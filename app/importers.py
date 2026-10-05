"""Read uploaded files, work out what they are, and store them.

Supported:
  * eBay Transaction report (CSV)      - account read from the "Seller," line
  * eBay All active listings report    - account matched by item numbers (or chosen on upload)
  * COGS list (CSV / XLSX)             - needs a SKU column and a cost column
  * Amazon Date Range transaction report (CSV) - Seller Central > Payments > Reports repository
Buyer names and addresses are never stored.
"""
import csv
import hashlib
import io
import re
from datetime import datetime

import pandas as pd

MISSING = {"", "--", "-", "nan", "None"}


class ImportError_(Exception):
    pass


def _txt(v):
    if v is None:
        return None
    s = str(v).strip()
    return None if s in MISSING else s


def _num(v):
    s = _txt(v)
    if s is None:
        return None
    s = s.replace(",", "").replace("£", "").replace("GBP", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def _date(s):
    s = _txt(s)
    if not s:
        return None
    s = s.replace("Sept", "Sep")
    s = re.sub(r"\s+(UTC|GMT|BST|PST|PDT)$", "", s)
    for fmt in ("%d %b %Y", "%d %b %Y %H:%M:%S", "%d %b %Y %I:%M:%S %p", "%b %d, %Y %I:%M:%S %p", "%d/%m/%Y", "%d/%m/%Y %H:%M:%S",
                "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%d.%m.%Y %H:%M:%S", "%d.%m.%Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    try:
        return pd.to_datetime(s, dayfirst=True).strftime("%Y-%m-%d")
    except Exception:
        return None


def decode(raw: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise ImportError_("Couldn't read the file's text encoding.")


def detect(filename: str, raw: bytes):
    """Return one of: ebay_tx, ebay_listings, amazon_tx, cogs."""
    name = filename.lower()
    if name.endswith((".xlsx", ".xls")):
        return "cogs"
    text = decode(raw)
    head = text[:6000]
    if "Transaction creation date" in head and "Seller," in head:
        return "ebay_tx"
    if "Item number" in head and "Custom label (SKU)" in head:
        return "ebay_listings"
    low = head.lower()
    if "settlement id" in low and "order id" in low and ("date/time" in low):
        return "amazon_tx"
    first = text.splitlines()[0].lower() if text else ""
    if "sku" in first and ("cost" in first or "cogs" in first):
        return "cogs"
    raise ImportError_("This file isn't one I recognise. Upload an eBay Transaction report, an eBay All active listings report, "
                       "an Amazon Date Range transaction report, or a COGS list with SKU and cost columns.")


def _row_keys(prefix, rows):
    """Stable key per row so re-uploading overlapping reports never double counts.
    Identical rows inside one file are told apart by their position among identical rows."""
    seen = {}
    keys = []
    for r in rows:
        h = hashlib.sha1((prefix + "|" + "|".join("" if v is None else str(v) for v in r)).encode()).hexdigest()
        n = seen.get(h, 0)
        seen[h] = n + 1
        keys.append(f"{h}#{n}")
    return keys


# ---------------------------------------------------------------- eBay transactions
EBAY_COLS = {
    "date": "Transaction creation date", "type": "Type", "order_no": "Order number", "item_id": "Item ID",
    "title": "Item title", "sku": "Custom label", "qty": "Quantity", "item_subtotal": "Item subtotal",
    "postage": "Postage and packaging", "gross": "Gross transaction amount", "net": "Net amount",
    "description": "Description", "reference": "Reference ID", "fvf_fixed": "Final value fee – fixed",
    "fvf_var": "Final value fee – variable", "txn_id": "Transaction ID",
}


def parse_ebay_tx(raw: bytes):
    text = decode(raw)
    lines = text.splitlines()
    seller = None
    start = None
    for i, l in enumerate(lines[:40]):
        if l.startswith("Seller,"):
            seller = l.split(",", 1)[1].strip().strip('"')
        if l.startswith("Transaction creation date"):
            start = i
            break
    if start is None:
        raise ImportError_("Couldn't find the header row of the eBay Transaction report.")
    rdr = csv.DictReader(io.StringIO("\n".join(lines[start:])))
    rows = []
    for r in rdr:
        g = {k: r.get(v) for k, v in EBAY_COLS.items()}
        d = _date(g["date"])
        if not d or not _txt(g["type"]):
            continue
        rows.append({
            "date": d, "type": _txt(g["type"]), "order_no": _txt(g["order_no"]), "item_id": _txt(g["item_id"]),
            "title": _txt(g["title"]), "sku": _txt(g["sku"]), "qty": _num(g["qty"]),
            "item_subtotal": _num(g["item_subtotal"]), "postage": _num(g["postage"]),
            "gross": _num(g["gross"]), "net": _num(g["net"]), "description": _txt(g["description"]),
            "_key": [d, _txt(g["type"]), _txt(g["order_no"]), _txt(g["item_id"]), _txt(g["txn_id"]), _txt(g["qty"]),
                     _txt(g["gross"]), _txt(g["net"]), _txt(g["reference"]), _txt(g["description"]), _txt(g["fvf_fixed"]), _txt(g["fvf_var"])],
        })
    if not rows:
        raise ImportError_("The Transaction report has no rows.")
    return seller, rows


# ---------------------------------------------------------------- eBay listings
def parse_ebay_listings(raw: bytes):
    df = pd.read_csv(io.StringIO(decode(raw)), dtype=str, keep_default_na=False)
    need = ["Item number", "Title", "Custom label (SKU)", "Current price"]
    for c in need:
        if c not in df.columns:
            raise ImportError_(f"The listings report is missing the '{c}' column.")
    out = []
    for _, r in df.iterrows():
        out.append({"item_id": _txt(r["Item number"]), "sku": _txt(r.get("Custom label (SKU)")), "title": _txt(r.get("Title")),
                    "price": _num(r.get("Current price")), "qty": int(_num(r.get("Available quantity")) or 0),
                    "category": _txt(r.get("eBay category 1 name")), "sold": int(_num(r.get("Sold quantity")) or 0)})
    return [o for o in out if o["item_id"]]


# ---------------------------------------------------------------- COGS list
def parse_cogs(filename: str, raw: bytes):
    if filename.lower().endswith((".xlsx", ".xls")):
        xl = pd.ExcelFile(io.BytesIO(raw))
        frames = []
        for sh in xl.sheet_names:
            df = xl.parse(sh, dtype=str)
            frames.append(df)
    else:
        frames = [pd.read_csv(io.StringIO(decode(raw)), dtype=str, keep_default_na=False)]
    out = {}
    for df in frames:
        cols = {c: str(c).strip().lower() for c in df.columns}
        sku_c = next((c for c, l in cols.items() if l in ("sku", "custom label", "custom label (sku)", "motoviano sku", "motoviano code")), None) \
            or next((c for c, l in cols.items() if "sku" in l), None)
        cost_c = next((c for c, l in cols.items() if l in ("cogs", "cost", "cost (£)", "cogs (£)", "known cogs (£)", "unit cost")), None) \
            or next((c for c, l in cols.items() if "cogs" in l or l.startswith("cost")), None)
        if not sku_c or not cost_c:
            continue
        for _, r in df.iterrows():
            s, c = _txt(r[sku_c]), _num(r[cost_c])
            if s and c is not None and c >= 0:
                out[s] = round(c, 2)
    if not out:
        raise ImportError_("Couldn't find a SKU column and a cost (or COGS) column in this file.")
    return out


# ---------------------------------------------------------------- Amazon
def _find(cols, *names):
    for n in names:
        for c in cols:
            if c.strip().lower() == n:
                return c
    return None


def parse_amazon_tx(raw: bytes):
    text = decode(raw)
    lines = text.splitlines()
    start = next((i for i, l in enumerate(lines[:30]) if "date/time" in l.lower() and "order id" in l.lower()), None)
    if start is None:
        raise ImportError_("Couldn't find the header row of the Amazon report.")
    df = pd.read_csv(io.StringIO("\n".join(lines[start:])), dtype=str, keep_default_na=False)
    cols = list(df.columns)
    c = {k: _find(cols, *v) for k, v in {
        "date": ("date/time",), "type": ("type",), "order": ("order id",), "sku": ("sku",), "desc": ("description",),
        "qty": ("quantity",), "sales": ("product sales",), "post": ("postage credits", "shipping credits"),
        "gift": ("gift wrap credits",), "promo": ("promotional rebates",), "total": ("total",),
    }.items()}
    if not c["date"] or not c["type"] or not c["total"]:
        raise ImportError_("The Amazon report is missing its date/time, type or total column.")
    rows = []
    for _, r in df.iterrows():
        d = _date(r[c["date"]])
        if not d:
            continue
        typ = _txt(r[c["type"]]) or "Other"
        sales = sum((_num(r[c[k]]) or 0) for k in ("sales", "post", "gift", "promo") if c[k])
        total = _num(r[c["total"]]) or 0
        t_norm = {"order": "Order", "refund": "Refund", "transfer": "Payout"}.get(typ.lower(), "Other fee")
        rows.append({"date": d, "type": t_norm, "order_no": _txt(r[c["order"]]) if c["order"] else None, "item_id": None,
                     "title": _txt(r[c["desc"]]) if c["desc"] else None, "sku": _txt(r[c["sku"]]) if c["sku"] else None,
                     "qty": _num(r[c["qty"]]) if c["qty"] else None, "item_subtotal": sales if t_norm in ("Order", "Refund") else None,
                     "postage": 0.0, "gross": sales if t_norm in ("Order", "Refund") else total, "net": total,
                     "description": typ if t_norm == "Other fee" else (_txt(r[c["desc"]]) if c["desc"] else None),
                     "_key": [str(v) for v in r.values]})
    if not rows:
        raise ImportError_("The Amazon report has no rows.")
    return rows


# ---------------------------------------------------------------- store
def store_transactions(con, account_id, rows, upload_id):
    keys = _row_keys(str(account_id), [r["_key"] for r in rows])
    added = 0
    for r, k in zip(rows, keys):
        cur = con.execute(
            """INSERT OR IGNORE INTO transactions(account_id,row_key,date,type,order_no,item_id,title,sku,qty,item_subtotal,postage,gross,net,description,upload_id)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (account_id, k, r["date"], r["type"], r["order_no"], r["item_id"], r["title"], r["sku"], r["qty"],
             r["item_subtotal"], r["postage"], r["gross"], r["net"], r["description"], upload_id))
        added += cur.rowcount
    return added, len(rows) - added


def store_listings(con, account_id, rows):
    today = datetime.utcnow().strftime("%Y-%m-%d")
    for r in rows:
        con.execute("""INSERT INTO listings(account_id,item_id,sku,title,price,qty,category,sold,updated_at,img) VALUES(?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(account_id,item_id) DO UPDATE SET sku=excluded.sku,title=excluded.title,price=excluded.price,
                       qty=excluded.qty,category=excluded.category,sold=excluded.sold,updated_at=excluded.updated_at,
                       img=COALESCE(excluded.img, listings.img)""",
                    (account_id, r["item_id"], r["sku"], r["title"], r["price"], r["qty"], r["category"], r["sold"], today, r.get("img")))
    return len(rows)


def guess_listing_account(con, rows):
    ids = [r["item_id"] for r in rows]
    best, best_n = None, 0
    for a in con.execute("SELECT id FROM accounts WHERE channel='ebay'"):
        q = ",".join("?" * len(ids[:900]))
        n1 = con.execute(f"SELECT COUNT(*) FROM listings WHERE account_id=? AND item_id IN ({q})", [a["id"], *ids[:900]]).fetchone()[0]
        n2 = con.execute(f"SELECT COUNT(DISTINCT item_id) FROM transactions WHERE account_id=? AND item_id IN ({q})", [a["id"], *ids[:900]]).fetchone()[0]
        n = max(n1, n2)
        if n > best_n:
            best, best_n = a["id"], n
    return best if best_n >= 3 else None
