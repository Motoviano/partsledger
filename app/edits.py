"""Bulk edits to live eBay listings: price, quantity, title, item specifics.

Every change keeps the old value, so a whole job can be undone. Price and quantity go through
ReviseInventoryStatus (quantity there is the quantity available); title and item specifics through
ReviseFixedPriceItem. eBay replaces the whole item-specifics block on a revise, so the listing's current
specifics are read first and the change is merged in.
"""
import json
import threading
import time
import xml.etree.ElementTree as ET

from . import ebay as EB
from . import db as DB

N = EB.N

SCHEMA = """
CREATE TABLE IF NOT EXISTS edit_jobs(
  id INTEGER PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP, created_by TEXT, kind TEXT, summary TEXT,
  status TEXT, total INTEGER, done INTEGER DEFAULT 0, ok INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0, undo_of INTEGER, undone_by INTEGER);
CREATE TABLE IF NOT EXISTS edit_items(
  id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, account_id INTEGER NOT NULL, item_id TEXT NOT NULL,
  sku TEXT, title TEXT, field TEXT NOT NULL, old_value TEXT, new_value TEXT,
  status TEXT DEFAULT 'waiting', message TEXT);
CREATE INDEX IF NOT EXISTS edit_items_job ON edit_items(job_id);
"""
FIELDS = {"price", "qty", "title", "specific", "bestoffer"}
_lock = threading.Lock()


class Skip(Exception):
    """Nothing to change for this listing (not an error)."""


# ------------------------------------------------------------------ single changes
def _inventory(token, item_id, price=None, qty=None):
    root = ET.Element(N + "ReviseInventoryStatusRequest")
    inv = EB._el(root, "InventoryStatus")
    EB._el(inv, "ItemID", item_id)
    if price is not None:
        EB._el(inv, "StartPrice", f"{float(price):.2f}")
    if qty is not None:
        EB._el(inv, "Quantity", str(int(qty)))
    return EB.trading("ReviseInventoryStatus", token, root_el=root)


def _revise(token, item_id, fill):
    root = ET.Element(N + "ReviseFixedPriceItemRequest")
    item = EB._el(root, "Item")
    EB._el(item, "ItemID", item_id)
    fill(item)
    return EB.trading("ReviseFixedPriceItem", token, root_el=root)


def _specifics(token, item_id):
    """Current item specifics as an ordered list of (name, [values])."""
    def b(root):
        EB._el(root, "ItemID", item_id)
        EB._el(root, "DetailLevel", "ReturnAll")
        EB._el(root, "IncludeItemSpecifics", "true")
    it = EB.trading("GetItem", token, b).find(N + "Item")
    out = []
    for nv in it.findall(f"{N}ItemSpecifics/{N}NameValueList"):
        name = nv.findtext(N + "Name")
        if name:
            out.append((name, [v.text or "" for v in nv.findall(N + "Value")]))
    return out, it.findtext(N + "Title")


def _write_specifics(token, item_id, specs):
    if not specs:  # an empty block doesn't clear them; eBay needs the field deleted
        root = ET.Element(N + "ReviseFixedPriceItemRequest")
        EB._el(EB._el(root, "Item"), "ItemID", item_id)
        EB._el(root, "DeletedField", "Item.ItemSpecifics")
        return EB.trading("ReviseFixedPriceItem", token, root_el=root)

    def fill(item):
        isx = EB._el(item, "ItemSpecifics")
        for name, vals in specs:
            nv = EB._el(isx, "NameValueList")
            EB._el(nv, "Name", name)
            for v in vals:
                EB._el(nv, "Value", v)
    return _revise(token, item_id, fill)


def apply_one(token, it):
    """Make one change. Returns (message, old_value_to_store or None to keep the stored one)."""
    f, new = it["field"], json.loads(it["new_value"])
    if f == "price":
        _inventory(token, it["item_id"], price=new)
        return f"Price now £{float(new):.2f}", None
    if f == "qty":
        _inventory(token, it["item_id"], qty=new)
        return f"Quantity now {int(new)}", None
    if f == "title":
        if len(new) > 80:
            raise Skip(f"New title is {len(new)} characters; eBay allows 80")
        _revise(token, it["item_id"], lambda item: EB._el(item, "Title", new))
        return "Title changed", None
    if f == "specific":
        specs, _ = _specifics(token, it["item_id"])
        name, key = new["name"].strip(), new["name"].strip().lower()
        i = next((n for n, (k, _) in enumerate(specs) if k.strip().lower() == key), None)
        cur = specs[i][1] if i is not None else None
        if "restore" in new:  # undo: put the old value back, or remove the specific if there wasn't one
            if new["restore"] is None:
                if i is None:
                    raise Skip(f"{name} is already not set")
                specs.pop(i)
            elif i is None:
                specs.append((name, new["restore"]))
            else:
                specs[i] = (specs[i][0], new["restore"])
            _write_specifics(token, it["item_id"], specs)
            return f"{name} put back to {', '.join(new['restore']) if new['restore'] else 'not set'}", json.dumps(cur)
        value = [v.strip() for v in str(new["value"]).split("|") if v.strip()]
        if not value:
            raise Skip("No value given")
        if cur and any(x.strip() for x in cur):
            if new.get("mode") == "missing":
                raise Skip(f"Already has {name}: {', '.join(cur)}")
            if [x.strip().lower() for x in cur] == [x.lower() for x in value]:
                raise Skip(f"{name} is already {', '.join(cur)}")
        if i is None:
            specs.append((name, value))
        else:
            specs[i] = (specs[i][0], value)
        if len(specs) > 45:
            raise Skip("Listing already has eBay's maximum of 45 item specifics")
        _write_specifics(token, it["item_id"], specs)
        return f"{name} set to {', '.join(value)}" + (f" (was {', '.join(cur)})" if cur else ""), json.dumps(cur)
    if f == "bestoffer":
        cur = _best_offer(token, it["item_id"])
        if "restore" in new:  # undo: put back exactly what was there
            want = new["restore"] or {"enabled": False, "accept": None, "decline": None}
            _write_best_offer(token, it["item_id"], want["enabled"], want.get("accept"), want.get("decline"))
            return ("Best Offer put back: " + _bo_text(want)), json.dumps(cur)
        if cur["price"] is not None and (new["accept"] >= cur["price"] or new["decline"] >= cur["price"]):
            raise Skip(f"Price on eBay is now £{cur['price']:.2f}; the offer prices were worked out for another price. Preview again")
        if not cur["enabled"] and not new.get("enable", True):
            raise Skip("Best Offer is off on this listing (and turning it on wasn't ticked)")
        if cur["enabled"] and cur["accept"] == new["accept"] and cur["decline"] == new["decline"]:
            raise Skip("Already set like this")
        _write_best_offer(token, it["item_id"], True, new["accept"], new["decline"])
        return ("Best Offer " + ("turned on: " if not cur["enabled"] else "set: ") + _bo_text({"enabled": True, **new})
                + (f" (was {_bo_text(cur)})" if cur["enabled"] else "")), json.dumps(cur)
    raise Skip("Unknown change")


def _bo_text(b):
    if not b or not b.get("enabled"):
        return "off"
    parts = []
    if b.get("accept"):
        parts.append(f"accept from £{b['accept']:.2f}")
    if b.get("decline"):
        parts.append(f"decline below £{b['decline']:.2f}")
    return ", ".join(parts) or "on, no automatic answers"


def _best_offer(token, item_id):
    """Current Best Offer settings of a listing."""
    def b(root):
        EB._el(root, "ItemID", item_id)
        EB._el(root, "DetailLevel", "ReturnAll")
    it = EB.trading("GetItem", token, b).find(N + "Item")
    num = lambda p: float(it.findtext(p)) if it.findtext(p) else None
    return {"enabled": (it.findtext(f"{N}BestOfferDetails/{N}BestOfferEnabled") or "").lower() == "true",
            "accept": num(f"{N}ListingDetails/{N}BestOfferAutoAcceptPrice"),
            "decline": num(f"{N}ListingDetails/{N}MinimumBestOfferPrice"),
            "price": num(f"{N}StartPrice") or num(f"{N}SellingStatus/{N}CurrentPrice")}


def _write_best_offer(token, item_id, enabled, accept, decline):
    root = ET.Element(N + "ReviseFixedPriceItemRequest")
    item = EB._el(root, "Item")
    EB._el(item, "ItemID", item_id)
    EB._el(EB._el(item, "BestOfferDetails"), "BestOfferEnabled", "true" if enabled else "false")
    if enabled and (accept or decline):
        ld = EB._el(item, "ListingDetails")
        for tag, v in (("BestOfferAutoAcceptPrice", accept), ("MinimumBestOfferPrice", decline)):
            if v:
                EB._el(ld, tag, f"{float(v):.2f}").set("currencyID", "GBP")
    for tag, v in (("BestOfferAutoAcceptPrice", accept), ("MinimumBestOfferPrice", decline)):
        if not enabled or not v:
            EB._el(root, "DeletedField", f"Item.ListingDetails.{tag}")
    return EB.trading("ReviseFixedPriceItem", token, root_el=root)


def _update_local(con, it):
    new = json.loads(it["new_value"])
    if it["field"] == "price":
        con.execute("UPDATE listings SET price=? WHERE account_id=? AND item_id=?", (float(new), it["account_id"], it["item_id"]))
    elif it["field"] == "qty":
        con.execute("UPDATE listings SET qty=? WHERE account_id=? AND item_id=?", (int(new), it["account_id"], it["item_id"]))
    elif it["field"] == "title":
        con.execute("UPDATE listings SET title=? WHERE account_id=? AND item_id=?", (new, it["account_id"], it["item_id"]))


# ------------------------------------------------------------------ jobs
def create_job(con, user, kind, summary, changes, undo_of=None):
    jid = con.execute("INSERT INTO edit_jobs(created_by,kind,summary,status,total,undo_of) VALUES(?,?,?,?,?,?)",
                      (user, kind, summary, "queued", len(changes), undo_of)).lastrowid
    for c in changes:
        con.execute("INSERT INTO edit_items(job_id,account_id,item_id,sku,title,field,old_value,new_value) VALUES(?,?,?,?,?,?,?,?)",
                    (jid, int(c["account_id"]), str(c["item_id"]), c.get("sku"), c.get("title"), c["field"],
                     json.dumps(c.get("old")), json.dumps(c["new"])))
    return jid


def run_job(db_factory, job_id):
    with _lock:
        with db_factory() as con:
            con.execute("UPDATE edit_jobs SET status='running' WHERE id=?", (job_id,))
            items = [dict(r) for r in con.execute("SELECT * FROM edit_items WHERE job_id=? AND status='waiting' ORDER BY id", (job_id,))]
        tokens = {}
        for it in items:
            status, col = "ok", "ok"
            try:
                if it["account_id"] not in tokens:
                    with db_factory() as con:
                        tokens[it["account_id"]] = EB.access_token(con, it["account_id"])
                msg, old = apply_one(tokens[it["account_id"]], it)
            except Skip as e:
                status, col, msg, old = "skipped", "skipped", str(e), None
            except Exception as e:
                DB.log_exc("edits.run_job")
                status, col, msg, old = "failed", "failed", str(e)[:900], None
            with db_factory() as con:
                if old is not None:
                    con.execute("UPDATE edit_items SET old_value=? WHERE id=?", (old, it["id"]))
                con.execute("UPDATE edit_items SET status=?, message=? WHERE id=?", (status, msg, it["id"]))
                con.execute(f"UPDATE edit_jobs SET done=done+1, {col}={col}+1 WHERE id=?", (job_id,))
                if status == "ok":
                    _update_local(con, it)
            time.sleep(0.3)
        with db_factory() as con:
            con.execute("UPDATE edit_jobs SET status='finished' WHERE id=?", (job_id,))
            j = con.execute("SELECT * FROM edit_jobs WHERE id=?", (job_id,)).fetchone()
        DB.log("info" if not j["failed"] else "warn", "bulk edit", f"Job #{job_id} ({j['summary']}): {j['ok']} changed, {j['skipped']} skipped, {j['failed']} failed", user=None)


def undo_changes(con, job_id):
    """Changes that put back what the job changed (only the ones that went through)."""
    out = []
    for r in con.execute("SELECT * FROM edit_items WHERE job_id=? AND status='ok' ORDER BY id", (job_id,)):
        old = json.loads(r["old_value"]) if r["old_value"] else None
        new = json.loads(r["new_value"])
        if r["field"] == "bestoffer":
            out.append({**dict(r), "old": new, "new": {"restore": old}})
        elif r["field"] == "specific":
            restore = {"name": new["name"], "restore": old}
            out.append({**dict(r), "old": new.get("value") if "value" in new else new.get("restore"), "new": restore})
        elif old is not None:
            out.append({**dict(r), "old": new, "new": old})
    return out


def start(db_factory, job_id):
    threading.Thread(target=run_job, args=(db_factory, job_id), daemon=True).start()
