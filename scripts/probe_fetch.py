#!/usr/bin/env python3
"""Health-check the article fetch path — is it working, Cloudflare-blocked, or paywalled?

Cloudflare never tells us when it stops challenging our egress IP; the only way to
know is to ask. This probes each still-empty story for a day ONCE through the same
Supabase proxy the cloud routine uses, and prints a plain verdict per story:

  RECOVERED   a real article came back  -> the next routine window will fill it
  BLOCKED     Cloudflare "Just a moment" challenge -> still flagged; wait, don't hammer
  PAYWALLED   the page came back but very short (TRD) -> refresh the session cookie
  SHORT       genuinely little text at the source -> it's a real blurb, leave as-is

One request per link — a probe, not the hammering that causes a flag in the first
place. Run it after a while to see whether the block has decayed.

Usage:  python3 scripts/probe_fetch.py [YYYY-MM-DD]   (default: today, ET)
"""
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co"
ANON_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"


def _get(path):
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/{path}",
        headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _words(html):
    return len(re.sub(r"<[^>]+>", " ", html or "").split())


def probe(url):
    """One proxy fetch. Returns (verdict, detail)."""
    pu = f"{SUPABASE_URL}/functions/v1/fetch-proxy?url=" + urllib.parse.quote(url, safe="")
    req = urllib.request.Request(pu, headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            d = json.load(r)
    except Exception as e:  # noqa: BLE001
        return "ERROR", str(e)[:60]
    html = d.get("html") or ""
    final = urllib.parse.urlparse(d.get("finalUrl") or "").netloc
    # count words inside <p> only — the article body, ignoring nav
    body_words = sum(_words(p) for p in re.findall(r"<p[^>]*>(.*?)</p>", html, re.S))
    if "just a moment" in html[:4000].lower():
        return "BLOCKED", "Cloudflare challenge (still flagged)"
    if d.get("status") != 200:
        return "BLOCKED", f"status {d.get('status')} (no redirect: {final})"
    if body_words >= 120:
        return "RECOVERED", f"{body_words}w -> {final}"
    return "SHORT/PAYWALLED", f"{body_words}w -> {final} (blurb, or refresh TRD cookie)"


def main():
    date = sys.argv[1] if len(sys.argv) > 1 else datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")
    rows = _get(f"days?date=eq.{date}&select=data")
    if not rows:
        print(f"No day found for {date}")
        return 1
    stories = rows[0]["data"].get("stories") or []
    stuck = [s for s in stories if s.get("sourceBlocked") or _words(s.get("content")) < 80]
    if not stuck:
        print(f"{date}: no stuck stories — everything has full content.")
        return 0
    print(f"{date}: probing {len(stuck)} still-empty stor{'y' if len(stuck)==1 else 'ies'} (one request each)\n")
    for s in stuck:
        verdict, detail = probe(s["url"])
        print(f"  {verdict:16} {s['id'][:34]:35} {detail}")
    print("\nBLOCKED = wait for the flag to decay · RECOVERED = fills next routine window")
    return 0


if __name__ == "__main__":
    sys.exit(main())
