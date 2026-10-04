"""Seller standards per account (Analytics API, sell.analytics.readonly - the same permission as Traffic).

- Seller level (Top Rated / Above standard / Below standard), now and projected for the next evaluation, with each
  metric (defect rate, cases closed without seller resolution, late dispatch...) against eBay's thresholds.
- Service metrics: "item not as described" and "item not received" rates against similar sellers
  (eBay rates them LOW .. VERY_HIGH; VERY_HIGH can lead to restrictions).
Read once a day; the page can refresh it.
"""
import datetime as _dt
import json
import re
import threading
import time

from . import ebay as EB
from . import db as DB

ANA = "https://api.ebay.com/sell/analytics/v1"
SCHEMA = """
CREATE TABLE IF NOT EXISTS std_profile(
  account_id INTEGER NOT NULL, program TEXT NOT NULL, cycle TEXT NOT NULL, level TEXT, eval_date TEXT, eval_month TEXT,
  is_default INTEGER, reason TEXT, metrics TEXT, raw TEXT, fetched_at TEXT, PRIMARY KEY(account_id, program, cycle));
CREATE TABLE IF NOT EXISTS std_service(
  account_id INTEGER NOT NULL, kind TEXT NOT NULL, cycle TEXT NOT NULL, start TEXT, end TEXT, dims TEXT, raw TEXT, fetched_at TEXT,
  PRIMARY KEY(account_id, kind, cycle));
CREATE TABLE IF NOT EXISTS std_state(account_id INTEGER PRIMARY KEY, last_check TEXT, last_status TEXT, last_message TEXT);
CREATE TABLE IF NOT EXISTS std_history(
  account_id INTEGER NOT NULL, day TEXT NOT NULL, program TEXT NOT NULL, level TEXT, projected TEXT, metrics TEXT,
  PRIMARY KEY(account_id, day, program));
"""
LEVELS = {"TOP_RATED": 3, "ABOVE_STANDARD": 2, "BELOW_STANDARD": 1}
RATING = {"LOW": 0, "AVERAGE": 1, "MEDIUM": 1, "HIGH": 2, "VERY_HIGH": 3}
CLOSED = re.compile(r"CLOSED|COMPLETED|REFUNDED|CANCELLED|CANCELED|RESOLVED", re.I)  # same as the Returns page
_lock = threading.Lock()


def now_iso():
    return _dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")


def _num(v):
    """eBay sends values as numbers, strings, or {"value": ...} objects."""
    if isinstance(v, dict):
        for k in ("value", "amount"):
            if k in v:
                return _num(v[k])
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def metric(m):
    v = m.get("value")
    out = {"key": m.get("metricKey"), "name": m.get("name") or (m.get("metricKey") or "").replace("_", " ").capitalize(),
           "type": m.get("type"), "level": m.get("level"), "value": _num(v),
           "num": _num((v or {}).get("numerator")) if isinstance(v, dict) else _num(m.get("numerator")),
           "den": _num((v or {}).get("denominator")) if isinstance(v, dict) else _num(m.get("denominator")),
           "lower": _num(m.get("thresholdLowerBound")), "upper": _num(m.get("thresholdUpperBound")),
           "meta": m.get("thresholdMetaData"), "from": (m.get("lookbackStartDate") or "")[:10], "to": (m.get("lookbackEndDate") or "")[:10]}
    if isinstance(v, dict) and v.get("applicable") is False:
        out["na"] = True
    return out


def service_dims(j):
    out = []
    for dm in j.get("dimensionMetrics") or []:
        d = dm.get("dimension") or {}
        row = {"key": d.get("dimensionKey"), "name": d.get("name") or d.get("value"), "value": d.get("value")}
        for m in dm.get("metrics") or []:
            k = m.get("metricKey")
            if k == "RATE":
                b = m.get("benchmark") or {}
                row.update(rate=_num(m.get("value")), rating=b.get("rating"), avg=_num((b.get("metadata") or {}).get("average")),
                           adjustment=b.get("adjustment"))
            elif k == "COUNT":
                row["count"] = _num(m.get("value"))
            elif k == "TRANSACTION_COUNT":
                row["txns"] = _num(m.get("value"))
        out.append(row)
    return out


def check_account(db_factory, a):
    with db_factory() as con:
        if not EB.has_scope(con, a, EB.ANALYTICS_SCOPE):
            con.execute("INSERT OR REPLACE INTO std_state VALUES(?,?,?,?)", (a, now_iso(), "scope", "Reconnect this account on the eBay page (the Traffic permission is needed)"))
            return
        tok = EB.access_token(con, a)
    j = EB._get_json(f"{ANA}/seller_standards_profile", tok)
    profs = j.get("standardsProfiles") or []
    svc = {}
    for kind in ("ITEM_NOT_AS_DESCRIBED", "ITEM_NOT_RECEIVED"):
        for cyc in ("CURRENT", "PROJECTED"):
            try:
                svc[(kind, cyc)] = EB._get_json(f"{ANA}/customer_service_metric/{kind}/{cyc}?evaluation_marketplace_id=EBAY_GB", tok)
            except EB.EbayError as e:
                svc[(kind, cyc)] = {"_error": str(e)}
            time.sleep(0.2)
    today = _dt.date.today().isoformat()
    with db_factory() as con:
        con.execute("DELETE FROM std_profile WHERE account_id=?", (a,))
        for p in profs:
            c = p.get("cycle") or {}
            con.execute("INSERT OR REPLACE INTO std_profile VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (a, p.get("program"), c.get("cycleType") or "CURRENT", p.get("standardsLevel"), (c.get("evaluationDate") or "")[:10],
                         c.get("evaluationMonth"), int(bool(p.get("defaultProgram"))), p.get("evaluationReason"),
                         json.dumps([metric(m) for m in p.get("metrics") or []]), json.dumps(p)[:20000], now_iso()))
        cur = {p.get("program"): p for p in profs if (p.get("cycle") or {}).get("cycleType") == "CURRENT"}
        prj = {p.get("program"): p for p in profs if (p.get("cycle") or {}).get("cycleType") == "PROJECTED"}
        for prog, p in cur.items():
            con.execute("INSERT OR REPLACE INTO std_history VALUES(?,?,?,?,?,?)",
                        (a, today, prog, p.get("standardsLevel"), (prj.get(prog) or {}).get("standardsLevel"),
                         json.dumps({m["key"]: m["value"] for m in map(metric, (prj.get(prog) or p).get("metrics") or [])})))
        for (kind, cyc), r in svc.items():
            ev = r.get("evaluationCycle") or {}
            con.execute("INSERT OR REPLACE INTO std_service VALUES(?,?,?,?,?,?,?,?)",
                        (a, kind, cyc, (ev.get("startDate") or "")[:10], (ev.get("endDate") or "")[:10],
                         json.dumps(service_dims(r)) if "_error" not in r else None, json.dumps(r)[:20000], now_iso()))
        con.execute("INSERT OR REPLACE INTO std_state VALUES(?,?,?,?)", (a, now_iso(), "ok", f"{len(profs)} standards profiles"))


def check(db_factory):
    with _lock:
        with db_factory() as con:
            accts = [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens")]
        for a in accts:
            try:
                check_account(db_factory, a)
            except Exception as e:
                DB.log_exc("standards.check")
                with db_factory() as con:
                    con.execute("INSERT OR REPLACE INTO std_state VALUES(?,?,?,?)", (a, now_iso(), "error", str(e)[:500]))


def page(con):
    names = {r["id"]: r["name"] for r in con.execute("SELECT id,name FROM accounts")}
    out = []
    for a in [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens ORDER BY account_id")]:
        st = con.execute("SELECT * FROM std_state WHERE account_id=?", (a,)).fetchone()
        profs = [dict(r) for r in con.execute("SELECT program,cycle,level,eval_date,eval_month,is_default,reason,metrics,fetched_at FROM std_profile WHERE account_id=? ORDER BY is_default DESC, program, cycle", (a,))]
        for p in profs:
            p["metrics"] = json.loads(p["metrics"] or "[]")
        svc = [dict(r) for r in con.execute("SELECT kind,cycle,start,end,dims,raw FROM std_service WHERE account_id=?", (a,))]
        for s in svc:
            s["dims"] = json.loads(s["dims"]) if s["dims"] else None
            if s["dims"] is None:
                try:
                    s["error"] = json.loads(s["raw"] or "{}").get("_error")
                except ValueError:
                    s["error"] = None
            s.pop("raw", None)
        hist = [dict(r) for r in con.execute("SELECT day,program,level,projected,metrics FROM std_history WHERE account_id=? ORDER BY day DESC LIMIT 120", (a,))]
        for h in hist:
            h["metrics"] = json.loads(h["metrics"] or "{}")
        # open returns and cases: each one can turn into a defect if it closes badly
        opened = {}
        if con.execute("SELECT name FROM sqlite_master WHERE name='returns'").fetchone():
            for r in con.execute("SELECT kind,state,status FROM returns WHERE account_id=?", (a,)):
                if not CLOSED.search(f"{r['state'] or ''} {r['status'] or ''}"):
                    opened[r["kind"]] = opened.get(r["kind"], 0) + 1
        out.append({"account_id": a, "name": names.get(a), "state": dict(st) if st else None, "profiles": profs, "service": svc,
                    "history": hist, "open": opened, "warn": warnings(profs, svc)})
    return out


def warnings(profs, svc):
    """Short warnings for the badge and the top of the page."""
    w = []
    by = {(p["program"], p["cycle"]): p for p in profs}
    for p in profs:
        if not p["is_default"] and p["program"] != "PROGRAM_UK":
            continue
        if p["cycle"] == "CURRENT" and p["level"] == "BELOW_STANDARD":
            w.append("Below standard now")
        if p["cycle"] == "PROJECTED":
            cur = by.get((p["program"], "CURRENT"))
            if cur and LEVELS.get(p["level"], 9) < LEVELS.get(cur["level"], 0):
                w.append(f"Heading down to {nice_level(p['level'])} at the next evaluation")
        for m in p["metrics"]:
            if m.get("level") and m["level"] != "TOP_RATED" and p["cycle"] == "PROJECTED":
                w.append(f"{m['name']}: {nice_level(m['level'])}")
    for s in svc:
        for d in s["dims"] or []:
            if RATING.get(d.get("rating"), 0) >= 2:
                w.append(f"{'Not as described' if s['kind'] == 'ITEM_NOT_AS_DESCRIBED' else 'Not received'} rate is {d['rating'].replace('_', ' ').lower()} in {d.get('name')}")
    return sorted(set(w))


def nice_level(l):
    return {"TOP_RATED": "Top Rated", "ABOVE_STANDARD": "Above standard", "BELOW_STANDARD": "Below standard"}.get(l, l or "–")


def warning_count(con):
    try:
        return sum(len(x["warn"]) for x in page(con))
    except Exception:
        return 0


def start_scheduler(db_factory):
    def loop():
        time.sleep(480)
        while True:
            try:
                if EB.configured():
                    check(db_factory)
            except Exception:
                DB.log_exc("standards.loop")
            time.sleep(12 * 3600)
    threading.Thread(target=loop, daemon=True).start()
