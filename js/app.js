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

/* One visual language for story types: same emoji + color in feed chips,
   map pins, and legends. */
const DEAL_TYPES = {
  Sale:        { emoji: "💰", color: "#2e7d32" },
  Financing:   { emoji: "🏦", color: "#1565c0" },
  Lease:       { emoji: "📝", color: "#6d4fa3" },
  Development: { emoji: "🏗️", color: "#b26a00" },
  Distress:    { emoji: "⚠️", color: "#c62828" },
  Legal:       { emoji: "⚖️", color: "#8d6e63" },
  Policy:      { emoji: "🏛️", color: "#455a64" },
  Industry:    { emoji: "🏢", color: "#00838f" },
  Markets:     { emoji: "📊", color: "#5d4037" },
};

function typeInfo(t) {
  return DEAL_TYPES[t] || { emoji: "📰", color: "#8a94a0" };
}

function fmtValue(n) {
  if (!n) return null;
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(n % 1e9 ? 1 : 0) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(n % 1e6 >= 1e5 ? 1 : 0).replace(/\.0$/, "") + "M";
  return "$" + Math.round(n / 1e3) + "K";
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
  filters: { type: null, asset: null, market: null },
  groupBy: "section",
  mapTypeFilter: null, // null = all; otherwise a Set of dealTypes
  controlsDate: null,  // filters reset when the viewed day changes
  rateChart: "curve",  // "curve" | "forward" | "history"
  histKey: null,       // which pane's trend is showing: "5Y" | "10Y" | "30Y" | "SOFR"
  histRange: "3M",     // "1M" | "3M" | "6M" | "1Y"
  fwdHorizon: "1Y",    // forward-view horizon: "30D" | "90D" | "6M" | "1Y" | "3Y" | "5Y"
};

const FWD_HORIZONS = { "30D": 1, "90D": 3, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60 };

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
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshData(true);
  });
  setInterval(() => { if (!document.hidden) refreshData(true); }, 10 * 60 * 1000);
  loadRates();
  // the curve's geometry is viewport-dependent; rebuild when crossing the breakpoint
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!$("view-rates").hidden) renderRates(); }, 200);
  });
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
    if (changed && !readerOpen) route();
    if (changed) flashToast("Briefing updated");
    loadRates();
  } catch { /* silent background refresh */ }
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
  } else if (h === "#/rates") {
    showView("rates");
    renderRates();
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
  // the masthead ticker is redundant on the Rates page itself
  $("rate-strip").classList.toggle("off", name === "rates");
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

  if (state.controlsDate !== date) {
    state.filters = { type: null, asset: null, market: null };
    state.controlsDate = date;
  }
  renderControls(day);
  renderFeed(day);

  $("day-notes").hidden = !day.notes;
  if (day.notes) $("day-notes").textContent = day.notes;
  $("generated-at").textContent = day.generatedAt
    ? `Compiled ${new Date(day.generatedAt).toLocaleString("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`
    : "";
}

function contentWords(story) {
  if (!story.content) return 0;
  return story.content.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
}

function readMinutes(story) {
  const words = contentWords(story);
  return words ? Math.max(1, Math.round(words / 220)) : 0;
}

/* A card is worth opening only when the article holds meaningfully more text
   than the card already shows (short Traded blurbs are fully visible in place). */
function isExpandable(story) {
  return contentWords(story) >= 80;
}

function cadenceLabel(story) {
  if (!story.cadence || story.cadence === "daily") return "";
  return story.cadence === "weekly" ? "Weekly" : "Special";
}

function storyMeta(story, expandable) {
  const row = document.createElement("div");
  row.className = "meta";
  const left = document.createElement("span");
  const cad = cadenceLabel(story);
  if (cad) {
    const c = document.createElement("span");
    c.className = "cadence";
    c.textContent = cad + " · ";
    left.appendChild(c);
  }
  const bits = [(story.sources || []).join(" · ")];
  if (expandable) {
    const mins = readMinutes(story);
    if (mins) bits.push(`${mins} min`);
  }
  left.appendChild(document.createTextNode(bits.filter(Boolean).join(" · ")));
  row.appendChild(left);

  if (expandable) {
    const open = document.createElement("span");
    open.className = "meta-open";
    open.textContent = "Read ›";
    row.appendChild(open);
  } else if (story.url) {
    const a = document.createElement("a");
    a.className = "meta-source";
    a.href = story.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Source ↗";
    row.appendChild(a);
  }
  return row;
}

function chip(text, cls) {
  const span = document.createElement("span");
  span.className = "chip" + (cls ? " " + cls : "");
  span.textContent = text;
  return span;
}

function storyChips(story) {
  const wrap = document.createElement("div");
  wrap.className = "chips";
  if (story.dealType) {
    const t = typeInfo(story.dealType);
    const c = chip(`${t.emoji} ${story.dealType}`, "chip-type");
    c.style.borderColor = t.color + "55";
    wrap.appendChild(c);
  }
  if (story.assetClass) wrap.appendChild(chip(story.assetClass));
  if (story.market) wrap.appendChild(chip(story.market));
  const v = fmtValue(story.valueUsd);
  if (v) wrap.appendChild(chip(v, "chip-value"));
  return wrap.children.length ? wrap : null;
}

function storyRow(story, date, lead) {
  const expandable = isExpandable(story);
  const el = document.createElement(expandable ? "button" : "div");
  el.className = "story" + (lead ? " lead" : "") + (expandable ? "" : " static");
  if (expandable) {
    el.addEventListener("click", () => { location.hash = `/story/${date}/${story.id}`; });
  }

  const h3 = document.createElement("h3");
  h3.textContent = story.title;
  el.appendChild(h3);

  if (story.summary) {
    const p = document.createElement("p");
    p.textContent = story.summary;
    el.appendChild(p);
  }
  const chips = storyChips(story);
  if (chips) el.appendChild(chips);
  el.appendChild(storyMeta(story, expandable));
  return el;
}

function sectionHead(label) {
  const h2 = document.createElement("h2");
  h2.className = "section-head";
  h2.textContent = label;
  return h2;
}

/* ---------- controls (filters + grouping) ---------- */

function counts(stories, key) {
  const m = new Map();
  for (const s of stories) {
    const v = s[key];
    if (v) m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function makeSelect(label, options, current, onChange) {
  const sel = document.createElement("select");
  sel.className = "ctl-select";
  const first = document.createElement("option");
  first.value = "";
  first.textContent = label;
  sel.appendChild(first);
  for (const [name, n] of options) {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = `${name} (${n})`;
    sel.appendChild(o);
  }
  sel.value = current || "";
  sel.addEventListener("change", () => onChange(sel.value || null));
  return sel;
}

function renderControls(day) {
  const bar = $("controls");
  const stories = day.stories || [];
  bar.hidden = stories.length < 6; // controls only earn their space on busy days
  if (bar.hidden) return;
  bar.innerHTML = "";

  // deal-type chips
  const typeRow = document.createElement("div");
  typeRow.className = "type-chips";
  for (const [name, n] of counts(stories, "dealType")) {
    const t = typeInfo(name);
    const b = document.createElement("button");
    b.className = "chip chip-filter" + (state.filters.type === name ? " on" : "");
    b.textContent = `${t.emoji} ${name} ${n}`;
    if (state.filters.type === name) {
      b.style.background = t.color;
      b.style.borderColor = t.color;
    }
    b.addEventListener("click", () => {
      state.filters.type = state.filters.type === name ? null : name;
      renderControls(day);
      renderFeed(day);
    });
    typeRow.appendChild(b);
  }
  bar.appendChild(typeRow);

  // asset / market / group-by selects
  const row2 = document.createElement("div");
  row2.className = "ctl-row";
  row2.appendChild(makeSelect("All assets", counts(stories, "assetClass"), state.filters.asset, (v) => {
    state.filters.asset = v; renderControls(day); renderFeed(day);
  }));
  row2.appendChild(makeSelect("All markets", counts(stories, "market"), state.filters.market, (v) => {
    state.filters.market = v; renderControls(day); renderFeed(day);
  }));

  const groupSel = document.createElement("select");
  groupSel.className = "ctl-select";
  for (const [val, label] of [["section", "Group: Topic"], ["dealType", "Group: Type"], ["assetClass", "Group: Asset"], ["market", "Group: Market"]]) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    groupSel.appendChild(o);
  }
  groupSel.value = state.groupBy;
  groupSel.addEventListener("change", () => { state.groupBy = groupSel.value; renderFeed(day); });
  row2.appendChild(groupSel);

  const active = state.filters.type || state.filters.asset || state.filters.market;
  if (active) {
    const clear = document.createElement("button");
    clear.className = "ctl-clear";
    clear.textContent = "✕ Clear";
    clear.addEventListener("click", () => {
      state.filters = { type: null, asset: null, market: null };
      renderControls(day);
      renderFeed(day);
    });
    row2.appendChild(clear);
  }

  const tally = document.createElement("span");
  tally.className = "ctl-tally";
  tally.textContent = `${applyFilters(stories).length} of ${stories.length}`;
  row2.appendChild(tally);

  bar.appendChild(row2);
}

function applyFilters(stories) {
  const f = state.filters;
  return stories.filter((s) =>
    (!f.type || s.dealType === f.type) &&
    (!f.asset || s.assetClass === f.asset) &&
    (!f.market || s.market === f.market)
  );
}

/* ---------- feed ---------- */

function groupLabel(key) {
  if (state.groupBy === "dealType") return `${typeInfo(key).emoji}  ${key}`;
  return key;
}

function renderFeed(day) {
  const feed = $("feed");
  feed.innerHTML = "";
  const all = day.stories || [];

  if (!all.length) {
    const p = document.createElement("p");
    p.style.cssText = "font-style:italic;color:var(--ink-2);padding:30px 0;text-align:center";
    p.textContent = "No newsletters arrived this day.";
    feed.appendChild(p);
    return;
  }

  const filtered = applyFilters(all);
  const filtering = filtered.length !== all.length;

  if (!filtered.length) {
    const p = document.createElement("p");
    p.style.cssText = "font-style:italic;color:var(--ink-2);padding:30px 0;text-align:center";
    p.textContent = "No stories match these filters.";
    feed.appendChild(p);
    return;
  }

  // Top Stories band only in the unfiltered view
  let rest = filtered;
  if (!filtering) {
    const featured = filtered.filter((s) => s.featured);
    rest = filtered.filter((s) => !s.featured);
    if (featured.length) {
      feed.appendChild(sectionHead("Top Stories"));
      const group = document.createElement("div");
      group.className = "story-group featured";
      featured.forEach((s, i) => group.appendChild(storyRow(s, day.date, i === 0)));
      feed.appendChild(group);
    }
  }

  const key = state.groupBy;
  const groups = new Map();
  for (const s of rest) {
    const k = s[key] || (key === "section" ? "More" : "Other");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  for (const [name, list] of ordered) {
    // within non-topic groupings, biggest deals first
    if (key !== "section") list.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
    feed.appendChild(sectionHead(groupLabel(name)));
    const group = document.createElement("div");
    group.className = "story-group";
    list.forEach((s) => group.appendChild(storyRow(s, day.date, false)));
    feed.appendChild(group);
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
    state.map = L.map("map-canvas", {
      scrollWheelZoom: true,
      wheelPxPerZoomLevel: 120,
      wheelDebounceTime: 25,
      zoomAnimation: true,
      fadeAnimation: true,
    });
    addTileLayer();
    // swap basemap when the OS theme flips
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (state.map) addTileLayer();
    });
    state.markers = L.layerGroup().addTo(state.map);
  }

  const dates = state.mapMode === "all" ? state.dates : [state.currentDate].filter(Boolean);
  $("map-title").textContent = state.mapMode === "all"
    ? `All coverage · ${state.dates.length} day${state.dates.length === 1 ? "" : "s"}`
    : (state.currentDate ? formatDate(state.currentDate, { weekday: "long", month: "long", day: "numeric" }) : "");

  state.markers.clearLayers();
  const pts = [];
  const typeTally = new Map();

  for (const date of dates) {
    const day = await getDay(date);
    for (const story of day?.stories || []) {
      const t = typeInfo(story.dealType);
      const hasLoc = (story.locations || []).some((l) => typeof l.lat === "number");
      if (hasLoc && story.dealType) typeTally.set(story.dealType, (typeTally.get(story.dealType) || 0) + 1);
      if (state.mapTypeFilter && !state.mapTypeFilter.has(story.dealType)) continue;
      for (const loc of story.locations || []) {
        if (typeof loc.lat !== "number" || typeof loc.lng !== "number") continue;
        pts.push([loc.lat, loc.lng]);
        const marker = L.marker([loc.lat, loc.lng], {
          icon: L.divIcon({
            className: "emoji-pin-wrap",
            html: `<div class="emoji-pin" style="border-color:${t.color}">${t.emoji}</div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15],
            popupAnchor: [0, -14],
          }),
        });
        const div = document.createElement("div");
        div.className = "map-popup";
        const h4 = document.createElement("h4");
        h4.textContent = story.title;
        h4.addEventListener("click", () => { location.hash = `/story/${date}/${story.id}`; });
        const meta = document.createElement("div");
        meta.className = "pop-meta";
        meta.textContent = [
          story.dealType ? `${t.emoji} ${story.dealType}` : null,
          story.assetClass,
          fmtValue(story.valueUsd),
          formatDate(date, { month: "short", day: "numeric" }),
        ].filter(Boolean).join(" · ");
        const locEl = document.createElement("div");
        locEl.className = "pop-loc";
        locEl.textContent = loc.label || "";
        div.append(h4, meta, locEl);
        marker.bindPopup(div, { maxWidth: 260 });
        state.markers.addLayer(marker);
      }
    }
  }

  renderMapLegend(typeTally);

  // let the container get its size before fitting
  requestAnimationFrame(() => {
    state.map.invalidateSize();
    if (pts.length > 1) state.map.fitBounds(pts, { padding: [36, 36] });
    else if (pts.length === 1) state.map.setView(pts[0], 11);
    else state.map.setView([39.5, -95], 4); // continental US
  });
}

function addTileLayer() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  if (state.tiles) state.map.removeLayer(state.tiles);
  // CARTO basemaps: retina ({r}) tiles, so no blur on 2x screens
  state.tiles = L.tileLayer(
    `https://{s}.basemaps.cartocdn.com/${dark ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`,
    {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 20,
      keepBuffer: 6,          // keep tiles around the viewport so panning never blanks
      updateWhenZooming: false, // don't re-request mid-pinch; settle, then load
    }
  ).addTo(state.map);
}

function renderMapLegend(typeTally) {
  const legend = $("map-legend");
  legend.innerHTML = "";
  const entries = [...typeTally.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length < 2) return;
  for (const [name, n] of entries) {
    const t = typeInfo(name);
    const off = state.mapTypeFilter && !state.mapTypeFilter.has(name);
    const b = document.createElement("button");
    b.className = "chip chip-filter" + (off ? " dim" : "");
    b.textContent = `${t.emoji} ${name} ${n}`;
    if (!off) b.style.borderColor = t.color + "88";
    b.addEventListener("click", () => {
      // tap = solo this type; tap again = show all
      if (state.mapTypeFilter && state.mapTypeFilter.size === 1 && state.mapTypeFilter.has(name)) {
        state.mapTypeFilter = null;
      } else {
        state.mapTypeFilter = new Set([name]);
      }
      renderMap();
    });
    legend.appendChild(b);
  }
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
    const grid = document.createElement("div");
    grid.className = "theme-grid";
    for (const t of wk.themes) {
      const box = document.createElement("div");
      box.className = "theme";
      const h3 = document.createElement("h3");
      h3.textContent = t.title;
      const p = document.createElement("p");
      p.textContent = t.body;
      box.append(h3, p);
      grid.appendChild(box);
    }
    wrap.appendChild(grid);
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

/* ---------- rates ---------- */

const TENOR_MONTHS = { "1M": 1, "2M": 2, "3M": 3, "4M": 4, "6M": 6, "1Y": 12, "2Y": 24, "3Y": 36, "5Y": 60, "7Y": 84, "10Y": 120, "20Y": 240, "30Y": 360 };

async function loadRates() {
  // Paint instantly from the persistent cache row (~100ms), then revalidate via
  // the edge function, which itself serves that cache unless it's >10 min old.
  const apply = (d) => {
    if (!d?.treasury || !Object.keys(d.treasury).length) return false;
    if (state.rates?.generatedAt && d.generatedAt <= state.rates.generatedAt) return false;
    state.rates = d;
    renderRateStrip();
    if (!$("view-rates").hidden) renderRates();
    return true;
  };

  try {
    const rows = await sb("rates_cache?id=eq.1&select=data");
    apply(rows[0]?.data);
  } catch { /* cache row may not exist yet */ }

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/rates-live`, {
      cache: "no-store",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (res.ok) apply(await res.json());
  } catch { /* keep whatever we have */ }

  if (!state.rates) {
    try {
      const rows = await sb("rates?select=data&order=date.desc&limit=1");
      state.rates = rows[0]?.data ?? null;
      renderRateStrip();
      if (!$("view-rates").hidden) renderRates();
    } catch { /* leave hidden */ }
  }
}

function pct(n) {
  return n == null ? "—" : n.toFixed(2) + "%";
}

function renderRateStrip() {
  const strip = $("rate-strip");
  const r = state.rates;
  if (!r?.treasury) { strip.hidden = true; return; }
  strip.hidden = false;
  strip.innerHTML = "";
  const tp = r.treasuryPrior || {};
  const items = [
    ["5Y", r.treasury["5Y"], tp["5Y"]],
    ["10Y", r.treasury["10Y"], tp["10Y"]],
    ["30Y", r.treasury["30Y"], tp["30Y"]],
    ["SOFR", r.sofr?.rate, r.sofr?.prior],
  ];
  for (const [label, val, prior] of items) {
    const span = document.createElement("span");
    span.className = "rs-item";
    const dir = val != null && prior != null ? (val > prior ? " up" : val < prior ? " down" : "") : "";
    span.innerHTML = `<b>${label}</b> <span class="rs-val${dir}">${val == null ? "—" : val.toFixed(2)}</span>`;
    strip.appendChild(span);
  }
}

function rateTile(label, value, sub, prior, key) {
  const div = document.createElement("div");
  div.className = "rate-tile";
  if (key) {
    div.classList.add("clickable");
    if (state.rateChart === "history" && state.histKey === key) div.classList.add("on");
    div.title = "Tap for the trend; tap again for the yield curve";
    div.addEventListener("click", () => {
      if (state.rateChart === "history" && state.histKey === key) {
        state.rateChart = "curve";
        state.histKey = null;
      } else {
        state.rateChart = "history";
        state.histKey = key;
      }
      renderRates();
    });
  }
  const l = document.createElement("div");
  l.className = "rt-label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "rt-value";
  v.textContent = pct(value);
  div.append(l, v);

  // 1-day change — the standard rates-screen window
  if (value != null && prior != null && prior !== 0) {
    const bp = (value - prior) * 100;
    const pc = (value - prior) / prior * 100;
    const chg = document.createElement("div");
    chg.className = "rt-chg " + (bp >= 0 ? "up" : "down");
    const arrow = bp >= 0 ? "▲" : "▼";
    chg.innerHTML = `${arrow} ${Math.abs(bp).toFixed(1)} bp <span class="rt-pct">(${pc >= 0 ? "+" : ""}${pc.toFixed(1)}%) 1d</span>`;
    div.appendChild(chg);
  } else if (sub) {
    const s = document.createElement("div");
    s.className = "rt-sub";
    s.textContent = sub;
    div.appendChild(s);
  }
  return div;
}

function renderRates() {
  const wrap = $("rates-content");
  wrap.innerHTML = "";
  const r = state.rates;
  if (!r?.treasury) {
    const p = document.createElement("p");
    p.style.cssText = "font-style:italic;color:var(--ink-2);padding:40px 0;text-align:center";
    p.textContent = "Rates arrive with the next pipeline run.";
    wrap.appendChild(p);
    return;
  }

  // headline tiles — 5Y / 10Y / 30Y / SOFR, matching the masthead order
  wrap.appendChild(sectionHead("Key Rates"));
  const tiles = document.createElement("div");
  tiles.className = "rate-tiles quads";
  const tp = r.treasuryPrior || {};
  tiles.appendChild(rateTile("5-Year", r.treasury["5Y"], "treasury", tp["5Y"], "5Y"));
  tiles.appendChild(rateTile("10-Year", r.treasury["10Y"], "treasury", tp["10Y"], "10Y"));
  tiles.appendChild(rateTile("30-Year", r.treasury["30Y"], "treasury", tp["30Y"], "30Y"));
  tiles.appendChild(rateTile("SOFR", r.sofr?.rate, "overnight", r.sofr?.prior, "SOFR"));
  wrap.appendChild(tiles);

  // chart band with a curve/forward toggle (one chart at a time keeps the page
  // to a single phone screen)
  const head = document.createElement("div");
  head.className = "chart-head";
  const histLabels = { "5Y": "5-Year Treasury", "10Y": "10-Year Treasury", "30Y": "30-Year Treasury", SOFR: "SOFR" };

  const titleWrap = document.createElement("div");
  titleWrap.className = "chart-title";
  const title = sectionHead(
    state.rateChart === "forward" ? `SOFR Forward — Next ${state.fwdHorizon}`
    : state.rateChart === "history" ? `${histLabels[state.histKey] || ""} — Past ${state.histRange}`
    : "Treasury Yield Curve"
  );
  title.style.margin = "0";
  const badge = document.createElement("span");
  badge.className = "chart-badge " + (state.rateChart === "forward" ? "proj" : "actual");
  badge.textContent = state.rateChart === "forward" ? "PROJECTED" : "ACTUAL";
  titleWrap.append(title, badge);
  head.appendChild(titleWrap);

  const toggle = document.createElement("div");
  toggle.className = "map-toggle scrolly";
  if (state.rateChart === "history") {
    for (const rng of ["1M", "3M", "6M", "1Y"]) {
      const b = document.createElement("button");
      b.textContent = rng;
      b.className = state.histRange === rng ? "on" : "";
      b.addEventListener("click", () => { state.histRange = rng; renderRates(); });
      toggle.appendChild(b);
    }
    const x = document.createElement("button");
    x.textContent = "✕";
    x.addEventListener("click", () => { state.rateChart = "curve"; state.histKey = null; renderRates(); });
    toggle.appendChild(x);
  } else if (state.rateChart === "forward") {
    toggle.classList.add("wrap-row");
    for (const h of Object.keys(FWD_HORIZONS)) {
      const b = document.createElement("button");
      b.textContent = h;
      b.className = state.fwdHorizon === h ? "on" : "";
      b.addEventListener("click", () => { state.fwdHorizon = h; renderRates(); });
      toggle.appendChild(b);
    }
    const x = document.createElement("button");
    x.textContent = "✕";
    x.addEventListener("click", () => { state.rateChart = "curve"; renderRates(); });
    toggle.appendChild(x);
  } else {
    for (const [mode, label] of [["curve", "Curve"], ["forward", "Forward"]]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = state.rateChart === mode ? "on" : "";
      b.addEventListener("click", () => { state.rateChart = mode; renderRates(); });
      toggle.appendChild(b);
    }
  }
  head.appendChild(toggle);
  wrap.appendChild(head);

  const chart = document.createElement("div");
  chart.className = "curve-wrap";
  chart.appendChild(
    state.rateChart === "forward" ? buildForwardSvg(r.forward || [], FWD_HORIZONS[state.fwdHorizon] || 12)
    : state.rateChart === "history" ? buildHistorySvg(r, state.histKey, state.histRange)
    : buildCurveSvg(r.treasury)
  );
  wrap.appendChild(chart);


  // SOFR averages
  const a = r.sofrAverages || {};
  wrap.appendChild(sectionHead("SOFR Compounded Averages"));
  const avgTiles = document.createElement("div");
  avgTiles.className = "rate-tiles thirds";
  avgTiles.appendChild(rateTile("30-Day", a["30d"]));
  avgTiles.appendChild(rateTile("90-Day", a["90d"]));
  avgTiles.appendChild(rateTile("180-Day", a["180d"]));
  wrap.appendChild(avgTiles);

  const note = document.createElement("p");
  note.className = "rates-note";
  note.textContent = state.rateChart === "forward"
    ? "Every point is in the FUTURE — the market's implied SOFR path read from today's Treasury prices (±10–30bp vs the licensed OIS curve inside 1Y). A modeling guide, not a quote."
    : state.rateChart === "history"
    ? "Every point is in the PAST — actual daily prints from treasury.gov and the New York Fed. Tap the highlighted pane again to return to the yield curve."
    : `Treasury par yield curve as of ${r.curveDate}; SOFR published by the New York Fed (${r.sofr?.date}). Changes are vs the prior business day.`;
  wrap.appendChild(note);
}

function buildCurveSvg(t) {
  const pts = Object.entries(TENOR_MONTHS)
    .filter(([k]) => t[k] != null)
    .map(([k, m]) => ({ label: k, months: m, rate: t[k] }));
  if (!pts.length) return document.createTextNode("");

  // The SVG scales to its container, so phones get their own taller geometry
  // and proportionally larger type instead of a shrunken desktop chart.
  const mobile = matchMedia("(max-width: 700px)").matches;
  const k = mobile ? 1.9 : 1; // text/mark scale factor
  const W = 680, H = mobile ? 630 : 320;
  const padL = 46 * (mobile ? 1.5 : 1), padR = 20, padT = 20 * k, padB = 32 * k;
  const fs = { axis: 10 * k, value: 11 * k };
  const xs = (m) => padL + (Math.sqrt(m) - 1) / (Math.sqrt(360) - 1) * (W - padL - padR);
  const rates = pts.map((p) => p.rate);
  const yMin = Math.floor(Math.min(...rates) * 4) / 4 - 0.25;
  const yMax = Math.ceil(Math.max(...rates) * 4) / 4 + 0.25;
  const ys = (r) => padT + (yMax - r) / (yMax - yMin) * (H - padT - padB);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Treasury par yield curve, " + pts.map((p) => `${p.label} ${p.rate}%`).join(", "));
  const put = (tag, attrs, text) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    svg.appendChild(el);
    return el;
  };

  // recessive horizontal grid at 0.25% steps for a granular y-axis
  for (let g = Math.ceil(yMin * 4) / 4; g <= yMax + 0.001; g += 0.25) {
    const major = Math.round(g * 100) % 50 === 0;
    put("line", { x1: padL, x2: W - padR, y1: ys(g), y2: ys(g), class: major ? "cv-grid" : "cv-grid minor" });
    put("text", { x: padL - 8, y: ys(g) + fs.axis * 0.34, class: "cv-ylabel", "text-anchor": "end", "font-size": fs.axis }, g.toFixed(2));
  }

  // x labels (selective)
  for (const p of pts) {
    if (!["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"].includes(p.label)) continue;
    if (mobile && ["3M", "3Y", "7Y"].includes(p.label)) continue; // avoid crowding at phone scale
    put("text", { x: xs(p.months), y: H - 10, class: "cv-xlabel", "text-anchor": "middle", "font-size": fs.axis }, p.label);
  }

  // the curve
  const d = pts.map((p, i) => `${i ? "L" : "M"}${xs(p.months).toFixed(1)},${ys(p.rate).toFixed(1)}`).join(" ");
  put("path", { d, class: "cv-line", "stroke-width": 2 * k });

  // dots — key tenors emphasized and direct-labeled
  const KEY = new Set(["5Y", "10Y", "30Y"]);
  for (const p of pts) {
    const key = KEY.has(p.label);
    put("circle", { cx: xs(p.months), cy: ys(p.rate), r: (key ? 5 : 3) * k, class: key ? "cv-dot key" : "cv-dot", "stroke-width": 2 * k });
    if (key) {
      put("text", { x: xs(p.months), y: ys(p.rate) - 11 * k, class: "cv-vlabel", "text-anchor": "middle", "font-size": fs.value }, p.rate.toFixed(2));
    }
    // generous invisible hit target with a native tooltip
    const hit = put("circle", { cx: xs(p.months), cy: ys(p.rate), r: 13 * k, class: "cv-hit" });
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${p.label}: ${p.rate.toFixed(2)}%`;
    hit.appendChild(title);
  }

  return svg;
}

function fwdLabel(m) {
  if (m === 0) return "Today";
  if (m < 12) return `+${m * 30}d`;
  return m % 12 === 0 ? `+${m / 12}Y` : `+${m}mo`;
}

function buildForwardSvg(fwd, horizonMonths) {
  const pts = (fwd || [])
    .map((p) => ({ m: p.m ?? (p.t || 0) * 12, rate: p.rate }))
    .filter((p) => Number.isFinite(p.m) && Number.isFinite(p.rate) && p.m <= (horizonMonths || 12));
  if (pts.length < 2) {
    const p = document.createElement("p");
    p.style.cssText = "font-style:italic;color:var(--ink-2);padding:26px 10px";
    p.textContent = "Forward path unavailable right now.";
    return p;
  }

  const mobile = matchMedia("(max-width: 700px)").matches;
  const k = mobile ? 1.9 : 1;
  // slightly shorter than the other charts on phones: forward mode carries an
  // extra control row, and the page must stay one screen
  const W = 680, H = mobile ? 545 : 320;
  const padL = 46 * (mobile ? 1.5 : 1), padR = 26, padT = 24 * k, padB = 32 * k;
  const fs = { axis: 10 * k, value: 11 * k };
  const tMax = Math.max(...pts.map((p) => p.m));
  const xs = (m) => padL + (m / tMax) * (W - padL - padR);
  const rates = pts.map((p) => p.rate);
  const yMin = Math.floor(Math.min(...rates) * 4) / 4 - 0.25;
  const yMax = Math.ceil(Math.max(...rates) * 4) / 4 + 0.25;
  const ys = (r) => padT + (yMax - r) / (yMax - yMin) * (H - padT - padB);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Implied forward short-rate path: " + pts.map((p) => `${fwdLabel(p.m)} ${p.rate}%`).join(", "));
  const put = (tag, attrs, text) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, v] of Object.entries(attrs)) el.setAttribute(key, v);
    if (text != null) el.textContent = text;
    svg.appendChild(el);
    return el;
  };

  for (let g = Math.ceil(yMin * 4) / 4; g <= yMax + 0.001; g += 0.25) {
    const major = Math.round(g * 100) % 50 === 0;
    put("line", { x1: padL, x2: W - padR, y1: ys(g), y2: ys(g), class: major ? "cv-grid" : "cv-grid minor" });
    put("text", { x: padL - 8, y: ys(g) + fs.axis * 0.34, class: "cv-ylabel", "text-anchor": "end", "font-size": fs.axis }, g.toFixed(2));
  }

  // Pick which points get text so labels can never overlap: walk left-to-right
  // enforcing a minimum x-gap, and always keep the first and last points.
  const labelGap = 62 * (mobile ? 1.35 : 1);
  const labeled = new Set([0, pts.length - 1]);
  let lastX = xs(pts[0].m);
  for (let i = 1; i < pts.length - 1; i++) {
    const x = xs(pts[i].m);
    if (x - lastX >= labelGap && xs(pts[pts.length - 1].m) - x >= labelGap) {
      labeled.add(i);
      lastX = x;
    }
  }

  for (let i = 0; i < pts.length; i++) {
    if (!labeled.has(i)) continue;
    const p = pts[i];
    put("text", { x: xs(p.m), y: H - 10, class: "cv-xlabel", "text-anchor": i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle", "font-size": fs.axis }, fwdLabel(p.m));
  }

  // stepped path — forward rates hold across each segment, which mirrors how
  // a draw schedule models a rate assumption per period
  let d = `M${xs(pts[0].m).toFixed(1)},${ys(pts[0].rate).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L${xs(pts[i].m).toFixed(1)},${ys(pts[i - 1].rate).toFixed(1)} L${xs(pts[i].m).toFixed(1)},${ys(pts[i].rate).toFixed(1)}`;
  }
  put("path", { d, class: "cv-line", "stroke-width": 2 * k });

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const isLabeled = labeled.has(i);
    put("circle", { cx: xs(p.m), cy: ys(p.rate), r: (isLabeled ? 4 : 2.5) * k, class: "cv-dot" + (isLabeled ? " key" : ""), "stroke-width": 2 * k });
    if (isLabeled) {
      put("text", { x: xs(p.m), y: ys(p.rate) - 11 * k, class: "cv-vlabel", "text-anchor": i === pts.length - 1 ? "end" : i === 0 ? "start" : "middle", "font-size": fs.value }, p.rate.toFixed(2));
    }
    const hit = put("circle", { cx: xs(p.m), cy: ys(p.rate), r: 13 * k, class: "cv-hit" });
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${fwdLabel(p.m)}: ${p.rate.toFixed(2)}%`;
    hit.appendChild(title);
  }

  return svg;
}

function buildHistorySvg(r, key, range) {
  const hist = r.history || {};
  const raw = key === "SOFR"
    ? (hist.sofr || []).map((e) => ({ date: e.date, rate: e.rate }))
    : (hist.treasury || []).map((e) => ({ date: e.date, rate: e[key] }));
  const days = { "1M": 32, "3M": 93, "6M": 184, "1Y": 367 }[range] || 93;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const pts = raw.filter((p) => typeof p.rate === "number" && p.date >= cutoff);

  if (pts.length < 2) {
    const p = document.createElement("p");
    p.style.cssText = "font-style:italic;color:var(--ink-2);padding:26px 10px";
    p.textContent = "Not enough history for this range yet.";
    return p;
  }

  const mobile = matchMedia("(max-width: 700px)").matches;
  const k = mobile ? 1.9 : 1;
  const W = 680, H = mobile ? 630 : 320;
  const padL = 46 * (mobile ? 1.5 : 1), padR = 54 * k * 0.6, padT = 20 * k, padB = 32 * k;
  const fs = { axis: 10 * k, value: 11 * k };

  const t0 = Date.parse(pts[0].date), t1 = Date.parse(pts[pts.length - 1].date);
  const xs = (d) => padL + (Date.parse(d) - t0) / (t1 - t0 || 1) * (W - padL - padR);
  const rates = pts.map((p) => p.rate);
  const lo = Math.min(...rates), hi = Math.max(...rates);
  const span = Math.max(hi - lo, 0.1);
  const step = span <= 0.5 ? 0.1 : span <= 1.2 ? 0.25 : 0.5;
  const yMin = Math.floor((lo - step / 2) / step) * step;
  const yMax = Math.ceil((hi + step / 2) / step) * step;
  const ys = (v) => padT + (yMax - v) / (yMax - yMin) * (H - padT - padB);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${key} over the last ${range}: from ${pts[0].rate}% to ${pts[pts.length - 1].rate}%`);
  const put = (tag, attrs, text) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [a, v] of Object.entries(attrs)) el.setAttribute(a, v);
    if (text != null) el.textContent = text;
    svg.appendChild(el);
    return el;
  };

  for (let g = yMin; g <= yMax + 0.001; g += step) {
    put("line", { x1: padL, x2: W - padR, y1: ys(g), y2: ys(g), class: "cv-grid" });
    put("text", { x: padL - 8, y: ys(g) + fs.axis * 0.34, class: "cv-ylabel", "text-anchor": "end", "font-size": fs.axis }, g.toFixed(2));
  }

  // 4 date labels across the window
  const fmt = (d) => new Date(Date.parse(d)).toLocaleDateString("en-US", range === "1Y" ? { month: "short" } : { month: "short", day: "numeric" });
  for (let i = 0; i < 4; i++) {
    const p = pts[Math.round(i * (pts.length - 1) / 3)];
    put("text", { x: xs(p.date), y: H - 10, class: "cv-xlabel", "text-anchor": i === 0 ? "start" : i === 3 ? "end" : "middle", "font-size": fs.axis }, fmt(p.date));
  }

  const d = pts.map((p, i) => `${i ? "L" : "M"}${xs(p.date).toFixed(1)},${ys(p.rate).toFixed(1)}`).join(" ");
  put("path", { d, class: "cv-line", "stroke-width": 2 * k });

  // endpoint dot + value
  const last = pts[pts.length - 1];
  put("circle", { cx: xs(last.date), cy: ys(last.rate), r: 4.5 * k, class: "cv-dot key", "stroke-width": 2 * k });
  put("text", { x: xs(last.date) + 8 * k, y: ys(last.rate) + fs.value * 0.34, class: "cv-vlabel", "text-anchor": "start", "font-size": fs.value }, last.rate.toFixed(2));

  // sparse hover targets (~24 across the window)
  const strideN = Math.max(1, Math.floor(pts.length / 24));
  for (let i = 0; i < pts.length; i += strideN) {
    const p = pts[i];
    const hit = put("circle", { cx: xs(p.date), cy: ys(p.rate), r: 12 * k, class: "cv-hit" });
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${p.date}: ${p.rate.toFixed(2)}%`;
    hit.appendChild(title);
  }

  return svg;
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
