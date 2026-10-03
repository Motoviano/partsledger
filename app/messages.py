"""Buyer messages from every eBay account in one inbox.

Questions buyers send about listings or orders come from GetMemberMessages (Trading API); replies go back
with AddMemberMessageRTQ, which answers that question on eBay (the buyer gets it in their eBay messages and
by email). The last 14 days are re-read on every check, so questions answered on the eBay website show as
answered here too.
"""
import datetime as _dt
import json
import re
import threading
import time

from . import ebay as EB
from . import db as DB

N = EB.N
SCHEMA = """
CREATE TABLE IF NOT EXISTS messages(
  account_id INTEGER NOT NULL, message_id TEXT NOT NULL, item_id TEXT, item_title TEXT, sender TEXT,
  subject TEXT, body TEXT, created TEXT, status TEXT, responses TEXT, question_type TEXT, public INTEGER,
  done INTEGER DEFAULT 0, replied_by TEXT, replied_at TEXT, reply_text TEXT, fetched_at TEXT,
  PRIMARY KEY(account_id, message_id));
CREATE INDEX IF NOT EXISTS messages_created ON messages(created);
CREATE TABLE IF NOT EXISTS message_state(
  account_id INTEGER PRIMARY KEY, last_check TEXT, last_status TEXT, last_message TEXT, backfilled INTEGER DEFAULT 0);
"""
DEFAULT_TEMPLATES = [
    {"name": "Ask for reg", "text": "Hi {buyer}, thanks for your message. Please send us your vehicle registration (or VIN) and we'll check this part fits your car before you order."},
    {"name": "It fits", "text": "Hi {buyer}, yes, we've checked and this part fits your vehicle. Orders placed before 1pm on a working day are dispatched the same day."},
    {"name": "Dispatch time", "text": "Hi {buyer}, orders placed before 1pm on a working day are dispatched the same day. Delivery usually takes 1 to 3 working days."},
    {"name": "Returns", "text": "Hi {buyer}, sorry to hear that. Please open a return through eBay (Purchase history → Return this item) and we'll sort it out for you straight away."},
]
_lock = threading.Lock()


def now_iso():
    return _dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")


def get_templates(con):
    r = con.execute("SELECT value FROM settings WHERE key='msg_templates'").fetchone()
    return json.loads(r[0]) if r else DEFAULT_TEMPLATES


def set_templates(con, items):
    clean = [{"name": str(t.get("name", ""))[:40].strip(), "text": str(t.get("text", ""))[:2000].strip()} for t in items]
    clean = [t for t in clean if t["name"] and t["text"]][:30]
    con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('msg_templates',?)", (json.dumps(clean),))
    return clean


def fetch(token, start, end):
    """All buyer questions created between two UTC datetimes."""
    out, page = [], 1
    while True:
        def b(root, page=page):
            EB._el(root, "MailMessageType", "All")
            EB._el(root, "StartCreationTime", start.strftime("%Y-%m-%dT%H:%M:%S.000Z"))
            EB._el(root, "EndCreationTime", end.strftime("%Y-%m-%dT%H:%M:%S.000Z"))
            pg = EB._el(root, "Pagination")
            EB._el(pg, "EntriesPerPage", "200")
            EB._el(pg, "PageNumber", str(page))
        r = EB.trading("GetMemberMessages", token, b)
        for ex in r.iter(N + "MemberMessageExchange"):
            q = ex.find(N + "Question")
            if q is None:
                continue
            out.append({
                "message_id": q.findtext(N + "MessageID"),
                "item_id": ex.findtext(f"{N}Item/{N}ItemID"),
                "item_title": ex.findtext(f"{N}Item/{N}Title"),
                "sender": q.findtext(N + "SenderID"),
                "subject": q.findtext(N + "Subject"),
                "body": q.findtext(N + "Body"),
                "question_type": q.findtext(N + "QuestionType"),
                "public": 1 if (q.findtext(N + "DisplayToPublic") or "").lower() == "true" else 0,
                "status": ex.findtext(N + "MessageStatus"),
                "created": (ex.findtext(N + "CreationDate") or "")[:19],
                "responses": [x.text or "" for x in ex.findall(N + "Response")],
            })
        pages = int(r.findtext(f"{N}PaginationResult/{N}TotalNumberOfPages") or 1)
        if page >= pages:
            return out
        page += 1


def _clean(s):
    s = re.sub(r"<br\s*/?>", "\n", s or "", flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'").strip()


def check(db_factory):
    with _lock:
        with db_factory() as con:
            accounts = [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens")]
        for a in accounts:
            try:
                with db_factory() as con:
                    tok = EB.access_token(con, a)
                    st = con.execute("SELECT * FROM message_state WHERE account_id=?", (a,)).fetchone()
                end = _dt.datetime.utcnow() - _dt.timedelta(seconds=60)
                days = 14 if st and st["backfilled"] else 30
                rows = fetch(tok, end - _dt.timedelta(days=days), end)
                new = 0
                with db_factory() as con:
                    for m in rows:
                        if not m["message_id"]:
                            continue
                        cur = con.execute("SELECT status FROM messages WHERE account_id=? AND message_id=?", (a, m["message_id"])).fetchone()
                        if cur is None:
                            new += 1
                            con.execute("""INSERT INTO messages(account_id,message_id,item_id,item_title,sender,subject,body,created,status,responses,question_type,public,fetched_at)
                                           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                                        (a, m["message_id"], m["item_id"], m["item_title"], m["sender"], _clean(m["subject"]), _clean(m["body"]),
                                         m["created"], m["status"], json.dumps([_clean(x) for x in m["responses"]]), m["question_type"], m["public"], now_iso()))
                        else:
                            # a reply sent from here stays answered even if eBay hasn't caught up yet
                            con.execute("""UPDATE messages SET status=CASE WHEN replied_at IS NOT NULL THEN 'Answered' ELSE ? END,
                                           responses=?, fetched_at=? WHERE account_id=? AND message_id=?""",
                                        (m["status"], json.dumps([_clean(x) for x in m["responses"]]), now_iso(), a, m["message_id"]))
                    con.execute("""INSERT INTO message_state(account_id,last_check,last_status,last_message,backfilled) VALUES(?,?,?,?,1)
                                   ON CONFLICT(account_id) DO UPDATE SET last_check=excluded.last_check,last_status=excluded.last_status,
                                   last_message=excluded.last_message,backfilled=1""",
                                (a, now_iso(), "ok", f"{len(rows)} messages in the last {days} days, {new} new"))
            except Exception as e:
                DB.log_exc("messages.check")
                with db_factory() as con:
                    con.execute("""INSERT INTO message_state(account_id,last_check,last_status,last_message) VALUES(?,?,?,?)
                                   ON CONFLICT(account_id) DO UPDATE SET last_check=excluded.last_check,last_status=excluded.last_status,last_message=excluded.last_message""",
                                (a, now_iso(), "error", str(e)[:500]))


def reply(con, account_id, message_id, text, public, user):
    m = con.execute("SELECT * FROM messages WHERE account_id=? AND message_id=?", (account_id, message_id)).fetchone()
    if not m:
        raise EB.EbayError("Message not found.")
    text = (text or "").strip()
    if not text:
        raise EB.EbayError("Type a reply first.")
    if len(text) > 2000:
        raise EB.EbayError(f"eBay allows 2,000 characters; this reply has {len(text)}.")
    tok = EB.access_token(con, account_id)

    def b(root):
        EB._el(root, "ItemID", m["item_id"])
        mm = EB._el(root, "MemberMessage")
        EB._el(mm, "Body", text)
        EB._el(mm, "DisplayToPublic", "true" if public else "false")
        EB._el(mm, "ParentMessageID", message_id)
        EB._el(mm, "RecipientID", m["sender"])
    EB.trading("AddMemberMessageRTQ", tok, b)
    t = now_iso()
    con.execute("UPDATE messages SET status='Answered', replied_by=?, replied_at=?, reply_text=? WHERE account_id=? AND message_id=?",
                (user, t, text, account_id, message_id))
    # other open questions from the same buyer about the same listing are covered by this reply
    con.execute("""UPDATE messages SET done=1 WHERE account_id=? AND sender=? AND IFNULL(item_id,'')=IFNULL(?, '')
                   AND status!='Answered' AND created<=?""", (account_id, m["sender"], m["item_id"], m["created"]))


def start_scheduler(db_factory, every_minutes=10):
    def loop():
        time.sleep(120)
        while True:
            try:
                if EB.configured():
                    check(db_factory)
            except Exception:
                DB.log_exc("messages.loop")
                pass
            time.sleep(every_minutes * 60)
    threading.Thread(target=loop, daemon=True).start()
