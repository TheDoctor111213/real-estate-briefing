// push-dispatch: the alerts brain (invoked by pg_cron every 10 minutes).
//
// The cloud routine can't send pushes (no egress), so this function watches
// the PUBLISHED data — the same pattern as the fill-content standby — and
// turns it into notifications:
//   1. breaking   — special-cadence stories in today's day → everyone opted in
//   2. ready      — the day's first edition → profiles who opted IN (off by default)
//   3. watchlist  — a watched player mentioned today → that profile
//   4. events     — a starred calendar event dated today (from ~8 AM ET)
//
// Every send is recorded in push_log first-writer-wins, so idempotent pipeline
// rebuilds can never double-ping a phone. Quiet overnight: nothing sends
// 9 PM–7 AM ET; unlogged items simply go out on the first morning run.
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

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function loadServer(): Promise<InstanceType<typeof webpush.ApplicationServer> | null> {
  const rows = await (await sb("secrets?id=eq.vapid&select=data")).json();
  const data = rows?.[0]?.data;
  if (!data?.publicJwk || !data?.privateJwk) return null; // push-send ?setup=1 not run yet
  const keys = await webpush.importVapidKeys(
    { publicKey: data.publicJwk, privateKey: data.privateJwk },
    { extractable: false },
  );
  return await webpush.ApplicationServer.new({ contactInformation: CONTACT, vapidKeys: keys });
}

function nowET(): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "0";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: parseInt(get("hour")) % 24 };
}

Deno.serve(async () => {
  try {
    const { date: today, hour } = nowET();
    // quiet overnight — everything unlogged goes out on the first morning run
    if (hour >= 21 || hour < 7) {
      return new Response(JSON.stringify({ ok: true, quiet: true }), { headers: HEADERS });
    }

    const [subRows, prefRows] = await Promise.all([
      (await sb("push_subs?select=profile,sub")).json(),
      (await sb("prefs?select=profile,data")).json(),
    ]);
    const subscribed = new Set<string>();
    for (const r of subRows || []) {
      if (r?.sub?.endpoint && !r.sub.disabled) subscribed.add(r.profile);
    }
    if (!subscribed.size) {
      return new Response(JSON.stringify({ ok: true, note: "no subscribed devices" }), { headers: HEADERS });
    }
    const notifOf = (p: string) =>
      (prefRows || []).find((r: { profile: string }) => r.profile === p)?.data?.notifications || {};
    const server = await loadServer();
    if (!server) {
      return new Response(JSON.stringify({ ok: true, note: "vapid not set up" }), { headers: HEADERS });
    }

    const loggedIds = new Set<string>(
      ((await (await sb("push_log?select=id&order=created_at.desc&limit=2000")).json()) || [])
        .map((r: { id: string }) => r.id),
    );
    const log = (id: string) =>
      sb("push_log", { method: "POST", body: JSON.stringify({ id }) });

    const deliver = async (profiles: string[], payload: Record<string, unknown>) => {
      const q = `push_subs?select=id,sub&profile=in.(${profiles.map((p) => `"${p}"`).join(",")})`;
      const subs = await (await sb(q)).json();
      for (const row of subs || []) {
        if (!row?.sub?.endpoint || row.sub.disabled) continue;
        try {
          await server.subscribe(row.sub).pushTextMessage(JSON.stringify(payload), {});
        } catch (e) {
          const status = (e as { response?: { status?: number } })?.response?.status ?? 0;
          if (status === 404 || status === 410) {
            await sb(`push_subs?id=eq.${encodeURIComponent(row.id)}`, { method: "DELETE" });
          }
        }
      }
    };

    const dayRows = await (await sb(`days?date=eq.${today}&select=data`)).json();
    const day = dayRows?.[0]?.data;
    const sentIds: string[] = [];

    // 1) breaking: special-cadence stories, one push each, ever
    for (const s of day?.stories || []) {
      if (s.cadence !== "special") continue;
      const id = `spec:${today}:${s.id}`;
      if (loggedIds.has(id)) continue;
      const to = [...subscribed].filter((p) => notifOf(p).breaking !== false);
      await log(id); // first-writer-wins before the send: reruns can't double-ping
      if (to.length) {
        await deliver(to, {
          title: `⚡ ${s.title}`,
          body: s.summary || "",
          url: `./#/story/${today}/${s.id}`,
          tag: id,
        });
        sentIds.push(id);
      }
    }

    // 2) briefing ready — opt-IN only (notifications.ready === true)
    if (day && (day.stories || []).length) {
      const id = `ready:${today}`;
      if (!loggedIds.has(id)) {
        const to = [...subscribed].filter((p) => notifOf(p).ready === true);
        await log(id);
        if (to.length) {
          await deliver(to, {
            title: "Today's briefing is ready",
            body: (day.overview || "").slice(0, 140),
            url: "./",
            tag: id,
          });
          sentIds.push(id);
        }
      }
    }

    // 3) watchlist: a watched player mentioned in today's stories
    const watchers = new Map<string, string[]>(); // profile -> watched slugs
    for (const r of prefRows || []) {
      const w = r?.data?.watchPlayers;
      if (subscribed.has(r.profile) && Array.isArray(w) && w.length &&
          notifOf(r.profile).watch !== false) watchers.set(r.profile, w);
    }
    if (watchers.size) {
      const union = [...new Set([...watchers.values()].flat())];
      const playerRows = await (await sb(
        `players?select=slug,data&slug=in.(${union.map((s) => `"${s}"`).join(",")})`,
      )).json();
      const todayMentions = new Map<string, { name: string; id: string; title: string }[]>();
      for (const row of playerRows || []) {
        const hits = (row.data?.mentions || []).filter((m: { date: string }) => m.date === today);
        if (hits.length) todayMentions.set(row.slug, hits.map((m: { id: string; title: string }) =>
          ({ name: row.data.name, id: m.id, title: m.title })));
      }
      for (const [profile, slugs] of watchers) {
        const fresh: { name: string; id: string; title: string }[] = [];
        for (const slug of slugs) {
          for (const m of todayMentions.get(slug) || []) {
            const id = `watch:${profile}:${today}:${slug}:${m.id}`;
            if (loggedIds.has(id)) continue;
            await log(id);
            fresh.push(m);
          }
        }
        if (fresh.length) {
          const names = [...new Set(fresh.map((f) => f.name))];
          await deliver([profile], {
            title: `${names.slice(0, 2).join(" and ")}${names.length > 2 ? ` +${names.length - 2}` : ""} in today's briefing`,
            body: fresh[0].title,
            url: fresh.length === 1 ? `./#/story/${today}/${fresh[0].id}` : "./",
            tag: `watch:${profile}:${today}`,
          });
          sentIds.push(`watch:${profile}:${today}(${fresh.length})`);
        }
      }
    }

    // 4) starred calendar events dated today (morning reminder, from 8 AM)
    if (hour >= 8) {
      const evRows = await (await sb("events?select=id,data")).json();
      const todays = (evRows || []).filter((r: { data?: { date?: string } }) => r.data?.date === today);
      if (todays.length) {
        for (const r of prefRows || []) {
          const stars = r?.data?.starEvents;
          if (!subscribed.has(r.profile) || !Array.isArray(stars) || !stars.length) continue;
          for (const ev of todays) {
            if (!stars.includes(ev.id)) continue;
            const id = `event:${r.profile}:${ev.id}`;
            if (loggedIds.has(id)) continue;
            await log(id);
            await deliver([r.profile], {
              title: `Today: ${ev.data.title}`,
              body: ev.data.market && ev.data.market !== "National" ? ev.data.market : "",
              url: "./",
              tag: id,
            });
            sentIds.push(id);
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, date: today, sent: sentIds }), { headers: HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e).slice(0, 300) }), { headers: HEADERS });
  }
});
