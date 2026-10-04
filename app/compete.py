"""Competitor prices (eBay Browse API, application token - no account permission needed).

For each listing the app searches eBay UK for the same part from other sellers:
  - by the OE / manufacturer part number from the item specifics when there is one (best match),
  - otherwise by the title, in the listing's category (looser: check the matches).
Only new-or-same-condition, Buy It Now, UK-located listings that post to the UK; our own three accounts are left out.
Prices are compared including postage. Competitor listings that aren't the same part can be marked and are ignored.
A suggested price never goes below the price that keeps the minimum profit (same floor as Offers and Discounts).
eBay allows 5,000 Browse searches a day; the app keeps under DAILY_CAP.
"""
import datetime as _dt
import json
import re
import statistics
import threading
import time
import urllib.parse
import urllib.request

from . import ebay as EB
from . import db as DB
from . import offers as OF
from . import titles as TL

N = EB.N
BROWSE = "https://api.ebay.com/buy/browse/v1/item_summary/search"
DAILY_CAP = 4500
SCHEMA = """
CREATE TABLE IF NOT EXISTS comp_query(
  account_id INTEGER NOT NULL, item_id TEXT NOT NULL, query TEXT, kind TEXT, part_no TEXT, category_id TEXT, condition_id TEXT,
  our_post REAL, updated_at TEXT, PRIMARY KEY(account_id, item_id));
CREATE TABLE IF NOT EXISTS comp_result(
  account_id INTEGER NOT NULL, item_id TEXT NOT NULL, checked_at TEXT, total INTEGER, items TEXT, status TEXT, message TEXT,
  PRIMARY KEY(account_id, item_id));
CREATE TABLE IF NOT EXISTS comp_ignore(
  account_id INTEGER NOT NULL, item_id TEXT NOT NULL, other_id TEXT NOT NULL, by TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(account_id, item_id, other_id));
"""
DEFAULTS = {"comp_auto": False, "comp_daily": 800, "comp_undercut": 0.01, "comp_min_profit": 1.0, "comp_raise_pct": 5.0,
            "comp_last_auto": None}
PROGRESS = {"running": False, "total": 0, "done": 0, "failed": 0, "started": None, "by": None}
_lock = threading.Lock()
_app = {"tok": None, "exp": 0}


def now_iso():
    return _dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")


def _norm(s):
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


# ------------------------------------------------------------------ settings and the daily allowance
def get_settings(con):
    s = DB.get_settings(con)
    return {k: s.get(k, v) for k, v in DEFAULTS.items()}


def set_settings(con, b):
    s = get_settings(con)
    if "comp_auto" in b:
        s["comp_auto"] = bool(b["comp_auto"])
    if "comp_daily" in b:
        s["comp_daily"] = max(0, min(DAILY_CAP, int(b["comp_daily"] or 0)))
    for k, lo, hi in (("comp_undercut", 0, 50), ("comp_min_profit", 0, 1000), ("comp_raise_pct", 0, 100)):
        if k in b:
            s[k] = max(lo, min(hi, float(b[k] or 0)))
    for k in DEFAULTS:
        if k in s:
            con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (k, json.dumps(s[k])))
    return s


def calls_today(con):
    r = DB.get_settings(con).get("comp_calls") or {}
    return r.get("n", 0) if r.get("day") == _dt.date.today().isoformat() else 0


def _count(con, n=1):
    con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('comp_calls',?)",
                (json.dumps({"day": _dt.date.today().isoformat(), "n": calls_today(con) + n}),))


# ------------------------------------------------------------------ eBay calls
def _app_token():
    if _app["tok"] and _app["exp"] > time.time():
        return _app["tok"]
    j = EB._token_request({"grant_type": "client_credentials", "scope": "https://api.ebay.com/oauth/api_scope"})
    _app["tok"], _app["exp"] = j["access_token"], time.time() + int(j.get("expires_in", 7200)) - 300
    return _app["tok"]


def _get(url):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + _app_token(), "Accept": "application/json",
                                               "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB", "X-EBAY-C-ENDUSERCTX": "contextualLocation=country%3DGB"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def read_listing(token, item_id):
    """What the search needs from our own listing: specifics, category, condition and our postage."""
    def b(root):
        EB._el(root, "ItemID", item_id)
        EB._el(root, "DetailLevel", "ReturnAll")
        EB._el(root, "IncludeItemSpecifics", "true")
    it = EB.trading("GetItem", token, b).find(N + "Item")
    specs = {}
    for nv in it.findall(f"{N}ItemSpecifics/{N}NameValueList"):
        specs[nv.findtext(N + "Name") or ""] = [v.text or "" for v in nv.findall(N + "Value")]
    post = None
    for o in it.findall(f"{N}ShippingDetails/{N}ShippingServiceOptions"):
        c = o.findtext(N + "ShippingServiceCost")
        if c is not None:
            v = float(c)
            post = v if post is None else min(post, v)
    if post is None and (it.findtext(f"{N}ShippingDetails/{N}ShippingServiceOptions/{N}FreeShipping") == "true"):
        post = 0.0
    return {"title": it.findtext(N + "Title") or "", "specs": specs, "category_id": it.findtext(f"{N}PrimaryCategory/{N}CategoryID"),
            "condition_id": it.findtext(N + "ConditionID"), "our_post": post or 0.0}


STOP = re.compile(r"\b(new|genuine|oem|oe|quality|for|fits|fit|with|and|the|set|pair|uk|stock|fast|free|post|delivery|left|right|lh|rh|\d{4}\s?-\s?\d{2,4}|\d{2}\s?-\s?\d{2})\b", re.I)


def title_query(title):
    t = STOP.sub(" ", re.sub(r"[^\w\s/-]", " ", title or ""))
    return " ".join(t.split()[:8])


def search(query, condition_id=None, category_id=None, exclude=()):
    f = ["buyingOptions:{FIXED_PRICE}", "itemLocationCountry:GB", "deliveryCountry:GB", "priceCurrency:GBP"]
    if condition_id:
        f.append("conditionIds:{%s}" % condition_id)
    if exclude:
        f.append("excludeSellers:{%s}" % "|".join(exclude))
    q = {"q": query[:100], "filter": ",".join(f), "sort": "price", "limit": 50}
    if category_id:
        q["category_ids"] = category_id
    st, j = _get(BROWSE + "?" + urllib.parse.urlencode(q))
    if st >= 400:
        raise EB.EbayError("Searching eBay: " + EB._err(j, f"eBay error {st}"))
    out = []
    for s in j.get("itemSummaries") or []:
        try:
            price = float((s.get("price") or {}).get("value"))
        except (TypeError, ValueError):
            continue
        ship = None
        for o in s.get("shippingOptions") or []:
            try:
                v = float((o.get("shippingCost") or {}).get("value"))
                ship = v if ship is None else min(ship, v)
            except (TypeError, ValueError):
                pass
        parts = (s.get("itemId") or "").split("|")
        out.append({"id": str(s.get("legacyItemId") or (parts[1] if len(parts) > 1 else parts[0])),
                    "seller": (s.get("seller") or {}).get("username"), "fb": (s.get("seller") or {}).get("feedbackScore"),
                    "title": s.get("title"), "price": price, "ship": ship, "total": round(price + (ship or 0), 2),
                    "url": s.get("itemWebUrl"), "img": (s.get("image") or {}).get("imageUrl")})
    return j.get("total") or len(out), out


# ------------------------------------------------------------------ checking listings
def check_one(con, token, a, item_id, sku, own):
    q = con.execute("SELECT * FROM comp_query WHERE account_id=? AND item_id=?", (a, item_id)).fetchone()
    if not q:
        info = read_listing(token, item_id)
        part = TL.oe_number(info["specs"], "", sku)
        query, kind = (part, "part") if part else (title_query(info["title"]), "title")
        con.execute("INSERT OR REPLACE INTO comp_query VALUES(?,?,?,?,?,?,?,?,?)",
                    (a, item_id, query, kind, part, info["category_id"], info["condition_id"], info["our_post"], now_iso()))
        q = con.execute("SELECT * FROM comp_query WHERE account_id=? AND item_id=?", (a, item_id)).fetchone()
    total, items = search(q["query"], q["condition_id"], q["category_id"] if q["kind"] == "title" else None, own)
    _count(con)
    items = [x for x in items if x["id"] != item_id][:30]
    pn = _norm(q["part_no"]) if q["kind"] == "part" else None
    for x in items:
        x["exact"] = bool(pn) and pn in _norm(x["title"])
    con.execute("INSERT OR REPLACE INTO comp_result VALUES(?,?,?,?,?,?,?)",
                (a, item_id, now_iso(), total, json.dumps(items), "ok", f"{len(items)} found"))


def run_check(db_factory, targets, by=None):
    """targets: [(account_id, item_id)]."""
    if not _lock.acquire(blocking=False):
        return False
    try:
        PROGRESS.update(running=True, total=len(targets), done=0, failed=0, started=now_iso(), by=by)
        with db_factory() as con:
            own = [r[0] for r in con.execute("SELECT ebay_user FROM ebay_tokens WHERE ebay_user IS NOT NULL")]
            skus = {(r["account_id"], r["item_id"]): r["sku"] for r in con.execute("SELECT account_id,item_id,sku FROM listings")}
            sku_map = {r["item_id"]: r["sku"] for r in con.execute("SELECT item_id,sku FROM sku_map")}
        tokens = {}
        for a, item in targets:
            try:
                with db_factory() as con:
                    if calls_today(con) >= DAILY_CAP:
                        DB.log("warn", "compete", f"Stopped: {DAILY_CAP} eBay searches used today")
                        break
                    if a not in tokens:
                        tokens[a] = EB.access_token(con, a)
                    check_one(con, tokens[a], a, item, sku_map.get(item) or skus.get((a, item)) or "", own)
            except Exception as e:
                PROGRESS["failed"] += 1
                DB.log_exc("compete.check", level="warn")
                with db_factory() as con:
                    con.execute("INSERT INTO comp_result(account_id,item_id,checked_at,status,message) VALUES(?,?,?,?,?) "
                                "ON CONFLICT(account_id,item_id) DO UPDATE SET checked_at=excluded.checked_at,status=excluded.status,message=excluded.message",
                                (a, item, now_iso(), "error", str(e)[:400]))
            PROGRESS["done"] += 1
            time.sleep(0.12)
        DB.log("info", "compete", f"Competitor check: {PROGRESS['done']} listings, {PROGRESS['failed']} failed")
        return True
    finally:
        PROGRESS["running"] = False
        _lock.release()


def start_check(db_factory, targets, by=None):
    if PROGRESS["running"]:
        return False
    threading.Thread(target=run_check, args=(db_factory, targets), kwargs={"by": by}, daemon=True).start()
    return True


def auto_targets(con, n):
    """Daily automatic check: in-stock listings, never-checked first, then the oldest checks; best sellers first."""
    rows = []
    for a in [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens")]:
        ids = set(EB.active_listing_ids(con, a))
        for r in con.execute("""SELECT l.item_id, l.sold, c.checked_at FROM listings l LEFT JOIN comp_result c
                                ON c.account_id=l.account_id AND c.item_id=l.item_id WHERE l.account_id=? AND l.qty>0""", (a,)):
            if r["item_id"] in ids:
                rows.append((r["checked_at"] or "", -(r["sold"] or 0), a, r["item_id"]))
    rows.sort()
    return [(a, i) for _, _, a, i in rows[:n]]


# ------------------------------------------------------------------ what the page shows
def summarise(con, s=None):
    s = s or get_settings(con)
    fl = OF.Floors(con, s["comp_min_profit"])
    ign = {}
    for r in con.execute("SELECT account_id,item_id,other_id FROM comp_ignore"):
        ign.setdefault((r["account_id"], r["item_id"]), set()).add(r["other_id"])
    qs = {(r["account_id"], r["item_id"]): dict(r) for r in con.execute("SELECT * FROM comp_query")}
    res = {(r["account_id"], r["item_id"]): dict(r) for r in con.execute("SELECT * FROM comp_result")}
    sku_map = {r["item_id"]: r["sku"] for r in con.execute("SELECT item_id,sku FROM sku_map")}
    out = []
    for a in [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens ORDER BY account_id")]:
        for item in EB.active_listing_ids(con, a):
            l = con.execute("SELECT sku,title,price,qty,sold FROM listings WHERE account_id=? AND item_id=?", (a, item)).fetchone()
            sku = sku_map.get(item) or l["sku"] or ""
            q, r = qs.get((a, item)), res.get((a, item))
            row = {"account_id": a, "item_id": item, "sku": sku, "group": OF.PR.group_of(sku), "title": l["title"], "price": l["price"], "qty": l["qty"], "sold": l["sold"],
                   "checked": r["checked_at"] if r else None, "status": r["status"] if r else None, "message": r["message"] if r else None,
                   "query": q["query"] if q else None, "kind": q["kind"] if q else None, "post": q["our_post"] if q else None}
            if r and r["status"] == "ok":
                items = [x for x in json.loads(r["items"] or "[]") if x["id"] not in ign.get((a, item), set())]
                exact = [x for x in items if x.get("exact")]
                use = exact if exact else items
                row["n"], row["n_exact"], row["ignored"] = len(use), len(exact), len(ign.get((a, item), ()))
                row["items"] = items[:20]
                ours = (l["price"] or 0) + (row["post"] or 0)
                row["ours"] = round(ours, 2)
                floor, note = fl.floor(a, item, sku, l["price"])
                row["floor"], row["floor_note"] = floor, note
                if use:
                    tots = sorted(x["total"] for x in use)
                    c = use[0] if use[0]["total"] == tots[0] else min(use, key=lambda x: x["total"])
                    row.update(cheapest=c["total"], cheapest_seller=c["seller"], cheapest_id=c["id"], cheapest_url=c["url"],
                               median=round(statistics.median(tots), 2), rank=1 + sum(1 for t in tots if t < ours - 0.005))
                    row.update(_suggest(ours, row["post"] or 0, l["price"] or 0, tots, floor, s))
                else:
                    row.update(state="alone", why="No other seller found")
            out.append(row)
    return out


def _suggest(ours, post, price, tots, floor, s):
    cut = s["comp_undercut"]
    cheapest = tots[0]
    if ours <= cheapest + 0.005:
        nxt = cheapest
        gap = nxt - ours
        if price and gap > max(0.5, price * s["comp_raise_pct"] / 100):
            new = round(nxt - cut - post, 2)
            return {"state": "raise", "suggest": new, "why": f"You're cheapest by £{gap:.2f}; you could go up to £{new:.2f} and still be cheapest"}
        return {"state": "cheapest", "why": "You're the cheapest" + (f" (next £{gap:.2f} more)" if gap > 0.005 else " (same price)")}
    target = round(cheapest - cut - post, 2)
    if floor is None:
        return {"state": "nocost", "why": "Cheaper sellers exist; add the cost on the COGS page to get a safe price"}
    if target >= floor:
        return {"state": "match", "suggest": target, "why": f"£{ours - cheapest:.2f} above the cheapest; £{target:.2f} makes you cheapest"}
    # can't be cheapest: go as low as is safe if that still beats some sellers
    beat = [t for t in tots if t - cut - post >= floor]
    if floor < price - 0.005 and beat:
        return {"state": "lower", "suggest": floor, "why": f"Cheapest (£{cheapest:.2f}) is below your lowest safe price £{floor:.2f}; at £{floor:.2f} you'd beat {sum(1 for t in tots if t > floor + post)} of {len(tots)}"}
    return {"state": "cant", "why": f"Cheapest (£{cheapest:.2f}) is below your lowest safe price £{floor:.2f}"}


def start_scheduler(db_factory):
    def loop():
        time.sleep(900)
        while True:
            try:
                if EB.configured():
                    with db_factory() as con:
                        s = get_settings(con)
                        today = _dt.date.today().isoformat()
                        due = s["comp_auto"] and s["comp_last_auto"] != today and OF._uk_now().hour >= 3
                        if due:
                            con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('comp_last_auto',?)", (json.dumps(today),))
                            room = max(0, min(s["comp_daily"], DAILY_CAP - calls_today(con) - 200))
                            targets = auto_targets(con, room)
                    if due and targets:
                        run_check(db_factory, targets, by="automatic")
            except Exception:
                DB.log_exc("compete.loop")
            time.sleep(1800)
    threading.Thread(target=loop, daemon=True).start()
