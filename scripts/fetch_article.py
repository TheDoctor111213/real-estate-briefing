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


class ArticleExtractor(HTMLParser):
    """Collect allowed elements inside <article> (or the whole body as fallback)."""

    def __init__(self, scope_to_article: bool):
        super().__init__(convert_charrefs=True)
        self.scope_to_article = scope_to_article
        self.in_article = 0 if scope_to_article else 1
        self.drop = 0
        self.out = []
        self.open_keep = []  # stack of kept tags
        self.og_image = None
        self.title = None
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta" and a.get("property") == "og:image" and not self.og_image:
            self.og_image = a.get("content")
        if tag == "title":
            self._in_title = True
        if tag == "article" and self.scope_to_article:
            self.in_article += 1
            return
        if self.drop or not self.in_article:
            if tag in DROP_SUBTREES or JUNK.search(a.get("class", "") + " " + a.get("id", "")):
                self.drop += 1 if tag in DROP_SUBTREES else 0
            if tag in DROP_SUBTREES:
                self.drop += 0  # handled above
            return
        if tag in DROP_SUBTREES or JUNK.search(a.get("class", "") + " " + a.get("id", "")):
            self.drop += 1
            return
        if tag in KEEP:
            if tag == "img":
                src = a.get("src") or a.get("data-src") or ""
                # skip WordPress-style small thumbnails (related-story teasers)
                m = re.search(r"-(\d+)x(\d+)\.(?:jpe?g|png|webp|gif)$", src)
                if m and int(m.group(1)) < 400:
                    return
                if src.startswith("http"):
                    alt = (a.get("alt") or "").replace('"', "&quot;")
                    self.out.append(f'<img src="{src}" alt="{alt}">')
                return
            self.open_keep.append(tag)
            self.out.append(f"<{tag}>")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag == "article" and self.scope_to_article and self.in_article:
            self.in_article -= 1
            return
        if self.drop:
            if tag in DROP_SUBTREES or (self.open_keep and tag not in KEEP):
                self.drop = max(0, self.drop - 1)
            if tag in DROP_SUBTREES:
                return
            return
        if tag in KEEP and tag != "img" and self.open_keep and self.open_keep[-1] == tag:
            self.open_keep.pop()
            self.out.append(f"</{tag}>")

    def handle_data(self, data):
        if self._in_title and self.title is None and data.strip():
            self.title = data.strip()
        if self.in_article and not self.drop and self.open_keep:
            self.out.append(data)


def extract(url: str) -> dict:
    headers = {"User-Agent": UA, "Accept": "text/html"}
    is_trd = "therealdeal.com" in urllib.parse.urlparse(url).netloc
    if is_trd:
        cookie = _trd_cookie()
        if cookie:
            headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    html = raw.decode("utf-8", errors="replace")

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
