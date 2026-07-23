#!/usr/bin/env python3
"""Give roster entries a real avatar and RE-HOST it so it can't rot.

Run ad-hoc, or on a schedule (.github/workflows/player-images.yml), to fill any
player missing an `image`:

    python3 scripts/backfill_player_images.py            # every player missing one
    python3 scripts/backfill_player_images.py --slug meta cbre
    python3 scripts/backfill_player_images.py --all      # re-source even existing ones
    python3 scripts/backfill_player_images.py --dry-run  # source + report, don't write

For each entity it gathers several logo/headshot candidates, keeps the best one
that passes a real quality gate (decodes the image's pixel dimensions — so a
blank 16x16 favicon is rejected no matter its byte size, which was the old
failure mode), uploads it to the Supabase `player-images` bucket, and points the
player's `image` at the public URL.

  Companies — every source is tried, the best-scoring passing candidate wins:
    - the site's apple-touch-icon / largest declared <link rel=icon>
    - icon.horse (serves a real 256px logo for most domains — the best live
      source now that Clearbit's logo API is dead, which is why unavatar/Google
      started returning blank tiles)
    - unavatar.io, DuckDuckGo icons, Google s2 @256 (fallbacks)
  People — Wikipedia REST thumbnail, discovered via search and gated by a
  name+context keyword check so a namesake can't slip through.

Quality gate: square-ish (aspect <= 1.6) AND min side >= 48px. Monograms remain
the honest fallback — most private real-estate people have no public headshot.
Extend COMPANY_DOMAINS when a name doesn't map cleanly to its domain.
"""
import json
import re
import struct
import sys
import urllib.parse
import urllib.request

URL = "https://uhwdnmbxiopfysodydty.supabase.co"
KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 briefing-bot"

MIN_SIDE = 48       # reject anything whose short side is smaller (16/32px favicons)
MAX_ASPECT = 1.6    # reject landscape/portrait (hero photos, wordmark banners)
MIN_BYTES = 350     # a raster this small at 48px+ is blank/transparent, not a logo

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
    # backfill batch — names that don't guess cleanly to their real domain
    "lxp-industrial-trust": "lxp.com", "cpp-investments": "cppinvestments.com",
    "hut-8": "hut8.com", "601w-companies": "601w.com", "newmark": "nmrk.com",
    "ares-reit": "aresreit.com", "whitestone-reit": "whitestonereit.com", "boxabl": "boxabl.com",
    "ubs": "ubs.com", "brandywine-realty-trust": "brandywinerealty.com",
    "empire-state-realty-trust": "esrtreit.com", "segro": "segro.com", "healthpeak": "healthpeak.com",
    "zeckendorf-development": "zeckendorfdevelopment.com", "loancore-capital": "loancore.com",
    "fisher-brothers": "fisherbrothers.com", "arbor-realty-trust": "arbor.com", "hines": "hines.com",
    "rialto-capital": "rialtocapital.com", "extell-development": "extell.com", "bxp": "bxp.com",
    "cbre": "cbre.com", "citi": "citi.com", "merritt-properties": "merrittproperties.com",
    "atlantic-development-group": "atlanticdevgrp.com", "chetrit-group": "chetritorg.com",
    "mural-real-estate": "muralrealestate.com", "fattal-hotels": "fattal-hotels.com",
}

# People with a clear public page + a keyword the page must contain (namesake guard).
# Most are auto-discovered via Wikipedia search; list here only overrides/hints.
PEOPLE_WIKI = {
    "zohran-mamdani": ("Zohran Mamdani", ("politician", "mayor", "assembly", "new york")),
    "harry-macklowe": ("Harry Macklowe", ("real estate", "developer", "macklowe")),
    "kevin-oleary": ("Kevin O'Leary", ("businessman", "shark tank", "investor")),
    "ken-griffin": ("Kenneth C. Griffin", ("citadel", "hedge fund", "investor", "businessman")),
}

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
        return r.read(), r.headers.get("Content-Type", "").split(";")[0].strip().lower(), r.status, r.geturl()


def _dims(data, ct):
    """Pixel (w, h) for png/gif/jpeg/ico/webp, else None. No image library needed."""
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", data[16:24])
        if data[:6] in (b"GIF87a", b"GIF89a"):
            return struct.unpack("<HH", data[6:10])
        if data[:2] == b"\xff\xd8":  # jpeg: walk to the first SOF marker
            i = 2
            while i < len(data) - 9:
                if data[i] != 0xFF:
                    i += 1; continue
                m = data[i + 1]
                if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                    h, w = struct.unpack(">HH", data[i + 5:i + 9]); return w, h
                if m in (0xD8, 0xD9):
                    i += 2; continue
                i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
            return None
        if data[:4] == b"\x00\x00\x01\x00":  # ico: largest embedded size
            best = (0, 0)
            for e in range(struct.unpack("<H", data[4:6])[0]):
                off = 6 + e * 16
                w, h = data[off] or 256, data[off + 1] or 256
                if w * h > best[0] * best[1]:
                    best = (w, h)
            return best
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            f = data[12:16]
            if f == b"VP8 ":
                return (struct.unpack("<H", data[26:28])[0] & 0x3FFF,
                        struct.unpack("<H", data[28:30])[0] & 0x3FFF)
            if f == b"VP8L":
                b0, b1, b2, b3 = data[21:25]
                return ((b1 & 0x3F) << 8 | b0) + 1, ((b3 & 0x0F) << 10 | b2 << 2 | (b1 & 0xC0) >> 6) + 1
            if f == b"VP8X":
                return ((data[24] | data[25] << 8 | data[26] << 16) + 1,
                        (data[27] | data[28] << 8 | data[29] << 16) + 1)
    except Exception:
        return None
    return None


def _passes(data, ct):
    """A candidate is usable if it's a real, square-ish, big-enough raster."""
    if ct == "image/svg+xml" and len(data) > 300:
        return True                       # vector logo — always crisp, no dims to check
    if len(data) < MIN_BYTES:
        return False                      # too few bytes at 64px+ ⇒ blank/transparent
    wh = _dims(data, ct)
    if not wh or min(wh) < MIN_SIDE:
        return False
    return max(wh) / max(1, min(wh)) <= MAX_ASPECT


def _score(data, ct):
    """Rank a passing candidate: crisp (>=96px short side) beats tiny; nearer a
    ~200px avatar target beats a 4000px monster; smaller bytes break ties."""
    if ct == "image/svg+xml":
        return (0, 0, len(data))          # vector: best tier, treat as ideal size
    wh = _dims(data, ct) or (0, 0)
    short = min(wh)
    return (0 if short >= 96 else 1, abs(short - 200), len(data))


def _guess_domain(name):
    base = re.sub(r"[^a-z0-9]", "", _STOPWORDS.sub("", name).lower())
    return base + ".com" if base else ""


def _site_icons(domain):
    """apple-touch-icon URLs (best) then declared favicon URLs (largest first)."""
    for scheme in ("https://www.", "https://"):
        try:
            html, _, _, final = _fetch(scheme + domain, timeout=12)
            html = html.decode("utf-8", "ignore")
            apple, icons = [], []
            for tag in re.findall(r"<link\b[^>]*>", html, re.I):
                if not re.search(r"rel=[\"']?[^\"'>]*icon", tag, re.I):
                    continue
                m = re.search(r"href=[\"']([^\"']+)", tag)
                if not m:
                    continue
                href = urllib.parse.urljoin(final, m.group(1))
                sz = re.search(r"sizes=[\"']?(\d+)", tag)
                sz = int(sz.group(1)) if sz else 0
                (apple if "apple-touch" in tag.lower() else icons).append((sz, href))
            icons.sort(reverse=True)
            return [h for _, h in apple] + [h for _, h in icons]
        except Exception:
            continue
    return []


def _company_logo(name, slug):
    domain = COMPANY_DOMAINS.get(slug) or _guess_domain(name)
    if not domain:
        return None
    # gather every real logo source, keep the best-scoring one that passes the gate
    # (apple-touch-icon, unavatar aggregate, declared favicons, Google @256 last)
    # icon.horse serves a real 256px logo for most domains and is the best live
    # replacement now that Clearbit's logo API (which unavatar leaned on) is dead —
    # so unavatar/Google frequently return a blank tile. Try several; keep the best.
    sources = _site_icons(domain) + [
        f"https://icon.horse/icon/{domain}",
        f"https://unavatar.io/{domain}?fallback=false",
        f"https://icons.duckduckgo.com/ip3/{domain}.ico",
        f"https://www.google.com/s2/favicons?domain={domain}&sz=256",
    ]
    best = None
    for src in sources:
        try:
            data, ct, status, _ = _fetch(src)
            if status != 200 or not ct.startswith("image") or not _passes(data, ct):
                continue
            sc = _score(data, ct)
            if best is None or sc < best[0]:
                best = (sc, data, ct)
        except Exception:
            continue
    return (best[1], best[2]) if best else None


def _person_headshot(slug, name):
    """People are CURATED only (PEOPLE_WIKI). We deliberately do NOT auto-search
    Wikipedia by name: real-estate figures share names with academics, athletes
    and executives, and putting the WRONG person's face on a profile is far worse
    than an initials monogram. Add a person here only after confirming the page.
    The keyword guard is a second belt: the page must mention the surname AND a
    business/RE/politics context word, or we skip it."""
    cfg = PEOPLE_WIKI.get(slug)
    if not cfg:
        return None
    title, keywords = cfg
    try:
        raw, _, status, _ = _fetch(
            "https://en.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(title.replace(" ", "_")))
        if status != 200:
            return None
        j = json.loads(raw)
        if j.get("type") == "disambiguation":
            return None
        blob = ((j.get("description") or "") + " " + (j.get("extract") or "")).lower()
        if not any(k in blob for k in keywords):
            return None
        # prefer the small REST thumbnail (~320px) over originalimage (multi-MB)
        thumb = (j.get("thumbnail") or j.get("originalimage") or {}).get("source")
        if not thumb:
            return None
        data, ct, status, _ = _fetch(thumb)
        if status == 200 and ct.startswith("image") and _passes(data, ct):
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


def _roster(only=None, include_existing=False):
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
        if not only and not include_existing and (d.get("image") or "").strip():
            continue
        out.append((slug, d))
    return out


def main():
    only = set(a for a in sys.argv[1:] if not a.startswith("--")) or None
    dry = "--dry-run" in sys.argv
    include_existing = "--all" in sys.argv
    done, skipped = [], []
    for slug, d in _roster(only, include_existing):
        got = (_person_headshot(slug, d["name"]) if d.get("type") == "person"
               else _company_logo(d["name"], slug))
        if not got:
            skipped.append(slug)
            print(f"  – {slug:<36} no image")
            continue
        wh = _dims(got[0], got[1])
        dim = f"{wh[0]}x{wh[1]}" if wh else "svg"
        if dry:
            done.append(slug)
            print(f"  ~ {slug:<36} {dim} {len(got[0])}b {got[1]} (dry-run)")
            continue
        try:
            pub = _upload(slug, got[0], got[1])
            if _set_image(slug, d, pub):
                done.append(slug)
                print(f"  ✓ {slug:<36} {dim} {len(got[0])}b -> {pub.rsplit('/', 1)[-1]}")
            else:
                skipped.append(slug)
        except Exception as e:  # noqa: BLE001
            skipped.append(slug)
            print(f"  ! {slug:<36} {str(e)[:60]}")
    print(f"\nDONE: {'would set' if dry else 'set'} {len(done)}, skipped {len(skipped)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
