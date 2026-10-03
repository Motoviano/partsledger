"""eBay payouts per account, with what each one is made of, to match against the bank.

Finances API (signed requests, like the transaction sync): getPayouts for the dates, then the transactions in
each payout (filter payoutId) so every payout splits into sales, refunds, postage labels, fees and other.
"Found in bank" is ticked by hand in the app.
"""
import datetime as _dt
import json
import threading
import time
import urllib.parse

from . import ebay as EB
from . import db as DB

SCHEMA = """
CREATE TABLE IF NOT EXISTS payouts(
  account_id INTEGER NOT NULL, payout_id TEXT NOT NULL, date TEXT, status TEXT, amount REAL, currency TEXT,
  tx_count INTEGER, instrument TEXT, last4 TEXT, bank_ref TEXT, raw TEXT, fetched_at TEXT,
  banked INTEGER DEFAULT 0, banked_by TEXT, banked_at TEXT, note TEXT, PRIMARY KEY(account_id, payout_id));
CREATE TABLE IF NOT EXISTS payout_lines(
  account_id INTEGER NOT NULL, payout_id TEXT NOT NULL, transaction_id TEXT NOT NULL, type TEXT, fee_type TEXT,
  amount REAL, order_id TEXT, date TEXT, PRIMARY KEY(account_id, payout_id, transaction_id));
CREATE TABLE IF NOT EXISTS seller_funds(
  account_id INTEGER PRIMARY KEY, at TEXT, total REAL, available REAL, processing REAL, on_hold REAL, raw TEXT);
CREATE TABLE IF NOT EXISTS payout_state(
  account_id INTEGER PRIMARY KEY, last_check TEXT, last_status TEXT, last_message TEXT, backfilled INTEGER DEFAULT 0);
"""
_lock = threading.Lock()


def now_iso():
    return _dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")


def _amt(o):
    try:
        return float((o or {}).get("value"))
    except (TypeError, ValueError):
        return None


def fetch_payouts(token, sign, start, end):
    out, off = [], 0
    while True:
        q = urllib.parse.urlencode({"filter": f"payoutDate:[{start}T00:00:00.000Z..{end}T23:59:59.000Z]", "limit": 200, "offset": off, "sort": "payoutDate"})
        j = EB._get_json(f"{EB.FIN}/payout?{q}", token, sign=sign)
        rows = j.get("payouts") or []
        out += rows
        if len(rows) < 200:
            return out
        off += 200


def fetch_lines(token, sign, payout_id):
    out, off = [], 0
    while True:
        q = urllib.parse.urlencode({"filter": f"payoutId:{{{payout_id}}}", "limit": 1000, "offset": off})
        j = EB._get_json(f"{EB.FIN}/transaction?{q}", token, sign=sign)
        rows = j.get("transactions") or []
        out += rows
        if len(rows) < 1000:
            return out
        off += 1000


def check(db_factory):
    with _lock:
        with db_factory() as con:
            accounts = [r[0] for r in con.execute("SELECT account_id FROM ebay_tokens")]
        today = _dt.date.today()
        for a in accounts:
            try:
                with db_factory() as con:
                    tok = EB.access_token(con, a)
                    sign = EB.signing_key(con)
                    st = con.execute("SELECT * FROM payout_state WHERE account_id=?", (a,)).fetchone()
                    have = {r["payout_id"]: (r["status"], r["n"]) for r in con.execute(
                        "SELECT p.payout_id, p.status, (SELECT COUNT(*) FROM payout_lines l WHERE l.account_id=p.account_id AND l.payout_id=p.payout_id) n FROM payouts p WHERE p.account_id=?", (a,))}
                days = 21 if st and st["backfilled"] else 120
                ps = fetch_payouts(tok, sign, (today - _dt.timedelta(days=days)).isoformat(), today.isoformat())
                try:  # money still in the eBay account (not paid out yet)
                    f = EB._get_json(f"{EB.FIN}/seller_funds_summary", tok, sign=sign)
                    with db_factory() as con:
                        con.execute("INSERT OR REPLACE INTO seller_funds VALUES(?,?,?,?,?,?,?)",
                                    (a, now_iso(), _amt(f.get("totalFunds")), _amt(f.get("availableFunds")), _amt(f.get("processingFunds")),
                                     _amt(f.get("fundsOnHold")), json.dumps(f)[:4000]))
                except Exception:
                    DB.log_exc("payouts.funds", level="warn")
                new_lines = 0
                for p in ps:
                    pid = str(p.get("payoutId"))
                    inst = p.get("payoutInstrument") or {}
                    with db_factory() as con:
                        con.execute("""INSERT INTO payouts(account_id,payout_id,date,status,amount,currency,tx_count,instrument,last4,bank_ref,raw,fetched_at)
                                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,payout_id) DO UPDATE SET date=excluded.date,status=excluded.status,
                                       amount=excluded.amount,tx_count=excluded.tx_count,instrument=excluded.instrument,last4=excluded.last4,bank_ref=excluded.bank_ref,
                                       raw=excluded.raw,fetched_at=excluded.fetched_at""",
                                    (a, pid, (p.get("payoutDate") or p.get("lastAttemptedPayoutDate") or "")[:19], p.get("payoutStatus"),
                                     _amt(p.get("amount")), (p.get("amount") or {}).get("currency"), p.get("transactionCount"),
                                     inst.get("nickname") or inst.get("instrumentType"), inst.get("accountLastFourDigits"),
                                     p.get("payoutReference") or p.get("bankReference"), json.dumps(p)[:8000], now_iso()))
                    old = have.get(pid)
                    if old and old[1] and old[0] == p.get("payoutStatus"):
                        continue  # lines already loaded and nothing changed
                    lines = fetch_lines(tok, sign, pid)
                    with db_factory() as con:
                        con.execute("DELETE FROM payout_lines WHERE account_id=? AND payout_id=?", (a, pid))
                        for t in lines:
                            con.execute("INSERT OR REPLACE INTO payout_lines VALUES(?,?,?,?,?,?,?,?)",
                                        (a, pid, str(t.get("transactionId")), t.get("transactionType"), t.get("feeType"),
                                         round(EB._signed(t), 2), t.get("orderId") or EB._ref(t, "ORDER_ID"),
                                         (t.get("transactionDate") or p.get("payoutDate") or "")[:10]))
                    new_lines += len(lines)
                    time.sleep(0.3)
                with db_factory() as con:
                    con.execute("""INSERT INTO payout_state(account_id,last_check,last_status,last_message,backfilled) VALUES(?,?,?,?,1)
                                   ON CONFLICT(account_id) DO UPDATE SET last_check=excluded.last_check,last_status=excluded.last_status,last_message=excluded.last_message,backfilled=1""",
                                (a, now_iso(), "ok", f"{len(ps)} payouts in the last {days} days" + (
                                    f" ({min(p.get('payoutDate', '')[:10] for p in ps)} to {max(p.get('payoutDate', '')[:10] for p in ps)})" if ps else "")))
            except Exception as e:
                DB.log_exc("payouts.check")
                with db_factory() as con:
                    con.execute("""INSERT INTO payout_state(account_id,last_check,last_status,last_message) VALUES(?,?,?,?)
                                   ON CONFLICT(account_id) DO UPDATE SET last_check=excluded.last_check,last_status=excluded.last_status,last_message=excluded.last_message""",
                                (a, now_iso(), "error", str(e)[:500]))


def start_scheduler(db_factory, every_hours=6):
    def loop():
        time.sleep(300)
        while True:
            try:
                if EB.configured():
                    check(db_factory)
            except Exception:
                DB.log_exc("payouts.loop")
            time.sleep(every_hours * 3600)
    threading.Thread(target=loop, daemon=True).start()
