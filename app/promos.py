"""Discounts (eBay Marketing API, sell.marketing scope - already granted).

- All promotions per account, with pause / resume / end.
- A multi-buy (VOLUME_DISCOUNT) rule the app keeps up to date: listings under a price limit, in stock, that still make
  the minimum profit at the deepest tier. eBay allows 500 listings per promotion, so big sets are split into parts.
  A listing can be in only one multi-buy, so listings in someone else's multi-buy are left out.
- Sales (price markdowns) for chosen dates, with the same profit check.
"""
import datetime as _dt
import json
import math
import threading
import time
import urllib.request

from . import ebay as EB
from . import db as DB
from . import offers as OF

MKT = EB.MKT
SCHEMA = """
CREATE TABLE IF NOT EXISTS promo_managed(
  account_id INTEGER NOT NULL, part INTEGER NOT NULL, promotion_id TEXT, listing_ids TEXT, updated_at TEXT,
  PRIMARY KEY(account_id, part));
CREATE TABLE IF NOT EXISTS promo_cache(
  account_id INTEGER NOT NULL, promotion_id TEXT NOT NULL, name TEXT, type TEXT, status TEXT, start TEXT, end TEXT,
  listing_ids TEXT, scope TEXT, raw TEXT, fetched_at TEXT, PRIMARY KEY(account_id, promotion_id));
CREATE TABLE IF NOT EXISTS promo_log(
  id INTEGER PRIMARY KEY, at TEXT DEFAULT CURRENT_TIMESTAMP, by TEXT, account_id INTEGER, action TEXT, promotion_id TEXT,
  status TEXT, message TEXT);
"""
RULE_DEFAULT = {"enabled": False, "tiers": [10, 15], "max_price": 30.0, "min_profit": 1.0, "exclude_prefixes": "", "name": "Partsledger multi-buy"}
_lock = threading.Lock()


def now_iso():
    return _dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")


def _iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def get_rule(con):
    r = con.execute("SELECT value FROM settings WHERE key='promo_rule'").fetchone()
    return {**RULE_DEFAULT, **(json.loads(r[0]) if r else {})}


def set_rule(con, b):
    rule = get_rule(con)
    if "tiers" in b:
        t = [round(float(x), 1) for x in b["tiers"] if x not in (None, "")]
        if len(t) not in (2, 3) or not (5 <= t[0] <= 79) or any(t[i] <= t[i - 1] for i in range(1, len(t))) or t[-1] > 80:
            raise EB.EbayError("Multi-buy needs Buy 2 between 5% and 79%, then each tier higher than the one before (up to 80%).")
        rule["tiers"] = t
    for k in ("max_price", "min_profit"):
        if k in b:
            rule[k] = max(0.0, float(b[k] or 0))
    if "exclude_prefixes" in b:
        rule["exclude_prefixes"] = str(b["exclude_prefixes"] or "")[:300]
    if "enabled" in b:
        rule["enabled"] = bool(b["enabled"])
    con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('promo_rule',?)", (json.dumps(rule),))
    return rule


def _req(method, url, token, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method, headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json", "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            st, raw, h = r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        st, raw, h = e.code, e.read(), dict(e.headers or {})
    try:
        j = json.loads(raw or b"{}")
    except ValueError:
        j = {}
    return st, j, h


def _ok(st, j, what):
    if st >= 400:
        raise EB.EbayError(f"{what}: " + EB._err(j, f"eBay error {st}"))
    return j


# ------------------------------------------------------------------ reading promotions
def list_promotions(token):
    out, off = [], 0
    while True:
        st, j, _ = _req("GET", f"{MKT}/promotion?marketplace_id=EBAY_GB&limit=200&offset={off}", token)
        if st == 204:
            return out
        j = _ok(st, j, "Reading discounts")
        ps = j.get("promotions") or []
        out += ps
        if len(ps) < 200:
            return out
        off += 200


def promotion_detail(token, p):
    """(listing ids or None, scope text) of a promotion."""
    pid, typ = p.get("promotionId"), p.get("promotionType")
    path = "item_price_markdown" if typ == "MARKDOWN_SALE" else "item_promotion"
    st, j, _ = _req("GET", f"{MKT}/{path}/{pid}", token)
    if st >= 400:
        return None, "couldn't read"
    crits = [d.get("inventoryCriterion") or {} for d in j.get("selectedInventoryDiscounts") or []] if typ == "MARKDOWN_SALE" else [j.get("inventoryCriterion") or {}]
    ids, scope = [], []
    for c in crits:
        t = c.get("inventoryCriterionType")
        if t == "INVENTORY_BY_VALUE":
            ids += [str(x) for x in c.get("listingIds") or []]
            if c.get("inventoryItems"):
                scope.append("some listings by SKU")
        elif t == "INVENTORY_ANY":
            scope.append("all listings")
        elif t == "INVENTORY_BY_RULE":
            scope.append("listings by rule")
    return (ids if not scope else None), (", ".join(scope) or f"{len(ids)} listings")


def refresh(db_factory, account_id):
    with db_factory() as con:
        tok = EB.access_token(con, account_id)
    ps = list_promotions(tok)
    rows = []
    for p in ps:
        if p.get("promotionStatus") in ("ENDED", "INVALID"):
            continue
        ids, scope = promotion_detail(tok, p) if p.get("promotionType") in ("VOLUME_DISCOUNT", "MARKDOWN_SALE", "ORDER_DISCOUNT") else (None, "")
        rows.append((account_id, str(p.get("promotionId")), p.get("name"), p.get("promotionType"), p.get("promotionStatus"),
                     (p.get("startDate") or "")[:16], (p.get("endDate") or "")[:16], json.dumps(ids) if ids is not None else None,
                     scope, json.dumps(p)[:4000], now_iso()))
    with db_factory() as con:
        con.execute("DELETE FROM promo_cache WHERE account_id=?", (account_id,))
        con.executemany("INSERT OR REPLACE INTO promo_cache VALUES(?,?,?,?,?,?,?,?,?,?,?)", rows)
    return len(rows)


def refresh_all(db_factory):
    with db_factory() as con:
        accts = [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens")]
    for a in accts:
        try:
            refresh(db_factory, a)
        except Exception:
            DB.log_exc("promos.refresh")


# ------------------------------------------------------------------ who qualifies
def eligible(con, rule, tiers=None, max_price=None, prefix="", exclude_in_other=True, stack=None):
    """{account_id: {"in": [...], "out": [(item_id, sku, title, price, reason)]}} for a multi-buy or sale.
    stack: for a sale, the app multi-buy's deepest % - listings in it must still pass with both discounts."""
    tiers = tiers or rule["tiers"]
    deepest = max(tiers) / 100
    max_price = rule["max_price"] if max_price is None else max_price
    fl = OF.Floors(con, rule["min_profit"])
    sku_map = {r["item_id"]: r["sku"] for r in con.execute("SELECT item_id,sku FROM sku_map")}
    managed = {r["promotion_id"] for r in con.execute("SELECT promotion_id FROM promo_managed WHERE promotion_id IS NOT NULL")}
    other_multibuy = {}
    for r in con.execute("SELECT account_id,promotion_id,name,listing_ids FROM promo_cache WHERE type='VOLUME_DISCOUNT' AND status IN ('RUNNING','SCHEDULED','PAUSED','DRAFT')"):
        if r["promotion_id"] in managed or not r["listing_ids"]:
            continue
        for i in json.loads(r["listing_ids"]):
            other_multibuy[(r["account_id"], i)] = r["name"]
    in_ours = set()
    if stack:
        for r in con.execute("SELECT account_id,listing_ids FROM promo_managed WHERE promotion_id IS NOT NULL"):
            in_ours.update((r["account_id"], i) for i in json.loads(r["listing_ids"] or "{}").get("ids", []))
    excl = [x.strip().upper() for x in (rule.get("exclude_prefixes") or "").split(",") if x.strip()]
    out = {}
    for a in [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens ORDER BY account_id")]:
        res = {"in": [], "out": []}
        for item in EB.active_listing_ids(con, a):
            l = con.execute("SELECT sku,title,price,qty FROM listings WHERE account_id=? AND item_id=?", (a, item)).fetchone()
            sku = sku_map.get(item) or l["sku"] or ""
            price = l["price"] or 0
            why = None
            if prefix and not sku.upper().startswith(prefix.upper()):
                continue
            if max_price and price >= max_price:
                continue  # outside the price limit: not shown at all
            if excl and any(sku.upper().startswith(x) for x in excl):
                why = "SKU excluded"
            elif not l["qty"]:
                why = "Out of stock"
            elif exclude_in_other and (a, item) in other_multibuy:
                why = f"Already in another multi-buy: {other_multibuy[(a, item)]}"
            else:
                floor, note = fl.floor(a, item, sku, price)
                if floor is None:
                    why = note
                elif price * (1 - deepest) < floor:
                    why = f"At {max(tiers):g}% off (£{price * (1 - deepest):.2f}) it would leave less than £{rule['min_profit']:.2f}; lowest safe price £{floor:.2f}"
                elif (a, item) in in_ours and price * (1 - deepest) * (1 - stack / 100) < floor:
                    why = f"Also in the multi-buy: with both discounts (£{price * (1 - deepest) * (1 - stack / 100):.2f}) it would leave less than £{rule['min_profit']:.2f}"
            (res["out"] if why else res["in"]).append((item, sku, l["title"], price) + ((why,) if why else ()))
        out[a] = res
    return out


# ------------------------------------------------------------------ writing
def _volume_body(name, tiers, ids, start, end, status="SCHEDULED"):
    rules = [{"discountSpecification": {"minQuantity": 1}, "discountBenefit": {"percentageOffOrder": "0"}, "ruleOrder": 1}]
    for n, t in enumerate(tiers, start=2):
        rules.append({"discountSpecification": {"minQuantity": n}, "discountBenefit": {"percentageOffOrder": f"{t:g}"}, "ruleOrder": n})
    return {"name": name[:90], "marketplaceId": "EBAY_GB", "promotionStatus": status, "promotionType": "VOLUME_DISCOUNT",
            "applyDiscountToSingleItemOnly": False, "startDate": _iso(start), "endDate": _iso(end),
            "inventoryCriterion": {"inventoryCriterionType": "INVENTORY_BY_VALUE", "listingIds": ids[:500]}, "discountRules": rules}


def _new_id(h):
    loc = h.get("Location") or h.get("location") or ""
    return loc.rstrip("/").rsplit("/", 1)[-1] if loc else None


def sync_multibuy(db_factory, user=None):
    """Make the app's multi-buy promotions on every account match the rule."""
    with _lock:
        refresh_all(db_factory)
        with db_factory() as con:
            rule = get_rule(con)
            el = eligible(con, rule)
        start = _dt.datetime.utcnow() + _dt.timedelta(minutes=5)
        end = _dt.datetime.utcnow() + _dt.timedelta(days=365)
        summary = []
        for a, res in el.items():
            ids = [x[0] for x in res["in"]]
            parts = [ids[i:i + 500] for i in range(0, len(ids), 500)]
            try:
                with db_factory() as con:
                    tok = EB.access_token(con, a)
                    have = {r["part"]: dict(r) for r in con.execute("SELECT * FROM promo_managed WHERE account_id=?", (a,))}
                    live = {r["promotion_id"] for r in con.execute("SELECT promotion_id FROM promo_cache WHERE account_id=?", (a,))}
                for n, chunk in enumerate(parts, start=1):
                    h = have.get(n)
                    name = f"{rule['name']}" + (f" {n}" if len(parts) > 1 else "")
                    if h and h["promotion_id"] in live:
                        saved = json.loads(h["listing_ids"] or "{}")
                        if sorted(saved.get("ids", [])) == sorted(chunk) and saved.get("tiers") == rule["tiers"]:
                            continue  # nothing changed for this part
                        with db_factory() as con:
                            c = con.execute("SELECT start FROM promo_cache WHERE account_id=? AND promotion_id=?", (a, h["promotion_id"])).fetchone()
                        keep_start = _dt.datetime.fromisoformat(c["start"]) if c and c["start"] else start  # a running promotion keeps its start
                        body = _volume_body(name, rule["tiers"], chunk, keep_start, end)
                        st, j, _ = _req("PUT", f"{MKT}/item_promotion/{h['promotion_id']}", tok, body)
                        _ok(st, j, "Updating the multi-buy")
                        pid, act = h["promotion_id"], "updated"
                    else:
                        st, j, hd = _req("POST", f"{MKT}/item_promotion", tok, _volume_body(name, rule["tiers"], chunk, start, end))
                        _ok(st, j, "Creating the multi-buy")
                        pid, act = _new_id(hd), "created"
                    with db_factory() as con:
                        con.execute("INSERT OR REPLACE INTO promo_managed VALUES(?,?,?,?,?)", (a, n, pid, json.dumps({"ids": chunk, "tiers": rule["tiers"]}), now_iso()))
                        con.execute("INSERT INTO promo_log(by,account_id,action,promotion_id,status,message) VALUES(?,?,?,?,?,?)",
                                    (user, a, act, pid, "ok", f"Multi-buy {act}: {len(chunk)} listings, " + ", ".join(f"buy {i + 2}: {t:g}% off" for i, t in enumerate(rule["tiers"]))))
                # parts no longer needed
                for n, h in have.items():
                    if n > len(parts) and h["promotion_id"]:
                        _req("DELETE", f"{MKT}/item_promotion/{h['promotion_id']}", tok)
                        with db_factory() as con:
                            con.execute("DELETE FROM promo_managed WHERE account_id=? AND part=?", (a, n))
                summary.append(f"{a}: {len(ids)} in, {len(res['out'])} left out")
            except Exception as e:
                DB.log_exc("promos.sync")
                with db_factory() as con:
                    con.execute("INSERT INTO promo_log(by,account_id,action,status,message) VALUES(?,?,?,?,?)", (user, a, "sync", "failed", str(e)[:500]))
        refresh_all(db_factory)
        DB.log("info", "discounts", "Multi-buy sync: " + "; ".join(summary))


def stop_multibuy(db_factory, user=None):
    with db_factory() as con:
        rows = [dict(r) for r in con.execute("SELECT * FROM promo_managed")]
    for r in rows:
        try:
            with db_factory() as con:
                tok = EB.access_token(con, r["account_id"])
            if r["promotion_id"]:
                st, j, _ = _req("DELETE", f"{MKT}/item_promotion/{r['promotion_id']}", tok)
                if st >= 400 and st != 404:
                    _ok(st, j, "Ending the multi-buy")
            with db_factory() as con:
                con.execute("DELETE FROM promo_managed WHERE account_id=? AND part=?", (r["account_id"], r["part"]))
                con.execute("INSERT INTO promo_log(by,account_id,action,promotion_id,status,message) VALUES(?,?,?,?,?,?)",
                            (user, r["account_id"], "ended", r["promotion_id"], "ok", "App multi-buy ended"))
        except Exception as e:
            with db_factory() as con:
                con.execute("INSERT INTO promo_log(by,account_id,action,promotion_id,status,message) VALUES(?,?,?,?,?,?)",
                            (user, r["account_id"], "end", r["promotion_id"], "failed", str(e)[:500]))
    refresh_all(db_factory)


def create_sale(db_factory, account_id, name, pct, ids, start, end, user=None):
    with db_factory() as con:
        tok = EB.access_token(con, account_id)
    made = []
    for n, chunk in enumerate([ids[i:i + 500] for i in range(0, len(ids), 500)], start=1):
        body = {"name": (name + (f" {n}" if len(ids) > 500 else ""))[:90], "marketplaceId": "EBAY_GB", "promotionStatus": "SCHEDULED",
                "startDate": _iso(start), "endDate": _iso(end), "applyFreeShipping": False, "autoSelectFutureInventory": False,
                "blockPriceIncreaseInItemRevision": False,
                "selectedInventoryDiscounts": [{"discountBenefit": {"percentageOffItem": f"{pct:g}"}, "ruleOrder": 1,
                                                "inventoryCriterion": {"inventoryCriterionType": "INVENTORY_BY_VALUE", "listingIds": chunk}}]}
        st, j, h = _req("POST", f"{MKT}/item_price_markdown", tok, body)
        try:
            _ok(st, j, "Creating the sale")
            made.append(_new_id(h))
            msg, status = f"Sale created: {pct:g}% off {len(chunk)} listings, {start:%d %b} to {end:%d %b}", "ok"
        except EB.EbayError as e:
            msg, status = str(e), "failed"
        with db_factory() as con:
            con.execute("INSERT INTO promo_log(by,account_id,action,promotion_id,status,message) VALUES(?,?,?,?,?,?)",
                        (user, account_id, "sale", made[-1] if made and status == "ok" else None, status, msg[:500]))
    refresh(db_factory, account_id)
    return made


def act(db_factory, account_id, promotion_id, action, user=None):
    """pause / resume / end one promotion."""
    with db_factory() as con:
        tok = EB.access_token(con, account_id)
        p = con.execute("SELECT type FROM promo_cache WHERE account_id=? AND promotion_id=?", (account_id, promotion_id)).fetchone()
    typ = p["type"] if p else None
    if action in ("pause", "resume"):
        st, j, _ = _req("POST", f"{MKT}/promotion/{promotion_id}/{action}", tok)
    else:
        path = "item_price_markdown" if typ == "MARKDOWN_SALE" else "item_promotion"
        st, j, _ = _req("DELETE", f"{MKT}/{path}/{promotion_id}", tok)
    ok = st < 400
    with db_factory() as con:
        con.execute("INSERT INTO promo_log(by,account_id,action,promotion_id,status,message) VALUES(?,?,?,?,?,?)",
                    (user, account_id, action, promotion_id, "ok" if ok else "failed", "Done" if ok else EB._err(j, f"eBay error {st}")))
        if ok and action == "end":
            con.execute("DELETE FROM promo_managed WHERE promotion_id=?", (promotion_id,))
    refresh(db_factory, account_id)
    if not ok:
        raise EB.EbayError(EB._err(j, f"eBay error {st}"))


def start_scheduler(db_factory):
    def loop():
        time.sleep(600)
        while True:
            try:
                if EB.configured():
                    with db_factory() as con:
                        on = get_rule(con)["enabled"]
                    if on:
                        sync_multibuy(db_factory)
                    else:
                        refresh_all(db_factory)
            except Exception:
                DB.log_exc("promos.loop")
            time.sleep(24 * 3600)
    threading.Thread(target=loop, daemon=True).start()
