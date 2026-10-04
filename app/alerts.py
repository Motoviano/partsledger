"""Instant alerts on your phone or computer (Web Push), for sales, buyer questions, returns/cases and seller standards.

Where alerts come from:
- Sales: the app looks for new orders on every account every 2 minutes (Fulfillment API).
- eBay Platform Notifications (optional, "instant"): eBay calls /ebay/notify the moment something sells, a buyer asks a
  question or a return opens. The call is only used as a nudge: the app then reads the order / message / return from
  eBay itself, so a fake call can't create a fake alert.
- Questions and returns: new rows from the Messages and Returns checks.
- Seller standards: a new warning.

Web Push is built in (RFC 8291 encryption + VAPID, with the cryptography package), so no extra service is needed.
On iPhone, alerts need the app added to the Home Screen first (Safari: Share > Add to Home Screen).
"""
import base64
import datetime as _dt
import hashlib
import hmac
import json
import os
import re
import struct
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from . import ebay as EB
from . import db as DB

SCHEMA = """
CREATE TABLE IF NOT EXISTS push_subs(
  id INTEGER PRIMARY KEY, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_email TEXT, device TEXT,
  prefs TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_ok TEXT, fails INTEGER DEFAULT 0, last_error TEXT);
CREATE TABLE IF NOT EXISTS alert_log(
  id INTEGER PRIMARY KEY, at TEXT DEFAULT CURRENT_TIMESTAMP, account_id INTEGER, kind TEXT NOT NULL, ref TEXT NOT NULL,
  title TEXT, body TEXT, url TEXT, sent INTEGER DEFAULT 0, source TEXT, UNIQUE(kind, account_id, ref));
CREATE TABLE IF NOT EXISTS alert_state(
  account_id INTEGER PRIMARY KEY, last_orders TEXT, notify_status TEXT, notify_message TEXT, notify_at TEXT, last_poke TEXT, pokes INTEGER DEFAULT 0);
"""
KINDS = {"sale": "Sales", "question": "Buyer questions", "return": "Returns and cases", "standards": "Seller standards"}
PREF_DEFAULT = {"sale": True, "question": True, "return": True, "standards": True, "min_sale": 0}
EVENTS = ["FixedPriceTransaction", "AuctionCheckoutComplete", "AskSellerQuestion", "ReturnCreated", "ReturnEscalated"]
SALE_EVENTS = {"FixedPriceTransaction", "AuctionCheckoutComplete", "ItemSold"}
_lock = threading.Lock()
_poke = {}


def now_iso():
    return _dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")


def _b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s):
    s = s.strip()
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# ------------------------------------------------------------------ Web Push (VAPID keys + encryption)
def vapid(con):
    """(private key, public key b64url); made once and kept in settings."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    r = con.execute("SELECT value FROM settings WHERE key='vapid'").fetchone()
    if r:
        v = json.loads(r[0])
        key = serialization.load_pem_private_key(v["private"].encode(), password=None)
        return key, v["public"]
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    pub = _b64(key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
    con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('vapid',?)", (json.dumps({"private": pem, "public": pub}),))
    return key, pub


def _hkdf(salt, ikm, info, n):
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:n]


def encrypt(payload, p256dh, auth):
    """RFC 8291 (aes128gcm) body for one subscription."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    ua_pub = _unb64(p256dh)
    secret = _unb64(auth)
    eph = ec.generate_private_key(ec.SECP256R1())
    as_pub = eph.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    shared = eph.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub))
    ikm = _hkdf(secret, shared, b"WebPush: info\x00" + ua_pub + as_pub, 32)
    salt = os.urandom(16)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    ct = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    return salt + struct.pack(">I", 4096) + bytes([len(as_pub)]) + as_pub + ct


def _jwt(key, aud):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    head = _b64(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
    claims = _b64(json.dumps({"aud": aud, "exp": int(time.time()) + 12 * 3600, "sub": "mailto:" + (os.environ.get("ALERT_CONTACT") or "contact@motoviano.com")}).encode())
    r, s = decode_dss_signature(key.sign(f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256())))
    return f"{head}.{claims}.{_b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


def _post(url, body, headers):
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, ""
    except urllib.error.HTTPError as e:
        return e.code, (e.read() or b"")[:300].decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)[:300]


def send_push(con, sub, msg):
    key, pub = vapid(con)
    u = urllib.parse.urlparse(sub["endpoint"])
    body = encrypt(json.dumps(msg).encode(), sub["p256dh"], sub["auth"])
    st, err = _post(sub["endpoint"], body, {"Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": "86400",
                                             "Urgency": "high", "Authorization": f"vapid t={_jwt(key, f'{u.scheme}://{u.netloc}')}, k={pub}"})
    if 200 <= st < 300:
        con.execute("UPDATE push_subs SET last_ok=?, fails=0, last_error=NULL WHERE id=?", (now_iso(), sub["id"]))
        return True
    if st in (404, 410):  # the device unsubscribed or the browser dropped it
        con.execute("DELETE FROM push_subs WHERE id=?", (sub["id"],))
    else:
        con.execute("UPDATE push_subs SET fails=fails+1, last_error=? WHERE id=?", (f"{st} {err}"[:300], sub["id"]))
    return False


def prefs_of(sub):
    try:
        return {**PREF_DEFAULT, **json.loads(sub["prefs"] or "{}")}
    except ValueError:
        return dict(PREF_DEFAULT)


# ------------------------------------------------------------------ making alerts
def alert(con, account_id, kind, ref, title, body, url="/", amount=None, source="watch"):
    """Record an alert once (by kind + account + ref) and push it to every device that wants this kind."""
    cur = con.execute("INSERT OR IGNORE INTO alert_log(account_id,kind,ref,title,body,url,source) VALUES(?,?,?,?,?,?,?)",
                      (account_id, kind, str(ref), title, body, url, source))
    if not cur.rowcount:
        return 0
    aid = cur.lastrowid
    sent = 0
    for sub in [dict(r) for r in con.execute("SELECT * FROM push_subs")]:
        p = prefs_of(sub)
        if not p.get(kind, True):
            continue
        if kind == "sale" and amount is not None and amount < float(p.get("min_sale") or 0):
            continue
        try:
            if send_push(con, sub, {"title": title, "body": body, "url": url, "tag": f"{kind}-{account_id}-{ref}"}):
                sent += 1
        except Exception:
            DB.log_exc("alerts.push", level="warn")
    con.execute("UPDATE alert_log SET sent=? WHERE id=?", (sent, aid))
    return sent


def _profit_tool(con):
    try:
        from . import offers as OF
        return OF.Floors(con, 0)
    except Exception:
        DB.log_exc("alerts.profit", level="warn")
        return None


def sale_alerts(db_factory, account_id, orders, source="watch"):
    with db_factory() as con:
        name = (con.execute("SELECT name FROM accounts WHERE id=?", (account_id,)).fetchone() or ["eBay"])[0]
        fl = None
        sku_of = {r["item_id"]: r["sku"] for r in con.execute("SELECT item_id,sku FROM sku_map")}
        for o in orders:
            if ((o.get("cancelStatus") or {}).get("cancelState") or "") == "CANCELED":
                continue
            lis = o.get("lineItems") or []
            total = EB._amt((o.get("pricingSummary") or {}).get("total")) or 0
            parts, profit, known = [], 0.0, True
            for li in lis:
                qty = int(li.get("quantity") or 1)
                item = str(li.get("legacyItemId") or "")
                sku = sku_of.get(item) or li.get("sku") or ""
                cost = EB._amt(li.get("lineItemCost")) or 0
                parts.append(f"{(li.get('title') or '')[:60]}" + (f" ×{qty}" if qty > 1 else "") + (f" ({sku})" if sku else ""))
                if fl is None:
                    fl = _profit_tool(con) or False
                if fl:
                    f, _ = fl.floor(account_id, item, sku, cost / qty if qty else cost)
                    if f is None:
                        known = False
                    else:
                        k, c, po = fl.last
                        profit += cost * k - (c + po) * qty
                else:
                    known = False
            body = " · ".join(parts) or "New order"
            if known and lis:
                body += f" · profit about £{profit:.2f}"
            alert(con, account_id, "sale", o.get("orderId"), f"Sold £{total:.2f} on {name}", body, "/#orders", amount=total, source=source)


def check_orders(db_factory, only=None, source="watch"):
    """New orders since the last look, per account (first run only remembers where to start)."""
    from . import stock as ST
    with db_factory() as con:
        accts = [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens")]
    for a in accts:
        if only is not None and a != only:
            continue
        try:
            with db_factory() as con:
                st = con.execute("SELECT last_orders FROM alert_state WHERE account_id=?", (a,)).fetchone()
                tok = EB.access_token(con, a)
            started = now_iso()
            fresh = st and st["last_orders"] and st["last_orders"] > (_dt.datetime.utcnow() - _dt.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S")
            if fresh:  # after a long gap (no devices for a while) start again from now rather than alert for old orders
                since = (_dt.datetime.fromisoformat(st["last_orders"]) - _dt.timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%S")
                orders = ST.fetch_new_orders(tok, since)
                sale_alerts(db_factory, a, orders, source)
            with db_factory() as con:
                con.execute("INSERT INTO alert_state(account_id,last_orders) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET last_orders=excluded.last_orders", (a, started))
        except Exception:
            DB.log_exc("alerts.orders", level="warn")


def check_tables(db_factory):
    """Questions and returns that the Messages / Returns checks have just found, and new standards warnings."""
    with db_factory() as con:
        names = {r["id"]: r["name"] for r in con.execute("SELECT id,name FROM accounts")}
        since = (_dt.datetime.utcnow() - _dt.timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%S")
        first = not con.execute("SELECT 1 FROM settings WHERE key='alerts_tables_started'").fetchone()
        if first:  # don't alert for everything already there when alerts are first switched on
            for r in con.execute("SELECT account_id,message_id FROM messages"):
                con.execute("INSERT OR IGNORE INTO alert_log(account_id,kind,ref,title,source) VALUES(?,?,?,?,?)", (r[0], "question", r[1], "(already there)", "start"))
            if con.execute("SELECT name FROM sqlite_master WHERE name='returns'").fetchone():
                for r in con.execute("SELECT account_id,kind,rid FROM returns"):
                    con.execute("INSERT OR IGNORE INTO alert_log(account_id,kind,ref,title,source) VALUES(?,?,?,?,?)", (r[0], "return", f"{r[1]}:{r[2]}", "(already there)", "start"))
            con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('alerts_tables_started',?)", (json.dumps(now_iso()),))
            return
        for r in con.execute("SELECT account_id,message_id,item_title,sender,body,created,status FROM messages WHERE fetched_at>=? AND status!='Answered' AND done=0", (since,)).fetchall():
            alert(con, r["account_id"], "question", r["message_id"], f"Question from {r['sender'] or 'a buyer'} · {names.get(r['account_id'], '')}",
                  f"{(r['item_title'] or '')[:60]}: {(r['body'] or '')[:140]}", "/#msgs")
        if con.execute("SELECT name FROM sqlite_master WHERE name='returns'").fetchone():
            kind_name = {"return": "Return", "inquiry": "Item not received", "case": "Case"}
            for r in con.execute("SELECT account_id,kind,rid,reason,comments,refund,fetched_at FROM returns WHERE fetched_at>=?", (since,)).fetchall():
                alert(con, r["account_id"], "return", f"{r['kind']}:{r['rid']}", f"{kind_name.get(r['kind'], r['kind'].title())} opened · {names.get(r['account_id'], '')}",
                      " · ".join(x for x in [(r["reason"] or "").replace("_", " ").lower(), (r["comments"] or "")[:120], f"£{r['refund']:.2f}" if r["refund"] else ""] if x) or "Open Returns to see it", "/#returns")
        try:
            from . import standards as SS
            day = _dt.date.today().strftime("%Y-%m")  # each warning once a month at most
            for acc in SS.page(con):
                for w in acc["warn"]:
                    alert(con, acc["account_id"], "standards", f"{day}:{hashlib.md5(w.encode()).hexdigest()[:10]}", f"Seller standards · {acc['name']}", w, "/#standards")
        except Exception:
            DB.log_exc("alerts.standards", level="warn")


# ------------------------------------------------------------------ eBay Platform Notifications (instant)
def notify_url():
    base = EB.cfg()["PUBLIC_URL"].rstrip("/")
    return f"{base}/ebay/notify" if base else None


def subscribe(con, account_id, enable=True):
    """Turn eBay's instant notifications on (or off) for one account (Trading API SetNotificationPreferences)."""
    url = notify_url()
    if not url:
        raise EB.EbayError("PUBLIC_URL isn't set in Render, so eBay doesn't know where to send notifications.")
    tok = EB.access_token(con, account_id)

    def b(root):
        ap = EB._el(root, "ApplicationDeliveryPreferences")
        EB._el(ap, "ApplicationEnable", "Enable")
        EB._el(ap, "ApplicationURL", url)
        EB._el(ap, "DeviceType", "Platform")
        ua = EB._el(root, "UserDeliveryPreferenceArray")
        for e in EVENTS:
            ne = EB._el(ua, "NotificationEnable")
            EB._el(ne, "EventType", e)
            EB._el(ne, "EventEnable", "Enable" if enable else "Disable")
    try:
        EB.trading("SetNotificationPreferences", tok, b)
        st, msg = ("on" if enable else "off"), ("eBay sends sales, questions and returns here the moment they happen" if enable else "Turned off")
    except EB.EbayError as e:
        st, msg = "error", str(e)[:400]
    con.execute("""INSERT INTO alert_state(account_id,notify_status,notify_message,notify_at) VALUES(?,?,?,?) ON CONFLICT(account_id)
                   DO UPDATE SET notify_status=excluded.notify_status,notify_message=excluded.notify_message,notify_at=excluded.notify_at""",
                (account_id, st, msg, now_iso()))
    if st == "error":
        raise EB.EbayError(msg)


def _find(root, name):
    for el in root.iter():
        if el.tag.rsplit("}", 1)[-1] == name and (el.text or "").strip():
            return el.text.strip()
    return None


def signature_ok(ts, sig):
    """eBay signs each notification with MD5(timestamp + dev id + app id + cert id). Needs EBAY_DEV_ID in Render."""
    c = EB.cfg()
    dev = os.environ.get("EBAY_DEV_ID", "").strip()
    if not dev or not ts or not sig:
        return None
    want = base64.b64encode(hashlib.md5((ts + dev + c["EBAY_CLIENT_ID"] + c["EBAY_CLIENT_SECRET"]).encode()).digest()).decode()
    try:
        fresh = abs((_dt.datetime.utcnow() - _dt.datetime.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")).total_seconds()) < 900
    except ValueError:
        fresh = False
    return hmac.compare_digest(want, sig) and fresh


def handle_notification(db_factory, raw):
    """A nudge from eBay: work out the account and event, then read the real data from eBay."""
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return "unreadable"
    event, user, ts, sig = (_find(root, n) for n in ("NotificationEventName", "RecipientUserID", "Timestamp", "NotificationSignature"))
    with db_factory() as con:
        r = con.execute("SELECT account_id FROM ebay_tokens WHERE lower(ebay_user)=lower(?)", (user or "",)).fetchone()
        if not r:
            return "unknown account"
        a = r[0]
        st = con.execute("SELECT last_poke FROM alert_state WHERE account_id=?", (a,)).fetchone()
        con.execute("INSERT INTO alert_state(account_id,last_poke,pokes) VALUES(?,?,1) ON CONFLICT(account_id) DO UPDATE SET last_poke=excluded.last_poke, pokes=pokes+1", (a, now_iso()))
    ok = signature_ok(ts, sig)
    if ok is False:
        DB.log("warn", "alerts", f"Notification {event} for {user} failed the signature check; read from eBay anyway")
    key = (a, event in SALE_EVENTS, event == "AskSellerQuestion")
    if time.time() - _poke.get(key, 0) < 15:  # several notifications for one order arrive together
        return "debounced"
    _poke[key] = time.time()
    if event in SALE_EVENTS:
        time.sleep(3)  # give eBay a moment to make the order readable
        check_orders(db_factory, only=a, source="instant")
        try:
            from . import stock as ST
            threading.Thread(target=ST.cycle, args=(db_factory,), daemon=True).start()  # stock sync straight away too
        except Exception:
            DB.log_exc("alerts.stock", level="warn")
    elif event == "AskSellerQuestion":
        from . import messages as MS
        MS.check(db_factory)
        check_tables(db_factory)
    elif event and event.startswith("Return"):
        from . import returns as RT
        RT.check(db_factory)
        check_tables(db_factory)
    return event or "?"


# ------------------------------------------------------------------ the 2-minute watcher
def start_scheduler(db_factory, every_seconds=120):
    def loop():
        time.sleep(60)
        n = 0
        while True:
            try:
                if EB.configured():
                    with db_factory() as con:
                        anyone = con.execute("SELECT 1 FROM push_subs LIMIT 1").fetchone()
                    if anyone:
                        check_orders(db_factory)
                        if n % 3 == 0:
                            check_tables(db_factory)
                n += 1
            except Exception:
                DB.log_exc("alerts.loop")
            time.sleep(every_seconds)
    threading.Thread(target=loop, daemon=True).start()
