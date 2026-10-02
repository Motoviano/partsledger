"""Stock sync across eBay accounts.

One stock count per SKU ("on hand"). Every listing of that SKU on every connected account is kept at that
quantity (or a lower cap). New orders, checked every 10 minutes through the Fulfillment API, take the sold
units off the count; the other listings are then updated with ReviseInventoryStatus.

Safety:
- nothing is sent to eBay unless automatic sync is switched on, or someone presses "Update eBay now";
- a SKU is only synced once a stock number has been set for it, and only sales after that moment count;
- a listing is never set to 0 on an account where eBay's out-of-stock control is off (eBay would end it).
"""
import datetime as _dt
import json
import threading
import time
import urllib.parse
import xml.etree.ElementTree as ET

from . import ebay as EB

N = EB.N

SCHEMA = """
CREATE TABLE IF NOT EXISTS stock_pool(
  sku TEXT PRIMARY KEY, on_hand INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
  set_at TEXT, set_by TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS stock_seen(
  account_id INTEGER NOT NULL, order_id TEXT NOT NULL, line_id TEXT NOT NULL,
  PRIMARY KEY(account_id, order_id, line_id));
CREATE TABLE IF NOT EXISTS stock_log(
  id INTEGER PRIMARY KEY, at TEXT DEFAULT CURRENT_TIMESTAMP, sku TEXT, change INTEGER, on_hand INTEGER,
  reason TEXT, account_id INTEGER, item_id TEXT, order_id TEXT, by TEXT);
CREATE TABLE IF NOT EXISTS stock_push(
  id INTEGER PRIMARY KEY, at TEXT DEFAULT CURRENT_TIMESTAMP, account_id INTEGER, item_id TEXT, sku TEXT,
  old_qty INTEGER, new_qty INTEGER, status TEXT, message TEXT);
CREATE TABLE IF NOT EXISTS stock_state(
  account_id INTEGER PRIMARY KEY, last_check TEXT, last_status TEXT, last_message TEXT,
  oos_control INTEGER, oos_checked TEXT);
"""
DEFAULTS = {"stock_auto": False, "stock_cap": 0}
_lock = threading.Lock()


def now_iso():
    return _dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")


def get_settings(con):
    out = dict(DEFAULTS)
    for k in DEFAULTS:
        r = con.execute("SELECT value FROM settings WHERE key=?", (k,)).fetchone()
        if r:
            out[k] = json.loads(r[0])
    return out


def set_setting(con, k, v):
    con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (k, json.dumps(v)))


def _sku_of(con):
    sku_map = {r["item_id"]: r["sku"] for r in con.execute("SELECT item_id,sku FROM sku_map")}
    lsku = {(r["account_id"], r["item_id"]): r["sku"] for r in con.execute("SELECT account_id,item_id,sku FROM listings") if r["sku"]}
    return lambda account_id, item_id, raw=None: sku_map.get(item_id) or raw or lsku.get((account_id, item_id)) or ""


def listings_by_sku(con):
    """Active listings on connected eBay accounts, grouped by SKU."""
    sku = _sku_of(con)
    out = {}
    for a in [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens ORDER BY account_id")]:
        active = set(EB.active_listing_ids(con, a))
        for r in con.execute("SELECT item_id,sku,title,qty FROM listings WHERE account_id=?", (a,)):
            if r["item_id"] in active:
                s = sku(a, r["item_id"], r["sku"])
                if s:
                    out.setdefault(s, []).append({"account_id": a, "item_id": r["item_id"], "qty": r["qty"], "title": r["title"]})
    return out


def target_of(on_hand, cap):
    t = max(0, int(on_hand))
    return min(t, int(cap)) if cap else t


def plan(con):
    """Listings whose quantity on eBay differs from the stock count."""
    st = get_settings(con)
    oos = {r["account_id"]: r["oos_control"] for r in con.execute("SELECT account_id,oos_control FROM stock_state")}
    by = listings_by_sku(con)
    out = []
    for p in con.execute("SELECT * FROM stock_pool WHERE enabled=1 AND on_hand IS NOT NULL"):
        tgt = target_of(p["on_hand"], st["stock_cap"])
        for l in by.get(p["sku"], []):
            if l["qty"] == tgt:
                continue
            blocked = None
            if tgt == 0 and oos.get(l["account_id"]) == 0:
                blocked = "Out-of-stock control is off on this account, so eBay would end the listing"
            out.append({**l, "sku": p["sku"], "new_qty": tgt, "blocked": blocked})
    return out


def push(db_factory, rows):
    """Send quantities to eBay, one listing at a time so each gets its own result."""
    from .edits import _inventory
    done = failed = 0
    tokens = {}
    for r in rows:
        if r.get("blocked"):
            continue
        try:
            if r["account_id"] not in tokens:
                with db_factory() as con:
                    tokens[r["account_id"]] = EB.access_token(con, r["account_id"])
            _inventory(tokens[r["account_id"]], r["item_id"], qty=r["new_qty"])
            status, msg = "ok", f"Quantity {r['qty']} → {r['new_qty']}"
            done += 1
        except Exception as e:
            status, msg = "failed", str(e)[:500]
            failed += 1
        with db_factory() as con:
            con.execute("INSERT INTO stock_push(account_id,item_id,sku,old_qty,new_qty,status,message) VALUES(?,?,?,?,?,?,?)",
                        (r["account_id"], r["item_id"], r["sku"], r["qty"], r["new_qty"], status, msg))
            if status == "ok":
                con.execute("UPDATE listings SET qty=? WHERE account_id=? AND item_id=?", (r["new_qty"], r["account_id"], r["item_id"]))
        time.sleep(0.2)
    return done, failed


# ------------------------------------------------------------------ reading new orders
def fetch_new_orders(token, since_iso):
    out, offset = [], 0
    while True:
        q = urllib.parse.urlencode({"filter": f"creationdate:[{since_iso}.000Z..]", "limit": 200, "offset": offset})
        j = EB._get_json(f"{EB.FUL}/order?{q}", token, marketplace=False)
        rows = j.get("orders") or []
        out += rows
        if len(rows) < 200:
            return out
        offset += 200


def oos_control(token):
    def b(root):
        EB._el(root, "ShowOutOfStockControlPreference", "true")
    r = EB.trading("GetUserPreferences", token, b)
    v = r.findtext(f"{N}OutOfStockControlPreference")
    return None if v is None else (1 if v.lower() == "true" else 0)


def check_orders(db_factory):
    """Take newly sold units off the stock counts. Returns the SKUs that changed."""
    changed = set()
    with db_factory() as con:
        accounts = [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens")]
        pool = {r["sku"]: dict(r) for r in con.execute("SELECT * FROM stock_pool WHERE on_hand IS NOT NULL")}
    if not pool:
        return changed
    first_set = min((p["set_at"] or now_iso()) for p in pool.values())
    for a in accounts:
        try:
            with db_factory() as con:
                tok = EB.access_token(con, a)
                st = con.execute("SELECT * FROM stock_state WHERE account_id=?", (a,)).fetchone()
                if not st or st["oos_checked"] is None or st["oos_checked"] < (_dt.datetime.utcnow() - _dt.timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S"):
                    try:
                        oc = oos_control(tok)
                    except Exception:
                        oc = st["oos_control"] if st else None
                    con.execute("INSERT INTO stock_state(account_id,oos_control,oos_checked) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET oos_control=excluded.oos_control, oos_checked=excluded.oos_checked",
                                (a, oc, now_iso()))
                last = (st["last_check"] if st and st["last_check"] else first_set)
            since = (_dt.datetime.fromisoformat(max(last, first_set)) - _dt.timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%S")
            started = now_iso()
            orders = fetch_new_orders(tok, since)
            n_units = 0
            with db_factory() as con:
                sku = _sku_of(con)
                for o in orders:
                    if ((o.get("cancelStatus") or {}).get("cancelState") or "") == "CANCELED":
                        continue
                    created = (o.get("creationDate") or "")[:19]
                    for li in o.get("lineItems") or []:
                        s = sku(a, li.get("legacyItemId"), li.get("sku"))
                        p = pool.get(s)
                        if not p or not p["enabled"] or created < (p["set_at"] or ""):
                            continue  # not synced, or sold before the stock number was set
                        cur = con.execute("INSERT OR IGNORE INTO stock_seen(account_id,order_id,line_id) VALUES(?,?,?)",
                                          (a, o.get("orderId"), li.get("lineItemId") or li.get("legacyItemId")))
                        if not cur.rowcount:
                            continue
                        q = int(li.get("quantity") or 1)
                        con.execute("UPDATE stock_pool SET on_hand=MAX(on_hand-?,0), updated_at=? WHERE sku=?", (q, now_iso(), s))
                        left = con.execute("SELECT on_hand FROM stock_pool WHERE sku=?", (s,)).fetchone()[0]
                        pool[s]["on_hand"] = left
                        con.execute("INSERT INTO stock_log(sku,change,on_hand,reason,account_id,item_id,order_id) VALUES(?,?,?,?,?,?,?)",
                                    (s, -q, left, "Sold", a, li.get("legacyItemId"), o.get("orderId")))
                        changed.add(s)
                        n_units += q
                con.execute("INSERT INTO stock_state(account_id,last_check,last_status,last_message) VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET last_check=excluded.last_check, last_status=excluded.last_status, last_message=excluded.last_message",
                            (a, started, "ok", f"{len(orders)} recent orders checked, {n_units} synced units sold"))
        except Exception as e:
            with db_factory() as con:
                con.execute("INSERT INTO stock_state(account_id,last_status,last_message) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET last_status=excluded.last_status, last_message=excluded.last_message",
                            (a, "error", str(e)[:500]))
    return changed


def cycle(db_factory, force_push=False):
    with _lock:
        check_orders(db_factory)
        with db_factory() as con:
            auto = get_settings(con)["stock_auto"]
            rows = plan(con) if (auto or force_push) else []
        return push(db_factory, rows) if rows else (0, 0)


def start_scheduler(db_factory, every_minutes=10):
    def loop():
        time.sleep(90)
        while True:
            try:
                if EB.configured():
                    cycle(db_factory)
            except Exception:
                pass
            time.sleep(every_minutes * 60)
    threading.Thread(target=loop, daemon=True).start()


# ------------------------------------------------------------------ setting stock numbers
def set_stock(con, items, user):
    """items: [{sku, on_hand (int or None), enabled (bool)}]. Setting a number restarts counting from now."""
    t = now_iso()
    n = 0
    for it in items:
        sku = (it.get("sku") or "").strip()
        if not sku:
            continue
        cur = con.execute("SELECT * FROM stock_pool WHERE sku=?", (sku,)).fetchone()
        oh = it.get("on_hand", cur["on_hand"] if cur else None)
        oh = None if oh in (None, "") else max(0, int(oh))
        en = 1 if it.get("enabled", cur["enabled"] if cur else 1) else 0
        changed_number = not cur or cur["on_hand"] != oh
        con.execute("""INSERT INTO stock_pool(sku,on_hand,enabled,set_at,set_by,updated_at) VALUES(?,?,?,?,?,?)
                       ON CONFLICT(sku) DO UPDATE SET on_hand=excluded.on_hand, enabled=excluded.enabled,
                       set_at=CASE WHEN ? THEN excluded.set_at ELSE stock_pool.set_at END,
                       set_by=CASE WHEN ? THEN excluded.set_by ELSE stock_pool.set_by END, updated_at=excluded.updated_at""",
                    (sku, oh, en, t, user, t, changed_number, changed_number))
        if changed_number:
            con.execute("INSERT INTO stock_log(sku,change,on_hand,reason,by) VALUES(?,?,?,?,?)",
                        (sku, None if oh is None or not cur or cur["on_hand"] is None else oh - cur["on_hand"], oh,
                         "Set by hand" if oh is not None else "Stock number cleared", user))
        n += 1
    return n
