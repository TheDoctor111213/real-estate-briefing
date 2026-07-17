// fetch-proxy: server-side article fetcher for the briefing pipeline.
//
// The scheduled cloud routine's egress policy blocks most news domains, but
// *.supabase.co is always reachable — so scripts/fetch_article.py falls back to
// this function, which fetches the page from Supabase's network instead and
// returns the raw HTML. It follows redirects (Traded's Mailchimp wrappers land
// on traded.co) and forwards the owner's TRD session cookie for therealdeal.com.
//
// GET/POST ?url=<article-url>  →  { ok, status, finalUrl, html }  (or { ok:false, error })
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Content-Type": "application/json",
};

// SSRF hygiene: only public http(s), never internal hosts / cloud metadata.
function blocked(u: URL): string | null {
  if (u.protocol !== "http:" && u.protocol !== "https:") return "protocol";
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return "internal host";
  if (h === "169.254.169.254" || h === "metadata.google.internal") return "metadata";
  if (/^(10\.|127\.|0\.|192\.168\.|169\.254\.)/.test(h)) return "private ip";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return "private ip";
  return null;
}

// Stored subscriber session for any outlet: rows keyed `session_<domain>`
// (saved via scripts/trd_session.py --domain <site>); therealdeal.com also
// falls back to its legacy `trd_session` row.
async function sessionCookie(hostname: string): Promise<string | null> {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  const parts = h.split(".");
  const domain = parts.length >= 2 ? parts.slice(-2).join(".") : h;
  const ids = [`session_${domain}`];
  if (domain === "therealdeal.com") ids.push("trd_session");
  for (const id of ids) {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/secrets?id=eq.${id}&select=data`, {
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      });
      const rows = await res.json();
      const c = rows?.[0]?.data?.cookie;
      if (c) return c;
    } catch {
      /* try the next id */
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: HEADERS });

  const target = new URL(req.url).searchParams.get("url");
  if (!target) {
    return new Response(JSON.stringify({ ok: false, error: "missing ?url" }), { status: 400, headers: HEADERS });
  }
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "bad url" }), { status: 400, headers: HEADERS });
  }
  const why = blocked(u);
  if (why) {
    return new Response(JSON.stringify({ ok: false, error: `blocked: ${why}` }), { status: 403, headers: HEADERS });
  }

  const reqHeaders: Record<string, string> = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  const c = await sessionCookie(u.hostname);
  if (c) reqHeaders["Cookie"] = c;

  try {
    const res = await fetch(u.href, { headers: reqHeaders, redirect: "follow" });
    const html = await res.text();
    // cap payload so a runaway page can't blow the response limit (~6MB)
    const capped = html.length > 6_000_000 ? html.slice(0, 6_000_000) : html;
    return new Response(
      JSON.stringify({ ok: res.ok, status: res.status, finalUrl: res.url, html: capped }),
      { headers: HEADERS },
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 502, headers: HEADERS });
  }
});
