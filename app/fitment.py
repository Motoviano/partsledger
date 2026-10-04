"""Fitment check: finds listings whose compatibility list (fitment) is missing, doesn't match the title, or has
fewer rows than the same SKU listed elsewhere.

- Each listing's fitment is read with GetItem (Trading API) and summarised per make/model with the year range.
- eBay's Taxonomy API says which categories take fitment at all (so listings in other categories aren't flagged).
- The same SKU on another listing (any of the three accounts) with more rows can be copied over in one go,
  through Bulk edit, which keeps the old fitment so it can be undone.
"""
import datetime as _dt
import json
import re
import threading
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

from . import ebay as EB
from . import db as DB
from . import titles as TL

N = EB.N
TAX = "https://api.ebay.com/commerce/taxonomy/v1/category_tree/3"  # 3 = eBay UK
MAX_RUN = 3000
SCHEMA = """
CREATE TABLE IF NOT EXISTS fit_result(
  account_id INTEGER NOT NULL, item_id TEXT NOT NULL, checked_at TEXT, title TEXT, category_id TEXT, rows INTEGER,
  fit TEXT, compat TEXT, status TEXT, message TEXT, PRIMARY KEY(account_id, item_id));
CREATE TABLE IF NOT EXISTS fit_cat(category_id TEXT PRIMARY KEY, supports INTEGER, props TEXT, fetched_at TEXT);
"""
PROGRESS = {"running": False, "total": 0, "done": 0, "failed": 0, "started": None, "by": None}
_lock = threading.Lock()


def now_iso():
    return _dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")


# ------------------------------------------------------------------ eBay
def read_listing(token, item_id):
    def b(root):
        EB._el(root, "ItemID", item_id)
        EB._el(root, "DetailLevel", "ReturnAll")
        EB._el(root, "IncludeItemCompatibilityList", "true")
    it = EB.trading("GetItem", token, b).find(N + "Item")
    return {"title": it.findtext(N + "Title") or "", "category_id": it.findtext(f"{N}PrimaryCategory/{N}CategoryID"),
            "compat": compat_rows(it)}


def compat_rows(it):
    rows = []
    for c in it.findall(f"{N}ItemCompatibilityList/{N}Compatibility"):
        nv = [[x.findtext(N + "Name") or "", x.findtext(N + "Value") or ""] for x in c.findall(N + "NameValueList")]
        if nv:
            rows.append({"nv": nv, "notes": c.findtext(N + "CompatibilityNotes") or ""})
    return rows


def current_rows(token, item_id):
    return read_listing(token, item_id)["compat"]


def write_rows(token, item_id, rows):
    """Replace the listing's whole fitment with these rows (an empty list removes it)."""
    import xml.etree.ElementTree as ET
    root = ET.Element(N + "ReviseFixedPriceItemRequest")
    item = EB._el(root, "Item")
    EB._el(item, "ItemID", item_id)
    if rows:
        cl = EB._el(item, "ItemCompatibilityList")
        EB._el(cl, "ReplaceAll", "true")
        for r in rows:
            c = EB._el(cl, "Compatibility")
            for name, value in r["nv"]:
                nv = EB._el(c, "NameValueList")
                EB._el(nv, "Name", name)
                EB._el(nv, "Value", value)
            if r.get("notes"):
                EB._el(c, "CompatibilityNotes", r["notes"][:500])
    else:
        EB._el(root, "DeletedField", "Item.ItemCompatibilityList")
    return EB.trading("ReviseFixedPriceItem", token, root_el=root)


def category_supports(con, category_id):
    """True/False whether eBay UK takes fitment in this category (Taxonomy API), cached; None if unknown."""
    if not category_id:
        return None
    r = con.execute("SELECT supports, fetched_at FROM fit_cat WHERE category_id=?", (category_id,)).fetchone()
    if r and r["fetched_at"] > (_dt.datetime.utcnow() - _dt.timedelta(days=30)).isoformat():
        return None if r["supports"] is None else bool(r["supports"])
    from . import compete as CP
    req = urllib.request.Request(f"{TAX}/get_compatibility_properties?" + urllib.parse.urlencode({"category_id": category_id}),
                                 headers={"Authorization": "Bearer " + CP._app_token(), "Accept": "application/json"})
    sup, props = None, []
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            j = json.loads(resp.read() or b"{}")
        props = [p.get("localizedName") or p.get("name") for p in j.get("compatibilityProperties") or []]
        sup = bool(props)
    except urllib.error.HTTPError as e:
        try:
            j = json.loads(e.read() or b"{}")
        except ValueError:
            j = {}
        txt = EB._err(j, "")
        if e.code in (400, 404) and re.search(r"not (a )?(valid|support|enabled)|compatib", txt, re.I):
            sup = False
        else:
            DB.log("warn", "fitment", f"Taxonomy for category {category_id}: {e.code} {txt}")
    except Exception:
        DB.log_exc("fitment.category", level="warn")
    con.execute("INSERT OR REPLACE INTO fit_cat VALUES(?,?,?,?)", (category_id, None if sup is None else int(sup), json.dumps(props), now_iso()))
    return sup


# ------------------------------------------------------------------ summarising fitment rows
def summary(rows):
    """[{make, model, y0, y1, n}] most rows first."""
    def pick(d, *keys):
        for k, v in d.items():
            kl = k.lower()
            if v and any(kl == x or kl.endswith(" " + x) or kl.startswith(x) for x in keys):
                return v.strip()
        return None
    counts, years = Counter(), defaultdict(set)
    for r in rows:
        d = {k: v for k, v in r["nv"]}
        make, model = pick(d, "make", "car make"), pick(d, "model")
        if not make:
            continue
        key = (make, model or "")
        counts[key] += 1
        for k, v in d.items():
            if "year" in k.lower():
                years[key].update(int(y) for y in re.findall(r"\b(?:19|20)\d{2}\b", v))
    out = []
    for (make, model), n in counts.most_common():
        ys = sorted(years[(make, model)])
        out.append({"make": make, "model": model, "y0": ys[0] if ys else None, "y1": ys[-1] if ys else None, "n": n})
    return out


def store_rows(con, account_id, item_id, rows):
    """After a fitment change made by the app: keep the stored check in step."""
    con.execute("UPDATE fit_result SET rows=?, fit=?, compat=?, checked_at=? WHERE account_id=? AND item_id=?",
                (len(rows), json.dumps(summary(rows)), json.dumps(rows), now_iso(), account_id, item_id))


YEARS = [(re.compile(r"\b((?:19|20)\d{2})\s*(?:-|–|to)\s*((?:19|20)\d{2}|\d{2})\b"), "range"),
         (re.compile(r"\b((?:19|20)\d{2})\s*(?:on\b|onwards\b|>|\+)", re.I), "open"),
         (re.compile(r"(?<![\d.])(\d{2})\s*-\s*(\d{2})(?![\d.])"), "short")]


def title_years(title):
    for rx, kind in YEARS:
        m = rx.search(title or "")
        if not m:
            continue
        if kind == "open":
            return int(m.group(1)), None
        a, b = m.group(1), m.group(2)
        if kind == "short":
            a, b = int(a), int(b)
            if not (a <= 40 or a >= 80) or not (b <= 40 or b >= 80):
                continue
            a, b = (2000 + a if a <= 40 else 1900 + a), (2000 + b if b <= 40 else 1900 + b)
        else:
            a = int(a)
            b = int(b) if len(b) == 4 else (a // 100 * 100 + int(b))
        if b >= a:
            return a, b
    return None


# ------------------------------------------------------------------ checking
def run_check(db_factory, targets, by=None):
    if not _lock.acquire(blocking=False):
        return False
    try:
        PROGRESS.update(running=True, total=len(targets), done=0, failed=0, started=now_iso(), by=by)
        tokens = {}
        for a, item in targets:
            try:
                with db_factory() as con:
                    if a not in tokens:
                        tokens[a] = EB.access_token(con, a)
                info = read_listing(tokens[a], item)
                with db_factory() as con:
                    category_supports(con, info["category_id"])
                    rows = info["compat"]
                    con.execute("INSERT OR REPLACE INTO fit_result VALUES(?,?,?,?,?,?,?,?,?,?)",
                                (a, item, now_iso(), info["title"], info["category_id"], len(rows), json.dumps(summary(rows)),
                                 json.dumps(rows), "ok", ""))
            except Exception as e:
                PROGRESS["failed"] += 1
                DB.log_exc("fitment.check", level="warn")
                with db_factory() as con:
                    con.execute("""INSERT INTO fit_result(account_id,item_id,checked_at,status,message) VALUES(?,?,?,?,?)
                                   ON CONFLICT(account_id,item_id) DO UPDATE SET checked_at=excluded.checked_at,status=excluded.status,message=excluded.message""",
                                (a, item, now_iso(), "error", str(e)[:400]))
            PROGRESS["done"] += 1
            time.sleep(0.15)
        DB.log("info", "fitment", f"Fitment check: {PROGRESS['done']} listings, {PROGRESS['failed']} failed")
        return True
    finally:
        PROGRESS["running"] = False
        _lock.release()


def start_check(db_factory, targets, by=None):
    if PROGRESS["running"]:
        return False
    threading.Thread(target=run_check, args=(db_factory, targets[:MAX_RUN]), kwargs={"by": by}, daemon=True).start()
    return True


# ------------------------------------------------------------------ what the page shows
LEVEL = {"none": 3, "make": 3, "fewer": 2, "years": 1, "model": 1}


def summarise(con, with_compat=False):
    sku_map = {r["item_id"]: r["sku"] for r in con.execute("SELECT item_id,sku FROM sku_map")}
    res = {(r["account_id"], r["item_id"]): dict(r) for r in con.execute(
        "SELECT account_id,item_id,checked_at,title,category_id,rows,fit,status,message" + (",compat" if with_compat else "") + " FROM fit_result")}
    cats = {r["category_id"]: r["supports"] for r in con.execute("SELECT category_id,supports FROM fit_cat")}
    names = {r["id"]: r["name"] for r in con.execute("SELECT id,name FROM accounts")}
    rows = []
    for a in [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens ORDER BY account_id")]:
        for item in EB.active_listing_ids(con, a):
            l = con.execute("SELECT sku,title,price,qty,sold FROM listings WHERE account_id=? AND item_id=?", (a, item)).fetchone()
            r = res.get((a, item))
            rows.append({"account_id": a, "item_id": item, "sku": sku_map.get(item) or l["sku"] or "", "title": (r or {}).get("title") or l["title"],
                         "price": l["price"], "qty": l["qty"], "sold": l["sold"], "checked": r["checked_at"] if r else None,
                         "status": r["status"] if r else None, "message": r["message"] if r else None,
                         "rows": r["rows"] if r and r["status"] == "ok" else None, "fit": json.loads(r["fit"]) if r and r["fit"] else [],
                         "supports": cats.get(r["category_id"]) if r else None, "compat": r.get("compat") if r else None})
    # the listing with the most fitment rows per SKU
    best = {}
    for x in rows:
        if x["sku"] and x["rows"]:
            b = best.get(x["sku"].upper())
            if not b or x["rows"] > b["rows"]:
                best[x["sku"].upper()] = x
    for x in rows:
        x["issues"] = issues(x, best.get(x["sku"].upper()) if x["sku"] else None, names)
        x["level"] = max((LEVEL[i["code"]] for i in x["issues"]), default=0)
        if not with_compat:
            x.pop("compat", None)
    return rows


def issues(x, twin, names):
    if x["rows"] is None:
        return []
    out, title, fit = [], x["title"] or "", x["fit"]
    shared = not x["fit"] or bool({TL._canon(f["make"]) for f in x["fit"]} & {TL._canon(f["make"]) for f in (twin or {}).get("fit", [])})
    if twin and twin is not x and shared and twin["rows"] > x["rows"] and (x["rows"] == 0 or twin["rows"] >= x["rows"] * 1.2 + 2):
        out.append({"code": "fewer", "from": [twin["account_id"], twin["item_id"]], "from_rows": twin["rows"],
                    "text": f"The same SKU on {names.get(twin['account_id'], 'another account')} ({twin['item_id']}) has {twin['rows']} fitment rows; this one has {x['rows']}"})
    if not x["rows"]:
        if x["supports"] is False:
            return out
        out.insert(0, {"code": "none", "text": "No fitment: the listing won't show for buyers who search with their car (My Garage)"})
        return out
    main = fit[0]
    fmakes = {TL._canon(f["make"]) for f in fit}
    tmakes = [m for m in TL.MAKES if TL._has(title, m)]
    if tmakes and not any(TL._canon(m) in fmakes for m in tmakes):
        out.append({"code": "make", "text": f"Title says {tmakes[0]} but the fitment is {main['make']}" + (f" {main['model']}" if main["model"] else "")})
    elif main["model"] and not TL._has(title, main["model"]):
        out.append({"code": "model", "text": f"Title doesn't name the main fitment: {main['make']} {main['model']} ({main['n']} rows). Bulk edit → Title from fitment can add it"})
    ty = title_years(title)
    if ty and main["y0"] and not any(i["code"] == "make" for i in out):
        t0, t1 = ty
        if t0 != main["y0"] or (t1 is not None and t1 != main["y1"]):
            out.append({"code": "years", "text": f"Title says {t0}–{t1 or 'on'}; the fitment for {main['make']} {main['model']} covers {main['y0']}–{main['y1']}"})
    return out
