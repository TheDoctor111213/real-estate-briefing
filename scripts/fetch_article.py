#!/usr/bin/env python3
"""Fetch an article URL and extract clean reader content.

Usage: python3 scripts/fetch_article.py <url>
Prints JSON: {"ok": bool, "title": str, "image": str|null, "html": str, "words": int}

The extractor keeps only p/h2/h3/blockquote/ul/ol/li/img/figure/figcaption from the
main article container and strips attributes except img src/alt. Used by the daily
scheduled task to populate each story's "content" field for the in-app reader.
"""
import json
import re
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co"
ANON_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y"


def _session_cookie(url: str) -> str | None:
    """Stored subscriber session for the URL's site, if the owner saved one via
    scripts/trd_session.py. Rows are keyed `session_<domain>`; therealdeal.com
    also falls back to the legacy `trd_session` row."""
    host = urllib.parse.urlparse(url).netloc.lower().removeprefix("www.")
    parts = host.split(".")
    domain = ".".join(parts[-2:]) if len(parts) >= 2 else host
    ids = [f"session_{domain}"]
    if domain == "therealdeal.com":
        ids.append("trd_session")
    for row_id in ids:
        try:
            req = urllib.request.Request(
                f"{SUPABASE_URL}/rest/v1/secrets?id=eq.{row_id}&select=data",
                headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"},
            )
            with urllib.request.urlopen(req, timeout=15) as r:
                rows = json.load(r)
            if rows:
                return rows[0]["data"]["cookie"]
        except Exception:
            continue
    return None

KEEP = {"p", "h2", "h3", "blockquote", "ul", "ol", "li", "img", "figure", "figcaption"}
DROP_SUBTREES = {"script", "style", "noscript", "iframe", "form", "aside", "nav", "footer", "header", "svg", "button"}
# class/id fragments that mark non-article chrome
JUNK = re.compile(r"related|share|social|newsletter|promo|ad-|advert|subscribe|paywall|comment|footer|nav|menu|sidebar|recirc|trending|signup|modal|byline-block", re.I)
# blank/placeholder image srcs some outlets emit when a story has no photo —
# Bisnow's watermark tile (assets/website/placeholder.png) is the worst offender.
# We never want these in the article body or as a hero.
JUNK_IMG = re.compile(r"placeholder|/blank[._-]|spacer|transparent\.(?:png|gif)|/1x1[._]|/assets/website/placeholder|/default[-_]?(?:image|thumb)", re.I)


VOID = {"img", "br", "hr", "meta", "input", "source", "link", "area", "base",
        "col", "embed", "param", "track", "wbr"}


class ArticleExtractor(HTMLParser):
    """Collect allowed elements inside <article> (or the whole body as fallback).

    Junk subtrees (nav, share widgets, related-story rails, paywall gates) are
    skipped by depth: when one opens we record its depth and drop everything
    until the parser returns to that depth. This is balanced by construction —
    a stray unclosed <div> can never leave us stuck in skip mode the way a
    plain increment/decrement counter could."""

    def __init__(self, scope_to_article: bool, junk_classes: bool = True):
        super().__init__(convert_charrefs=True)
        self.scope_to_article = scope_to_article
        self.junk_classes = junk_classes  # False: drop by tag only (relaxed pass)
        self.in_article = 0 if scope_to_article else 1
        self.depth = 0            # nesting depth of open non-void elements
        self.drop_depth = None    # depth at which the current skipped subtree began
        self.out = []
        self.open_keep = []       # stack of emitted KEEP tags
        self.og_image = None
        self.title = None
        self._in_title = False

    @property
    def dropping(self):
        return self.drop_depth is not None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta" and a.get("property") == "og:image" and not self.og_image:
            self.og_image = a.get("content")
        if tag == "title":
            self._in_title = True

        void = tag in VOID
        emit = self.in_article and not self.dropping

        if tag == "article" and self.scope_to_article:
            self.in_article += 1
        elif emit and tag == "img":
            src = a.get("src") or a.get("data-src") or ""
            m = re.search(r"-(\d+)x(\d+)\.(?:jpe?g|png|webp|gif)$", src)  # skip small WP thumbs
            if not (m and int(m.group(1)) < 400) and src.startswith("http") and not JUNK_IMG.search(src):
                alt = (a.get("alt") or "").replace('"', "&quot;")
                self.out.append(f'<img src="{src}" alt="{alt}">')
        elif emit and (tag in DROP_SUBTREES or
                       (self.junk_classes and JUNK.search(a.get("class", "") + " " + a.get("id", "")))):
            self.drop_depth = self.depth  # begin skipping this subtree
        elif emit and tag in KEEP:
            self.open_keep.append(tag)
            self.out.append(f"<{tag}>")

        if not void:
            self.depth += 1

    def handle_startendtag(self, tag, attrs):
        # self-closed tag (e.g. <img/>) — treat as a start of a void element
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in VOID:
            return

        self.depth -= 1
        if self.dropping:
            if self.depth <= self.drop_depth:
                self.drop_depth = None  # returned to where the skip began
            return

        if tag == "article" and self.scope_to_article and self.in_article:
            self.in_article -= 1
        elif tag in KEEP and self.open_keep and self.open_keep[-1] == tag:
            self.open_keep.pop()
            self.out.append(f"</{tag}>")

    def handle_data(self, data):
        if self._in_title and self.title is None and data.strip():
            self.title = data.strip()
        if self.in_article and not self.dropping and self.open_keep:
            self.out.append(data)


_TOP_TAG = re.compile(r"<(p|h2|h3|blockquote|ul|ol|figure)\b[^>]*>.*?</\1>|<img\b[^>]*>", re.S)
_BODY_TAGS = {"p", "ul", "ol", "blockquote"}


def _strip_nav_clutter(body: str) -> str:
    """Trim newsletter/nav chrome that sits OUTSIDE the article body.

    Some sources (credaily.com especially) render an article page with no
    <article> tag and a long list of other-story <h3> links in the header,
    a 'trending' rail, and the footer. Those get swept in and dominate the
    top of the reader. The real article is the run of real paragraphs, so we
    keep the slice from the first substantial body element (a <p>/<ul> with
    real text) to the last one, dropping the heading-only clutter that brackets
    it. On a clean article (starts and ends with paragraphs) this is a no-op."""
    toks = list(_TOP_TAG.finditer(body))
    if len(toks) < 2:
        return body
    def tag(m):
        return m.group(1) or "img"
    def wc(s):
        return len(re.sub(r"<[^>]+>", " ", s).split())
    body_idx = [i for i, m in enumerate(toks) if tag(m) in _BODY_TAGS and wc(m.group(0)) >= 4]
    if not body_idx:
        return body
    start, end = body_idx[0], body_idx[-1]
    # nothing to trim if the body already spans the whole thing
    if start == 0 and end == len(toks) - 1:
        return body
    return "".join(toks[i].group(0) for i in range(start, end + 1))


def _looks_blocked(html: str) -> bool:
    """A Cloudflare/anti-bot interstitial rather than the real article. The
    'Just a moment…' title is Cloudflare's challenge page — an unambiguous
    signal on its own (no real article is titled that), so we don't also
    require the challenge-platform script, which some variants omit."""
    low = html[:4000].lower()
    return "just a moment" in low or \
           ("attention required" in low and "cloudflare" in low) or \
           ("enable javascript and cookies to continue" in low) or len(html) < 1200


def _fetch_direct(url: str) -> tuple[str, str]:
    headers = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
               "Accept-Language": "en-US,en;q=0.9"}
    cookie = _session_cookie(url)
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        # resp.geturl() is the URL after any redirects — the real publisher's page
        return resp.read().decode("utf-8", errors="replace"), resp.geturl()


def _fetch_via_proxy(url: str) -> tuple[str, str]:
    """Fetch through the Supabase fetch-proxy edge function — works where the
    run environment's egress is blocked, or where a site rate-limits our IP but
    not Supabase's. The proxy forwards the TRD cookie and follows redirects, and
    reports the post-redirect `finalUrl` so we can credit the real publisher."""
    pu = f"{SUPABASE_URL}/functions/v1/fetch-proxy?url=" + urllib.parse.quote(url, safe="")
    req = urllib.request.Request(pu, headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        doc = json.load(resp)
    if doc.get("html"):
        return doc["html"], doc.get("finalUrl") or url
    raise RuntimeError(doc.get("error") or f"proxy status {doc.get('status')}")


def _get_html(url: str) -> tuple[str, str]:
    """Direct fetch first; fall back to the edge proxy on failure or a bot wall.
    Returns (html, final_url_after_redirects)."""
    try:
        html, final = _fetch_direct(url)
        if not _looks_blocked(html):
            return html, final
    except Exception:
        pass  # egress blocked, timeout, 403 — try the proxy
    return _fetch_via_proxy(url)


def extract_from_html(html: str, url: str, final_url: str | None = None) -> dict:
    """Extract reader content from already-fetched page HTML. Shared by the
    HTTP path (extract below) and the headless-browser filler
    (scripts/fill_browser.py), so both produce identical output."""
    is_trd = "therealdeal.com" in urllib.parse.urlparse(final_url or url).netloc
    final_url = final_url or url
    blocked = _looks_blocked(html)
    has_article_tag = "<article" in html

    def run(junk_classes: bool):
        p = ArticleExtractor(scope_to_article=has_article_tag, junk_classes=junk_classes)
        p.feed(html)
        body = "".join(p.out)
        # tidy: drop empty paragraphs, collapse whitespace
        body = re.sub(r"<(p|h2|h3|li|blockquote)>\s*</\1>", "", body)
        body = re.sub(r"[ \t]+", " ", body)
        body = _strip_nav_clutter(body)  # drop newsletter/nav headings around the real body
        return p, body, len(re.sub(r"<[^>]+>", " ", body).split())

    # strict pass first; when a page-builder wraps the whole body in a class the
    # junk filter matches (0 words despite a real article), retry dropping by
    # tag only — _strip_nav_clutter still trims the edges
    p, body, words = run(True)
    if words < 120:
        p2, body2, words2 = run(False)
        if words2 >= 120:
            p, body, words = p2, body2, words2
    out = {
        "ok": words > 120,
        "title": p.title,
        "image": None if (p.og_image and JUNK_IMG.search(p.og_image)) else p.og_image,
        "html": body.strip(),
        "words": words,
        "finalUrl": final_url,  # after redirects — the real publisher's page
    }
    # a dead link is not a paywall: a 404 page reached via the proxy also comes
    # back short, and blaming the session sends the owner chasing cookies
    low = html.lower()
    if not out["ok"] and ("page not found" in low[:8000] or "error-404" in low[:8000]):
        out["notFound"] = True
    # a short TRD result otherwise usually means the session cookie is
    # missing/expired — surface it so the pipeline can flag it in the day's notes
    elif is_trd and not out["ok"]:
        out["paywalled"] = True
    # distinguish "hit a bot wall" (transient, worth retrying) from a genuinely
    # empty/short article, so callers report it honestly instead of "0 words"
    if not out["ok"] and blocked:
        out["blocked"] = True
    return out


def extract(url: str) -> dict:
    html, final_url = _get_html(url)
    return extract_from_html(html, url, final_url)


# Common title words that aren't distinctive subjects — English function words,
# calendar terms, and generic real-estate nouns. A capitalized token NOT in here
# is treated as a proper-noun-like subject (a company, person, or place).
_TITLE_STOP = {
    "the", "a", "an", "and", "or", "but", "nor", "for", "so", "yet", "of", "to", "in", "on",
    "at", "by", "with", "from", "as", "into", "over", "under", "after", "before", "amid",
    "its", "his", "her", "their", "this", "that", "these", "those", "up", "out", "off", "than",
    "more", "less", "most", "new", "old", "first", "second", "third", "one", "two", "three", "four",
    "office", "offices", "building", "buildings", "jobs", "deal", "deals", "sale", "sales", "sells",
    "sold", "buys", "buy", "firm", "firms", "group", "real", "estate", "city", "tower", "towers",
    "project", "projects", "report", "market", "markets", "fund", "funds", "capital", "partners",
    "properties", "property", "development", "developer", "loan", "loans", "refi", "financing",
    "lease", "leases", "court", "plan", "plans", "million", "billion", "home", "homes", "housing",
    "apartment", "apartments", "hotel", "retail", "industrial", "north", "south", "east", "west",
    "cuts", "scores", "adds", "opens", "closes", "eyes", "lands", "wins", "faces", "seeks",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "january", "february", "march", "april", "may", "june", "july", "august", "september",
    "october", "november", "december",
}


def _proper_tokens(title: str) -> list[str]:
    out = []
    for t in re.findall(r"[A-Za-z][A-Za-z.&'-]{2,}", title or ""):
        if t[0].isupper() and t.lower() not in _TITLE_STOP:
            out.append(t.lower().strip(".&'-"))
    return out


def title_mismatch(story_title: str, res: dict) -> bool:
    """True when a story's headline shares NO distinctive proper noun with the
    article that was actually fetched — a strong sign the url pointed at the
    wrong article (e.g. a newsletter link mis-paired to a headline). Conservative
    by design: it needs 2+ distinctive tokens in the headline and zero of them
    present in the fetched title/body, so a merely-rewritten headline is never
    falsely rejected."""
    toks = _proper_tokens(story_title)
    if len(toks) < 2:
        return False
    hay = ((res.get("title") or "") + " " + re.sub(r"<[^>]+>", " ", res.get("html") or "")).lower()
    return not any(re.search(r"\b" + re.escape(t) + r"\b", hay) for t in toks)


if __name__ == "__main__":
    try:
        print(json.dumps(extract(sys.argv[1])))
    except Exception as e:  # noqa: BLE001 - report any fetch failure as not-ok
        print(json.dumps({"ok": False, "error": str(e)}))
