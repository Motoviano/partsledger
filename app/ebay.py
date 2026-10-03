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
    "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
]
# What accounts connected before traffic was added were granted. A refresh must ask for no more than
# the account agreed to, so older connections keep working until they're reconnected.
LEGACY_SCOPES = SCOPES[:6]
ANALYTICS_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly"

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
    try:
        st, body = _http(TOKEN_URL, urllib.parse.urlencode(form).encode(),
                         {"Content-Type": "application/x-www-form-urlencoded", "Authorization": _basic()}, "POST")
    except OSError as e:
        raise EbayError(f"Couldn't reach eBay to renew the login ({e}). Try again in a minute.")
    try:
        j = json.loads(body or b"{}")
    except ValueError:
        raise EbayError(f"eBay gave an unreadable answer when renewing the login ({st}). Try again in a minute.")
    if st != 200:
        raise EbayError(j.get("error_description") or j.get("error") or f"eBay login failed ({st}).")
    return j


def exchange_code(code):
    return _token_request({"grant_type": "authorization_code", "code": code, "redirect_uri": cfg()["EBAY_RUNAME"]})


def save_connection(con, account_id, tok, by):
    access, exp = tok["access_token"], time.time() + int(tok.get("expires_in", 7200)) - 120
    user = get_user_id(access)
    rexp = time.strftime("%Y-%m-%d", time.gmtime(time.time() + int(tok.get("refresh_token_expires_in", 0))))
    con.execute("""INSERT INTO ebay_tokens(account_id,ebay_user,refresh_token,refresh_expires,access_token,access_expires,connected_by,scopes)
                   VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET ebay_user=excluded.ebay_user,
                   refresh_token=excluded.refresh_token,refresh_expires=excluded.refresh_expires,access_token=excluded.access_token,
                   access_expires=excluded.access_expires,connected_by=excluded.connected_by,scopes=excluded.scopes,connected_at=CURRENT_TIMESTAMP""",
                (account_id, user, tok["refresh_token"], rexp, access, exp, by, " ".join(SCOPES)))
    return user


def migrate(con):
    """Add columns introduced after the first release."""
    def add(table, col, typ):
        if col not in {r[1] for r in con.execute(f"PRAGMA table_info({table})")}:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
    add("ebay_tokens", "scopes", "TEXT")
    add("sync_state", "last_traffic_sync", "TEXT")
    add("sync_state", "traffic_status", "TEXT")
    add("sync_state", "traffic_message", "TEXT")


def granted(row):
    return (row["scopes"] if row and row["scopes"] else " ".join(LEGACY_SCOPES)).split()


def has_scope(con, account_id, scope):
    r = con.execute("SELECT scopes FROM ebay_tokens WHERE account_id=?", (account_id,)).fetchone()
    return bool(r) and scope in granted(r)


def access_token(con, account_id):
    r = con.execute("SELECT * FROM ebay_tokens WHERE account_id=?", (account_id,)).fetchone()
    if not r:
        raise EbayError("This account isn't connected to eBay yet.")
    if r["access_token"] and (r["access_expires"] or 0) > time.time():
        return r["access_token"]
    j = _token_request({"grant_type": "refresh_token", "refresh_token": r["refresh_token"], "scope": " ".join(granted(r))})
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


def trading(call, token, build=None, root_el=None, image=None):
    c = cfg()
    root = root_el if root_el is not None else ET.Element(N + call + "Request")
    if build:
        build(root)
    _el(root, "ErrorLanguage", "en_GB")
    _el(root, "WarningLevel", "High")
    body = b'<?xml version="1.0" encoding="utf-8"?>' + ET.tostring(root)
    ctype = "text/xml"
    if image is not None:  # UploadSiteHostedPictures with the picture file attached
        bnd = "PL" + secrets.token_hex(12)
        body = (f'--{bnd}\r\nContent-Disposition: form-data; name="XML Payload"\r\nContent-Type: text/xml;charset=utf-8\r\n\r\n'.encode()
                + body + f'\r\n--{bnd}\r\nContent-Disposition: form-data; name="image"; filename="picture.jpg"\r\n'
                f'Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\n\r\n'.encode()
                + image + f'\r\n--{bnd}--\r\n'.encode())
        ctype = f"multipart/form-data; boundary={bnd}"
    st, raw = _http(TRADING_URL, body, {
        "X-EBAY-API-CALL-NAME": call, "X-EBAY-API-SITEID": c["EBAY_SITE_ID"],
        "X-EBAY-API-COMPATIBILITY-LEVEL": c["EBAY_COMPAT_LEVEL"], "X-EBAY-API-IAF-TOKEN": token,
        "Content-Type": ctype}, "POST", timeout=120)
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


def _photo_sources(url):
    """Download addresses for a listing photo, largest first. GetItem gives addresses like
    .../z/<id>/$_57.JPG?set_id=..., which eBay's picture service can't always re-read itself."""
    import re
    out = []
    m = re.search(r"/(?:z|g)/([A-Za-z0-9~_-]{10,})/", url)
    if m:
        out += [f"https://i.ebayimg.com/images/g/{m.group(1)}/s-l1600.jpg", f"https://i.ebayimg.com/images/g/{m.group(1)}/s-l1600.png"]
    out.append(re.sub(r"/s-l\d+\.(jpg|jpeg|png|webp)", r"/s-l1600.\1", url))
    out.append(url)
    return list(dict.fromkeys(out))


def _download_jpeg(url):
    """Fetch a photo and re-save it as a plain JPEG (eBay rejects WebP and some re-encoded files)."""
    import io
    from PIL import Image
    st, raw = _http(url, headers={"User-Agent": "Mozilla/5.0 Partsledger", "Accept": "image/jpeg,image/png;q=0.9,*/*;q=0.5"}, timeout=60)
    if st != 200 or not raw:
        return None
    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
    except Exception:
        return None
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    elif im.mode != "RGB":
        im = im.convert("RGB")
    if min(im.size) < 500:  # eBay wants at least 500px on the longest side; upscale small ones a little
        k = 500 / max(im.size)
        if k > 1:
            im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=92, optimize=True)
    return buf.getvalue()


def upload_picture(token, url, name):
    """Re-host a photo on the target account. Returns (new_url, note). Tries, in order:
    download + upload the file, let eBay fetch the address, then reuse the eBay-hosted address as it is."""
    def b(root, ext=None):
        if ext:
            _el(root, "ExternalPictureURL", ext)
        _el(root, "PictureName", name[:80])
        _el(root, "PictureSet", "Supersize")
    last = None
    for src in _photo_sources(url):
        data = _download_jpeg(src)
        if not data:
            continue
        try:
            r = trading("UploadSiteHostedPictures", token, b, image=data)
            return r.findtext(f"{N}SiteHostedPictureDetails/{N}FullURL"), None
        except EbayError as e:
            last = e
            break  # the file itself was refused; a smaller copy won't help
    try:
        r = trading("UploadSiteHostedPictures", token, lambda root: b(root, url))
        return r.findtext(f"{N}SiteHostedPictureDetails/{N}FullURL"), None
    except EbayError as e:
        last = e
    if "ebayimg.com" in url:
        return url, f"photo kept on its original eBay address ({last})"
    raise last or EbayError("Couldn't copy a photo.")


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
                t = ch.tag.replace(N, "")
                if t not in PLD_KEEP:
                    e.remove(ch)
                elif t == "BrandMPN":
                    # GetItem often returns BrandMPN with only one of Brand/MPN (or empty ones), which
                    # AddFixedPriceItem rejects (code 37). Keep it only when both are filled; the brand
                    # and part number are still copied in the item specifics.
                    b, m = (ch.findtext(N + "Brand") or "").strip(), (ch.findtext(N + "MPN") or "").strip()
                    if not b or not m:
                        e.remove(ch)
                    else:
                        for x in list(ch):
                            if x.tag.replace(N, "") not in ("Brand", "MPN"):
                                ch.remove(x)
                elif t in ("EAN", "UPC", "ISBN") and not (ch.text or "").strip():
                    e.remove(ch)
            if not any(c.tag.replace(N, "") in ("EAN", "UPC", "ISBN", "BrandMPN") for c in e):
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
    notes = []
    if verify_only:
        pics = urls[:1]  # checking doesn't need every photo re-hosted
    else:
        pics = []
        for i, u in enumerate(urls[:24]):
            p, note = upload_picture(dst_token, u, f"{sku or item_id}-{i+1}")
            pics.append(p)
            if note:
                notes.append(f"Photo {i+1}: {note}")
    new = build_new_item(src, pics, price, qty, policies, sku)
    call = "VerifyAddFixedPriceItem" if verify_only else "AddFixedPriceItem"
    root = ET.Element(N + call + "Request")
    root.append(new)
    r = trading(call, dst_token, root_el=root)
    comp_n = len(src.findall(f"{N}ItemCompatibilityList/{N}Compatibility"))
    return {"new_item_id": r.findtext(N + "ItemID"), "sku": sku, "title": title, "price": price, "photos": len(urls),
            "fitment_rows": comp_n, "warnings": notes + json.loads(r.get("pl_warnings", "[]"))}


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


# ------------------------------------------------------------------ Digital signatures (required by eBay for UK/EU sellers on the Finances API)
SCHEMA += """
CREATE TABLE IF NOT EXISTS ebay_signing_key(
  id INTEGER PRIMARY KEY CHECK (id=1), signing_key_id TEXT, private_key TEXT NOT NULL, jwe TEXT NOT NULL,
  expires REAL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
"""
KEY_URL = "https://apiz.ebay.com/developer/key_management/v1/signing_key"


def app_token():
    j = _token_request({"grant_type": "client_credentials", "scope": "https://api.ebay.com/oauth/api_scope"})
    return j["access_token"]


def _load_private_key(text):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    t = (text or "").strip()
    if "BEGIN" in t:
        return serialization.load_pem_private_key(t.encode(), password=None)
    raw = base64.b64decode(t + "=" * (-len(t) % 4))
    if len(raw) == 32:
        return Ed25519PrivateKey.from_private_bytes(raw)
    return serialization.load_der_private_key(raw, password=None)


def signing_key(con):
    """The app's signing key; created through eBay's Key Management API the first time it's needed."""
    r = con.execute("SELECT * FROM ebay_signing_key WHERE id=1").fetchone()
    if r and (r["expires"] or 0) > time.time() + 7 * 86400:
        return r["private_key"], r["jwe"]
    st, j = _rest("POST", KEY_URL, app_token(), {"signingKeyCipher": "ED25519"})
    if st not in (200, 201) or not j.get("privateKey") or not j.get("jwe"):
        raise EbayError("Couldn't create eBay's signing key: " + _err(j, str(st)))
    con.execute("INSERT OR REPLACE INTO ebay_signing_key(id,signing_key_id,private_key,jwe,expires) VALUES(1,?,?,?,?)",
                (j.get("signingKeyId"), j["privateKey"], j["jwe"], float(j.get("expirationTime") or time.time() + 3 * 365 * 86400)))
    con.commit()
    return j["privateKey"], j["jwe"]


def signature_headers(private_key, jwe, method, url, body=None):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ed25519, padding
    u = urllib.parse.urlsplit(url)
    created = int(time.time())
    comps, lines, h = [], [], {"x-ebay-signature-key": jwe}
    if body:
        digest = "sha-256=:" + base64.b64encode(hashlib.sha256(body).digest()).decode() + ":"
        h["Content-Digest"] = digest
        comps.append('"content-digest"')
        lines.append(f'"content-digest": {digest}')
    comps += ['"x-ebay-signature-key"', '"@method"', '"@path"', '"@authority"']
    lines += [f'"x-ebay-signature-key": {jwe}', f'"@method": {method.upper()}', f'"@path": {u.path}', f'"@authority": {u.netloc}']
    params = f'({" ".join(comps)});created={created}'
    lines.append(f'"@signature-params": {params}')
    base = "\n".join(lines).encode()
    key = _load_private_key(private_key)
    if isinstance(key, ed25519.Ed25519PrivateKey):
        sig = key.sign(base)
    else:
        sig = key.sign(base, padding.PKCS1v15(), hashes.SHA256())
    h["Signature-Input"] = f"sig1={params}"
    h["Signature"] = "sig1=:" + base64.b64encode(sig).decode() + ":"
    return h


# ------------------------------------------------------------------ Sync: orders, money movements, listings
FIN = "https://apiz.ebay.com/sell/finances/v1"
FUL = "https://api.ebay.com/sell/fulfillment/v1"

SCHEMA += """
CREATE TABLE IF NOT EXISTS sync_state(
  account_id INTEGER PRIMARY KEY, synced_from TEXT, last_tx_sync TEXT, last_listing_sync TEXT,
  last_status TEXT, last_message TEXT);
"""

FEE_NAMES = {"AD_FEE": "Promoted Listings - General fee", "INSERTION_FEE": "Insertion fee",
             "STORE_SUBSCRIPTION_FEE": "Shop subscription fee", "FINAL_VALUE_FEE": "Final value fee",
             "FINAL_VALUE_FEE_FIXED_PER_ORDER": "Final value fee", "REGULATORY_OPERATING_FEE": "Regulatory operating fee"}


def _get_json(url, token, marketplace=True, sign=None):
    h = {"Authorization": "Bearer " + token, "Accept": "application/json"}
    if marketplace:
        h["X-EBAY-C-MARKETPLACE-ID"] = "EBAY_GB"
    if sign:
        h.update(signature_headers(sign[0], sign[1], "GET", url))
    st, raw = _http(url, None, h, "GET", timeout=120)
    try:
        j = json.loads(raw or b"{}")
    except ValueError:
        j = {}
    if st >= 400:
        raise EbayError(_err(j, f"eBay returned {st} for {url.split('?')[0].rsplit('/', 1)[-1]}"))
    return j


def _iso(d, end=False):
    if end:
        # eBay rejects end times in the future, so end "today" at the current moment (minus a little slack)
        now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - 120))
        e = d + "T23:59:59.999Z"
        return min(e, now)
    return d + "T00:00:00.000Z"


def fetch_transactions(token, start, end, sign=None):
    out, offset = [], 0
    while True:
        q = urllib.parse.urlencode({"filter": f"transactionDate:[{_iso(start)}..{_iso(end, True)}]", "limit": 1000, "offset": offset})
        j = _get_json(f"{FIN}/transaction?{q}", token, sign=sign)
        rows = j.get("transactions") or []
        out += rows
        if len(rows) < 1000:
            return out
        offset += 1000


def fetch_orders(token, start, end):
    out, offset = [], 0
    while True:
        q = urllib.parse.urlencode({"filter": f"creationdate:[{_iso(start)}..]", "limit": 200, "offset": offset})
        j = _get_json(f"{FUL}/order?{q}", token, marketplace=False)
        rows = j.get("orders") or []
        out += rows
        if len(rows) < 200:
            return out
        offset += 200


def fetch_listings(token):
    out, page = [], 1
    while True:
        def b(root, page=page):
            al = _el(root, "ActiveList")
            _el(al, "Include", "true")
            pg = _el(al, "Pagination")
            _el(pg, "EntriesPerPage", "200")
            _el(pg, "PageNumber", str(page))
        r = trading("GetMyeBaySelling", token, b)
        al = r.find(N + "ActiveList")
        if al is None:
            return out
        for it in al.iter(N + "Item"):
            q = int(it.findtext(N + "Quantity") or 0)
            qa = it.findtext(N + "QuantityAvailable")
            qa = int(qa) if qa is not None else q - int(it.findtext(f"{N}SellingStatus/{N}QuantitySold") or 0)
            out.append({"item_id": it.findtext(N + "ItemID"), "sku": it.findtext(N + "SKU"), "title": it.findtext(N + "Title"),
                        "price": float(it.findtext(f"{N}SellingStatus/{N}CurrentPrice") or it.findtext(f"{N}BuyItNowPrice") or 0),
                        "qty": max(qa, 0), "category": None, "sold": int(it.findtext(f"{N}SellingStatus/{N}QuantitySold") or 0)})
        pages = int(al.findtext(f"{N}PaginationResult/{N}TotalNumberOfPages") or 1)
        if page >= pages:
            return out
        page += 1


def fetch_seller_list(token, days_ahead=119):
    """Every active fixed-price listing, found by end time. Unlike the My eBay active list this also returns
    listings kept alive at quantity 0 by out-of-stock control (GTC listings renew every 30 days)."""
    import datetime as _dt
    now = _dt.datetime.utcnow()
    out, page = [], 1
    while True:
        def b(root, page=page):
            _el(root, "EndTimeFrom", now.strftime("%Y-%m-%dT%H:%M:%S.000Z"))
            _el(root, "EndTimeTo", (now + _dt.timedelta(days=days_ahead)).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
            _el(root, "GranularityLevel", "Coarse")
            _el(root, "IncludeVariations", "false")
            pg = _el(root, "Pagination")
            _el(pg, "EntriesPerPage", "200")
            _el(pg, "PageNumber", str(page))
        r = trading("GetSellerList", token, b)
        for it in r.iter(N + "Item"):
            if (it.findtext(f"{N}SellingStatus/{N}ListingStatus") or "Active") != "Active":
                continue
            q = int(it.findtext(N + "Quantity") or 0)
            sold = int(it.findtext(f"{N}SellingStatus/{N}QuantitySold") or 0)
            out.append({"item_id": it.findtext(N + "ItemID"), "sku": it.findtext(N + "SKU"), "title": it.findtext(N + "Title"),
                        "price": float(it.findtext(f"{N}SellingStatus/{N}CurrentPrice") or it.findtext(f"{N}StartPrice") or 0),
                        "qty": max(q - sold, 0), "category": None, "sold": sold})
        pages = int(r.findtext(f"{N}PaginationResult/{N}TotalNumberOfPages") or 1)
        if page >= pages:
            return out
        page += 1


def _amt(o):
    try:
        return float((o or {}).get("value"))
    except (TypeError, ValueError):
        return None


def _signed(t):
    a = _amt(t.get("amount")) or 0.0
    return a if t.get("bookingEntry") == "CREDIT" else -a


def _ref(t, kind):
    for r in t.get("references") or []:
        if r.get("referenceType") == kind:
            return r.get("referenceId")
    return None


def to_rows(transactions, orders):
    """Map API data onto the same rows the Transaction report CSV produces."""
    lines = {}
    for o in orders:
        lines[o.get("orderId")] = o
    rows = []
    for t in transactions:
        tid, typ = t.get("transactionId"), t.get("transactionType")
        d = (t.get("transactionDate") or "")[:10]
        if not d or typ in ("TRANSFER", "WITHDRAWAL", "LOAN_REPAYMENT") or t.get("transactionStatus") == "FAILED":
            continue
        net = round(_signed(t), 2)
        oid = t.get("orderId") or _ref(t, "ORDER_ID")
        base = {"date": d, "order_no": oid, "item_id": None, "title": None, "sku": None, "qty": None,
                "item_subtotal": None, "postage": None, "gross": None, "net": net, "description": None}
        if typ == "SALE":
            gross = _amt(t.get("totalFeeBasisAmount"))
            if gross is None:
                gross = net + (_amt(t.get("totalFeeAmount")) or 0)
            rows.append({**base, "type": "Order", "gross": round(gross, 2), "_key": ["api", tid, "h"]})
            o = lines.get(oid) or {}
            for i, li in enumerate(o.get("lineItems") or []):
                rows.append({**base, "type": "Order", "net": None, "item_id": li.get("legacyItemId"), "sku": li.get("sku"),
                             "title": li.get("title"), "qty": float(li.get("quantity") or 1),
                             "item_subtotal": _amt(li.get("lineItemCost")),
                             "postage": _amt((li.get("deliveryCost") or {}).get("shippingCost")) or 0.0,
                             "_key": ["api", tid, "li", i]})
        elif typ == "REFUND":
            gross = _amt(t.get("totalFeeBasisAmount"))
            rows.append({**base, "type": "Refund", "gross": -abs(gross) if gross else net, "_key": ["api", tid]})
        elif typ == "SHIPPING_LABEL":
            rows.append({**base, "type": "Postage label", "description": t.get("transactionMemo") or "Postage label", "_key": ["api", tid]})
        elif typ == "DISPUTE":
            rows.append({**base, "type": "Claim", "_key": ["api", tid]})
        elif typ == "NON_SALE_CHARGE":
            ft = t.get("feeType") or ""
            rows.append({**base, "type": "Other fee", "item_id": _ref(t, "ITEM_ID"),
                         "description": FEE_NAMES.get(ft, ft.replace("_", " ").capitalize() or "eBay fee"), "_key": ["api", tid]})
        else:  # CREDIT, ADJUSTMENT
            rows.append({**base, "type": "Adjustment", "description": typ.capitalize(), "_key": ["api", tid]})
    return rows


def sync_account(db_factory, account_id, days_back=3, listings=True):
    """Pull recent money movements + orders (and listings) for one account."""
    import datetime as _dt
    from . import importers as IM
    today = _dt.date.today()
    with db_factory() as con:
        st = con.execute("SELECT * FROM sync_state WHERE account_id=?", (account_id,)).fetchone()
        if st and st["synced_from"]:
            start_floor = st["synced_from"]
        else:
            # Start the day after the newest uploaded Transaction report, so nothing is counted twice
            last_csv = con.execute("SELECT MAX(date) FROM transactions WHERE account_id=? AND row_key NOT LIKE 'api%'", (account_id,)).fetchone()[0]
            start_floor = (_dt.date.fromisoformat(last_csv) + _dt.timedelta(days=1)).isoformat() if last_csv else (today - _dt.timedelta(days=90)).isoformat()
            con.execute("INSERT OR REPLACE INTO sync_state(account_id,synced_from) VALUES(?,?)", (account_id, start_floor))
        tok = access_token(con, account_id)
        sign = signing_key(con)
    start = max(start_floor, (today - _dt.timedelta(days=days_back)).isoformat())
    if st is None or not st["last_tx_sync"] or st["last_status"] != "ok":
        start = start_floor  # first run, or after a failed run: catch up everything since the last upload
    end = today.isoformat()
    added = skipped = 0
    msg = []
    if start <= end:
        tx = fetch_transactions(tok, start, end, sign)
        order_ids = {t.get("orderId") for t in tx if t.get("transactionType") == "SALE"}
        orders = fetch_orders(tok, (_dt.date.fromisoformat(start) - _dt.timedelta(days=30)).isoformat(), end) if order_ids else []
        rows = to_rows(tx, orders)
        with db_factory() as con:
            # stable keys: "api|<transactionId>|..." so re-syncing the same days never double counts
            for r in rows:
                r["_row_key"] = "api:" + ":".join(str(x) for x in r["_key"][1:])
            for r in rows:
                cur = con.execute(
                    """INSERT OR IGNORE INTO transactions(account_id,row_key,date,type,order_no,item_id,title,sku,qty,item_subtotal,postage,gross,net,description,upload_id)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
                    (account_id, r["_row_key"], r["date"], r["type"], r["order_no"], r["item_id"], r["title"], r["sku"], r["qty"],
                     r["item_subtotal"], r["postage"], r["gross"], r["net"], r["description"]))
                added += cur.rowcount
            skipped = len(rows) - added
        msg.append(f"{added} new rows from {len(tx)} eBay transactions and {len(orders)} orders ({start} to {end})")
    if listings:
        ls = fetch_listings(tok)
        try:  # add listings the My eBay list leaves out, e.g. sold out but kept live by out-of-stock control
            seen = {l["item_id"] for l in ls}
            extra = [l for l in fetch_seller_list(tok) if l["item_id"] not in seen]
            ls += extra
            if extra:
                msg.append(f"{len(extra)} more found by end date (incl. sold out)")
        except EbayError:
            pass
        with db_factory() as con:
            IM.store_listings(con, account_id, ls)
            con.execute("UPDATE sync_state SET last_listing_sync=datetime('now') WHERE account_id=?", (account_id,))
        msg.append(f"{len(ls)} active listings")
    with db_factory() as con:
        con.execute("UPDATE sync_state SET last_tx_sync=datetime('now'), last_status='ok', last_message=? WHERE account_id=?",
                    ("; ".join(msg), account_id))
    return "; ".join(msg)


# ------------------------------------------------------------------ Traffic per listing (Analytics API)
ANA = "https://api.ebay.com/sell/analytics/v1/traffic_report"
TRAFFIC_METRICS = ["LISTING_IMPRESSION_TOTAL", "LISTING_IMPRESSION_SEARCH_RESULTS_PAGE", "LISTING_VIEWS_TOTAL",
                   "LISTING_VIEWS_SOURCE_SEARCH_RESULTS_PAGE", "TRANSACTION"]
TRAFFIC_COLS = ["impressions", "search_impressions", "views", "search_views", "transactions"]
TRAFFIC_BACKFILL_DAYS = 30
TRAFFIC_REFRESH_DAYS = 3  # eBay finalises traffic a day or two late, so the newest days are fetched again

SCHEMA += """
CREATE TABLE IF NOT EXISTS traffic(
  account_id INTEGER NOT NULL, item_id TEXT NOT NULL, date TEXT NOT NULL,
  impressions INTEGER, search_impressions INTEGER, views INTEGER, search_views INTEGER, transactions INTEGER,
  PRIMARY KEY(account_id, item_id, date));
CREATE INDEX IF NOT EXISTS traffic_date ON traffic(account_id, date);
CREATE TABLE IF NOT EXISTS traffic_days(
  account_id INTEGER NOT NULL, date TEXT NOT NULL, listings INTEGER, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(account_id, date));
"""


def _num(v):
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return 0


def fetch_traffic_day(token, day, item_ids, sign=None):
    """Traffic for one day (YYYY-MM-DD) for up to 200 listings: {item_id: [impressions, search impr, views, search views, sold]}."""
    d = day.replace("-", "")
    flt = f"marketplace_ids:{{EBAY_GB}},date_range:[{d}..{d}],listing_ids:{{{'|'.join(item_ids)}}}"
    url = (f"{ANA}?dimension=LISTING&metric={','.join(TRAFFIC_METRICS)}&filter="
           + urllib.parse.quote(flt, safe=",:."))
    try:
        j = _get_json(url, token, marketplace=False)
    except EbayError as e:
        if sign and "signature" in str(e).lower():
            j = _get_json(url, token, marketplace=False, sign=sign)
        else:
            raise
    keys = [m.get("key") for m in (j.get("header") or {}).get("metrics") or []] or TRAFFIC_METRICS
    out = {}
    for rec in j.get("records") or []:
        dv = rec.get("dimensionValues") or []
        if not dv:
            continue
        lid = str(dv[0].get("value"))
        vals = {k: _num((mv or {}).get("value")) for k, mv in zip(keys, rec.get("metricValues") or [])}
        out[lid] = [vals.get(k, 0) for k in TRAFFIC_METRICS]
    return out


def active_listing_ids(con, account_id):
    """Listings seen in the newest listings sync or upload for the account (older rows have ended)."""
    newest = con.execute("SELECT MAX(updated_at) FROM listings WHERE account_id=?", (account_id,)).fetchone()[0]
    if not newest:
        return []
    return [r[0] for r in con.execute("SELECT item_id FROM listings WHERE account_id=? AND updated_at>=date(?, '-1 day')",
                                      (account_id, newest))]


def sync_traffic(db_factory, account_id, max_calls=400):
    import datetime as _dt
    today = _dt.date.today()
    yday = today - _dt.timedelta(days=1)
    with db_factory() as con:
        if not has_scope(con, account_id, ANALYTICS_SCOPE):
            con.execute("UPDATE sync_state SET traffic_status='reconnect', traffic_message=? WHERE account_id=?",
                        ("Reconnect this account to allow traffic data", account_id))
            return "traffic needs a reconnect"
        tok = access_token(con, account_id)
        sign = signing_key(con)
        ids = active_listing_ids(con, account_id)
        have = {r[0] for r in con.execute("SELECT date FROM traffic_days WHERE account_id=?", (account_id,))}
    if not ids:
        return "no active listings to check traffic for"
    refresh_from = (yday - _dt.timedelta(days=TRAFFIC_REFRESH_DAYS - 1)).isoformat()
    days = [(yday - _dt.timedelta(days=i)).isoformat() for i in range(TRAFFIC_BACKFILL_DAYS)]
    days = [d for d in days if d not in have or d >= refresh_from]  # newest first, so a cut-short run still gets recent days
    batches = [ids[i:i + 200] for i in range(0, len(ids), 200)]
    calls = done = 0
    note = ""
    for day in days:
        if calls + len(batches) > max_calls:
            note = " (more days next sync)"
            break
        got = {}
        try:
            for b in batches:
                got.update(fetch_traffic_day(tok, day, b, sign))
                calls += 1
        except EbayError as e:
            msg = str(e)
            if "date" in msg.lower() and day >= refresh_from:
                continue  # eBay hasn't published this day yet
            with db_factory() as con:
                con.execute("UPDATE sync_state SET last_traffic_sync=datetime('now'), traffic_status='error', traffic_message=? WHERE account_id=?",
                            (f"Traffic stopped at {day}: {msg}"[:500], account_id))
            return f"traffic error: {msg[:150]}"
        with db_factory() as con:
            con.execute("DELETE FROM traffic WHERE account_id=? AND date=?", (account_id, day))
            con.executemany("INSERT INTO traffic(account_id,item_id,date,impressions,search_impressions,views,search_views,transactions) VALUES(?,?,?,?,?,?,?,?)",
                            [(account_id, k, day, *v) for k, v in got.items() if any(v)])
            con.execute("INSERT OR REPLACE INTO traffic_days(account_id,date,listings) VALUES(?,?,?)", (account_id, day, len(ids)))
        done += 1
    msg = f"{len(ids)} listings, {done} days updated{note}"
    with db_factory() as con:
        con.execute("UPDATE sync_state SET last_traffic_sync=datetime('now'), traffic_status='ok', traffic_message=? WHERE account_id=?",
                    (msg, account_id))
    return msg


def sync_all(db_factory, listings=True):
    with db_factory() as con:
        ids = [r["account_id"] for r in con.execute("SELECT account_id FROM ebay_tokens")]
    res = {}
    for a in ids:
        try:
            res[a] = sync_account(db_factory, a, listings=listings)
        except Exception as e:
            with db_factory() as con:
                con.execute("INSERT INTO sync_state(account_id,last_status,last_message) VALUES(?, 'error', ?) "
                            "ON CONFLICT(account_id) DO UPDATE SET last_status='error', last_message=excluded.last_message, last_tx_sync=datetime('now')",
                            (a, str(e)[:500]))
            res[a] = "error: " + str(e)[:200]
            continue
        # Traffic: with each listings sync (every 6 hours / Sync now), or straight away if never fetched
        with db_factory() as con:
            st = con.execute("SELECT last_traffic_sync FROM sync_state WHERE account_id=?", (a,)).fetchone()
        if listings or not (st and st["last_traffic_sync"]):
            try:
                res[a] += "; " + sync_traffic(db_factory, a)
            except Exception as e:
                with db_factory() as con:
                    con.execute("UPDATE sync_state SET last_traffic_sync=datetime('now'), traffic_status='error', traffic_message=? WHERE account_id=?",
                                (str(e)[:500], a))
    return res


_sync_lock = threading.Lock()


def start_scheduler(db_factory, every_minutes=60):
    def loop():
        n = 0
        time.sleep(30)
        while True:
            if configured() and _sync_lock.acquire(blocking=False):
                try:
                    sync_all(db_factory, listings=(n % 6 == 0))  # listings every 6 hours
                except Exception:
                    pass
                finally:
                    _sync_lock.release()
            n += 1
            time.sleep(every_minutes * 60)
    threading.Thread(target=loop, daemon=True).start()
