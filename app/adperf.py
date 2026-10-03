"""Promoted Listings performance and rate changes.

Once a day, per account: every campaign's ads (listing + current rate) and a LISTING_PERFORMANCE_REPORT
for the last 30 and 90 days (ad impressions, clicks, ad sales, ad fees). The report is an async task:
create it, wait until eBay has built it, download the TSV. Which metric names exist is read from eBay's
report metadata, so nothing breaks if eBay renames or adds metrics.

Rate changes go to the campaign each listing is already in; listings not in any campaign are added to the
"Partsledger General" campaign. "Stop" removes the ad.
"""
import csv
import datetime as _dt
import gzip
import io
import json
import re
import threading
import time
import urllib.parse
import urllib.request

from . import ebay as EB

MKT = EB.MKT
WINDOWS = (30, 90)
SCHEMA = """
CREATE TABLE IF NOT EXISTS ad_current(
  account_id INTEGER NOT NULL, item_id TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT,
  funding TEXT, rate REAL, status TEXT, PRIMARY KEY(account_id, item_id, campaign_id));
CREATE TABLE IF NOT EXISTS ad_perf(
  account_id INTEGER NOT NULL, window_days INTEGER NOT NULL, item_id TEXT NOT NULL,
  impressions INTEGER, clicks INTEGER, ad_units REAL, ad_sales REAL, ad_fees REAL, raw TEXT,
  PRIMARY KEY(account_id, window_days, item_id));
CREATE TABLE IF NOT EXISTS ad_perf_state(
  account_id INTEGER PRIMARY KEY, fetched_at TEXT, status TEXT, message TEXT, date_to TEXT);
CREATE TABLE IF NOT EXISTS ad_changes(
  id INTEGER PRIMARY KEY, at TEXT DEFAULT CURRENT_TIMESTAMP, by TEXT, account_id INTEGER, item_id TEXT, sku TEXT,
  action TEXT, old_rate REAL, new_rate REAL, status TEXT DEFAULT 'waiting', message TEXT);
"""
_lock = threading.Lock()


def migrate(con):
    if "strategy" not in {r[1] for r in con.execute("PRAGMA table_info(ad_current)")}:
        con.execute("ALTER TABLE ad_current ADD COLUMN strategy TEXT")  # FIXED or DYNAMIC ad rates


def now_iso():
    return _dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")


def _req(method, url, token, body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json" if not raw else "*/*",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers or {})


def _json(st, body, what):
    try:
        j = json.loads(body or b"{}")
    except ValueError:
        j = {}
    if st >= 400:
        raise EB.EbayError(f"{what}: " + EB._err(j, f"eBay error {st}"))
    return j


# ------------------------------------------------------------------ campaigns and ads
def campaigns(token):
    out, off = [], 0
    while True:
        st, b, _ = _req("GET", f"{MKT}/ad_campaign?limit=100&offset={off}", token)
        j = _json(st, b, "Reading campaigns")
        cs = j.get("campaigns") or []
        out += cs
        if len(cs) < 100:
            return out
        off += 100


def ads(token, cid):
    out, off = [], 0
    while True:
        st, b, _ = _req("GET", f"{MKT}/ad_campaign/{cid}/ad?limit=500&offset={off}", token)
        if st == 404:
            return out
        j = _json(st, b, "Reading ads")
        a = j.get("ads") or []
        out += a
        if len(a) < 500:
            return out
        off += 500


# ------------------------------------------------------------------ the performance report
def _pick_metrics(meta):
    keys = [m.get("metricKey") for m in meta.get("metricMetadata") or [] if m.get("metricKey")]
    want = []
    def first(pred):
        for k in keys:
            if pred(k.lower()) and k not in want:
                want.append(k)
                return
    first(lambda k: k == "impressions" or k.endswith("impressions"))
    first(lambda k: k == "clicks" or (k.endswith("clicks") and "rate" not in k))
    first(lambda k: k in ("sales", "sale_quantity", "attributed_sales", "sold_quantity") or (("sale" in k or "sold" in k) and ("quantity" in k or k.endswith("sales")) and "amount" not in k and "rate" not in k))
    first(lambda k: "sale_amount" in k or ("sales" in k and "amount" in k))
    first(lambda k: "ad_fees" in k or k == "ad_fee" or ("fee" in k and "avg" not in k))
    cap = int(meta.get("maxNumberOfMetricsToRequest") or 10)
    return want[:cap]


def _norm(h):
    return re.sub(r"[^a-z0-9]+", "_", (h or "").strip().lower()).strip("_")


def _num(v):
    try:
        return float(str(v).replace(",", "").replace("£", "").replace("%", "").strip() or 0)
    except ValueError:
        return 0.0


def run_report(token, cids, date_from, date_to):
    st, b, _ = _req("GET", f"{MKT}/ad_report_metadata/LISTING_PERFORMANCE_REPORT", token)
    meta = _json(st, b, "Reading report options")
    metrics = _pick_metrics(meta)
    if not metrics:
        raise EB.EbayError("eBay's listing report has no metrics this app understands.")
    body = {"reportType": "LISTING_PERFORMANCE_REPORT", "marketplaceId": "EBAY_GB", "campaignIds": cids,
            "fundingModels": ["COST_PER_SALE"],
            "dateFrom": date_from + "T00:00:00.000Z", "dateTo": date_to + "T23:59:59.000Z",
            "dimensions": [{"dimensionKey": "listing_id"}, {"dimensionKey": "campaign_id"}],  # eBay requires both
            "metricKeys": metrics, "reportFormat": "TSV_GZIP"}
    st, b, h = _req("POST", f"{MKT}/ad_report_task", token, body)
    if st >= 400:
        _json(st, b, "Asking eBay for the ad report")
    loc = h.get("Location") or h.get("location") or ""
    task_id = loc.rstrip("/").rsplit("/", 1)[-1] if loc else None
    if not task_id:
        raise EB.EbayError("eBay accepted the report request but didn't say where to collect it.")
    href = None
    for _ in range(60):  # up to ~10 minutes
        time.sleep(10)
        st, b, _ = _req("GET", f"{MKT}/ad_report_task/{task_id}", token)
        j = _json(st, b, "Checking the ad report")
        s = j.get("reportTaskStatus")
        if s == "SUCCESS":
            href = j.get("reportHref")
            break
        if s == "FAILED":
            raise EB.EbayError("eBay couldn't build the ad report: " + (j.get("reportTaskStatusMessage") or "no reason given"))
    if not href:
        raise EB.EbayError("eBay is still building the ad report; it will be collected next time.")
    st, b, _ = _req("GET", href, token, raw=True)
    if st >= 400:
        raise EB.EbayError(f"Couldn't download the ad report ({st}).")
    try:
        b = gzip.decompress(b)
    except OSError:
        pass
    text = b.decode("utf-8-sig", "replace")
    rows = list(csv.reader(io.StringIO(text), delimiter="\t"))
    if not rows:
        return {}, metrics
    head = [_norm(x) for x in rows[0]]
    lid = next((i for i, x in enumerate(head) if x in ("listing_id", "item_id", "listingid")), None)
    if lid is None:
        lid = next((i for i, x in enumerate(head) if "listing" in x and "id" in x), 0)
    # one row per listing and campaign: add the numbers up per listing
    skip = {i for i, x in enumerate(head) if i == lid or "campaign" in x or "listing" in x or x in ("title", "item_title")}
    out = {}
    for r in rows[1:]:
        if len(r) <= lid or not r[lid].strip().isdigit():
            continue
        acc = out.setdefault(r[lid].strip(), {})
        for i in range(min(len(head), len(r))):
            if i in skip:
                continue
            acc[head[i]] = acc.get(head[i], 0.0) + _num(r[i])
    for acc in out.values():
        if "click_through_rate" in acc:
            acc.pop("click_through_rate")  # a rate can't be added up across campaigns
    return out, metrics


def _extract(vals, metrics):
    """Map a report row to impressions, clicks, units, sales £, fees £ using the metric names eBay used."""
    def get(pred):
        for k, v in vals.items():
            if pred(k):
                return _num(v)
        return 0.0
    return {
        "impressions": int(get(lambda k: k.endswith("impressions"))),
        "clicks": int(get(lambda k: k.endswith("clicks") and "rate" not in k)),
        "ad_units": get(lambda k: (("sale" in k or "sold" in k) and ("quantity" in k or k.endswith("sales"))) and "amount" not in k and "rate" not in k),
        "ad_sales": get(lambda k: "sale_amount" in k or ("sales" in k and "amount" in k)),
        "ad_fees": get(lambda k: "fee" in k and "avg" not in k),
    }


def refresh(db_factory, account_id):
    with db_factory() as con:
        tok = EB.access_token(con, account_id)
    cs = campaigns(tok)
    cur = []
    for c in cs:
        if c.get("campaignStatus") in ("ENDED", "DELETED", "ARCHIVED"):
            continue
        fs = c.get("fundingStrategy") or {}
        fm, strat = fs.get("fundingModel"), (fs.get("adRateStrategy") or "FIXED").upper()
        for a in ads(tok, c["campaignId"]):
            if a.get("listingId"):
                cur.append((account_id, str(a["listingId"]), c["campaignId"], c.get("campaignName"), fm,
                            _num(a.get("bidPercentage")) if a.get("bidPercentage") else None, a.get("adStatus"), strat))
    with db_factory() as con:
        con.execute("DELETE FROM ad_current WHERE account_id=?", (account_id,))
        con.executemany("INSERT OR REPLACE INTO ad_current(account_id,item_id,campaign_id,campaign_name,funding,rate,status,strategy) VALUES(?,?,?,?,?,?,?,?)", cur)
    cps = [c["campaignId"] for c in cs if (c.get("fundingStrategy") or {}).get("fundingModel") == "COST_PER_SALE"]
    if not cps:
        with db_factory() as con:
            con.execute("INSERT OR REPLACE INTO ad_perf_state(account_id,fetched_at,status,message,date_to) VALUES(?,?,?,?,?)",
                        (account_id, now_iso(), "ok", f"{len(cur)} promoted listings; no General campaigns to report on", None))
        return
    end = (_dt.date.today() - _dt.timedelta(days=1)).isoformat()
    got = {}
    for w in WINDOWS:
        start = (_dt.date.today() - _dt.timedelta(days=w)).isoformat()
        rows, metrics = run_report(tok, cps, start, end)
        got[w] = (rows, metrics)
    with db_factory() as con:
        for w, (rows, metrics) in got.items():
            con.execute("DELETE FROM ad_perf WHERE account_id=? AND window_days=?", (account_id, w))
            for item, vals in rows.items():
                e = _extract(vals, metrics)
                con.execute("INSERT INTO ad_perf VALUES(?,?,?,?,?,?,?,?,?)", (account_id, w, item, e["impressions"], e["clicks"],
                            e["ad_units"], round(e["ad_sales"], 2), round(e["ad_fees"], 2), json.dumps(vals)))
        con.execute("INSERT OR REPLACE INTO ad_perf_state(account_id,fetched_at,status,message,date_to) VALUES(?,?,?,?,?)",
                    (account_id, now_iso(), "ok", f"{len(cur)} promoted listings; report for {len(got[30][0])} listings (30 days)", end))


def refresh_all(db_factory, only_stale=False):
    with _lock:
        with db_factory() as con:
            accts = [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens")]
            state = {r["account_id"]: r["fetched_at"] for r in con.execute("SELECT * FROM ad_perf_state")}
        for a in accts:
            if only_stale and state.get(a) and state[a] > (_dt.datetime.utcnow() - _dt.timedelta(hours=20)).strftime("%Y-%m-%dT%H:%M:%S"):
                continue
            try:
                refresh(db_factory, a)
            except Exception as e:
                with db_factory() as con:
                    con.execute("""INSERT INTO ad_perf_state(account_id,fetched_at,status,message) VALUES(?,?,?,?)
                                   ON CONFLICT(account_id) DO UPDATE SET fetched_at=excluded.fetched_at,status=excluded.status,message=excluded.message""",
                                (a, now_iso(), "error", str(e)[:500]))


def start_scheduler(db_factory):
    def loop():
        time.sleep(180)
        while True:
            try:
                if EB.configured():
                    refresh_all(db_factory, only_stale=True)
            except Exception:
                pass
            time.sleep(3600)
    threading.Thread(target=loop, daemon=True).start()


# ------------------------------------------------------------------ applying changes
def apply(db_factory, change_ids):
    """Run queued ad_changes rows: set rate in the listing's own campaign, add to Partsledger General, or stop."""
    with _lock:
        with db_factory() as con:
            rows = [dict(r) for r in con.execute(f"SELECT * FROM ad_changes WHERE id IN ({','.join('?' * len(change_ids))})", change_ids)]
            where = {(r["account_id"], r["item_id"]): r["campaign_id"] for r in con.execute(
                "SELECT account_id,item_id,campaign_id FROM ad_current WHERE funding='COST_PER_SALE'")}
            dynamic = {r[0] for r in con.execute("SELECT DISTINCT campaign_id FROM ad_current WHERE strategy='DYNAMIC'")}
        by_acct = {}
        for r in rows:
            by_acct.setdefault(r["account_id"], []).append(r)
        for a, rs in by_acct.items():
            try:
                with db_factory() as con:
                    tok = EB.access_token(con, a)
            except Exception as e:
                _mark(db_factory, [r["id"] for r in rs], "failed", str(e))
                continue
            groups = {}
            for r in rs:
                cid = where.get((a, r["item_id"]))
                kind = "delete" if r["action"] == "stop" else ("move" if cid in dynamic else "update" if cid else "create")
                if kind == "delete" and not cid:
                    _mark(db_factory, [r["id"]], "done", "Wasn't promoted")
                    continue
                if kind == "create":
                    cid = None
                groups.setdefault((kind, cid), []).append(r)
            for (kind, cid), grp in groups.items():
                if kind == "move":
                    move(db_factory, tok, a, cid, grp)
                    continue
                try:
                    if kind == "create":
                        cid = EB.find_or_create_campaign(tok)
                    path = {"create": "bulk_create_ads_by_listing_id", "update": "bulk_update_ads_bid_by_listing_id",
                            "delete": "bulk_delete_ads_by_listing_id"}[kind]
                    for i in range(0, len(grp), 500):
                        chunk = grp[i:i + 500]
                        reqs = [{"listingId": r["item_id"]} if kind == "delete" else {"listingId": r["item_id"], "bidPercentage": f"{r['new_rate']:.1f}"} for r in chunk]
                        st, b, _ = _req("POST", f"{MKT}/ad_campaign/{cid}/{path}", tok, {"requests": reqs})
                        try:
                            j = json.loads(b or b"{}")
                        except ValueError:
                            j = {}
                        resp = {str(x.get("listingId")): x for x in j.get("responses") or []}
                        if kind == "update":
                            dyn = [r for r in chunk if "DYNAMIC" in EB._err(resp.get(r["item_id"]) or {}, "").upper()]
                            if dyn:
                                move(db_factory, tok, a, cid, dyn)
                                chunk = [r for r in chunk if r not in dyn]
                        for r in chunk:
                            x = resp.get(r["item_id"])
                            ok = (x and x.get("statusCode") in (200, 201, 204)) or (not x and st < 300)
                            msg = ("Stopped promoting" if kind == "delete" else f"Rate set to {r['new_rate']:.1f}%") if ok else EB._err(x or j, f"eBay error {st}")
                            _mark(db_factory, [r["id"]], "done" if ok else "failed", msg)
                            if ok:
                                with db_factory() as con:
                                    if kind == "delete":
                                        con.execute("DELETE FROM ad_current WHERE account_id=? AND item_id=? AND campaign_id=?", (a, r["item_id"], cid))
                                    else:
                                        con.execute("INSERT OR REPLACE INTO ad_current(account_id,item_id,campaign_id,campaign_name,funding,rate,status) VALUES(?,?,?,COALESCE((SELECT campaign_name FROM ad_current WHERE account_id=? AND item_id=? AND campaign_id=?),?),'COST_PER_SALE',?,'ACTIVE')",
                                                    (a, r["item_id"], cid, a, r["item_id"], cid, EB.CAMPAIGN_NAME if kind == "create" else None, r["new_rate"]))
                except Exception as e:
                    _mark(db_factory, [r["id"] for r in grp], "failed", str(e))


def _mark(db_factory, ids, status, msg):
    with db_factory() as con:
        for i in ids:
            con.execute("UPDATE ad_changes SET status=?, message=? WHERE id=?", (status, str(msg)[:500], i))


def _bulk(tok, cid, path, reqs):
    st, b, _ = _req("POST", f"{MKT}/ad_campaign/{cid}/{path}", tok, {"requests": reqs})
    try:
        j = json.loads(b or b"{}")
    except ValueError:
        j = {}
    resp = {str(x.get("listingId")): x for x in j.get("responses") or []}
    out = {}
    for r in reqs:
        x = resp.get(str(r["listingId"]))
        ok = (x and x.get("statusCode") in (200, 201, 204)) or (not x and st < 300)
        out[str(r["listingId"])] = (bool(ok), None if ok else EB._err(x or j, f"eBay error {st}"))
    return out


def move(db_factory, tok, a, from_cid, grp):
    """eBay won't take a fixed rate for one listing in a dynamic-rate campaign. Take the listing out of that
    campaign and add it to Partsledger General at the chosen rate; if that fails, put it back."""
    try:
        to_cid = EB.find_or_create_campaign(tok)
    except Exception as e:
        _mark(db_factory, [r["id"] for r in grp], "failed", str(e))
        return
    with db_factory() as con:
        old_name = {r["item_id"]: r["campaign_name"] for r in con.execute(
            "SELECT item_id,campaign_name FROM ad_current WHERE account_id=? AND campaign_id=?", (a, from_cid))}
    for i in range(0, len(grp), 500):
        chunk = grp[i:i + 500]
        out = _bulk(tok, from_cid, "bulk_delete_ads_by_listing_id", [{"listingId": r["item_id"]} for r in chunk])
        moved = [r for r in chunk if out[r["item_id"]][0]]
        for r in chunk:
            if not out[r["item_id"]][0]:
                _mark(db_factory, [r["id"]], "failed", "Couldn't take it out of the dynamic campaign: " + out[r["item_id"]][1])
        if not moved:
            continue
        added = _bulk(tok, to_cid, "bulk_create_ads_by_listing_id", [{"listingId": r["item_id"], "bidPercentage": f"{r['new_rate']:.1f}"} for r in moved])
        back = [r for r in moved if not added[r["item_id"]][0]]
        restored = _bulk(tok, from_cid, "bulk_create_ads_by_listing_id", [{"listingId": r["item_id"]} for r in back]) if back else {}
        with db_factory() as con:
            for r in moved:
                ok, err = added[r["item_id"]]
                if ok:
                    con.execute("DELETE FROM ad_current WHERE account_id=? AND item_id=?", (a, r["item_id"]))
                    con.execute("INSERT INTO ad_current(account_id,item_id,campaign_id,campaign_name,funding,rate,status,strategy) VALUES(?,?,?,?,?,?,?,?)",
                                (a, r["item_id"], to_cid, EB.CAMPAIGN_NAME, "COST_PER_SALE", r["new_rate"], "ACTIVE", "FIXED"))
                    con.execute("UPDATE ad_changes SET status='done', message=? WHERE id=?",
                                (f"Moved from \"{old_name.get(r['item_id']) or 'dynamic campaign'}\" (dynamic rate) to {EB.CAMPAIGN_NAME} at {r['new_rate']:.1f}%", r["id"]))
                else:
                    put_back = restored.get(r["item_id"], (False, None))[0]
                    con.execute("UPDATE ad_changes SET status='failed', message=? WHERE id=?",
                                (f"Couldn't add it at a fixed rate ({err}). " + ("Put back in its dynamic campaign." if put_back else "It is NOT promoted now; add it again."), r["id"]))
                    if not put_back:
                        con.execute("DELETE FROM ad_current WHERE account_id=? AND item_id=? AND campaign_id=?", (a, r["item_id"], from_cid))
