#!/usr/bin/env python3
"""Surface every SOURCED market-stat citation in a day's stories.

The metrics ledger (CLAUDE.md step 10d) is only as good as the routine's memory to
look for cited figures — and it was silently under-capturing. This makes the harvest
MECHANICAL instead of from-memory: it scans each story's summary + article text for a
number-with-unit sitting next to a RECOGNISED market-data source (Trepp, CBRE, Yardi,
Case-Shiller, Census, …), and prints each hit with its sentence. The routine then just
decides recurring-market-series (register it) vs single-deal figure (skip) — it no
longer has to remember to go looking.

Usage:
  python3 scripts/scan_metrics.py                 # today (America/New_York)
  python3 scripts/scan_metrics.py 2026-07-22      # one day
  python3 scripts/scan_metrics.py 2026-07-18 2026-07-22   # inclusive range
  python3 scripts/scan_metrics.py --json 2026-07-22       # machine-readable

Prints nothing but a header on a genuinely stat-free day. Reads Supabase directly
(no local files needed), so it runs the same in the cloud or locally.
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co"
ANON_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"

# Recognised recurring-print data sources — the trade press quotes these constantly.
# A number is only a metric candidate if it sits beside one of THESE (which is what
# filters out "80% stake per Aligned" style deal noise: Aligned isn't a data shop).
SOURCES = [
    "Trepp", "Green Street", "CBRE", "JLL", "Cushman", "Colliers", "CoStar", "Newmark",
    "Moody's", "Moody", "RCA", "MSCI", "Real Capital Analytics", "Case-Shiller",
    "CoreLogic", "S&P CoreLogic", "Zillow", "Redfin", "Apartment List", "Yardi",
    "RealPage", "ATTOM", "Census", "NAR", "National Association of Realtors",
    "Fannie Mae", "Freddie Mac", "Mortgage Bankers", "MBA", "John Burns",
    "Marcus & Millichap", "Fitch", "DBRS", "Kroll", "KBRA", "Zumper", "Realtor.com",
    "Black Knight", "ICE", "Cushman & Wakefield", "Yardi Matrix", "Federal Reserve",
    "St. Louis Fed", "SLOOS", "Deloitte", "PwC", "Avison Young", "Lument", "Berkadia",
    "Freddie", "Fannie", "Cushman", "Delinquency", "Trepp",
]
# de-dup, longest-first so "S&P CoreLogic" wins over "CoreLogic"
SOURCES = sorted(set(SOURCES), key=len, reverse=True)
SRC_RE = re.compile(r"\b(" + "|".join(re.escape(s) for s in SOURCES) + r")\b", re.I)

# a figure that reads like a market series, not a deal price: a percent, bps, an
# index level, or a rent/price with a clear unit. (Bare $-amounts are deal sizes —
# those are valueUsd, not metrics — so we DON'T match plain "$109M".)
NUM_RE = re.compile(
    r"(\$?\d[\d,]*(?:\.\d+)?\s?(?:%|percent|percentage points|bps|basis points|"
    r"per square foot|per sf|psf|/sf|a month|per month))",
    re.I,
)
TAG_RE = re.compile(r"<[^>]+>")
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9$])")


def get(path):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def sentences(story):
    parts = [story.get("summary") or ""]
    parts.append(TAG_RE.sub(" ", story.get("content") or ""))
    for cov in story.get("coverage") or []:
        parts.append(TAG_RE.sub(" ", cov.get("content") or ""))
    text = re.sub(r"\s+", " ", " ".join(parts)).strip()
    return SENT_SPLIT.split(text)


def scan_story(story):
    """Return [(source, figure, sentence)] for sentences carrying BOTH a market
    figure and a recognised source. De-duped per (source, figure)."""
    hits, seen = [], set()
    for sent in sentences(story):
        src = SRC_RE.search(sent)
        if not src:
            continue
        for num in NUM_RE.finditer(sent):
            key = (src.group(0).lower(), num.group(0).lower())
            if key in seen:
                continue
            seen.add(key)
            hits.append((src.group(0), num.group(1).strip(), sent.strip()))
    return hits


def today_ny():
    return (datetime.now(timezone.utc) - timedelta(hours=4)).strftime("%Y-%m-%d")


def daterange(a, b):
    d0 = datetime.strptime(a, "%Y-%m-%d")
    d1 = datetime.strptime(b, "%Y-%m-%d")
    out = []
    while d0 <= d1:
        out.append(d0.strftime("%Y-%m-%d"))
        d0 += timedelta(days=1)
    return out


def main():
    args = [a for a in sys.argv[1:] if a != "--json"]
    as_json = "--json" in sys.argv
    if not args:
        dates = [today_ny()]
    elif len(args) == 1:
        dates = [args[0]]
    else:
        dates = daterange(args[0], args[1])

    result = {}
    for date in dates:
        rows = get(f"days?date=eq.{date}&select=data")
        if not rows:
            continue
        day = rows[0]["data"]
        day_hits = []
        for s in day.get("stories", []):
            for src, fig, sent in scan_story(s):
                day_hits.append({"id": s.get("id"), "source": src, "figure": fig,
                                 "market": s.get("market"), "sentence": sent})
        if day_hits:
            result[date] = day_hits

    if as_json:
        print(json.dumps(result, indent=2))
        return

    total = sum(len(v) for v in result.values())
    print(f"=== sourced market-stat citations: {total} across {len(result)} day(s) ===")
    print("Register each RECURRING market series (reuse existing slugs); skip single-deal figures.\n")
    for date, hits in result.items():
        print(f"— {date} —")
        for h in hits:
            print(f"  [{h['source']}] {h['figure']}  ({h['market'] or '—'} · {h['id']})")
            print(f"      {h['sentence'][:180]}")
        print()


if __name__ == "__main__":
    main()
