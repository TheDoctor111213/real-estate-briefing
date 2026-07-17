#!/usr/bin/env python3
"""Store a The Real Deal subscriber session so the cloud pipeline can fetch
subscriber articles.

TRD's reader site is a Next.js app with its own login/subscription system —
it is NOT WordPress auth, so a scripted email+password login does not work
(wp-login.php doesn't know your reader account). The reliable way is to copy
the session cookies from a browser where you're already signed in (via Google
or password, either is fine).

HOW TO RUN IT (yourself, locally):

  python3 scripts/trd_session.py --cookie [optional-article-url]

  Then paste your therealdeal.com cookie string. To get it:
    1. Sign in at therealdeal.com in your browser.
    2. Open DevTools (Cmd+Opt+I) → Network tab → reload the page.
    3. Click the top document request → Headers → Request Headers →
       copy the entire value of the "cookie:" line.
    (Copying the whole cookie header is the robust move — it captures whatever
     cookie TRD uses to gate articles, without guessing names.)

  If you pass an article URL, the script test-fetches it with your cookies and
  reports the word count so you can confirm it beat the paywall before saving.

The cookies land in the Supabase `secrets` table (row "trd_session") and
scripts/fetch_article.py uses them automatically for any therealdeal.com URL.
Sessions expire after a couple of weeks — re-run this when the pipeline's day
notes say TRD fetches hit the paywall.

(Legacy: `python3 scripts/trd_session.py you@example.com` still attempts a
WordPress login for the rare account that has one, but --cookie is preferred.)
"""
import getpass
import http.cookiejar
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co"
ANON_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
LOGIN_URL = "https://therealdeal.com/wp-login.php"


def _article_words(url: str, cookie_header: str) -> int:
    """Fetch an article with the cookie and count visible words (rough paywall test)."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Cookie": cookie_header, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=30) as r:
        html = r.read().decode("utf-8", errors="replace")
    # count words inside <p> tags only — the article body
    paras = re.findall(r"<p[^>]*>(.*?)</p>", html, re.S)
    text = re.sub(r"<[^>]+>", " ", " ".join(paras))
    return len(text.split())


def _domain() -> str:
    """--domain <site> stores a session for any outlet (default therealdeal.com).
    e.g.  python3 scripts/trd_session.py --cookie --domain bisnow.com"""
    args = sys.argv[1:]
    if "--domain" in args:
        d = args[args.index("--domain") + 1].lower().removeprefix("www.")
        return d
    return "therealdeal.com"


def store(cookie_header: str, how: str) -> None:
    domain = _domain()
    # legacy row name for TRD (the pipeline reads both); session_<domain> for the rest
    row_id = "trd_session" if domain == "therealdeal.com" else f"session_{domain}"
    row = {
        "id": row_id,
        "data": {
            "cookie": cookie_header,
            "domain": domain,
            "savedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "via": how,
            "note": "Browser session cookies only; no password is ever stored.",
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
    print(f"Session cookie stored. The pipeline will now use it for {domain} articles.")


def run_cookie_mode() -> None:
    test_url = None
    for arg in sys.argv[1:]:
        if arg.startswith("http"):
            test_url = arg
    print("Paste your therealdeal.com cookie string (the whole 'cookie:' request header):")
    cookie = input("> ").strip().strip('"').strip("'")
    if cookie.lower().startswith("cookie:"):
        cookie = cookie[len("cookie:"):].strip()
    if not cookie or "=" not in cookie:
        raise SystemExit("That doesn't look like a cookie string.")

    if test_url:
        try:
            n = _article_words(test_url, cookie)
            print(f"Test fetch of {test_url}: {n} words in the article body.")
            if n < 150:
                print("WARN that's short — the cookie may not be unlocking full articles. "
                      "Double-check you copied the whole cookie header while signed in.")
        except Exception as e:  # noqa: BLE001
            print(f"WARN test fetch failed ({e}); storing the cookie anyway.")
    else:
        print("Tip: re-run with a subscriber article URL to verify, e.g.\n"
              "  python3 scripts/trd_session.py --cookie https://therealdeal.com/new-york/2026/07/15/<slug>/")
    store(cookie, "pasted-cookie")


def run_login_mode() -> None:
    email = sys.argv[1]
    password = getpass.getpass("TRD password (hidden, used once, never stored): ")
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [("User-Agent", UA), ("Referer", LOGIN_URL)]
    opener.open(LOGIN_URL, timeout=30)  # prime test cookie
    form = urllib.parse.urlencode({
        "log": email, "pwd": password, "rememberme": "forever",
        "wp-submit": "Log In", "redirect_to": "https://therealdeal.com/", "testcookie": "1",
    }).encode()
    opener.open(LOGIN_URL, data=form, timeout=30)
    session_cookies = {c.name: c.value for c in jar if "wordpress" in c.name.lower() and "test" not in c.name.lower()}
    if not any("logged_in" in n for n in session_cookies):
        raise SystemExit(
            "WordPress login failed (TRD's reader accounts usually aren't WordPress users).\n"
            "Use the cookie method instead:\n"
            "  python3 scripts/trd_session.py --cookie\n"
            "and paste the cookie header from your signed-in browser (see the header of this file)."
        )
    cookie_header = "; ".join(f"{n}={v}" for n, v in session_cookies.items())
    print(f"Logged in as {email} ({len(session_cookies)} session cookies).")
    store(cookie_header, "wp-login")


def main() -> None:
    if "--cookie" in sys.argv:
        run_cookie_mode()
    elif len(sys.argv) > 1 and "@" in sys.argv[1]:
        run_login_mode()
    else:
        print(__doc__)
        sys.exit(0)


if __name__ == "__main__":
    main()
