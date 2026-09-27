"""SQLite storage. One file, path set by DB_PATH (default ./data/partsledger.db)."""
import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = os.environ.get("DB_PATH", str(Path(__file__).resolve().parent.parent / "data" / "partsledger.db"))
SEED_DIR = Path(__file__).resolve().parent.parent / "seed"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  pw_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS accounts(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, channel TEXT NOT NULL,
  seller_id TEXT, color TEXT, sort INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS transactions(
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
  row_key TEXT UNIQUE NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL,
  order_no TEXT, item_id TEXT, title TEXT, sku TEXT, qty REAL,
  item_subtotal REAL, postage REAL, gross REAL, net REAL, description TEXT,
  upload_id INTEGER);
CREATE INDEX IF NOT EXISTS tx_acc_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS tx_order ON transactions(account_id, order_no);

CREATE TABLE IF NOT EXISTS listings(
  account_id INTEGER NOT NULL, item_id TEXT NOT NULL, sku TEXT, title TEXT,
  price REAL, qty INTEGER, category TEXT, sold INTEGER, updated_at TEXT,
  PRIMARY KEY(account_id, item_id));

-- Item-level SKU corrections (listings without a SKU, or with a wrong one)
CREATE TABLE IF NOT EXISTS sku_map(item_id TEXT PRIMARY KEY, sku TEXT NOT NULL, note TEXT);

-- Cost history: the cost with the latest effective_from on or before the sale date applies
CREATE TABLE IF NOT EXISTS cogs(
  id INTEGER PRIMARY KEY, sku TEXT NOT NULL, cost REAL NOT NULL,
  effective_from TEXT NOT NULL DEFAULT '2000-01-01', source TEXT, updated_by TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(sku, effective_from));

CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS uploads(
  id INTEGER PRIMARY KEY, filename TEXT, kind TEXT, account_id INTEGER,
  rows_added INTEGER, rows_skipped INTEGER, date_from TEXT, date_to TEXT,
  uploaded_by TEXT, uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP);
"""

DEFAULT_SETTINGS = {
    "bands": [[6, 1.0], [10, 2.0], [12, 3.0], [16, 4.0]],  # price under X -> COGS Y
    "low_price_threshold": 6.0,
    "returned_refund_share": 0.9,  # refund >= 90% of the order = returned, COGS comes back
}

DEFAULT_ACCOUNTS = [
    ("Newgates19uk", "ebay", "newgates19ltd", "#2F6FB0", 1),
    ("Autonation", "ebay", "autonationaccessoriesltd", "#23907F", 2),
    ("Technofest", "ebay", "technofestltd", "#7B5BB8", 3),
    ("Amazon Motoviano", "amazon", None, "#C27A12", 4),
]


def connect():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA journal_mode=WAL")
    return con


@contextmanager
def db():
    con = connect()
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init():
    with db() as con:
        con.executescript(SCHEMA)
        if not con.execute("SELECT 1 FROM accounts").fetchone():
            con.executemany("INSERT INTO accounts(name,channel,seller_id,color,sort) VALUES(?,?,?,?,?)", DEFAULT_ACCOUNTS)
        for k, v in DEFAULT_SETTINGS.items():
            con.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, json.dumps(v)))
        # First start: load the costs and SKU corrections agreed so far
        if not con.execute("SELECT 1 FROM cogs").fetchone():
            f = SEED_DIR / "cogs_seed.json"
            if f.exists():
                for r in json.loads(f.read_text()):
                    con.execute("INSERT OR IGNORE INTO cogs(sku,cost,effective_from,source,updated_by) VALUES(?,?,?,?,?)",
                                (r["sku"], r["cost"], "2000-01-01", r["source"], "seed"))
        if not con.execute("SELECT 1 FROM sku_map").fetchone():
            f = SEED_DIR / "sku_map.json"
            if f.exists():
                for r in json.loads(f.read_text()):
                    con.execute("INSERT OR IGNORE INTO sku_map(item_id,sku,note) VALUES(?,?,?)", (r["item_id"], r["sku"], r.get("note")))
        if not con.execute("SELECT 1 FROM listings").fetchone():
            f = SEED_DIR / "listings_seed.json"
            if f.exists():
                accs = {r["name"]: r["id"] for r in con.execute("SELECT id,name FROM accounts")}
                for r in json.loads(f.read_text()):
                    con.execute("INSERT OR IGNORE INTO listings(account_id,item_id,sku,title,price,qty,category,sold,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                                (accs[r["account"]], r["item_id"], r["sku"], r["title"], r["price"], r["qty"], r["category"], r["sold"], r["updated_at"]))


def get_settings(con):
    return {r["key"]: json.loads(r["value"]) for r in con.execute("SELECT key,value FROM settings")}
