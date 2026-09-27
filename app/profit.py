"""Turns stored transactions into per-item profit lines, the same way as the May-Sep 2026 analysis.

Per sold item: sales, eBay fees (final value, per-order, regulatory - as charged), Promoted Listings ads,
postage labels, refunds/claims, COGS. Order-level amounts (postage, refunds) are split across the items
of an order by value. A fully refunded order counts as returned: the part comes back, so its COGS is
added back and the loss is only postage and any fees not refunded.
Costs that can't be tied to a sale (insertion fees, shop subscription, labels/refunds for orders outside
the loaded data, Amazon service fees) are returned as dated overheads.
"""
import bisect
import re
from collections import defaultdict

SKIP_TYPES = {"Charge", "Payout", "Hold", "Transfer"}


def group_of(sku: str) -> str:
    if not sku or sku.startswith("No SKU"):
        return "NO SKU"
    if sku.upper().startswith("MRR"):
        return "MRR"  # mirror glass: MRRCUS, MRRMK8, MRRSP6, MRRSP7
    m = re.match(r"^([A-Za-z]+)", sku)
    return m.group(1).upper() if m else "OTHER"


class CostBook:
    def __init__(self, con, settings):
        self.hist = defaultdict(list)
        for r in con.execute("SELECT sku,cost,effective_from,source FROM cogs ORDER BY sku,effective_from"):
            self.hist[r["sku"]].append((r["effective_from"], r["cost"], r["source"]))
        self.bands = sorted(settings["bands"])

    def current(self, sku):
        h = self.hist.get(sku)
        return h[-1] if h else None

    def cost(self, sku, date, unit_price):
        h = self.hist.get(sku)
        if h:
            i = bisect.bisect_right([x[0] for x in h], date) - 1
            if i >= 0:
                return h[i][1], "K"
        for limit, c in self.bands:
            if unit_price < limit:
                return c, "P"
        return 0.0, "M"  # no cost yet


def _rows(con, account_id):
    return [dict(r) for r in con.execute(
        "SELECT * FROM transactions WHERE account_id=? ORDER BY date,id", (account_id,)) if r["type"] not in SKIP_TYPES]


def build(con, settings):
    accounts = [dict(r) for r in con.execute("SELECT * FROM accounts ORDER BY sort,id")]
    sku_map = {r["item_id"]: r["sku"] for r in con.execute("SELECT item_id,sku FROM sku_map")}
    listing_sku = {(r["account_id"], r["item_id"]): r["sku"] for r in con.execute("SELECT account_id,item_id,sku FROM listings") if r["sku"]}
    book = CostBook(con, settings)
    ret_share = float(settings.get("returned_refund_share", 0.9))
    items, overheads = [], []

    for acc in accounts:
        rows = _rows(con, acc["id"])
        if not rows:
            continue
        if acc["channel"] == "amazon":
            it, oh = _amazon(acc, rows)
        else:
            it, oh = _ebay(acc, rows)
        for x in it:
            raw = x["sku_raw"]
            sku = sku_map.get(x["item_id"]) if x["item_id"] else None
            sku = sku or raw or listing_sku.get((acc["id"], x["item_id"])) or ("No SKU: " + (x["title"] or "")[:60])
            unit_cost, src = book.cost(sku, x["date"], x["unit_price"])
            returned = x["order_sales"] > 0 and -x["order_refund_gross"] >= ret_share * x["order_sales"]
            items.append([x["date"], acc["id"], x["order"], x["item_id"] or "", sku, group_of(sku), (x["title"] or "")[:100],
                          x["qty"], round(x["sales"], 2), round(x["fees"], 2), round(x["ads"], 2), round(x["post"], 2),
                          round(x["ref"], 2), round(unit_cost, 2), src, 1 if returned else 0])
        overheads += oh
    return accounts, items, overheads, book


def _ebay(acc, rows):
    orders = defaultdict(list)
    for r in rows:
        if r["type"] == "Order" and r["order_no"]:
            orders[r["order_no"]].append(r)
    ads = defaultdict(float)
    ads_rows = []
    post = defaultdict(float)
    refund_net = defaultdict(float)
    refund_gross = defaultdict(float)
    overheads = []
    for r in rows:
        desc = r["description"] or ""
        if r["type"] == "Other fee" and desc.startswith("Promoted Listings"):
            ads[(r["order_no"], r["item_id"])] += r["net"] or 0
            ads_rows.append(r)
        elif r["type"] == "Other fee":
            overheads.append([r["date"], acc["id"], re.sub(r"\s+\d.*$", "", desc).strip() or "Other eBay fee", round(r["net"] or 0, 2)])
        elif r["type"] == "Postage label":
            post[r["order_no"]] += r["net"] or 0
        elif r["type"] in ("Refund", "Claim"):
            refund_net[r["order_no"]] += r["net"] or 0
            if r["type"] == "Refund":
                refund_gross[r["order_no"]] += r["gross"] or 0
        elif r["type"] not in ("Order",):
            overheads.append([r["date"], acc["id"], r["type"], round(r["net"] or 0, 2)])

    items = []
    used_orders, used_ads = set(), set()
    for o, rs in orders.items():
        money = [r for r in rs if r["gross"] is not None]
        o_sales = sum(r["gross"] for r in money)
        o_net = sum(r["net"] or 0 for r in money)
        lines = [r for r in rs if r["item_id"]]
        if not lines:
            continue
        tot_q = sum((r["qty"] or 1) for r in lines)
        vals = []
        for r in lines:
            q = r["qty"] or 1
            v = r["item_subtotal"] if r["item_subtotal"] is not None else (
                (r["gross"] - (r["postage"] or 0)) if r["gross"] is not None else o_sales * q / tot_q)
            vals.append(max(v, 0))
        vsum = sum(vals) or 1
        date = min(r["date"] for r in rs)
        for r, v in zip(lines, vals):
            q = r["qty"] or 1
            sh = v / vsum
            items.append({"date": date, "order": o, "item_id": r["item_id"], "sku_raw": r["sku"], "title": r["title"], "qty": q,
                          "unit_price": round(v / q, 2), "sales": o_sales * sh, "fees": (o_net - o_sales) * sh,
                          "ads": ads.get((o, r["item_id"]), 0.0), "post": post.get(o, 0.0) * sh, "ref": refund_net.get(o, 0.0) * sh,
                          "order_sales": o_sales, "order_refund_gross": refund_gross.get(o, 0.0)})
            used_ads.add((o, r["item_id"]))
        used_orders.add(o)

    for r in rows:
        if r["type"] == "Postage label" and r["order_no"] not in used_orders:
            overheads.append([r["date"], acc["id"], "Postage not linked to a sale", round(r["net"] or 0, 2)])
        elif r["type"] in ("Refund", "Claim") and r["order_no"] not in used_orders:
            overheads.append([r["date"], acc["id"], "Refund on an order outside the data", round(r["net"] or 0, 2)])
    for r in ads_rows:
        if (r["order_no"], r["item_id"]) not in used_ads:
            overheads.append([r["date"], acc["id"], "Ads not linked to a sale", round(r["net"] or 0, 2)])
    return items, overheads


def _amazon(acc, rows):
    refunds = defaultdict(lambda: [0.0, 0.0])
    overheads = []
    for r in rows:
        if r["type"] == "Refund":
            k = (r["order_no"], r["sku"])
            refunds[k][0] += r["net"] or 0
            refunds[k][1] += r["gross"] or 0
        elif r["type"] != "Order":
            overheads.append([r["date"], acc["id"], r["description"] or "Amazon fee", round(r["net"] or 0, 2)])
    items, used = [], set()
    for r in rows:
        if r["type"] != "Order":
            continue
        q = r["qty"] or 1
        g = r["gross"] or 0
        k = (r["order_no"], r["sku"])
        rn, rg = refunds.get(k, (0.0, 0.0)) if k not in used else (0.0, 0.0)
        used.add(k)
        items.append({"date": r["date"], "order": r["order_no"], "item_id": None, "sku_raw": r["sku"], "title": r["title"], "qty": q,
                      "unit_price": round(g / q, 2) if q else g, "sales": g, "fees": (r["net"] or 0) - g, "ads": 0.0, "post": 0.0,
                      "ref": rn, "order_sales": g, "order_refund_gross": rg})
    for k, (rn, rg) in refunds.items():
        if k not in used:
            overheads.append([rows[-1]["date"], acc["id"], "Refund on an order outside the data", round(rn, 2)])
    return items, overheads


def cogs_table(con, items, book):
    """One row per SKU: cost now, where it came from, price per eBay account, units sold."""
    acc_ids = [r["id"] for r in con.execute("SELECT id FROM accounts ORDER BY sort,id")]
    info = {}
    for r in con.execute("SELECT account_id,item_id,sku,title,price FROM listings"):
        s = r["sku"] or None
        if not s:
            continue
        d = info.setdefault(s, {"title": r["title"], "prices": {}})
        p = d["prices"].get(r["account_id"])
        if r["price"] is not None and (p is None or r["price"] < p):
            d["prices"][r["account_id"]] = r["price"]
    units = defaultdict(float)
    for x in items:
        units[x[4]] += x[7]
        info.setdefault(x[4], {"title": x[6], "prices": {}})
    for s in book.hist:
        info.setdefault(s, {"title": "", "prices": {}})
    out = []
    bands = book.bands
    for s, d in sorted(info.items()):
        cur = book.current(s)
        prices = [d["prices"].get(a) for a in acc_ids]
        known = [p for p in prices if p is not None]
        if cur:
            src = cur[2] or "Your cost"
        elif known:
            p = min(known)
            b = next((c for lim, c in bands if p < lim), None)
            src = f"Price band £{b:g}" if b is not None else "Needs cost"
        else:
            src = "Price band"
        out.append({"sku": s, "group": group_of(s), "title": d["title"] or "", "cost": cur[1] if cur else None,
                    "since": cur[0] if cur and cur[0] > "2000-01-01" else None, "changes": len(book.hist.get(s, [])),
                    "source": src, "prices": prices, "units": units.get(s, 0)})
    return out
