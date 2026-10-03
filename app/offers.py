"""Offers to interested buyers (eBay Negotiation API).

eBay says which listings have interested buyers (watchers, abandoned baskets); an offer for one listing goes to
all of them. The offer price is the chosen discount off the current price, but never below the floor: the lowest
price that still leaves the minimum profit after COGS, average postage, the account's eBay fee rate and the
listing's ad rate. If the floor leaves less than a 5% discount, the listing is skipped.
Scope: sell.inventory (already granted when the accounts were connected).
"""
import datetime as _dt
import json
import math
import threading
import time
import urllib.request
from collections import defaultdict

from . import ebay as EB
from . import db as DB
from . import profit as PR

NEG = "https://api.ebay.com/sell/negotiation/v1"
SCHEMA = """
CREATE TABLE IF NOT EXISTS offer_log(
  id INTEGER PRIMARY KEY, at TEXT DEFAULT CURRENT_TIMESTAMP, by TEXT, auto INTEGER DEFAULT 0, account_id INTEGER, item_id TEXT,
  sku TEXT, title TEXT, price REAL, offer_price REAL, floor REAL, buyers INTEGER, status TEXT, message TEXT);
CREATE INDEX IF NOT EXISTS offer_log_item ON offer_log(account_id, item_id, at);
CREATE TABLE IF NOT EXISTS offer_state(account_id INTEGER PRIMARY KEY, last_check TEXT, last_status TEXT, last_message TEXT);
"""
DEFAULTS = {"offer_auto": False, "offer_discount": 10.0, "offer_min_profit": 1.0, "offer_min_discount": 5.0,
            "offer_days_between": 7, "offer_message": "Thanks for your interest in this part. Here's a special price for you, valid for 2 days."}
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


def set_settings(con, b):
    for k, v in b.items():
        if k in DEFAULTS:
            if k == "offer_auto":
                v = bool(v)
            elif k == "offer_message":
                v = str(v)[:1000].strip() or DEFAULTS[k]
            else:
                v = max(0.0, float(v))
            con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (k, json.dumps(v)))
    return get_settings(con)


def _req(method, url, token, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method, headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json", "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            st, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        st, raw = e.code, e.read()
    try:
        j = json.loads(raw or b"{}")
    except ValueError:
        j = {}
    return st, j


def eligible(token):
    out, off = [], 0
    while True:
        st, j = _req("GET", f"{NEG}/find_eligible_items?limit=200&offset={off}", token)
        if st == 204:
            return out
        if st >= 400:
            raise EB.EbayError("Finding interested buyers: " + EB._err(j, f"eBay error {st}"))
        rows = j.get("eligibleItems") or []
        out += [str(r.get("listingId")) for r in rows if r.get("listingId")]
        if len(rows) < 200:
            return out
        off += 200


def send(token, listing_id, price, message, days=2):
    body = {"allowCounterOffer": False, "message": message[:1000], "offerDuration": {"unit": "DAY", "value": int(days)},
            "offeredItems": [{"listingId": str(listing_id), "price": {"currency": "GBP", "value": f"{price:.2f}"}, "quantity": 1}]}
    st, j = _req("POST", f"{NEG}/send_offer_to_interested_buyers", token, body)
    if st >= 400:
        raise EB.EbayError(EB._err(j, f"eBay error {st}"))
    return len(j.get("offers") or [])


# ------------------------------------------------------------------ the profit floor
class Floors:
    """Lowest price per listing that keeps the minimum profit, from the same data as the profit pages."""

    def __init__(self, con, min_profit):
        settings = DB.get_settings(con)
        accounts, items, overheads, book = PR.build(con, settings)
        since = (_dt.date.today() - _dt.timedelta(days=90)).isoformat()
        fee = defaultdict(lambda: [0.0, 0.0]); post = defaultdict(lambda: [0.0, 0.0]); gpost = defaultdict(lambda: [0.0, 0.0])
        for x in items:  # [date, account, order, item, sku, group, title, qty, sales, fees, ads, post, ref, unit_cost, src, ret]
            if x[0] < since:
                continue
            fee[x[1]][0] += x[8]; fee[x[1]][1] -= x[9]
            post[x[4]][0] += x[7]; post[x[4]][1] -= x[11]
            gpost[x[5]][0] += x[7]; gpost[x[5]][1] -= x[11]
        tot = [sum(v[0] for v in fee.values()), sum(v[1] for v in fee.values())]
        self.default_fee = tot[1] / tot[0] if tot[0] > 0 else 0.13
        self.fee, self.post, self.gpost, self.book, self.min_profit = fee, post, gpost, book, min_profit
        self.ads = {(r["account_id"], r["item_id"]): r["rate"] or 0 for r in con.execute(
            "SELECT account_id,item_id,rate FROM ad_current WHERE funding='COST_PER_SALE'")} if con.execute(
            "SELECT name FROM sqlite_master WHERE name='ad_current'").fetchone() else {}

    def floor(self, account_id, item_id, sku, price):
        """(floor price or None, explanation)."""
        cost, src = self.book.cost(sku or "", _dt.date.today().isoformat(), price or 0)
        if src == "M":
            return None, "No cost for this SKU (add it on the COGS page)"
        f = self.fee.get(account_id)
        fr = f[1] / f[0] if f and f[0] > 50 else self.default_fee
        p = self.post.get(sku) or self.gpost.get(PR.group_of(sku or ""))
        po = max(0.0, p[1] / p[0]) if p and p[0] else 0.0
        ad = (self.ads.get((account_id, item_id)) or 0) / 100
        k = 1 - fr - ad
        if k <= 0:
            return None, "Fees and ads take the whole price"
        fl = math.ceil((self.min_profit + cost + po) / k * 100) / 100
        self.last = (k, cost, po)
        return fl, f"cost £{cost:.2f}{' (price band)' if src == 'P' else ''} · postage £{po:.2f} · fees {fr*100:.1f}% · ads {ad*100:.1f}%"


def plan(con, ids_by_account, s=None):
    """Proposed offer per eligible listing."""
    s = s or get_settings(con)
    fl = Floors(con, s["offer_min_profit"])
    sku_map = {r["item_id"]: r["sku"] for r in con.execute("SELECT item_id,sku FROM sku_map")}
    since = (_dt.datetime.utcnow() - _dt.timedelta(days=float(s["offer_days_between"]))).strftime("%Y-%m-%d %H:%M:%S")
    recent = {(r["account_id"], r["item_id"]): r["at"] for r in con.execute(
        "SELECT account_id,item_id,MAX(at) at FROM offer_log WHERE status='sent' GROUP BY 1,2")}
    out = []
    for a, ids in ids_by_account.items():
        for item in ids:
            l = con.execute("SELECT sku,title,price,qty FROM listings WHERE account_id=? AND item_id=?", (a, item)).fetchone()
            sku = sku_map.get(item) or (l["sku"] if l else None) or ""
            price = (l["price"] if l else None) or 0
            row = {"account_id": a, "item_id": item, "sku": sku, "title": l["title"] if l else "", "price": price,
                   "qty": l["qty"] if l else None, "last_offer": recent.get((a, item))}
            floor, why = fl.floor(a, item, sku, price) if price else (None, "Listing not in the app yet (sync listings first)")
            row["floor"], row["why"] = floor, why
            target = math.floor(price * (1 - s["offer_discount"] / 100) * 100) / 100 if price else None
            offer = max(target, floor) if (target is not None and floor is not None) else None
            row["offer"] = offer
            row["profit"] = round(offer * fl.last[0] - fl.last[1] - fl.last[2], 2) if offer is not None else None
            if offer is None:
                row["skip"] = why
            elif row["qty"] == 0:
                row["skip"] = "Out of stock"
            elif offer > price * (1 - s["offer_min_discount"] / 100) + 1e-9:
                row["skip"] = f"Floor £{floor:.2f} leaves less than a {s['offer_min_discount']:g}% discount"
            elif row["last_offer"] and row["last_offer"] >= since:
                row["skip"] = f"Offer already sent {row['last_offer'][:10]}"
            else:
                row["skip"] = None
            out.append(row)
    return out


def send_rows(db_factory, rows, user=None, auto=False):
    with db_factory() as con:
        s = get_settings(con)
    tokens, sent, failed = {}, 0, 0
    for r in rows:
        try:
            if r["account_id"] not in tokens:
                with db_factory() as con:
                    tokens[r["account_id"]] = EB.access_token(con, r["account_id"])
            n = send(tokens[r["account_id"]], r["item_id"], r["offer"], s["offer_message"])
            status, msg = "sent", f"Offer sent to {n} interested buyer{'s' if n != 1 else ''}"
            sent += 1
        except Exception as e:
            n, status, msg = 0, "failed", str(e)[:500]
            failed += 1
        with db_factory() as con:
            con.execute("INSERT INTO offer_log(by,auto,account_id,item_id,sku,title,price,offer_price,floor,buyers,status,message) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                        (user, 1 if auto else 0, r["account_id"], r["item_id"], r.get("sku"), r.get("title"), r.get("price"), r["offer"], r.get("floor"), n, status, msg))
        time.sleep(0.3)
    if sent or failed:
        DB.log("info" if not failed else "warn", "offers", f"{'Automatic' if auto else 'Manual'} offers: {sent} sent, {failed} failed", user=None)
    return sent, failed


def find_all(db_factory):
    """{account_id: [listing ids with interested buyers]}"""
    out = {}
    with db_factory() as con:
        accounts = [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens")]
    for a in accounts:
        try:
            with db_factory() as con:
                tok = EB.access_token(con, a)
            out[a] = eligible(tok)
            with db_factory() as con:
                con.execute("INSERT OR REPLACE INTO offer_state VALUES(?,?,?,?)", (a, now_iso(), "ok", f"{len(out[a])} listings with interested buyers"))
        except Exception as e:
            DB.log_exc("offers.find")
            with db_factory() as con:
                con.execute("INSERT OR REPLACE INTO offer_state VALUES(?,?,?,?)", (a, now_iso(), "error", str(e)[:500]))
    return out


def auto_cycle(db_factory):
    with _lock:
        with db_factory() as con:
            s = get_settings(con)
        if not s["offer_auto"]:
            return
        ids = find_all(db_factory)
        with db_factory() as con:
            rows = [r for r in plan(con, ids, s) if not r["skip"]]
        send_rows(db_factory, rows, auto=True)


def start_scheduler(db_factory, every_hours=6):
    def loop():
        time.sleep(420)
        while True:
            try:
                if EB.configured():
                    auto_cycle(db_factory)
            except Exception:
                DB.log_exc("offers.loop")
            time.sleep(every_hours * 3600)
    threading.Thread(target=loop, daemon=True).start()
