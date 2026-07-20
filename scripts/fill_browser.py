#!/usr/bin/env python3
"""Fill missing story content using a REAL headless browser (Playwright).

This is the backbone content-filler, run every 30 minutes by the GitHub Actions
workflow (.github/workflows/fill-content.yml) on GitHub's runners — machines
with unrestricted egress, independent of both the owner's hardware and the
cloud routine's sandbox (whose egress is blocked). A real browser also executes
JavaScript, so it passes the Cloudflare "Just a moment…" challenges that block
plain HTTP fetches, and it follows email tracking-link redirects (beehiiv,
Mailchimp) to the real publisher page — which lets us store the canonical URL
and credit the true source.

Idempotent and self-healing: only stories still missing content are attempted;
anything that fails is retried on the next scheduled run.

Usage:
  python3 scripts/fill_browser.py                # today (America/New_York)
  python3 scripts/fill_browser.py 2026-07-17     # a specific day
  python3 scripts/fill_browser.py --no-push      # fill local file only

Requires:  pip install playwright && playwright install chromium
"""
import json
import pathlib
import sys
import time
import urllib.parse
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import fetch_article  # extract_from_html + _session_cookie
import fill_content   # day load/push, MIN_WORDS, wrapper helpers

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
CHALLENGE_WAIT_S = 25   # max time to let Cloudflare's JS challenge resolve
SETTLE_MS = 1500        # extra settle after load for late-rendering pages


def _registrable(host: str) -> str:
    h = host.lower().removeprefix("www.")
    parts = h.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else h


def _cookies_for(url: str):
    """Parse a stored 'a=b; c=d' session header into Playwright cookies."""
    header = fetch_article._session_cookie(url)
    if not header:
        return []
    domain = "." + _registrable(urllib.parse.urlparse(url).netloc)
    out = []
    for part in header.split(";"):
        part = part.strip()
        if "=" not in part:
            continue
        name, _, value = part.partition("=")
        if name.strip():
            out.append({"name": name.strip(), "value": value.strip(),
                        "domain": domain, "path": "/"})
    return out


def fetch_with_browser(page, url: str) -> tuple[str, str]:
    """Navigate a real browser to the URL, wait out any JS challenge, and
    return (rendered_html, final_url_after_redirects)."""
    page.goto(url, wait_until="domcontentloaded", timeout=45000)
    deadline = time.time() + CHALLENGE_WAIT_S
    while time.time() < deadline:
        title = (page.title() or "").lower()
        if "just a moment" not in title and "attention required" not in title:
            break
        page.wait_for_timeout(1000)
    page.wait_for_timeout(SETTLE_MS)
    return page.content(), page.url


# How many trailing days (besides today) a no-date run also sweeps for
# stragglers. Older days rolled off "today" would otherwise never get another
# real-browser attempt; this backfills any that were missed (a Cloudflare wall
# that later clears, a wrapper the browser can now follow, a late-arriving edit).
BACKFILL_DAYS = 4


def _recent_dates(today: str) -> list[str]:
    from datetime import date as _d, timedelta
    y, m, dd = map(int, today.split("-"))
    base = _d(y, m, dd)
    return [(base - timedelta(days=i)).isoformat() for i in range(BACKFILL_DAYS + 1)]


def _fill_one_day(page, ctx, cookied: set, date: str, no_push: bool) -> tuple[int, int]:
    """Fill every straggler in one day with the shared browser. Returns
    (filled, failed). A day with nothing missing is a fast no-op (no fetches)."""
    day, path = fill_content._load_local(date)
    source = "local file"
    if day is None:
        day = fill_content._load_supabase(date)
        source = "Supabase"
    if day is None:
        return 0, 0

    stories = day.get("stories") or []
    targets = [s for s in stories
               if fill_content._words(s.get("content")) < fill_content.MIN_WORDS
               and s.get("url")]
    if not targets:
        return 0, 0
    print(f"{date} ({source}): {len(stories)} stories, {len(targets)} need content")

    filled, failed, changed_urls = [], [], 0
    for s in targets:
        sid = s.get("id")
        try:
            dom = _registrable(urllib.parse.urlparse(s["url"]).netloc)
            if dom not in cookied:
                cookies = _cookies_for(s["url"])
                if cookies:
                    ctx.add_cookies(cookies)
                cookied.add(dom)
            html, final = fetch_with_browser(page, s["url"])
            res = fetch_article.extract_from_html(html, s["url"], final)
            # canonical URL: a tracking wrapper that resolved to a real page
            if final and fill_content._is_wrapper(s["url"]) and not fill_content._is_wrapper(final):
                s["url"] = fill_content._clean_url(final)
                changed_urls += 1
            if res.get("ok") and res["words"] > fill_content._words(s.get("content")) \
                    and not fetch_article.title_mismatch(s.get("title", ""), res):
                s["content"] = res["html"]
                if not s.get("image") and res.get("image"):
                    s["image"] = res["image"]
                s.pop("sourceBlocked", None)
                filled.append(sid)
                print(f"  ✓ {sid:<40} {res['words']} words")
            elif res.get("ok") and fetch_article.title_mismatch(s.get("title", ""), res):
                # url pointed at the wrong article — leave a tap-through, don't
                # show mismatched content under this headline
                s["sourceBlocked"] = True
                failed.append((sid, "headline/article mismatch — url likely mis-paired"))
                print(f"  ⤫ {sid:<40} headline/article mismatch")
            elif res.get("premiumData"):
                # TRD Data ($/yr tier) — no session unlocks it; clean tap-through
                s["sourceBlocked"] = True
                failed.append((sid, "TRD Data (premium tier)"))
                print(f"  ⤫ {sid:<40} TRD Data (premium tier)")
            else:
                s["sourceBlocked"] = True  # app: card taps through to the source
                failed.append((sid, f"{res.get('words', 0)} words"
                                    + (" (challenge held)" if res.get("blocked") else "")))
                print(f"  ✗ {sid:<40} {res.get('words', 0)} words")
        except Exception as e:  # noqa: BLE001 - one bad page never stops the loop
            failed.append((sid, str(e)[:70]))
            print(f"  ✗ {sid:<40} {str(e)[:70]}")

    if filled or changed_urls:
        day["generatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        fill_content.DATA.mkdir(exist_ok=True)
        path.write_text(json.dumps(day, ensure_ascii=False, indent=2))
        if not no_push:
            try:
                fill_content._push(day)
                print(f"  published {date} to Supabase")
            except Exception as e:  # noqa: BLE001
                print(f"  WARN push failed for {date}: {e}")

    parts = [f"{date}: filled {len(filled)}/{len(targets)}"]
    if failed:
        parts.append(f"{len(failed)} still missing")
    print("  " + " · ".join(parts))
    return len(filled), len(failed)


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    no_push = "--no-push" in sys.argv
    # an explicit date fills just that day; otherwise sweep today + recent days so
    # stragglers that rolled off "today" still get a real-browser attempt
    dates = [args[0]] if args else _recent_dates(fill_content._today())

    # cheap pre-check: if NOTHING across the window needs content, skip launching
    # a browser entirely (the common steady-state — keeps no-op runs seconds long)
    any_targets = False
    for date in dates:
        day, _ = fill_content._load_local(date)
        if day is None:
            day = fill_content._load_supabase(date)
        if day and any(fill_content._words(s.get("content")) < fill_content.MIN_WORDS and s.get("url")
                       for s in (day.get("stories") or [])):
            any_targets = True
            break
    if not any_targets:
        print(f"SUMMARY: nothing to fill across {len(dates)} day(s)")
        fill_content.record_heartbeat(dates[0], 0, 0, "")
        return 0

    from playwright.sync_api import sync_playwright  # imported late: no-op runs skip it

    total_filled = total_failed = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(user_agent=UA, locale="en-US",
                                  viewport={"width": 1280, "height": 900})
        cookied: set = set()
        page = ctx.new_page()
        for date in dates:
            f, x = _fill_one_day(page, ctx, cookied, date, no_push)
            total_filled += f
            total_failed += x
        browser.close()

    fill_content.record_heartbeat(dates[0], total_filled, total_failed, "")
    print(f"SUMMARY: filled {total_filled}, {total_failed} still missing across {len(dates)} day(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
