import json
import os
import secrets
import sqlite3
import tempfile
import time
from datetime import date, datetime
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware

from . import db as DB
from . import importers as IM
from . import profit as PR
from . import ebay as EB
from . import edits as ED
from . import stock as ST
from . import messages as MS
from . import adperf as AP
from .auth import check_pw, ensure_admin, hash_pw

STATIC = Path(__file__).resolve().parent / "static"
SECRET = os.environ.get("SECRET_KEY") or secrets.token_hex(32)

app = FastAPI(title="Partsledger", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(SessionMiddleware, secret_key=SECRET, session_cookie="pl_session", max_age=60 * 60 * 24 * 14,
                   same_site="lax", https_only=os.environ.get("HTTPS_ONLY", "1") == "1")


@app.on_event("startup")
def startup():
    DB.init()
    with DB.db() as con:
        con.executescript(EB.SCHEMA)
        EB.migrate(con)
        con.executescript(ED.SCHEMA)
        con.executescript(ST.SCHEMA)
        con.executescript(MS.SCHEMA)
        con.executescript(AP.SCHEMA)
        AP.migrate(con)
        con.execute("UPDATE ad_changes SET status='failed', message='Stopped by a restart; try again' WHERE status='waiting'")
        con.execute("UPDATE edit_jobs SET status='stopped' WHERE status IN ('queued','running')")
        con.execute("UPDATE ebay_jobs SET status='stopped' WHERE status IN ('queued','running')")
        ensure_admin(con)
        DB.purge_log(con)
    DB.log("info", "app", "Partsledger started")
    if os.environ.get("DISABLE_SYNC") != "1":
        EB.start_scheduler(DB.db)
        ST.start_scheduler(DB.db)
        MS.start_scheduler(DB.db)
        AP.start_scheduler(DB.db)


def uk_today():
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo("Europe/London")).date().isoformat()


# ------------------------------------------------------------------ auth helpers
def user(request: Request):
    uid = request.session.get("uid")
    if not uid:
        return None
    with DB.db() as con:
        r = con.execute("SELECT id,email,name,is_admin FROM users WHERE id=?", (uid,)).fetchone()
        return dict(r) if r else None


def need_user(request: Request):
    u = user(request)
    if not u:
        raise HTTPException(401, "Please log in again.")
    return u


def need_admin(request: Request):
    u = need_user(request)
    if not u["is_admin"]:
        raise HTTPException(403, "Only admins can do this.")
    return u


# ------------------------------------------------------------------ pages
@app.get("/login", response_class=HTMLResponse)
def login_page():
    return (STATIC / "login.html").read_text()


@app.post("/login")
def login(request: Request, email: str = Form(...), password: str = Form(...)):
    with DB.db() as con:
        r = con.execute("SELECT id,pw_hash FROM users WHERE email=?", (email.strip().lower(),)).fetchone()
    if not r or not check_pw(password, r["pw_hash"]):
        time.sleep(1)
        return RedirectResponse("/login?error=1", status_code=303)
    request.session.clear()
    request.session["uid"] = r["id"]
    return RedirectResponse("/", status_code=303)


@app.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    if not user(request):
        return RedirectResponse("/login", status_code=303)
    return (STATIC / "app.html").read_text()


@app.get("/static/{name}")
def static(name: str, request: Request):
    if name not in {"app.js", "app.css"}:
        raise HTTPException(404)
    if name == "app.js" and not user(request):
        raise HTTPException(401)
    return FileResponse(STATIC / name, headers={"Cache-Control": "no-cache"})


@app.get("/favicon.ico")
def favicon():
    from fastapi.responses import Response
    return Response(status_code=204)


@app.get("/privacy", response_class=HTMLResponse)
def privacy():
    return """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy · Partsledger</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 16px">
<h1>Partsledger privacy notice</h1>
<p>Partsledger is an internal tool used only by Motoviano Ltd staff to manage its own eBay and Amazon seller accounts.</p>
<p>It stores the company's own sales, fees and listing data from its seller accounts, and the login details of staff users.
It does not store buyer names, addresses or contact details, and it does not share any data with third parties.</p>
<p>Contact: contact@motoviano.com</p></body>"""


@app.get("/healthz")
def health():
    return {"ok": True}


# ------------------------------------------------------------------ data
@app.get("/api/data")
def data(request: Request):
    u = need_user(request)
    with DB.db() as con:
        settings = DB.get_settings(con)
        accounts, items, overheads, book = PR.build(con, settings)
        cogs = PR.cogs_table(con, items, book)
        ups = [dict(r) for r in con.execute(
            "SELECT u.*, a.name AS account FROM uploads u LEFT JOIN accounts a ON a.id=u.account_id ORDER BY u.id DESC LIMIT 200")]
        last = con.execute("SELECT MAX(date) FROM transactions").fetchone()[0]
        msg_open = con.execute("SELECT COUNT(*) FROM messages WHERE status!='Answered' AND done=0").fetchone()[0]
    return {"me": u, "asOf": last or uk_today(), "today": uk_today(),
            "accounts": [{"id": a["id"], "name": a["name"], "channel": a["channel"], "color": a["color"],
                          "hasData": any(i[1] == a["id"] for i in items)} for a in accounts],
            "items": items, "overheads": overheads, "cogs": cogs, "settings": settings, "uploads": ups, "msgOpen": msg_open}


@app.post("/api/cogs")
async def set_cogs(request: Request):
    u = need_user(request)
    b = await request.json()
    sku = (b.get("sku") or "").strip()
    if not sku:
        raise HTTPException(400, "SKU is missing.")
    cost = b.get("cost")
    mode = b.get("mode", "all")  # all = correct every date; from = new cost from a date
    with DB.db() as con:
        if cost is None or cost == "":
            con.execute("DELETE FROM cogs WHERE sku=?", (sku,))
            return {"ok": True}
        cost = round(float(cost), 2)
        if cost < 0:
            raise HTTPException(400, "Cost can't be negative.")
        if mode == "from":
            frm = b.get("from") or date.today().isoformat()
            datetime.strptime(frm, "%Y-%m-%d")
            con.execute("""INSERT INTO cogs(sku,cost,effective_from,source,updated_by) VALUES(?,?,?,?,?)
                           ON CONFLICT(sku,effective_from) DO UPDATE SET cost=excluded.cost,source=excluded.source,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP""",
                        (sku, cost, frm, "Your cost", u["email"]))
        else:
            con.execute("DELETE FROM cogs WHERE sku=?", (sku,))
            con.execute("INSERT INTO cogs(sku,cost,effective_from,source,updated_by) VALUES(?,?,?,?,?)",
                        (sku, cost, "2000-01-01", "Your cost", u["email"]))
    return {"ok": True}


@app.get("/api/cogs/{sku}/history")
def cogs_history(sku: str, request: Request):
    need_user(request)
    with DB.db() as con:
        return [dict(r) for r in con.execute("SELECT cost,effective_from,source,updated_by,updated_at FROM cogs WHERE sku=? ORDER BY effective_from", (sku,))]


@app.post("/api/sku-map")
async def set_sku_map(request: Request):
    need_user(request)
    b = await request.json()
    item, sku = (b.get("item_id") or "").strip(), (b.get("sku") or "").strip()
    if not item:
        raise HTTPException(400, "Item number is missing.")
    with DB.db() as con:
        if sku:
            con.execute("INSERT INTO sku_map(item_id,sku,note) VALUES(?,?,?) ON CONFLICT(item_id) DO UPDATE SET sku=excluded.sku",
                        (item, sku, "set in app"))
        else:
            con.execute("DELETE FROM sku_map WHERE item_id=?", (item,))
    return {"ok": True}


@app.post("/api/settings")
async def set_settings(request: Request):
    need_user(request)
    b = await request.json()
    bands = b.get("bands")
    if not isinstance(bands, list) or not all(isinstance(x, list) and len(x) == 2 for x in bands):
        raise HTTPException(400, "Price bands must be pairs of 'price under' and 'cost'.")
    bands = sorted([[float(a), float(c)] for a, c in bands if a is not None and c is not None])
    with DB.db() as con:
        con.execute("UPDATE settings SET value=? WHERE key='bands'", (json.dumps(bands),))
    return {"ok": True}


# ------------------------------------------------------------------ uploads
@app.post("/api/upload")
async def upload(request: Request, files: list[UploadFile] = File(...), account_id: str = Form("")):
    u = need_user(request)
    results = []
    # Read everything first so transaction reports are stored before listings
    # (listings are matched to an account by the item numbers already loaded).
    batch = []
    order = {"ebay_tx": 0, "amazon_tx": 1, "ebay_listings": 2, "cogs": 3}
    for f in files:
        raw = await f.read()
        name = f.filename or "file"
        try:
            if len(raw) > 30 * 1024 * 1024:
                raise IM.ImportError_("File is larger than 30 MB.")
            batch.append((order[IM.detect(name, raw)], name, raw))
        except IM.ImportError_ as e:
            results.append({"file": name, "ok": False, "msg": str(e)})
    for _, name, raw in sorted(batch, key=lambda x: x[0]):
        try:
            kind = IM.detect(name, raw)
            with DB.db() as con:
                accs = {r["seller_id"]: r["id"] for r in con.execute("SELECT id,seller_id FROM accounts WHERE seller_id IS NOT NULL")}
                names = {r["id"]: r["name"] for r in con.execute("SELECT id,name FROM accounts")}
                if kind == "ebay_tx":
                    seller, rows = IM.parse_ebay_tx(raw)
                    aid = accs.get((seller or "").lower())
                    if not aid:
                        raise IM.ImportError_(f"This report is for eBay seller '{seller}', which isn't one of the Motoviano accounts.")
                    sf = con.execute("SELECT synced_from FROM sync_state WHERE account_id=?", (aid,)).fetchone()
                    synced = 0
                    if sf and sf["synced_from"]:
                        # days from this date on come from the live eBay sync; skip them so nothing is counted twice
                        keep = [r for r in rows if r["date"] < sf["synced_from"]]
                        synced, rows = len(rows) - len(keep), keep
                        if not rows:
                            raise IM.ImportError_(f"Everything in this report is already coming in through the live eBay sync (from {sf['synced_from']}).")
                    uid = con.execute("INSERT INTO uploads(filename,kind,account_id,uploaded_by) VALUES(?,?,?,?)",
                                      (name, "eBay transactions", aid, u["email"])).lastrowid
                    add, skip = IM.store_transactions(con, aid, rows, uid)
                    skip += synced
                    ds = [r["date"] for r in rows]
                    con.execute("UPDATE uploads SET rows_added=?,rows_skipped=?,date_from=?,date_to=? WHERE id=?", (add, skip, min(ds), max(ds), uid))
                    results.append({"file": name, "ok": True, "msg": f"{names[aid]}: {add} new rows added, {skip} already loaded ({min(ds)} to {max(ds)})."})
                elif kind == "ebay_listings":
                    rows = IM.parse_ebay_listings(raw)
                    aid = int(account_id) if account_id else IM.guess_listing_account(con, rows)
                    if not aid:
                        raise IM.ImportError_("Couldn't tell which account these listings belong to. Choose the account and upload again.")
                    n = IM.store_listings(con, aid, rows)
                    con.execute("INSERT INTO uploads(filename,kind,account_id,rows_added,rows_skipped,date_from,date_to,uploaded_by) VALUES(?,?,?,?,?,?,?,?)",
                                (name, "eBay listings", aid, n, 0, date.today().isoformat(), date.today().isoformat(), u["email"]))
                    results.append({"file": name, "ok": True, "msg": f"{names[aid]}: {n} listings updated."})
                elif kind == "amazon_tx":
                    rows = IM.parse_amazon_tx(raw)
                    aid = con.execute("SELECT id FROM accounts WHERE channel='amazon' ORDER BY id LIMIT 1").fetchone()["id"]
                    uid = con.execute("INSERT INTO uploads(filename,kind,account_id,uploaded_by) VALUES(?,?,?,?)",
                                      (name, "Amazon transactions", aid, u["email"])).lastrowid
                    add, skip = IM.store_transactions(con, aid, rows, uid)
                    ds = [r["date"] for r in rows]
                    con.execute("UPDATE uploads SET rows_added=?,rows_skipped=?,date_from=?,date_to=? WHERE id=?", (add, skip, min(ds), max(ds), uid))
                    results.append({"file": name, "ok": True, "msg": f"{names[aid]}: {add} new rows added, {skip} already loaded."})
                else:
                    costs = IM.parse_cogs(name, raw)
                    for s, c in costs.items():
                        con.execute("DELETE FROM cogs WHERE sku=?", (s,))
                        con.execute("INSERT INTO cogs(sku,cost,effective_from,source,updated_by) VALUES(?,?,?,?,?)",
                                    (s, c, "2000-01-01", "Uploaded list", u["email"]))
                    con.execute("INSERT INTO uploads(filename,kind,rows_added,rows_skipped,uploaded_by) VALUES(?,?,?,?,?)",
                                (name, "COGS list", len(costs), 0, u["email"]))
                    results.append({"file": name, "ok": True, "msg": f"{len(costs)} costs saved."})
        except IM.ImportError_ as e:
            results.append({"file": name, "ok": False, "msg": str(e)})
        except Exception as e:  # keep other files going
            results.append({"file": name, "ok": False, "msg": f"Couldn't process this file ({type(e).__name__}: {e})."})
    return {"results": results}


@app.delete("/api/uploads/{upload_id}")
def delete_upload(upload_id: int, request: Request):
    need_admin(request)
    with DB.db() as con:
        n = con.execute("DELETE FROM transactions WHERE upload_id=?", (upload_id,)).rowcount
        con.execute("DELETE FROM uploads WHERE id=?", (upload_id,))
    return {"ok": True, "removed": n}


# ------------------------------------------------------------------ users
@app.get("/api/users")
def users(request: Request):
    need_user(request)
    with DB.db() as con:
        return [dict(r) for r in con.execute("SELECT id,email,name,is_admin,created_at FROM users ORDER BY name")]


@app.post("/api/users")
async def add_user(request: Request):
    need_admin(request)
    b = await request.json()
    email, name, pw = (b.get("email") or "").strip().lower(), (b.get("name") or "").strip(), b.get("password") or ""
    if "@" not in email or not name or len(pw) < 8:
        raise HTTPException(400, "Enter a name, a valid email and a password of at least 8 characters.")
    with DB.db() as con:
        try:
            con.execute("INSERT INTO users(email,name,pw_hash,is_admin) VALUES(?,?,?,?)", (email, name, hash_pw(pw), 1 if b.get("is_admin") else 0))
        except sqlite3.IntegrityError:
            raise HTTPException(400, "A user with that email already exists.")
    return {"ok": True}


@app.post("/api/users/{uid}/password")
async def reset_pw(uid: int, request: Request):
    me = need_user(request)
    if me["id"] != uid and not me["is_admin"]:
        raise HTTPException(403, "You can only change your own password.")
    b = await request.json()
    pw = b.get("password") or ""
    if len(pw) < 8:
        raise HTTPException(400, "Password must be at least 8 characters.")
    with DB.db() as con:
        con.execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_pw(pw), uid))
    return {"ok": True}


@app.delete("/api/users/{uid}")
def del_user(uid: int, request: Request):
    me = need_admin(request)
    if me["id"] == uid:
        raise HTTPException(400, "You can't remove yourself.")
    with DB.db() as con:
        con.execute("DELETE FROM users WHERE id=?", (uid,))
    return {"ok": True}


@app.get("/api/backup")
def backup(request: Request):
    need_admin(request)
    tmp = Path(tempfile.mkdtemp()) / f"partsledger-backup-{date.today().isoformat()}.db"
    src = sqlite3.connect(DB.DB_PATH)
    dst = sqlite3.connect(tmp)
    src.backup(dst)
    src.close()
    dst.close()
    return FileResponse(tmp, filename=tmp.name, media_type="application/octet-stream")


# ------------------------------------------------------------------ eBay connection
@app.get("/api/ebay/status")
def ebay_status(request: Request):
    need_user(request)
    with DB.db() as con:
        toks = {r["account_id"]: {**{k: r[k] for k in ("account_id", "ebay_user", "refresh_expires", "connected_at", "connected_by")},
                                  "traffic": EB.ANALYTICS_SCOPE in EB.granted(r)} for r in con.execute("SELECT * FROM ebay_tokens")}
        accs = [dict(r) for r in con.execute("SELECT id,name,seller_id,color FROM accounts WHERE channel='ebay' ORDER BY sort,id")]
        sync = {r["account_id"]: dict(r) for r in con.execute("SELECT * FROM sync_state")}
    for a in accs:
        a["connection"] = toks.get(a["id"])
        a["sync"] = sync.get(a["id"])
    return {"configured": EB.configured(), "missing": EB.missing_settings(), "accounts": accs,
            "callbackHint": (os.environ.get("PUBLIC_URL", "").rstrip("/") + "/ebay/callback") if os.environ.get("PUBLIC_URL") else None}


@app.get("/api/traffic")
def traffic(request: Request, start: str, end: str):
    """Traffic per listing for a date range, with SKU, group, price and stock, including active listings with no traffic."""
    need_user(request)
    with DB.db() as con:
        sku_map = {r["item_id"]: r["sku"] for r in con.execute("SELECT item_id,sku FROM sku_map")}
        rows = {}
        for r in con.execute("""SELECT account_id,item_id,SUM(impressions) i,SUM(search_impressions) si,SUM(views) v,SUM(search_views) sv,
                                SUM(transactions) t FROM traffic WHERE date BETWEEN ? AND ? GROUP BY account_id,item_id""", (start, end)):
            rows[(r["account_id"], r["item_id"])] = [r["i"] or 0, r["si"] or 0, r["v"] or 0, r["sv"] or 0, r["t"] or 0]
        cover = {}
        for r in con.execute("SELECT account_id,MIN(date) a,MAX(date) b,COUNT(*) n FROM traffic_days WHERE date BETWEEN ? AND ? GROUP BY account_id", (start, end)):
            cover[r["account_id"]] = {"from": r["a"], "to": r["b"], "days": r["n"]}
        listing = {}
        for a in con.execute("SELECT DISTINCT account_id FROM listings"):
            for item_id in EB.active_listing_ids(con, a[0]):
                listing[(a[0], item_id)] = True
        info = {(r["account_id"], r["item_id"]): r for r in con.execute("SELECT account_id,item_id,sku,title,price,qty FROM listings")}
        tracked = {r[0] for r in con.execute("SELECT DISTINCT account_id FROM traffic_days")}
        out = []
        for key in set(rows) | {k for k in listing if k[0] in tracked}:
            l = info.get(key)
            sku = sku_map.get(key[1]) or (l["sku"] if l else None) or ""
            out.append([key[0], key[1], sku, PR.group_of(sku), (l["title"] if l else "") or "", l["price"] if l else None,
                        l["qty"] if l else None, 1 if key in listing else 0, *rows.get(key, [0, 0, 0, 0, 0])])
    return {"rows": out, "coverage": cover}


# ------------------------------------------------------------------ bulk edits
@app.get("/api/edit/listings")
def edit_listings(request: Request):
    """Active listings on every connected account, with SKU and product group."""
    need_user(request)
    with DB.db() as con:
        sku_map = {r["item_id"]: r["sku"] for r in con.execute("SELECT item_id,sku FROM sku_map")}
        connected = {r[0] for r in con.execute("SELECT account_id FROM ebay_tokens")}
        ads = {(r["account_id"], r["item_id"]): r["rate"] for r in con.execute("SELECT account_id,item_id,rate FROM ad_rates")}
        out = []
        for a in sorted(connected):
            active = set(EB.active_listing_ids(con, a))
            for r in con.execute("SELECT item_id,sku,title,price,qty,sold FROM listings WHERE account_id=?", (a,)):
                if r["item_id"] not in active:
                    continue
                sku = sku_map.get(r["item_id"]) or r["sku"] or ""
                out.append([a, r["item_id"], sku, PR.group_of(sku), r["title"] or "", r["price"], r["qty"], r["sold"] or 0,
                            ads.get((a, r["item_id"]))])
    return {"rows": out, "connected": sorted(connected)}


@app.post("/api/edit/jobs")
async def edit_new_job(request: Request):
    u = need_user(request)
    b = await request.json()
    changes = b.get("changes") or []
    if not changes:
        raise HTTPException(400, "Nothing to change.")
    if len(changes) > 2000:
        raise HTTPException(400, "Up to 2,000 listings at a time, please.")
    for c in changes:
        if c.get("field") not in ED.FIELDS or not c.get("item_id") or c.get("new") in (None, ""):
            raise HTTPException(400, "One of the changes is incomplete.")
        if c["field"] == "price" and not (0.99 <= float(c["new"]) <= 99999):
            raise HTTPException(400, f"Price for {c['item_id']} must be between £0.99 and £99,999.")
        if c["field"] == "qty" and not (0 <= int(c["new"]) <= 99999):
            raise HTTPException(400, "Quantity must be between 0 and 99,999.")
    with DB.db() as con:
        for a in {int(c["account_id"]) for c in changes}:
            EB.access_token(con, a)  # fails early if an account isn't connected
        jid = ED.create_job(con, u["email"], changes[0]["field"], str(b.get("summary") or "")[:300], changes)
    ED.start(DB.db, jid)
    return {"job": jid}


@app.get("/api/edit/jobs")
def edit_jobs(request: Request):
    need_user(request)
    with DB.db() as con:
        return [dict(r) for r in con.execute("SELECT * FROM edit_jobs ORDER BY id DESC LIMIT 30")]


@app.get("/api/edit/jobs/{job_id}")
def edit_job(job_id: int, request: Request):
    need_user(request)
    with DB.db() as con:
        j = con.execute("SELECT * FROM edit_jobs WHERE id=?", (job_id,)).fetchone()
        if not j:
            raise HTTPException(404, "Job not found.")
        return {"job": dict(j), "items": [dict(r) for r in con.execute(
            "SELECT e.*, a.name AS account FROM edit_items e JOIN accounts a ON a.id=e.account_id WHERE job_id=? ORDER BY e.id", (job_id,))]}


@app.post("/api/edit/jobs/{job_id}/undo")
def edit_undo(job_id: int, request: Request):
    u = need_user(request)
    with DB.db() as con:
        j = con.execute("SELECT * FROM edit_jobs WHERE id=?", (job_id,)).fetchone()
        if not j:
            raise HTTPException(404, "Job not found.")
        if j["status"] in ("queued", "running"):
            raise HTTPException(400, "Wait for this job to finish first.")
        if j["undone_by"]:
            raise HTTPException(400, f"Already undone (job #{j['undone_by']}).")
        ch = ED.undo_changes(con, job_id)
        if not ch:
            raise HTTPException(400, "Nothing in this job went through, so there's nothing to undo.")
        jid = ED.create_job(con, u["email"], j["kind"], f"Undo #{job_id}: {j['summary']}"[:300], ch, undo_of=job_id)
        con.execute("UPDATE edit_jobs SET undone_by=? WHERE id=?", (jid, job_id))
    ED.start(DB.db, jid)
    return {"job": jid}


# ------------------------------------------------------------------ stock sync
@app.get("/api/stock")
def stock(request: Request):
    need_user(request)
    with DB.db() as con:
        st = ST.get_settings(con)
        by = ST.listings_by_sku(con)
        pool = {r["sku"]: dict(r) for r in con.execute("SELECT * FROM stock_pool")}
        accs = [dict(r) for r in con.execute("""SELECT a.id,a.name,a.color,s.oos_control,s.last_check,s.last_status,s.last_message
            FROM accounts a JOIN ebay_tokens t ON t.account_id=a.id LEFT JOIN stock_state s ON s.account_id=a.id ORDER BY a.sort,a.id""")]
        skus = []
        for sku in sorted(set(by) | set(pool)):
            p = pool.get(sku) or {}
            ls = by.get(sku, [])
            skus.append({"sku": sku, "group": PR.group_of(sku), "title": (ls[0]["title"] if ls else "") or "",
                         "on_hand": p.get("on_hand"), "enabled": p.get("enabled", 1), "set_at": p.get("set_at"),
                         "listings": [[l["account_id"], l["item_id"], l["qty"]] for l in ls]})
        log = [dict(r) for r in con.execute("SELECT l.*, a.name AS account FROM stock_log l LEFT JOIN accounts a ON a.id=l.account_id ORDER BY l.id DESC LIMIT 150")]
        pushes = [dict(r) for r in con.execute("SELECT p.*, a.name AS account FROM stock_push p LEFT JOIN accounts a ON a.id=p.account_id ORDER BY p.id DESC LIMIT 150")]
        pending = ST.plan(con)
    return {"settings": st, "accounts": accs, "skus": skus, "log": log, "pushes": pushes,
            "plan": [[r["account_id"], r["item_id"], r["sku"], r["qty"], r["new_qty"], r["blocked"]] for r in pending]}


@app.post("/api/stock/set")
async def stock_set(request: Request):
    u = need_user(request)
    b = await request.json()
    items = b.get("items") or []
    for it in items:
        if it.get("on_hand") not in (None, "") and not (0 <= int(it["on_hand"]) <= 99999):
            raise HTTPException(400, "Stock must be between 0 and 99,999.")
    with DB.db() as con:
        n = ST.set_stock(con, items, u["email"])
    return {"saved": n}


@app.post("/api/stock/settings")
async def stock_settings(request: Request):
    need_user(request)
    b = await request.json()
    with DB.db() as con:
        if "stock_auto" in b:
            ST.set_setting(con, "stock_auto", bool(b["stock_auto"]))
        if "stock_cap" in b:
            ST.set_setting(con, "stock_cap", max(0, int(b["stock_cap"] or 0)))
        return ST.get_settings(con)


@app.post("/api/stock/push")
def stock_push(request: Request):
    need_user(request)
    import threading
    threading.Thread(target=ST.cycle, args=(DB.db,), kwargs={"force_push": True}, daemon=True).start()
    return {"ok": True}


# ------------------------------------------------------------------ buyer messages
@app.get("/api/messages")
def messages(request: Request, days: int = 60):
    need_user(request)
    with DB.db() as con:
        rows = [dict(r) for r in con.execute("SELECT * FROM messages WHERE created>=datetime('now', ?) ORDER BY created",
                                             (f"-{max(1, min(days, 400))} days",))]
        items = {r["item_id"] for r in rows if r["item_id"]}
        info = {}
        sku_map = {r["item_id"]: r["sku"] for r in con.execute("SELECT item_id,sku FROM sku_map")}
        for r in con.execute("SELECT account_id,item_id,sku,price,qty FROM listings"):
            if r["item_id"] in items:
                info[r["item_id"]] = {"sku": sku_map.get(r["item_id"]) or r["sku"], "price": r["price"], "qty": r["qty"]}
        sold = {r[0]: r[1] for r in con.execute(
            f"SELECT item_id, SUM(qty) FROM transactions WHERE type='Order' AND item_id IN ({','.join('?' * len(items)) or 'NULL'}) GROUP BY item_id", list(items))}
        state = [dict(r) for r in con.execute("""SELECT a.id,a.name,a.color,s.last_check,s.last_status,s.last_message FROM accounts a
            JOIN ebay_tokens t ON t.account_id=a.id LEFT JOIN message_state s ON s.account_id=a.id ORDER BY a.sort,a.id""")]
        tpl = MS.get_templates(con)
    for r in rows:
        r["responses"] = json.loads(r["responses"] or "[]")
        r.pop("fetched_at", None)
    return {"messages": rows, "items": {k: {**v, "sold": sold.get(k, 0)} for k, v in info.items()},
            "accounts": state, "templates": tpl}


@app.post("/api/messages/reply")
async def messages_reply(request: Request):
    u = need_user(request)
    b = await request.json()
    with DB.db() as con:
        MS.reply(con, int(b["account_id"]), str(b["message_id"]), b.get("text"), bool(b.get("public")), u["email"])
    return {"ok": True}


@app.post("/api/messages/done")
async def messages_done(request: Request):
    need_user(request)
    b = await request.json()
    ids = [str(x) for x in b.get("message_ids") or []]
    with DB.db() as con:
        for mid in ids:
            con.execute("UPDATE messages SET done=? WHERE account_id=? AND message_id=?", (1 if b.get("done", True) else 0, int(b["account_id"]), mid))
    return {"ok": True}


@app.post("/api/messages/check")
def messages_check(request: Request):
    need_user(request)
    import threading
    threading.Thread(target=MS.check, args=(DB.db,), daemon=True).start()
    return {"ok": True}


@app.post("/api/messages/templates")
async def messages_templates(request: Request):
    need_user(request)
    b = await request.json()
    with DB.db() as con:
        return MS.set_templates(con, b.get("items") or [])


# ------------------------------------------------------------------ Promoted Listings performance
@app.get("/api/ads")
def ads_perf(request: Request, window: int = 30):
    need_user(request)
    w = 90 if window >= 90 else 30
    with DB.db() as con:
        cur = [list(r) for r in con.execute("SELECT account_id,item_id,campaign_id,campaign_name,funding,rate,status,strategy FROM ad_current")]
        perf = [list(r) for r in con.execute("SELECT account_id,item_id,impressions,clicks,ad_units,ad_sales,ad_fees FROM ad_perf WHERE window_days=?", (w,))]
        state = [dict(r) for r in con.execute("""SELECT a.id,a.name,s.fetched_at,s.status,s.message,s.date_to FROM accounts a
            JOIN ebay_tokens t ON t.account_id=a.id LEFT JOIN ad_perf_state s ON s.account_id=a.id ORDER BY a.sort,a.id""")]
        changes = [dict(r) for r in con.execute("SELECT c.*, a.name AS account FROM ad_changes c LEFT JOIN accounts a ON a.id=c.account_id ORDER BY c.id DESC LIMIT 200")]
    return {"window": w, "current": cur, "perf": perf, "state": state, "changes": changes}


@app.post("/api/ads/refresh")
def ads_refresh(request: Request):
    need_user(request)
    import threading
    threading.Thread(target=AP.refresh_all, args=(DB.db,), daemon=True).start()
    return {"ok": True}


@app.post("/api/ads/apply")
async def ads_apply(request: Request):
    u = need_user(request)
    b = await request.json()
    ch = b.get("changes") or []
    if not ch:
        raise HTTPException(400, "Nothing to change.")
    ids = []
    with DB.db() as con:
        for c in ch:
            act = "stop" if c.get("action") == "stop" else "rate"
            nr = None if act == "stop" else float(c["new_rate"])
            if act == "rate" and not (1.0 <= nr <= 100.0):
                raise HTTPException(400, f"Ad rate for {c.get('item_id')} must be between 1% and 100%.")
            ids.append(con.execute("INSERT INTO ad_changes(by,account_id,item_id,sku,action,old_rate,new_rate) VALUES(?,?,?,?,?,?,?)",
                                   (u["email"], int(c["account_id"]), str(c["item_id"]), c.get("sku"), act, c.get("old_rate"), nr)).lastrowid)
    import threading
    threading.Thread(target=AP.apply, args=(DB.db, ids), daemon=True).start()
    return {"queued": len(ids)}


# ------------------------------------------------------------------ log
def _log_rows(con, level="", q="", days=90, limit=500):
    sql, args = "SELECT l.*, u.email AS user_email FROM app_log l LEFT JOIN users u ON u.id=l.user WHERE l.at >= datetime('now', ?)", [f"-{max(1, min(days, 90))} days"]
    if level:
        sql += " AND l.level=?"; args.append(level)
    if q:
        sql += " AND (l.message LIKE ? OR l.source LIKE ? OR l.detail LIKE ?)"; args += [f"%{q}%"] * 3
    sql += " ORDER BY l.id DESC LIMIT ?"; args.append(limit)
    return [dict(r) for r in con.execute(sql, args)]


@app.get("/api/logs")
def logs(request: Request, level: str = "", q: str = "", days: int = 30):
    need_admin(request)
    with DB.db() as con:
        DB.purge_log(con)
        rows = _log_rows(con, level, q, days, 500)
        counts = {r[0]: r[1] for r in con.execute("SELECT level, COUNT(*) FROM app_log WHERE at >= datetime('now','-1 day') GROUP BY level")}
    return {"rows": rows, "last24h": counts, "readKey": bool(os.environ.get("LOG_READ_KEY"))}


@app.get("/api/logs.txt")
def logs_file(request: Request, key: str = "", days: int = 14, level: str = ""):
    """The log as a plain text file. Admins can download it; with LOG_READ_KEY set in Render it can also be
    read with ?key=... (read-only, errors and events only: no tokens, passwords or buyer details)."""
    rk = os.environ.get("LOG_READ_KEY", "")
    if not (rk and key and secrets.compare_digest(key, rk)):
        need_admin(request)
    with DB.db() as con:
        rows = _log_rows(con, level, "", days, 5000)
    from fastapi.responses import PlainTextResponse
    out = [f"Partsledger log · last {days} days · {len(rows)} entries · newest first", ""]
    for r in rows:
        out.append(f"[{r['at']} UTC] {r['level'].upper():5} {r['source']} · {r['message']}" + (f" · by {r['user_email']}" if r.get("user_email") else ""))
        if r.get("detail"):
            out += ["    " + x for x in r["detail"].rstrip().split("\n")[-25:]]
    return PlainTextResponse("\n".join(out), headers={"Content-Disposition": f'inline; filename="partsledger-log-{date.today().isoformat()}.txt"'})


@app.post("/api/log")
async def log_from_browser(request: Request):
    """Errors the browser saw (including ones the server couldn't log because it was restarting)."""
    u = user(request)
    if not u:
        return {"ok": False}
    b = await request.json()
    for e in (b.get("entries") or [])[:20]:
        DB.log("browser", str(e.get("where") or "page")[:80], str(e.get("message") or "")[:1000],
               f"{e.get('at', '')} {e.get('detail') or ''}"[:4000], user=u["id"])
    return {"ok": True}


@app.get("/ebay/connect/{account_id}")
def ebay_connect(account_id: int, request: Request):
    if not user(request):
        return RedirectResponse("/login", status_code=303)
    need_admin(request)
    if not EB.configured():
        return RedirectResponse("/?ebay=notset#ebay", status_code=303)
    return RedirectResponse(EB.auth_link(account_id), status_code=303)


@app.get("/ebay/callback")
def ebay_callback(request: Request, code: str = "", state: str = "", error: str = ""):
    u = user(request)
    if not u:
        return RedirectResponse("/login", status_code=303)
    account_id = EB.pop_state(state)
    if error or not code or not account_id:
        return RedirectResponse("/?ebay=declined#ebay", status_code=303)
    try:
        tok = EB.exchange_code(code)
        with DB.db() as con:
            expected = con.execute("SELECT seller_id FROM accounts WHERE id=?", (account_id,)).fetchone()["seller_id"]
            got = EB.get_user_id(tok["access_token"]) or ""
            if expected and got.lower() != expected.lower():
                return RedirectResponse(f"/?ebay=wrong&got={got}#ebay", status_code=303)
            EB.save_connection(con, account_id, tok, u["email"])
    except EB.EbayError as e:
        return RedirectResponse("/?ebay=error&msg=" + str(e)[:200].replace("&", " ") + "#ebay", status_code=303)
    return RedirectResponse("/?ebay=ok#ebay", status_code=303)


@app.get("/ebay/declined")
def ebay_declined():
    return RedirectResponse("/?ebay=declined#ebay", status_code=303)


@app.post("/api/ebay/sync")
def ebay_sync_now(request: Request):
    need_user(request)
    import threading

    def run():
        if EB._sync_lock.acquire(blocking=False):
            try:
                EB.sync_all(DB.db, listings=True)
            finally:
                EB._sync_lock.release()
    threading.Thread(target=run, daemon=True).start()
    return {"ok": True}


@app.post("/api/ebay/disconnect/{account_id}")
def ebay_disconnect(account_id: int, request: Request):
    need_admin(request)
    with DB.db() as con:
        con.execute("DELETE FROM ebay_tokens WHERE account_id=?", (account_id,))
    return {"ok": True}


@app.get("/api/ebay/policies/{account_id}")
def ebay_policies(account_id: int, request: Request):
    need_user(request)
    try:
        with DB.db() as con:
            tok = EB.access_token(con, account_id)
        return EB.get_policies(tok)
    except EB.EbayError as e:
        raise HTTPException(400, str(e))


@app.get("/api/ebay/candidates")
def ebay_candidates(request: Request, source: int, target: int, prefix: str = ""):
    need_user(request)
    pre = prefix.strip().upper()
    with DB.db() as con:
        have = {(r["sku"] or "").upper() for r in con.execute("SELECT sku FROM listings WHERE account_id=?", (target,))}
        rows = [dict(r) for r in con.execute(
            "SELECT item_id,sku,title,price,qty,sold FROM listings WHERE account_id=? AND COALESCE(qty,1)>0 ORDER BY sku,price", (source,))]
        done = {r["item_id"] for r in con.execute(
            "SELECT i.item_id FROM ebay_job_items i JOIN ebay_jobs j ON j.id=i.job_id WHERE j.mode='copy' AND j.target_id=? AND i.status='ok'", (target,))}
    out, seen = [], set()
    for r in rows:
        s = (r["sku"] or "").upper()
        if not s or (pre and not s.startswith(pre)) or s in have or r["item_id"] in done:
            continue
        r["dupe_in_source"] = s in seen
        seen.add(s)
        out.append(r)
    return out


@app.post("/api/ebay/jobs")
async def ebay_new_job(request: Request):
    u = need_user(request)
    b = await request.json()
    items = [str(x) for x in b.get("items", [])][:500]
    mode = "verify" if b.get("mode") == "verify" else "copy"
    if not items:
        raise HTTPException(400, "Select at least one listing.")
    src, dst = int(b["source"]), int(b["target"])
    if src == dst:
        raise HTTPException(400, "Choose a different account to copy to.")
    pol = b.get("policies") or {}
    if mode == "copy" and not all(pol.get(k) for k in ("shipping", "return", "payment")):
        raise HTTPException(400, "Choose the postage, returns and payment policies for the account you're copying to.")
    with DB.db() as con:
        for a in (src, dst):
            EB.access_token(con, a)  # fails early if not connected
        info = {r["item_id"]: dict(r) for r in con.execute(
            f"SELECT item_id,sku,title,price FROM listings WHERE account_id=? AND item_id IN ({','.join('?'*len(items))})", [src, *items])}
        jid = con.execute("INSERT INTO ebay_jobs(created_by,source_id,target_id,mode,settings,status,total) VALUES(?,?,?,?,?,?,?)",
                          (u["email"], src, dst, mode, json.dumps({"price": b.get("price"), "policies": pol}), "queued", len(items))).lastrowid
        for it in items:
            r = info.get(it, {})
            con.execute("INSERT INTO ebay_job_items(job_id,item_id,sku,title,price) VALUES(?,?,?,?,?)", (jid, it, r.get("sku"), r.get("title"), r.get("price")))
    import threading
    threading.Thread(target=EB.run_job, args=(DB.db, jid), daemon=True).start()
    return {"job": jid}


@app.get("/api/ebay/jobs")
def ebay_jobs(request: Request):
    need_user(request)
    with DB.db() as con:
        return [dict(r) for r in con.execute("""SELECT j.*, s.name AS source, t.name AS target FROM ebay_jobs j
            JOIN accounts s ON s.id=j.source_id JOIN accounts t ON t.id=j.target_id ORDER BY j.id DESC LIMIT 20""")]


@app.get("/api/ebay/jobs/{job_id}")
def ebay_job(job_id: int, request: Request):
    need_user(request)
    with DB.db() as con:
        j = con.execute("SELECT * FROM ebay_jobs WHERE id=?", (job_id,)).fetchone()
        if not j:
            raise HTTPException(404, "Job not found.")
        return {"job": dict(j), "items": [dict(r) for r in con.execute("SELECT * FROM ebay_job_items WHERE job_id=? ORDER BY id", (job_id,))]}


# ------------------------------------------------------------------ Promoted Listings ad rates
@app.post("/api/ebay/adrates")
async def ebay_adrates_upload(request: Request, file: UploadFile = File(...)):
    u = need_user(request)
    raw = await file.read()
    import io
    import pandas as pd
    name = (file.filename or "").lower()
    df = pd.read_excel(io.BytesIO(raw), dtype=str) if name.endswith((".xlsx", ".xls")) else pd.read_csv(io.StringIO(IM.decode(raw)), dtype=str)
    cols = {c.strip().lower(): c for c in df.columns}
    acc_c = next((cols[k] for k in cols if k.startswith("account")), None)
    item_c = next((cols[k] for k in cols if k in ("item number", "item id", "itemid", "ebay item id")), None)
    rate_c = next((cols[k] for k in cols if "rate" in k), None)
    if not (acc_c and item_c and rate_c):
        raise HTTPException(400, "The file needs Account, Item number and Ad rate columns.")
    with DB.db() as con:
        accs = {r["name"].lower(): r["id"] for r in con.execute("SELECT id,name FROM accounts WHERE channel='ebay'")}
        n, bad = 0, 0
        for _, r in df.iterrows():
            a = accs.get(str(r[acc_c]).strip().lower())
            item = str(r[item_c]).strip().replace('="', "").replace('"', "")
            try:
                rate = float(str(r[rate_c]).replace("%", "").strip())
            except ValueError:
                rate = None
            if not a or not item or rate is None or not (2 <= rate <= 100):
                bad += 1
                continue
            info = con.execute("SELECT sku,title FROM listings WHERE account_id=? AND item_id=?", (a, item)).fetchone()
            con.execute("""INSERT INTO ad_rates(account_id,item_id,rate,sku,title,status) VALUES(?,?,?,?,?,'pending')
                           ON CONFLICT(account_id,item_id) DO UPDATE SET rate=excluded.rate,status='pending',message=NULL,updated_at=CURRENT_TIMESTAMP""",
                        (a, item, round(rate, 1), info["sku"] if info else None, info["title"] if info else None))
            n += 1
    return {"ok": True, "saved": n, "skipped": bad}


@app.get("/api/ebay/adrates")
def ebay_adrates(request: Request):
    need_user(request)
    with DB.db() as con:
        return [dict(r) for r in con.execute("""SELECT r.*, a.name AS account FROM ad_rates r JOIN accounts a ON a.id=r.account_id
                                                ORDER BY a.sort, r.status, r.sku""")]


@app.post("/api/ebay/adrates/apply/{account_id}")
def ebay_adrates_apply(account_id: int, request: Request):
    need_user(request)
    with DB.db() as con:
        EB.access_token(con, account_id)
    import threading
    threading.Thread(target=EB.run_ad_job, args=(DB.db, account_id), daemon=True).start()
    return {"ok": True}


# eBay requires every app to accept "marketplace account deletion" notices.
# We don't keep buyer names or addresses, so there is nothing to delete; we confirm receipt.
@app.get("/ebay/account-deletion")
def ebay_deletion_check(challenge_code: str = ""):
    return {"challengeResponse": EB.deletion_challenge(challenge_code)}


@app.post("/ebay/account-deletion")
async def ebay_deletion_notice(request: Request):
    await request.body()
    return JSONResponse({}, status_code=200)


@app.exception_handler(HTTPException)
async def http_err(request: Request, exc: HTTPException):
    # keep refusals of actions (and anything eBay refused) in the log; skip "please log in" and not-found
    if exc.status_code >= 500 or (exc.status_code == 400 and (request.method != "GET" or request.url.path.startswith("/api/ebay"))):
        DB.log("error" if exc.status_code >= 500 else "warn", f"{request.method} {request.url.path}", str(exc.detail), user=request.session.get("uid"))
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


@app.exception_handler(EB.EbayError)
async def ebay_err(request: Request, exc: EB.EbayError):
    DB.log("warn", f"{request.method} {request.url.path}", str(exc), user=request.session.get("uid"))
    return JSONResponse({"error": str(exc)}, status_code=400)


@app.exception_handler(Exception)
async def any_err(request: Request, exc: Exception):
    """Anything unexpected: say what it was (instead of a bare 500) and keep it in the server log."""
    import logging
    import traceback
    logging.getLogger("partsledger").error("Error on %s %s\n%s", request.method, request.url.path, traceback.format_exc())
    DB.log("error", f"{request.method} {request.url.path}", f"{type(exc).__name__}: {exc}", traceback.format_exc(), user=request.session.get("uid"))
    return JSONResponse({"error": f"Server error on {request.url.path}: {type(exc).__name__}: {str(exc)[:300]}"}, status_code=500)
