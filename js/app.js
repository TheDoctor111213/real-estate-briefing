/* Real Estate Briefing — views: briefing / map / weekly / history, plus reader overlay.
   Hash routes: #/ · #/day/DATE · #/story/DATE/ID · #/map · #/weekly · #/history
   Data lives in Supabase (public-read); the pipeline upserts via scripts/push_data.py. */

const SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co";
const SUPABASE_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y";

async function sb(query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    cache: "no-store",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}`);
  return res.json();
}

const state = {
  dates: [],
  weeks: [],
  currentDate: null,
  days: new Map(),   // date -> day json
  weeksData: new Map(),
  map: null,
  markers: null,
  mapMode: "day",
};

const $ = (id) => document.getElementById(id);

/* ---------- boot ---------- */

async function fetchIndex() {
  const [days, weeks] = await Promise.all([
    sb("days?select=date&order=date.asc"),
    sb("weeks?select=week_of&order=week_of.asc"),
  ]);
  state.dates = days.map((r) => r.date);
  state.weeks = weeks.map((r) => r.week_of);
}

async function init() {
  try {
    await fetchIndex();
  } catch { /* leave empty */ }

  state.currentDate = state.dates[state.dates.length - 1] || null;

  $("prev-day").addEventListener("click", () => stepDay(-1));
  $("next-day").addEventListener("click", () => stepDay(1));
  $("refresh-btn").addEventListener("click", () => refreshData(false));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshData(true);
  });
  setInterval(() => { if (!document.hidden) refreshData(true); }, 10 * 60 * 1000);
  $("reader-back").addEventListener("click", () => closeReaderNav());
  $("map-mode-day").addEventListener("click", () => setMapMode("day"));
  $("map-mode-all").addEventListener("click", () => setMapMode("all"));
  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("reader").hidden) closeReaderNav();
  });

  route();
}

async function getDay(date) {
  if (!date) return null;
  if (state.days.has(date)) return state.days.get(date);
  try {
    const rows = await sb(`days?date=eq.${date}&select=data`);
    const day = rows[0]?.data ?? null;
    if (day) state.days.set(date, day);
    return day;
  } catch { return null; }
}

async function getWeek(weekOf) {
  if (!weekOf) return null;
  if (state.weeksData.has(weekOf)) return state.weeksData.get(weekOf);
  try {
    const rows = await sb(`weeks?week_of=eq.${weekOf}&select=data`);
    const wk = rows[0]?.data ?? null;
    if (wk) state.weeksData.set(weekOf, wk);
    return wk;
  } catch { return null; }
}

/* Re-fetch index + current day + latest week from disk; re-render if anything changed.
   silent=true (auto): no toast unless there's new data, and never disturb an open reader. */
let refreshing = false;
let toastTimer;

async function refreshData(silent) {
  if (refreshing) return;
  refreshing = true;
  const btn = $("refresh-btn");
  btn.classList.add("spin");
  try {
    await fetchIndex();

    const latest = state.dates[state.dates.length - 1] || null;
    const target = state.currentDate && state.dates.includes(state.currentDate) ? state.currentDate : latest;

    const before = target ? state.days.get(target)?.generatedAt : null;
    if (target) state.days.delete(target);
    if (latest && latest !== target) state.days.delete(latest);
    const wk = state.weeks[state.weeks.length - 1];
    if (wk) state.weeksData.delete(wk);

    const fresh = target ? await getDay(target) : null;
    state.currentDate = target;
    const changed = !!fresh && fresh.generatedAt !== before;

    const readerOpen = !$("reader").hidden;
    if ((changed && !readerOpen) || !silent) route();
    if (changed) flashToast("Briefing updated");
    else if (!silent) flashToast("Up to date — new editions arrive with the next compile");
  } catch {
    if (!silent) flashToast("Refresh failed");
  }
  btn.classList.remove("spin");
  refreshing = false;
}

function flashToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}

function formatDate(iso, opts) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", opts);
}

/* ---------- routing ---------- */

function route() {
  const h = location.hash;
  let m;
  if ((m = h.match(/^#\/story\/(\d{4}-\d{2}-\d{2})\/(.+)$/))) {
    openReaderRoute(m[1], m[2]);
    return;
  }
  hideReader();
  if ((m = h.match(/^#\/day\/(\d{4}-\d{2}-\d{2})$/))) {
    showView("briefing");
    renderBriefing(m[1]);
  } else if (h === "#/map") {
    showView("map");
    renderMap();
  } else if (h === "#/weekly") {
    showView("weekly");
    renderWeekly();
  } else if (h === "#/history") {
    showView("history");
    renderHistory();
  } else {
    showView("briefing");
    renderBriefing(state.currentDate);
  }
}

function showView(name) {
  for (const v of document.querySelectorAll(".view")) v.hidden = true;
  $(`view-${name}`).hidden = false;
  for (const a of document.querySelectorAll(".tabs a")) {
    a.classList.toggle("active", a.dataset.tab === name);
  }
  $("date-nav").classList.toggle("off", name !== "briefing");
  window.scrollTo(0, 0);
}

function stepDay(delta) {
  const i = state.dates.indexOf(state.currentDate) + delta;
  if (i < 0 || i >= state.dates.length) return;
  location.hash = `/day/${state.dates[i]}`;
}

/* ---------- briefing view ---------- */

async function renderBriefing(date) {
  const empty = $("empty-state");
  if (!date) {
    empty.hidden = false;
    empty.textContent = "No briefings yet.";
    $("lede-block").hidden = true;
    return;
  }
  state.currentDate = date;

  const i = state.dates.indexOf(date);
  $("current-date").textContent = formatDate(date, { month: "short", day: "numeric", year: "numeric" });
  $("prev-day").disabled = i <= 0;
  $("next-day").disabled = i >= state.dates.length - 1;

  const day = await getDay(date);
  if (!day) {
    empty.hidden = false;
    empty.textContent = "Couldn't load this briefing.";
    $("lede-block").hidden = true;
    $("feed").innerHTML = "";
    return;
  }
  empty.hidden = true;

  $("lede-block").hidden = !day.overview && !(day.keyPoints || []).length;
  $("lede").textContent = day.overview || "";
  const kp = $("key-points");
  kp.innerHTML = "";
  for (const point of day.keyPoints || []) {
    const li = document.createElement("li");
    li.textContent = point;
    kp.appendChild(li);
  }

  renderFeed(day);

  $("day-notes").hidden = !day.notes;
  if (day.notes) $("day-notes").textContent = day.notes;
  $("generated-at").textContent = day.generatedAt
    ? `Compiled ${new Date(day.generatedAt).toLocaleString("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`
    : "";
}

function readMinutes(story) {
  if (!story.content) return 0;
  const words = story.content.replace(/<[^>]+>/g, " ").split(/\s+/).length;
  return Math.max(1, Math.round(words / 220));
}

function cadenceLabel(story) {
  if (!story.cadence || story.cadence === "daily") return "";
  return story.cadence === "weekly" ? "Weekly" : "Special";
}

function storyMeta(story) {
  const span = document.createElement("div");
  span.className = "meta";
  const cad = cadenceLabel(story);
  if (cad) {
    const c = document.createElement("span");
    c.className = "cadence";
    c.textContent = cad + " · ";
    span.appendChild(c);
  }
  const bits = [(story.sources || []).join(" · ")];
  const mins = readMinutes(story);
  if (mins) bits.push(`${mins} min`);
  span.appendChild(document.createTextNode(bits.filter(Boolean).join(" · ")));
  return span;
}

function storyRow(story, date, lead) {
  const btn = document.createElement("button");
  btn.className = "story" + (lead ? " lead" : "");
  btn.addEventListener("click", () => { location.hash = `/story/${date}/${story.id}`; });

  const h3 = document.createElement("h3");
  h3.textContent = story.title;
  btn.appendChild(h3);

  if (story.summary) {
    const p = document.createElement("p");
    p.textContent = story.summary;
    btn.appendChild(p);
  }
  btn.appendChild(storyMeta(story));
  return btn;
}

function sectionHead(label) {
  const h2 = document.createElement("h2");
  h2.className = "section-head";
  h2.textContent = label;
  return h2;
}

function renderFeed(day) {
  const feed = $("feed");
  feed.innerHTML = "";
  const stories = day.stories || [];

  if (!stories.length) {
    const p = document.createElement("p");
    p.style.cssText = "font-style:italic;color:var(--ink-2);padding:30px 0;text-align:center";
    p.textContent = "No newsletters arrived this day.";
    feed.appendChild(p);
    return;
  }

  const featured = stories.filter((s) => s.featured);
  const rest = stories.filter((s) => !s.featured);

  if (featured.length) {
    feed.appendChild(sectionHead("Top Stories"));
    featured.forEach((s, i) => feed.appendChild(storyRow(s, day.date, i === 0)));
  }

  const groups = new Map();
  for (const s of rest) {
    const key = s.section || "More";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  for (const [name, list] of ordered) {
    feed.appendChild(sectionHead(name));
    list.forEach((s) => feed.appendChild(storyRow(s, day.date, false)));
  }
}

/* ---------- map view ---------- */

function setMapMode(mode) {
  state.mapMode = mode;
  $("map-mode-day").classList.toggle("on", mode === "day");
  $("map-mode-all").classList.toggle("on", mode === "all");
  renderMap();
}

async function renderMap() {
  const canvas = $("map-canvas");
  if (typeof L === "undefined") {
    canvas.innerHTML = "<p style='padding:20px;font-size:13px;color:var(--ink-2)'>Map library couldn't load (offline?). Try again once connected.</p>";
    return;
  }

  if (!state.map) {
    state.map = L.map("map-canvas", { scrollWheelZoom: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(state.map);
    state.markers = L.layerGroup().addTo(state.map);
  }

  const dates = state.mapMode === "all" ? state.dates : [state.currentDate].filter(Boolean);
  $("map-title").textContent = state.mapMode === "all"
    ? `All coverage · ${state.dates.length} day${state.dates.length === 1 ? "" : "s"}`
    : (state.currentDate ? formatDate(state.currentDate, { weekday: "long", month: "long", day: "numeric" }) : "");

  state.markers.clearLayers();
  const pts = [];

  for (const date of dates) {
    const day = await getDay(date);
    for (const story of day?.stories || []) {
      for (const loc of story.locations || []) {
        if (typeof loc.lat !== "number" || typeof loc.lng !== "number") continue;
        pts.push([loc.lat, loc.lng]);
        const marker = L.circleMarker([loc.lat, loc.lng], {
          radius: 8, weight: 2, color: "#8a3324", fillColor: "#8a3324", fillOpacity: 0.35,
        });
        const div = document.createElement("div");
        div.className = "map-popup";
        const h4 = document.createElement("h4");
        h4.textContent = story.title;
        h4.addEventListener("click", () => { location.hash = `/story/${date}/${story.id}`; });
        const meta = document.createElement("div");
        meta.className = "pop-meta";
        meta.textContent = `${story.section || ""} · ${formatDate(date, { month: "short", day: "numeric" })}`;
        const locEl = document.createElement("div");
        locEl.className = "pop-loc";
        locEl.textContent = loc.label || "";
        div.append(h4, meta, locEl);
        marker.bindPopup(div, { maxWidth: 260 });
        state.markers.addLayer(marker);
      }
    }
  }

  // let the container get its size before fitting
  requestAnimationFrame(() => {
    state.map.invalidateSize();
    if (pts.length > 1) state.map.fitBounds(pts, { padding: [36, 36] });
    else if (pts.length === 1) state.map.setView(pts[0], 11);
    else state.map.setView([39.5, -95], 4); // continental US
  });
}

/* ---------- weekly view ---------- */

async function renderWeekly() {
  const wrap = $("weekly-content");
  wrap.innerHTML = "";
  const latest = state.weeks[state.weeks.length - 1];
  const wk = await getWeek(latest);

  if (!wk) {
    const p = document.createElement("p");
    p.style.cssText = "font-style:italic;color:var(--ink-2);padding:40px 0;text-align:center";
    p.textContent = "No weekly summary yet — it builds as the week's briefings come in.";
    wrap.appendChild(p);
    return;
  }

  const label = document.createElement("div");
  label.className = "week-label";
  label.textContent = `The Week · ${formatDate(wk.weekOf, { month: "long", day: "numeric" })}–${formatDate(addDays(wk.weekOf, 6), { month: "long", day: "numeric" })}`;
  wrap.appendChild(label);

  if (wk.overview) {
    const p = document.createElement("p");
    p.className = "week-overview";
    p.textContent = wk.overview;
    wrap.appendChild(p);
  }

  if ((wk.themes || []).length) {
    wrap.appendChild(sectionHead("Themes"));
    for (const t of wk.themes) {
      const box = document.createElement("div");
      box.className = "theme";
      const h3 = document.createElement("h3");
      h3.textContent = t.title;
      const p = document.createElement("p");
      p.textContent = t.body;
      box.append(h3, p);
      wrap.appendChild(box);
    }
  }

  if ((wk.topStories || []).length) {
    const div = document.createElement("div");
    div.className = "week-stories";
    div.appendChild(sectionHead("Stories of the Week"));
    for (const s of wk.topStories) {
      const btn = document.createElement("button");
      btn.className = "week-story";
      btn.addEventListener("click", () => { location.hash = `/story/${s.day}/${s.id}`; });
      const h4 = document.createElement("h4");
      h4.textContent = s.title;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${s.source || ""} · ${formatDate(s.day, { weekday: "short", month: "short", day: "numeric" })}`;
      btn.append(h4, meta);
      div.appendChild(btn);
    }
    wrap.appendChild(div);
  }

  if (wk.notes) {
    const p = document.createElement("p");
    p.className = "week-notes";
    p.textContent = wk.notes;
    wrap.appendChild(p);
  }
}

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/* ---------- history view ---------- */

async function renderHistory() {
  const wrap = $("history-list");
  wrap.innerHTML = "";
  if (!state.dates.length) {
    wrap.textContent = "No briefings yet.";
    return;
  }
  for (const date of state.dates.slice().reverse()) {
    const day = await getDay(date);
    const card = document.createElement("button");
    card.className = "day-card";
    card.addEventListener("click", () => { location.hash = `/day/${date}`; });

    const h3 = document.createElement("h3");
    h3.textContent = formatDate(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    card.appendChild(h3);

    if (day?.overview) {
      const p = document.createElement("p");
      p.textContent = day.overview;
      card.appendChild(p);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const n = day?.stories?.length ?? 0;
    const sections = [...new Set((day?.stories || []).map((s) => s.section).filter(Boolean))];
    meta.textContent = `${n} ${n === 1 ? "story" : "stories"}${sections.length ? " · " + sections.join(" · ") : ""}`;
    card.appendChild(meta);

    wrap.appendChild(card);
  }
}

/* ---------- reader ---------- */

async function openReaderRoute(date, id) {
  const day = await getDay(date);
  const story = (day?.stories || []).find((s) => s.id === id);
  if (!story) { location.hash = "/"; return; }

  $("reader-kicker").textContent = [story.section, cadenceLabel(story)].filter(Boolean).join(" · ");
  $("reader-title").textContent = story.title;

  const mins = readMinutes(story);
  $("reader-meta").textContent = [
    (story.sources || []).join(" · "),
    formatDate(date, { weekday: "long", month: "long", day: "numeric" }),
    mins ? `${mins} min read` : null,
  ].filter(Boolean).join("  ·  ");

  const hero = $("reader-hero");
  const heroImg = $("reader-hero-img");
  if (story.image) {
    heroImg.src = story.image;
    heroImg.alt = story.title;
    hero.hidden = false;
  } else {
    hero.hidden = true;
    heroImg.removeAttribute("src");
  }

  const body = $("reader-body");
  if (story.content) {
    body.innerHTML = story.content.replace(/<script[\s\S]*?<\/script>/gi, "");
    const firstImg = body.querySelector("img");
    if (firstImg && story.image && firstImg.src === story.image) firstImg.remove();
  } else {
    body.innerHTML = "";
    const p = document.createElement("p");
    p.className = "reader-fallback";
    p.textContent = (story.summary || "") + " Full text wasn't available for this story — use the link below to read it at the source.";
    body.appendChild(p);
  }

  $("reader-original").href = story.url || "#";
  $("reader-original-end").href = story.url || "#";

  const reader = $("reader");
  reader.hidden = false;
  reader.scrollTop = 0;
  document.body.classList.add("reader-open");
}

function hideReader() {
  $("reader").hidden = true;
  document.body.classList.remove("reader-open");
}

function closeReaderNav() {
  if (history.length > 1) history.back();
  else location.hash = "/";
}

init();
