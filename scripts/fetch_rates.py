#!/usr/bin/env python3
"""Fetch the daily Treasury par yield curve and SOFR, publish to Supabase.

Usage: python3 scripts/fetch_rates.py
Writes data/rates.json and upserts the row into the `rates` table (keyed by the
curve date). Run by the daily pipeline; safe to re-run any time.

Two paths, tried in order:
1. DIRECT — treasury.gov daily yield-curve XML + NY Fed markets API (with
   retries and a browser User-Agent).
2. EDGE FALLBACK — the Supabase `rates-live` edge function, which fetches the
   same sources from Supabase's servers. This is what makes the script work
   inside the cloud routine, whose egress policy blocks treasury.gov and
   newyorkfed.org but allows *.supabase.co.

Exit code 0 whenever a row was published (a WARN line flags a fallback);
exit 1 only when both paths fail — put that in the day's notes.
"""
import json
import pathlib
import sys
import time
import urllib.request
from datetime import datetime, timezone
from xml.etree import ElementTree

SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co"
ANON_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"
ROOT = pathlib.Path(__file__).resolve().parent.parent
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

TENOR_FIELDS = [
    ("1M", "BC_1MONTH"), ("2M", "BC_2MONTH"), ("3M", "BC_3MONTH"),
    ("4M", "BC_4MONTH"), ("6M", "BC_6MONTH"), ("1Y", "BC_1YEAR"),
    ("2Y", "BC_2YEAR"), ("3Y", "BC_3YEAR"), ("5Y", "BC_5YEAR"),
    ("7Y", "BC_7YEAR"), ("10Y", "BC_10YEAR"), ("20Y", "BC_20YEAR"),
    ("30Y", "BC_30YEAR"),
]


def get(url: str, tries: int = 3):
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - retry any network failure
            last = e
            if attempt < tries - 1:
                time.sleep(2 * (attempt + 1))
    raise last


def treasury_curve():
    year = datetime.now(timezone.utc).strftime("%Y")
    xml = get(
        "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml"
        f"?data=daily_treasury_yield_curve&field_tdr_date_value={year}"
    )
    root = ElementTree.fromstring(xml)
    ns_d = "{http://schemas.microsoft.com/ado/2007/08/dataservices}"
    entries = []
    for props in root.iter("{http://schemas.microsoft.com/ado/2007/08/dataservices/metadata}properties"):
        row = {}
        date_el = props.find(f"{ns_d}NEW_DATE")
        if date_el is None or not date_el.text:
            continue
        row["date"] = date_el.text[:10]
        for label, field in TENOR_FIELDS:
            el = props.find(f"{ns_d}{field}")
            if el is not None and el.text:
                try:
                    row[label] = float(el.text)
                except ValueError:
                    pass
        entries.append(row)
    entries.sort(key=lambda r: r["date"])
    return entries[-1] if entries else None


def nyfed(path):
    doc = json.loads(get(f"https://markets.newyorkfed.org/api/rates/secured/{path}/last/1.json"))
    rows = doc.get("refRates") or []
    return rows[0] if rows else {}


def build_direct() -> dict:
    curve = treasury_curve()
    if not curve:
        raise RuntimeError("no treasury curve data returned")
    sofr = nyfed("sofr")
    avgs = nyfed("sofrai")
    return {
        "curveDate": curve["date"],
        "treasury": {k: v for k, v in curve.items() if k != "date"},
        "sofr": {"rate": sofr.get("percentRate"), "date": sofr.get("effectiveDate")},
        "sofrAverages": {
            "30d": avgs.get("average30day"),
            "90d": avgs.get("average90day"),
            "180d": avgs.get("average180day"),
            "date": avgs.get("effectiveDate"),
        },
        "source": "direct",
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def build_from_edge() -> dict:
    """Same data via the rates-live edge function (runs on Supabase's servers,
    so it works where this script's own egress to treasury.gov is blocked)."""
    req = urllib.request.Request(
        f"{SUPABASE_URL}/functions/v1/rates-live",
        headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        p = json.load(r)
    if not p.get("treasury") or not p.get("curveDate"):
        raise RuntimeError("edge function returned no curve")
    return {
        "curveDate": p["curveDate"],
        "treasury": p["treasury"],
        "sofr": {"rate": (p.get("sofr") or {}).get("rate"), "date": (p.get("sofr") or {}).get("date")},
        "sofrAverages": p.get("sofrAverages") or {},
        "source": "edge-function",
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def publish(doc: dict) -> None:
    (ROOT / "data").mkdir(exist_ok=True)
    (ROOT / "data" / "rates.json").write_text(json.dumps(doc, indent=2))
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rates",
        data=json.dumps({"date": doc["curveDate"], "data": doc, "generated_at": doc["generatedAt"]}).encode(),
        headers={
            "apikey": ANON_KEY,
            "Authorization": f"Bearer {ANON_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        assert r.status in (200, 201)
    print(f"rates published for {doc['curveDate']} via {doc['source']}: "
          f"5Y {doc['treasury'].get('5Y')} · 10Y {doc['treasury'].get('10Y')} · "
          f"30Y {doc['treasury'].get('30Y')} · SOFR {doc['sofr']['rate']}")


def main() -> None:
    force_edge = "--via-edge" in sys.argv
    if not force_edge:
        try:
            publish(build_direct())
            return
        except Exception as e:  # noqa: BLE001 - fall back to the edge path
            print(f"WARN direct treasury/NY Fed fetch failed ({e}); falling back to rates-live edge function")
    try:
        publish(build_from_edge())
    except Exception as e:  # noqa: BLE001 - both paths dead
        print(f"ERROR rates unavailable from both direct sources and the edge function: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
