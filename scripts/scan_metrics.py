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
    "Freddie", "Fannie", "Cushman",
    # promoted from the review queue as they recurred (the script flags novel sources
    # under "⚠ unrecognised sources"; add the legitimate recurring ones here):
    "Parcl Labs", "Apartments.com", "EIA", "Corcoran", "Miller Samuel", "RealtyRates",
    "Placer.ai", "Kastle", "Zonda", "John Burns Research", "Cotality", "Altus",
]
# de-dup, longest-first so "S&P CoreLogic" wins over "CoreLogic"
SOURCES = sorted(set(SOURCES), key=len, reverse=True)
SRC_RE = re.compile(r"\b(" + "|".join(re.escape(s) for s in SOURCES) + r")\b", re.I)

# The curated list above is a CONFIDENCE label, not a gate. A brand-new source we've
# never seen must not slip through, so a figure ALSO qualifies when it sits next to
# the GRAMMAR of attribution to a NAMED entity — "per X", "according to X", or
# "X reported / X's data / X survey", where X is a proper noun. That catches any
# novel data shop and tags it "review (new source?)" so the routine promotes the
# recurring ones into SOURCES (a one-line edit the script tells you to make).
# Requiring a real named entity (not a bare noun like "report"/"project") is what
# keeps this from firing on every sentence.
_ENT = r"(?:[A-Z][A-Za-z0-9.&'’-]*)(?:\s+(?:&\s+|of\s+|the\s+)?[A-Z][A-Za-z0-9.&'’-]*){0,3}"
ATTR_ENTITY = [
    # "per / according to / reported by  [a|the report from|by]  <Entity>"
    re.compile(r"\b(?:per|according to|via|cited by|reported by)\s+"
               r"(?:the\s+|a\s+|an\s+)?(?:[a-z]+\s+(?:from\s+|by\s+)?)?(" + _ENT + r")"),
    # "<Entity>('s) [Group] reported / data / survey / index / estimates / …"
    re.compile(r"\b(" + _ENT + r")(?:'s|’s)?\s+(?:Group\s+)?(?:reported|reports|said|"
               r"says|found|finds|estimates?|projects|pegged|data show|data shows|"
               r"survey|index|analysis|figures|research)\b"),
]
# tokens that can fill the attribution slot but never NAME a data source
NON_SOURCE = {"the", "it", "its", "this", "that", "he", "she", "they", "we", "a", "an",
              "company", "firm", "report", "data", "survey", "index", "analysis",
              "research", "release", "spokesperson", "landlord", "seller", "buyer",
              "listing", "broker", "developer", "publication", "project", "deal",
              "january", "february", "march", "april", "may", "june", "july", "august",
              "september", "october", "november", "december", "monday", "tuesday",
              "wednesday", "thursday", "friday", "q1", "q2", "q3", "q4"}

# a figure that reads like a MARKET SERIES: a percent or basis-point move. Bare $
# amounts are deal sizes (valueUsd) and $/sf are single-deal comps (handled by the
# Desk's comps board), so we deliberately DON'T match those — a $-level or index
# metric with no % is left to the routine's own read (the script is a floor, not a
# ceiling; see CLAUDE.md step 10d).
NUM_RE = re.compile(
    r"(\d[\d,]*(?:\.\d+)?\s?(?:%|percent|percentage points|bps|basis points))",
    re.I,
)
TAG_RE = re.compile(r"<[^>]+>")
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9$])")


def attributed_source(sent):
    """Name the source a sentence attributes a figure to. Returns (name, known):
    a curated source (known=True), else a NAMED proper noun in an attribution slot
    (known=False → 'review, maybe a new source'), else (None, False) — no attribution
    to a real source, so it isn't a market metric."""
    known = SRC_RE.search(sent)
    if known:
        return known.group(0), True
    for pat in ATTR_ENTITY:
        m = pat.search(sent)
        if m:
            name = m.group(1).strip()
            if name.split()[0].lower().strip(".,") not in NON_SOURCE:
                return name, False
    return None, False


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
    """Return [(source, figure, sentence, known)] for sentences carrying BOTH a
    market figure and an attributed source — a curated one (known=True) OR a novel
    one detected by attribution grammar (known=False). De-duped per (source, figure)."""
    hits, seen = [], set()
    for sent in sentences(story):
        if not NUM_RE.search(sent):
            continue
        source, known = attributed_source(sent)
        if not source:
            continue
        for num in NUM_RE.finditer(sent):
            key = (source.lower(), num.group(0).lower())
            if key in seen:
                continue
            seen.add(key)
            hits.append((source, num.group(1).strip(), sent.strip(), known))
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
            for src, fig, sent, known in scan_story(s):
                day_hits.append({"id": s.get("id"), "source": src, "figure": fig,
                                 "market": s.get("market"), "sentence": sent, "known": known})
        if day_hits:
            result[date] = day_hits

    if as_json:
        print(json.dumps(result, indent=2))
        return

    total = sum(len(v) for v in result.values())
    novel = sorted({h["source"] for hits in result.values() for h in hits if not h["known"] and h["source"] != "?"})
    print(f"=== sourced market-stat citations: {total} across {len(result)} day(s) ===")
    print("Register each RECURRING market series (reuse existing slugs); skip single-deal figures.")
    print("Rows marked ⚠ cite a source NOT in the curated list — treat them the same, and if a")
    print("source recurs, add it to SOURCES in this script so it's auto-recognised next time.\n")
    for date, hits in result.items():
        print(f"— {date} —")
        for h in hits:
            flag = "  " if h["known"] else "⚠ "
            print(f"  {flag}[{h['source']}] {h['figure']}  ({h['market'] or '—'} · {h['id']})")
            print(f"      {h['sentence'][:180]}")
        print()
    if novel:
        print("⚠ unrecognised sources surfaced this run (promote recurring ones into SOURCES):")
        print("   " + ", ".join(novel))


if __name__ == "__main__":
    main()
