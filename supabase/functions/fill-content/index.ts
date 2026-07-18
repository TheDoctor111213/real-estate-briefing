// fill-content: serverless STANDBY content-filler (layer 4 of the failover chain).
//
// A pg_cron job (fill-heartbeat-standby, every 15 min) invokes this function.
// While the primary filler (the GitHub Actions headless-browser workflow) is
// alive — its pulse in the `secrets` row `fill_heartbeat` is fresh — this
// function exits immediately. When the pulse goes stale, it takes over with
// plain-HTTP fetching + DOM extraction, filling a small batch per invocation
// (edge CPU limits) until the queue drains across invocations.
//
// Honest limit: no browser here, so Cloudflare-JS-walled pages stay for the
// browser layers (GitHub Actions / the owner's Mac watchdog). It pulses ONLY
// on real progress (via: supabase-edge), never on no-ops, so a dead primary
// stays visible to the deeper layers.
//
// GET/POST ?date=YYYY-MM-DD (default today ET) &force=1 (skip standby check)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { parseHTML } from "https://esm.sh/linkedom@0.18.5/worker";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const HEADERS = { "Content-Type": "application/json" };
const MIN_WORDS = 120;
const BATCH = 4;            // stories per invocation — stay inside edge limits
const STALE_AFTER_MIN = 45; // primary pulses every 30 min

const DROP = "script,style,noscript,iframe,form,aside,nav,footer,header,svg,button";
const JUNK = /related|share|social|newsletter|promo|ad-|advert|subscribe|paywall|comment|footer|nav|menu|sidebar|recirc|trending|signup|modal|byline-block/i;
const KEEP = "p,h2,h3,blockquote,ul,ol,figure,img";

const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean).length;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function looksBlocked(html: string): boolean {
  const low = html.slice(0, 4000).toLowerCase();
  return low.includes("just a moment") ||
    (low.includes("attention required") && low.includes("cloudflare")) ||
    low.includes("enable javascript and cookies to continue") || html.length < 1200;
}

function goodImg(el: Element): string | null {
  const src = el.getAttribute("src") || el.getAttribute("data-src") || "";
  if (!src.startsWith("http")) return null;
  const m = src.match(/-(\d+)x(\d+)\.(?:jpe?g|png|webp|gif)$/);
  if (m && parseInt(m[1]) < 400) return null; // small WP thumbs
  const alt = esc(el.getAttribute("alt") || "");
  return `<img src="${esc(src)}" alt="${alt}">`;
}

function serialize(el: Element): { html: string; words: number; isBody: boolean } | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "img") {
    const img = goodImg(el);
    return img ? { html: img, words: 0, isBody: false } : null;
  }
  if (tag === "figure") {
    const img = el.querySelector("img");
    const imgHtml = img ? goodImg(img) : null;
    const cap = el.querySelector("figcaption")?.textContent?.trim() || "";
    if (!imgHtml && !cap) return null;
    return { html: `<figure>${imgHtml || ""}${cap ? `<figcaption>${esc(cap)}</figcaption>` : ""}</figure>`, words: 0, isBody: false };
  }
  if (tag === "ul" || tag === "ol") {
    const items = [...el.querySelectorAll("li")]
      .map((li) => (li.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    if (!items.length) return null;
    const text = items.join(" ");
    return { html: `<${tag}>${items.map((t) => `<li>${esc(t)}</li>`).join("")}</${tag}>`,
             words: wordsOf(text), isBody: true };
  }
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return { html: `<${tag}>${esc(text)}</${tag}>`, words: wordsOf(text),
           isBody: tag === "p" || tag === "blockquote" };
}

function extractPass(doc: Document, junkClasses: boolean): { html: string; words: number } {
  const root = (doc.querySelector("article") || doc.querySelector("body") || doc.documentElement)!
    .cloneNode(true) as Element;
  for (const el of [...root.querySelectorAll(DROP)]) el.remove();
  if (junkClasses) {
    for (const el of [...root.querySelectorAll("[class],[id]")]) {
      const sig = `${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""}`;
      if (JUNK.test(sig)) el.remove();
    }
  }
  // collect top-level KEEP elements in document order (skip nested duplicates)
  const picked: Element[] = [];
  for (const el of [...root.querySelectorAll(KEEP)]) {
    if (picked.some((p) => p.contains(el))) continue;
    picked.push(el);
  }
  const blocks = picked.map(serialize).filter(Boolean) as { html: string; words: number; isBody: boolean }[];
  // nav-clutter trim: keep first..last substantial body block
  const idx = blocks.map((b, i) => (b.isBody && b.words >= 4 ? i : -1)).filter((i) => i >= 0);
  const sliced = idx.length ? blocks.slice(idx[0], idx[idx.length - 1] + 1) : blocks;
  const html = sliced.map((b) => b.html).join("");
  return { html, words: sliced.reduce((s, b) => s + b.words, 0) };
}

function extract(html: string): { ok: boolean; html: string; words: number; image: string | null; blocked: boolean } {
  const blocked = looksBlocked(html);
  const { document: doc } = parseHTML(html);
  let res = extractPass(doc, true);
  if (res.words < MIN_WORDS) {
    const relaxed = extractPass(doc, false); // page-builder wrapped body in a junk-matching class
    if (relaxed.words >= MIN_WORDS) res = relaxed;
  }
  const image = doc.querySelector('meta[property="og:image"]')?.getAttribute("content") || null;
  return { ok: res.words > MIN_WORDS, html: res.html, words: res.words, image, blocked };
}

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
               "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
               ...(init.headers || {}) },
  });
}

async function sessionCookie(hostname: string): Promise<string | null> {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  const parts = h.split(".");
  const domain = parts.length >= 2 ? parts.slice(-2).join(".") : h;
  const ids = [`session_${domain}`];
  if (domain === "therealdeal.com") ids.push("trd_session");
  for (const id of ids) {
    try {
      const rows = await (await sb(`secrets?id=eq.${id}&select=data`)).json();
      const c = rows?.[0]?.data?.cookie;
      if (c) return c;
    } catch { /* next */ }
  }
  return null;
}

const isWrapper = (u: string) => {
  try {
    const h = new URL(u).hostname;
    return ["list-manage.com", "beehiiv.com", "mailchi.mp"].some((w) => h.endsWith(w));
  } catch { return false; }
};

function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

Deno.serve(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const date = params.get("date") || todayET();
  const force = params.get("force") === "1";

  // standby: act only when the primary's pulse is stale
  if (!force) {
    try {
      const rows = await (await sb("secrets?id=eq.fill_heartbeat&select=data")).json();
      const last = rows?.[0]?.data?.lastRun;
      if (last) {
        const ageMin = (Date.now() - Date.parse(last)) / 60000;
        if (ageMin <= STALE_AFTER_MIN) {
          return new Response(JSON.stringify({ ok: true, standby: true, pulseAgeMin: Math.round(ageMin) }), { headers: HEADERS });
        }
      }
    } catch { /* no pulse readable → act */ }
  }

  const dayRows = await (await sb(`days?date=eq.${date}&select=data`)).json();
  const day = dayRows?.[0]?.data;
  if (!day) return new Response(JSON.stringify({ ok: true, note: `no day for ${date}` }), { headers: HEADERS });

  const stories: Record<string, unknown>[] = day.stories || [];
  const wordsIn = (h: unknown) => wordsOf(String(h || "").replace(/<[^>]+>/g, " "));
  const targets = stories.filter((s) =>
    wordsIn(s.content) < MIN_WORDS && s.url && !s.brief).slice(0, BATCH);
  if (!targets.length) {
    return new Response(JSON.stringify({ ok: true, note: "nothing to fill" }), { headers: HEADERS });
  }

  const filled: string[] = [], failed: string[] = [];
  for (const s of targets) {
    try {
      const u = new URL(String(s.url));
      const h: Record<string, string> = { "User-Agent": UA, "Accept": "text/html,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" };
      const cookie = await sessionCookie(u.hostname);
      if (cookie) h["Cookie"] = cookie;
      const res = await fetch(u.href, { headers: h, redirect: "follow" });
      const html = await res.text();
      const out = extract(html);
      if (res.url && isWrapper(String(s.url)) && !isWrapper(res.url)) {
        const f = new URL(res.url);
        s.url = `${f.protocol}//${f.host}${f.pathname}`; // canonical publisher URL
      }
      if (out.ok && out.words > wordsIn(s.content)) {
        s.content = out.html;
        if (!s.image && out.image) s.image = out.image;
        delete s.sourceBlocked;
        filled.push(String(s.id));
      } else {
        failed.push(String(s.id));
      }
    } catch {
      failed.push(String(s.id));
    }
  }

  if (filled.length) {
    day.generatedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    await sb("days", { method: "POST", body: JSON.stringify({ date: day.date, data: day, generated_at: day.generatedAt }) });
    // pulse ONLY on progress — a no-op standby must not mask a dead primary
    await sb("secrets", { method: "POST", body: JSON.stringify({ id: "fill_heartbeat", data: {
      lastRun: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      date, filled: filled.length, failed: failed.length, via: "supabase-edge",
    } }) });
  }

  return new Response(JSON.stringify({ ok: true, date, filled, failed }), { headers: HEADERS });
});
