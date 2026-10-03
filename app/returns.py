"""Returns, item-not-received requests and cases from every eBay account (Post-Order API, read only).

The Post-Order API takes the OAuth user token as "Authorization: IAF <token>". Searching needs no digital
signature (only refund/approve calls do, and this app doesn't make those). The last 90 days are read on the
first run, then the last 45 days every few hours so state changes (closed, refunded) come through.
"""
import datetime as _dt
import json
import threading
import time
import urllib.parse

from . import ebay as EB
from . import db as DB

PO = "https://api.ebay.com/post-order/v2"
SCHEMA = """
CREATE TABLE IF NOT EXISTS returns(
  account_id INTEGER NOT NULL, kind TEXT NOT NULL, rid TEXT NOT NULL, order_id TEXT, item_id TEXT, transaction_id TEXT,
  buyer TEXT, reason TEXT, reason_type TEXT, comments TEXT, state TEXT, status TEXT, created TEXT,
  refund REAL, qty INTEGER, raw TEXT, fetched_at TEXT, PRIMARY KEY(account_id, kind, rid));
CREATE INDEX IF NOT EXISTS returns_created ON returns(created);
CREATE TABLE IF NOT EXISTS returns_state(
  account_id INTEGER PRIMARY KEY, last_check TEXT, last_status TEXT, last_message TEXT, backfilled INTEGER DEFAULT 0);
"""
_lock = threading.Lock()


def now_iso():
    return _dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")


def _get(path, token, params):
    url = f"{PO}/{path}?" + urllib.parse.urlencode(params)
    for auth in ("IAF " + token, "Bearer " + token):
        st, raw = EB._http(url, None, {"Authorization": auth, "Accept": "application/json", "Content-Type": "application/json",
                                       "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB"}, "GET", timeout=90)
        if st == 401 and auth.startswith("IAF"):
            continue
        try:
            j = json.loads(raw or b"{}")
        except ValueError:
            j = {}
        if st >= 400:
            msg = "; ".join(e.get("longMessage") or e.get("message") or str(e.get("errorId")) for e in (j.get("error") or j.get("errors") or []) if isinstance(e, dict))
            raise EB.EbayError(f"eBay returns ({path.split('/')[0]}): {msg or 'error ' + str(st)}")
        return j
    raise EB.EbayError("eBay didn't accept the login for returns. Reconnect the account on the eBay page.")


def _search(path, token, date_params, list_key):
    out, seen, page = [], set(), 1
    while page <= 50:
        j = _get(path, token, {**date_params, "limit": 200, "offset": page})
        rows = j.get(list_key) or []
        new = 0
        for r in rows:
            k = json.dumps(r.get("returnId") or r.get("inquiryId") or r.get("caseId") or r, sort_keys=True)
            if k not in seen:
                seen.add(k); out.append(r); new += 1
        if len(rows) < 200 or not new:
            return out
        page += 1
    return out


def _v(d, *path):
    for p in path:
        if not isinstance(d, dict):
            return None
        d = d.get(p)
    return d


def _amt(x):
    try:
        return abs(float(x))
    except (TypeError, ValueError):
        return None


def _created(cd):
    v = cd.get("value") if isinstance(cd, dict) else cd
    return (v or "")[:19]


def _iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def fetch(token, start, end):
    """[(kind, row dict)] for returns, item-not-received requests and cases created in the range."""
    out = []
    for r in _search("return/search", token, {"creation_date_range_from": _iso(start), "creation_date_range_to": _iso(end), "role": "SELLER"}, "members"):
        ci = r.get("creationInfo") or {}
        out.append(("return", {
            "rid": str(r.get("returnId")), "order_id": r.get("orderId"), "item_id": str(_v(ci, "item", "itemId") or "") or None,
            "transaction_id": _v(ci, "item", "transactionId"), "buyer": r.get("buyerLoginName"),
            "reason": ci.get("reason"), "reason_type": ci.get("reasonType"), "comments": _v(ci, "comments", "content"),
            "state": r.get("state"), "status": r.get("status"), "created": (_v(ci, "creationDate", "value") or "")[:19],
            "refund": _amt(_v(r, "sellerTotalRefund", "actualRefundAmount", "value")) or _amt(_v(r, "buyerTotalRefund", "actualRefundAmount", "value"))
                      or _amt(_v(r, "sellerTotalRefund", "estimatedRefundAmount", "value")),
            "qty": _v(ci, "item", "returnQuantity"), "raw": r}))
    for kind, path, key, dk in (("inquiry", "inquiry/search", "members", "inquiry_creation_date_range"),
                                ("case", "casemanagement/search", "members", "case_creation_date_range")):
        try:
            rows = _search(path, token, {f"{dk}_from": _iso(start), f"{dk}_to": _iso(end)}, key)
        except EB.EbayError:
            DB.log_exc(f"returns.{kind}", level="warn")
            continue
        for r in rows:
            out.append((kind, {
                "rid": str(r.get("inquiryId") or r.get("caseId")), "order_id": r.get("orderId"), "item_id": str(r.get("itemId") or "") or None,
                "transaction_id": r.get("transactionId"), "buyer": r.get("buyer") or r.get("buyerLoginName"),
                "reason": r.get("caseType") or ("ITEM_NOT_RECEIVED" if kind == "inquiry" else None), "reason_type": "INR" if kind == "inquiry" else r.get("caseType"),
                "comments": None, "state": r.get("inquiryStatusEnum") or r.get("caseStatusEnum") or r.get("status"), "status": r.get("status"),
                "created": _created(r.get("creationDate")),
                "refund": _amt(_v(r, "claimAmount", "value")), "qty": None, "raw": r}))
    return out


def check(db_factory):
    with _lock:
        with db_factory() as con:
            accounts = [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens")]
        for a in accounts:
            try:
                with db_factory() as con:
                    tok = EB.access_token(con, a)
                    st = con.execute("SELECT * FROM returns_state WHERE account_id=?", (a,)).fetchone()
                end = _dt.datetime.utcnow() - _dt.timedelta(minutes=2)
                days = 45 if st and st["backfilled"] else 90
                rows = fetch(tok, end - _dt.timedelta(days=days), end)
                with db_factory() as con:
                    for kind, r in rows:
                        if not r["rid"] or r["rid"] == "None":
                            continue
                        con.execute("""INSERT INTO returns(account_id,kind,rid,order_id,item_id,transaction_id,buyer,reason,reason_type,comments,state,status,created,refund,qty,raw,fetched_at)
                                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,kind,rid) DO UPDATE SET
                                       state=excluded.state,status=excluded.status,refund=COALESCE(excluded.refund,returns.refund),raw=excluded.raw,fetched_at=excluded.fetched_at""",
                                    (a, kind, r["rid"], r["order_id"], r["item_id"], r["transaction_id"], r["buyer"], r["reason"], r["reason_type"],
                                     r["comments"], r["state"], r["status"], r["created"], r["refund"], r["qty"], json.dumps(r["raw"])[:20000], now_iso()))
                    n = {k: sum(1 for x, _ in rows if x == k) for k in ("return", "inquiry", "case")}
                    con.execute("""INSERT INTO returns_state(account_id,last_check,last_status,last_message,backfilled) VALUES(?,?,?,?,1)
                                   ON CONFLICT(account_id) DO UPDATE SET last_check=excluded.last_check,last_status=excluded.last_status,last_message=excluded.last_message,backfilled=1""",
                                (a, now_iso(), "ok", f"{n['return']} returns, {n['inquiry']} not-received, {n['case']} cases in the last {days} days"))
            except Exception as e:
                DB.log_exc("returns.check")
                with db_factory() as con:
                    con.execute("""INSERT INTO returns_state(account_id,last_check,last_status,last_message) VALUES(?,?,?,?)
                                   ON CONFLICT(account_id) DO UPDATE SET last_check=excluded.last_check,last_status=excluded.last_status,last_message=excluded.last_message""",
                                (a, now_iso(), "error", str(e)[:500]))


def start_scheduler(db_factory, every_hours=3):
    def loop():
        time.sleep(240)
        while True:
            try:
                if EB.configured():
                    check(db_factory)
            except Exception:
                DB.log_exc("returns.loop")
            time.sleep(every_hours * 3600)
    threading.Thread(target=loop, daemon=True).start()
