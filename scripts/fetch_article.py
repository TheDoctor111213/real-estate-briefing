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


def _trd_cookie() -> str | None:
    """Subscriber session for therealdeal.com, stored by scripts/trd_session.py."""
    try:
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/secrets?id=eq.trd_session&select=data",
            headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            rows = json.load(r)
        return rows[0]["data"]["cookie"] if rows else None
    except Exception:
        return None

KEEP = {"p", "h2", "h3", "blockquote", "ul", "ol", "li", "img", "figure", "figcaption"}
DROP_SUBTREES = {"script", "style", "noscript", "iframe", "form", "aside", "nav", "footer", "header", "svg", "button"}
# class/id fragments that mark non-article chrome
JUNK = re.compile(r"related|share|social|newsletter|promo|ad-|advert|subscribe|paywall|comment|footer|nav|menu|sidebar|recirc|trending|signup|modal|byline-block", re.I)


VOID = {"img", "br", "hr", "meta", "input", "source", "link", "area", "base",
        "col", "embed", "param", "track", "wbr"}


class ArticleExtractor(HTMLParser):
    """Collect allowed elements inside <article> (or the whole body as fallback).

    Junk subtrees (nav, share widgets, related-story rails, paywall gates) are
    skipped by depth: when one opens we record its depth and drop everything
    until the parser returns to that depth. This is balanced by construction —
    a stray unclosed <div> can never leave us stuck in skip mode the way a
    plain increment/decrement counter could."""

    def __init__(self, scope_to_article: bool):
        super().__init__(convert_charrefs=True)
        self.scope_to_article = scope_to_article
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
            if not (m and int(m.group(1)) < 400) and src.startswith("http"):
                alt = (a.get("alt") or "").replace('"', "&quot;")
                self.out.append(f'<img src="{src}" alt="{alt}">')
        elif emit and (tag in DROP_SUBTREES or JUNK.search(a.get("class", "") + " " + a.get("id", ""))):
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


def _looks_blocked(html: str) -> bool:
    """A Cloudflare/anti-bot interstitial rather than the real article."""
    low = html[:4000].lower()
    return ("just a moment" in low and "challenge-platform" in html.lower()) or \
           ("attention required" in low and "cloudflare" in low) or len(html) < 1200


def _fetch_direct(url: str) -> str:
    headers = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
               "Accept-Language": "en-US,en;q=0.9"}
    if "therealdeal.com" in urllib.parse.urlparse(url).netloc:
        cookie = _trd_cookie()
        if cookie:
            headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _fetch_via_proxy(url: str) -> str:
    """Fetch through the Supabase fetch-proxy edge function — works where the
    run environment's egress is blocked, or where a site rate-limits our IP but
    not Supabase's. The proxy forwards the TRD cookie and follows redirects."""
    pu = f"{SUPABASE_URL}/functions/v1/fetch-proxy?url=" + urllib.parse.quote(url, safe="")
    req = urllib.request.Request(pu, headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        doc = json.load(resp)
    if doc.get("html"):
        return doc["html"]
    raise RuntimeError(doc.get("error") or f"proxy status {doc.get('status')}")


def _get_html(url: str) -> str:
    """Direct fetch first; fall back to the edge proxy on failure or a bot wall."""
    try:
        html = _fetch_direct(url)
        if not _looks_blocked(html):
            return html
    except Exception:
        pass  # egress blocked, timeout, 403 — try the proxy
    return _fetch_via_proxy(url)


def extract(url: str) -> dict:
    is_trd = "therealdeal.com" in urllib.parse.urlparse(url).netloc
    html = _get_html(url)

    has_article_tag = "<article" in html
    p = ArticleExtractor(scope_to_article=has_article_tag)
    p.feed(html)
    body = "".join(p.out)
    # tidy: drop empty paragraphs, collapse whitespace
    body = re.sub(r"<(p|h2|h3|li|blockquote)>\s*</\1>", "", body)
    body = re.sub(r"[ \t]+", " ", body)
    words = len(re.sub(r"<[^>]+>", " ", body).split())
    out = {
        "ok": words > 120,
        "title": p.title,
        "image": p.og_image,
        "html": body.strip(),
        "words": words,
    }
    # a short TRD result usually means the session cookie is missing/expired —
    # surface it so the pipeline can flag it in the day's notes
    if is_trd and not out["ok"]:
        out["paywalled"] = True
    return out


if __name__ == "__main__":
    try:
        print(json.dumps(extract(sys.argv[1])))
    except Exception as e:  # noqa: BLE001 - report any fetch failure as not-ok
        print(json.dumps({"ok": False, "error": str(e)}))
