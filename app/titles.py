"""Better titles from each listing's own fitment rows and item specifics.

For every listing: read its compatibility list and specifics (GetItem), find the main make and model (the one
with most fitment rows) and its year range, and the OE number. Then add what the title is missing, in this
order, while it fits in eBay's 80 characters:
  make -> model -> year range (after the model if the model is already in the title) -> OE number.
Nothing is removed from the title. A short year range (14-19) is used when the long one doesn't fit.
"""
import re
import threading
import time
from collections import Counter, defaultdict

from . import ebay as EB
from . import db as DB

N = EB.N
SCHEMA = """
CREATE TABLE IF NOT EXISTS title_jobs(
  id INTEGER PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP, created_by TEXT, total INTEGER, done INTEGER DEFAULT 0, status TEXT);
CREATE TABLE IF NOT EXISTS title_suggest(
  job_id INTEGER NOT NULL, account_id INTEGER NOT NULL, item_id TEXT NOT NULL, old_title TEXT, new_title TEXT,
  added TEXT, note TEXT, status TEXT DEFAULT 'waiting', sku TEXT, PRIMARY KEY(job_id, account_id, item_id));
"""
YEAR_IN_TITLE = re.compile(r"\b(19|20)\d{2}\b|\b\d{2}\s?-\s?\d{2}\b|\b\d{2}\s?(on|onwards|>)\b|\b(19|20)\d{2}\s?-", re.I)
OE_NAMES = re.compile(r"\b(oe|oem)\b|reference|manufacturer part number|part number|mpn", re.I)
_lock = threading.Lock()


def _norm(s):
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def _has(title, text):
    return bool(text) and re.search(r"(?<![A-Za-z0-9])" + re.escape(text) + r"(?![A-Za-z0-9])", title, re.I) is not None


def read_item(token, item_id):
    def b(root):
        EB._el(root, "ItemID", item_id)
        EB._el(root, "DetailLevel", "ReturnAll")
        EB._el(root, "IncludeItemCompatibilityList", "true")
        EB._el(root, "IncludeItemSpecifics", "true")
    it = EB.trading("GetItem", token, b).find(N + "Item")
    compat = []
    for c in it.findall(f"{N}ItemCompatibilityList/{N}Compatibility"):
        compat.append({(nv.findtext(N + "Name") or ""): (nv.findtext(N + "Value") or "") for nv in c.findall(N + "NameValueList")})
    specs = {}
    for nv in it.findall(f"{N}ItemSpecifics/{N}NameValueList"):
        specs[nv.findtext(N + "Name") or ""] = [v.text or "" for v in nv.findall(N + "Value")]
    return it.findtext(N + "Title") or "", compat, specs


def fitment_summary(compat):
    """Main make and model, their year range, how many fitment rows."""
    def pick(row, *keys):
        for k, v in row.items():
            kl = k.lower()
            if any(kl == x or kl.endswith(" " + x) or kl.startswith(x) for x in keys) and v:
                return v.strip()
        return None
    counts, years = Counter(), defaultdict(set)
    for row in compat:
        make, model = pick(row, "make", "car make"), pick(row, "model")
        if not make or not model:
            continue
        counts[(make, model)] += 1
        for k, v in row.items():
            if "year" in k.lower():
                years[(make, model)].update(int(y) for y in re.findall(r"\b(?:19|20)\d{2}\b", v))
    if not counts:
        return None
    (make, model), n = counts.most_common(1)[0]
    ys = sorted(years[(make, model)])
    return {"make": make, "model": model, "y0": ys[0] if ys else None, "y1": ys[-1] if ys else None, "rows": len(compat), "main_rows": n}


def oe_number(specs, title, sku=None):
    """An OE number from the specifics: OE/OEM/Reference fields first, then part-number fields that aren't the SKU."""
    names = sorted((n for n in specs if OE_NAMES.search(n) and not re.search(r"interchange|brand", n, re.I)),
                   key=lambda n: 0 if re.search(r"\b(oe|oem)\b|reference", n, re.I) else 1)
    for name in names:
        vals = specs[name]
        for v in vals:
            for tok in re.split(r"[,;/|]\s*|\s{2,}", v):
                tok = tok.strip()
                if len(_norm(tok)) >= 5 and not re.fullmatch(r"(?i)does not apply|n/?a|unbranded|none", tok) and _norm(tok) not in _norm(title) \
                        and not (sku and _norm(tok) == _norm(sku)):
                    return tok
    return None


MAKES = ["Alfa Romeo", "Audi", "BMW", "Citroen", "Dacia", "Fiat", "Ford", "Honda", "Hyundai", "Iveco", "Jaguar", "Jeep", "Kia",
         "Land Rover", "Range Rover", "Lexus", "Mazda", "Mercedes", "Mini", "Mitsubishi", "Nissan", "Peugeot", "Porsche", "Renault",
         "Seat", "Skoda", "Smart", "Suzuki", "Toyota", "Vauxhall", "Opel", "Volkswagen", "VW", "Volvo", "Chevrolet", "Isuzu", "MAN", "LDV"]
ALIAS = {"VW": "VOLKSWAGEN", "MERCEDES": "MERCEDESBENZ", "MERCEDESBENZ": "MERCEDESBENZ", "RANGEROVER": "LANDROVER", "OPEL": "VAUXHALL"}


def _canon(make):
    n = _norm(make)
    return ALIAS.get(n, n)


PLATFORM = re.compile(r"\s+(MK\s?\d+[A-Z]?|Mk\s?\d+|W\d{3}|[A-Z]\d{2,3}|Facelift|FL)\b", re.I)


def build(title, compat, specs, limit=80, sku=None):
    """(new_title, [what was added], note)."""
    title = re.sub(r"\s{2,}", " ", title).strip()
    fit = fitment_summary(compat)
    added, skipped = [], []
    new = title

    def fits(t):
        return len(t) <= limit

    if fit:
        make, model = fit["make"], fit["model"]
        fm = _canon(make)
        other = [m for m in MAKES if _has(new, m) and _canon(m) != fm]
        if other and not any(_has(new, m) for m in MAKES if _canon(m) == fm) and not _has(new, make.split("-")[0]):
            return title, [], f"Title says {other[0]} but the fitment is {make} {model}: check this listing (title left as it is)"
        if not _has(new, model):
            words = model.split()
            # part of the model is already there (e.g. "Transit" for "Transit Custom"): add only the rest, right after it
            k = next((k for k in range(len(words) - 1, 0, -1) if _has(new, " ".join(words[:k]))), 0)
            if k:
                mm = re.search(r"(?<![A-Za-z0-9])" + re.escape(" ".join(words[:k])) + r"(?![A-Za-z0-9])", new, re.I)
                rest = " ".join(words[k:])
                cand = new[:mm.end()] + " " + rest + new[mm.end():]
                piece = rest
            else:
                piece = model if _has(new, make) else f"{make} {model}"
                cand = f"{new} {piece}"
            if fits(cand):
                new = cand; added.append(piece)
            else:
                skipped.append(piece)
        if fit["y0"] and not YEAR_IN_TITLE.search(new):
            y0, y1 = fit["y0"], fit["y1"]
            longy, shorty = (f"{y0}-{y1}", f"{str(y0)[2:]}-{str(y1)[2:]}") if y1 != y0 else (str(y0), str(y0))
            m = re.search(re.escape(model), new, re.I) if model else None
            at = None
            if m:  # after the model, and after a platform code like MK8 or W906 that follows it
                at = m.end()
                pm = PLATFORM.match(new, at)
                if pm:
                    at = pm.end()
            for ys in (longy, shorty):
                cand = (new[:at] + " " + ys + new[at:]) if at is not None else f"{new} {ys}"
                if fits(cand):
                    new = cand; added.append(ys); break
            else:
                skipped.append(longy)
    oe = oe_number(specs, new, sku)
    if oe:
        cand = f"{new} {oe}"
        if fits(cand):
            new = cand; added.append(oe)
        else:
            skipped.append(f"OE {oe}")
    new = re.sub(r"\s{2,}", " ", new).strip()
    if not fit:
        note = "No fitment rows on this listing" + ("" if oe else "")
    else:
        note = f"Fitment: {fit['make']} {fit['model']}" + (f" {fit['y0']}-{fit['y1']}" if fit["y0"] else "") + f" ({fit['rows']} rows)"
    if skipped:
        note += " · didn't fit in 80 characters: " + ", ".join(skipped)
    return new, added, note


def run_job(db_factory, job_id):
    with _lock:
        with db_factory() as con:
            con.execute("UPDATE title_jobs SET status='running' WHERE id=?", (job_id,))
            rows = [dict(r) for r in con.execute("SELECT * FROM title_suggest WHERE job_id=? AND status='waiting'", (job_id,))]
        tokens = {}
        for r in rows:
            try:
                if r["account_id"] not in tokens:
                    with db_factory() as con:
                        tokens[r["account_id"]] = EB.access_token(con, r["account_id"])
                title, compat, specs = read_item(tokens[r["account_id"]], r["item_id"])
                new, added, note = build(title, compat, specs, sku=r.get("sku"))
                st, vals = "ok", (title, new, ", ".join(added), note)
            except Exception as e:
                DB.log_exc("titles.run_job", level="warn")
                st, vals = "failed", (r["old_title"], None, "", str(e)[:400])
            with db_factory() as con:
                con.execute("UPDATE title_suggest SET old_title=?, new_title=?, added=?, note=?, status=? WHERE job_id=? AND account_id=? AND item_id=?",
                            (*vals, st, job_id, r["account_id"], r["item_id"]))
                con.execute("UPDATE title_jobs SET done=done+1 WHERE id=?", (job_id,))
            time.sleep(0.15)
        with db_factory() as con:
            con.execute("UPDATE title_jobs SET status='finished' WHERE id=?", (job_id,))
