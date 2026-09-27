import hashlib
import hmac
import os
import secrets

ITER = 240_000


def hash_pw(pw: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), ITER).hex()
    return f"pbkdf2${ITER}${salt}${h}"


def check_pw(pw: str, stored: str) -> bool:
    try:
        _, it, salt, h = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), int(it)).hex()
        return hmac.compare_digest(calc, h)
    except Exception:
        return False


def ensure_admin(con):
    """Create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD if there are no users yet."""
    if con.execute("SELECT 1 FROM users").fetchone():
        return
    email = os.environ.get("ADMIN_EMAIL")
    pw = os.environ.get("ADMIN_PASSWORD")
    if email and pw:
        con.execute("INSERT INTO users(email,name,pw_hash,is_admin) VALUES(?,?,?,1)",
                    (email.strip().lower(), os.environ.get("ADMIN_NAME", "Admin"), hash_pw(pw)))
