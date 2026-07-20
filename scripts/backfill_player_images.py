#!/usr/bin/env python3
"""Give roster entries a real avatar and RE-HOST it so it can't rot.

Run ad-hoc (or from a scheduled job) to fill in any player missing an `image`:

    python3 scripts/backfill_player_images.py            # all missing
    python3 scripts/backfill_player_images.py --slug meta amazon

For each entity it sources a logo/headshot, uploads it to the Supabase
`player-images` bucket, and points the player's `image` at the public URL.

  • Companies: unavatar.io → DuckDuckGo → Google s2 favicon, tried against the
    entity's domain (from the curated map below, else guessed from the name).
    unavatar aggregates favicon/logo/clearbit-cache and 404s cleanly when it has
    nothing, so a wrong guess is simply skipped.
  • People: the Wikipedia REST thumbnail, only when the page description clearly
    matches (a keyword guard against namesakes).

Monograms remain the fallback — most private real-estate people have no public
headshot, and that's fine. Extend COMPANY_DOMAINS / PEOPLE_WIKI as the roster grows.
"""
import json
import re
import sys
import urllib.parse
import urllib.request

URL = "https://uhwdnmbxiopfysodydty.supabase.co"
KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 briefing-bot"

# Known-good domains for entities whose name doesn't map cleanly to a domain.
COMPANY_DOMAINS = {
    "amazon": "amazon.com", "meta": "meta.com", "jpmorgan": "jpmorganchase.com",
    "keller-williams": "kw.com", "rebny": "rebny.com", "realpage": "realpage.com",
    "gotham-organization": "gothamorg.com", "apollo-global-advisors": "apollo.com",
    "balbec-capital": "balbec.com", "blackstone": "blackstone.com", "brixmor": "brixmor.com",
    "brookfield": "brookfield.com", "cherre": "cherre.com", "columbia-university": "columbia.edu",
    "crescent-heights": "crescentheights.com", "hilton-hyland": "hiltonhyland.com",
    "prologis": "prologis.com", "smartstop": "smartstop.com", "tishman-speyer": "tishmanspeyer.com",
    "verizon": "verizon.com", "columbia-property-trust": "columbiapropertytrust.com",
    "charney-cos": "charneycompanies.com", "maverick-real-estate-partners": "maverickrep.com",
    "ppr-capital": "pprcapitalmgmt.com", "jason-mitchell-group": "jasonmitchellgroup.com",
}

# People with a clear public page + a keyword the page must contain (namesake guard).
PEOPLE_WIKI = {
    "zohran-mamdani": ("Zohran Mamdani", ("politician", "mayor", "assembly", "new york")),
    "harry-macklowe": ("Harry Macklowe", ("real estate", "developer", "macklowe")),
}

# generic corporate words to strip when guessing a domain from a company name
_STOPWORDS = re.compile(
    r"\b(the|group|development|dev|company|companies|cos|co|capital|partners|holdings|"
    r"realty|real|estate|properties|property|trust|management|mgmt|advisors|global|"
    r"inc|llc|lp|corp|corporation)\b", re.I)

EXT_BY_CT = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp",
             "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/svg+xml": "svg",
             "image/gif": "png"}


def _fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get("Content-Type", "").split(";")[0].strip().lower(), r.status


def _guess_domain(name: str) -> str:
    base = _STOPWORDS.sub("", name)
    base = re.sub(r"[^a-z0-9]", "", base.lower())
    return base + ".com" if base else ""


def _company_logo(name: str, slug: str):
    domain = COMPANY_DOMAINS.get(slug) or _guess_domain(name)
    if not domain:
        return None
    for src in (f"https://unavatar.io/{domain}?fallback=false",
                f"https://icons.duckduckgo.com/ip3/{domain}.ico",
                f"https://www.google.com/s2/favicons?domain={domain}&sz=128"):
        try:
            data, ct, status = _fetch(src)
            if status == 200 and len(data) > 500 and ct.startswith("image"):
                return data, ct
        except Exception:
            continue
    return None


def _person_headshot(slug: str):
    cfg = PEOPLE_WIKI.get(slug)
    if not cfg:
        return None
    title, keywords = cfg
    try:
        raw, _, status = _fetch(f"https://en.wikipedia.org/api/rest_v1/page/summary/{urllib.parse.quote(title)}")
        if status != 200:
            return None
        j = json.loads(raw)
        blob = ((j.get("description") or "") + " " + (j.get("extract") or "")).lower()
        if not any(k in blob for k in keywords):
            return None
        thumb = (j.get("originalimage") or j.get("thumbnail") or {}).get("source")
        if not thumb:
            return None
        data, ct, status = _fetch(thumb)
        if status == 200 and len(data) > 800 and ct.startswith("image"):
            return data, ct
    except Exception:
        pass
    return None


def _upload(slug, data, ct):
    name = f"{slug}.{EXT_BY_CT.get(ct, 'png')}"
    req = urllib.request.Request(
        f"{URL}/storage/v1/object/player-images/{name}", data=data, method="POST",
        headers={**H, "Content-Type": ct or "image/png", "x-upsert": "true"})
    with urllib.request.urlopen(req, timeout=30) as r:
        if r.status not in (200, 201):
            raise RuntimeError(f"upload {r.status}")
    return f"{URL}/storage/v1/object/public/player-images/{name}"


def _set_image(slug, data_obj, image_url):
    data_obj["image"] = image_url
    body = json.dumps({"data": data_obj}).encode()
    req = urllib.request.Request(
        f"{URL}/rest/v1/players?slug=eq.{urllib.parse.quote(slug)}", data=body, method="PATCH",
        headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status in (200, 204)


def _roster(only=None):
    req = urllib.request.Request(f"{URL}/rest/v1/players?select=slug,data", headers=H)
    with urllib.request.urlopen(req, timeout=20) as r:
        rows = json.load(r)
    out = []
    for row in rows:
        slug, d = row["slug"], row.get("data") or {}
        if slug.startswith("_") or not d.get("name"):
            continue
        if only and slug not in only:
            continue
        if not only and (d.get("image") or "").strip():
            continue
        out.append((slug, d))
    return out


def main():
    only = set(a for a in sys.argv[1:] if not a.startswith("--")) or None
    done, skipped = [], []
    for slug, d in _roster(only):
        got = _person_headshot(slug) if d.get("type") == "person" else _company_logo(d["name"], slug)
        if not got:
            skipped.append(slug)
            print(f"  – {slug:<34} no image")
            continue
        try:
            pub = _upload(slug, got[0], got[1])
            if _set_image(slug, d, pub):
                done.append(slug)
                print(f"  ✓ {slug:<34} {len(got[0])}b -> {pub.rsplit('/', 1)[-1]}")
            else:
                skipped.append(slug)
        except Exception as e:  # noqa: BLE001
            skipped.append(slug)
            print(f"  ! {slug:<34} {str(e)[:60]}")
    print(f"\nDONE: set {len(done)}, skipped {len(skipped)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
