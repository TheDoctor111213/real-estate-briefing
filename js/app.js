/* Real Estate Briefing — views: briefing / map / weekly / players / dictionary / history / rates, plus reader overlay.
   Hash routes: #/ · #/day/DATE · #/story/DATE/ID · #/map · #/weekly · #/players · #/player/SLUG ·
                #/dictionary · #/term/SLUG · #/history · #/rates · #/trends ·
                #/threads · #/thread/SLUG · #/calendar (Phase 5, no tab — reached from reader/Trends/watch)
   History has no tab of its own — it's reached by tapping the masthead date. It still gets a hash route.
   Data lives in Supabase (public-read); the pipeline upserts via scripts/push_data.py. */

const APP_VERSION = "v69";
const SUPABASE_URL = "https://uhwdnmbxiopfysodydty.supabase.co";
const SUPABASE_KEY = "sb_publishable_LEQ5_-jjcRRl2p0wlaiXcw_RX4Wf8-y";
// Mapbox public token — a pk.* token is meant to ship to browsers, but GitHub's
// secret scanner blocks committing one, so it's served from a public Supabase
// config row and fetched at runtime (cached after first read).
let MAPBOX_TOKEN = null;
async function getMapboxToken() {
  if (MAPBOX_TOKEN) return MAPBOX_TOKEN;
  try {
    const rows = await sb("app_config?key=eq.mapbox_token&select=value");
    MAPBOX_TOKEN = rows[0]?.value || null;
  } catch { MAPBOX_TOKEN = null; }
  return MAPBOX_TOKEN;
}

/* What can THIS device actually do with a share? iOS "Add to Home Screen"
   web apps have a standing WebKit limitation where files can't go through the
   share sheet from standalone mode — canShare({files}) returns false — which is
   why the one-tap share silently falls back to the card viewer. This readout
   (shown on the Status page) tells us which case we're in on a real phone. */
function shareCapabilities() {
  let canFiles = false;
  try {
    const f = new File([new Uint8Array([0])], "probe.png", { type: "image/png" });
    canFiles = !!(navigator.canShare && navigator.canShare({ files: [f] }));
  } catch { canFiles = false; }
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
  return {
    version: APP_VERSION,
    standalone,
    hasShare: typeof navigator.share === "function",
    canShareFiles: canFiles,
  };
}

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

/* Blank/placeholder images some outlets embed when a story has no photo —
   Bisnow's watermark placeholder is the worst offender (a big empty "BISNOW"
   tile). We never want these as a hero or inside an article body. */
function isJunkImageUrl(src) {
  if (!src) return true;
  const s = src.toLowerCase();
  if (s.startsWith("data:image") && s.length < 256) return true; // 1x1 spacers
  return /(?:^|\/|=)(?:placeholder|blank|spacer|transparent|default-image|missing|no-image|1x1)\b/.test(s)
    || /placeholder\.(?:png|jpe?g|gif|webp)/.test(s)
    || /assets\/website\/placeholder/.test(s);
}

/* Sanitize stored article HTML at render time: drop any <script>, and strip
   blank/placeholder <img>s so a bad hero or watermark tile never shows. */
function sanitizeArticleHtml(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const m = tag.match(/src\s*=\s*["']([^"']+)["']/i);
      return m && isJunkImageUrl(m[1]) ? "" : tag;
    });
}

/* Price-efficiency chip: $/unit when a unit count is known (multifamily), else
   $/sf when a square footage is known. Both read optional pipeline fields
   (units / sizeSqft); null when there's no single deal size to divide by. */
function derivedMetric(story) {
  const v = story.valueUsd;
  if (!v) return null;
  if (story.units > 0) return "$" + Math.round(v / story.units / 1000) + "K/unit";
  if (story.sizeSqft > 0) return "$" + Math.round(v / story.sizeSqft) + "/sf";
  return null;
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
  mapAsset: null,      // asset-class filter on the map
  mapValueBand: null,  // min deal size filter (number) or null
  mapPlaying: false,   // all-time playback running
  controlsDate: null,  // filters reset when the viewed day changes
  players: null,       // slug -> entity (people + companies roster)
  playerType: "people",   // "people" | "companies"
  playerSort: "active",   // "active" | "volume" | "az"
  playerQuery: "",
  terms: null,         // slug -> term (dictionary)
  termCategory: null,  // null = all, otherwise a category label
  termSort: "az",       // "az" | "recent" | "mentions"
  termQuery: "",
  rateChart: "curve",  // "curve" | "forward" | "history"
  histKey: null,       // which pane's trend is showing: "5Y" | "10Y" | "30Y" | "SOFR"
  histRange: "3M",     // "1M" | "3M" | "6M" | "1Y"
  fwdHorizon: "1Y",    // forward-view horizon: "30D" | "90D" | "6M" | "1Y" | "3Y" | "5Y"
  allDays: null,       // every day's data, loaded once for Search + Trends
  threads: null,       // story arcs (cross-day timelines)
  events: null,        // dated catalysts (the calendar)
  metrics: null,       // cited industry figures (market metrics)
  pulse: null,         // Market Pulse: national + by-metro external data (FRED/Zillow)
  pulseKey: null,      // which national signal's full chart is open
  pulseRange: 60,      // Market Pulse chart window in months
  pulseGroup: "rates", // Market Pulse active group tab
  marketMetric: null,  // which external series' chart is open on a Market page
  marketRange: 60,     // Market page chart window in months
  compSort: "recent",  // comps sort: "recent" | "value" | "psf" | "punit"
  compAsset: null,     // asset class scoping the by-market comps
  capAsset: null,      // asset class scoping the by-market cap rates
  leagueRole: "buyer", // League Tables active role
  leagueWin: 0,        // League Tables window in days (0 = all time)
  calView: "agenda",   // calendar layout: "agenda" | "month"
  calMonth: null,      // month shown in grid view (YYYY-MM)
  calDay: null,        // day selected in grid view (YYYY-MM-DD)
  trendFilters: { market: null, asset: null, type: null }, // Deal Ledger filters
  searchQuery: "",
  reader: null,        // { story, date } currently open in the reader
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

  // the wordmark ALWAYS returns to the current day — from an older day, from
  // any tab, from anywhere. Only when you're already on today does it refresh
  // instead (data AND app updates — see hardRefresh).
  document.querySelector(".wordmark").addEventListener("click", (e) => {
    e.preventDefault();
    const latest = state.dates[state.dates.length - 1] || null;
    const h = location.hash;
    const onBriefing = h === "" || h === "#/" || h.startsWith("#/day/");
    if (onBriefing && state.currentDate === latest) { hardRefresh(); return; }
    state.currentDate = latest;
    if (h === "" || h === "#/") route(); // hash unchanged → no hashchange event
    else location.hash = "/";
  });

  $("search-btn").addEventListener("click", () => { location.hash = "/search"; });
  $("bell-btn").addEventListener("click", () => { location.hash = "/alerts"; });
  paintBellDot();
  try { navigator.clearAppBadge?.(); } catch { /* unsupported */ }
  // the monogram locks the app back to the picker; re-entering any
  // passcoded profile (including your own) asks for its code
  $("profile-btn").addEventListener("click", () => {
    setLocked();
    try { sessionStorage.removeItem(GUEST_KEY); } catch { /* ignore */ }
    showProfilePicker(false);
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshData(true);
      paintBellDot();
      try { navigator.clearAppBadge?.(); } catch { /* unsupported */ }
    }
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
  // entity/term links live inside clickable cards; capture phase wins over the
  // card's own click. They open the mini-dossier sheet (full page one tap away).
  document.addEventListener("click", (e) => {
    const entity = e.target.closest?.(".entity-link");
    if (entity) {
      e.preventDefault();
      e.stopPropagation();
      openPlayerSheet(entity.dataset.slug);
      return;
    }
    const term = e.target.closest?.(".term-link");
    if (term) {
      e.preventDefault();
      e.stopPropagation();
      openTermSheet(term.dataset.slug);
    }
  }, true);
  $("sheet-backdrop").addEventListener("click", () => sheetDismiss());
  // drag the sheet with your finger — tracks smoothly, springs back or flings away
  const sheetCard = $("sheet-card");
  sheetCard.addEventListener("touchstart", (e) => { sheetDragStart(e.touches[0].clientY); }, { passive: true });
  sheetCard.addEventListener("touchmove", (e) => {
    if (sheetDragY === null) return;
    const dy = e.touches[0].clientY - sheetDragY;
    // downward always drags; upward drags too on a story peek (fling up = open),
    // otherwise upward stays a scroll on tall dossier sheets
    if (dy > 0 || peekTarget) { e.preventDefault(); sheetDragMove(e.touches[0].clientY); }
  }, { passive: false });
  sheetCard.addEventListener("touchend", () => sheetDragEnd());
  sheetCard.addEventListener("touchcancel", () => sheetDragEnd());

  // reader: horizontal swipe = prev/next story; pull down from the top =
  // close, tracking the finger the whole way (springs back if you let go early)
  const reader = $("reader");
  let rt = null;
  reader.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { rt = null; return; }
    rt = { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, dy: 0, axis: null };
  }, { passive: true });
  reader.addEventListener("touchmove", (e) => {
    if (!rt) return;
    rt.dx = e.touches[0].clientX - rt.x;
    rt.dy = e.touches[0].clientY - rt.y;
    if (!rt.axis && (Math.abs(rt.dx) > 10 || Math.abs(rt.dy) > 10)) {
      if (Math.abs(rt.dy) > Math.abs(rt.dx) && rt.dy > 0 && reader.scrollTop <= 0) rt.axis = "close";
      else rt.axis = Math.abs(rt.dx) > Math.abs(rt.dy) ? "x" : "scroll";
    }
    if (rt.axis === "close") {
      e.preventDefault();
      const y = Math.max(0, rt.dy);
      reader.style.transition = "none";
      reader.style.transform = `translateY(${y * 0.7}px)`;
      reader.style.opacity = String(Math.max(0.35, 1 - y / 640));
    }
  }, { passive: false });
  const readerTouchEnd = () => {
    if (!rt) return;
    const { axis, dx, dy } = rt;
    rt = null;
    if (axis === "x" && Math.abs(dx) > 70) readerStep(dx < 0 ? 1 : -1);
    else if (axis === "close") {
      if (dy > 130) {
        reader.style.transition = "transform .2s ease, opacity .2s ease";
        reader.style.transform = "translateY(100%)";
        reader.style.opacity = "0";
        setTimeout(() => { closeReaderNav(); reader.style.transition = ""; reader.style.transform = ""; reader.style.opacity = ""; }, 190);
      } else {
        reader.style.transition = "transform .26s cubic-bezier(.2,.9,.25,1), opacity .26s ease";
        reader.style.transform = ""; reader.style.opacity = "";
      }
    }
  };
  reader.addEventListener("touchend", readerTouchEnd, { passive: true });
  reader.addEventListener("touchcancel", readerTouchEnd, { passive: true });
  // scroll memory + "~N min left"
  reader.addEventListener("scroll", onReaderScroll, { passive: true });
  // TTS playback of the open story
  $("reader-listen").addEventListener("click", toggleTTS);

  // feed card gestures: swipe right = save ★, swipe left = toggle read/unread;
  // long-press = draggable peek preview. Vertical drags stay scrolls.
  const feed = $("feed");
  let ft = null;
  feed.addEventListener("touchstart", (e) => {
    const card = e.target.closest(".story[data-id]");
    if (!card || e.touches.length !== 1) { ft = null; return; }
    const t = e.touches[0];
    ft = { card, x: t.clientX, y: t.clientY, dx: 0, horiz: false, moved: false, mode: null };
    ft.timer = setTimeout(() => {
      // long-press: open the peek and hand this same finger into the sheet drag
      if (ft && !ft.moved) { ft.mode = "peek"; openStoryPeek(card.dataset.date, card.dataset.id, ft.y); }
    }, 450);
  }, { passive: true });
  feed.addEventListener("touchmove", (e) => {
    if (!ft) return;
    const t = e.touches[0];
    if (ft.mode === "peek") {
      e.preventDefault();
      if (sheetDragY === null) sheetDragStart(t.clientY); // lazy: start where the finger is now
      sheetDragMove(t.clientY);
      return;
    }
    const dx = t.clientX - ft.x, dy = t.clientY - ft.y;
    if (!ft.horiz && !ft.moved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      ft.moved = true; clearTimeout(ft.timer);
      ft.horiz = Math.abs(dx) > Math.abs(dy);
    }
    if (ft.horiz) {
      e.preventDefault();
      ft.dx = dx;
      ft.card.style.transition = "none";
      ft.card.style.transform = `translateX(${dx}px)`;
      ft.card.classList.toggle("swipe-read", dx > 45);
      ft.card.classList.toggle("swipe-save", dx < -45);
    }
  }, { passive: false });
  const endFeed = (e) => {
    if (!ft) return;
    clearTimeout(ft.timer);
    if (ft.mode === "peek") { sheetDragEnd(); if (e && e.cancelable) e.preventDefault(); ft = null; return; }
    const { card, dx, horiz } = ft;
    card.style.transition = "transform .2s ease";
    card.style.transform = "";
    card.classList.remove("swipe-save", "swipe-read");
    if (horiz && Math.abs(dx) > 90) {
      const date = card.dataset.date, id = card.dataset.id;
      if (dx < 0) {
        const story = (state.days.get(date)?.stories || []).find((s) => s.id === id);
        if (story) flashToast(toggleSaved(story, date) ? "Saved ★" : "Removed");
      } else {
        const nowRead = !isRead(date, id);
        setRead(date, id, nowRead); card.classList.toggle("is-read", nowRead);
        flashToast(nowRead ? "Marked read" : "Marked unread");
      }
    }
    if (horiz && e && e.cancelable) e.preventDefault(); // no synthetic click after a swipe
    ft = null;
  };
  feed.addEventListener("touchend", endFeed, { passive: false });
  feed.addEventListener("touchcancel", endFeed, { passive: false });

  // share the open story as a typographic image card
  $("reader-share").addEventListener("click", () => {
    if (state.reader) shareStoryCard(state.reader.story, state.reader.date);
  });
  $("sharebox-close").addEventListener("click", hideShareBox);
  $("sharebox").addEventListener("click", (e) => { if (e.target === $("sharebox")) hideShareBox(); });
  // copy the IMAGE itself to the clipboard — pasting in Messages inserts the
  // picture, no share sheet involved (the reliable iOS path)
  $("sharebox-copy").addEventListener("click", async () => {
    if (!shareBoxState) return;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": Promise.resolve(shareBoxState.blob) }),
      ]);
      flashToast("Card copied — paste it in Messages");
    } catch {
      flashToast("Couldn't copy — touch and hold the card instead");
    }
  });
  // fresh tap = fresh user activation, so these calls are allowed to run
  $("sharebox-share").addEventListener("click", async () => {
    if (!shareBoxState) return;
    const file = new File([shareBoxState.blob], shareBoxState.filename, { type: "image/png" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
    flashToast("Touch and hold the card instead");
  });
  $("sharebox-link").addEventListener("click", async () => {
    if (!shareBoxState?.link) return;
    try {
      await navigator.clipboard.writeText(shareBoxState.link);
      flashToast("Link copied");
    } catch {
      flashToast(shareBoxState.link); // worst case: show it to copy by hand
    }
  });

  // text size (persists per reader profile)
  $("reader-size").addEventListener("click", () => {
    const order = ["m", "l", "s"];
    const cur = pref("textScale", "m");
    setPref("textScale", order[(order.indexOf(cur) + 1) % order.length]);
    applyTextScale();
  });

  // hold a player photo to peek at it full-size; release to drop (Instagram-style)
  let peekTimer = null, peeking = false;
  document.addEventListener("pointerdown", (e) => {
    const img = e.target.closest?.(".player-avatar img");
    if (!img || !img.src) return;
    peekTimer = setTimeout(() => {
      peeking = true;
      $("lightbox-img").src = img.src;
      $("lightbox").classList.add("peek");
      $("lightbox").hidden = false;
    }, 160);
  });
  const endPeek = () => {
    clearTimeout(peekTimer);
    if (!peeking) return;
    peeking = false;
    $("lightbox").hidden = true;
    $("lightbox").classList.remove("peek");
    // the release shouldn't also fire the card/link underneath
    document.addEventListener("click", (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
  };
  document.addEventListener("pointerup", endPeek);
  document.addEventListener("pointercancel", endPeek);

  // tap an article image to inspect it; tap anywhere to close
  document.addEventListener("click", (e) => {
    const box = $("lightbox");
    if (!box.hidden && !box.classList.contains("peek")) { box.hidden = true; return; }
    const img = e.target.closest?.("#reader-body img, #reader-hero-img");
    if (img && img.src) {
      e.preventDefault();
      $("lightbox-img").src = img.src;
      box.hidden = false;
    }
  });
  $("map-mode-day").addEventListener("click", () => setMapMode("day"));
  $("map-mode-week").addEventListener("click", () => setMapMode("week"));
  $("map-mode-all").addEventListener("click", () => setMapMode("all"));
  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", (e) => {
    if (e.target.matches?.("input, textarea")) return;
    if (e.key === "Escape") {
      if (!$("sharebox").hidden) { hideShareBox(); return; }
      if (!$("sheet").hidden) { closeSheet(); return; }
      if (!$("lightbox").hidden) { $("lightbox").hidden = true; return; }
      if (!$("reader").hidden) closeReaderNav();
      return;
    }
    if (!$("reader").hidden) {
      if (e.key === "j" || e.key === "ArrowRight") readerStep(1);
      else if (e.key === "k" || e.key === "ArrowLeft") readerStep(-1);
      else if (e.key === "s") $("reader-save").click();
    } else if (e.key === "/") {
      e.preventDefault();
      location.hash = "/search";
    }
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

/* Every day's data in one shot — powers Search and Trends, which reason over the
   whole archive rather than one day. Cached; cleared on refresh. */
async function getAllDays() {
  if (state.allDays) return state.allDays;
  try {
    const rows = await sb("days?select=date,data&order=date.desc");
    state.allDays = rows.map((r) => r.data).filter(Boolean);
  } catch { state.allDays = []; }
  return state.allDays;
}

/* The three deep-data registries the pipeline maintains (steps 10b–10d). Each is
   a whole table fetched once and cached; cleared on refresh like the rest. They
   stay empty until the pipeline has qualifying content, so every render guards
   for []. */
async function getThreads() {
  if (state.threads) return state.threads;
  try {
    const rows = await sb("threads?select=slug,data");
    state.threads = rows.map((r) => ({ slug: r.slug, ...(r.data || {}) }));
  } catch { state.threads = []; }
  return state.threads;
}

async function getEvents() {
  if (state.events) return state.events;
  try {
    const rows = await sb("events?select=id,data");
    state.events = rows.map((r) => ({ id: r.id, ...(r.data || {}) }));
  } catch { state.events = []; }
  return state.events;
}

async function getMetrics() {
  if (state.metrics) return state.metrics;
  try {
    const rows = await sb("metrics?select=id,data");
    state.metrics = rows.map((r) => ({ id: r.id, ...(r.data || {}) }));
  } catch { state.metrics = []; }
  return state.metrics;
}

async function getPulse() {
  if (state.pulse) return state.pulse;
  try {
    const rows = await sb("market_pulse?id=eq.1&select=data");
    state.pulse = rows[0]?.data ?? null;
  } catch { state.pulse = null; }
  // best-effort revalidate through the edge function (serves the cache unless
  // it's gone stale, in which case it rebuilds) — never blocks first paint
  fetch(`${SUPABASE_URL}/functions/v1/market-pulse`, {
    cache: "no-store",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  }).then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (d && !d.error && (!state.pulse || d.generatedAt > state.pulse.generatedAt)) {
      state.pulse = d;
      if (location.hash.startsWith("#/desk/pulse") || location.hash.startsWith("#/market/")) route();
    }
  }).catch(() => {});
  return state.pulse;
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

async function refreshData(silent, manual) {
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
    state.players = null; // roster refetches next time the Players view opens
    state.terms = null;   // dictionary refetches next time the Dictionary view opens
    state.allDays = null; // Search/Trends corpus refetches on next open
    state.threads = null; // arcs/calendar/metrics refetch on next open
    state.events = null;
    state.metrics = null;
    state.pulse = null;   // Market Pulse re-reads the cache on next Desk/Market open

    const fresh = target ? await getDay(target) : null;
    state.currentDate = target;
    const changed = !!fresh && fresh.generatedAt !== before;

    const readerOpen = !$("reader").hidden;
    if (changed && !readerOpen) route();
    if (changed) flashToast("Briefing updated");
    else if (manual) flashToast("Up to date");
    loadRates();
  } catch {
    if (manual) flashToast("Couldn't refresh — try again");
  }
  refreshing = false;
}

function flashToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}

/* Wordmark tap on the briefing: refresh the DATA (Supabase re-query) and check
   for an APP update — if a new service worker version installs, reload so the
   fresh shell takes over immediately instead of on some later visit. */
async function hardRefresh() {
  refreshData(false, true);
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) return;
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      if (w) w.addEventListener("statechange", () => { if (w.state === "activated") location.reload(); });
    });
    await reg.update();
    if (reg.waiting) location.reload();
  } catch { /* offline — data refresh already toasted */ }
}

/* iPhone: the app shell must never zoom. Double-tap is disabled via
   touch-action, pinch via the viewport meta (honored in installed web apps)
   plus Safari's gesture events here. The map keeps its own pinch (Leaflet
   handles touches itself). */
window.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
window.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });
window.addEventListener("wheel", (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }, { passive: false });

function formatDate(iso, opts) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", opts);
}

/* ---------- routing ---------- */

function route() {
  const sheet = $("sheet");
  if (sheet && !sheet.hidden) closeSheet(); // a route change always drops the sheet
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
  } else if ((m = h.match(/^#\/player\/([\w-]+)$/))) {
    showView("players");
    renderPlayerProfile(m[1]);
  } else if (h === "#/players") {
    showView("players");
    renderPlayers();
  } else if ((m = h.match(/^#\/term\/([\w-]+)$/))) {
    showView("dictionary");
    renderTermProfile(m[1]);
  } else if (h === "#/dictionary") {
    showView("dictionary");
    renderDictionary();
  } else if (h === "#/history") {
    showView("history");
    renderHistory();
  } else if (h === "#/rates") {
    showView("rates");
    renderRates();
  } else if (h === "#/status") {
    showView("status");
    renderStatus();
  } else if (h === "#/alerts") {
    showView("alerts");
    renderAlerts();
  } else if ((m = h.match(/^#\/thread\/([\w-]+)$/))) {
    showView("threads");
    renderThread(m[1]);
  } else if (h === "#/threads") {
    showView("threads");
    renderThreads();
  } else if (h === "#/calendar") {
    showView("calendar");
    renderCalendar();
  } else if (h === "#/trends") {
    showView("trends");
    renderTrends();
  } else if ((m = h.match(/^#\/desk\/([\w-]+)$/))) {
    showView("trends");
    renderDeskSection(m[1]);
  } else if ((m = h.match(/^#\/market\/(.+)$/))) {
    showView("market");
    renderMarketPage(decodeURIComponent(m[1]));
  } else if (h === "#/search") {
    showView("search");
    renderSearch();
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

  const hasOverview = !!day.overview;
  const kps = day.keyPoints || [];
  $("lede-block").hidden = !hasOverview && !kps.length;
  $("overview-col").hidden = !hasOverview;
  $("lede").textContent = day.overview || "";
  linkifyElement($("lede"));

  $("kp-col").hidden = !kps.length;
  const kp = $("key-points");
  kp.innerHTML = "";
  for (const point of kps) {
    // a key point is either a plain string or { text, id } linking its source story
    const text = typeof point === "string" ? point : (point.text || "");
    const id = typeof point === "string" ? null : point.id;
    const li = document.createElement("li");
    li.textContent = text;
    if (id && (day.stories || []).some((s) => s.id === id)) {
      li.classList.add("kp-clickable");
      li.addEventListener("click", () => { location.hash = `/story/${date}/${id}`; });
    }
    kp.appendChild(li);
  }
  linkifyElement(kp);

  // forward-looking catalysts (newer day files; absent on old ones)
  const watch = $("watch-row");
  watch.hidden = !(day.watch || []).length;
  watch.innerHTML = "";
  if (!watch.hidden) {
    const label = document.createElement("span");
    label.className = "watch-label";
    label.textContent = "Watch";
    watch.appendChild(label);
    const list = document.createElement("div");
    list.className = "watch-items";
    for (const item of day.watch) {
      const el = document.createElement("div");
      el.className = "watch-item";
      el.textContent = item;
      list.appendChild(el);
    }
    linkifyElement(list);
    watch.appendChild(list);
    const cal = document.createElement("a");
    cal.className = "watch-cal";
    cal.href = "#/calendar";
    cal.textContent = "Full calendar →";
    watch.appendChild(cal);
  }

  if (state.controlsDate !== date) {
    state.filters = { type: null, asset: null, market: null };
    state.controlsDate = date;
  }
  renderControls(day);
  renderFeed(day);

  $("day-notes").hidden = !day.notes;
  if (day.notes) {
    $("day-notes").textContent = day.notes;
    linkifyElement($("day-notes"));
  }
  $("generated-at-text").textContent = day.generatedAt
    ? `Compiled ${new Date(day.generatedAt).toLocaleString("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`
    : "";
  paintHealthDot(day);
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

/* Publishers, in one fixed order so the footer never shows random permutations.
   `sources` already names the original publisher — the story `url` domain is only
   an email tracking-link wrapper (list-manage / beehiiv), never a real source, so
   it is never displayed. Abbreviations are footer-only and limited to names a
   reader already knows; the full article window always spells them out. */
const SOURCE_ORDER = ["The Real Deal", "Inman", "CRE Daily", "CRE Daily New York", "Traded"];
const SOURCE_ABBR = { "The Real Deal": "TRD", "CRE Daily New York": "CRE Daily NY", "The Wall Street Journal": "WSJ" };

function sourceLabels(sources, abbrev) {
  return (sources || []).slice()
    .sort((a, b) => {
      const ia = SOURCE_ORDER.indexOf(a), ib = SOURCE_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    })
    .map((s) => (abbrev && SOURCE_ABBR[s]) || s);
}

/* Credit the ORIGINAL PUBLISHER, not just the newsletter that surfaced the story.
   The publisher is read from the article URL's domain once the pipeline has
   resolved any email tracking-link wrapper to the real destination. Until that
   resolves (or for an unknown domain) we fall back to the newsletter name. */
const PUBLISHER_BY_DOMAIN = [
  ["therealdeal.com", "The Real Deal"],
  ["inman.com", "Inman"],
  ["credaily.com", "CRE Daily"],
  ["commercialsearch.com", "CommercialSearch"],
  ["multihousingnews.com", "Multi-Housing News"],
  ["commercialobserver.com", "Commercial Observer"],
  ["bisnow.com", "Bisnow"],
  ["globest.com", "GlobeSt"],
  ["connectcre.com", "Connect CRE"],
  ["costar.com", "CoStar"],
  ["altswire.com", "AltsWire"],
  ["chainstoreage.com", "Chain Store Age"],
  ["streeteasy.com", "StreetEasy"],
  ["rebusinessonline.com", "REBusiness"],
  ["wsj.com", "The Wall Street Journal"],
  ["traded.co", "Traded"],
  ["tradedmedia.co", "Traded"],
];
// email service providers whose domains are wrappers, never a publisher
const WRAPPER_DOMAINS = ["list-manage.com", "beehiiv.com", "mailchi.mp"];

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}

function publisherFromUrl(url) {
  const h = domainOf(url);
  if (!h || WRAPPER_DOMAINS.some((w) => h === w || h.endsWith("." + w) || h.endsWith(w))) return null;
  for (const [dom, name] of PUBLISHER_BY_DOMAIN) {
    if (h === dom || h.endsWith("." + dom)) return name;
  }
  return null; // real but unmapped domain → fall back to the newsletter
}

/* Display names to credit for a story, primary outlet first: the explicit
   `publisher` (or the resolved URL domain) leads, then every other outlet that
   covered it (coverage rows + newsletter sources, deduped). `abbrev` swaps in
   common short forms (TRD) for the footer; the reader passes false. */
function storyPublishers(story, abbrev) {
  const list = [];
  const push = (name) => { if (name && !list.includes(name)) list.push(name); };
  push(story.publisher || publisherFromUrl(story.url));
  for (const c of story.coverage || []) push(c.publisher);
  for (const s of sourceLabels(story.sources, false)) push(s);
  return list.map((n) => (abbrev && SOURCE_ABBR[n]) || n);
}

/* Footer form: first outlet [· second] [+N] — compact, corroboration visible. */
function publisherLine(story) {
  const names = storyPublishers(story, true);
  if (names.length <= 2) return names.join(" · ");
  return names.slice(0, 2).join(" · ") + ` +${names.length - 2}`;
}

function storyMeta(story, expandable) {
  const row = document.createElement("div");
  row.className = "meta";
  const left = document.createElement("span");
  // Footer: primary outlet [· second] [+N] · Cadence (only when Weekly/Special) · read time
  const parts = [publisherLine(story)];
  const cad = cadenceLabel(story); // "" for daily — the common case, kept unlabeled
  if (cad) parts.push(cad);
  if (expandable) {
    const mins = readMinutes(story);
    if (mins) parts.push(`${mins} min`);
  }
  left.textContent = parts.filter(Boolean).join(" · ");
  row.appendChild(left);

  // C: full text lives at a source we couldn't fetch — signal it reads off-site
  const blocked = !expandable && !!story.sourceBlocked && !!story.url;
  if (expandable) {
    const open = document.createElement("span");
    open.className = "meta-open";
    open.textContent = "Read ›";
    row.appendChild(open);
  } else if (story.url) {
    const a = document.createElement("a");
    a.className = blocked ? "meta-source redirect" : "meta-source";
    a.href = story.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = blocked ? "Read at source ↗" : "Source ↗";
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
  const per = derivedMetric(story);
  if (per) wrap.appendChild(chip(per));
  // arc chip: this story is a registered thread installment — tap through to the
  // timeline (stop the card's own click so it doesn't open the reader instead)
  if (story.thread) {
    const arc = chip("🧵 Arc", "chip-arc");
    arc.setAttribute("role", "link");
    arc.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      location.hash = `/thread/${story.thread}`;
    });
    wrap.appendChild(arc);
  }
  return wrap.children.length ? wrap : null;
}

function storyRow(story, date, lead) {
  const expandable = isExpandable(story);
  // C: no in-app text, but a full article lives at a 3rd-party source we couldn't
  // fetch (blocked). The whole card opens that source — same as the footer link.
  const blockedSource = !expandable && !!story.sourceBlocked && !!story.url;
  const el = document.createElement(expandable ? "button" : "div");
  el.className = "story" + (lead ? " lead" : "")
    + (expandable || blockedSource ? "" : " static")
    + (blockedSource ? " redirect" : "")
    + (expandable && isRead(date, story.id) ? " is-read" : "");
  if (expandable) {
    el.dataset.date = date;      // for swipe / long-press gestures + read dimming
    el.dataset.id = story.id;
    el.addEventListener("click", () => { location.hash = `/story/${date}/${story.id}`; });
  } else if (blockedSource) {
    el.addEventListener("click", (e) => {
      if (e.target.closest("a")) return; // let the footer's own link handle its click
      window.open(story.url, "_blank", "noopener");
    });
  }

  const h3 = document.createElement("h3");
  h3.textContent = story.title;
  el.appendChild(h3);

  if (story.summary) {
    const p = document.createElement("p");
    p.textContent = story.summary;
    linkifyElement(p);
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

/* ---------- catch-up (per reader profile) ----------
   The routine adds stories all day. Each profile keeps a snapshot of the last
   state it CLEARED; anything newer renders as a duplicate strip on top of the
   feed (the feed itself stays properly sorted below). Clear advances the
   snapshot. The snapshot only ever covers the latest day, so it stays tiny. */

function storySig(s) {
  // cheap change signature: content growth, new outlets, a new hero image
  return [contentWords(s), (s.coverage || []).length, s.image ? 1 : 0, (s.title || "").length].join("|");
}

function snapshotDay(day) {
  const sig = {};
  for (const s of day.stories || []) sig[s.id] = storySig(s);
  return { date: day.date, generatedAt: day.generatedAt, at: new Date().toISOString(), sig };
}

function renderCatchup(feed, day) {
  const latest = state.dates[state.dates.length - 1];
  if (day.date !== latest) return;
  const seen = pref("seen", null);
  if (!seen || seen.date !== day.date) {
    // first look at this day: baseline silently — catch-up measures from here
    setPref("seen", snapshotDay(day));
    return;
  }
  const fresh = [], updated = [];
  for (const s of day.stories || []) {
    const old = seen.sig?.[s.id];
    if (old === undefined) fresh.push(s);
    else if (old !== storySig(s)) updated.push(s);
  }
  if (!fresh.length && !updated.length) return;

  const box = document.createElement("div");
  box.className = "catchup";
  const head = document.createElement("div");
  head.className = "catchup-head";
  const label = document.createElement("span");
  label.className = "catchup-label";
  const since = seen.at ? new Date(seen.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "you left";
  label.textContent = `Since ${since}`;
  const count = document.createElement("span");
  count.className = "catchup-count";
  count.textContent = [fresh.length ? `${fresh.length} new` : null,
                       updated.length ? `${updated.length} updated` : null].filter(Boolean).join(" · ");
  const clear = document.createElement("button");
  clear.className = "catchup-clear";
  clear.textContent = "Clear";
  clear.addEventListener("click", () => { setPref("seen", snapshotDay(day)); renderFeed(day); });
  head.append(label, count, clear);
  box.appendChild(head);

  const addRow = (s, tag) => {
    const row = document.createElement("button");
    row.className = "catchup-row";
    row.addEventListener("click", () => {
      if (isExpandable(s)) location.hash = `/story/${day.date}/${s.id}`;
      else if (s.url) window.open(s.url, "_blank", "noopener");
    });
    const b = document.createElement("span");
    b.className = "catchup-tag" + (tag === "updated" ? " upd" : "");
    b.textContent = tag === "updated" ? "Updated" : "New";
    const t = document.createElement("span");
    t.className = "catchup-title";
    t.textContent = s.title;
    row.append(b, t);
    const meta = s.section || s.market;
    if (meta) {
      const m = document.createElement("span");
      m.className = "catchup-meta";
      m.textContent = meta;
      row.appendChild(m);
    }
    box.appendChild(row);
  };
  fresh.forEach((s) => addRow(s, "new"));
  updated.forEach((s) => addRow(s, "updated"));
  feed.appendChild(box);
}

function renderFeed(day) {
  const feed = $("feed");
  feed.innerHTML = "";
  const all = day.stories || [];

  renderCatchup(feed, day);

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

  // brief one-liners render as the "Also today" strip, never as cards
  const briefs = filtered.filter((s) => s.brief);
  const fullStories = filtered.filter((s) => !s.brief);

  // Top Stories band only in the unfiltered view
  let rest = fullStories;
  if (!filtering) {
    const featured = fullStories.filter((s) => s.featured);
    rest = fullStories.filter((s) => !s.featured);
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

  if (briefs.length) {
    feed.appendChild(sectionHead("Also today"));
    const strip = document.createElement("div");
    strip.className = "brief-strip";
    for (const s of briefs) {
      // briefs are compact in the FEED, not lesser stories: once the fill loop
      // has their article text they open in the reader like anything else
      const el = document.createElement(s.url || isExpandable(s) ? "button" : "div");
      el.className = "brief-row";
      el.addEventListener("click", () => {
        if (isExpandable(s)) location.hash = `/story/${day.date}/${s.id}`;
        else if (s.url) window.open(s.url, "_blank", "noopener");
      });
      const t = document.createElement("span");
      t.className = "brief-title";
      t.textContent = s.title;
      el.appendChild(t);
      const meta = [s.market, fmtValue(s.valueUsd)].filter(Boolean).join(" · ");
      if (meta) {
        const m = document.createElement("span");
        m.className = "brief-meta";
        m.textContent = meta;
        el.appendChild(m);
      }
      strip.appendChild(el);
    }
    feed.appendChild(strip);
  }

  // a finish line for the daily read
  if (!filtering) {
    const mins = fullStories.reduce((sum, s) => sum + readMinutes(s), 0);
    const done = document.createElement("div");
    done.className = "feed-done";
    done.textContent = `You're all caught up ✓ · ${all.length} ${all.length === 1 ? "story" : "stories"}${mins ? ` · ~${mins} min` : ""}`;
    feed.appendChild(done);
  }
}

/* ---------- map view ---------- */

function weekMonday(iso) {
  const d = new Date(iso + "T00:00:00");
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  return addDays(iso, -dow);
}

function mapDates() {
  if (state.mapMode === "all") return state.dates;
  if (state.mapMode === "week") {
    const cur = state.currentDate || state.dates[state.dates.length - 1];
    if (!cur) return [];
    const mon = weekMonday(cur);
    return state.dates.filter((d) => d >= mon && d <= cur);
  }
  return [state.currentDate].filter(Boolean);
}

function mapTitle(dates) {
  if (state.mapMode === "all") return `All time · ${dates.length} day${dates.length === 1 ? "" : "s"}`;
  if (state.mapMode === "week") return dates.length ? `Week of ${formatDate(dates[0], { month: "short", day: "numeric" })}` : "This week";
  return state.currentDate ? formatDate(state.currentDate, { weekday: "long", month: "long", day: "numeric" }) : "";
}

function setMapMode(mode) {
  state.mapMode = mode;
  $("map-mode-day").classList.toggle("on", mode === "day");
  $("map-mode-week").classList.toggle("on", mode === "week");
  $("map-mode-all").classList.toggle("on", mode === "all");
  renderMap();
}

// dealType → hex color as a Mapbox "match" expression, driving circle color
function typeColorExpr() {
  const m = ["match", ["get", "type"]];
  for (const [name, info] of Object.entries(DEAL_TYPES)) m.push(name, info.color);
  m.push("#8a94a0"); // default
  return m;
}

// deal-circle radius: grows with value but HARD-CAPPED so a $1B deal is a tidy
// ~20px dot, never a screen-eating ring (the old bug). Uses sqrt(value) so area
// tracks dollars, interpolated between sensible stops.
const RADIUS_EXPR = ["interpolate", ["linear"], ["sqrt", ["coalesce", ["get", "value"], 0]],
  0, 5, 1000, 6.5, 5000, 9, 15000, 13, 31623, 18, 70000, 22];

async function renderMap() {
  const canvas = $("map-canvas");
  if (typeof mapboxgl === "undefined") {
    canvas.innerHTML = "<p style='padding:20px;font-size:13px;color:var(--ink-2)'>Map library couldn't load (offline?). Try again once connected.</p>";
    return;
  }
  if (!state.map) {
    const token = await getMapboxToken();
    if (!token) {
      canvas.innerHTML = "<p style='padding:20px;font-size:13px;color:var(--ink-2)'>Map is momentarily unavailable. Try again in a moment.</p>";
      return;
    }
    mapboxgl.accessToken = token;
    state.map = new mapboxgl.Map({
      container: "map-canvas",
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      projection: "mercator", // flat map: predictable, and avoids the globe's
      center: [-95, 39.5], zoom: 3.2, minZoom: 2, maxZoom: 18, // initial-tile 'load' hang
      attributionControl: false, dragRotate: false, pitchWithRotate: false,
      cooperativeGestures: false, logoPosition: "bottom-left",
    });
    state.map.touchZoomRotate.disableRotation();
    state.map.addControl(new mapboxgl.NavigationControl({ showCompass: false, visualizePitch: false }), "top-right");
    state.map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");
    state.mapPopup = new mapboxgl.Popup({ closeButton: true, maxWidth: "270px", offset: 14, className: "mb-popup" });
    // Add layers + draw as soon as the STYLE is ready. 'style.load' is reliable;
    // the map-wide 'load' event can hang forever waiting on every initial tile.
    const onReady = () => { if (state.mapReady) return; state.mapReady = true; mapEnsureLayers(); renderMap(); };
    state.map.on("style.load", onReady);
    state.map.on("load", onReady);
    return;
  }
  if (!state.mapReady) return;
  stopPlayback();
  state.map.resize();

  const dates = mapDates();
  const items = [];
  const assets = new Set();
  for (const date of dates) {
    const day = await getDay(date);
    for (const story of day?.stories || []) {
      if (story.assetClass) assets.add(story.assetClass);
      for (const loc of story.locations || []) {
        if (typeof loc.lat === "number" && typeof loc.lng === "number") items.push({ date, story, loc });
      }
    }
  }

  $("map-title").textContent = mapTitle(dates);
  renderMapFilters([...assets].sort());

  const afterAV = items.filter((it) =>
    (!state.mapAsset || it.story.assetClass === state.mapAsset) &&
    (!state.mapValueBand || (it.story.valueUsd || 0) >= state.mapValueBand));
  const tally = new Map();
  for (const it of afterAV) if (it.story.dealType) tally.set(it.story.dealType, (tally.get(it.story.dealType) || 0) + 1);
  const shown = afterAV.filter((it) => !state.mapTypeFilter || state.mapTypeFilter.has(it.story.dealType));

  state.mapShown = shown;
  renderMapLegend(tally);
  drawDeals(shown, true);
  renderPlayback(shown);
}

// Build a GeoJSON FeatureCollection of deal points from {date, story, loc} items
function dealsGeoJSON(items) {
  return {
    type: "FeatureCollection",
    features: items.map(({ date, story, loc }) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [loc.lng, loc.lat] },
      properties: {
        date, id: story.id, title: story.title, type: story.dealType || "",
        asset: story.assetClass || "", market: story.market || "",
        value: story.valueUsd || 0, label: loc.label || "",
      },
    })),
  };
}

// Aggregate deals to one soft "money" bubble per market (centroid + total $) —
// the market-shading layer that answers "where is the capital going?"
function marketsGeoJSON(items) {
  const by = new Map();
  for (const { story, loc } of items) {
    const mk = story.market;
    if (!mk || mk === "National") continue;
    const g = by.get(mk) || { sumLat: 0, sumLng: 0, n: 0, total: 0, market: mk };
    g.sumLat += loc.lat; g.sumLng += loc.lng; g.n++; g.total += story.valueUsd || 0;
    by.set(mk, g);
  }
  return {
    type: "FeatureCollection",
    features: [...by.values()].filter((g) => g.total > 0).map((g) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [g.sumLng / g.n, g.sumLat / g.n] },
      properties: { market: g.market, total: g.total, count: g.n, totalLabel: fmtValue(g.total) || "" },
    })),
  };
}

function mapEnsureLayers() {
  const map = state.map;
  if (map.getSource("deals")) return;
  const empty = { type: "FeatureCollection", features: [] };
  map.addSource("markets", { type: "geojson", data: empty });
  map.addSource("deals", { type: "geojson", data: empty });

  // market "money" halo (behind deals)
  map.addLayer({
    id: "market-halo", type: "circle", source: "markets",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "total"]], 0, 18, 31623, 46, 200000, 78],
      "circle-color": "#ffcf6b", "circle-opacity": 0.14, "circle-blur": 0.7,
    },
  });
  map.addLayer({
    id: "market-label", type: "symbol", source: "markets",
    layout: {
      "text-field": ["concat", ["get", "market"], "  ", ["get", "totalLabel"]],
      "text-size": 12, "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
      "text-offset": [0, 0], "text-allow-overlap": false, "symbol-sort-key": ["-", 0, ["get", "total"]],
    },
    paint: { "text-color": "#fff3d6", "text-halo-color": "rgba(20,16,8,0.9)", "text-halo-width": 1.4 },
  });

  // deal dots
  map.addLayer({
    id: "deal-circle", type: "circle", source: "deals",
    paint: {
      "circle-radius": RADIUS_EXPR,
      "circle-color": typeColorExpr(),
      "circle-opacity": 0.9,
      "circle-stroke-width": 1.6,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-opacity": 0.85,
    },
  });

  map.on("click", "deal-circle", (e) => { if (e.features?.[0]) openDealPopup(e.features[0]); });
  map.on("click", "market-halo", (e) => {
    // a deal dot on top owns the click — the halo only responds to empty space
    if (map.queryRenderedFeatures(e.point, { layers: ["deal-circle"] }).length) return;
    const mk = e.features?.[0]?.properties?.market;
    if (mk) location.hash = `/market/${encodeURIComponent(mk)}`;
  });
  for (const layer of ["deal-circle", "market-halo", "market-label"]) {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  }
}

function openDealPopup(feature) {
  const p = feature.properties;
  const t = typeInfo(p.type);
  const div = document.createElement("div");
  div.className = "map-popup";
  const h4 = document.createElement("h4");
  h4.textContent = p.title;
  h4.addEventListener("click", () => { location.hash = `/story/${p.date}/${p.id}`; });
  const meta = document.createElement("div");
  meta.className = "pop-meta";
  meta.textContent = [p.type ? `${t.emoji} ${p.type}` : null, p.asset, fmtValue(p.value), formatDate(p.date, { month: "short", day: "numeric" })].filter(Boolean).join(" · ");
  div.append(h4, meta);
  if (p.label) { const locEl = document.createElement("div"); locEl.className = "pop-loc"; locEl.textContent = p.label; div.appendChild(locEl); }
  if (p.market) {
    const mk = document.createElement("a");
    mk.className = "pop-market";
    mk.href = `#/market/${encodeURIComponent(p.market)}`;
    mk.textContent = `View ${p.market} market ›`;
    div.appendChild(mk);
  }
  state.mapPopup.setLngLat(feature.geometry.coordinates).setDOMContent(div).addTo(state.map);
}

function drawDeals(items, fit) {
  if (!state.map?.getSource("deals")) return;
  state.map.getSource("deals").setData(dealsGeoJSON(items));
  // market halos only in aggregate modes (week / all), where they read as trend
  const showMarkets = state.mapMode !== "day";
  state.map.getSource("markets").setData(showMarkets ? marketsGeoJSON(items) : { type: "FeatureCollection", features: [] });
  for (const l of ["market-halo", "market-label"]) {
    if (state.map.getLayer(l)) state.map.setLayoutProperty(l, "visibility", showMarkets ? "visible" : "none");
  }
  if (fit) {
    if (!items.length) { state.map.easeTo({ center: [-95, 39.5], zoom: 3.2, duration: 500 }); return; }
    // A single offshore/international pin shouldn't zoom the whole world out —
    // if the spread is transoceanic, anchor the fit on the US mainland cluster.
    let pts = items;
    const spanB = new mapboxgl.LngLatBounds();
    for (const { loc } of items) spanB.extend([loc.lng, loc.lat]);
    if (spanB.getEast() - spanB.getWest() > 100 || spanB.getNorth() - spanB.getSouth() > 60) {
      const us = items.filter(({ loc }) => loc.lng >= -130 && loc.lng <= -60 && loc.lat >= 20 && loc.lat <= 52);
      if (us.length) pts = us;
    }
    if (pts.length === 1) { state.map.easeTo({ center: [pts[0].loc.lng, pts[0].loc.lat], zoom: 10, duration: 600 }); return; }
    const b = new mapboxgl.LngLatBounds();
    for (const { loc } of pts) b.extend([loc.lng, loc.lat]);
    state.map.fitBounds(b, { padding: 56, maxZoom: 12, duration: 700 });
  }
}

function renderMapFilters(assets) {
  const bar = $("map-filters");
  bar.innerHTML = "";
  const mk = (label, opts, cur, on) => {
    const sel = document.createElement("select");
    sel.className = "ctl-select";
    const f = document.createElement("option"); f.value = ""; f.textContent = label; sel.appendChild(f);
    for (const [val, txt] of opts) { const o = document.createElement("option"); o.value = String(val); o.textContent = txt; sel.appendChild(o); }
    sel.value = cur != null ? String(cur) : "";
    sel.addEventListener("change", () => on(sel.value || null));
    return sel;
  };
  bar.appendChild(mk("Any asset", assets.map((a) => [a, a]), state.mapAsset, (v) => { state.mapAsset = v; renderMap(); }));
  bar.appendChild(mk("Any size", [["25000000", "$25M+"], ["100000000", "$100M+"], ["500000000", "$500M+"]],
    state.mapValueBand, (v) => { state.mapValueBand = v ? Number(v) : null; renderMap(); }));
}

/* All-time playback: deals accumulate day by day so you watch flow spread across
   the map. Cumulative (not day-scrub) so sparse data reads as growth. */
let playTimer = null;
function stopPlayback() {
  state.mapPlaying = false;
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
}
function renderPlayback(shown) {
  const box = $("map-playback");
  if (state.mapMode !== "all") { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = "";
  const btn = document.createElement("button");
  btn.className = "map-play-btn";
  btn.textContent = state.mapPlaying ? "⏸ Pause" : "▶ Play accumulation";
  btn.addEventListener("click", () => {
    if (state.mapPlaying) { stopPlayback(); drawDeals(shown, false); renderPlayback(shown); }
    else { startPlayback(shown); renderPlayback(shown); }
  });
  const label = document.createElement("span");
  label.className = "map-play-label"; label.id = "map-play-label";
  box.append(btn, label);
}
function startPlayback(shown) {
  stopPlayback();
  const byDate = new Map();
  for (const it of shown) { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); }
  const days = [...byDate.keys()].sort();
  if (!days.length) return;
  state.mapPlaying = true;
  let i = 0; const acc = []; let sum = 0;
  const paint = () => { const l = $("map-play-label"); if (l) l.textContent = `${formatDate(days[Math.min(i, days.length - 1)], { month: "short", day: "numeric" })} · ${acc.length} deals · ${fmtValue(sum) || "$0"}`; };
  const step = () => {
    if (i >= days.length) { stopPlayback(); renderPlayback(shown); return; }
    for (const it of byDate.get(days[i])) { acc.push(it); sum += it.story.valueUsd || 0; }
    drawDeals(acc.slice(), i === 0);
    paint();
    i++;
  };
  step();
  playTimer = setInterval(step, Math.max(450, Math.min(1400, Math.round(11000 / days.length))));
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
    linkifyElement(p);
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
      linkifyElement(p);
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
    linkifyElement(p);
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
  await renderHistoryHeat(wrap);
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
      linkifyElement(p);
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

/* ---------- saved stories (bookmarks — kept per reader profile) ---------- */

function getSaved() { return pref("saved", []); }
function setSavedList(list) { setPref("saved", list); }
function savedKey(date, id) { return date + "/" + id; }
function isSaved(date, id) { return getSaved().some((s) => s.key === savedKey(date, id)); }
function toggleSaved(story, date) {
  const key = savedKey(date, story.id);
  const list = getSaved();
  const i = list.findIndex((s) => s.key === key);
  if (i >= 0) list.splice(i, 1);
  else list.unshift({ key, date, id: story.id, title: story.title, section: story.section || null, market: story.market || null });
  setSavedList(list);
  return i < 0; // true if now saved
}

/* ---------- read-state (per profile): dims cards you've read; set by opening a
   story or swiping a feed row left ---------- */
function readMark(date, id) { return date + "/" + id; }
function isRead(date, id) { return (pref("read", []) || []).includes(readMark(date, id)); }
function setRead(date, id, on) {
  const set = new Set(pref("read", []) || []);
  const k = readMark(date, id);
  if (on) set.add(k); else set.delete(k);
  setPref("read", [...set].slice(-800)); // cap so the list can't grow forever
}

/* ---------- search ---------- */

async function renderSearch() {
  const wrap = $("search-content");
  wrap.innerHTML = "";

  const bar = document.createElement("div");
  bar.className = "search-bar";
  const input = document.createElement("input");
  input.className = "search-input";
  input.type = "search";
  input.placeholder = "Search every briefing, players, terms…";
  input.value = state.searchQuery || "";
  bar.appendChild(input);
  wrap.appendChild(bar);

  const results = document.createElement("div");
  results.id = "search-results";
  wrap.appendChild(results);

  const [days, players, terms] = await Promise.all([getAllDays(), getPlayers(), getTerms()]);
  const run = () => { state.searchQuery = input.value; renderSearchResults(results, days, players, terms); };
  input.addEventListener("input", run);
  run();
  input.focus();
}

function searchStoryRow(date, id, title, meta) {
  const el = document.createElement("button");
  el.className = "search-story";
  el.addEventListener("click", () => { location.hash = `/story/${date}/${id}`; });
  const h = document.createElement("h4");
  h.textContent = title;
  el.appendChild(h);
  if (meta) {
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = meta;
    el.appendChild(m);
  }
  return el;
}

function renderSearchResults(root, days, players, terms) {
  root.innerHTML = "";
  const q = (state.searchQuery || "").trim().toLowerCase();

  // empty query → the Saved list is this surface's resting state
  if (!q) {
    const saved = getSaved();
    if (!saved.length) {
      const p = document.createElement("p");
      p.className = "search-hint";
      p.textContent = "Search across every briefing, plus the Players roster and Dictionary. Stories you save (★ in the reader) collect here.";
      root.appendChild(p);
      return;
    }
    root.appendChild(sectionHead("Saved"));
    const list = document.createElement("div");
    list.className = "story-group";
    for (const s of saved) {
      const sub = [formatDate(s.date, { month: "short", day: "numeric", year: "numeric" }), s.section || s.market].filter(Boolean).join(" · ");
      list.appendChild(searchStoryRow(s.date, s.id, s.title, sub));
    }
    root.appendChild(list);
    return;
  }

  const storyHits = [];
  for (const day of days) {
    for (const s of day.stories || []) {
      const blob = [s.title, s.summary, s.section, s.market, s.dealType, s.assetClass, s.publisher, (s.sources || []).join(" ")]
        .filter(Boolean).join(" ").toLowerCase();
      if (blob.includes(q)) storyHits.push({ date: day.date, s });
    }
  }
  storyHits.sort((a, b) => b.date.localeCompare(a.date));
  const playerHits = [...players.values()].filter((p) =>
    [p.name, p.role, p.org, p.tagline, ...(p.markets || []), ...(p.assetClasses || [])].filter(Boolean).join(" ").toLowerCase().includes(q));
  const termHits = [...terms.values()].filter((t) =>
    [t.term, t.category, t.shortDef, ...(t.aliases || [])].filter(Boolean).join(" ").toLowerCase().includes(q));

  if (!storyHits.length && !playerHits.length && !termHits.length) {
    const p = document.createElement("p");
    p.className = "search-hint";
    p.textContent = "No matches.";
    root.appendChild(p);
    return;
  }

  if (storyHits.length) {
    root.appendChild(sectionHead(`Stories · ${storyHits.length}`));
    const list = document.createElement("div");
    list.className = "story-group";
    for (const { date, s } of storyHits.slice(0, 80)) {
      const sub = [formatDate(date, { month: "short", day: "numeric" }), s.market, fmtValue(s.valueUsd)].filter(Boolean).join(" · ");
      list.appendChild(searchStoryRow(date, s.id, s.title, sub));
    }
    root.appendChild(list);
  }
  if (playerHits.length) {
    root.appendChild(sectionHead(`Players · ${playerHits.length}`));
    const grid = document.createElement("div");
    grid.className = "player-grid";
    for (const p of playerHits.slice(0, 12)) grid.appendChild(playerCard(p));
    root.appendChild(grid);
  }
  if (termHits.length) {
    root.appendChild(sectionHead(`Dictionary · ${termHits.length}`));
    const grid = document.createElement("div");
    grid.className = "player-grid";
    for (const t of termHits.slice(0, 12)) grid.appendChild(termCard(t));
    root.appendChild(grid);
  }
}

/* ---------- trends ---------- */

function hbarChart(items) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const box = document.createElement("div");
  box.className = "hbars";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "hbar-row";
    const label = document.createElement("div");
    label.className = "hbar-label";
    label.textContent = it.label;
    const track = document.createElement("div");
    track.className = "hbar-track";
    const fill = document.createElement("div");
    fill.className = "hbar-fill";
    fill.style.width = Math.max(3, (it.value / max) * 100) + "%";
    if (it.color) fill.style.background = it.color;
    track.appendChild(fill);
    const val = document.createElement("div");
    val.className = "hbar-val";
    val.textContent = it.sub;
    row.append(label, track, val);
    box.appendChild(row);
  }
  return box;
}

/* The Trends page shows only what curated trade-press coverage credibly
   supports. Each individual fact (a deal, its price, its parties) is real and
   editor-verified — but SUMS of them measure what got reported, not the market
   (one mega-deal's news day would dwarf a quiet week). So: facts are shown as
   facts (a comps ledger, records, a distress list) and attention is shown as
   attention (story counts, labeled as coverage) — never attention as dollars. */

function subHead(label, sub) {
  const wrap = document.createElement("div");
  wrap.appendChild(sectionHead(label));
  if (sub) {
    const p = document.createElement("p");
    p.className = "trends-note";
    p.textContent = sub;
    wrap.appendChild(p);
  }
  return wrap;
}

function ledgerRow(s) {
  const el = document.createElement("button");
  el.className = "ledger-row";
  el.addEventListener("click", () => { location.hash = `/story/${s._date}/${s.id}`; });
  const main = document.createElement("div");
  main.className = "lr-main";
  const t = document.createElement("div");
  t.className = "lr-title";
  t.textContent = s.title;
  const m = document.createElement("div");
  m.className = "lr-meta";
  m.textContent = [
    formatDate(s._date, { month: "short", day: "numeric" }),
    s.market,
    s.assetClass,
    s.dealType ? typeInfo(s.dealType).emoji + " " + s.dealType : null,
    s.cadence === "weekly" ? "Weekly recap" : null,
  ].filter(Boolean).join(" · ");
  main.append(t, m);
  const price = document.createElement("div");
  price.className = "lr-price";
  const v = document.createElement("div");
  v.className = "lr-val";
  v.textContent = fmtValue(s.valueUsd);
  price.appendChild(v);
  const per = derivedMetric(s);
  if (per) {
    const p = document.createElement("div");
    p.className = "lr-per";
    p.textContent = per;
    price.appendChild(p);
  }
  el.append(main, price);
  return el;
}

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const compPsf = (s) => (s.sizeSqft ? s.valueUsd / s.sizeSqft : null);
const compPunit = (s) => (s.units ? s.valueUsd / s.units : null);

/* ---------- Comps, delineated by market ----------
   A median across unlike deals in different cities and asset classes is noise.
   A comp only means something within one market + asset class (and, once the
   pipeline tags them, one submarket). So: group priced deals by market, show a
   median only where a market has 3+ comparable sales, and otherwise present the
   deals as individual reference points — never a fake market rate. */
function buildComps(body, priced) {
  body.innerHTML = "";
  const note = document.createElement("p");
  note.className = "trends-note";
  note.textContent = "Grouped by market, because a comp only holds within one market and asset class. A median appears once a market has 3+ comparable sales; below that these are individual reference points, not a rate. Submarket-level (neighborhood) breakdown lands as the pipeline tags them, and a data feed would make it robust.";
  body.appendChild(note);

  // asset-class scope (chips) — comps are only comparable within an asset class
  const assets = [...new Set(priced.map((s) => s.assetClass).filter(Boolean))].sort();
  const chips = document.createElement("div");
  chips.className = "comp-assetchips";
  const mkChip = (label, val) => {
    const c = document.createElement("button");
    c.className = "comp-assetchip" + ((state.compAsset || null) === val ? " on" : "");
    c.textContent = label;
    c.addEventListener("click", () => { state.compAsset = val; buildComps(body, priced); });
    return c;
  };
  chips.appendChild(mkChip("All assets", null));
  for (const a of assets) chips.appendChild(mkChip(a, a));
  body.appendChild(chips);

  const scope = priced.filter((s) => !state.compAsset || s.assetClass === state.compAsset);
  const byMarket = new Map();
  for (const s of scope) { const k = s.market || "—"; (byMarket.get(k) || byMarket.set(k, []).get(k)).push(s); }
  const markets = [...byMarket.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  if (!markets.length) {
    const p = document.createElement("p"); p.className = "trends-note"; p.textContent = "No priced deals in this asset class yet.";
    body.appendChild(p); return;
  }
  const list = document.createElement("div"); list.className = "comp-markets";
  for (const [market, deals] of markets) list.appendChild(compMarketRow(market, deals));
  body.appendChild(list);
}

// A row linking a market's board section to its unified Market page (external
// backdrop + internal deals). The join key across the app is `market`.
function marketBackdropLink(market) {
  const a = document.createElement("a");
  a.className = "cm-market-link";
  a.href = `#/market/${encodeURIComponent(market)}`;
  a.innerHTML = `<span>${market} market — rents, values &amp; the backdrop</span><span class="cm-ml-arrow">↗</span>`;
  return a;
}

function compMarketRow(market, deals) {
  const psfs = deals.map(compPsf).filter((v) => v);
  const punits = deals.map(compPunit).filter((v) => v);
  const total = deals.reduce((s, d) => s + (d.valueUsd || 0), 0);
  const wrap = document.createElement("div"); wrap.className = "comp-market";
  const head = document.createElement("button"); head.type = "button"; head.className = "comp-market-head";
  const name = document.createElement("span"); name.className = "cm-name"; name.textContent = market;
  const stat = document.createElement("span"); stat.className = "cm-stat";
  if (punits.length >= 3) stat.innerHTML = `<b>$${Math.round(median(punits)).toLocaleString()}/unit</b> median · n=${punits.length}`;
  else if (psfs.length >= 3) stat.innerHTML = `<b>$${Math.round(median(psfs)).toLocaleString()}/sf</b> median · n=${psfs.length}`;
  else stat.textContent = `${deals.length} deal${deals.length === 1 ? "" : "s"} · ${fmtValue(total) || "—"}`;
  const chev = document.createElement("span"); chev.className = "cm-chev"; chev.textContent = "▾";
  head.append(name, stat, chev);
  const inner = document.createElement("div"); inner.className = "comp-market-body"; inner.hidden = true;
  inner.appendChild(marketBackdropLink(market));
  for (const s of [...deals].sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0))) inner.appendChild(ledgerRow(s));
  head.addEventListener("click", () => { const o = inner.hidden; inner.hidden = !o; head.classList.toggle("open", o); });
  wrap.append(head, inner);
  return wrap;
}

/* ---------- Cap rates, by market ----------
   The purest read on what a market is pricing. Taken straight from coverage when
   a deal's cap rate is published, or computed as NOI ÷ price when both are given
   (derived). Grouped by market + asset like the comps, median only at n≥3. */
function capRateOf(s) {
  if (typeof s.capRate === "number" && s.capRate > 0) return { v: s.capRate, derived: false };
  if (s.noi && s.valueUsd) return { v: (s.noi / s.valueUsd) * 100, derived: true };
  return null;
}

function buildCapRates(body, stories) {
  body.innerHTML = "";
  const note = document.createElement("p");
  note.className = "trends-note";
  note.textContent = "Deal cap rates by market — published rates when coverage gives them, or NOI ÷ price when both are stated (derived). A median appears at 3+ per market; below that they're reference points. The single clearest gauge of what a market is pricing.";
  body.appendChild(note);

  const withCap = stories.map((s) => ({ s, cap: capRateOf(s) })).filter((x) => x.cap);
  if (!withCap.length) {
    body.appendChild(emptyPanel("No cap rates yet",
      "As coverage publishes a deal's cap rate — or its NOI and price (we compute the rate) — they collect here by market. Cap rates are cited constantly in CRE deal coverage, so this fills fast."));
    return;
  }
  const assets = [...new Set(withCap.map((x) => x.s.assetClass).filter(Boolean))].sort();
  const chips = document.createElement("div");
  chips.className = "comp-assetchips";
  const mkChip = (label, val) => {
    const c = document.createElement("button");
    c.className = "comp-assetchip" + ((state.capAsset || null) === val ? " on" : "");
    c.textContent = label;
    c.addEventListener("click", () => { state.capAsset = val; buildCapRates(body, stories); });
    return c;
  };
  chips.appendChild(mkChip("All assets", null));
  for (const a of assets) chips.appendChild(mkChip(a, a));
  body.appendChild(chips);

  const scope = withCap.filter((x) => !state.capAsset || x.s.assetClass === state.capAsset);
  const byMarket = new Map();
  for (const x of scope) { const k = x.s.market || "—"; (byMarket.get(k) || byMarket.set(k, []).get(k)).push(x); }
  const markets = [...byMarket.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const list = document.createElement("div");
  list.className = "comp-markets";
  for (const [market, obs] of markets) list.appendChild(capRateMarketRow(market, obs));
  body.appendChild(list);
}

function capRateMarketRow(market, obs) {
  const rates = obs.map((o) => o.cap.v);
  const wrap = document.createElement("div"); wrap.className = "comp-market";
  const head = document.createElement("button"); head.type = "button"; head.className = "comp-market-head";
  const name = document.createElement("span"); name.className = "cm-name"; name.textContent = market;
  const stat = document.createElement("span"); stat.className = "cm-stat";
  if (rates.length >= 3) stat.innerHTML = `<b>${median(rates).toFixed(1)}%</b> median cap · n=${rates.length}`;
  else stat.textContent = `${obs.length} cap rate${obs.length === 1 ? "" : "s"}`;
  const chev = document.createElement("span"); chev.className = "cm-chev"; chev.textContent = "▾";
  head.append(name, stat, chev);
  const inner = document.createElement("div"); inner.className = "comp-market-body"; inner.hidden = true;
  inner.appendChild(marketBackdropLink(market));
  for (const o of [...obs].sort((a, b) => a.cap.v - b.cap.v)) inner.appendChild(capObsRow(o));
  head.addEventListener("click", () => { const o = inner.hidden; inner.hidden = !o; head.classList.toggle("open", o); });
  wrap.append(head, inner);
  return wrap;
}

function capObsRow({ s, cap }) {
  const el = document.createElement("button");
  el.className = "ledger-row";
  el.addEventListener("click", () => { location.hash = `/story/${s._date}/${s.id}`; });
  const main = document.createElement("div"); main.className = "lr-main";
  const t = document.createElement("div"); t.className = "lr-title"; t.textContent = s.title;
  const m = document.createElement("div"); m.className = "lr-meta";
  m.textContent = [formatDate(s._date, { month: "short", day: "numeric" }), s.market, s.assetClass, fmtValue(s.valueUsd)].filter(Boolean).join(" · ");
  main.append(t, m);
  const price = document.createElement("div"); price.className = "lr-price";
  const v = document.createElement("div"); v.className = "lr-val"; v.textContent = cap.v.toFixed(1) + "%";
  const p = document.createElement("div"); p.className = "lr-per"; p.textContent = cap.derived ? "derived" : "stated";
  price.append(v, p);
  el.append(main, price);
  return el;
}

function buildMetrics(body, metrics) {
  if (!metrics.length) {
    body.appendChild(emptyPanel("No metrics yet",
      "As coverage cites market figures with a source — CMBS delinquency (Trepp), vacancy and rents (CBRE/JLL), price indices (Green Street) — they collect here, each tagged by geography."));
    return;
  }
  const note = document.createElement("p"); note.className = "trends-note";
  note.textContent = "Real figures the trade press cites, each tagged by geography and source. National series and market-specific prints kept distinct.";
  body.appendChild(note);
  const grid = document.createElement("div"); grid.className = "metric-grid";
  for (const m of [...metrics].sort((a, b) => (b.series?.length || 0) - (a.series?.length || 0))) grid.appendChild(metricCard(m));
  body.appendChild(grid);
}

function buildPulse(body, stories) {
  const maxDate = stories.reduce((m, s) => (s._date > m ? s._date : m), "0000");
  const inWin = (s, from, to) => s._date > from && s._date <= to;
  const d7 = addDays(maxDate, -7), d14 = addDays(maxDate, -14);
  const cur = stories.filter((s) => inWin(s, d7, maxDate));
  const prev = stories.filter((s) => inWin(s, d14, d7));
  const share = (l) => { const m = new Map(); for (const s of l) if (s.dealType) m.set(s.dealType, (m.get(s.dealType) || 0) + 1); return m; };
  const curShare = share(cur), prevShare = share(prev);
  const pulse = [...curShare.entries()].sort((a, b) => b[1] - a[1]);
  const note = document.createElement("p"); note.className = "trends-note";
  note.textContent = `Share of trade-press attention over the last 7 days (${cur.length} stories)${prev.length ? " — arrows vs the prior week" : ""}. Coverage, not market size.`;
  body.appendChild(note);
  if (!pulse.length) { const p = document.createElement("p"); p.className = "trends-note"; p.textContent = "No recent coverage."; body.appendChild(p); return; }
  body.appendChild(hbarChart(pulse.map(([name, n]) => {
    const pct = Math.round((n / cur.length) * 100);
    let delta = "";
    if (prev.length) { const pp = Math.round(((prevShare.get(name) || 0) / prev.length) * 100); delta = pct > pp ? " ▲" : pct < pp ? " ▼" : ""; }
    return { label: typeInfo(name).emoji + " " + name, value: n, sub: `${pct}%${delta}`, color: typeInfo(name).color };
  })));
}

function buildDistress(body, distress) {
  const box = document.createElement("div"); box.className = "week-stories";
  for (const s of distress) {
    const btn = document.createElement("button"); btn.className = "week-story";
    btn.addEventListener("click", () => { location.hash = `/story/${s._date}/${s.id}`; });
    const h4 = document.createElement("h4"); h4.textContent = s.title;
    const meta = document.createElement("div"); meta.className = "meta";
    meta.textContent = [formatDate(s._date, { month: "short", day: "numeric" }), s.market, s.assetClass, fmtValue(s.valueUsd)].filter(Boolean).join(" · ");
    btn.append(h4, meta); box.appendChild(btn);
  }
  body.appendChild(box);
}

function buildLedger(body, priced) {
  const bar = document.createElement("div");
  bar.className = "ctl-row ledger-bar";
  bar.appendChild(makeSelect("All markets", counts(priced, "market"), state.trendFilters.market, (v) => { state.trendFilters.market = v; renderLedgerList(priced); }));
  bar.appendChild(makeSelect("All assets", counts(priced, "assetClass"), state.trendFilters.asset, (v) => { state.trendFilters.asset = v; renderLedgerList(priced); }));
  bar.appendChild(makeSelect("All types", counts(priced, "dealType"), state.trendFilters.type, (v) => { state.trendFilters.type = v; renderLedgerList(priced); }));
  body.appendChild(bar);
  const sortBar = document.createElement("div");
  sortBar.className = "comp-sortbar";
  for (const [key, label] of [["recent", "Newest"], ["value", "$ high"], ["psf", "$/sf"], ["punit", "$/unit"]]) {
    const b = document.createElement("button");
    b.className = "comp-sort" + (state.compSort === key ? " on" : "");
    b.textContent = label;
    b.addEventListener("click", () => { state.compSort = key; sortBar.querySelectorAll(".comp-sort").forEach((x) => x.classList.toggle("on", x === b)); renderLedgerList(priced); });
    sortBar.appendChild(b);
  }
  const tally = document.createElement("span"); tally.className = "ctl-tally"; tally.id = "ledger-tally";
  sortBar.appendChild(tally);
  body.appendChild(sortBar);
  const list = document.createElement("div"); list.id = "ledger-list"; list.className = "ledger-list";
  body.appendChild(list);
  renderLedgerList(priced);
}

function renderLedgerList(priced) {
  const box = $("ledger-list");
  if (!box) return;
  box.innerHTML = "";
  const f = state.trendFilters;
  const filtered = priced.filter((s) =>
    (!f.market || s.market === f.market) &&
    (!f.asset || s.assetClass === f.asset) &&
    (!f.type || s.dealType === f.type)
  );
  // sort — $/sf and $/unit sorts also drop deals without that size
  const sort = state.compSort || "recent";
  let list = filtered;
  if (sort === "value") list = [...filtered].sort((a, b) => b.valueUsd - a.valueUsd);
  else if (sort === "psf") list = filtered.filter(compPsf).sort((a, b) => compPsf(b) - compPsf(a));
  else if (sort === "punit") list = filtered.filter(compPunit).sort((a, b) => compPunit(b) - compPunit(a));
  else list = [...filtered].sort((a, b) => b._date.localeCompare(a._date) || (b.valueUsd - a.valueUsd));

  const tally = $("ledger-tally");
  if (tally) tally.textContent = `${list.length} deal${list.length === 1 ? "" : "s"}`;
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "trends-note";
    p.textContent = sort === "psf" ? "No filtered deals report a square footage yet."
      : sort === "punit" ? "No filtered deals report a unit count yet."
        : "No priced deals match these filters.";
    box.appendChild(p);
    return;
  }
  for (const s of list.slice(0, 120)) box.appendChild(ledgerRow(s));
}

/* ---------- League Tables ----------
   Who is most active, by the role they actually played in a deal. Built from the
   players roster's mention ledger (each mention carries {role, valueUsd, date}),
   so it sharpens with every deal the pipeline credits — a real "most-active
   buyers / lenders / brokers this quarter" board, tap-through to each dossier. */
const LEAGUE_ROLES = [
  ["buyer", "Buyers", "🏢"],
  ["seller", "Sellers", "🏷️"],
  ["lender", "Lenders", "🏦"],
  ["developer", "Developers", "🏗️"],
  ["landlord", "Landlords", "🔑"],
  ["broker", "Brokers", "🤝"],
];
const LEAGUE_WINS = [[0, "All time"], [90, "90 days"], [30, "30 days"]];

function buildLeagueTables(body, players) {
  body.innerHTML = "";
  const roster = [...players.values()];
  if (!roster.length) {
    body.appendChild(emptyPanel("No players yet",
      "As the roster credits buyers, sellers, lenders and brokers on deals, the most-active players rank here by role."));
    return;
  }
  const note = document.createElement("p");
  note.className = "trends-note";
  note.textContent = "Most-active players by the role they played, ranked on deals credited over the window. Counts real transaction roles from the roster — it deepens with every deal the pipeline attributes.";
  body.appendChild(note);

  // role selector
  const roleBar = document.createElement("div");
  roleBar.className = "comp-assetchips";
  for (const [key, label, emoji] of LEAGUE_ROLES) {
    const c = document.createElement("button");
    c.className = "comp-assetchip" + (state.leagueRole === key ? " on" : "");
    c.textContent = `${emoji} ${label}`;
    c.addEventListener("click", () => { state.leagueRole = key; buildLeagueTables(body, players); });
    roleBar.appendChild(c);
  }
  body.appendChild(roleBar);

  // window selector
  const winBar = document.createElement("div");
  winBar.className = "comp-sortbar";
  for (const [days, label] of LEAGUE_WINS) {
    const b = document.createElement("button");
    b.className = "comp-sort" + (state.leagueWin === days ? " on" : "");
    b.textContent = label;
    b.addEventListener("click", () => { state.leagueWin = days; buildLeagueTables(body, players); });
    winBar.appendChild(b);
  }
  body.appendChild(winBar);

  const role = state.leagueRole;
  const win = state.leagueWin;
  const ranked = [];
  for (const p of roster) {
    let count = 0, volume = 0;
    for (const mn of (p.mentions || [])) {
      if (mn.role !== role) continue;
      if (win && daysSince(mn.date) > win) continue;
      count++;
      if (typeof mn.valueUsd === "number") volume += mn.valueUsd;
    }
    if (count) ranked.push({ p, count, volume });
  }
  ranked.sort((a, b) => b.count - a.count || b.volume - a.volume || a.p.name.localeCompare(b.p.name));

  if (!ranked.length) {
    const empty = document.createElement("p");
    empty.className = "trends-note";
    const label = (LEAGUE_ROLES.find((r) => r[0] === role) || [, "players"])[1].toLowerCase();
    empty.textContent = win ? `No ${label} credited in the last ${win} days.` : `No ${label} credited yet.`;
    body.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "league-list";
  ranked.slice(0, 25).forEach((r, i) => list.appendChild(leagueRow(r, i + 1)));
  body.appendChild(list);
}

function leagueRow({ p, count, volume }, rank) {
  const el = document.createElement("button");
  el.className = "league-row";
  el.addEventListener("click", () => { location.hash = `/player/${p.slug}`; });
  const num = document.createElement("span");
  num.className = "league-rank";
  num.textContent = rank;
  const av = playerAvatar(p);
  av.classList.add("league-av");
  const main = document.createElement("div");
  main.className = "league-main";
  const name = document.createElement("div");
  name.className = "league-name";
  name.textContent = p.name;
  const sub = document.createElement("div");
  sub.className = "league-sub";
  sub.textContent = p.role || (p.type === "person" ? "Person" : "Company");
  main.append(name, sub);
  const stat = document.createElement("div");
  stat.className = "league-stat";
  const c = document.createElement("div");
  c.className = "league-count";
  c.textContent = `${count} deal${count === 1 ? "" : "s"}`;
  stat.appendChild(c);
  if (volume) {
    const v = document.createElement("div");
    v.className = "league-vol";
    v.textContent = fmtValue(volume);
    stat.appendChild(v);
  }
  el.append(num, av, main, stat);
  return el;
}

/* ---------- The Desk: a ranked board of tools ----------
   Every analytical surface is a tap-through card (same language as Calendar and
   Story Arcs), ordered by strength/interest — the macro backdrop first, then the
   numbers that sharpen as coverage accumulates. Each opens its own full board. */
const DESK_CATALOG = [
  { id: "pulse", icon: "📈", title: "Market Pulse", blurb: "The national backdrop — rates, home prices, rents, credit — in deep, real data" },
  { id: "comps", icon: "🏙️", title: "Comps", blurb: "$/sf and $/unit medians, delineated by market and asset class" },
  { id: "caprates", icon: "🎯", title: "Cap Rates", blurb: "What each market is pricing, straight from deal coverage" },
  { id: "league", icon: "🏆", title: "League Tables", blurb: "Most-active buyers, lenders, developers and brokers" },
  { id: "metrics", icon: "📊", title: "Market Metrics", blurb: "Figures the trade press cites — delinquency, vacancy, rents" },
  { id: "distress", icon: "⚠️", title: "Distress Watch", blurb: "Defaults, foreclosures and forced sales as they surface" },
  { id: "coverage", icon: "🔥", title: "Coverage Pulse", blurb: "What the desks are covering this week versus last" },
  { id: "ledger", icon: "💵", title: "Deal Ledger", blurb: "Every priced deal, filterable and sortable" },
  { id: "calendar", icon: "📅", title: "Calendar", blurb: "Upcoming catalysts — auctions, court dates, Fed decisions", hash: "#/calendar" },
  { id: "threads", icon: "🧵", title: "Story Arcs", blurb: "Running storylines the briefing is tracking", hash: "#/threads" },
];

async function renderTrends() {
  const wrap = $("trends-content");
  wrap.innerHTML = "";
  wrap.appendChild(pageHead("The Desk",
    "The market's macro backdrop and every number the briefing accumulates — each board a tap away."));

  // the landing needs six independent tables — fetch them in parallel (one round
  // trip, not six) so the Desk paints fast on first open
  const [days, metrics, players, events, threads, pulse] = await Promise.all([
    getAllDays(), getMetrics(), getPlayers(), getEvents(), getThreads(), getPulse(),
  ]);
  const stories = days.flatMap((d) => (d.stories || []).map((s) => ({ ...s, _date: d.date })));
  const priced = stories.filter((s) => s.valueUsd);
  const distress = stories.filter((s) => s.dealType === "Distress");

  const stat = {
    pulse: pulse?.national ? `${Object.keys(pulse.national).length} indicators live` : "live data",
    comps: `${new Set(priced.map((s) => s.market).filter(Boolean)).size} markets`,
    caprates: `${stories.filter((s) => capRateOf(s)).length} rates`,
    league: `${players.size} players`,
    metrics: `${metrics.length} series`,
    distress: `${distress.length} on watch`,
    coverage: `${stories.length} stories`,
    ledger: `${priced.length} priced deals`,
    calendar: `${events.filter((e) => (e.date || "") >= todayISO() && !e.resolvedBy).length} upcoming`,
    threads: `${threads.filter((t) => t.status !== "resolved").length} active`,
  };

  const grid = document.createElement("div");
  grid.className = "desk-grid";
  for (const item of DESK_CATALOG) grid.appendChild(deskCard(item, stat[item.id]));
  wrap.appendChild(grid);
}

function deskCard(item, stat) {
  const a = document.createElement("a");
  a.className = "desk-card" + (item.id === "pulse" ? " dc-feature" : "");
  a.href = item.hash || `#/desk/${item.id}`;
  a.innerHTML =
    `<span class="dc-icon">${item.icon}</span>` +
    `<span class="dc-body"><span class="dc-title">${item.title}</span>` +
    `<span class="dc-blurb">${item.blurb}</span></span>` +
    `<span class="dc-foot"><span class="dc-stat">${stat || ""}</span><span class="dc-arrow">›</span></span>`;
  return a;
}

async function renderDeskSection(id) {
  const wrap = $("trends-content");
  wrap.innerHTML = "";
  wrap.appendChild(backLink("The Desk", "#/trends"));
  const item = DESK_CATALOG.find((x) => x.id === id);
  if (!item) { wrap.appendChild(emptyPanel("Not found", "That board isn't here.")); return; }

  if (id === "pulse") {
    wrap.appendChild(pageHead("Market Pulse",
      "The national market read, pooled from public data the trade shops themselves quote — the Fed's rate and credit series, Case-Shiller home prices, and Zillow's market-by-market rents. Tap any signal for its full history."));
    const pulse = await getPulse();
    buildMarketPulse(wrap, pulse);
    return;
  }

  wrap.appendChild(pageHead(item.title, item.blurb));
  const days = await getAllDays();
  const stories = days.flatMap((d) => (d.stories || []).map((s) => ({ ...s, _date: d.date })));
  const priced = stories.filter((s) => s.valueUsd);
  const body = document.createElement("div");
  body.className = "desk-page";
  wrap.appendChild(body);
  if (!stories.length && id !== "metrics") {
    body.appendChild(emptyPanel("Nothing here yet", "This board fills as briefings accumulate."));
    return;
  }
  switch (id) {
    case "comps": buildComps(body, priced); break;
    case "caprates": buildCapRates(body, stories); break;
    case "league": buildLeagueTables(body, await getPlayers()); break;
    case "metrics": buildMetrics(body, await getMetrics()); break;
    case "distress": buildDistress(body, distressStories(stories)); break;
    case "coverage": buildPulse(body, stories); break;
    case "ledger": buildLedger(body, priced); break;
  }
}

function distressStories(stories) {
  return stories.filter((s) => s.dealType === "Distress").sort((a, b) => b._date.localeCompare(a._date));
}

/* ---------- Market Pulse: the national backdrop ----------
   One read on the whole market, built from FRED (rates/credit/prices/housing)
   and Zillow (rents/values) via the market-pulse edge function. A computed
   verdict up top, signal tiles grouped by theme, each opening a scrubbable
   multi-year chart, then a by-market board that flows into the Market pages. */
const PULSE_NEUTRAL = new Set(["ust10y", "ust2y", "spread", "fedfunds"]);
const PULSE_GROUPS = [["rates", "Rates & Credit"], ["housing", "Housing & Rents"], ["economy", "Economy"]];

function fmtMoney(v) {
  if (v == null) return "—";
  if (Math.abs(v) >= 1e6) return "$" + (v / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
  if (Math.abs(v) >= 1e5) return "$" + Math.round(v / 1e3) + "K";
  return "$" + Math.round(v).toLocaleString();
}

function fmtPulseLevel(v, unit) {
  if (v == null) return "—";
  if (unit === "%") return v.toFixed(2) + "%";
  if (unit === "$") return fmtMoney(v);
  if (unit === "K") return (v / 1000).toFixed(2) + "M";
  if (unit === "M") return (v / 1e6).toFixed(2) + "M";
  if (unit === "index") return v.toFixed(1);
  return String(v);
}

function signed(n, digits = 1) { return (n >= 0 ? "+" : "") + n.toFixed(digits); }

function buildMarketPulse(wrap, pulse) {
  if (!pulse?.national || !Object.keys(pulse.national).length) {
    wrap.appendChild(emptyPanel("Market Pulse is warming up",
      "The national data feed refreshes a few times a day. Check back shortly."));
    return;
  }
  const n = pulse.national;

  // computed verdict
  const verdict = computeVerdict(pulse);
  const vb = document.createElement("div");
  vb.className = "pulse-verdict " + verdict.tone;
  vb.innerHTML = `<span class="pv-kicker">The read</span><p class="pv-text">${verdict.text}</p>`;
  wrap.appendChild(vb);

  // if a signal's chart is open, show it up top
  const openSeries = resolvePulseSeries(pulse, state.pulseKey);
  if (openSeries) wrap.appendChild(pulseChartPanel(openSeries));

  // group tabs
  const tabs = document.createElement("div");
  tabs.className = "pulse-tabs";
  for (const [g, label] of PULSE_GROUPS) {
    const b = document.createElement("button");
    b.className = "pulse-tab" + (state.pulseGroup === g ? " on" : "");
    b.textContent = label;
    b.addEventListener("click", () => { state.pulseGroup = g; route(); });
    tabs.appendChild(b);
  }
  wrap.appendChild(tabs);

  // signal tiles for the active group
  const grid = document.createElement("div");
  grid.className = "pulse-grid";
  const order = pulse.order || Object.keys(n);
  for (const key of order) {
    const s = n[key];
    if (!s || s.group !== state.pulseGroup) continue;
    grid.appendChild(pulseTile(s));
  }
  // fold Zillow national rent/value into the housing group
  if (state.pulseGroup === "housing" && pulse.zillowNational) {
    if (pulse.zillowNational.rent) grid.appendChild(pulseZillowTile("National Rent (Zillow)", "rent", pulse.zillowNational.rent));
    if (pulse.zillowNational.value) grid.appendChild(pulseZillowTile("Home Value (Zillow)", "value", pulse.zillowNational.value));
  }
  wrap.appendChild(grid);

  // the Rates page is the deep tool for the curve; link to it from here
  if (state.pulseGroup === "rates") {
    const see = document.createElement("a");
    see.className = "pulse-seelink";
    see.href = "#/rates";
    see.innerHTML = "See the full Treasury curve, forwards &amp; SOFR &rarr;";
    wrap.appendChild(see);
  }

  // by-market board → each flows into a full Market page
  wrap.appendChild(subHead("By market", "Home prices, rents and values across the metros the briefing covers"));
  const markets = document.createElement("div");
  markets.className = "pulse-markets";
  const metroOrder = Object.entries(pulse.metros || {}).sort((a, b) =>
    a[0] === "New York" ? -1 : b[0] === "New York" ? 1 : a[0].localeCompare(b[0]));
  for (const [name, md] of metroOrder) markets.appendChild(pulseMarketRow(name, md));
  wrap.appendChild(markets);

  const note = document.createElement("p");
  note.className = "trends-note";
  const when = pulse.generatedAt ? formatDate(pulse.generatedAt.slice(0, 10), { month: "short", day: "numeric" }) : "";
  note.textContent = `Sources: ${(pulse.sources || []).join(", ")}. Refreshed ${when}. Free public data — the same series the trade press cites, not a licensed CoStar feed.`;
  wrap.appendChild(note);
}

/* Change indicator for a tile. NOTE: `s.yoy` is the computed YoY *number* (the
   edge function's series() field), not a flag. Rule: %-level series (rates,
   credit, vacancy, unemployment) show their change vs the prior print; every
   other unit ($/index/K/M) tells its story in year-over-year terms.
   Returns { txt, cls, up } — `up` is the value's direction (drives the arrow),
   `cls` is good/bad/flat (drives the color). */
function pulseDelta(s) {
  const neutral = PULSE_NEUTRAL.has(s.key);
  if (s.unit !== "%") {
    if (s.yoy == null) return null;
    const up = s.yoy >= 0;
    const good = s.invert ? s.yoy < 0 : s.yoy > 0;
    return { txt: `${signed(s.yoy)}% YoY`, cls: neutral ? "flat" : good ? "good" : "bad", up };
  }
  if (!s.latest || !s.prev) return null;
  const d = s.latest.value - s.prev.value;
  if (Math.abs(d) < 1e-9) return { txt: "flat", cls: "flat", up: true, noArrow: true };
  const up = d >= 0;
  const good = s.invert ? d < 0 : d > 0;
  const cls = neutral ? "flat" : good ? "good" : "bad";
  const bp = Math.round(d * 100);
  return { txt: `${d >= 0 ? "+" : ""}${bp} bp`, cls, up };
}

function pulseTile(s) {
  const el = document.createElement("button");
  el.className = "pulse-tile" + (state.pulseKey === s.key ? " on" : "");
  el.addEventListener("click", () => { state.pulseKey = state.pulseKey === s.key ? null : s.key; route(); });

  // for index series the headline number is the YoY, not the meaningless level
  const big = s.unit === "index" && s.yoy != null ? `${signed(s.yoy)}%` : fmtPulseLevel(s.latest?.value, s.unit);

  const l = document.createElement("div"); l.className = "pt-label"; l.textContent = s.short;
  const v = document.createElement("div"); v.className = "pt-value"; v.textContent = big;
  el.append(l, v);

  const c = document.createElement("div");
  if (s.unit === "index") {
    c.className = "pt-chg sub"; c.textContent = "year-over-year";
  } else {
    const d = pulseDelta(s);
    if (d) { c.className = "pt-chg " + d.cls; c.textContent = (d.noArrow ? "" : d.up ? "▲ " : "▼ ") + d.txt; }
  }
  if (c.textContent) el.appendChild(c);
  if (s.history?.length > 1) el.appendChild(miniSpark(s.history, s.invert));
  return el;
}

function pulseZillowTile(label, kind, s) {
  const el = document.createElement("button");
  const vk = "zil_" + kind;
  el.className = "pulse-tile" + (state.pulseKey === vk ? " on" : "");
  el.addEventListener("click", () => { state.pulseKey = state.pulseKey === vk ? null : vk; route(); });
  const l = document.createElement("div"); l.className = "pt-label"; l.textContent = label;
  const v = document.createElement("div"); v.className = "pt-value"; v.textContent = fmtMoney(s.latest?.value);
  el.append(l, v);
  if (s.yoy != null) {
    const good = s.yoy > 0;
    const c = document.createElement("div"); c.className = "pt-chg " + (good ? "good" : "bad");
    c.textContent = (good ? "▲ " : "▼ ") + `${signed(s.yoy)}% YoY`;
    el.appendChild(c);
  }
  if (s.history?.length > 1) el.appendChild(miniSpark(s.history, false));
  return el;
}

function resolvePulseSeries(pulse, key) {
  if (!key || !pulse) return null;
  if (pulse.national?.[key]) return pulse.national[key];
  if (key === "zil_rent" && pulse.zillowNational?.rent) return { key, label: "National Rent (Zillow)", short: "National Rent", unit: "$", ...pulse.zillowNational.rent };
  if (key === "zil_value" && pulse.zillowNational?.value) return { key, label: "Home Value (Zillow)", short: "Home Value", unit: "$", ...pulse.zillowNational.value };
  return null;
}

function pulseChartPanel(s) {
  const panel = document.createElement("div");
  panel.className = "pulse-chart-panel";
  const head = document.createElement("div");
  head.className = "pcp-head";
  const title = document.createElement("div"); title.className = "pcp-title"; title.textContent = s.label || s.short;
  const close = document.createElement("button"); close.className = "pcp-close"; close.textContent = "✕";
  close.setAttribute("aria-label", "Close chart");
  close.addEventListener("click", () => { state.pulseKey = null; route(); });
  head.append(title, close);
  panel.appendChild(head);

  // range selector
  const ranges = [[24, "2Y"], [60, "5Y"], [120, "Max"]];
  const rbar = document.createElement("div"); rbar.className = "pcp-ranges";
  for (const [mo, label] of ranges) {
    const b = document.createElement("button");
    b.className = "pcp-range" + (state.pulseRange === mo ? " on" : "");
    b.textContent = label;
    b.addEventListener("click", () => { state.pulseRange = mo; route(); });
    rbar.appendChild(b);
  }
  panel.appendChild(rbar);

  const chart = document.createElement("div"); chart.className = "curve-wrap";
  chart.appendChild(buildPulseChart(s.history || [], { unit: s.unit, months: state.pulseRange, yoy: s.yoy != null }));
  panel.appendChild(chart);
  return panel;
}

function pulseMarketRow(name, md) {
  const el = document.createElement("a");
  el.className = "pmk-row";
  el.href = `#/market/${encodeURIComponent(name)}`;
  const nm = document.createElement("div"); nm.className = "pmk-name"; nm.textContent = name;
  const stats = document.createElement("div"); stats.className = "pmk-stats";
  const stat = (label, val, yoy) => {
    if (val == null) return;
    const c = document.createElement("div"); c.className = "pmk-stat";
    let sub = "";
    if (yoy != null) { const g = yoy >= 0; sub = `<span class="pmk-yoy ${g ? "good" : "bad"}">${signed(yoy)}%</span>`; }
    c.innerHTML = `<span class="pmk-k">${label}</span><span class="pmk-v">${val}</span>${sub}`;
    stats.appendChild(c);
  };
  if (md.rent) stat("Rent", fmtMoney(md.rent.latest?.value), md.rent.yoy);
  if (md.value) stat("Value", fmtMoney(md.value.latest?.value), md.value.yoy);
  if (md.caseShiller) stat("Prices", null, md.caseShiller.yoy); // YoY-only shown as its own
  if (md.caseShiller && md.caseShiller.yoy != null) {
    const c = document.createElement("div"); c.className = "pmk-stat";
    const g = md.caseShiller.yoy >= 0;
    c.innerHTML = `<span class="pmk-k">Case-Shiller</span><span class="pmk-v ${g ? "good" : "bad"}">${signed(md.caseShiller.yoy)}%</span>`;
    stats.appendChild(c);
  }
  const arrow = document.createElement("span"); arrow.className = "pmk-arrow"; arrow.textContent = "›";
  el.append(nm, stats, arrow);
  return el;
}

/* compact inline sparkline (no axes) for pulse tiles */
function miniSpark(hist, invert) {
  const pts = (hist || []).filter((p) => typeof p.value === "number").slice(-36);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "pt-spark");
  svg.setAttribute("viewBox", "0 0 100 28");
  svg.setAttribute("preserveAspectRatio", "none");
  if (pts.length < 2) return svg;
  const xs = pts.map((_, i) => (i / (pts.length - 1)) * 100);
  const vals = pts.map((p) => p.value);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const ys = vals.map((v) => 26 - ((v - lo) / (hi - lo || 1)) * 24);
  const rising = vals[vals.length - 1] >= vals[0];
  const good = invert ? !rising : rising;
  const cls = good ? "spark-good" : "spark-bad";
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" "));
  path.setAttribute("class", "pt-spark-line " + cls);
  path.setAttribute("fill", "none");
  svg.appendChild(path);
  return svg;
}

function computeVerdict(p) {
  const n = p.national || {};
  const bits = [];
  let easing = 0, tightening = 0;
  const mort = n.mortgage30;
  if (mort?.latest) {
    const d = mort.latest.value - (mort.prev?.value ?? mort.latest.value);
    if (d < -0.02) { bits.push(`30-year mortgages are easing to ${mort.latest.value.toFixed(2)}%`); easing++; }
    else if (d > 0.02) { bits.push(`30-year mortgages have climbed to ${mort.latest.value.toFixed(2)}%`); tightening++; }
    else bits.push(`30-year mortgages are holding near ${mort.latest.value.toFixed(2)}%`);
  }
  const hpi = n.hpi;
  if (hpi?.yoy != null) {
    bits.push(hpi.yoy > 4 ? `home prices are still rising (${signed(hpi.yoy)}% YoY)`
      : hpi.yoy > 0.5 ? `home-price growth has cooled to ${signed(hpi.yoy)}% YoY`
      : hpi.yoy > -0.5 ? "home prices have gone flat" : `home prices are slipping (${signed(hpi.yoy)}% YoY)`);
  }
  const rent = p.zillowNational?.rent;
  if (rent?.yoy != null) {
    bits.push(rent.yoy > 4 ? `rents are running hot (${signed(rent.yoy)}% YoY)`
      : rent.yoy > 1.5 ? `rent growth is moderating (${signed(rent.yoy)}% YoY)`
      : `rents are soft (${signed(rent.yoy)}% YoY)`);
  }
  const cre = n.cre_delinq;
  if (cre?.latest) {
    const d = cre.latest.value - (cre.prev?.value ?? cre.latest.value);
    if (d > 0.03) { bits.push(`and CRE loan delinquency is grinding higher to ${cre.latest.value.toFixed(1)}%`); tightening++; }
    else if (cre.latest.value > 1.2) bits.push(`with CRE loan delinquency elevated at ${cre.latest.value.toFixed(1)}%`);
  }
  let text = bits.join("; ").replace("; and", ", and");
  text = text.charAt(0).toUpperCase() + text.slice(1) + ".";
  const tone = tightening > easing ? "tight" : easing > tightening ? "easy" : "mixed";
  return { text, tone };
}

/* generalized scrubbable line chart for a Market Pulse series (reuses attachScrub) */
function buildPulseChart(history, opts) {
  const unit = opts.unit;
  const months = opts.months || 60;
  const cut = new Date(); cut.setMonth(cut.getMonth() - months);
  const cutIso = cut.toISOString().slice(0, 10);
  const pts = (history || []).filter((p) => typeof p.value === "number" && p.date >= cutIso);
  if (pts.length < 2) {
    const el = document.createElement("p");
    el.style.cssText = "font-style:italic;color:var(--ink-2);padding:26px 10px";
    el.textContent = "Not enough history for this range.";
    return el;
  }
  const fmtV = (v) => unit === "%" ? v.toFixed(2) : unit === "$" ? fmtMoney(v) : unit === "K" ? (v / 1000).toFixed(1) + "M" : unit === "M" ? (v / 1e6).toFixed(1) + "M" : v.toFixed(0);
  const fmtAxis = (v) => unit === "%" ? v.toFixed(2) : unit === "$" ? (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + "M" : Math.round(v / 1e3) + "K") : unit === "K" ? (v / 1000).toFixed(1) : unit === "M" ? (v / 1e6).toFixed(1) : Math.round(v).toString();

  const mobile = matchMedia("(max-width: 700px)").matches;
  const k = mobile ? 1.9 : 1;
  const W = 680, H = mobile ? 545 : 320;
  const padL = 52 * (mobile ? 1.5 : 1), padR = 54 * k * 0.6, padT = 20 * k, padB = 32 * k;
  const fs = { axis: 10 * k, value: 11 * k };
  const t0 = Date.parse(pts[0].date), t1 = Date.parse(pts[pts.length - 1].date);
  const xs = (d) => padL + (Date.parse(d) - t0) / (t1 - t0 || 1) * (W - padL - padR);
  const vals = pts.map((p) => p.value);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1;
  const yMin = lo - pad, yMax = hi + pad;
  const ys = (v) => padT + (yMax - v) / (yMax - yMin || 1) * (H - padT - padB);

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  const put = (tag, attrs, text) => {
    const el = document.createElementNS(ns, tag);
    for (const [a, v] of Object.entries(attrs)) el.setAttribute(a, v);
    if (text != null) el.textContent = text;
    svg.appendChild(el);
    return el;
  };
  // gridlines (5 steps)
  for (let i = 0; i <= 4; i++) {
    const gv = yMin + (i / 4) * (yMax - yMin);
    put("line", { x1: padL, x2: W - padR, y1: ys(gv), y2: ys(gv), class: "cv-grid" });
    put("text", { x: padL - 8, y: ys(gv) + fs.axis * 0.34, class: "cv-ylabel", "text-anchor": "end", "font-size": fs.axis }, fmtAxis(gv));
  }
  // date labels
  const fmtD = (d) => new Date(Date.parse(d)).toLocaleDateString("en-US", months <= 24 ? { month: "short", year: "2-digit" } : { year: "numeric" });
  for (let i = 0; i < 4; i++) {
    const p = pts[Math.round(i * (pts.length - 1) / 3)];
    put("text", { x: xs(p.date), y: H - 10, class: "cv-xlabel", "text-anchor": i === 0 ? "start" : i === 3 ? "end" : "middle", "font-size": fs.axis }, fmtD(p.date));
  }
  const d = pts.map((p, i) => `${i ? "L" : "M"}${xs(p.date).toFixed(1)},${ys(p.value).toFixed(1)}`).join(" ");
  put("path", { d, class: "cv-line", "stroke-width": 2 * k });
  const last = pts[pts.length - 1];
  put("circle", { cx: xs(last.date), cy: ys(last.value), r: 4.5 * k, class: "cv-dot key", "stroke-width": 2 * k });
  put("text", { x: xs(last.date) + 8 * k, y: ys(last.value) + fs.value * 0.34, class: "cv-vlabel", "text-anchor": "start", "font-size": fs.value }, fmtV(last.value));

  attachScrub(svg, pts.map((p) => ({
    x: xs(p.date), y: ys(p.value),
    label: formatDate(p.date, { month: "short", year: "numeric" }),
    value: fmtV(p.value) + (unit === "%" ? "%" : ""),
  })), { W, H, padT, padB, padL, padR, k });
  return svg;
}

/* ---------- Market page: internal + external for one metro ----------
   The join key across the app is `market`. This page unifies what the briefing
   has tracked in a metro (comps, cap rates, deals) with the external backdrop
   (Zillow rents/values, Case-Shiller). Reached from Market Pulse, the map, and
   the comps board — so the same market always resolves to one place. */
async function renderMarketPage(name) {
  const wrap = $("market-content");
  wrap.innerHTML = "";
  wrap.appendChild(backLink("Market Pulse", "#/desk/pulse"));
  wrap.appendChild(pageHead(name,
    "Everything the briefing knows about this market — the external backdrop and every deal tracked here."));

  const pulse = await getPulse();
  const md = pulse?.metros?.[name];

  // open external chart, if any
  const series = md && state.marketMetric ? ({
    rent: md.rent && { label: `${name} — Median Rent`, unit: "$", ...md.rent },
    value: md.value && { label: `${name} — Home Value`, unit: "$", ...md.value },
    cs: md.caseShiller && { label: `${name} — Case-Shiller Index`, unit: "index", ...md.caseShiller },
  })[state.marketMetric] : null;
  if (series) wrap.appendChild(marketChartPanel(series));

  // external backdrop tiles
  if (md && (md.rent || md.value || md.caseShiller)) {
    wrap.appendChild(subHead("Market backdrop", "Zillow rents & values and Case-Shiller prices — free public data"));
    const ext = document.createElement("div");
    ext.className = "pulse-grid";
    if (md.rent) ext.appendChild(marketStatTile("rent", "Median Rent", fmtMoney(md.rent.latest?.value), md.rent.yoy, md.rent.history, false));
    if (md.value) ext.appendChild(marketStatTile("value", "Home Value", fmtMoney(md.value.latest?.value), md.value.yoy, md.value.history, false));
    if (md.caseShiller) ext.appendChild(marketStatTile("cs", "Case-Shiller", `${signed(md.caseShiller.yoy || 0)}%`, md.caseShiller.yoy, md.caseShiller.history, false, "YoY"));
    wrap.appendChild(ext);
  }

  // internal: this market's deals
  const days = await getAllDays();
  const stories = days.flatMap((d) => (d.stories || []).map((s) => ({ ...s, _date: d.date })))
    .filter((s) => s.market === name);
  const priced = stories.filter((s) => s.valueUsd);

  wrap.appendChild(subHead("What we've tracked here", `${stories.length} stor${stories.length === 1 ? "y" : "ies"} · ${priced.length} priced deal${priced.length === 1 ? "" : "s"}`));

  // internal medians (comps + cap rate)
  const psfs = priced.map(compPsf).filter((v) => v);
  const punits = priced.map(compPunit).filter((v) => v);
  const caps = stories.map((s) => capRateOf(s)).filter(Boolean).map((c) => c.v);
  const medianRow = document.createElement("div");
  medianRow.className = "market-medians";
  const mtile = (label, val, sub) => {
    const d = document.createElement("div"); d.className = "mm-tile";
    d.innerHTML = `<div class="mm-k">${label}</div><div class="mm-v">${val}</div><div class="mm-sub">${sub}</div>`;
    return d;
  };
  if (punits.length >= 3) medianRow.appendChild(mtile("Median $/unit", "$" + Math.round(median(punits)).toLocaleString(), `n=${punits.length}`));
  if (psfs.length >= 3) medianRow.appendChild(mtile("Median $/sf", "$" + Math.round(median(psfs)).toLocaleString(), `n=${psfs.length}`));
  if (caps.length >= 3) medianRow.appendChild(mtile("Median cap", median(caps).toFixed(1) + "%", `n=${caps.length}`));
  if (priced.length) {
    const total = priced.reduce((s, d) => s + (d.valueUsd || 0), 0);
    medianRow.appendChild(mtile("Tracked volume", fmtValue(total) || "—", `${priced.length} deals`));
  }
  if (medianRow.children.length) wrap.appendChild(medianRow);

  // recent deals
  if (priced.length) {
    const list = document.createElement("div"); list.className = "ledger-list";
    for (const s of [...priced].sort((a, b) => b._date.localeCompare(a._date) || (b.valueUsd - a.valueUsd)).slice(0, 40)) {
      list.appendChild(ledgerRow(s));
    }
    wrap.appendChild(list);
  } else {
    wrap.appendChild(emptyPanel("No priced deals tracked here yet", "As the briefing covers deals in this market, they collect here alongside the external backdrop."));
  }
}

function marketStatTile(metric, label, val, yoy, history, invert, suffix) {
  const el = document.createElement("button");
  el.className = "pulse-tile" + (state.marketMetric === metric ? " on" : "");
  el.addEventListener("click", () => { state.marketMetric = state.marketMetric === metric ? null : metric; route(); });
  const l = document.createElement("div"); l.className = "pt-label"; l.textContent = label;
  const v = document.createElement("div"); v.className = "pt-value"; v.textContent = val;
  el.append(l, v);
  if (yoy != null) {
    const good = yoy >= 0;
    const c = document.createElement("div"); c.className = "pt-chg " + (good ? "good" : "bad");
    c.textContent = (good ? "▲ " : "▼ ") + `${signed(yoy)}% ${suffix || "YoY"}`;
    el.appendChild(c);
  }
  if (history?.length > 1) el.appendChild(miniSpark(history, invert));
  return el;
}

function marketChartPanel(s) {
  const panel = document.createElement("div");
  panel.className = "pulse-chart-panel";
  const head = document.createElement("div"); head.className = "pcp-head";
  const title = document.createElement("div"); title.className = "pcp-title"; title.textContent = s.label;
  const close = document.createElement("button"); close.className = "pcp-close"; close.textContent = "✕";
  close.setAttribute("aria-label", "Close chart");
  close.addEventListener("click", () => { state.marketMetric = null; route(); });
  head.append(title, close);
  panel.appendChild(head);
  const ranges = [[24, "2Y"], [60, "5Y"], [120, "Max"]];
  const rbar = document.createElement("div"); rbar.className = "pcp-ranges";
  for (const [mo, label] of ranges) {
    const b = document.createElement("button");
    b.className = "pcp-range" + (state.marketRange === mo ? " on" : "");
    b.textContent = label;
    b.addEventListener("click", () => { state.marketRange = mo; route(); });
    rbar.appendChild(b);
  }
  panel.appendChild(rbar);
  const chart = document.createElement("div"); chart.className = "curve-wrap";
  chart.appendChild(buildPulseChart(s.history || [], { unit: s.unit, months: state.marketRange, yoy: s.yoy != null }));
  panel.appendChild(chart);
  return panel;
}

/* ---------- players ---------- */

async function getPlayers() {
  if (state.players) return state.players;
  const m = new Map();
  try {
    const rows = await sb("players?select=slug,data");
    for (const r of rows) {
      // slugs starting with "_" are pipeline bookkeeping (candidate ledger), not profiles
      if (!r.slug.startsWith("_") && r.data?.name) m.set(r.slug, { slug: r.slug, ...r.data });
    }
  } catch { /* leave empty */ }
  state.players = m;
  return m;
}

async function getTerms() {
  if (state.terms) return state.terms;
  const m = new Map();
  try {
    const rows = await sb("terms?select=slug,data");
    for (const r of rows) {
      if (r.data?.term) m.set(r.slug, { slug: r.slug, ...r.data });
    }
  } catch { /* leave empty */ }
  state.terms = m;
  return m;
}

function daysSince(iso) {
  if (!iso) return 9999;
  const [y, mo, d] = iso.split("-").map(Number);
  return Math.max(0, (Date.now() - new Date(y, mo - 1, d).getTime()) / 86400000);
}

/* Recency-weighted activity: a mention today counts 1, one from ~6 weeks ago ~0.5.
   Keeps the roster self-ranking as it grows — dormant names sink, they don't clutter. */
function playerScore(p) {
  return (p.mentions || []).reduce((sum, mn) => sum + 1 / (1 + daysSince(mn.date) / 45), 0);
}

const MENTION_ROLES = {
  subject: "In the story", buyer: "Buyer", seller: "Seller", developer: "Developer",
  lender: "Lender", borrower: "Borrower", landlord: "Landlord", tenant: "Tenant", broker: "Broker",
};

/* Avatar: profile image when the pipeline sourced one (company logo, Wikimedia
   headshot), otherwise a deterministic initials monogram — never a broken image. */
const AVATAR_COLORS = ["#5b7ea8", "#7a6ba8", "#5f8f6b", "#a87f5b", "#a85b6e", "#5b9aa8", "#8f8a5e", "#75808c"];

function playerAvatar(p, big) {
  const el = document.createElement("div");
  el.className = "player-avatar" + (big ? " big" : "") + (p.type === "person" ? " photo" : "");
  const monogram = () => {
    el.classList.add("mono");
    const initials = p.name.split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w))
      .slice(0, 2).map((w) => w[0].toUpperCase()).join("");
    let h = 0;
    for (const ch of p.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    el.style.background = AVATAR_COLORS[h % AVATAR_COLORS.length];
    el.textContent = initials;
  };
  if (p.image) {
    const img = document.createElement("img");
    img.src = p.image;
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => { img.remove(); monogram(); });
    el.appendChild(img);
  } else {
    monogram();
  }
  return el;
}

/* ---------- entity + term linking ----------
   Any roster name, and any dictionary term, appearing in prose (articles,
   summaries, ledes, dossiers) becomes a tap-through — to a player's profile
   or a term's dictionary entry. Matching is case-sensitive ("Compass" the
   brokerage, not "compass"), longest-name-first, first occurrence per block,
   and skips text already inside a link. Entities and terms share one pass
   over the text but render as differently-styled spans (.entity-link vs
   .term-link) so terms read as quieter, secondary links. */

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function entityIndex(players, terms) {
  if (state.entityIdx && state.entityIdx.forSize === players.size && state.entityIdx.forTermSize === terms.size) {
    return state.entityIdx;
  }
  const map = new Map();
  const add = (name, slug, kind) => {
    if (!name || name.length < 3 || map.has(name)) return;
    map.set(name, { slug, kind });
    if (name.includes("'")) map.set(name.replace(/'/g, "’"), { slug, kind }); // curly-quote variant
  };
  // full names first so they always beat another entity's alias or surname
  for (const p of players.values()) add(p.name, p.slug, "player");
  for (const p of players.values()) for (const a of p.aliases || []) add(a, p.slug, "player");
  for (const p of players.values()) {
    // bare-surname shorthand ("Whittall said…"), simple two-word names only
    const words = p.name.split(/\s+/);
    if (p.type === "person" && words.length === 2 && words[1].length >= 4) add(words[1], p.slug, "player");
  }
  for (const t of terms.values()) add(t.term, t.slug, "term");
  for (const t of terms.values()) for (const a of t.aliases || []) add(a, t.slug, "term");
  const alts = [...map.keys()].sort((a, b) => b.length - a.length).map(escapeRegex);
  state.entityIdx = {
    forSize: players.size,
    forTermSize: terms.size,
    map,
    regex: alts.length ? new RegExp(`(?<![A-Za-z0-9])(?:${alts.join("|")})(?![A-Za-z0-9])`, "g") : null,
  };
  return state.entityIdx;
}

function linkifyElement(root, excludeSlug) {
  if (!root) return;
  Promise.all([getPlayers(), getTerms()]).then(([players, terms]) => {
    if ((!players.size && !terms.size) || !root.isConnected) return;
    const { regex, map } = entityIndex(players, terms);
    if (!regex) return;
    const seen = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || n.nodeValue.length < 3) return NodeFilter.FILTER_REJECT;
        for (let el = n.parentElement; el && el !== root; el = el.parentElement) {
          if (el.tagName === "A" || el.classList.contains("entity-link") || el.classList.contains("term-link")) {
            return NodeFilter.FILTER_REJECT;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      regex.lastIndex = 0;
      let m, frag = null, last = 0;
      while ((m = regex.exec(text))) {
        const hit = map.get(m[0]);
        if (!hit || hit.slug === excludeSlug || seen.has(hit.slug)) continue;
        seen.add(hit.slug);
        if (!frag) frag = document.createDocumentFragment();
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const s = document.createElement("span");
        s.className = hit.kind === "term" ? "term-link" : "entity-link";
        s.dataset.slug = hit.slug;
        s.textContent = m[0];
        frag.appendChild(s);
        last = m.index + m[0].length;
      }
      if (frag) {
        frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
      }
    }
  });
}

async function renderPlayers() {
  const wrap = $("players-content");
  wrap.innerHTML = "";
  const players = await getPlayers();

  if (!players.size) {
    const p = document.createElement("p");
    p.style.cssText = "font-style:italic;color:var(--ink-2);padding:40px 0;text-align:center";
    p.textContent = "No players yet — the roster builds as briefings accumulate.";
    wrap.appendChild(p);
    return;
  }

  const all = [...players.values()];
  const nPeople = all.filter((p) => p.type === "person").length;

  const bar = document.createElement("div");
  bar.className = "players-bar";

  const toggle = document.createElement("div");
  toggle.className = "map-toggle";
  for (const [key, label, n] of [["people", "People", nPeople], ["companies", "Companies", all.length - nPeople]]) {
    const b = document.createElement("button");
    b.className = state.playerType === key ? "on" : "";
    b.textContent = `${label} · ${n}`;
    b.addEventListener("click", () => {
      state.playerType = key;
      for (const btn of toggle.children) btn.classList.toggle("on", btn === b);
      renderPlayerList(all);
    });
    toggle.appendChild(b);
  }

  const search = document.createElement("input");
  search.className = "player-search";
  search.type = "search";
  search.placeholder = "Search names, firms, markets…";
  search.value = state.playerQuery;
  search.addEventListener("input", () => { state.playerQuery = search.value; renderPlayerList(all); });

  const sort = document.createElement("select");
  sort.className = "ctl-select";
  for (const [val, label] of [["active", "Most active"], ["volume", "Deal volume"], ["az", "A–Z"]]) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    sort.appendChild(o);
  }
  sort.value = state.playerSort;
  sort.addEventListener("change", () => { state.playerSort = sort.value; renderPlayerList(all); });

  bar.append(toggle, search, sort);
  wrap.appendChild(bar);

  const list = document.createElement("div");
  list.id = "player-list";
  wrap.appendChild(list);

  const hint = document.createElement("p");
  hint.className = "players-hint";
  hint.textContent = "Compiled from the newsletters: the people and firms behind the deals. Profiles deepen as coverage accumulates.";
  wrap.appendChild(hint);

  renderPlayerList(all);
}

function renderPlayerList(all) {
  const listWrap = $("player-list");
  if (!listWrap) return;
  listWrap.innerHTML = "";

  const q = state.playerQuery.trim().toLowerCase();
  let list = all.filter((p) => (state.playerType === "people") === (p.type === "person"));
  if (q) {
    list = list.filter((p) =>
      [p.name, p.role, p.org, p.tagline, ...(p.markets || []), ...(p.assetClasses || [])]
        .filter(Boolean).join(" ").toLowerCase().includes(q)
    );
  }

  if (state.playerSort === "volume") {
    list.sort((a, b) => (b.stats?.dealVolumeUsd || 0) - (a.stats?.dealVolumeUsd || 0));
  } else if (state.playerSort === "az") {
    list.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    list.sort((a, b) => playerScore(b) - playerScore(a) || (b.stats?.dealVolumeUsd || 0) - (a.stats?.dealVolumeUsd || 0));
  }

  if (!list.length) {
    const p = document.createElement("p");
    p.style.cssText = "font-style:italic;color:var(--ink-2);padding:30px 0;text-align:center";
    p.textContent = "No matches.";
    listWrap.appendChild(p);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "player-grid";
  for (const p of list) grid.appendChild(playerCard(p));
  listWrap.appendChild(grid);
}

function playerCard(p) {
  const el = document.createElement("button");
  el.className = "player-card";
  el.addEventListener("click", () => { location.hash = `/player/${p.slug}`; });

  const head = document.createElement("div");
  head.className = "player-card-head";
  const id = document.createElement("div");
  id.className = "player-card-id";
  const h3 = document.createElement("h3");
  h3.textContent = p.name;
  id.appendChild(h3);

  const kicker = document.createElement("div");
  kicker.className = "player-kicker";
  const showOrg = p.type === "person" && p.org && !(p.role || "").toLowerCase().includes(p.org.toLowerCase());
  kicker.textContent = [p.role, showOrg ? p.org : null].filter(Boolean).join(" · ");
  id.appendChild(kicker);
  head.append(playerAvatar(p, false), id);
  el.appendChild(head);

  if (p.tagline) {
    const tag = document.createElement("p");
    tag.textContent = p.tagline;
    linkifyElement(tag, p.slug);
    el.appendChild(tag);
  }

  const chips = document.createElement("div");
  chips.className = "chips";
  const vol = fmtValue(p.stats?.dealVolumeUsd);
  if (vol) chips.appendChild(chip(vol + " tracked", "chip-value"));
  for (const mkt of (p.markets || []).slice(0, 2)) chips.appendChild(chip(mkt));
  for (const ac of (p.assetClasses || []).slice(0, 2)) chips.appendChild(chip(ac));
  if (chips.children.length) el.appendChild(chips);

  const meta = document.createElement("div");
  meta.className = "meta";
  const n = p.stats?.mentions || (p.mentions || []).length;
  const last = p.stats?.lastSeen || p.mentions?.[0]?.date;
  meta.textContent = `${n} mention${n === 1 ? "" : "s"}` + (last ? ` · last ${formatDate(last, { month: "short", day: "numeric" })}` : "");
  el.appendChild(meta);

  return el;
}

async function renderPlayerProfile(slug) {
  const wrap = $("players-content");
  wrap.innerHTML = "";
  const players = await getPlayers();
  const p = players.get(slug);
  if (!p) { location.hash = "/players"; return; }

  const back = document.createElement("button");
  back.className = "player-back";
  back.textContent = "‹ All players";
  back.addEventListener("click", () => { location.hash = "/players"; });
  wrap.appendChild(back);

  const head = document.createElement("div");
  head.className = "player-head";
  const id = document.createElement("div");
  const name = document.createElement("h1");
  name.className = "player-name";
  name.textContent = p.name;
  const roleLine = document.createElement("p");
  roleLine.className = "player-roleline";
  roleLine.textContent = p.role || (p.type === "person" ? "Person" : "Company");
  linkifyElement(roleLine, p.slug);
  id.append(name, roleLine);
  head.append(playerAvatar(p, true), id, watchStar(p.slug, p.name));
  wrap.appendChild(head);

  // person → firm cross-link when the firm has its own profile
  if (p.type === "person" && p.org) {
    const target = [...players.values()].find(
      (c) => c.type === "company" && c.name.toLowerCase() === p.org.toLowerCase()
    );
    if (target) {
      const link = document.createElement("button");
      link.className = "chip chip-filter player-org-link";
      link.textContent = p.org + " ›";
      link.addEventListener("click", () => { location.hash = `/player/${target.slug}`; });
      const row = document.createElement("div");
      row.className = "chips";
      row.appendChild(link);
      wrap.appendChild(row);
    }
  }

  const tiles = document.createElement("div");
  tiles.className = "rate-tiles player-tiles";
  const n = p.stats?.mentions || (p.mentions || []).length;
  const cells = [
    ["Mentions", String(n)],
    ["Tracked volume", fmtValue(p.stats?.dealVolumeUsd) || "—"],
    ["First seen", p.stats?.firstSeen ? formatDate(p.stats.firstSeen, { month: "short", day: "numeric" }) : "—"],
    ["Last seen", p.stats?.lastSeen ? formatDate(p.stats.lastSeen, { month: "short", day: "numeric" }) : "—"],
  ];
  for (const [label, value] of cells) {
    const tile = document.createElement("div");
    tile.className = "rate-tile";
    const l = document.createElement("div");
    l.className = "rt-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "rt-value";
    v.textContent = value;
    tile.append(l, v);
    tiles.appendChild(tile);
  }
  wrap.appendChild(tiles);

  if (p.profile) {
    const dossier = document.createElement("div");
    dossier.className = "player-dossier";
    for (const para of p.profile.split(/\n+/).filter(Boolean)) {
      const el = document.createElement("p");
      el.textContent = para;
      dossier.appendChild(el);
    }
    linkifyElement(dossier, p.slug);
    wrap.appendChild(dossier);
  }

  const chips = document.createElement("div");
  chips.className = "chips";
  for (const mkt of p.markets || []) chips.appendChild(chip(mkt));
  for (const ac of p.assetClasses || []) chips.appendChild(chip(ac));
  if (chips.children.length) wrap.appendChild(chips);

  const mentions = (p.mentions || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (mentions.length) {
    wrap.appendChild(sectionHead("In the news"));
    const list = document.createElement("div");
    list.className = "week-stories";
    for (const mn of mentions) {
      const btn = document.createElement("button");
      btn.className = "week-story";
      btn.addEventListener("click", () => { location.hash = `/story/${mn.date}/${mn.id}`; });
      const h4 = document.createElement("h4");
      h4.textContent = mn.title;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = [
        formatDate(mn.date, { month: "short", day: "numeric", year: "numeric" }),
        MENTION_ROLES[mn.role] || null,
        fmtValue(mn.valueUsd),
      ].filter(Boolean).join(" · ");
      btn.append(h4, meta);
      list.appendChild(btn);
    }
    wrap.appendChild(list);
  }
}

/* ---------- dictionary ---------- */

function termScore(t) {
  return (t.mentions || []).reduce((sum, mn) => sum + 1 / (1 + daysSince(mn.date) / 45), 0);
}

async function renderDictionary() {
  const wrap = $("dictionary-content");
  wrap.innerHTML = "";
  const terms = await getTerms();

  if (!terms.size) {
    const p = document.createElement("p");
    p.style.cssText = "font-style:italic;color:var(--ink-2);padding:40px 0;text-align:center";
    p.textContent = "No terms yet — the dictionary builds as jargon shows up in coverage.";
    wrap.appendChild(p);
    return;
  }

  const all = [...terms.values()];
  renderTermOfDay(wrap, all);
  const categories = [...new Set(all.map((t) => t.category).filter(Boolean))].sort();

  const bar = document.createElement("div");
  bar.className = "players-bar";

  const search = document.createElement("input");
  search.className = "player-search";
  search.type = "search";
  search.placeholder = "Search terms, definitions…";
  search.value = state.termQuery;
  search.addEventListener("input", () => { state.termQuery = search.value; renderTermList(all); });

  const cat = document.createElement("select");
  cat.className = "ctl-select";
  const anyOpt = document.createElement("option");
  anyOpt.value = "";
  anyOpt.textContent = "All categories";
  cat.appendChild(anyOpt);
  for (const c of categories) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    cat.appendChild(o);
  }
  cat.value = state.termCategory || "";
  cat.addEventListener("change", () => { state.termCategory = cat.value || null; renderTermList(all); });

  const sort = document.createElement("select");
  sort.className = "ctl-select";
  for (const [val, label] of [["az", "A–Z"], ["recent", "Most active"], ["mentions", "Most mentioned"]]) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    sort.appendChild(o);
  }
  sort.value = state.termSort;
  sort.addEventListener("change", () => { state.termSort = sort.value; renderTermList(all); });

  bar.append(search, cat, sort);
  wrap.appendChild(bar);

  const list = document.createElement("div");
  list.id = "term-list";
  wrap.appendChild(list);

  const hint = document.createElement("p");
  hint.className = "players-hint";
  hint.textContent = "Jargon and concepts from the newsletters, explained plainly. Builds as coverage accumulates.";
  wrap.appendChild(hint);

  renderTermList(all);
}

function renderTermList(all) {
  const listWrap = $("term-list");
  if (!listWrap) return;
  listWrap.innerHTML = "";

  const q = state.termQuery.trim().toLowerCase();
  let list = all;
  if (state.termCategory) list = list.filter((t) => t.category === state.termCategory);
  if (q) {
    list = list.filter((t) =>
      [t.term, t.category, t.shortDef, t.definition, ...(t.aliases || [])]
        .filter(Boolean).join(" ").toLowerCase().includes(q)
    );
  }

  if (state.termSort === "mentions") {
    list.sort((a, b) => (b.stats?.mentions || (b.mentions || []).length) - (a.stats?.mentions || (a.mentions || []).length));
  } else if (state.termSort === "recent") {
    list.sort((a, b) => termScore(b) - termScore(a));
  } else {
    list.sort((a, b) => a.term.localeCompare(b.term));
  }

  if (!list.length) {
    const p = document.createElement("p");
    p.style.cssText = "font-style:italic;color:var(--ink-2);padding:30px 0;text-align:center";
    p.textContent = "No matches.";
    listWrap.appendChild(p);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "player-grid";
  for (const t of list) grid.appendChild(termCard(t));
  listWrap.appendChild(grid);
}

function termCard(t) {
  const el = document.createElement("button");
  el.className = "player-card term-card";
  el.addEventListener("click", () => { location.hash = `/term/${t.slug}`; });

  const h3 = document.createElement("h3");
  h3.textContent = t.term;
  el.appendChild(h3);

  if (t.category) {
    const kicker = document.createElement("div");
    kicker.className = "player-kicker";
    kicker.textContent = t.category;
    el.appendChild(kicker);
  }

  if (t.shortDef) {
    const p = document.createElement("p");
    p.textContent = t.shortDef;
    el.appendChild(p);
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  const n = t.stats?.mentions || (t.mentions || []).length;
  const last = t.stats?.lastSeen || t.mentions?.[0]?.date;
  meta.textContent = `${n} mention${n === 1 ? "" : "s"}` + (last ? ` · last ${formatDate(last, { month: "short", day: "numeric" })}` : "");
  el.appendChild(meta);

  return el;
}

async function renderTermProfile(slug) {
  const wrap = $("dictionary-content");
  wrap.innerHTML = "";
  const terms = await getTerms();
  const t = terms.get(slug);
  if (!t) { location.hash = "/dictionary"; return; }

  const back = document.createElement("button");
  back.className = "player-back";
  back.textContent = "‹ All terms";
  back.addEventListener("click", () => { location.hash = "/dictionary"; });
  wrap.appendChild(back);

  const name = document.createElement("h1");
  name.className = "player-name";
  name.style.marginTop = "12px";
  name.textContent = t.term;
  wrap.appendChild(name);

  if (t.category) {
    const roleLine = document.createElement("p");
    roleLine.className = "player-roleline";
    roleLine.textContent = t.category;
    wrap.appendChild(roleLine);
  }

  const tiles = document.createElement("div");
  tiles.className = "rate-tiles player-tiles";
  const n = t.stats?.mentions || (t.mentions || []).length;
  const cells = [
    ["Mentions", String(n)],
    ["First seen", t.stats?.firstSeen ? formatDate(t.stats.firstSeen, { month: "short", day: "numeric" }) : "—"],
    ["Last seen", t.stats?.lastSeen ? formatDate(t.stats.lastSeen, { month: "short", day: "numeric" }) : "—"],
  ];
  for (const [label, value] of cells) {
    const tile = document.createElement("div");
    tile.className = "rate-tile";
    const l = document.createElement("div");
    l.className = "rt-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "rt-value";
    v.textContent = value;
    tile.append(l, v);
    tiles.appendChild(tile);
  }
  wrap.appendChild(tiles);

  if (t.definition) {
    const dossier = document.createElement("div");
    dossier.className = "player-dossier";
    for (const para of t.definition.split(/\n+/).filter(Boolean)) {
      const el = document.createElement("p");
      el.textContent = para;
      dossier.appendChild(el);
    }
    linkifyElement(dossier, t.slug);
    wrap.appendChild(dossier);
  }

  const mentions = (t.mentions || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (mentions.length) {
    wrap.appendChild(sectionHead("Seen in"));
    const list = document.createElement("div");
    list.className = "week-stories";
    for (const mn of mentions) {
      const btn = document.createElement("button");
      btn.className = "week-story";
      btn.addEventListener("click", () => { location.hash = `/story/${mn.date}/${mn.id}`; });
      const h4 = document.createElement("h4");
      h4.textContent = mn.title;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = formatDate(mn.date, { month: "short", day: "numeric", year: "numeric" });
      btn.append(h4, meta);
      list.appendChild(btn);
    }
    wrap.appendChild(list);
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

  // Fixed geometry in every mode: title hugs the left margin, badge is pinned
  // to the right margin, controls are always their own row beneath.
  const titleRow = document.createElement("div");
  titleRow.className = "chart-title-row";
  const title = sectionHead(
    state.rateChart === "forward" ? `SOFR Forward — Next ${state.fwdHorizon}`
    : state.rateChart === "history" ? `${histLabels[state.histKey] || ""} — Past ${state.histRange}`
    : "Treasury Yield Curve"
  );
  title.style.margin = "0";
  const badge = document.createElement("span");
  badge.className = "chart-badge " + (state.rateChart === "forward" ? "proj" : "actual");
  badge.textContent = state.rateChart === "forward" ? "PROJECTED" : "ACTUAL";
  titleRow.append(title, badge);
  head.appendChild(titleRow);

  const toggle = document.createElement("div");
  toggle.className = "map-toggle chart-controls";
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

/* ---------- chart scrubbing ----------
   Hold and drag (or hover, on desktop) anywhere on a rate chart: a vertical
   crosshair snaps to the nearest data point and a flag shows its exact
   label/date and rate. One engine serves all three chart types; each builder
   passes its own points [{x, y, label, value}] in viewBox coordinates. */

function attachScrub(svg, pts, geom) {
  if (!pts || pts.length < 2) return;
  const ns = "http://www.w3.org/2000/svg";
  const { W, H, padT, padB, padL, padR, k } = geom;
  const mk = (tag, attrs) => {
    const el = document.createElementNS(ns, tag);
    for (const [a, v] of Object.entries(attrs)) el.setAttribute(a, v);
    return el;
  };

  const layer = mk("g", { class: "scrub-layer" });
  layer.style.display = "none";
  const line = mk("line", { class: "scrub-line", y1: padT, y2: H - padB, "stroke-width": 1 * k });
  const dot = mk("circle", { class: "scrub-dot", r: 4.5 * k, "stroke-width": 2 * k });
  const flagBg = mk("rect", { class: "scrub-flag-bg", rx: 6 * k, height: 38 * k, y: padT + 2 });
  const flagLabel = mk("text", { class: "scrub-flag-label", "font-size": 10 * k, y: padT + 2 + 15 * k });
  const flagValue = mk("text", { class: "scrub-flag-value", "font-size": 13 * k, y: padT + 2 + 31 * k });
  layer.append(line, dot, flagBg, flagLabel, flagValue);
  svg.appendChild(layer);

  // the rates page fits one screen with no scrolling, so owning all touch
  // gestures over the chart is safe — it's what makes the scrub feel smooth
  svg.style.touchAction = "none";
  svg.style.cursor = "crosshair";

  const show = (clientX) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const vx = (clientX - rect.left) * (W / rect.width);
    let best = pts[0], bd = Infinity;
    for (const p of pts) {
      const d = Math.abs(p.x - vx);
      if (d < bd) { bd = d; best = p; }
    }
    layer.style.display = "";
    line.setAttribute("x1", best.x);
    line.setAttribute("x2", best.x);
    dot.setAttribute("cx", best.x);
    dot.setAttribute("cy", best.y);
    flagLabel.textContent = best.label;
    flagValue.textContent = best.value;
    const w = Math.max(flagLabel.getBBox().width, flagValue.getBBox().width) + 18 * k;
    flagBg.setAttribute("width", w);
    // flag rides beside the line, flipping sides so it never leaves the chart
    let fx = best.x + 11 * k;
    if (fx + w > W - 4) fx = best.x - 11 * k - w;
    flagBg.setAttribute("x", fx);
    flagLabel.setAttribute("x", fx + 9 * k);
    flagValue.setAttribute("x", fx + 9 * k);
  };
  const hide = () => { layer.style.display = "none"; };

  svg.addEventListener("pointerdown", (e) => {
    try { svg.setPointerCapture(e.pointerId); } catch { /* older Safari */ }
    show(e.clientX);
    e.preventDefault();
  });
  // no rAF throttle: rAF stalls in throttled/low-power contexts, and show()
  // is cheap (nearest-point scan + one getBBox), so per-event updates are safe
  svg.addEventListener("pointermove", (e) => show(e.clientX));
  svg.addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") hide(); });
  svg.addEventListener("pointercancel", hide);
  svg.addEventListener("pointerleave", hide);
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
  const W = 680, H = mobile ? 545 : 320; // uniform phone height across all chart modes
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

  attachScrub(
    svg,
    pts.map((p) => ({ x: xs(p.months), y: ys(p.rate), label: `${p.label} Treasury`, value: p.rate.toFixed(2) + "%" })),
    { W, H, padT, padB, padL, padR, k }
  );

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
  const W = 680, H = mobile ? 545 : 320; // uniform phone height across all chart modes
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

  attachScrub(
    svg,
    pts.map((p) => ({ x: xs(p.m), y: ys(p.rate), label: p.m === 0 ? "Today (spot)" : `${fwdLabel(p.m)} · projected`, value: p.rate.toFixed(2) + "%" })),
    { W, H, padT, padB, padL, padR, k }
  );

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
  const W = 680, H = mobile ? 545 : 320; // uniform phone height across all chart modes
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

  // scrub snaps to every daily print, not just the sparse hover targets
  attachScrub(
    svg,
    pts.map((p) => ({
      x: xs(p.date),
      y: ys(p.rate),
      label: formatDate(p.date, { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
      value: p.rate.toFixed(2) + "%",
    })),
    { W, H, padT, padB, padL, padR, k }
  );

  return svg;
}

/* ---------- reader ---------- */

/* ---------- reader navigation (swipe / keys through the day) ----------
   Order mirrors the feed: featured first, then groups exactly as rendered.
   Only stories with real article text participate — the others are cards
   that open their source, not reader pages. */

function feedOrder(day) {
  const full = (day.stories || []).filter((s) => !s.brief);
  const featured = full.filter((s) => s.featured);
  const rest = full.filter((s) => !s.featured);
  const key = state.groupBy;
  const groups = new Map();
  for (const s of rest) {
    const k = s[key] || (key === "section" ? "More" : "Other");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const out = [...featured];
  for (const [, list] of ordered) {
    if (key !== "section") list.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
    out.push(...list);
  }
  // readable briefs ride at the end, mirroring the "Also today" strip
  out.push(...(day.stories || []).filter((s) => s.brief));
  return out.filter(isExpandable);
}

function buildReaderNav(day, story) {
  const list = feedOrder(day);
  return { date: day.date, list, idx: list.findIndex((s) => s.id === story.id) };
}

/* Moving story-to-story REPLACES the history entry instead of pushing one:
   however far you've swiped, one Back (button or iOS edge swipe) returns to
   the feed — never a rewind through every story you passed. */
function readerGo(date, id) {
  location.replace(`#/story/${date}/${id}`);
}

function readerStep(delta) {
  const nav = state.readerNav;
  if (!nav || nav.idx < 0) return;
  const next = nav.list[nav.idx + delta];
  if (!next) {
    flashToast(delta > 0 ? "That's the whole briefing ✓" : "Start of the briefing");
    return;
  }
  readerStepFlash = true; // let openReaderRoute show the section interstitial if it changes
  readerGo(nav.date, next.id);
  flashToast(`${next.section ? next.section + " · " : ""}${nav.idx + 1 + delta} of ${nav.list.length}`);
}

function renderReaderProgress() {
  const bar = $("reader-progress");
  bar.innerHTML = "";
  const nav = state.readerNav;
  if (!nav || nav.idx < 0 || nav.list.length < 2) { bar.hidden = true; return; }
  bar.hidden = false;
  nav.list.forEach((s, i) => {
    const seg = document.createElement("span");
    seg.className = "rp-seg" + (i < nav.idx ? " done" : i === nav.idx ? " cur" : "");
    seg.title = s.title;
    seg.addEventListener("click", () => readerGo(nav.date, s.id));
    bar.appendChild(seg);
  });
}

function renderReaderNext() {
  const box = $("reader-next");
  box.innerHTML = "";
  const nav = state.readerNav;
  if (!nav || nav.idx < 0) { box.hidden = true; return; }
  const next = nav.list[nav.idx + 1];
  box.hidden = false;

  if (next) {
    const btn = document.createElement("button");
    btn.className = "reader-next-card";
    const k = document.createElement("span");
    k.className = "rn-kicker";
    k.textContent = "Next" + (next.section ? " · " + next.section : "");
    const t = document.createElement("span");
    t.className = "rn-title";
    t.textContent = next.title;
    btn.append(k, t);
    btn.addEventListener("click", () => readerGo(nav.date, next.id));
    box.appendChild(btn);
  } else {
    // end of the feed — the ritual gets a finish line
    const mins = nav.list.reduce((sum, s) => sum + (readMinutes(s) || 0), 0);
    const card = document.createElement("div");
    card.className = "reader-done";
    const h = document.createElement("div");
    h.className = "rd-head";
    h.textContent = "You're caught up ✓";
    const m = document.createElement("div");
    m.className = "rd-meta";
    m.textContent = `${nav.list.length} ${nav.list.length === 1 ? "story" : "stories"}${mins ? ` · ${mins} min` : ""}`;
    const back = document.createElement("button");
    back.className = "rd-back";
    back.textContent = "Back to the briefing";
    back.addEventListener("click", () => closeReaderNav());
    card.append(h, m, back);
    box.appendChild(card);
  }
}

function applyTextScale() {
  const sc = pref("textScale", "m");
  const r = $("reader");
  r.classList.toggle("size-s", sc === "s");
  r.classList.toggle("size-l", sc === "l");
}

/* ---------- reader polish: scroll memory, time-left, section flash, TTS ---------- */
const readerScrollPos = {};             // date/id -> scrollTop (session memory)
let readerPrevSection = null;           // section of the story we came from
let readerStepFlash = false;            // set by readerStep so a fresh open doesn't flash
let readerSlideIn = false;              // set by a peek fling: slide the reader up over the sheet
let flashTimer = null;

// remember scroll position and update "~N min left" as you read
function onReaderScroll() {
  const r = $("reader");
  if (r.hidden || !state.reader) return;
  const { date, story } = state.reader;
  readerScrollPos[readMark(date, story.id)] = r.scrollTop;
  updateTimeLeft();
  // mark read once you've actually gotten ~5/6 of the way down
  const max = r.scrollHeight - r.clientHeight;
  if (max > 40 && r.scrollTop / max > 0.83 && !isRead(date, story.id)) setRead(date, story.id, true);
}

function updateTimeLeft() {
  const el = $("reader-timeleft");
  if (!el || !state.reader) return;
  const total = readMinutes(state.reader.story) || 0;
  const r = $("reader");
  const max = r.scrollHeight - r.clientHeight;
  const frac = max > 40 ? Math.min(1, r.scrollTop / max) : 1;
  const left = Math.max(0, Math.round(total * (1 - frac)));
  if (!total || frac > 0.92) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = left <= 0 ? "almost done" : `~${left} min left`;
}

// Web Speech playback of the open story
let ttsOn = false;
function paintListenBtn(on) {
  ttsOn = on;
  const b = $("reader-listen");
  if (b) { b.textContent = on ? "⏸" : "🔊"; b.classList.toggle("on", on); }
}
function stopTTS() {
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch { /* unsupported */ }
  ttsOn = false;
}
function toggleTTS() {
  if (!("speechSynthesis" in window)) { flashToast("Listening isn't supported on this browser"); return; }
  if (ttsOn) { stopTTS(); paintListenBtn(false); return; }
  const s = state.reader?.story;
  if (!s) return;
  const bodyText = ($("reader-body").textContent || "").replace(/\s+/g, " ").trim();
  const text = `${s.title}. ${s.summary || ""} ${bodyText}`.slice(0, 32000);
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0;
  u.onend = () => paintListenBtn(false);
  u.onerror = () => paintListenBtn(false);
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
  paintListenBtn(true);
}

async function openReaderRoute(date, id) {
  const day = await getDay(date);
  const story = (day?.stories || []).find((s) => s.id === id);
  if (!story) { location.hash = "/"; return; }

  $("reader-kicker").textContent = [story.section, cadenceLabel(story)].filter(Boolean).join(" · ");
  $("reader-title").textContent = story.title;

  const mins = readMinutes(story);
  $("reader-meta").textContent = [
    storyPublishers(story, false).join(" · "), // real publisher, full name, in the reader
    formatDate(date, { weekday: "long", month: "long", day: "numeric" }),
    mins ? `${mins} min read` : null,
  ].filter(Boolean).join("  ·  ");

  const hero = $("reader-hero");
  const heroImg = $("reader-hero-img");
  if (story.image && !isJunkImageUrl(story.image)) {
    heroImg.src = story.image;
    heroImg.alt = story.title;
    hero.hidden = false;
  } else {
    hero.hidden = true;
    heroImg.removeAttribute("src");
  }

  const body = $("reader-body");
  if (story.content) {
    body.innerHTML = sanitizeArticleHtml(story.content);
    const firstImg = body.querySelector("img");
    if (firstImg && story.image && firstImg.src === story.image) firstImg.remove();
  } else {
    body.innerHTML = "";
    const p = document.createElement("p");
    p.className = "reader-fallback";
    p.textContent = (story.summary || "") + " Full text wasn't available for this story — use the link below to read it at the source.";
    body.appendChild(p);
  }
  linkifyElement(body);

  // optional plain-English rewrite for dense stories — supplements the
  // article above, never replaces it
  const expl = $("reader-explainer");
  expl.hidden = !story.explainer;
  expl.innerHTML = "";
  if (story.explainer) {
    const label = document.createElement("div");
    label.className = "explainer-label";
    label.textContent = "In plain English";
    expl.appendChild(label);
    for (const para of story.explainer.split(/\n+/).filter(Boolean)) {
      const p = document.createElement("p");
      p.textContent = para;
      expl.appendChild(p);
    }
    linkifyElement(expl);
  }

  $("reader-original").href = story.url || "#";
  $("reader-original-end").href = story.url || "#";

  // other outlets' takes on the same story — depth on demand, never repetition
  readerCoverageBlock(story, date, null);

  // save (bookmark) toggle for this story
  state.reader = { story, date };
  const saveBtn = $("reader-save");
  const paintSave = () => {
    const on = isSaved(date, story.id);
    saveBtn.textContent = on ? "★" : "☆";
    saveBtn.classList.toggle("on", on);
    saveBtn.setAttribute("aria-label", on ? "Saved — tap to remove" : "Save story");
  };
  paintSave();
  saveBtn.onclick = () => { const now = toggleSaved(story, date); paintSave(); flashToast(now ? "Saved" : "Removed"); };

  // arc banner: if this story belongs to a registered thread, offer its timeline
  const threadEl = $("reader-thread");
  threadEl.hidden = true;
  if (story.thread) {
    getThreads().then((threads) => {
      const t = threads.find((x) => x.slug === story.thread);
      if (!t || !state.reader || state.reader.story.id !== story.id) return; // reader moved on
      const n = (t.entries || []).length;
      threadEl.textContent = `🧵 Part of an arc — ${t.title} · ${n} ${n === 1 ? "story" : "stories"} →`;
      threadEl.href = `#/thread/${t.slug}`;
      threadEl.hidden = false;
    });
  }

  // swipe/keyboard navigation context + progress + the next-up card
  state.readerNav = buildReaderNav(day, story);
  renderReaderProgress();
  renderReaderNext();
  applyTextScale();

  // section interstitial when a swipe crosses into a new section
  const flash = $("reader-flash");
  flash.hidden = true;
  if (readerStepFlash && readerPrevSection && story.section && readerPrevSection !== story.section) {
    flash.textContent = "— " + story.section + " —";
    flash.hidden = false;
    flash.classList.remove("show"); void flash.offsetWidth; flash.classList.add("show");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash.hidden = true; }, 700);
  }
  readerPrevSection = story.section || null;
  readerStepFlash = false;

  stopTTS(); // any prior playback ends when the story changes
  paintListenBtn(false);

  const reader = $("reader");
  reader.hidden = false;
  document.body.classList.add("reader-open");
  // scroll-position memory: return to where you left this story, else the top
  reader.scrollTop = readerScrollPos[readMark(date, story.id)] || 0;

  if (readerSlideIn) {
    // continuous "peek grows into the story": lift the reader above the sheet
    // (z 700) and slide it up from the bottom over the frozen peek, then drop
    // the now-covered sheet. No fade, no gap.
    readerSlideIn = false;
    reader.style.zIndex = "760";
    reader.style.opacity = "1";
    reader.style.transition = "none";
    reader.style.transform = "translateY(100%)";
    requestAnimationFrame(() => {
      reader.style.transition = "transform .34s cubic-bezier(.2,.85,.25,1)";
      reader.style.transform = "translateY(0)";
    });
    setTimeout(() => {
      const s = $("sheet"); s.classList.remove("open"); s.hidden = true;
      document.body.classList.remove("sheet-open");
      reader.style.transition = ""; reader.style.transform = ""; reader.style.zIndex = "";
    }, 360);
  } else {
    reader.style.transition = ""; reader.style.transform = ""; reader.style.opacity = ""; // clear pull-to-close residue
  }

  updateTimeLeft();
  // a short article that doesn't scroll is fully seen on open → mark it read
  requestAnimationFrame(() => {
    if (state.reader && state.reader.story.id === story.id &&
        reader.scrollHeight - reader.clientHeight <= 40) setRead(date, story.id, true);
  });
}

/* ---------- multi-outlet coverage in the reader ----------
   A merged story holds ONE primary article (story.content/url/publisher) plus a
   `coverage` array of other outlets' versions. The reader shows the primary and
   lists the rest as "Also covered by" rows: rows with captured text swap the
   reader body to that version in place; the rest link out. When a coverage
   version is active, the primary appears as a row so you can switch back. */

function coverageVersions(story) {
  return (story.coverage || []).filter((c) => c && (c.url || c.content));
}

function readerCoverageBlock(story, date, activeIdx) {
  const box = $("reader-coverage");
  box.innerHTML = "";
  const vers = coverageVersions(story);
  if (!vers.length) { box.hidden = true; return; }
  box.hidden = false;

  const label = document.createElement("div");
  label.className = "coverage-label";
  label.textContent = "Also covered by";
  box.appendChild(label);

  const entries = [];
  if (activeIdx !== null) {
    entries.push({ idx: null, publisher: storyPublishers(story, false)[0] || "Primary",
                   title: story.title, content: story.content, url: story.url, note: "The primary version" });
  }
  vers.forEach((c, i) => { if (i !== activeIdx) entries.push({ idx: i, ...c }); });

  for (const e of entries) {
    const readable = contentWords({ content: e.content }) >= 80;
    const row = document.createElement(readable ? "button" : "div");
    row.className = "coverage-row";
    const main = document.createElement("div");
    main.className = "cov-main";
    const t = document.createElement("p");
    t.className = "cov-title";
    const pub = document.createElement("span");
    pub.className = "cov-pub";
    pub.textContent = e.publisher || "Source";
    t.appendChild(pub);
    if (e.title && e.title !== story.title) {
      t.appendChild(document.createTextNode(" — " + e.title));
    }
    main.appendChild(t);
    if (e.note) {
      const n = document.createElement("p");
      n.className = "cov-note";
      n.textContent = e.note;
      main.appendChild(n);
    }
    row.appendChild(main);
    if (readable) {
      const open = document.createElement("span");
      open.className = "cov-open";
      open.textContent = "Read ›";
      row.appendChild(open);
      row.addEventListener("click", () => showReaderVersion(story, date, e.idx));
    } else if (e.url) {
      const a = document.createElement("a");
      a.className = "cov-src";
      a.href = e.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Source ↗";
      row.appendChild(a);
    }
    box.appendChild(row);
  }
}

function showReaderVersion(story, date, idx) {
  const c = idx === null ? null : coverageVersions(story)[idx];
  const content = c ? c.content : story.content;

  $("reader-title").textContent = (c && c.title) || story.title;
  const mins = readMinutes({ content });
  $("reader-meta").textContent = [
    c ? `${c.publisher || "Coverage"} version` : storyPublishers(story, false).join(" · "),
    formatDate(date, { weekday: "long", month: "long", day: "numeric" }),
    mins ? `${mins} min read` : null,
  ].filter(Boolean).join("  ·  ");

  // hero + explainer belong to the primary version only
  const hero = $("reader-hero");
  if (!c && story.image && !isJunkImageUrl(story.image)) { $("reader-hero-img").src = story.image; hero.hidden = false; }
  else hero.hidden = true;
  $("reader-explainer").hidden = !!c || !story.explainer;

  const body = $("reader-body");
  body.innerHTML = sanitizeArticleHtml(content);
  linkifyElement(body);

  const url = (c && c.url) || story.url || "#";
  $("reader-original").href = url;
  $("reader-original-end").href = url;

  readerCoverageBlock(story, date, idx);
  $("reader").scrollTop = 0;
}

function hideReader() {
  $("reader").hidden = true;
  document.body.classList.remove("reader-open");
  stopTTS();
  paintListenBtn(false);
}

/* ---------- mini-dossier sheets ----------
   Tapping any linked name or term opens a bottom sheet — a glance, not a
   navigation. The full page is one tap away (header or the footer button). */

function openSheet(build) {
  const sheet = $("sheet");
  const card = $("sheet-card");
  card.innerHTML = "";
  card.style.transition = "";   // clear any leftover drag inline styles so the
  card.style.transform = "";    // CSS .open rise/fall animates cleanly
  build(card);
  sheet.hidden = false;
  document.body.classList.add("sheet-open"); // suppresses page-wide text selection
  requestAnimationFrame(() => sheet.classList.add("open"));
}

function closeSheet() {
  const sheet = $("sheet");
  const card = $("sheet-card");
  card.style.transition = ""; card.style.transform = ""; // let CSS animate the fall
  peekTarget = null; sheetDragY = null;
  sheet.classList.remove("open");
  document.body.classList.remove("sheet-open");
  setTimeout(() => { sheet.hidden = true; }, 260);
}

function sheetGo(hash) {
  closeSheet();
  location.hash = hash;
}

/* ---------- draggable bottom sheet (peek + dossiers) ----------
   Tracks the finger 1:1 (bob up/down), rubber-bands when pulled above open,
   and on release either springs back, flings away, or — for a story peek —
   flings up to open the story. */
let sheetDragY = null;   // start Y of an active drag, or null when idle
let sheetDy = 0;
let peekTarget = null;   // {date,id} a story peek can fling up to open

function sheetDragStart(y) { sheetDragY = y; sheetDy = 0; }
function sheetDragMove(y) {
  if (sheetDragY === null) return;
  sheetDy = y - sheetDragY;
  const px = sheetDy > 0 ? sheetDy : sheetDy * 0.32; // resistance when pulling up
  const c = $("sheet-card");
  c.style.transition = "none";
  c.style.transform = `translateY(${px}px)`;
}
function sheetDragEnd() {
  if (sheetDragY === null) return;
  const dy = sheetDy;
  sheetDragY = null; sheetDy = 0;
  if (dy > 90) sheetDismiss();
  else if (dy < -55 && peekTarget) sheetOpenStory();
  else sheetSettle();
}
function sheetSettle() {
  const c = $("sheet-card");
  c.style.transition = "transform .26s cubic-bezier(.2,.9,.25,1)";
  c.style.transform = "translateY(0)";
}
function sheetDismiss() {
  const c = $("sheet-card");
  c.style.transition = "transform .24s cubic-bezier(.35,0,.7,1)";
  c.style.transform = "translateY(110%)";
  peekTarget = null; sheetDragY = null;
  document.body.classList.remove("sheet-open");
  setTimeout(() => { const s = $("sheet"); s.classList.remove("open"); s.hidden = true; }, 220);
}
function sheetOpenStory() {
  const t = peekTarget; peekTarget = null; sheetDragY = null;
  document.body.classList.remove("sheet-open");
  if (!t) { closeSheet(); return; }
  // Don't fade the sheet out. Leave it frozen where the fling left it and let
  // openReaderRoute slide the full story UP over it — one continuous upward
  // motion, the peek "growing" into the article rather than vanishing.
  readerSlideIn = true;
  location.hash = `/story/${t.date}/${t.id}`;
}

// long-press peek: summary + hero in a sheet; the long-press finger keeps
// dragging it (fromY), so you can bob it and fling up (open) or down (dismiss)
function openStoryPeek(date, id, fromY) {
  const story = (state.days.get(date)?.stories || []).find((s) => s.id === id);
  if (!story) return;
  peekTarget = isExpandable(story) ? { date, id } : null;
  openSheet((card) => {
    if (story.image && !isJunkImageUrl(story.image)) {
      const fig = document.createElement("div");
      fig.className = "peek-hero";
      const img = document.createElement("img");
      img.alt = ""; img.draggable = false;
      img.onload = () => img.classList.add("loaded");   // fade in, no pop
      img.src = story.image;
      if (img.complete) img.classList.add("loaded");    // cached: show at once
      fig.appendChild(img);
      card.appendChild(fig);
    }
    const k = document.createElement("div");
    k.className = "peek-kicker";
    k.textContent = [story.section, story.market].filter(Boolean).join(" · ");
    const h = document.createElement("h3");
    h.className = "peek-title";
    h.textContent = story.title;
    const p = document.createElement("p");
    p.className = "peek-summary";
    p.textContent = story.summary || "";
    card.append(k, h, p);
    const chips = storyChips(story);
    if (chips) { chips.classList.add("peek-chips"); card.appendChild(chips); }
    if (isExpandable(story)) {
      const open = document.createElement("button");
      open.className = "peek-open";
      open.textContent = "Open story →";
      open.addEventListener("click", () => sheetOpenStory());
      card.appendChild(open);
    }
  });
  // NB: we do NOT start the drag here — the feed handler lazy-starts it on the
  // first finger move (capturing the finger's position then), so the card never
  // snaps from mid-rise to the finger. `fromY` is unused now, kept for clarity.
}

async function openPlayerSheet(slug) {
  const players = await getPlayers();
  const p = players.get(slug);
  if (!p) { location.hash = `/player/${slug}`; return; }
  openSheet((card) => {
    const head = document.createElement("button");
    head.className = "sheet-head";
    head.addEventListener("click", () => sheetGo(`/player/${slug}`));
    head.appendChild(playerAvatar(p, false));
    const ht = document.createElement("span");
    ht.className = "sheet-head-text";
    const nm = document.createElement("span");
    nm.className = "sheet-name";
    nm.textContent = p.name;
    const rl = document.createElement("span");
    rl.className = "sheet-role";
    rl.textContent = p.role || (p.type === "company" ? "Company" : "");
    ht.append(nm, rl);
    head.appendChild(ht);
    head.appendChild(watchStar(slug, p.name));
    const arrow = document.createElement("span");
    arrow.className = "sheet-arrow";
    arrow.textContent = "›";
    head.appendChild(arrow);
    card.appendChild(head);

    if (p.tagline) {
      const tg = document.createElement("p");
      tg.className = "sheet-tagline";
      tg.textContent = p.tagline;
      card.appendChild(tg);
    }

    const st = p.stats || {};
    const stats = document.createElement("div");
    stats.className = "sheet-stats";
    const stat = (v, l) => {
      const d = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = v;
      const s = document.createElement("span");
      s.textContent = l;
      d.append(b, s);
      return d;
    };
    stats.appendChild(stat(st.mentions ?? (p.mentions || []).length, "mentions"));
    if (st.dealVolumeUsd) stats.appendChild(stat(fmtValue(st.dealVolumeUsd), "tracked volume"));
    if (st.lastSeen) stats.appendChild(stat(formatDate(st.lastSeen, { month: "short", day: "numeric" }), "last seen"));
    card.appendChild(stats);

    const ms = (p.mentions || []).slice(0, 3);
    if (ms.length) {
      const lbl = document.createElement("div");
      lbl.className = "sheet-label";
      lbl.textContent = "Recent coverage";
      card.appendChild(lbl);
      for (const m of ms) {
        const row = document.createElement("button");
        row.className = "sheet-mention";
        const d = document.createElement("span");
        d.className = "sm-date";
        d.textContent = formatDate(m.date, { month: "short", day: "numeric" });
        const t = document.createElement("span");
        t.className = "sm-title";
        t.textContent = m.title;
        row.append(d, t);
        row.addEventListener("click", () => sheetGo(`/story/${m.date}/${m.id}`));
        card.appendChild(row);
      }
    }

    const full = document.createElement("button");
    full.className = "sheet-full";
    full.textContent = "Full profile →";
    full.addEventListener("click", () => sheetGo(`/player/${slug}`));
    card.appendChild(full);
  });
}

async function openTermSheet(slug) {
  const terms = await getTerms();
  const t = terms.get(slug);
  if (!t) { location.hash = `/term/${slug}`; return; }
  openSheet((card) => {
    const head = document.createElement("button");
    head.className = "sheet-head";
    head.addEventListener("click", () => sheetGo(`/term/${slug}`));
    const ht = document.createElement("span");
    ht.className = "sheet-head-text";
    const nm = document.createElement("span");
    nm.className = "sheet-name";
    nm.textContent = t.term;
    const rl = document.createElement("span");
    rl.className = "sheet-role";
    rl.textContent = t.category || "Dictionary";
    ht.append(nm, rl);
    head.appendChild(ht);
    const arrow = document.createElement("span");
    arrow.className = "sheet-arrow";
    arrow.textContent = "›";
    head.appendChild(arrow);
    card.appendChild(head);

    const def = document.createElement("p");
    def.className = "sheet-tagline";
    def.textContent = t.shortDef || (t.definition || "").split("\n")[0];
    card.appendChild(def);

    const full = document.createElement("button");
    full.className = "sheet-full";
    full.textContent = "Full entry →";
    full.addEventListener("click", () => sheetGo(`/term/${slug}`));
    card.appendChild(full);
  });
}

function closeReaderNav() {
  if (history.length > 1) history.back();
  else location.hash = "/";
}

/* ---------- reader profiles ----------
   Everything personal — saved stories today; read state, watchlists, and
   settings as they arrive — lives under a named profile (one `prefs` row per
   reader in Supabase), so one person's actions never touch another's. The
   device remembers its reader across visits; Guest persists nothing at all. */

const PROFILE_KEY = "briefing_profile_v1";     // this device's reader (slug)
const GUEST_KEY = "briefing_guest_v1";         // sessionStorage: guest for this visit only
const LOCKED_KEY = "briefing_locked_v1";       // set by the masthead monogram; forces the picker
const LEGACY_SAVED_KEY = "briefing_saved_v1";  // pre-profiles bookmarks, migrated on first pick

const FOUNDERS = [
  { slug: "matthew", name: "Matthew", color: "#8a3b46" },
  { slug: "daniel",  name: "Daniel",  color: "#215a8f" },
  { slug: "rafe",    name: "Rafe",    color: "#2e7d5b" },
  { slug: "alain",   name: "Alain",   color: "#b26a00" },
];
const PROFILE_COLORS = ["#8a3b46", "#215a8f", "#2e7d5b", "#b26a00", "#6d4fa3", "#00778b", "#5d4037", "#a34f6c"];

const profile = { slug: null, name: null, color: null, guest: false, data: {}, dirty: new Set() };

function profileCacheKey(slug) { return "briefing_prefs_" + slug; }

function rememberedProfile() {
  try { if (sessionStorage.getItem(GUEST_KEY) === "1") return "guest"; } catch { /* ignore */ }
  try { return localStorage.getItem(PROFILE_KEY); } catch { return null; }
}

async function fetchProfileRows() {
  try { return await sb("prefs?select=profile,data"); } catch { return []; }
}

/* The picker's roster: named rows from Supabase layered over the founding four. */
function profileRoster(rows) {
  const bySlug = new Map(FOUNDERS.map((f) => [f.slug, { ...f, pinHash: null }]));
  for (const r of rows) {
    const meta = r.data || {};
    bySlug.set(r.profile, {
      slug: r.profile,
      name: meta.name || r.profile,
      color: meta.color || PROFILE_COLORS[bySlug.size % PROFILE_COLORS.length],
      pinHash: meta.pinHash || null,
    });
  }
  return [...bySlug.values()];
}

async function activateProfile(slug, meta) {
  if (slug === "guest") {
    Object.assign(profile, { slug: "guest", name: "Guest", color: null, guest: true, data: {}, dirty: new Set() });
    try { sessionStorage.setItem(GUEST_KEY, "1"); } catch { /* ignore */ }
    paintAvatar();
    return;
  }
  meta = meta || FOUNDERS.find((f) => f.slug === slug) || null;
  let data = null;
  try {
    const rows = await sb(`prefs?profile=eq.${encodeURIComponent(slug)}&select=data`);
    data = rows[0]?.data ?? null;
  } catch { /* offline — fall back to this device's cached copy */ }
  if (data === null) {
    try { data = JSON.parse(localStorage.getItem(profileCacheKey(slug)) || "null"); } catch { data = null; }
  }
  data = data || { name: meta?.name || slug, color: meta?.color, createdAt: new Date().toISOString().slice(0, 10) };
  if (!data.name) data.name = meta?.name || slug;
  if (!data.color) data.color = meta?.color || PROFILE_COLORS[0];

  Object.assign(profile, { slug, name: data.name, color: data.color, guest: false, data, dirty: new Set() });

  // a passcode chosen at create time rides in on meta and syncs with the row
  if (meta?.pinHash && !data.pinHash) {
    data.pinHash = meta.pinHash;
    profile.dirty.add("pinHash");
  }

  // one-time migration: bookmarks saved before profiles existed join this reader
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_SAVED_KEY) || "[]");
    if (legacy.length) {
      const have = new Set((data.saved || []).map((s) => s.key));
      data.saved = [...(data.saved || []), ...legacy.filter((s) => !have.has(s.key))];
      profile.dirty.add("saved");
    }
    localStorage.removeItem(LEGACY_SAVED_KEY);
  } catch { /* ignore */ }

  try {
    localStorage.setItem(PROFILE_KEY, slug);
    localStorage.setItem(profileCacheKey(slug), JSON.stringify(data));
    sessionStorage.removeItem(GUEST_KEY);
  } catch { /* ignore */ }
  schedulePrefsFlush(true); // ensure the row exists (and carries any migration)
  paintAvatar();
}

function pref(key, fallback) {
  const v = profile.data?.[key];
  return v === undefined ? fallback : v;
}

function setPref(key, value) {
  profile.data[key] = value;
  if (profile.guest) return; // guest: session memory only, nothing persists
  profile.dirty.add(key);
  try { localStorage.setItem(profileCacheKey(profile.slug), JSON.stringify(profile.data)); } catch { /* ignore */ }
  schedulePrefsFlush();
}

/* Write-through sync: only keys this session actually changed overwrite the
   remote copy, so two devices on one profile can't clobber each other. */
let prefsFlushTimer = null;

function schedulePrefsFlush(soon) {
  if (profile.guest) return;
  clearTimeout(prefsFlushTimer);
  prefsFlushTimer = setTimeout(flushPrefs, soon ? 50 : 800);
}

async function flushPrefs() {
  if (profile.guest || !profile.slug) return;
  const slug = profile.slug;
  const changed = [...profile.dirty];
  profile.dirty = new Set();
  try {
    let remote = {};
    try {
      const rows = await sb(`prefs?profile=eq.${encodeURIComponent(slug)}&select=data`);
      remote = rows[0]?.data || {};
    } catch { /* first write or offline — send what we have */ }
    const merged = { ...remote };
    for (const k of changed) merged[k] = profile.data[k];
    merged.name = profile.name;
    merged.color = profile.color;
    if (!merged.createdAt) merged.createdAt = profile.data.createdAt || new Date().toISOString().slice(0, 10);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/prefs`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                 "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ profile: slug, data: merged, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`prefs ${res.status}`);
    // adopt remote keys we didn't have, but keep anything edited mid-flight
    const result = { ...merged };
    for (const k of profile.dirty) result[k] = profile.data[k];
    profile.data = result;
    try { localStorage.setItem(profileCacheKey(slug), JSON.stringify(profile.data)); } catch { /* ignore */ }
  } catch {
    for (const k of changed) profile.dirty.add(k); // retry on the next write
  }
}

function paintAvatar() {
  const btn = $("profile-btn");
  if (!btn) return;
  const av = $("profile-avatar");
  av.textContent = (profile.name || "?").trim().charAt(0).toUpperCase();
  av.style.background = profile.guest ? "transparent" : (profile.color || "#8a94a0");
  av.classList.toggle("guest", profile.guest);
  btn.hidden = false;
}

function timeGreeting(name) {
  const h = new Date().getHours();
  const part = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return `${part}, ${name}`;
}

function slugifyName(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function pinHashOf(slug, pin) { return sha256Hex(`${slug}:${pin}`); }

function isLocked() {
  try { return localStorage.getItem(LOCKED_KEY) === "1"; } catch { return false; }
}
function setLocked() { try { localStorage.setItem(LOCKED_KEY, "1"); } catch { /* ignore */ } }
function clearLocked() { try { localStorage.removeItem(LOCKED_KEY); } catch { /* ignore */ } }

/* Upsert a profile's identity (name / color / passcode) without touching its
   other keys. Used by the picker's Edit flow. */
async function saveProfileMeta(slug, meta) {
  let remote = {};
  try {
    const rows = await sb(`prefs?profile=eq.${encodeURIComponent(slug)}&select=data`);
    remote = rows[0]?.data || {};
  } catch { /* offline: push what we know */ }
  const merged = { ...remote, name: meta.name, color: meta.color };
  if (meta.pinHash) merged.pinHash = meta.pinHash;
  else delete merged.pinHash;
  if (!merged.createdAt) merged.createdAt = new Date().toISOString().slice(0, 10);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/prefs`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
               "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ profile: slug, data: merged, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`prefs ${res.status}`);
  try { localStorage.setItem(profileCacheKey(slug), JSON.stringify(merged)); } catch { /* ignore */ }
  if (profile.slug === slug && !profile.guest) {
    profile.name = merged.name;
    profile.color = merged.color;
    Object.assign(profile.data, { name: merged.name, color: merged.color });
    if (merged.pinHash) profile.data.pinHash = merged.pinHash;
    else delete profile.data.pinHash;
    paintAvatar();
  }
}

/* The keypad — same design language as the old app lock, rendered into `host`.
   onEntry(pin, pad) fires at 4 digits; call pad.fail(msg) to shake and retry. */
function pinPad(host, subtitle, onEntry) {
  const wrap = document.createElement("div");
  wrap.className = "profile-pin";
  const prompt = document.createElement("p");
  prompt.className = "lock-prompt";
  prompt.textContent = subtitle;
  const dots = document.createElement("div");
  dots.className = "lock-dots";
  for (let i = 0; i < 4; i++) dots.appendChild(document.createElement("span"));
  const keys = document.createElement("div");
  keys.className = "lock-keys";
  for (const k of ["1", "2", "3", "4", "5", "6", "7", "8", "9", null, "0", "del"]) {
    if (k === null) { keys.appendChild(document.createElement("span")); continue; }
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.k = k;
    if (k === "del") { b.className = "lock-del"; b.setAttribute("aria-label", "Delete"); b.textContent = "⌫"; }
    else b.textContent = k;
    keys.appendChild(b);
  }
  wrap.append(prompt, dots, keys);
  host.appendChild(wrap);

  let entry = "", busy = false;
  const paint = () => [...dots.children].forEach((d, i) => d.classList.toggle("on", i < entry.length));
  const pad = {
    fail(msg) {
      prompt.textContent = msg;
      prompt.classList.add("err");
      dots.classList.add("shake");
      setTimeout(() => { dots.classList.remove("shake"); entry = ""; paint(); busy = false; }, 460);
    },
  };
  keys.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn || busy) return;
    const k = btn.dataset.k;
    if (k === "del") entry = entry.slice(0, -1);
    else if (entry.length < 4) {
      if (prompt.classList.contains("err")) { prompt.textContent = subtitle; prompt.classList.remove("err"); }
      entry += k;
    }
    paint();
    if (entry.length === 4) { busy = true; await onEntry(entry, pad); }
  });
  return pad;
}

/* Choose-and-confirm flow for setting a new passcode. */
function setPinFlow(host, slug, onSet, onCancel) {
  const cancelLink = () => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "profiles-cancel";
    b.textContent = "Cancel";
    b.addEventListener("click", onCancel);
    host.appendChild(b);
  };
  const run = () => {
    host.innerHTML = "";
    pinPad(host, "Choose a passcode", (first) => {
      host.innerHTML = "";
      pinPad(host, "Type it again", async (second, pad) => {
        if (first !== second) {
          pad.fail("Doesn't match");
          setTimeout(run, 700);
          return;
        }
        onSet(await pinHashOf(slug, second), second);
      });
      cancelLink();
    });
    cancelLink();
  };
  run();
}

/* The picker IS the lock. coldBoot=true on first load (init() runs after a
   profile is entered); coldBoot=false when the masthead monogram re-locks over
   the live app (re-entering the same reader resumes without a rebuild).
   Entering any profile that carries a passcode requires it; Guest never does. */
async function showProfilePicker(coldBoot) {
  const overlay = $("profiles");
  overlay.innerHTML = "";
  overlay.hidden = false;
  document.body.classList.add("profiles-open");

  const inner = document.createElement("div");
  inner.className = "profiles-inner";
  overlay.appendChild(inner);

  const word = document.createElement("div");
  word.className = "profiles-word";
  word.textContent = "Real Estate Briefing";
  inner.appendChild(word);

  const title = document.createElement("h2");
  title.className = "profiles-title";
  inner.appendChild(title);

  const stage = document.createElement("div");
  stage.className = "profiles-stage";
  inner.appendChild(stage);

  const closePicker = () => {
    overlay.classList.add("leaving");
    setTimeout(() => {
      overlay.hidden = true;
      overlay.classList.remove("leaving");
      document.body.classList.remove("profiles-open");
    }, 380);
  };

  let roster = profileRoster(await fetchProfileRows());

  const proceed = async (p) => {
    clearLocked();
    if (p.slug === "guest") {
      try { sessionStorage.setItem(GUEST_KEY, "1"); } catch { /* ignore */ }
      if (coldBoot) { await activateProfile("guest"); closePicker(); init(); }
      else if (profile.slug === "guest") closePicker();
      else location.reload();
      return;
    }
    if (coldBoot) {
      await activateProfile(p.slug, p);
      closePicker();
      init();
      flashToast(timeGreeting(profile.name));
    } else if (p.slug === profile.slug) {
      closePicker(); // same reader resuming: keep the live app as-is
    } else {
      await activateProfile(p.slug, p);
      await flushPrefs();
      location.reload();
    }
  };

  const backLink = (label, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "profiles-cancel";
    b.textContent = label;
    b.addEventListener("click", fn);
    stage.appendChild(b);
  };

  const showPinFor = (p, subtitle, onOk, backMode) => {
    title.textContent = p.name;
    stage.innerHTML = "";
    pinPad(stage, subtitle, async (pin, pad) => {
      if ((await pinHashOf(p.slug, pin)) === p.pinHash) onOk();
      else pad.fail("Wrong passcode");
    });
    backLink("‹ All readers", () => renderGrid(backMode));
  };

  const card = (p, i, mode) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "profile-card";
    el.style.animationDelay = `${60 + i * 55}ms`;
    const disc = document.createElement("span");
    disc.className = "profile-disc";
    disc.style.background = `linear-gradient(160deg, ${p.color} 0%, ${p.color} 55%, rgba(0,0,0,0.28) 160%)`;
    disc.textContent = p.name.trim().charAt(0).toUpperCase();
    el.appendChild(disc);
    if (mode === "edit") {
      const badge = document.createElement("span");
      badge.className = "profile-edit-badge";
      badge.textContent = "✎";
      el.appendChild(badge);
    }
    const nm = document.createElement("span");
    nm.className = "profile-name";
    nm.textContent = p.name;
    el.appendChild(nm);
    if (mode === "pick" && !coldBoot && p.slug === profile.slug) {
      el.classList.add("current");
      const now = document.createElement("span");
      now.className = "profile-now";
      now.textContent = "reading now";
      el.appendChild(now);
    }
    el.addEventListener("click", () => {
      if (mode === "edit") {
        if (p.pinHash) showPinFor(p, "Enter current passcode", () => renderEditForm(p, null), "edit");
        else renderEditForm(p, null);
        return;
      }
      if (p.pinHash) {
        showPinFor(p, "Enter passcode", () => proceed(p), "pick");
      } else {
        const grid = el.closest(".profiles-grid");
        grid.classList.add("chosen");
        el.classList.add("picked");
        setTimeout(() => proceed(p), 420);
      }
    });
    return el;
  };

  const renderGrid = (mode) => {
    title.textContent = mode === "edit" ? "Edit readers" : "Who's reading?";
    stage.innerHTML = "";
    const grid = document.createElement("div");
    grid.className = "profiles-grid";
    stage.appendChild(grid);
    let i = 0;
    for (const p of roster) grid.appendChild(card(p, i++, mode));

    if (mode === "pick") {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "profile-card";
      add.style.animationDelay = `${60 + i++ * 55}ms`;
      add.innerHTML = `<span class="profile-disc new">+</span><span class="profile-name">New</span>`;
      add.addEventListener("click", () => renderCreate(null));
      grid.appendChild(add);

      const guest = document.createElement("button");
      guest.type = "button";
      guest.className = "profiles-guest";
      guest.innerHTML = `Browse as guest<span>nothing is saved</span>`;
      guest.addEventListener("click", () => proceed({ slug: "guest" }));
      stage.appendChild(guest);

      backLink("Edit readers", () => renderGrid("edit"));
    } else {
      backLink("Done", () => renderGrid("pick"));
    }
  };

  /* Edit a reader's name / color / passcode. `preserved` carries in-progress
     field values across the set-passcode sub-flow. */
  const renderEditForm = (p, preserved) => {
    title.textContent = "Edit reader";
    stage.innerHTML = "";
    const form = document.createElement("div");
    form.className = "profile-create";
    stage.appendChild(form);

    let color = preserved ? preserved.color : p.color;
    let pendingPin = preserved ? preserved.pinHash : (p.pinHash || null);

    const preview = document.createElement("span");
    preview.className = "profile-disc preview";
    const paintPreview = (name) => {
      preview.style.background = `linear-gradient(160deg, ${color} 0%, ${color} 55%, rgba(0,0,0,0.28) 160%)`;
      preview.textContent = (name || "?").trim().charAt(0).toUpperCase() || "?";
    };
    form.appendChild(preview);

    const input = document.createElement("input");
    input.className = "profile-input";
    input.type = "text";
    input.maxLength = 24;
    input.value = preserved ? preserved.name : p.name;
    input.autocapitalize = "words";
    form.appendChild(input);
    paintPreview(input.value);
    input.addEventListener("input", () => paintPreview(input.value));

    const swatches = document.createElement("div");
    swatches.className = "profile-swatches";
    for (const c of PROFILE_COLORS) {
      const s = document.createElement("button");
      s.type = "button";
      s.className = "profile-swatch" + (c === color ? " on" : "");
      s.style.background = c;
      s.setAttribute("aria-label", "Pick color");
      s.addEventListener("click", () => {
        color = c;
        swatches.querySelectorAll(".on").forEach((el) => el.classList.remove("on"));
        s.classList.add("on");
        paintPreview(input.value);
      });
      swatches.appendChild(s);
    }
    form.appendChild(swatches);

    const pinRow = document.createElement("div");
    pinRow.className = "profile-pinrow";
    const status = document.createElement("span");
    const setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.className = "profile-chipbtn";
    const offBtn = document.createElement("button");
    offBtn.type = "button";
    offBtn.className = "profile-chipbtn";
    offBtn.textContent = "Remove";
    const paintPin = () => {
      status.textContent = pendingPin ? "Passcode on" : "No passcode";
      setBtn.textContent = pendingPin ? "Change" : "Set passcode";
      offBtn.hidden = !pendingPin;
    };
    paintPin();
    const toPinFlow = () => {
      const keep = { name: input.value, color, pinHash: pendingPin };
      setPinFlow(stage, p.slug,
        (hash) => { keep.pinHash = hash; renderEditForm(p, keep); },
        () => renderEditForm(p, keep));
      title.textContent = p.name;
    };
    setBtn.addEventListener("click", toPinFlow);
    offBtn.addEventListener("click", () => { pendingPin = null; paintPin(); });
    pinRow.append(status, setBtn, offBtn);
    form.appendChild(pinRow);

    const go = document.createElement("button");
    go.type = "button";
    go.className = "profile-go";
    go.textContent = "Save";
    go.addEventListener("click", async () => {
      const name = input.value.trim() || p.name;
      go.textContent = "Saving…";
      try {
        await saveProfileMeta(p.slug, { name, color, pinHash: pendingPin });
        roster = profileRoster(await fetchProfileRows());
        renderGrid("edit");
      } catch {
        go.textContent = "Couldn't save — try again";
      }
    });
    form.appendChild(go);

    backLink("‹ Readers", () => renderGrid("edit"));
  };

  /* New reader, with an optional passcode. */
  const renderCreate = (preserved) => {
    title.textContent = "New reader";
    stage.innerHTML = "";
    const form = document.createElement("div");
    form.className = "profile-create";
    stage.appendChild(form);

    const used = new Set(roster.map((r) => r.color));
    let color = preserved ? preserved.color
      : (PROFILE_COLORS.find((c) => !used.has(c)) || PROFILE_COLORS[roster.length % PROFILE_COLORS.length]);
    // the slug isn't final until submit, so hold the raw pin in memory (never
    // stored) and hash it against the real slug at submit time
    let pendingRaw = preserved ? preserved.rawPin : null;

    const preview = document.createElement("span");
    preview.className = "profile-disc preview";
    const paintPreview = (name) => {
      preview.style.background = `linear-gradient(160deg, ${color} 0%, ${color} 55%, rgba(0,0,0,0.28) 160%)`;
      preview.textContent = (name || "?").trim().charAt(0).toUpperCase() || "?";
    };
    form.appendChild(preview);

    const input = document.createElement("input");
    input.className = "profile-input";
    input.type = "text";
    input.maxLength = 24;
    input.placeholder = "Your name";
    input.autocapitalize = "words";
    if (preserved) input.value = preserved.name;
    form.appendChild(input);
    paintPreview(input.value);
    input.addEventListener("input", () => paintPreview(input.value));

    const swatches = document.createElement("div");
    swatches.className = "profile-swatches";
    for (const c of PROFILE_COLORS) {
      const s = document.createElement("button");
      s.type = "button";
      s.className = "profile-swatch" + (c === color ? " on" : "");
      s.style.background = c;
      s.setAttribute("aria-label", "Pick color");
      s.addEventListener("click", () => {
        color = c;
        swatches.querySelectorAll(".on").forEach((el) => el.classList.remove("on"));
        s.classList.add("on");
        paintPreview(input.value);
      });
      swatches.appendChild(s);
    }
    form.appendChild(swatches);

    const pinRow = document.createElement("div");
    pinRow.className = "profile-pinrow";
    const status = document.createElement("span");
    const setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.className = "profile-chipbtn";
    const paintPin = () => {
      status.textContent = pendingRaw ? "Passcode on" : "No passcode";
      setBtn.textContent = pendingRaw ? "Change" : "Add passcode";
    };
    paintPin();
    setBtn.addEventListener("click", () => {
      const keep = { name: input.value, color, rawPin: pendingRaw };
      setPinFlow(stage, "new",
        (hash, raw) => { keep.rawPin = raw; renderCreate(keep); },
        () => renderCreate(keep));
    });
    pinRow.append(status, setBtn);
    form.appendChild(pinRow);

    const go = document.createElement("button");
    go.type = "button";
    go.className = "profile-go";
    go.textContent = "Start reading";
    form.appendChild(go);

    backLink("‹ All readers", () => renderGrid("pick"));

    const submit = async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      let slug = slugifyName(name) || "reader";
      const taken = new Set(roster.map((r) => r.slug));
      let n = 2;
      while (taken.has(slug)) slug = `${slugifyName(name)}-${n++}`;
      const pinHash = pendingRaw ? await pinHashOf(slug, pendingRaw) : null;
      proceed({ slug, name, color, pinHash });
    };
    go.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  };

  renderGrid("pick");
}

/* ---------- term of the day ----------
   One card, one habit: a date-seeded pick weighted toward recently-mentioned
   terms, definition hidden behind a reveal (active recall). "Got it" marks the
   term learned on this profile and retires it from the rotation. */

function renderTermOfDay(wrap, all) {
  const learned = new Set(pref("learnedTerms", []));
  let pool = all.filter((t) => !learned.has(t.slug));
  if (!pool.length) pool = all;
  const recent = pool.filter((t) => daysSince(t.stats?.lastSeen) <= 14);
  const pickFrom = recent.length >= 3 ? recent : pool;
  const today = new Date().toISOString().slice(0, 10);
  let h = 0;
  for (const ch of today) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const t = pickFrom[h % pickFrom.length];
  if (!t) return;

  const card = document.createElement("div");
  card.className = "totd";

  const kicker = document.createElement("div");
  kicker.className = "totd-kicker";
  kicker.textContent = "Term of the day";
  card.appendChild(kicker);

  const head = document.createElement("div");
  head.className = "totd-head";
  const name = document.createElement("span");
  name.className = "totd-term";
  name.textContent = t.term;
  head.appendChild(name);
  if (t.category) {
    const c = document.createElement("span");
    c.className = "totd-cat";
    c.textContent = t.category;
    head.appendChild(c);
  }
  card.appendChild(head);

  const def = document.createElement("p");
  def.className = "totd-def";
  def.textContent = t.shortDef || (t.definition || "").split("\n")[0];
  def.hidden = true;
  card.appendChild(def);

  const actions = document.createElement("div");
  actions.className = "totd-actions";
  card.appendChild(actions);

  const reveal = document.createElement("button");
  reveal.className = "totd-reveal";
  reveal.textContent = "Reveal definition";
  actions.appendChild(reveal);

  reveal.addEventListener("click", () => {
    def.hidden = false;
    actions.innerHTML = "";

    const got = document.createElement("button");
    got.className = "totd-chip";
    got.textContent = "Got it ✓";
    got.addEventListener("click", () => {
      const list = pref("learnedTerms", []);
      if (!list.includes(t.slug)) setPref("learnedTerms", [...list, t.slug]);
      got.textContent = "Learned — retired from rotation";
      got.disabled = true;
    });
    actions.appendChild(got);

    const full = document.createElement("button");
    full.className = "totd-chip quiet";
    full.textContent = "Full entry →";
    full.addEventListener("click", () => { location.hash = `/term/${t.slug}`; });
    actions.appendChild(full);

    const mn = (t.mentions || [])[0];
    if (mn) {
      const seen = document.createElement("button");
      seen.className = "totd-seen";
      seen.textContent = `Seen ${formatDate(mn.date, { month: "short", day: "numeric" })}: ${mn.title}`;
      seen.addEventListener("click", () => { location.hash = `/story/${mn.date}/${mn.id}`; });
      card.appendChild(seen);
    }
  });

  wrap.appendChild(card);
}

/* ---------- history heatmap ---------- */

async function renderHistoryHeat(wrap) {
  const days = await getAllDays();
  if (days.length < 2) return;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const metric = state.histMetric || "stories";
  const valOf = (d) => !d ? 0
    : metric === "stories" ? (d.stories || []).length
    : (d.stories || []).reduce((s, x) => s + (x.valueUsd || 0), 0);

  const box = document.createElement("div");
  box.className = "heat";

  const bar = document.createElement("div");
  bar.className = "heat-bar";
  const label = document.createElement("span");
  label.className = "heat-label";
  label.textContent = "Every briefing";
  bar.appendChild(label);
  const toggle = document.createElement("div");
  toggle.className = "map-toggle";
  for (const [val, text] of [["stories", "Stories"], ["value", "Deal $"]]) {
    const b = document.createElement("button");
    b.textContent = text;
    b.classList.toggle("on", metric === val);
    b.addEventListener("click", () => { state.histMetric = val; renderHistory(); });
    toggle.appendChild(b);
  }
  bar.appendChild(toggle);
  box.appendChild(bar);

  // months from the first briefing to today, each a little calendar
  const first = state.dates[0];
  const todayIso = new Date().toISOString().slice(0, 10);
  const max = Math.max(...days.map(valOf), 1);
  let [y, m] = first.split("-").map(Number);
  const [ty, tm] = todayIso.split("-").map(Number);

  const months = document.createElement("div");
  months.className = "heat-months";
  while (y < ty || (y === ty && m <= tm)) {
    const month = document.createElement("div");
    month.className = "heat-month";
    const name = document.createElement("div");
    name.className = "heat-month-name";
    name.textContent = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    month.appendChild(name);
    const grid = document.createElement("div");
    grid.className = "heat-grid";
    const firstDow = new Date(y, m - 1, 1).getDay();
    for (let i = 0; i < firstDow; i++) grid.appendChild(document.createElement("span"));
    const dim = new Date(y, m, 0).getDate();
    for (let d = 1; d <= dim; d++) {
      const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const day = byDate.get(iso);
      const v = valOf(day);
      const cell = document.createElement(day ? "button" : "span");
      cell.className = "heat-cell";
      if (day) {
        const level = v <= 0 ? 1 : Math.min(4, 1 + Math.floor((v / max) * 3.999));
        cell.classList.add(`l${level}`);
        cell.title = `${formatDate(iso, { month: "short", day: "numeric" })} · ${
          metric === "stories" ? `${v} stories` : (fmtValue(v) || "$0")}`;
        cell.addEventListener("click", () => { location.hash = `/day/${iso}`; });
      }
      grid.appendChild(cell);
    }
    month.appendChild(grid);
    months.appendChild(month);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  box.appendChild(months);
  wrap.appendChild(box);
}

/* ---------- share card ----------
   A typographic image of the story (no remote photos — cross-origin images
   taint the canvas), rendered on demand and handed to the native share sheet. */

function cardWrapText(x, text, maxWidth, maxLines) {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const probe = line ? line + " " + w : w;
    if (x.measureText(probe).width > maxWidth && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    } else {
      line = probe;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  else if (lines.length === maxLines && line) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s+\S*$/, "") + "…";
  return lines;
}

function shareStoryCard(story, date) {
  // the shortest honest form of the article link: origin + path, no tracking
  let link = null;
  if (story.url) {
    try {
      const u = new URL(story.url);
      link = u.origin + u.pathname;
    } catch { link = story.url; }
  }

  const W = 1080, H = 1350, P = 96;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d");
  const SERIF = "Georgia, 'Times New Roman', serif";
  const SANS = "-apple-system, 'Helvetica Neue', Arial, sans-serif";

  x.fillStyle = "#fafaf7";
  x.fillRect(0, 0, W, H);

  // masthead
  x.textAlign = "center";
  x.fillStyle = "#99a1ab";
  if ("letterSpacing" in x) x.letterSpacing = "8px";
  x.font = `700 30px ${SERIF}`;
  x.fillText("REAL ESTATE BRIEFING", W / 2, P + 10);
  if ("letterSpacing" in x) x.letterSpacing = "0px";
  x.font = `400 26px ${SANS}`;
  x.fillText(formatDate(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" }), W / 2, P + 58);
  x.strokeStyle = "#14181d";
  x.lineWidth = 3;
  x.beginPath();
  x.moveTo(P, P + 100);
  x.lineTo(W - P, P + 100);
  x.stroke();

  x.textAlign = "left";
  const maxW = W - 2 * P;

  // measure first, draw second: the headline shrinks to fit long titles
  // (78px → 66px → 58px) and the whole block centers vertically between the
  // masthead rule and the footer instead of leaving dead air at the bottom
  let headSize = 78, headLH = 92, headLines;
  for (const [size, lh] of [[78, 92], [66, 79], [58, 70]]) {
    headSize = size;
    headLH = lh;
    x.font = `700 ${size}px ${SERIF}`;
    headLines = cardWrapText(x, story.title, maxW, 5);
    if (headLines.length <= 3) break;
  }
  x.font = `400 37px ${SANS}`;
  const sumLines = cardWrapText(x, story.summary || "", maxW, 5);

  const chips = [];
  if (story.dealType) chips.push(story.dealType);
  if (story.market) chips.push(story.market);
  const v = fmtValue(story.valueUsd);
  if (v) chips.push(v);
  const per = derivedMetric(story);
  if (per) chips.push(per);

  const kickerH = story.section ? 28 + 56 : 0;
  const blockH = kickerH + headLines.length * headLH + 26
    + (sumLines.length ? sumLines.length * 54 + 40 : 0)
    + (chips.length ? 58 : 0);
  const contentTop = P + 100 + 56;           // below the masthead rule
  const contentBottom = H - P - 52 - 60;     // above the footer rule
  let y = contentTop + Math.max(0, (contentBottom - contentTop - blockH) / 2) + headSize * 0.8;

  // section kicker
  if (story.section) {
    x.fillStyle = "#2158a8";
    x.font = `700 28px ${SANS}`;
    if ("letterSpacing" in x) x.letterSpacing = "3px";
    x.fillText(story.section.toUpperCase(), P, y - headSize * 0.8 + 16);
    if ("letterSpacing" in x) x.letterSpacing = "0px";
    y += kickerH;
  }

  // headline
  x.fillStyle = "#14181d";
  x.font = `700 ${headSize}px ${SERIF}`;
  for (const line of headLines) {
    x.fillText(line, P, y);
    y += headLH;
  }
  y += 26;

  // summary
  x.fillStyle = "#59626d";
  x.font = `400 37px ${SANS}`;
  for (const line of sumLines) {
    x.fillText(line, P, y);
    y += 54;
  }
  if (sumLines.length) y += 40;

  // chips
  x.font = `600 30px ${SANS}`;
  let cx = P;
  for (const text of chips) {
    const w = x.measureText(text).width + 44;
    if (cx + w > W - P) break;
    x.strokeStyle = "#d7dbe0";
    x.lineWidth = 2;
    x.beginPath();
    x.roundRect(cx, y - 40, w, 58, 29);
    x.stroke();
    x.fillStyle = "#14181d";
    x.fillText(text, cx + 22, y);
    cx += w + 18;
  }

  // footer
  const fy = H - P - 40;
  x.strokeStyle = "#e6e9ed";
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(P, fy - 52);
  x.lineTo(W - P, fy - 52);
  x.stroke();
  x.fillStyle = "#59626d";
  x.font = `600 28px ${SANS}`;
  x.fillText(storyPublishers(story, false).slice(0, 2).join(" · "), P, fy);
  x.textAlign = "right";
  x.fillStyle = "#99a1ab";
  x.font = `400 26px ${SANS}`;
  x.fillText("briefing.pierrepontcompanies.com", W - P, fy);
  x.textAlign = "left";

  // Build the PNG SYNCHRONOUSLY (toDataURL, not the async toBlob). Awaiting a
  // blob here would drop the user-activation and iOS would silently block the
  // share — the whole point is to stay inside the live tap gesture.
  // We deliberately do NOT hand the file to navigator.share: iOS Messages shows
  // a web-SHARED image in the share sheet but silently drops it when the compose
  // window opens — true for PNG *and* JPEG, an Apple bug no page can override.
  // The reliable path is to show the card as a REAL <img> and let the user
  // touch-and-hold it: iOS treats a long-pressed image as genuine media, so its
  // Share → Messages always attaches. PNG for a crisp card + clipboard copy.
  const png = canvasToFile(c, "image/png", `${story.id}.png`);
  if (!png) { flashToast("Couldn't render the card"); return; }
  showShareBox(png, `${story.id}.png`, link);
}

/* Canvas → File, fully synchronous. toDataURL blocks (unlike toBlob), which is
   exactly what we need: the File is ready without yielding the event loop, so a
   navigator.share() right after still counts as user-initiated on iOS. */
function canvasToFile(canvas, type, filename, quality) {
  try {
    const url = quality != null ? canvas.toDataURL(type, quality) : canvas.toDataURL(type);
    const b64 = url.split(",")[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], filename, { type });
  } catch { return null; }
}

/* The card viewer — now a FALLBACK, shown only when the direct native share
   isn't available (desktop, older browsers) or it fails. The card lives here as
   a REAL image: touch-and-hold gives the native photo menu (Share / Copy /
   Save), and each button runs in its own fresh tap gesture, which is what the
   clipboard and share APIs require. */
let shareBoxState = null;

function showShareBox(blob, filename, link) {
  const box = $("sharebox");
  if (shareBoxState?.url) URL.revokeObjectURL(shareBoxState.url);
  const url = URL.createObjectURL(blob);
  shareBoxState = { blob, filename, link, url };
  $("sharebox-img").src = url;
  $("sharebox-link").hidden = !link;
  box.hidden = false;
}

function hideShareBox() {
  const box = $("sharebox");
  box.hidden = true;
  if (shareBoxState?.url) URL.revokeObjectURL(shareBoxState.url);
  shareBoxState = null;
}

/* ---------- system status ---------- */

async function readHeartbeatRow() {
  try {
    const rows = await sb("secrets?id=eq.fill_heartbeat&select=data");
    return rows[0]?.data || null;
  } catch { return null; }
}

function ageMin(iso) {
  return iso ? (Date.now() - Date.parse(iso)) / 60000 : Infinity;
}

function missingContent(day) {
  return (day?.stories || []).filter((s) =>
    s.url && contentWords(s) < 120 && !s.sourceBlocked);
}

async function paintHealthDot(day) {
  const dot = $("health-dot");
  if (!dot) return;
  const hb = await readHeartbeatRow();
  const age = ageMin(hb?.lastRun);
  const missing = missingContent(day).length;
  const cls = age > 180 ? "bad" : (age > 90 || missing ? "warn" : "ok");
  dot.className = "health-dot " + cls;
}

function statusCard(title) {
  const card = document.createElement("div");
  card.className = "status-card";
  const h = document.createElement("div");
  h.className = "status-title";
  h.textContent = title;
  card.appendChild(h);
  return card;
}

function statusRow(card, label, value, cls) {
  const row = document.createElement("div");
  row.className = "status-row";
  const l = document.createElement("span");
  l.className = "status-label";
  l.textContent = label;
  const r = document.createElement("span");
  r.className = "status-value" + (cls ? " " + cls : "");
  r.textContent = value;
  row.append(l, r);
  card.appendChild(row);
  return row;
}

function fmtAge(min) {
  if (!isFinite(min)) return "never";
  if (min < 60) return `${Math.round(min)} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

/* ---------- Phase 5: story threads, calendar, market metrics ----------
   Three surfaces over the pipeline's deep-data registries (CLAUDE.md 10b–10d).
   No new tab — reached like History/Status: from the reader (arc banner), the
   Trends page (arcs + metrics), and the briefing/alerts (calendar). Every render
   guards for [] because the tables stay empty until there's qualifying content. */

function pageHead(title, sub) {
  const head = document.createElement("div");
  head.className = "page-head";
  const h = document.createElement("h2");
  h.textContent = title;
  head.appendChild(h);
  if (sub) {
    const p = document.createElement("p");
    p.textContent = sub;
    head.appendChild(p);
  }
  return head;
}

function emptyPanel(title, msg) {
  const wrap = document.createElement("div");
  wrap.className = "panel-empty";
  const h = document.createElement("h3");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = msg;
  wrap.append(h, p);
  return wrap;
}

function backLink(label, hash) {
  const a = document.createElement("a");
  a.className = "back-link";
  a.href = hash;
  a.textContent = "‹ " + label;
  return a;
}

function todayISO() {
  return new Date().toLocaleDateString("en-CA"); // local YYYY-MM-DD
}

/* --- Story threads (arcs) --- */
async function renderThreads() {
  const wrap = $("threads-content");
  wrap.innerHTML = "";
  wrap.appendChild(pageHead("Story Arcs",
    "Running storylines the briefing is tracking. Each links stories by a concrete shared spine — the same property, deal, lawsuit, or company event — never a vague theme."));
  const threads = await getThreads();
  if (!threads.length) {
    wrap.appendChild(emptyPanel("No arcs yet",
      "When two or more stories share a concrete anchor — the same building, deal, case, or company event — they connect into a timeline here."));
    return;
  }
  const sorted = [...threads].sort((a, b) => {
    const ar = a.status === "resolved" ? 1 : 0, br = b.status === "resolved" ? 1 : 0;
    if (ar !== br) return ar - br;                 // active before resolved
    return (b.lastSeen || "").localeCompare(a.lastSeen || "");
  });
  const list = document.createElement("div");
  list.className = "thread-list";
  for (const t of sorted) list.appendChild(threadCard(t));
  wrap.appendChild(list);
}

function threadCard(t) {
  const btn = document.createElement("button");
  btn.className = "thread-card";
  btn.addEventListener("click", () => { location.hash = `/thread/${t.slug}`; });
  const top = document.createElement("div");
  top.className = "thread-card-top";
  const h = document.createElement("h3");
  h.textContent = t.title || t.slug;
  const st = document.createElement("span");
  st.className = "thread-status " + (t.status === "resolved" ? "resolved" : "active");
  st.textContent = t.status === "resolved" ? "Resolved" : "Active";
  top.append(h, st);
  const anchor = document.createElement("p");
  anchor.className = "thread-anchor";
  anchor.textContent = t.anchor || "";
  const meta = document.createElement("p");
  meta.className = "thread-meta";
  const n = (t.entries || []).length;
  meta.textContent = `${n} ${n === 1 ? "story" : "stories"}` +
    (t.lastSeen ? " · updated " + formatDate(t.lastSeen, { month: "short", day: "numeric" }) : "");
  btn.append(top, anchor, meta);
  return btn;
}

async function renderThread(slug) {
  const wrap = $("threads-content");
  wrap.innerHTML = "";
  wrap.appendChild(backLink("All arcs", "#/threads"));
  const threads = await getThreads();
  const t = threads.find((x) => x.slug === slug);
  if (!t) { wrap.appendChild(emptyPanel("Arc not found", "This storyline isn't on record.")); return; }

  const head = document.createElement("div");
  head.className = "thread-head";
  const h = document.createElement("h2");
  h.textContent = t.title || slug;
  const st = document.createElement("span");
  st.className = "thread-status " + (t.status === "resolved" ? "resolved" : "active");
  st.textContent = t.status === "resolved" ? "Resolved" : "Active";
  head.append(h, st);
  wrap.appendChild(head);
  if (t.anchor) {
    const a = document.createElement("p");
    a.className = "thread-anchor big";
    a.textContent = t.anchor;
    wrap.appendChild(a);
  }

  // entries are stored newest-first; a timeline reads oldest → newest
  const entries = [...(t.entries || [])].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const tl = document.createElement("div");
  tl.className = "timeline";
  for (const e of entries) {
    const row = document.createElement("button");
    row.className = "timeline-row";
    row.addEventListener("click", () => { location.hash = `/story/${e.date}/${e.id}`; });
    const dot = document.createElement("div");
    dot.className = "tl-dot";
    const body = document.createElement("div");
    body.className = "tl-body";
    const d = document.createElement("div");
    d.className = "tl-date";
    d.textContent = formatDate(e.date, { month: "short", day: "numeric", year: "numeric" });
    const ti = document.createElement("div");
    ti.className = "tl-title";
    ti.textContent = e.title;
    body.append(d, ti);
    if (e.delta) {
      const dl = document.createElement("div");
      dl.className = "tl-delta";
      dl.textContent = e.delta;
      body.appendChild(dl);
    }
    if (e.why) {
      const w = document.createElement("div");
      w.className = "tl-why";
      w.textContent = e.why;
      body.appendChild(w);
    }
    row.append(dot, body);
    tl.appendChild(row);
  }
  wrap.appendChild(tl);
}

/* --- Calendar (dated catalysts) --- */
const EVENT_ICON = { auction: "🔨", court: "⚖️", policy: "🏛️", fed: "🏦", data: "📊", deadline: "⏳", opening: "🏗️", other: "📌" };

async function renderCalendar() {
  const wrap = $("calendar-content");
  wrap.innerHTML = "";
  wrap.appendChild(pageHead("Calendar",
    "Dated catalysts pulled from the briefing — auctions, court dates, policy deadlines, Fed decisions. Tap one to read the story it came from; star it to be reminded the morning it lands."));
  const events = await getEvents();
  if (!events.length) {
    wrap.appendChild(emptyPanel("Nothing scheduled yet",
      "As stories name concrete dated events, they gather here — as an agenda and a month calendar — each tapping through to its source story."));
    return;
  }

  // resolve each event's source story so rows can tap through to the reader
  const days = await getAllDays();
  const storyIndex = new Map();
  for (const d of days) for (const s of (d.stories || [])) storyIndex.set(d.date + "|" + s.id, { ...s, _date: d.date });

  // Agenda / Month layout toggle + export
  const toolbar = document.createElement("div");
  toolbar.className = "cal-toolbar";
  const toggle = document.createElement("div");
  toggle.className = "cal-toggle";
  for (const [key, label] of [["agenda", "Agenda"], ["month", "Month"]]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = state.calView === key ? "on" : "";
    b.addEventListener("click", () => { state.calView = key; renderCalendar(); });
    toggle.appendChild(b);
  }
  toolbar.appendChild(toggle);
  const today = todayISO();
  const future = events.filter((e) => (e.date || "") >= today && !e.resolvedBy);
  if (future.length) {
    const ics = document.createElement("button");
    ics.className = "cal-ics";
    ics.textContent = "⤓ Add to calendar";
    ics.addEventListener("click", () => exportICS(future));
    toolbar.appendChild(ics);
  }
  wrap.appendChild(toolbar);

  if (state.calView === "month") renderCalendarMonth(wrap, events, storyIndex);
  else renderCalendarAgenda(wrap, events, storyIndex);
}

/* Export upcoming catalysts as an .ics the reader can drop into Apple/Google
   Calendar — all-day events, one VEVENT each, generated entirely client-side. */
function icsDate(iso) { return (iso || "").replace(/-/g, ""); }
function icsEscape(s) { return String(s || "").replace(/[\\;,]/g, "\\$&").replace(/\n/g, "\\n"); }

function exportICS(events) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CRE Briefing//Calendar//EN", "CALSCALE:GREGORIAN"];
  for (const e of events) {
    if (!e.date) continue;
    const start = new Date(e.date + "T00:00:00");
    const end = new Date(start.getTime() + 86400000);
    const endIso = end.toISOString().slice(0, 10);
    const bits = [];
    if (e.market && e.market !== "National") bits.push(e.market);
    if (e.approx === "month") bits.push("date approximate");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@briefing.pierrepontcompanies.com`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(e.date)}`,
      `DTEND;VALUE=DATE:${icsDate(endIso)}`,
      `SUMMARY:${icsEscape((EVENT_ICON[e.type] || "📌") + " " + (e.title || ""))}`,
      `DESCRIPTION:${icsEscape([bits.join(" · "), "From the CRE Briefing calendar."].filter(Boolean).join("\n"))}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "cre-briefing-calendar.ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  flashToast(`${events.length} event${events.length === 1 ? "" : "s"} exported`);
}

function renderCalendarAgenda(wrap, events, storyIndex) {
  const today = todayISO();
  const upcoming = events.filter((e) => (e.date || "") >= today)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const past = events.filter((e) => (e.date || "") < today)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  if (upcoming.length) {
    wrap.appendChild(subHead("Upcoming", null));
    const g = document.createElement("div");
    g.className = "cal-list";
    for (const e of upcoming) g.appendChild(eventRow(e, false, storyIndex));
    wrap.appendChild(g);
  }
  if (past.length) {
    wrap.appendChild(subHead("Passed", null));
    const g = document.createElement("div");
    g.className = "cal-list";
    for (const e of past.slice(0, 40)) g.appendChild(eventRow(e, true, storyIndex));
    wrap.appendChild(g);
  }
}

function shiftMonth(ym, delta) {
  let [y, m] = ym.split("-").map(Number);
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

function renderCalendarMonth(wrap, events, storyIndex) {
  const today = todayISO();
  const byDate = new Map();
  for (const e of events) { (byDate.get(e.date) || byDate.set(e.date, []).get(e.date)).push(e); }

  // default to the month of the nearest upcoming event (else the latest event)
  if (!state.calMonth) {
    const upcoming = events.map((e) => e.date).filter((d) => d >= today).sort();
    const all = events.map((e) => e.date).sort();
    state.calMonth = (upcoming[0] || all[all.length - 1] || today).slice(0, 7);
  }
  const [Y, M] = state.calMonth.split("-").map(Number);

  // month nav
  const nav = document.createElement("div");
  nav.className = "cal-nav";
  const prev = document.createElement("button");
  prev.className = "cal-navbtn"; prev.textContent = "‹"; prev.setAttribute("aria-label", "Previous month");
  prev.addEventListener("click", () => { state.calMonth = shiftMonth(state.calMonth, -1); state.calDay = null; renderCalendar(); });
  const label = document.createElement("div");
  label.className = "cal-nav-label";
  label.textContent = new Date(Y, M - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const next = document.createElement("button");
  next.className = "cal-navbtn"; next.textContent = "›"; next.setAttribute("aria-label", "Next month");
  next.addEventListener("click", () => { state.calMonth = shiftMonth(state.calMonth, 1); state.calDay = null; renderCalendar(); });
  nav.append(prev, label, next);
  wrap.appendChild(nav);

  // grid
  const grid = document.createElement("div");
  grid.className = "cal-grid";
  for (const w of ["S", "M", "T", "W", "T", "F", "S"]) {
    const h = document.createElement("div"); h.className = "cal-wd"; h.textContent = w; grid.appendChild(h);
  }
  const startDow = new Date(Y, M - 1, 1).getDay();
  const daysInMonth = new Date(Y, M, 0).getDate();
  for (let i = 0; i < startDow; i++) { const c = document.createElement("div"); c.className = "cal-cell blank"; grid.appendChild(c); }
  let firstEventDay = null;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${Y}-${String(M).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const evs = byDate.get(iso) || [];
    const cell = document.createElement(evs.length ? "button" : "div");
    cell.className = "cal-cell" + (evs.length ? " has" : "") + (iso === today ? " today" : "") + (iso === state.calDay ? " sel" : "");
    const num = document.createElement("span"); num.className = "cal-num"; num.textContent = d; cell.appendChild(num);
    if (evs.length) {
      const dot = document.createElement("span"); dot.className = "cal-dot"; cell.appendChild(dot);
      if (!firstEventDay) firstEventDay = iso;
      // tap a day to select it; tap the already-selected (blue) day to deselect
      cell.addEventListener("click", () => { state.calDay = (state.calDay === iso) ? null : iso; renderCalendar(); });
    }
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);

  // detail for the selected day (default: first event day in the shown month)
  const sel = (state.calDay && state.calDay.slice(0, 7) === state.calMonth) ? state.calDay : firstEventDay;
  if (sel) {
    const [sy, sm, sd] = sel.split("-").map(Number);
    const head = document.createElement("div");
    head.className = "cal-detail-head";
    head.textContent = new Date(sy, sm - 1, sd).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    wrap.appendChild(head);
    const list = document.createElement("div");
    list.className = "cal-list";
    for (const e of byDate.get(sel) || []) list.appendChild(eventRow(e, sel < today, storyIndex));
    wrap.appendChild(list);
  } else {
    const p = document.createElement("p");
    p.className = "cal-none";
    p.textContent = "No events this month.";
    wrap.appendChild(p);
  }
}

function eventRow(e, isPast, storyIndex) {
  const src = (e.announcedBy && e.announcedBy[e.announcedBy.length - 1]) || null;
  const srcStory = (src && storyIndex) ? storyIndex.get(src.day + "|" + src.id) : null;

  const row = document.createElement("div");
  row.className = "cal-row" + (isPast ? " past" : "");

  // the whole card (minus the star) taps through to the source story
  const open = document.createElement(src ? "button" : "div");
  open.className = "cal-open";

  const date = document.createElement("div");
  date.className = "cal-date";
  const mo = document.createElement("div"); mo.className = "cal-mo"; mo.textContent = formatDate(e.date, { month: "short" });
  const dd = document.createElement("div"); dd.className = "cal-dd"; dd.textContent = formatDate(e.date, { day: "numeric" });
  date.append(mo, dd);

  const body = document.createElement("div");
  body.className = "cal-body";
  const t = document.createElement("div");
  t.className = "cal-title";
  t.textContent = (EVENT_ICON[e.type] || "📌") + " " + (e.title || "");
  body.appendChild(t);
  const bits = [];
  if (e.market && e.market !== "National") bits.push(e.market);
  if (e.approx === "month") bits.push("date approx.");
  if (bits.length) {
    const m = document.createElement("div"); m.className = "cal-meta"; m.textContent = bits.join(" · ");
    body.appendChild(m);
  }
  if (e.resolvedBy?.outcome) {
    const r = document.createElement("div"); r.className = "cal-outcome"; r.textContent = "✓ " + e.resolvedBy.outcome;
    body.appendChild(r);
  }
  if (src) {
    const s = document.createElement("div");
    s.className = "cal-src";
    s.textContent = srcStory ? `From: ${srcStory.title} →` : "Read the source story →";
    body.appendChild(s);
  }
  open.append(date, body);
  if (src) open.addEventListener("click", () => { location.hash = `/story/${src.day}/${src.id}`; });
  row.appendChild(open);

  // star to opt into a morning-of reminder (push-dispatch reads starEvents)
  if (!isPast && !e.resolvedBy) {
    const star = document.createElement("button");
    star.className = "cal-star";
    const paint = () => {
      const on = (pref("starEvents", []) || []).includes(e.id);
      star.textContent = on ? "★" : "☆";
      star.classList.toggle("on", on);
      star.setAttribute("aria-label", on ? "Starred — tap to remove" : "Star for a reminder");
    };
    paint();
    star.addEventListener("click", () => {
      const cur = new Set(pref("starEvents", []) || []);
      if (cur.has(e.id)) cur.delete(e.id); else cur.add(e.id);
      setPref("starEvents", [...cur]);
      paint();
      flashToast(cur.has(e.id) ? "Starred — you'll get a reminder" : "Reminder removed");
    });
    row.appendChild(star);
  }
  return row;
}

/* --- Market metrics (cards + sparkline) --- */
function fmtMetric(v, unit) {
  if (unit === "%") return (Math.round(v * 100) / 100) + "%";
  if (unit === "bps") return v + " bps";
  // big dollars (home prices) abbreviate to $M/$B; small ones (rents) stay exact
  if (unit === "$") return v >= 1e6 ? fmtValue(v) : "$" + Math.round(v).toLocaleString();
  return String(v);
}

function metricCard(m) {
  const card = document.createElement("div");
  card.className = "metric-card";
  const series = [...(m.series || [])].sort((a, b) => (a.asOf || "").localeCompare(b.asOf || ""));
  const last = series[series.length - 1];

  // geography chip up top — makes explicit whether it's a national series or a
  // market-specific print, so a metric never masquerades as market-agnostic
  const geo = document.createElement("div");
  geo.className = "metric-geo";
  geo.textContent = m.geography || "National";
  card.appendChild(geo);

  const top = document.createElement("div");
  top.className = "metric-top";
  const name = document.createElement("div");
  name.className = "metric-name";
  name.textContent = m.name || m.id;
  const val = document.createElement("div");
  val.className = "metric-val";
  val.textContent = last ? fmtMetric(last.value, m.unit) : "—";
  if (series.length >= 2) {
    const d = last.value - series[series.length - 2].value;
    if (d !== 0) {
      const del = document.createElement("span");
      del.className = "metric-delta " + (d > 0 ? "up" : "down");
      del.textContent = (d > 0 ? " ▲" : " ▼");
      val.appendChild(del);
    }
  }
  top.append(name, val);
  card.appendChild(top);

  if (series.length >= 2) card.appendChild(sparkline(series.map((s) => s.value)));

  const meta = document.createElement("div");
  meta.className = "metric-meta";
  const bits = [];
  if (m.geography && m.geography !== "National") bits.push(m.geography);
  if (last?.source) bits.push("per " + last.source);
  if (last?.asOf) bits.push(formatDate(last.asOf, { month: "short", year: "numeric" }));
  meta.textContent = bits.join(" · ");
  card.appendChild(meta);
  return card;
}

function sparkline(values) {
  const w = 132, h = 34, pad = 3;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const step = (w - pad * 2) / Math.max(1, values.length - 1);
  const pts = values.map((v, i) =>
    `${(pad + i * step).toFixed(1)},${(pad + (1 - (v - min) / span) * (h - pad * 2)).toFixed(1)}`);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("class", "sparkline");
  svg.setAttribute("preserveAspectRatio", "none");
  const poly = document.createElementNS(NS, "polyline");
  poly.setAttribute("points", pts.join(" "));
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "currentColor");
  poly.setAttribute("stroke-width", "1.5");
  poly.setAttribute("stroke-linecap", "round");
  poly.setAttribute("stroke-linejoin", "round");
  svg.appendChild(poly);
  return svg;
}

async function renderStatus() {
  const wrap = $("status-content");
  wrap.innerHTML = "";

  const head = document.createElement("div");
  head.className = "status-head";
  head.innerHTML = `<h2>System status</h2><p>The pipeline behind the briefing — content filling, sources, and sessions.</p>`;
  wrap.appendChild(head);

  const latest = state.dates[state.dates.length - 1];
  const [day, hb] = await Promise.all([getDay(latest), readHeartbeatRow()]);
  // session health comes from the PUBLIC app_status table (metadata only — the
  // cookies themselves live in the locked-down secrets vault the app never reads)
  let connMeta = [];
  try { connMeta = await sb("app_status?id=in.(conn_therealdeal.com,conn_bisnow.com)&select=id,data"); } catch { /* offline */ }
  let ratesAt = null;
  try { const r = await sb("rates_cache?id=eq.1&select=generated_at"); ratesAt = r[0]?.generated_at || null; } catch { /* offline */ }

  const briefingCard = statusCard("Today's briefing");
  if (day) {
    const stories = day.stories || [];
    statusRow(briefingCard, "Date", formatDate(day.date, { weekday: "long", month: "long", day: "numeric" }));
    statusRow(briefingCard, "Last compiled", day.generatedAt
      ? new Date(day.generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "—");
    statusRow(briefingCard, "Stories", `${stories.length} (${stories.filter((s) => s.featured).length} top · ${stories.filter((s) => s.brief).length} briefs)`);
    if (day.notes) statusRow(briefingCard, "Notes", day.notes);
  } else {
    statusRow(briefingCard, "Date", "no briefing loaded", "warn");
  }
  wrap.appendChild(briefingCard);

  const contentCard = statusCard("Article content");
  if (day) {
    const withUrl = (day.stories || []).filter((s) => s.url);
    const missing = missingContent(day);
    const blocked = (day.stories || []).filter((s) => s.sourceBlocked);
    statusRow(contentCard, "Full text in-app",
      `${withUrl.length - missing.length - blocked.length} of ${withUrl.length}`,
      missing.length ? "warn" : "ok");
    for (const s of missing) statusRow(contentCard, s.id, "waiting on the fill loop", "warn");
    for (const s of blocked) statusRow(contentCard, s.id, "reads at source (unfetchable)");
  }
  wrap.appendChild(contentCard);

  const hbCard = statusCard("Content heartbeat");
  const hbAge = ageMin(hb?.lastRun);
  statusRow(hbCard, "Last filler run", fmtAge(hbAge), hbAge > 180 ? "bad" : hbAge > 90 ? "warn" : "ok");
  if (hb) {
    statusRow(hbCard, "Ran via", hb.via || "—");
    statusRow(hbCard, "That run", `${hb.filled ?? 0} filled · ${hb.failed ?? 0} failed`);
  }
  const hbNote = document.createElement("p");
  hbNote.className = "status-note";
  hbNote.textContent = "GitHub Actions fills every 30 min; a stale pulse wakes the cloud routine, the Supabase standby, then the Mac watchdog.";
  hbCard.appendChild(hbNote);
  wrap.appendChild(hbCard);

  const srcCard = statusCard("Sources today");
  const EXPECTED = ["The Real Deal", "Inman", "CRE Daily", "CRE Daily New York", "Traded", "Bisnow"];
  const tally = new Map();
  for (const s of day?.stories || []) {
    for (const src of s.sources || []) tally.set(src, (tally.get(src) || 0) + 1);
  }
  for (const name of EXPECTED) {
    const n = [...tally.entries()].filter(([k]) => k.includes(name)).reduce((sum, [, v]) => sum + v, 0);
    statusRow(srcCard, name, n ? `${n} ${n === 1 ? "story" : "stories"}` : "nothing today", n ? "" : "quiet");
  }
  for (const [k, v] of tally) {
    if (!EXPECTED.some((e) => k.includes(e))) statusRow(srcCard, k, `${v} ${v === 1 ? "story" : "stories"}`);
  }
  wrap.appendChild(srcCard);

  const sysCard = statusCard("Sessions & rates");
  for (const [id, label] of [["conn_therealdeal.com", "The Real Deal login"], ["conn_bisnow.com", "Bisnow login"]]) {
    const row = connMeta.find((r) => r.id === id);
    const at = row?.data?.savedAt;
    const needs = row?.data?.needsReconnect;
    // neutral tone on purpose: a stored cookie is NOT proof content is fetching.
    // Most subscriber articles ship full text without a login. Red only when the
    // pipeline actually detected a session-gated fetch failing (needsReconnect).
    statusRow(sysCard, label,
      needs ? "reconnect needed" : at ? `cookie saved ${fmtAge(ageMin(at))}` : "not stored",
      needs ? "bad" : at && ageMin(at) / 1440 > 60 ? "warn" : "");
  }
  const sNote = document.createElement("p");
  sNote.className = "status-note";
  sNote.textContent = "A stored login isn't a guarantee of coverage — most subscriber articles ship their full text without one. TRD Data pages are a separate paid tier no login unlocks; they read at source. Watch \"Full text in-app\" above for the real picture.";
  sysCard.appendChild(sNote);
  const rAge = ageMin(ratesAt);
  statusRow(sysCard, "Rates cache", fmtAge(rAge), rAge > 120 ? "warn" : "ok");
  wrap.appendChild(sysCard);

  // This device — confirms which app version is actually running (cache check)
  // and whether iOS will let this install hand a file to Messages.
  const devCard = statusCard("This device");
  const cap = shareCapabilities();
  statusRow(devCard, "App version", cap.version);
  statusRow(devCard, "Installed app", cap.standalone ? "yes (home screen)" : "no (browser tab)");
  statusRow(devCard, "Web Share", cap.hasShare ? "yes" : "no", cap.hasShare ? "ok" : "warn");
  statusRow(devCard, "Share image directly", cap.canShareFiles ? "yes" : "no",
    cap.canShareFiles ? "ok" : "warn");
  if (!cap.canShareFiles) {
    const note = document.createElement("p");
    note.className = "status-note";
    note.textContent = "This install can't push an image straight into the share sheet (an iOS limitation), so Share opens the card viewer instead.";
    devCard.appendChild(note);
  }
  wrap.appendChild(devCard);
}

/* ---------- alerts: web push + following (Phase 4) ----------
   Server side: push-send / push-dispatch edge functions + pg_cron. This side:
   subscribe the device, keep per-profile toggles and the watchlist in prefs,
   read the device-local inbox the service worker writes. */

const ALERTS_SEEN_KEY = "briefing_alerts_seen";

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function urlB64ToUint8Array(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function vapidPublicKey() {
  try {
    const rows = await sb("secrets?id=eq.vapid&select=data");
    if (rows[0]?.data?.publicKeyB64) return rows[0].data.publicKeyB64;
  } catch { /* fall through to setup */ }
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/push-send?setup=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    return (await res.json()).publicKeyB64 || null;
  } catch { return null; }
}

async function currentPushSub() {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch { return null; }
}

async function savePushSub(subJson, disabled) {
  await fetch(`${SUPABASE_URL}/rest/v1/push_subs`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
               "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      id: subJson.endpoint,
      profile: profile.slug,
      sub: disabled ? { ...subJson, disabled: true } : subJson,
    }),
  });
}

async function enableAlerts() {
  if (profile.guest) { flashToast("Guest can't get alerts — pick a reader"); return false; }
  if (!pushSupported()) { flashToast("Add the app to your Home Screen first"); return false; }
  let perm = Notification.permission;
  if (perm !== "granted") perm = await Notification.requestPermission();
  if (perm !== "granted") { flashToast("Notifications are blocked — allow them in Settings"); return false; }
  const key = await vapidPublicKey();
  if (!key) { flashToast("Couldn't reach the alert server"); return false; }
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(key),
      });
    }
    await savePushSub(sub.toJSON(), false);
    flashToast(`Alerts on for ${profile.name}`);
    return true;
  } catch {
    flashToast("Couldn't subscribe this device");
    return false;
  }
}

async function disableAlerts() {
  const sub = await currentPushSub();
  if (sub) {
    try { await savePushSub(sub.toJSON(), true); } catch { /* row stays; sender skips disabled */ }
    try { await sub.unsubscribe(); } catch { /* ignore */ }
  }
  flashToast("Alerts off on this device");
}

/* following — watched players live in the profile's prefs */
function watchedPlayers() { return pref("watchPlayers", []); }
function isWatched(slug) { return watchedPlayers().includes(slug); }
function toggleWatch(slug) {
  const list = [...watchedPlayers()];
  const i = list.indexOf(slug);
  if (i >= 0) list.splice(i, 1);
  else list.push(slug);
  setPref("watchPlayers", list);
  return i < 0;
}

function watchStar(slug, name) {
  const el = document.createElement("span");
  el.className = "watch-star" + (isWatched(slug) ? " on" : "");
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", "Follow");
  el.textContent = isWatched(slug) ? "★" : "☆";
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const now = toggleWatch(slug);
    el.classList.toggle("on", now);
    el.textContent = now ? "★" : "☆";
    flashToast(now ? `Following ${name} — you'll be alerted when they appear` : `Unfollowed ${name}`);
  });
  return el;
}

/* the device-local inbox the service worker fills on each push */
function readAlertsInbox() {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open("briefing-alerts", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("inbox", { keyPath: "at" });
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction("inbox", "readonly");
          const r = tx.objectStore("inbox").getAll();
          r.onsuccess = () => resolve((r.result || []).sort((a, b) => b.at.localeCompare(a.at)));
          r.onerror = () => resolve([]);
        } catch { resolve([]); }
      };
      open.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

async function paintBellDot() {
  const dot = $("bell-dot");
  if (!dot) return;
  const inbox = await readAlertsInbox();
  let seen = "";
  try { seen = localStorage.getItem(ALERTS_SEEN_KEY) || ""; } catch { /* ignore */ }
  dot.hidden = !(inbox[0] && inbox[0].at > seen);
}

function alertToggleRow(card, label, sub, value, onChange) {
  const row = document.createElement("div");
  row.className = "alert-toggle";
  const text = document.createElement("span");
  text.className = "at-text";
  const l = document.createElement("span");
  l.className = "at-label";
  l.textContent = label;
  text.appendChild(l);
  if (sub) {
    const s = document.createElement("span");
    s.className = "at-sub";
    s.textContent = sub;
    text.appendChild(s);
  }
  const sw = document.createElement("button");
  sw.className = "at-switch" + (value ? " on" : "");
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", String(value));
  sw.addEventListener("click", () => {
    const now = !sw.classList.contains("on");
    sw.classList.toggle("on", now);
    sw.setAttribute("aria-checked", String(now));
    onChange(now);
  });
  row.append(text, sw);
  card.appendChild(row);
}

async function renderAlerts() {
  const wrap = $("alerts-content");
  wrap.innerHTML = "";

  const head = document.createElement("div");
  head.className = "status-head";
  head.innerHTML = `<h2>Alerts</h2><p>Lock-screen notifications from your briefing — only for what you choose. Quiet overnight (9 PM–7 AM).</p>`;
  wrap.appendChild(head);

  // this device
  const devCard = statusCard("This device");
  const sub = await currentPushSub();
  statusRow(devCard, "Notifications", sub ? "on" : "off", sub ? "ok" : "quiet");
  const devBtn = document.createElement("button");
  devBtn.className = "profile-go alert-enable";
  devBtn.textContent = sub ? "Turn off on this device" : "Enable alerts on this device";
  devBtn.addEventListener("click", async () => {
    devBtn.disabled = true;
    if (sub) await disableAlerts();
    else await enableAlerts();
    renderAlerts();
  });
  devCard.appendChild(devBtn);
  if (!pushSupported()) {
    const note = document.createElement("p");
    note.className = "status-note";
    note.textContent = "Alerts need the app installed on your Home Screen (iOS 16.4+): Share → Add to Home Screen.";
    devCard.appendChild(note);
  }
  wrap.appendChild(devCard);

  // what gets sent (per reader profile, synced across devices)
  const n = pref("notifications", {});
  const sendCard = statusCard(`What ${profile.guest ? "guests" : profile.name} gets`);
  alertToggleRow(sendCard, "Breaking news", "special-edition stories, as they publish",
    n.breaking !== false, (v) => setPref("notifications", { ...pref("notifications", {}), breaking: v }));
  alertToggleRow(sendCard, "People I follow", "a watched player appears in the briefing",
    n.watch !== false, (v) => setPref("notifications", { ...pref("notifications", {}), watch: v }));
  alertToggleRow(sendCard, "Morning: briefing is ready", "one push when the first edition lands",
    n.ready === true, (v) => setPref("notifications", { ...pref("notifications", {}), ready: v }));
  const evNote = document.createElement("p");
  evNote.className = "status-note";
  evNote.innerHTML = "Starred calendar events remind you the morning they happen — starring is the opt-in. ";
  const calLink = document.createElement("a");
  calLink.href = "#/calendar";
  calLink.className = "inline-link";
  calLink.textContent = "Open the calendar →";
  evNote.appendChild(calLink);
  sendCard.appendChild(evNote);
  wrap.appendChild(sendCard);

  // following
  const folCard = statusCard("Following");
  const watched = watchedPlayers();
  if (watched.length) {
    const players = await getPlayers();
    const list = document.createElement("div");
    list.className = "follow-list";
    for (const slug of watched) {
      const p = players.get(slug);
      const chipEl = document.createElement("button");
      chipEl.className = "follow-chip";
      const nm = document.createElement("span");
      nm.textContent = p?.name || slug;
      nm.addEventListener("click", () => { location.hash = `/player/${slug}`; });
      const x = document.createElement("span");
      x.className = "follow-x";
      x.textContent = "✕";
      x.addEventListener("click", (e) => { e.stopPropagation(); toggleWatch(slug); renderAlerts(); });
      chipEl.append(nm, x);
      list.appendChild(chipEl);
    }
    folCard.appendChild(list);
  } else {
    const empty = document.createElement("p");
    empty.className = "status-note";
    empty.textContent = "Star ☆ a player on their profile (or their pop-up card) to follow them — you'll be alerted whenever they appear in coverage.";
    folCard.appendChild(empty);
  }
  wrap.appendChild(folCard);

  // recent alerts (this device)
  const inCard = statusCard("Recent alerts");
  const inbox = await readAlertsInbox();
  if (inbox.length) {
    for (const entry of inbox.slice(0, 15)) {
      const row = document.createElement("button");
      row.className = "sheet-mention";
      const d = document.createElement("span");
      d.className = "sm-date";
      d.textContent = new Date(entry.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const t = document.createElement("span");
      t.className = "sm-title";
      t.textContent = entry.title + (entry.body ? ` — ${entry.body}` : "");
      row.append(d, t);
      row.addEventListener("click", () => {
        const h = (entry.url || "").split("#")[1];
        if (h) location.hash = h;
      });
      inCard.appendChild(row);
    }
  } else {
    const empty = document.createElement("p");
    empty.className = "status-note";
    empty.textContent = "Notifications you receive on this device collect here.";
    inCard.appendChild(empty);
  }
  wrap.appendChild(inCard);

  try { if (inbox[0]) localStorage.setItem(ALERTS_SEEN_KEY, inbox[0].at); } catch { /* ignore */ }
  paintBellDot();
}

/* ---------- boot ---------- */

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Remembered, unlocked devices go straight to their reader; everything else
   (first visit, or a lock via the masthead monogram) goes through the picker,
   where each profile's own passcode gates entry. */
function bootApp() {
  const slug = rememberedProfile();
  if (slug && !isLocked()) activateProfile(slug).catch(() => {}).then(init);
  else showProfilePicker(true);
}

bootApp();
