"""eBay connection: OAuth per account, Trading API calls, and the listing copier.

Settings (Render → Environment):
  EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME      - from developer.ebay.com (Production keyset + user token RuName)
  EBAY_VERIFICATION_TOKEN                             - any 32-80 character string, also typed into the developer portal
  PUBLIC_URL                                          - e.g. https://profit.motoviano.com
Optional: EBAY_COMPAT_LEVEL (default 1477), EBAY_SITE_ID (default 3 = UK)
"""
import base64
import hashlib
import json
import os
import secrets
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from copy import deepcopy

NS = "urn:ebay:apis:eBLBaseComponents"
N = "{%s}" % NS
ET.register_namespace("", NS)

AUTH_URL = "https://auth.ebay.com/oauth2/authorize"
TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token"
TRADING_URL = "https://api.ebay.com/ws/api.dll"
SCOPES = [
    "https://api.ebay.com/oauth/api_scope",
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.account",
    "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
    "https://api.ebay.com/oauth/api_scope/sell.finances",
    "https://api.ebay.com/oauth/api_scope/sell.marketing",
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS ebay_tokens(
  account_id INTEGER PRIMARY KEY, ebay_user TEXT, refresh_token TEXT NOT NULL,
  refresh_expires TEXT, access_token TEXT, access_expires REAL, connected_by TEXT,
  connected_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS ebay_jobs(
  id INTEGER PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP, created_by TEXT,
  source_id INTEGER, target_id INTEGER, mode TEXT, settings TEXT, status TEXT,
  total INTEGER, done INTEGER DEFAULT 0, ok INTEGER DEFAULT 0, failed INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS ebay_job_items(
  id INTEGER PRIMARY KEY, job_id INTEGER, item_id TEXT, sku TEXT, title TEXT,
  price REAL, status TEXT DEFAULT 'waiting', new_item_id TEXT, message TEXT);
"""


class EbayError(Exception):
    pass


def cfg():
    c = {k: os.environ.get(k, "").strip() for k in
         ("EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RUNAME", "EBAY_VERIFICATION_TOKEN", "PUBLIC_URL")}
    c["EBAY_COMPAT_LEVEL"] = os.environ.get("EBAY_COMPAT_LEVEL", "1477")
    c["EBAY_SITE_ID"] = os.environ.get("EBAY_SITE_ID", "3")
    return c


def configured():
    c = cfg()
    return all(c[k] for k in ("EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RUNAME"))


def missing_settings():
    c = cfg()
    return [k for k in ("EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RUNAME", "EBAY_VERIFICATION_TOKEN", "PUBLIC_URL") if not c[k]]


# ------------------------------------------------------------------ HTTP helpers
def _http(url, data=None, headers=None, method=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# ------------------------------------------------------------------ OAuth
_states = {}


def auth_link(account_id: int) -> str:
    c = cfg()
    state = secrets.token_urlsafe(24)
    _states[state] = (account_id, time.time())
    q = {"client_id": c["EBAY_CLIENT_ID"], "response_type": "code", "redirect_uri": c["EBAY_RUNAME"],
         "scope": " ".join(SCOPES), "state": state, "prompt": "login"}
    return AUTH_URL + "?" + urllib.parse.urlencode(q, quote_via=urllib.parse.quote)


def pop_state(state):
    v = _states.pop(state or "", None)
    if not v or time.time() - v[1] > 1800:
        return None
    return v[0]


def _basic():
    c = cfg()
    return "Basic " + base64.b64encode(f"{c['EBAY_CLIENT_ID']}:{c['EBAY_CLIENT_SECRET']}".encode()).decode()


def _token_request(form):
    st, body = _http(TOKEN_URL, urllib.parse.urlencode(form).encode(),
                     {"Content-Type": "application/x-www-form-urlencoded", "Authorization": _basic()}, "POST")
    j = json.loads(body or b"{}")
    if st != 200:
        raise EbayError(j.get("error_description") or j.get("error") or f"eBay login failed ({st}).")
    return j


def exchange_code(code):
    return _token_request({"grant_type": "authorization_code", "code": code, "redirect_uri": cfg()["EBAY_RUNAME"]})


def save_connection(con, account_id, tok, by):
    access, exp = tok["access_token"], time.time() + int(tok.get("expires_in", 7200)) - 120
    user = get_user_id(access)
    rexp = time.strftime("%Y-%m-%d", time.gmtime(time.time() + int(tok.get("refresh_token_expires_in", 0))))
    con.execute("""INSERT INTO ebay_tokens(account_id,ebay_user,refresh_token,refresh_expires,access_token,access_expires,connected_by)
                   VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET ebay_user=excluded.ebay_user,
                   refresh_token=excluded.refresh_token,refresh_expires=excluded.refresh_expires,access_token=excluded.access_token,
                   access_expires=excluded.access_expires,connected_by=excluded.connected_by,connected_at=CURRENT_TIMESTAMP""",
                (account_id, user, tok["refresh_token"], rexp, access, exp, by))
    return user


def access_token(con, account_id):
    r = con.execute("SELECT * FROM ebay_tokens WHERE account_id=?", (account_id,)).fetchone()
    if not r:
        raise EbayError("This account isn't connected to eBay yet.")
    if r["access_token"] and (r["access_expires"] or 0) > time.time():
        return r["access_token"]
    j = _token_request({"grant_type": "refresh_token", "refresh_token": r["refresh_token"], "scope": " ".join(SCOPES)})
    con.execute("UPDATE ebay_tokens SET access_token=?, access_expires=? WHERE account_id=?",
                (j["access_token"], time.time() + int(j.get("expires_in", 7200)) - 120, account_id))
    con.commit()
    return j["access_token"]


# ------------------------------------------------------------------ Trading API
def _el(parent, tag, text=None):
    e = ET.SubElement(parent, N + tag)
    if text is not None:
        e.text = str(text)
    return e


def trading(call, token, build=None, root_el=None):
    c = cfg()
    root = root_el if root_el is not None else ET.Element(N + call + "Request")
    if build:
        build(root)
    _el(root, "ErrorLanguage", "en_GB")
    _el(root, "WarningLevel", "High")
    body = b'<?xml version="1.0" encoding="utf-8"?>' + ET.tostring(root)
    st, raw = _http(TRADING_URL, body, {
        "X-EBAY-API-CALL-NAME": call, "X-EBAY-API-SITEID": c["EBAY_SITE_ID"],
        "X-EBAY-API-COMPATIBILITY-LEVEL": c["EBAY_COMPAT_LEVEL"], "X-EBAY-API-IAF-TOKEN": token,
        "Content-Type": "text/xml"}, "POST", timeout=120)
    try:
        resp = ET.fromstring(raw)
    except ET.ParseError:
        raise EbayError(f"eBay returned an unexpected answer to {call} ({st}).")
    ack = resp.findtext(N + "Ack")
    errs = [(e.findtext(N + "SeverityCode"), e.findtext(N + "ErrorCode"), e.findtext(N + "LongMessage") or e.findtext(N + "ShortMessage"))
            for e in resp.findall(N + "Errors")]
    if ack not in ("Success", "Warning"):
        msg = "; ".join(f"{m} (code {code})" for sev, code, m in errs if sev == "Error") or f"{call} failed"
        raise EbayError(msg)
    resp.set("pl_warnings", json.dumps([f"{m} (code {code})" for sev, code, m in errs if sev == "Warning"]))
    return resp


def get_user_id(token):
    r = trading("GetUser", token)
    return r.findtext(f"{N}User/{N}UserID")


def get_policies(token):
    def b(root):
        _el(root, "ShowSellerProfilePreferences", "true")
    r = trading("GetUserPreferences", token, b)
    out = {"PAYMENT": [], "RETURN_POLICY": [], "SHIPPING": []}
    for p in r.iter(N + "SupportedSellerProfile"):
        t = p.findtext(N + "ProfileType")
        if t in out:
            out[t].append({"id": p.findtext(N + "ProfileID"), "name": p.findtext(N + "ProfileName"),
                           "default": (p.findtext(N + "CategoryGroup/" + N + "IsDefault") == "true")})
    return out


def get_item(token, item_id):
    def b(root):
        _el(root, "ItemID", item_id)
        _el(root, "DetailLevel", "ReturnAll")
        _el(root, "IncludeItemCompatibilityList", "true")
        _el(root, "IncludeItemSpecifics", "true")
    return trading("GetItem", token, b).find(N + "Item")


def upload_picture(token, url, name):
    def b(root):
        _el(root, "ExternalPictureURL", url)
        _el(root, "PictureName", name[:80])
        _el(root, "PictureSet", "Supersize")
    r = trading("UploadSiteHostedPictures", token, b)
    return r.findtext(f"{N}SiteHostedPictureDetails/{N}FullURL")


def _big(url):
    import re
    return re.sub(r"/s-l\d+\.(jpg|jpeg|png|webp)", r"/s-l1600.\1", url)


# Elements copied as they are from the source listing
COPY_TAGS = ["Title", "SubTitle", "Description", "PrimaryCategory", "SecondaryCategory", "ConditionID", "ConditionDescription",
             "ItemSpecifics", "Country", "Currency", "Location", "PostalCode", "DispatchTimeMax", "ProductListingDetails"]
PLD_KEEP = {"EAN", "UPC", "ISBN", "BrandMPN", "IncludeeBayProductDetails"}


def build_new_item(src, pictures, price, quantity, policies, sku):
    item = ET.Element(N + "Item")
    for tag in COPY_TAGS:
        e = src.find(N + tag)
        if e is None:
            continue
        e = deepcopy(e)
        if tag in ("PrimaryCategory", "SecondaryCategory"):
            cid = e.findtext(N + "CategoryID")
            e = ET.Element(N + tag)
            _el(e, "CategoryID", cid)
        if tag == "ProductListingDetails":
            for ch in list(e):
                if ch.tag.replace(N, "") not in PLD_KEEP:
                    e.remove(ch)
            if not len(e):
                continue
        item.append(e)
    comp = src.find(N + "ItemCompatibilityList")
    if comp is not None and len(comp):
        newc = ET.SubElement(item, N + "ItemCompatibilityList")
        for c in comp.findall(N + "Compatibility"):
            nc = ET.SubElement(newc, N + "Compatibility")
            for nv in c.findall(N + "NameValueList"):
                if nv.findtext(N + "Name"):
                    nc.append(deepcopy(nv))
            note = c.findtext(N + "CompatibilityNotes")
            if note:
                _el(nc, "CompatibilityNotes", note)
    pd = ET.SubElement(item, N + "PictureDetails")
    for u in pictures:
        _el(pd, "PictureURL", u)
    _el(item, "ListingType", "FixedPriceItem")
    _el(item, "ListingDuration", "GTC")
    _el(item, "Site", "UK")
    _el(item, "StartPrice", f"{price:.2f}")
    _el(item, "Quantity", str(max(1, int(quantity))))
    if sku:
        _el(item, "SKU", sku)
    sp = ET.SubElement(item, N + "SellerProfiles")
    for tag, id_tag, key in (("SellerShippingProfile", "ShippingProfileID", "shipping"),
                             ("SellerReturnProfile", "ReturnProfileID", "return"),
                             ("SellerPaymentProfile", "PaymentProfileID", "payment")):
        if policies.get(key):
            _el(ET.SubElement(sp, N + tag), id_tag, policies[key])
    return item


def copy_one(src_token, dst_token, item_id, price_rule, policies, verify_only):
    src = get_item(src_token, item_id)
    if src is None:
        raise EbayError("Couldn't read the source listing.")
    sku = src.findtext(N + "SKU")
    title = src.findtext(N + "Title") or ""
    cur = float(src.findtext(f"{N}StartPrice") or src.findtext(f"{N}SellingStatus/{N}CurrentPrice") or 0)
    qty = int(src.findtext(N + "Quantity") or 1) - int(src.findtext(f"{N}SellingStatus/{N}QuantitySold") or 0)
    price = apply_price(cur, price_rule)
    urls = [u.text for u in src.findall(f"{N}PictureDetails/{N}PictureURL") if u.text]
    if verify_only:
        pics = urls[:1]  # checking doesn't need every photo re-hosted
    else:
        pics = [upload_picture(dst_token, _big(u), f"{sku or item_id}-{i+1}") for i, u in enumerate(urls[:24])]
    new = build_new_item(src, pics, price, qty, policies, sku)
    call = "VerifyAddFixedPriceItem" if verify_only else "AddFixedPriceItem"
    root = ET.Element(N + call + "Request")
    root.append(new)
    r = trading(call, dst_token, root_el=root)
    comp_n = len(src.findall(f"{N}ItemCompatibilityList/{N}Compatibility"))
    return {"new_item_id": r.findtext(N + "ItemID"), "sku": sku, "title": title, "price": price, "photos": len(urls),
            "fitment_rows": comp_n, "warnings": json.loads(r.get("pl_warnings", "[]"))}


def apply_price(cur, rule):
    kind, val = (rule or {}).get("kind", "same"), float((rule or {}).get("value") or 0)
    if kind == "pct":
        p = cur * (1 + val / 100)
    elif kind == "add":
        p = cur + val
    else:
        p = cur
    return round(max(p, 0.99), 2)


# ------------------------------------------------------------------ jobs (run in a background thread)
_lock = threading.Lock()


def run_job(db_factory, job_id):
    with _lock:
        with db_factory() as con:
            job = dict(con.execute("SELECT * FROM ebay_jobs WHERE id=?", (job_id,)).fetchone())
            s = json.loads(job["settings"])
            con.execute("UPDATE ebay_jobs SET status='running' WHERE id=?", (job_id,))
            items = [dict(r) for r in con.execute("SELECT * FROM ebay_job_items WHERE job_id=? AND status='waiting' ORDER BY id", (job_id,))]
        for it in items:
            try:
                with db_factory() as con:
                    st, dt = access_token(con, job["source_id"]), access_token(con, job["target_id"])
                res = copy_one(st, dt, it["item_id"], s.get("price"), s.get("policies", {}), job["mode"] == "verify")
                msg = (f"Checked: would list at £{res['price']:.2f} with {res['photos']} photos and {res['fitment_rows']} fitment rows"
                       if job["mode"] == "verify" else
                       f"Listed at £{res['price']:.2f} with {res['photos']} photos and {res['fitment_rows']} fitment rows")
                if res["warnings"]:
                    msg += ". eBay notes: " + " | ".join(res["warnings"][:3])
                with db_factory() as con:
                    con.execute("UPDATE ebay_job_items SET status='ok', new_item_id=?, price=?, message=? WHERE id=?",
                                (res["new_item_id"], res["price"], msg, it["id"]))
                    con.execute("UPDATE ebay_jobs SET done=done+1, ok=ok+1 WHERE id=?", (job_id,))
                    if job["mode"] == "copy" and res["new_item_id"]:
                        con.execute("""INSERT OR REPLACE INTO listings(account_id,item_id,sku,title,price,qty,category,sold,updated_at)
                                       VALUES(?,?,?,?,?,?,?,0,date('now'))""",
                                    (job["target_id"], res["new_item_id"], res["sku"], res["title"], res["price"], None, None))
            except Exception as e:
                with db_factory() as con:
                    con.execute("UPDATE ebay_job_items SET status='failed', message=? WHERE id=?", (str(e)[:900], it["id"]))
                    con.execute("UPDATE ebay_jobs SET done=done+1, failed=failed+1 WHERE id=?", (job_id,))
            time.sleep(0.5)
        with db_factory() as con:
            con.execute("UPDATE ebay_jobs SET status='finished' WHERE id=?", (job_id,))


def deletion_challenge(code):
    c = cfg()
    endpoint = c["PUBLIC_URL"].rstrip("/") + "/ebay/account-deletion"
    return hashlib.sha256((code + c["EBAY_VERIFICATION_TOKEN"] + endpoint).encode()).hexdigest()


# ------------------------------------------------------------------ Promoted Listings (Marketing API)
MKT = "https://api.ebay.com/sell/marketing/v1"
CAMPAIGN_NAME = "Partsledger General"

SCHEMA += """
CREATE TABLE IF NOT EXISTS ad_rates(
  account_id INTEGER NOT NULL, item_id TEXT NOT NULL, rate REAL NOT NULL, sku TEXT, title TEXT,
  status TEXT DEFAULT 'pending', message TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(account_id, item_id));
"""


def _rest(method, url, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    st, raw = _http(url, data, {"Authorization": "Bearer " + token, "Content-Type": "application/json",
                                "Accept": "application/json", "Content-Language": "en-GB"}, method)
    try:
        j = json.loads(raw) if raw else {}
    except ValueError:
        j = {}
    return st, j


def _err(j, fallback):
    es = j.get("errors") or []
    return "; ".join(e.get("longMessage") or e.get("message") or str(e.get("errorId")) for e in es) or fallback


def find_or_create_campaign(token):
    st, j = _rest("GET", MKT + "/ad_campaign?" + urllib.parse.urlencode({"campaign_name": CAMPAIGN_NAME}), token)
    for c in (j.get("campaigns") or []):
        if c.get("campaignName") == CAMPAIGN_NAME and c.get("campaignStatus") not in ("ENDED", "DELETED"):
            return c["campaignId"]
    start = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 60))
    body = {"campaignName": CAMPAIGN_NAME, "marketplaceId": "EBAY_GB", "startDate": start,
            "fundingStrategy": {"fundingModel": "COST_PER_SALE", "bidPercentage": "5.0"}}
    st, j = _rest("POST", MKT + "/ad_campaign", token, body)
    if st not in (200, 201):
        raise EbayError("Couldn't create the Promoted Listings campaign: " + _err(j, str(st)))
    st, j = _rest("GET", MKT + "/ad_campaign?" + urllib.parse.urlencode({"campaign_name": CAMPAIGN_NAME}), token)
    for c in (j.get("campaigns") or []):
        if c.get("campaignName") == CAMPAIGN_NAME:
            return c["campaignId"]
    raise EbayError("The campaign was created but couldn't be found again. Try once more.")


def apply_ad_rates(token, rows):
    """rows: [(item_id, rate)]. Adds each listing to the campaign, or updates its rate if it's already there.
    Returns {item_id: (ok, message)}."""
    cid = find_or_create_campaign(token)
    out = {}
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        reqs = [{"listingId": it, "bidPercentage": f"{r:.1f}"} for it, r in chunk]
        st, j = _rest("POST", f"{MKT}/ad_campaign/{cid}/bulk_create_ads_by_listing_id", token, {"requests": reqs})
        if st >= 400 and not j.get("responses"):
            for it, _ in chunk:
                out[it] = (False, _err(j, f"eBay error {st}"))
            continue
        retry = []
        for resp in j.get("responses", []):
            it = str(resp.get("listingId"))
            if resp.get("statusCode") in (200, 201):
                out[it] = (True, "Promoted at {:.1f}%".format(dict(chunk)[it]))
            else:
                msg = _err(resp, "not added")
                if "already" in msg.lower() and "campaign" in msg.lower():
                    retry.append(it)
                out[it] = (False, msg)
        if retry:
            reqs = [{"listingId": it, "bidPercentage": f"{dict(chunk)[it]:.1f}"} for it in retry]
            st, j = _rest("POST", f"{MKT}/ad_campaign/{cid}/bulk_update_ads_bid_by_listing_id", token, {"requests": reqs})
            for resp in j.get("responses", []):
                it = str(resp.get("listingId"))
                if resp.get("statusCode") in (200, 201, 204):
                    out[it] = (True, "Rate updated to {:.1f}%".format(dict(chunk)[it]))
    return out


def run_ad_job(db_factory, account_id):
    with _lock:
        with db_factory() as con:
            rows = [(r["item_id"], r["rate"]) for r in con.execute(
                "SELECT item_id,rate FROM ad_rates WHERE account_id=? AND status IN ('pending','failed')", (account_id,))]
            con.execute("UPDATE ad_rates SET status='working', message=NULL WHERE account_id=? AND status IN ('pending','failed')", (account_id,))
        try:
            with db_factory() as con:
                tok = access_token(con, account_id)
            res = apply_ad_rates(tok, rows)
        except Exception as e:
            res = {it: (False, str(e)[:500]) for it, _ in rows}
        with db_factory() as con:
            for it, _ in rows:
                ok, msg = res.get(it, (False, "No answer from eBay for this listing"))
                con.execute("UPDATE ad_rates SET status=?, message=?, updated_at=CURRENT_TIMESTAMP WHERE account_id=? AND item_id=?",
                            ("done" if ok else "failed", msg, account_id, it))
