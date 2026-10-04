"""How many eBay API calls are used and left today (eBay's Developer Analytics API).

- For the app (one set of developer keys, shared by every connected account): getRateLimits, application token.
- For each connected account: getUserRateLimits, that account's token.
Read when the eBay page asks, kept for 10 minutes.
"""
import json
import time

from . import ebay as EB
from . import db as DB

BASE = "https://api.ebay.com/developer/analytics/v1_beta"
_cache = {"at": 0, "data": None}


def _rows(j):
    out = []
    for rl in j.get("rateLimits") or []:
        for res in rl.get("resources") or []:
            for r in res.get("rates") or []:
                lim, used, left = r.get("limit"), r.get("count"), r.get("remaining")
                out.append({"api": rl.get("apiName"), "context": rl.get("apiContext"), "version": rl.get("apiVersion"),
                            "resource": res.get("name"), "used": used, "limit": lim, "left": left, "reset": r.get("reset"),
                            "window": r.get("timeWindow")})
    return out


def read(force=False):
    if not force and _cache["data"] and time.time() - _cache["at"] < 600:
        return _cache["data"]
    from . import compete as CP  # the cached application token
    data = {"app": [], "app_error": None, "accounts": [], "at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())}
    try:
        data["app"] = _rows(EB._get_json(f"{BASE}/rate_limit/", CP._app_token(), marketplace=False))
    except Exception as e:
        DB.log_exc("ratelimits.app", level="warn")
        data["app_error"] = str(e)[:300]
    with DB.db() as con:
        accts = [(r["account_id"], r["name"]) for r in con.execute(
            "SELECT t.account_id, a.name FROM ebay_tokens t JOIN accounts a ON a.id=t.account_id ORDER BY a.sort, a.id")]
    for a, name in accts:
        row = {"account_id": a, "name": name, "rows": [], "error": None}
        try:
            with DB.db() as con:
                tok = EB.access_token(con, a)
            row["rows"] = _rows(EB._get_json(f"{BASE}/user_rate_limit/", tok, marketplace=False))
        except Exception as e:
            row["error"] = str(e)[:300]
        data["accounts"].append(row)
    _cache.update(at=time.time(), data=data)
    return data
