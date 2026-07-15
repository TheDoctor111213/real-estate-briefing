#!/usr/bin/env python3
"""Log into The Real Deal with YOUR credentials and store the session cookie
so the cloud pipeline can fetch subscriber articles.

Usage (run it yourself, locally):
  python3 scripts/trd_session.py you@example.com
  → prompts for your password (hidden, never stored anywhere),
    logs in at therealdeal.com/wp-login.php,
    verifies the session, and saves ONLY the session cookies to the
    Supabase `secrets` table (row id "trd_session").

scripts/fetch_article.py automatically uses the stored cookie for any
therealdeal.com URL. WordPress "remember me" sessions last ~14 days —
re-run this when the pipeline's day notes say TRD fetches hit the paywall.
"""
import getpass
import http.cookiejar
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co"
ANON_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
LOGIN_URL = "https://therealdeal.com/wp-login.php"


def main() -> None:
    email = sys.argv[1] if len(sys.argv) > 1 else input("TRD account email: ").strip()
    password = getpass.getpass("TRD password (hidden, used once, never stored): ")

    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [("User-Agent", UA), ("Referer", LOGIN_URL)]

    # prime cookies (WP sets a test cookie on GET)
    opener.open(LOGIN_URL, timeout=30)

    form = urllib.parse.urlencode({
        "log": email,
        "pwd": password,
        "rememberme": "forever",
        "wp-submit": "Log In",
        "redirect_to": "https://therealdeal.com/",
        "testcookie": "1",
    }).encode()
    opener.open(LOGIN_URL, data=form, timeout=30)

    session_cookies = {c.name: c.value for c in jar if "wordpress" in c.name.lower() and "test" not in c.name.lower()}
    if not any("logged_in" in n for n in session_cookies):
        raise SystemExit("Login failed — no wordpress_logged_in cookie returned. Check email/password.")

    cookie_header = "; ".join(f"{n}={v}" for n, v in session_cookies.items())

    row = {
        "id": "trd_session",
        "data": {
            "cookie": cookie_header,
            "savedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "note": "WordPress session cookies only; password is never stored.",
        },
    }
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/secrets",
        data=json.dumps(row).encode(),
        headers={
            "apikey": ANON_KEY,
            "Authorization": f"Bearer {ANON_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        assert resp.status in (200, 201)

    print(f"Logged in as {email}; session cookie stored ({len(session_cookies)} cookies).")
    print("The pipeline will now fetch TRD subscriber articles automatically.")


if __name__ == "__main__":
    main()
