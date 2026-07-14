#!/usr/bin/env python3
"""Upsert local data files into the Supabase backend that the hosted app reads.

Usage:
  python3 scripts/push_data.py                 # push every data/*.json and data/weeks/*.json
  python3 scripts/push_data.py 2026-07-14      # push one day (plus its week file if present)

The pipeline writes local JSON first (same schemas as before, documented in
CLAUDE.md), then runs this to publish. Uses the project's publishable key —
the tables have open-write RLS by owner's choice (single-user app).
"""
import json
import pathlib
import sys
import urllib.request

SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co"
ANON_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def upsert(table: str, row: dict) -> None:
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{table}",
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
            raise RuntimeError(f"{table}: HTTP {resp.status}")


def push_day(path: pathlib.Path) -> None:
    doc = json.loads(path.read_text())
    upsert("days", {"date": doc["date"], "data": doc, "generated_at": doc.get("generatedAt")})
    print(f"pushed day  {doc['date']}")


def push_week(path: pathlib.Path) -> None:
    doc = json.loads(path.read_text())
    upsert("weeks", {"week_of": doc["weekOf"], "data": doc, "generated_at": doc.get("generatedAt")})
    print(f"pushed week {doc['weekOf']}")


def main() -> None:
    only = sys.argv[1] if len(sys.argv) > 1 else None
    days = sorted(DATA.glob("????-??-??.json"))
    weeks = sorted((DATA / "weeks").glob("????-??-??.json")) if (DATA / "weeks").exists() else []
    if only:
        days = [p for p in days if p.stem == only]
    for p in days:
        push_day(p)
    for p in weeks:
        push_week(p)
    if not days and not weeks:
        print("nothing to push")


if __name__ == "__main__":
    main()
