#!/usr/bin/env python3
"""Deterministically fill every story's reader content for a day.

The daily routine writes the day file with each story's `url`; THIS script then
loops over EVERY story and fetches full article text for any that is missing or
too short — through scripts/fetch_article.py (direct → Supabase proxy → TRD
cookie). It takes article-fetching OFF the agent's judgment and makes it a
guaranteed loop, so no story is ever silently left as a summary-only stub.

It is idempotent: only stories still lacking real content get fetched, so it is
safe (and cheap) to run at every scheduled window. A story whose fetch failed
transiently is simply retried on the next run — that cross-run retry is what
makes coverage reliable without any manual step.

Usage:
  python3 scripts/fill_content.py                 # today (America/New_York)
  python3 scripts/fill_content.py 2026-07-16      # a specific day
  python3 scripts/fill_content.py 2026-07-16 --no-push   # fill local file only, don't publish

Exit status is 0 on a clean run; it prints a per-story report and a summary
line like "filled 14/16 · 2 failed (ids…)" so the routine can fold any
persistent failure into the day's notes.
"""
import json
import pathlib
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import fetch_article  # same directory; provides extract(url) -> {ok, html, image, words, [paywalled]}

SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co"
ANON_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# A story "has content" once it holds at least this many words — matches
# fetch_article's own ok bar, so we never overwrite a real body with a shorter
# one and never leave a genuine stub unfilled.
MIN_WORDS = 120

# Email tracking-link wrappers: the stored `url` is opaque and points here, not
# at the publisher. Once a fetch resolves the redirect we swap in the real URL so
# the app can credit the actual publisher (and "Source ↗" skips the redirect).
WRAPPERS = ("list-manage.com", "beehiiv.com", "mailchi.mp")


def _words(html: str | None) -> int:
    if not html:
        return 0
    return len(re.sub(r"<[^>]+>", " ", html).split())


def _host(url: str) -> str:
    try:
        return urllib.parse.urlparse(url).netloc.lower()
    except Exception:
        return ""


def _is_wrapper(url: str) -> bool:
    h = _host(url)
    return any(w in h for w in WRAPPERS)


def _clean_url(url: str) -> str:
    """Drop query/fragment tracking so the stored publisher URL is canonical."""
    try:
        p = urllib.parse.urlparse(url)
        return urllib.parse.urlunparse((p.scheme, p.netloc, p.path, "", "", ""))
    except Exception:
        return url


def _today() -> str:
    return datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")


def _load_local(date: str) -> tuple[dict | None, pathlib.Path]:
    path = DATA / f"{date}.json"
    if path.exists():
        return json.loads(path.read_text()), path
    return None, path


def _load_supabase(date: str) -> dict | None:
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/days?date=eq.{date}&select=data",
        headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        rows = json.load(r)
    return rows[0]["data"] if rows else None


def _push(day: dict) -> None:
    row = {"date": day["date"], "data": day, "generated_at": day.get("generatedAt")}
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/days",
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
        if resp.status not in (200, 201):
            raise RuntimeError(f"push failed: HTTP {resp.status}")


def _try_story(s: dict) -> tuple[str, object]:
    """Attempt to fill one story's content. Mutates it on success.
    Returns (status, detail) where status is 'filled'|'paywalled'|'failed'."""
    have = _words(s.get("content"))
    try:
        res = fetch_article.extract(s["url"])
    except Exception as e:  # noqa: BLE001
        return "failed", f"fetch error: {str(e)[:70]}"
    # credit the real publisher: if the stored url was a tracking wrapper and the
    # fetch resolved to a real destination, swap in the canonical publisher URL
    final = res.get("finalUrl")
    if final and _is_wrapper(s["url"]) and not _is_wrapper(final):
        s["url"] = _clean_url(final)
    if res.get("ok") and _words(res.get("html")) > have:
        s["content"] = res["html"]
        if not s.get("image") and res.get("image"):
            s["image"] = res["image"]
        return "filled", res["words"]
    if res.get("paywalled"):
        return "paywalled", None
    if res.get("blocked"):
        return "blocked", "bot wall (Cloudflare) — auto-retries next run"
    return "failed", f"only {res.get('words', 0)} words"


def fill_day(day: dict, throttle: float = 1.5, retry_wait: float = 25) -> dict:
    """Fetch content for every story that still needs it. Mutates `day` in place.

    Fetches are spaced out (`throttle`) so a burst never trips the tracking-link
    hosts' per-IP rate limit (beehiiv/Mailchimp 403 under rapid repeat hits), and
    any story that still failed gets ONE retry pass after `retry_wait` — long
    enough for a rate-limit window to reset. Whatever remains failed is a genuine
    miss that the next scheduled run will retry again.

    Returns a report: {filled, failed, paywalled, skipped, attempted}."""
    stories = day.get("stories") or []
    to_fetch = [s for s in stories if _words(s.get("content")) < MIN_WORDS and s.get("url")]
    skipped = len(stories) - len(to_fetch)
    filled, paywalled = [], []
    unresolved = {}  # id -> (kind, detail); kind in {"blocked", "failed"}

    def run_pass(items: list, tag: str) -> None:
        for i, s in enumerate(items):
            if i:
                time.sleep(throttle)  # space out to dodge tracking-link rate limits
            sid = s.get("id")
            status, detail = _try_story(s)
            if status == "filled":
                filled.append(sid)
                unresolved.pop(sid, None)
                print(f"  ✓ {sid:<40} {detail} words{tag}")
            elif status == "paywalled":
                if sid not in paywalled:
                    paywalled.append(sid)
                unresolved.pop(sid, None)
                print(f"  ⚠ {sid:<40} TRD paywalled (session expired)")
            elif status == "blocked":
                unresolved[sid] = ("blocked", detail)
                print(f"  ⛔ {sid:<40} {detail}{tag}")
            else:
                unresolved[sid] = ("failed", detail)
                print(f"  ✗ {sid:<40} {detail}{tag}")

    run_pass(to_fetch, "")
    retry = [s for s in to_fetch if s.get("id") in unresolved]
    if retry:
        print(f"  … retrying {len(retry)} after {retry_wait:.0f}s (rate-limit / bot-wall may clear)")
        time.sleep(retry_wait)
        run_pass(retry, "  (retry)")

    if filled:
        day["generatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    blocked = [(i, d) for i, (k, d) in unresolved.items() if k == "blocked"]
    failed = [(i, d) for i, (k, d) in unresolved.items() if k == "failed"]
    return {"filled": filled, "failed": failed, "blocked": blocked, "paywalled": paywalled,
            "skipped": skipped, "attempted": len(to_fetch)}


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    no_push = "--no-push" in sys.argv
    date = args[0] if args else _today()

    day, path = _load_local(date)
    source = "local file"
    if day is None:
        day = _load_supabase(date)
        source = "Supabase"
    if day is None:
        print(f"No day found for {date} (checked local file and Supabase).")
        return 1

    print(f"Filling content for {date}  (loaded from {source}, {len(day.get('stories') or [])} stories)")
    rep = fill_day(day)

    # persist: always write the local file so a later push_data.py stays in sync
    DATA.mkdir(exist_ok=True)
    path.write_text(json.dumps(day, ensure_ascii=False, indent=2))

    if rep["filled"] and not no_push:
        try:
            _push(day)
            print("  published updated day to Supabase")
        except Exception as e:  # noqa: BLE001
            print(f"  WARN push failed: {e}")

    # summary line the routine can read at a glance
    parts = [f"filled {len(rep['filled'])}/{rep['attempted']}"]
    if rep["blocked"]:
        parts.append(f"{len(rep['blocked'])} bot-walled, auto-retries next run ({', '.join(i or '?' for i, _ in rep['blocked'])})")
    if rep["failed"]:
        parts.append(f"{len(rep['failed'])} failed ({', '.join(i or '?' for i, _ in rep['failed'])})")
    if rep["paywalled"]:
        parts.append(f"{len(rep['paywalled'])} TRD-paywalled — refresh with: python3 scripts/trd_session.py --cookie")
    print("SUMMARY: " + " · ".join(parts) + f" · {rep['skipped']} already had content")
    return 0


if __name__ == "__main__":
    sys.exit(main())
