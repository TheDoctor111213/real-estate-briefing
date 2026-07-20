// push-send: web-push sender for the briefing (Phase 4 alerts plumbing).
//
// GET  ?setup=1 → ensure VAPID keys exist (generated once, stored in the
//                 `secrets` row `vapid`); returns the public
//                 applicationServerKey the app subscribes with.
// POST {profiles?: string[]|null, title, body?, url?, tag?}
//               → deliver a notification to those profiles' devices
//                 (null/omitted = every subscribed device). Dead
//                 subscriptions (404/410 from the push service) are pruned.
//
// Apple's push service carries the message to installed home-screen web apps
// (iOS 16.4+). The service worker displays it and deep-links the tap.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as webpush from "jsr:@negrel/webpush@0.3.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HEADERS = { "Content-Type": "application/json" };
const CONTACT = "mailto:mfkodsi@gmail.com";

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
               "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
               ...(init.headers || {}) },
  });
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// raw uncompressed P-256 point (0x04 || x || y) from the public JWK — the
// form pushManager.subscribe() wants as applicationServerKey
function rawPublicKey(jwk: JsonWebKey): string {
  const x = b64urlToBytes(jwk.x!), y = b64urlToBytes(jwk.y!);
  const out = new Uint8Array(65);
  out[0] = 4;
  out.set(x, 1);
  out.set(y, 33);
  return b64url(out);
}

export async function loadVapid(): Promise<{ keys: CryptoKeyPair; publicKeyB64: string }> {
  const rows = await (await sb("secrets?id=eq.vapid&select=data")).json();
  let data = rows?.[0]?.data;
  if (!data?.publicJwk || !data?.privateJwk) {
    const pair = await webpush.generateVapidKeys({ extractable: true });
    const exported = await webpush.exportVapidKeys(pair);
    data = {
      publicJwk: exported.publicKey,
      privateJwk: exported.privateKey,
      publicKeyB64: rawPublicKey(exported.publicKey),
      createdAt: new Date().toISOString(),
      note: "VAPID keypair for web push — generated once by push-send ?setup=1",
    };
    await sb("secrets", { method: "POST", body: JSON.stringify({ id: "vapid", data }) });
  }
  const keys = await webpush.importVapidKeys(
    { publicKey: data.publicJwk, privateKey: data.privateJwk },
    { extractable: false },
  );
  return { keys, publicKeyB64: data.publicKeyB64 };
}

export async function deliver(
  profiles: string[] | null,
  payload: Record<string, unknown>,
): Promise<{ sent: number; pruned: number; failed: number; devices: number }> {
  const q = profiles && profiles.length
    ? `push_subs?select=id,profile,sub&profile=in.(${profiles.map((p) => `"${p}"`).join(",")})`
    : "push_subs?select=id,profile,sub";
  const subs = await (await sb(q)).json();
  const { keys } = await loadVapid();
  const server = await webpush.ApplicationServer.new({
    contactInformation: CONTACT,
    vapidKeys: keys,
  });
  let sent = 0, pruned = 0, failed = 0;
  for (const row of subs || []) {
    if (!row?.sub?.endpoint || row.sub.disabled) continue;
    try {
      const subscriber = server.subscribe(row.sub);
      await subscriber.pushTextMessage(JSON.stringify(payload), {});
      sent++;
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status ?? 0;
      const gone = status === 404 || status === 410 ||
        (e as { isGone?: () => boolean })?.isGone?.() === true;
      if (gone) {
        await sb(`push_subs?id=eq.${encodeURIComponent(row.id)}`, { method: "DELETE" });
        pruned++;
      } else {
        failed++;
      }
    }
  }
  return { sent, pruned, failed, devices: (subs || []).length };
}

Deno.serve(async (req: Request) => {
  try {
    const params = new URL(req.url).searchParams;
    if (params.get("setup") === "1") {
      const { publicKeyB64 } = await loadVapid();
      return new Response(JSON.stringify({ ok: true, publicKeyB64 }), { headers: HEADERS });
    }
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "POST a notification, or GET ?setup=1" }), { headers: HEADERS });
    }
    const body = await req.json().catch(() => ({}));
    if (!body.title) {
      return new Response(JSON.stringify({ ok: false, error: "title required" }), { headers: HEADERS });
    }
    const res = await deliver(body.profiles ?? null, {
      title: body.title,
      body: body.body || "",
      url: body.url || "./",
      tag: body.tag || undefined,
    });
    return new Response(JSON.stringify({ ok: true, ...res }), { headers: HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e).slice(0, 300) }), { headers: HEADERS });
  }
});
