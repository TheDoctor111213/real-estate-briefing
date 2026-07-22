# Real Estate News Briefing

A web app that compiles Matthew's real estate newsletters into a daily briefing with an in-app reader, deal map, weekly summary, players roster (accumulating people/company dossiers), a dictionary of jargon/concepts, and a history archive.
Static site (no build step): `index.html` + `css/style.css` + `js/app.js`, pipeline helpers in `scripts/`. Leaflet (CDN) powers the map.

- **Hosting**: GitHub Pages, custom domain `briefing.pierrepontcompanies.com` (`CNAME` file). Deploys happen only when app code changes — data never requires a deploy. **To ship js/css changes, run `scripts/deploy.sh "what changed"`** — it bumps the version in every spot that needs it (`APP_VERSION` in `js/app.js`, the `?v=` on css/js/manifest/sw-register in `index.html`, and `VERSION` + shell-asset `?v=` in `sw.js`), sanity-checks the JS, then commits and pushes. Keeping those in lockstep is what stops cached pages pairing old code with new data shapes. The installed app then auto-updates: its service worker reloads the page as soon as the new version activates (checked on every open/focus), so users don't need to manually relaunch. GitHub Pages takes ~1–2 min to serve the new files after the push.
- **Data**: Supabase project `uhwdnmbxiopfysodydty` (org ptxdileqdzaovbezrplg) — tables `days` (pk `date`, `data` jsonb, `generated_at`), `weeks` (pk `week_of`, `data` jsonb, `generated_at`), `players` (pk `slug`, `data` jsonb, `updated_at`), and `terms` (pk `slug`, `data` jsonb, `updated_at`). RLS is open read AND open write on the publishable key (owner's accepted tradeoff, single-user app); DELETE is revoked at the DB level on all four tables. The app reads it live via PostgREST.
- **Local dev**: the `briefing` config in `.claude/launch.json` (python3 http.server, port 8420) — the app reads Supabase either way. `data/` holds the pipeline's working JSON files and is gitignored (also keeps subscriber-only article text out of the public repo).

## Architecture

1. Scheduled cloud routines on claude.ai (windows: 7:30, 8:00, 8:30, 9:00, 10:00 AM, 12:00, 2:00, 4:00 PM ET; hardware-independent — they run in Anthropic's cloud against this repo) read the day's real estate newsletters from Gmail, synthesizes ONE deduped story list, fetches full article text, geocodes deal locations, writes `data/YYYY-MM-DD.json`, updates the rolling week file `data/weeks/<monday>.json`, maintains `data/index.json` (`{dates: [], weeks: []}`), then **publishes with `python3 scripts/push_data.py`** (upserts days + weeks + players + terms + threads + events + metrics to Supabase). Runs are idempotent: each rebuilds today's file from ALL of today's emails (`after:` today, America/New_York — not `newer_than:1d`), keeping existing story ids stable.
2. The app has six hash-routed views — Briefing (`#/day/DATE`), Map (`#/map`), Weekly (`#/weekly`), Players (`#/players`, profiles at `#/player/SLUG`), Dictionary (`#/dictionary`, entries at `#/term/SLUG`), Rates (`#/rates`) — plus History (`#/history`, reached by tapping the masthead date, not a tab) and a full-screen reader overlay (`#/story/DATE/ID`). A masthead refresh button (and auto-refetch every 10 min / on tab focus) re-queries Supabase and re-renders when `generatedAt` changes; pulling NEW emails always happens through a task run, not the page.

## Newsletter sources (Gmail senders)

- Inman — `select@inman.com` (Morning Headlines) and `headlines@inman.com` (Afternoon Headlines / Newsflash), both daily
- CRE Daily — `mail@news.credaily.com` (daily; often carries full story text in the email)
- CRE Daily New York — `mail@newyork.credaily.com` (daily)
- The Real Deal — `elerts@e.therealdeal.com` (mix of daily elerts, weekly recaps, and special/breaking blasts)
- Traded — senders on BOTH `traded.co` and `tradedmedia.co` (e.g. `hello@tradedmedia.co`); search both domains (National digest ~2×/week; treat regular editions as `daily` cadence). Traded editions are lists of individual closings/listings — each deal (address, price, buyer/seller/broker) becomes its own story with a precise `locations` pin; these are the best map content we get. Group them under a market-level `section` (New York, National, ...) and don't mark routine deal items `featured` unless one is genuinely headline-scale.
- Bisnow — senders on `bisnow.com` (search the domain; they mail from subdomains). The owner subscribes to MANY Bisnow newsletters — most asset classes, most of NYC, Philadelphia, and DC — with mixed cadence (daily / weekly / biweekly / occasional). These are volume feeds: apply the story budget and market tiers (step 4) hard — most Bisnow items belong in `brief` one-liners, the record layer, or as corroboration merged into existing stories, NOT as new full stories. Bisnow articles fetch free (no hard paywall observed); if some content turns out gated, a session cookie can be stored with `python3 scripts/trd_session.py --cookie --domain bisnow.com`. Skip their event promos and sponsored/"Studio B" content entirely.
  - **Bisnow URLs — use the real email link, NEVER fabricate one.** Bisnow's HTML wraps every article in an `a-prod.bisnow.io/s/<hex-id>` short-link (e.g. `a-prod.bisnow.io/s/6a5aa4956aed4`) that 302-redirects to the real `bisnow.com/<market>/news/<category>/<slug>-<id>` article — copy that short-link verbatim as the story's `url` (the fill loop follows the redirect and stores the canonical page). **The `<id>` is always lowercase hex.** A descriptive slug like `a-prod.bisnow.io/s/philly-centre-square-cancel` is NOT a real short-link — inventing one 404s forever, and `fetch_article.is_fabricated_bisnow_shortlink` now hard-rejects it and drops the url (the app then shows the story summary-only). If you can't find the real short-link in the email for a given item, take its canonical `bisnow.com/...` article URL if one appears, else leave `url` unset — **never mint a `/s/<slug>`.**

Also include any other newsletter that is clearly real-estate news. Skip welcome/confirmation emails, job alerts, meetup blasts, and promotional one-offs.

## Daily update procedure (for the scheduled task)

1. Search Gmail: `from:(select@inman.com OR headlines@inman.com OR mail@news.credaily.com OR mail@newyork.credaily.com OR elerts@e.therealdeal.com OR traded.co OR tradedmedia.co OR bisnow.com) after:<today>` — plus a broader pass for other real-estate newsletters received today (America/New_York).
2. For each newsletter, get the message and extract stories from the HTML body. **Never construct or guess an article URL** — a story's `url` must be a link that actually appears in the email (decoded from its tracking wrapper). When a roundup item has no individual link (TRD "top deals" digests list several closings under one article), every story split out of it gets the ROUNDUP's own URL — a guessed per-address slug 404s and poisons the fill loop. Large bodies get saved to a tool-results file; parse with python (`html.parser`), never by reading raw HTML into context. Tracking links like `link.therealdeal.com/click/<id>/<base64>` decode via urlsafe-base64 (pad with `=`) to the real article URL — strip query params.
   - **CRE Daily / CRE Daily New York (beehiiv) — use the PLAINTEXT for real URLs.** These newsletters rewrite every article link in the HTML body to an opaque `link.mail.beehiiv.com` tracking wrapper that can NOT be decoded and is Cloudflare-walled (so it can't be fetched or resolved server-side). But the message's **plaintext part** (`plaintextBody` / `text/plain`) carries the REAL destination URLs as `[label](https://real-publisher-url): blurb` markdown. Parse those and take each story's canonical `url` from the plaintext link — strip `utm_*` / `_bhlid` query params. Match each story to its markdown item by the blurb/label text. This is what surfaces CRE Daily's *root sources* (it's a partial aggregator: items link to credaily.com's own articles AND to CommercialSearch, Multi-Housing News, Bisnow, Commercial Observer, GlobeSt, Connect CRE, CoStar, AltsWire, WSJ, …). The real URL is what drives correct publisher crediting (step 6) and lets `fill_content.py` fetch the actual site. **Caveat:** the plaintext doesn't always list every secondary blurb — if a story has no plaintext markdown link, keep its beehiiv href as `url`; `fill_content.py` will flag it `sourceBlocked` and the app makes it a tap-through (only a real browser can follow those, which the routine can't do).
3. **Classify cadence** per newsletter edition: `daily` (regular daily edition), `weekly` (weekly recap/digest), or `special` (breaking-news or one-off themed blast). Every story inherits its newsletter's cadence.
4. **Synthesize & rank.** The reader's time is fixed; input volume is not. As sources grow, **input scales, output doesn't** — more newsletters must produce *better-corroborated* stories, never more of them.
   - **Merge, don't multiply.** Dedupe into ONE story list: the same story in N newsletters → one entry, every outlet in `sources`. Corroboration is a ranking signal (a story three desks covered outranks a similar one desk covered); take each fact from the best version and prefer the most authoritative numbers. When outlets' versions genuinely differ, record the extra takes in the story's `coverage` array (schema below): the main `content`/`url`/`publisher` hold the PRIMARY version (fullest text, most authoritative outlet), and each other outlet contributes `{publisher, url, title, content|null, note}` — `note` is a ≤10-word phrase for what that version adds ("adds construction financing details"), null when it's just the same story. The app renders these as "Also covered by" rows in the reader.
   - **Weekly/biweekly digests merge, never multiply.** A weekly-recap item matching a story from the past week adds its outlet to that story's `sources`/`coverage` (and updates numbers if newer) — it does NOT create a new story. Weeklies exist to fill gaps we missed and to corroborate.
   - **Story budget: ~30 full stories/day** (thinner early in the day is fine — later runs keep adding as editions arrive). Everything newsworthy beyond the budget becomes a one-liner: set `brief: true` and give it only `title`, `summary` (one short sentence), classification fields, `url`, `locations`, `valueUsd` — no featured, no explainer. The app shows briefs as an "Also today" strip at the feed's bottom; they still feed the map, ledger, and players. **Brief compresses the FEED treatment, not the reader**: the fill loop fetches article text for briefs like any story, and the app opens them as full reader pages — so always give a brief its real `url`. Routine digest closings (small Traded/Bisnow items), minor leases, and watch-tier markets' day-to-day deals belong here.
   - **Market tiers** (the reader is a New York investor):
     - **Core — New York:** full story treatment at normal thresholds.
     - **Watch — Tristate (NJ/CT) and Philadelphia:** stories only when genuinely significant (scale, distress, precedent); their routine transactions → `brief` or record-only.
     - **Policy-only — Washington DC:** the DC newsletters matter for policy/regulatory news that impacts other markets, NOT for DC's day-to-day deal flow. Skip routine DC transactions entirely (not even a brief) — except genuinely headline-scale ones (a White House-adjacent trophy trade, a national-record deal).
     - **Guardrail:** these tiers must never suppress genuinely important deals from ANY city — a $500M Chicago tower sale or a landmark Miami distress still makes the main feed on its own merits. Tiers demote the routine, not the significant.
   Assign each story a short reusable `section` (New York, Capital Markets, Residential, Development, Policy, Tech, ...). Then **rank the day's stories by importance** — this single ranking drives Top Stories, the overview's lead, and the key points, so all three always agree on what matters. Judge importance in this priority order:
   1. **Systemic significance** — does it signal or move a market-wide trend (a rate/credit shift, a distress wave, a sector-reshaping policy, major consolidation)? A story that changes how a whole market behaves outranks a bigger one-off deal.
   2. **Scale & irreversibility** — dollars / square footage / market share at stake, and permanent structural change (a law, bankruptcy, merger) over a routine transaction.
   3. **Breadth** — national or sector-defining over single-asset.
   4. **Novelty** — a genuine new development over an incremental update or a routine listing.
   5. **Continuity** — meaningfully advances a running arc the reader is tracking.
   Mark the top **3–5** `featured: true` — these ARE the app's "Top Stories." A splashy but minor item (a celebrity home sale, a routine Traded closing, a land purchase that's only interesting as trend-color) does NOT get featured just because it's eye-catching. (See Writing style: the overview and keyPoints must anchor to this same top set.)
5. **Classify** every story for the app's filters, chips, and map icons — all four fields, consistently:
   - `dealType` — exactly one of: `Sale`, `Financing`, `Lease`, `Development`, `Distress`, `Legal`, `Policy`, `Industry`, `Markets`. Pick the story's dominant nature (a bankruptcy-driven sale → Distress; a lawsuit → Legal; company/people/tech news → Industry; data/trend pieces → Markets).
   - `assetClass` — `Multifamily`, `Office`, `Retail`, `Industrial`, `Hotel`, `Residential` (single-family/condo/luxury homes), `Mixed-Use`, `Land`, or `null` when not asset-specific.
   - `market` — short reusable metro/region label. Reuse existing ones before inventing: New York, Los Angeles, SF Bay Area, South Florida, Texas, DFW, Chicago, Washington DC, Boston, New Jersey, Phoenix, Atlanta, Denver, Austin, San Diego, National.
   - `submarket` — OPTIONAL finer-grained neighborhood/submarket within the metro when stated or clearly inferable ("Brooklyn Heights", "Midtown", "Brickell", "Williamsburg"). This powers The Desk's by-market Comps drilling down to submarket level — where comps actually mean something (Cobble Hill ≠ Park Slope even though both are Brooklyn). Capture it whenever the deal names a neighborhood; omit when only the metro is known. Keep labels clean and reusable. **`market` = where the real estate is, not where the story "feels" like it belongs.** `National` is reserved for stories with genuinely no single geography: federal policy/regulators, nationwide lawsuits or company/industry news with no single asset, national data prints (rent/vacancy/sales indices), REIT- or company-level M&A. Any story about a specific property, site, portfolio-in-one-metro, or named project — even inside a sector-trend piece — gets that metro (invent a clean label when needed: "Louisiana", "Nashville", "Bahamas"→International). Real estate transactions are almost never National.
   - `valueUsd` — the single deal size in dollars as a plain number (e.g. 81400000); `null` when there is no single figure (permit recaps, roundups, policy pieces).
   - `capRate` / `noi` — for income-producing sales, capture the deal's **cap rate** when the article states it (plain percent number, e.g. `5.5` for 5.5%), and/or its **`noi`** (annual net operating income, plain dollars) when stated. The Desk builds market-level cap-rate medians from these — using a stated `capRate` directly, or computing `noi / valueUsd` when both are present. This is the single most valuable returns metric for the reader (a NY investor lives on cap rates), so capture it diligently whenever coverage gives a cap rate OR an NOI — both are cited constantly in CRE deal coverage. Omit for non-income deals (raw land, development sites, homes) and when neither is stated.
   - `sizeSqft` / `units` — the deal's size when a single clear figure is stated: square footage (office / retail / industrial / mixed-use) or unit count (multifamily / residential apartments; hotel keys/rooms count as `units`). Plain numbers; omit either when not stated. The app derives a `$/sf` or `$/unit` chip from these plus `valueUsd` (it prefers `$/unit` when `units` is present). **Capture these diligently on EVERY priced deal — they power The Desk's Comps medians ($/sf, $/unit by market and asset), which is a headline feature that sharpens with every sized deal.** Traded/permit closings almost always state a size ("258-unit", "260,000-square-foot", "117-key"); pull it. **Use the DEAL's own size, never an aspirational or portfolio-total figure** (e.g. Ian Jacobs "targeting 3M sf of SF retail" is NOT the size of his one $48.5M/180-Post-St purchase; a $218M phase-3 financing for 273 units is 273, not the 2,600-unit master plan). If the size is ambiguous or refers to something other than the transacted asset, omit it — a wrong size poisons the comp medians.
5. **Geocode**: for stories tied to identifiable places (a property, site, submarket, or city), add `locations: [{label, lat, lng}]` — approximate coordinates from knowledge are fine (city/neighborhood precision; a specific address if confident). Stories with no meaningful geography (national policy, earnings, data prints) get `locations: []`. **Every story whose `market` is a metro/region MUST carry at least one pin** — a regional story with `locations: []` is a bug. A trend piece anchored on one or two named projects should pin those projects even if the theme is national.
6. **Reader content** per story, in order of preference: (a) full story text extracted from the email body itself when the newsletter carries it (CRE Daily often does) — include `<figure>/<img>/<figcaption>`; (b) `python3 scripts/fetch_article.py <url>` → JSON `{ok, title, image, html, words}`; if `ok`, use `html` as `content` and `image` as hero; (c) neither → `content: null` for now — step 7b's `fill_content.py` will loop back and fetch it deterministically, so you don't have to fetch every story inline here; you just have to run that step.
   - **Credit the real publisher.** When a newsletter item is a pointer to another outlet's article (CRE Daily roundups constantly do this — the blurb says "per CommercialSearch", "via Multi-Housing News", "The Wall Street Journal reports"), set the story's `publisher` to that outlet's name. The app credits `publisher` first, then the resolved article-URL domain, then the newsletter — so a reroute is attributed correctly even when its link is a `beehiiv`/Mailchimp wrapper that couldn't be resolved. Leave `publisher` unset when the newsletter is itself the publisher (its own credaily.com/therealdeal.com/inman.com article).
   - **fetch_article.py fetches through a fallback chain**: direct HTTP first, then the Supabase `fetch-proxy` edge function when the direct fetch fails, times out, hits a bot wall, or the run environment's egress is blocked (cloud runs). The proxy fetches from Supabase's network (always reachable), follows redirects (Traded's `us.list-manage.com` links resolve to `traded.co`), and forwards the TRD cookie. This is why article fetches succeed in the cloud even though direct egress to news sites is blocked. Inman and The Real Deal both use client-side (Piano) paywalls — the full article ships in the page HTML, so no login is needed once the page is fetched; Inman just also sits behind Cloudflare, which the proxy's clean egress IP passes.
   - **The Real Deal (subscriber articles)**: fetch_article.py automatically sends the owner's TRD session cookie (stored in the Supabase `secrets` table, row `trd_session`). TRD's reader site is Next.js with its own (non-WordPress) login, so the session is captured by the owner pasting their browser cookie header into `python3 scripts/trd_session.py --cookie` — the pipeline never sees a password. If a therealdeal.com fetch returns `paywalled: true`, the session has expired: still write the story with `content: null`, and say in the day's `notes` that the TRD session needs a refresh (`python3 scripts/trd_session.py --cookie`).
7. Write `data/YYYY-MM-DD.json` (schema below). Create the `data/` directory if it doesn't exist. (`data/index.json` is a legacy local-dev artifact — ignore it if absent; the app reads Supabase, not files.)
7b. **Reader content is filled by the GitHub Actions heartbeat — you don't need working egress.** A scheduled workflow (`.github/workflows/fill-content.yml`, every 30 min) runs `scripts/fill_browser.py` on GitHub's runners: a REAL headless browser (Playwright) that fetches every story still missing content, passes Cloudflare JS challenges, resolves tracking-link redirects to canonical publisher URLs, and republishes the day. So: write each story's `url` (and any content available in the email body itself) and move on — text you can't fetch will fill itself within ~30 minutes. If your sandbox happens to have egress, you MAY still run `python3 scripts/fill_content.py <date> --no-push` as a fast first pass; its failures are expected and non-fatal when egress is blocked (do not spend run time retrying).
   - **Failover duty (every run):** the fillers write a pulse to the Supabase `secrets` row `fill_heartbeat` on every run (`GET <SUPABASE_URL>/rest/v1/secrets?id=eq.fill_heartbeat&select=data`). Check its `lastRun`: if it is **more than 90 minutes old**, the GitHub Actions heartbeat is down — then (a) attempt `python3 scripts/fill_content.py <date>` yourself even if egress previously failed, and (b) record in the day's `notes`: "content heartbeat stale since <time> — GitHub Actions filler may be down" so the owner sees it in the app. (Two more layers also watch this pulse: the `fill-content` Supabase edge function — a pg_cron standby every 15 min that HTTP-fills when the pulse is stale — and a Mac-side watchdog that adds a local headless-browser pass. Your note is the owner's cross-check.) If the pulse is fresh, content-filling needs nothing from you. This is the reliability backstop for step 6: a plain code loop over **every** story that fetches full article text for any still missing it (`content: null` or under ~120 words) via `fetch_article.py` (direct → Supabase proxy → TRD cookie). Fetching articles is therefore **not** a per-story judgment call you can partially skip — this loop guarantees each story is attempted. It is idempotent (stories that already have content are left alone), throttled with one retry pass so tracking-link hosts (beehiiv/Mailchimp) don't rate-limit the batch, and any story that fails transiently is retried automatically on the **next** scheduled window — so coverage self-heals without manual steps. Read its `SUMMARY:` line: if it reports persistent `failed` ids or `TRD-paywalled`, fold that into the day's `notes` (for TRD, refresh the session with `python3 scripts/trd_session.py --cookie`). `--no-push` fills only the local file; step 12's `push_data.py` publishes it.
8. **Weekly rollup**: compute the week's Monday. Rewrite `data/weeks/<monday>.json` synthesizing ALL of that week's days so far (schema below) — synthesize across days, don't just concatenate. **In a fresh checkout (cloud runs) the earlier day files won't exist locally** — fetch them from Supabase instead: `GET <SUPABASE_URL>/rest/v1/days?date=gte.<monday>&date=lte.<today>&select=data` with the `apikey` header, using the URL and key found in `scripts/push_data.py`.
9. **Players roster**: maintain the persistent people/companies dossier set behind the app's Players tab. Fetch the current roster from Supabase (`GET <SUPABASE_URL>/rest/v1/players?select=slug,data` with the `apikey` header), merge today's stories into it, write the complete result to `data/players.json` (schema below). Curation rules — these keep the roster valuable instead of unwieldy:
   - **Who gets a profile.** People: only when a story is substantially *about* them (protagonist of a deal, fund event, lawsuit, interview, appointment). Companies: story subject, or a named principal (buyer / seller / developer / lender / borrower / landlord) in a deal ≥ $25M or a lease ≥ 100K sf.
   - **Who waits in `_candidates`.** Names appearing only as deal-party credits in digest items (Traded blurbs, permit recaps) — brokers, small-deal principals, execs named beside their firm — get a tally in the `_candidates` row instead of a profile. Promote to a full profile on the **second** sighting (any size), then remove the ledger entry.
   - **Who never enters.** Celebrities/athletes/entertainers in personal-home deals, private individuals buying homes, tenants/occupiers acting purely as space users (profile the landlord, not the tenant), reporters, quoted analysts.
   - **Updating an existing profile.** Append today's mention(s) newest-first — the full mention history is kept forever, never trimmed. Update `stats` (`dealVolumeUsd` sums `valueUsd` only where the entity was a transaction principal, not a mere story subject), extend `markets`/`assetClasses`, refresh `lastSeen`. Rewrite `profile`/`tagline` only when today's news meaningfully changes the picture; otherwise leave the prose alone.
   - **Mention `role` is a REAL-ESTATE transaction role — reserve `buyer`/`seller`/`lender`/`borrower`/`developer`/`landlord`/`tenant`/`broker` for a party to an actual property deal (a purchase, loan, lease, ground-up, refinancing).** These feed the app's League Tables ("most-active buyers/lenders/developers…"), so a non-property event must NOT borrow a transaction role. A company acquiring another company, a brokerage, or a team of agents (industry M&A), a personnel hire, a lawsuit, an earnings print, or any story an entity is merely the *subject* of → `role: "subject"`, never `buyer`/`seller`. (E.g. Keller Williams acquiring a 1,200-agent group is `subject`, not `buyer` — no real estate changed hands.) When unsure whether an entity was a deal principal, use `subject`.
   - **Profiles are permanent.** Never delete a profile, a mention, or a `_candidates` tally (the only removal ever allowed is a candidate's ledger entry at the moment it's promoted to a full profile). Dormant entities are not cleaned up — the app's recency-weighted ranking simply sinks them, and search still finds them. The database also enforces this: the publishable key has no DELETE permission on `players` (or `days`/`weeks`/`rates`).
   - **One slug per entity, forever.** Check for aliases before creating (e.g. "Blackstone" vs "Blackstone Group"; people by full name). Never re-slug.
   - **Aliases** (`aliases` field): short alternate names the app auto-links wherever they appear in prose (summaries, articles, dossiers) — e.g. "NAR", "Elliman", "Brookfield", "Oren Alexander". Add them when an entity is commonly referenced by a shorter or different name. Keep them unambiguous and case-exact: never a common English word, never something that could be a different entity. (People with simple two-word names get bare-surname linking automatically — no alias needed for that.)
   - **Profile image** (`image` field): **avatars are now filled automatically — you normally do nothing.** A daily GitHub Actions job (`.github/workflows/player-images.yml`) runs `scripts/backfill_player_images.py` on GitHub's runners (UNRESTRICTED egress — so CBRE/Hines/Newmark and other sites the cloud sandbox can't resolve fill cleanly), sourcing a logo/headshot for every roster entry still missing one and re-hosting it in the `player-images` bucket. It is idempotent (only null-image players are touched) and self-heals new entries within a day. The script gathers several candidates per entity — **companies:** the site's `apple-touch-icon` (best), `unavatar.io/<domain>`, the largest declared favicon, then Google `s2` @256 last — and keeps the best that passes a real quality gate: it decodes the image's **pixel dimensions** (no PIL) and rejects anything not square-ish (aspect ≤ 1.6) or under 64px or under 350 bytes, which is what stops the blank-favicon-on-a-white-tile failure. **People are CURATED ONLY (`PEOPLE_WIKI`)** — it never name-searches Wikipedia, because a namesake's face is worse than a monogram; add a person only after confirming the exact page title (e.g. the Citadel founder is `Kenneth C. Griffin`, not `Ken Griffin`, which is a different person). To fill immediately or after adding a domain: `python3 scripts/backfill_player_images.py` (or `--slug <slug> …`, `--all` to re-source, `--dry-run` to preview). Add the entity's domain to `COMPANY_DOMAINS` when the name doesn't guess to its real domain (e.g. Newmark is `nmrk.com`). Manual order of preference if sourcing by hand:
     1. Companies: `https://unavatar.io/<domain>?fallback=false` (best), else `https://www.google.com/s2/favicons?domain=<their domain>&sz=128` — verify with `curl -sL` HTTP 200. Find the real domain first (a web search is fine — e.g. Lift Partners is liftrp.com, not liftpartners.com). **Prefer unavatar: plain Google favicons are often blank white on the app's white avatar tile.**
     2. People: the Wikipedia thumbnail from `https://en.wikipedia.org/api/rest_v1/page/summary/<Title>` ONLY after checking the page description actually matches this person (namesakes are common).
     3. People/companies with no favicon or Wikipedia entry: find an official headshot or logo (the firm's own team/leadership page, the person's own site), download it, downscale to ≤400px, and **re-host it in the public `player-images` storage bucket** so it can never rot: `curl -X POST <SUPABASE_URL>/storage/v1/object/player-images/<slug>.<ext> -H "apikey: <key>" -H "Authorization: Bearer <key>" -H "Content-Type: image/<ext>" -H "x-upsert: true" --data-binary @file`, then store `<SUPABASE_URL>/storage/v1/object/public/player-images/<slug>.<ext>`. Never hotlink news-article or team-page photos directly — re-host them.
     `null` is always fine; the app renders an initials monogram. If `image` is null when an entity resurfaces, try again — a domain or team page may be identifiable from the new story.
10. **Dictionary**: maintain the persistent glossary behind the app's Dictionary tab. Fetch the current dictionary from Supabase (`GET <SUPABASE_URL>/rest/v1/terms?select=slug,data` with the `apikey` header), merge today's stories into it, write the complete result to `data/terms.json` (schema below). Curation rules:
    - **Who gets an entry.** Jargon or concepts a smart reader without real-estate background wouldn't know: deal/finance mechanics (cap rate, mezzanine debt, DSCR, CMBS, defeasance, 1031 exchange), legal/regulatory constructs (FARE Act, TOPA, Ellis Act eviction), industry-specific structures (syndication, ground lease, triple net, opportunity zone). Skip plain English and anything already self-explanatory in context.
    - **Who never enters.** Company/person names (that's the Players roster), plain financial terms a general-news reader already knows (mortgage, landlord, tenant), one-off proper nouns that won't recur.
    - **Updating an existing entry.** Append today's mention(s) newest-first — mention history is kept forever, never trimmed. Refresh `stats.lastSeen`/`mentions`. Rewrite `definition`/`shortDef` only if today's usage reveals the existing explanation is wrong or incomplete; otherwise leave the prose alone.
    - **Entries are permanent.** Never delete an entry or a mention — same DB-enforced guarantee as `players` (no DELETE grant on `terms`).
    - **One slug per concept, forever.** Check for aliases before creating (e.g. "Cap Rate" vs "Capitalization Rate"). Never re-slug.
    - **Aliases** (`aliases` field): alternate names/abbreviations the app auto-links wherever they appear in prose — e.g. "DSCR" for "Debt Service Coverage Ratio". Keep them unambiguous.
    - **Category** (`category` field): a short reusable label — Valuation & Returns, Financing & Debt, Legal & Regulatory, Deal Structures, Market Mechanics, Tax — reuse existing ones before inventing.
10b. **Threads**: maintain the persistent story-arc registry (cross-day continuity the app renders as timelines). Fetch current threads from Supabase (`GET <SUPABASE_URL>/rest/v1/threads?select=slug,data` with the `apikey` header), link today's stories, write the complete result to `data/threads.json` (schema below). Linking is strictly evidence-gated — **a thread is a shared concrete anchor, never a vibe**:
    - **The five valid anchors (the ONLY five):** (1) **same property/site** — same address or same pinned location; (2) **same transaction lifecycle** — announced → financed → closed → resold, same parties and asset; (3) **same legal case** — same litigation, same parties; (4) **same company/fund event** — ONE bankruptcy, ONE fund collapse, ONE merger (not "more news about the same company"); (5) **event → resolution** — a dated catalyst from the events registry (step 10c) and the story reporting its outcome.
    - **Banned as link bases:** thematic similarity ("both are office distress"), same sector, same market, same player appearing in unrelated deals. If the anchor can't be stated in one concrete phrase, the link does not exist. Precision over recall: a missed link is harmless, a false link poisons the feature.
    - Every entry carries `why` — the anchor phrase shown to the reader ("same property: 111 Wall St", "resolves: July 22 UCC auction"). If you can't write that phrase, don't link.
    - Create a thread only at the SECOND qualifying story (a thread of one is not a thread). When a thread is created or extended, set each linked story's `thread` field to the thread slug — including patching the earlier days' stories (refetch those days, set the field, re-push).
    - `status`: `active` until the arc concretely concludes (deal closed, case settled/dismissed, resolution reported) → `resolved`. Nothing else; the app derives dormancy from `lastSeen`.
    - Threads are permanent — never delete a thread or an entry; one slug per arc, forever (same no-DELETE guarantee as `players`).
10b-ii. **Canopies**: maintain the campaign registry — the layer *above* threads that groups several distinct threads (and loose stories) into ONE agenda the app renders as a trunk → branches → leaves tree (`#/campaign/SLUG`). Fetch current canopies (`GET <SUPABASE_URL>/rest/v1/campaigns?select=slug,data`), merge today's stories, write `data/campaigns.json` (schema below). This is where sibling initiatives that share no single thread-anchor but ARE one program belong (e.g. Mamdani's rent-freeze, pied-à-terre tax, and land-trust RFP are not one thread, but they are one housing agenda). **The gate — a canopy needs a bounded actor-driven program, never a theme. All three must pass:**
    1. **Named driver** — you can name the actor/coalition pushing it (a mayor, a regulator, a stated coalition, a firm executing a *stated* strategy). No nameable driver → it's a theme (banned). "Office distress" fails; "Mamdani's housing platform" passes.
    2. **Bounded mandate** — the program has articulated planks, not an open-ended market condition or sector. "Interest rates" / "the market" have no mandate → banned.
    3. **Coverage would say it** — a reporter would naturally write "another plank of X's agenda." If the strongest sentence you can write is "both are about NYC housing," it's a theme → reject.
    - **Banned exactly as threads are:** thematic similarity, same sector, same market, or the same player merely appearing in unrelated deals (five random Blackstone deals ≠ a canopy; Blackstone's *announced* $100B data-center platform with named acquisitions toward it = a canopy).
    - **Structure:** a canopy has `branches` (each either a registered `thread` slug, OR a set of loose `stories` that don't form a valid thread on their own) and optional `relatedThreads` (adjacent arcs shown but honestly labeled as NOT part of the agenda). Each branch carries a one-phrase `why` (the anchor that admits it to the trunk). A branch may hold a single story — the trunk supplies the context a lone thread would lack.
    - **`throughLine`** is the meaning layer: 2–4 sentences on why these fronts are one story, in the voice of the daily overview. This is the canopy's reason to exist — if you can't write it, there's no canopy.
    - Create a canopy at the SECOND qualifying branch (a trunk with one branch is just a thread). Canopies point *down* at stories/threads that already exist — you never write a `campaign` field onto stories or threads; membership lives only in the canopy's `branches`, so a canopy can be added or reworked without touching a single story. `status`: `active` until the whole agenda concludes → `resolved`. Permanent, append-only, one slug per agenda forever (same no-DELETE guarantee as `players`).
10c. **Calendar events**: maintain the events registry — **automatically compile EVERY concrete dated future event** mentioned in today's stories, no curation: auctions, court dates/trials, policy votes/deadlines/effective dates, Fed meetings, scheduled data releases, loan maturities with stated dates, scheduled groundbreakings/openings/closings. Fetch current events (`GET <SUPABASE_URL>/rest/v1/events?select=id,data`), merge, write `data/events.json` (schema below). Rules:
    - Only real dated events: a specific day, or an unambiguous month (store the 1st with `"approx": "month"`). Vague timing ("later this year", "expected soon") never enters.
    - `id` = `YYYY-MM-DD-short-kebab-title`. Check whether the same event already exists under a slightly different title before creating; a repeat mention appends to `announcedBy` instead of duplicating.
    - When a later story reports the outcome, set `resolvedBy` (`{day, id, outcome}` — outcome ≤20 words). An announced↔resolved pair is also thread anchor #5 (step 10b). Past events with no resolution stay as-is — silence is itself information.
    - Events are permanent, never deleted. (The day's `watch` array stays what it is — the 1–3 headline catalysts; the events registry is the exhaustive layer underneath.)
10d. **Metrics harvest**: capture every **industry metric a story cites** into the metrics ledger — the numbers the trade press quotes from the paid data shops: CMBS delinquency / special-servicing rates (Trepp), vacancy / absorption / asking rents (CBRE, JLL, Colliers, Cushman prints), price indices (Green Street CPPI, RCA/MSCI), cap-rate surveys, national rent indices (Zillow, Apartment List, Yardi), housing prints (Case-Shiller, NAR sales, MBA mortgage rates), lending-standards surveys (SLOOS). Fetch current metrics (`GET <SUPABASE_URL>/rest/v1/metrics?select=id,data`), merge, write `data/metrics.json` (schema below).
    - **Do NOT harvest from memory — run the surfacer.** `python3 scripts/scan_metrics.py <date>` mechanically lists EVERY sentence in today's stories that pairs a market figure (%, bps, index, $/sf, rent) with a recognised data source (Trepp/CBRE/Yardi/NAR/CoStar/Case-Shiller/Census/JLL/…). This is mandatory: the harvest was silently under-capturing when it depended on remembering to look. Work down its list and register each hit unless it's a single-deal figure. (Egress-blocked sandbox? the script only reads Supabase, which is always reachable — it will run.)
    - Only stated figures WITH an attributable source: "office CMBS delinquency hit 11.1%, per Trepp" → metric `cmbs-delinquency-office`, value 11.1, unit `%`, source Trepp. No figure or no source → skip.
    - **Register, don't skip.** The surfacer's job is recall; yours is the one judgment call per hit: is it a *recurring market-level series* (register it) or a *single-deal / one-off / hypothetical* figure (skip)? Recurring examples the routine has missed before and MUST catch: NAR pending-sales & median-price prints, MBA/CBRE/Colliers vacancy and rate prints, CoStar rent-to-income, market-level concessions. Skip: a single building's cap rate (that's `capRate`), a deal's price (`valueUsd`), novelty stats ("X employees could buy 29% of SF").
    - Skip single-deal numbers (that's `valueUsd`) and one-off anecdotes; this ledger is for recurring market-level series only.
    - One entry per metric slug, forever; append to `series` (skip exact duplicates of the same print). `asOf` = the period the figure describes when stated, else the story date. Scope geography/asset in the slug (`office-vacancy-manhattan`, `rent-growth-national`) — reuse existing slugs before inventing near-duplicates.
11. Validate all written files with `python3 -m json.tool`.
11b. **Collector checklist — do NOT skip (this is the step most often missed).** Steps 10b–10d are mandatory every run, not optional flourishes. Before publishing, confirm you actually built them this run: **threads** (`data/threads.json` — did any story concretely link to another, same property/case/company-event? if yes it MUST be registered and the linked stories' `thread` fields set), **events** (`data/events.json` — EVERY dated future catalyst mentioned today; a run that produced any `watch` item almost always has events to register), and **metrics** (`data/metrics.json` — run `python3 scripts/scan_metrics.py <date>` and register every recurring series it surfaces; a normal news day yields several, and an empty metrics run on a busy day means you skipped this). Also check **canopies** (step 10b-ii, `data/campaigns.json`) — if today added a sibling initiative to a running agenda (or a second front opened one), the canopy must be created/extended. These are append-only registries, so fetch the current rows from Supabase first (`GET .../threads|campaigns|events|metrics?select=...`) and merge — never overwrite. If a genuinely quiet run has none of a given kind, that's fine — but the default expectation on a normal news day is several events and metrics. (History note: these three registries sat empty for the app's first week because this step was skipped; a one-time backfill mined them from the archive. Don't let them fall behind again.)
12. **Publish**: `python3 scripts/push_data.py` — upserts every local day and week file plus `data/players.json`, `data/terms.json`, and (when present) `data/threads.json` / `data/campaigns.json` / `data/events.json` / `data/metrics.json` to Supabase. The hosted app updates within seconds (no deploy involved).
13. **Rates**: **Rates are maintained server-side and need no action from the routine.** A Supabase `pg_cron` job (`rates-heartbeat`, every 30 min) calls the `rates-live` edge function, which fetches the Treasury curve + SOFR from *Supabase's* network (clean egress) and refreshes `rates_cache` — what the app's Rates page and masthead actually read. This is fully independent of the routine's own egress. You MAY run `python3 scripts/fetch_rates.py` as a redundant belt-and-suspenders, but **a failure is expected and non-fatal in sandboxes that block all outbound HTTP (including *.supabase.co) — do NOT record it in the day's `notes`.** The site's rates stay fresh regardless. (Only worth flagging if the app itself shows stale rates, which would mean the edge function or heartbeat is down — a separate infra issue, not a routine failure.)

## Web push (server-side — no action from the routine)

The app's alerts (breaking-story pushes, watched-player pushes, starred-event reminders) are handled entirely by the `push-dispatch` Supabase edge function on a pg_cron schedule (every 10 min): it watches the PUBLISHED data and delivers via web push (`push-send`, VAPID keys in the `secrets` row `vapid`; subscriptions in `push_subs`; dedupe ledger in `push_log` — never double-sends across idempotent rebuilds). The routine changes nothing about its own behavior — it just publishes; marking a story `cadence: "special"` is what makes it push-eligible, so reserve `special` for genuinely breaking one-off blasts.

## Notifications (every run, every window)

**Send a push notification ONLY when the run actually changed published content** — i.e. you rebuilt today's day row and its `generatedAt` advanced because new newsletter editions arrived, new stories were added, or article content/images were filled in. That is the *only* trigger.

**Stay silent otherwise.** Specifically, do NOT notify when:
- no new newsletters arrived since the current Supabase row and you skip the rebuild (a no-op run — the common case at most of the day's windows);
- the only thing that happened was a `fetch_rates.py` warning/failure (rates are server-side; see step 13);
- you merely re-verified existing data, patched `notes`, or hit internal retries.

The test: *would the user, opening the app, see something new?* If no, finish silently. This holds at every scheduled window throughout the day (7:30, 8:00, 8:30, 9, 10 AM, 12, 2, 4 PM ET) — a quiet run is a successful run.

## Data schema — `data/YYYY-MM-DD.json`

```json
{
  "date": "YYYY-MM-DD",
  "generatedAt": "ISO-8601 UTC",
  "overview": "≈100-word signal lede: the through-line and arc movement, NOT a restatement of the keyPoints (see Writing style)",
  "keyPoints": [{ "text": "4–8 self-contained takeaways: identified actor + number + why it matters (see Writing style)", "id": "the story id this point summarizes — the app makes the row tap-through to that story; omit id (or use a plain string) only for a synthesized point with no single source story" }],
  "watch": ["1–3 dated upcoming catalysts (auctions, trials, policy deadlines, Fed decisions) from today's and recent coverage; [] if none"],
  "stories": [
    {
      "id": "kebab-slug",
      "title": "headline",
      "summary": "1–2 sentences, concrete (names, numbers), in your own words",
      "section": "New York | Capital Markets | Residential | Development | Policy | Tech | ...",
      "sources": ["newsletter name(s)"],
      "cadence": "daily | weekly | special",
      "dealType": "Sale | Financing | Lease | Development | Distress | Legal | Policy | Industry | Markets",
      "assetClass": "Multifamily | Office | Retail | Industrial | Hotel | Residential | Mixed-Use | Land | null",
      "market": "short metro/region label (see procedure step 5)",
      "valueUsd": 81400000,
      "capRate": 5.4,
      "noi": 4400000,
      "sizeSqft": 250000,
      "units": 120,
      "submarket": "Long Island City",
      "featured": true,
      "url": "canonical article URL",
      "publisher": "real publisher's display name when the item points to ANOTHER outlet (common in CRE Daily roundups, which credit e.g. CommercialSearch, Multi-Housing News, The Wall Street Journal) — read it from the blurb's attribution so the app credits the true source, not the newsletter; omit when the newsletter itself is the publisher",
      "sourceBlocked": "set by fill_content.py only — true when full text lives at a source that couldn't be fetched; the app then turns the card into a tap-through to that source (do not set by hand)",
      "brief": "true for sub-budget one-liners (see step 4) — the app renders them in the 'Also today' strip, not as cards, but they still get content-filled and open as reader pages; omit for full stories",
      "thread": "slug of the registered thread this story belongs to (set by step 10b when an evidence-gated link exists); omit otherwise",
      "coverage": [{ "publisher": "other outlet's display name", "url": "their version's URL", "title": "their headline", "content": "their sanitized article HTML or null", "note": "≤10 words on what this take adds, or null" }],
      "image": "hero image URL or null",
      "locations": [{ "label": "human-readable place", "lat": 0.0, "lng": 0.0 }],
      "content": "<p>sanitized article HTML (p/h2/h3/blockquote/ul/ol/li/img/figure/figcaption) or null</p>",
      "explainer": "plain-English rewrite for any story with an economic/policy/structural concept a non-specialist couldn't grasp from the text — bias toward inclusion (see Writing style); null only for self-explanatory deal/listing/personnel items"
    }
  ],
  "notes": "optional: anything unusual (missing editions, new subscriptions)"
}
```

If no newsletters arrived, still write the file: overview says so, `stories: []`, note why.

## Data schema — `data/weeks/<monday YYYY-MM-DD>.json`

```json
{
  "weekOf": "YYYY-MM-DD (Monday)",
  "generatedAt": "ISO-8601 UTC",
  "overview": "2–4 sentences on the week's arc so far",
  "themes": [{ "title": "short theme name", "body": "2–3 sentences synthesizing across days/newsletters" }],
  "topStories": [{ "day": "YYYY-MM-DD", "id": "story id in that day file", "title": "", "source": "" }],
  "notes": "optional; mention if the week is still in progress"
}
```

## Data schema — `data/players.json`

The whole roster in one file; `push_data.py` upserts each entry as its own `players` row. The app hides any slug starting with `_`.

```json
{
  "generatedAt": "ISO-8601 UTC",
  "players": {
    "scott-everett": {
      "name": "Scott Everett",
      "type": "person | company",
      "role": "people: title + firm ('Founder & CEO, S2 Capital'); companies: short category ('Multifamily syndicator (Dallas)', 'Lender', 'Brokerage')",
      "org": "people only: their firm's display name (cross-links to the firm's profile in the app) or null",
      "tagline": "one line: who they are and why they matter right now",
      "image": "stable square image URL (company favicon/logo, Wikipedia headshot) or null — see image-sourcing rule in step 9",
      "aliases": ["short alternate names for auto-linking in prose — see aliases rule in step 9; [] if none"],
      "profile": "2–5 sentence dossier synthesized from ALL coverage to date, not just today; separate paragraphs with \\n\\n",
      "markets": ["DFW"],
      "assetClasses": ["Multifamily"],
      "stats": { "mentions": 1, "dealVolumeUsd": 400000000, "firstSeen": "YYYY-MM-DD", "lastSeen": "YYYY-MM-DD" },
      "mentions": [
        { "date": "YYYY-MM-DD", "id": "story id in that day file", "title": "story headline", "role": "subject | buyer | seller | developer | lender | borrower | landlord | tenant | broker", "valueUsd": 400000000 }
      ]
    },
    "_candidates": {
      "names": { "Jane Broker": { "type": "person", "count": 1, "lastSeen": "YYYY-MM-DD", "note": "broker, $38.5M Bronx portfolio" } }
    }
  }
}
```

## Data schema — `data/terms.json`

The whole dictionary in one file; `push_data.py` upserts each entry as its own `terms` row.

```json
{
  "generatedAt": "ISO-8601 UTC",
  "terms": {
    "cap-rate": {
      "term": "Cap Rate",
      "category": "Valuation & Returns | Financing & Debt | Legal & Regulatory | Deal Structures | Market Mechanics | Tax",
      "aliases": ["short alternate names/abbreviations for auto-linking in prose; [] if none"],
      "shortDef": "one sentence, ≤25 words — for the dictionary card view",
      "definition": "2–4 sentences, plain language, assumes no prior knowledge; separate paragraphs with \\n\\n",
      "stats": { "mentions": 2, "firstSeen": "YYYY-MM-DD", "lastSeen": "YYYY-MM-DD" },
      "mentions": [
        { "date": "YYYY-MM-DD", "id": "story id in that day file", "title": "story headline" }
      ]
    }
  }
}
```

## Data schema — `data/threads.json`

The whole registry in one file; `push_data.py` upserts each entry as its own `threads` row. See step 10b for the linking rules (five hard anchors, nothing else).

```json
{
  "generatedAt": "ISO-8601 UTC",
  "threads": {
    "111-wall-street": {
      "title": "short arc name ('111 Wall Street', 'S2 Capital fund collapse')",
      "type": "property | transaction | litigation | company | event",
      "anchor": "one concrete phrase naming the shared spine — the thread's reason to exist",
      "status": "active | resolved",
      "entries": [
        { "date": "YYYY-MM-DD", "id": "story id in that day file", "title": "story headline", "delta": "≤15 words: what this installment changed", "why": "anchor phrase for THIS link, e.g. 'same property: 111 Wall St'" }
      ],
      "createdAt": "YYYY-MM-DD",
      "lastSeen": "YYYY-MM-DD"
    }
  }
}
```

Entries newest-first (same convention as player mentions); the app reverses for timeline display.

## Data schema — `data/campaigns.json`

The whole registry in one file; `push_data.py` upserts each entry as its own `campaigns` row. See step 10b-ii for the gate (named driver + bounded mandate + coverage-would-say-it — nothing else). A canopy points DOWN at existing threads/stories; never write a `campaign` field onto them.

```json
{
  "generatedAt": "ISO-8601 UTC",
  "campaigns": {
    "mamdani-housing-agenda": {
      "title": "short agenda name ('Mamdani's Housing Agenda')",
      "type": "agenda | program | campaign",
      "driver": "the named actor/coalition pushing it ('the Mamdani administration')",
      "mandate": "the bounded program ('NYC housing platform')",
      "throughLine": "2–4 sentences: why these fronts are one story, in the daily-overview voice — the canopy's reason to exist",
      "status": "active | resolved",
      "branches": [
        { "title": "front name ('Rental Ripoff enforcement')", "thread": "thread slug when this front IS a registered thread (pulls its live entries); omit for a loose-leaf front", "why": "one-phrase anchor admitting this front to the trunk", "stories": [ { "date": "YYYY-MM-DD", "id": "story id", "title": "headline", "delta": "≤12 words: what this installment added (optional)" } ] }
      ],
      "relatedThreads": ["thread slug — adjacent arc shown but labeled NOT part of the agenda"],
      "createdAt": "YYYY-MM-DD",
      "lastSeen": "YYYY-MM-DD"
    }
  }
}
```

A branch is EITHER thread-backed (`thread` set, `stories` omitted — the app pulls the thread's entries) OR loose (`stories` listed, `thread` omitted). Loose `stories` are ordered any way; the app sorts each branch oldest→newest for its timeline.

## Data schema — `data/events.json`

The whole registry in one file; `push_data.py` upserts each entry as its own `events` row. See step 10c — every concrete dated event, compiled automatically.

```json
{
  "generatedAt": "ISO-8601 UTC",
  "events": {
    "2026-08-13-fed-rate-decision": {
      "date": "YYYY-MM-DD (the event's date; for month-precision use the 1st)",
      "approx": "day | month",
      "title": "short event name ('S2 North Texas foreclosure auctions', 'FARE Act effective date')",
      "type": "auction | court | policy | fed | data | deadline | opening | other",
      "market": "same labels as stories, or National",
      "announcedBy": [{ "day": "YYYY-MM-DD", "id": "story id" }],
      "resolvedBy": { "day": "YYYY-MM-DD", "id": "story id", "outcome": "≤20 words on what happened" }
    }
  }
}
```

`resolvedBy` is null/omitted until an outcome story arrives.

## Data schema — `data/metrics.json`

The whole ledger in one file; `push_data.py` upserts each entry as its own `metrics` row. See step 10d — cited industry figures only, with their sources.

```json
{
  "generatedAt": "ISO-8601 UTC",
  "metrics": {
    "cmbs-delinquency-office": {
      "name": "Office CMBS delinquency",
      "unit": "% | $ | bps | index | count",
      "geography": "National | Manhattan | ... (same labels as story markets)",
      "series": [
        { "asOf": "YYYY-MM-DD (period the figure describes)", "value": 11.1, "source": "Trepp", "day": "YYYY-MM-DD (story's day)", "id": "story id" }
      ]
    }
  }
}
```

Series in chronological order; append-only.

## Writing style

**Write for a smart reader who doesn't know any of the names — in as few words as possible.** Every company and person gets a compact identifying clause on first reference in any prose field: "Dallas syndicator S2 Capital", "ex-Buffett protégé Ian Jacobs", "Asana Partners, a Charlotte urban-retail specialist" — never a bare name, never a full sentence of biography. Assume no memory of prior days' coverage. Maximize information per word: keep every number, cut connective tissue. Targets: `overview` ≈ 100 words; each `keyPoint` ≤ 30 words.

**The three summary layers — one ranking, three altitudes, no repetition.** Top Stories (the `featured` set), the `overview`, and `keyPoints` must all point at the *same* handful of most-important stories (the step-4 ranking), each at a different altitude so moving between them feels like zooming in — never like reading the same sentence three times:
- **Top Stories** = the 3–5 `featured` stories as full cards in the feed. The detailed layer; the app renders it, you just set the flag.
- `overview` = the **meaning** layer (≈100 words). **Lead with the day's single most important story or dominant theme — and it MUST be one that's `featured`.** Never open on a story you didn't feature: the reader immediately notices it's absent from Top Stories (this is the "Musk/Meta trap" — don't foreground stories the rest of the page treats as minor). After the lead, draw the through-line connecting the top stories and how the running arcs moved — cite prior coverage when it does ("a day after Compass's $1.6B Anywhere deal drew a class action…"); fetch the prior 2–3 days from Supabase first, continuity is the point. It is argument/synthesis, **not** a fact list: it may cite a fact as evidence, but never re-explains a keyPoint or restates a story's summary. Ban scene-setting filler ("a busy day in…").
- `keyPoints` = the **fast-facts** layer: one tight line per top story (identified actor + number + significance, ≤30 words), covering the `featured` set first, then 1–2 essential macro datapoints that aren't standalone featured stories (a national rent / vacancy / rate print). Each carries the `id` of its story. Write it *terser than that story's own summary* — a scan, not a re-read.
- **Coherence test** (run it before publishing): the story the overview opens on = a `featured` Top Story = one of the first keyPoints. If those three disagree, the ranking wasn't applied consistently — fix it, don't ship it.
- **Non-repetition test:** a reader going overview → key points → the story's card should get *new* information at each step (why it matters → the numbers → the full account), never the same wording thrice.
- `watch`: 1–3 forward-looking catalysts with dates ("Fed bill-purchase decision Aug. 13", "S2's five North Texas foreclosure auctions land this month"), ≤20 words each, drawn from today's and recent stories. Only include real, dated events — never vague "keep an eye on" items.
- `summary` (per story): concrete who/what/how-much, actors identified the same way, in your own words.
- `content` is mechanical extraction (email body or fetch_article.py output), not rewriting.
- `explainer` (optional, per story): a plain-English re-telling for any story that rests on a mechanism, concept, or consequence a smart *non-specialist* couldn't fully grasp from the article alone — this is broader than jargon. Include one when the story turns on: financial/monetary mechanics (Fed plumbing, securitization/CMBS, rate math, cap rates); a policy or legal structure and its second-order effects (rent regulation, zoning/land-use, tax programs, antitrust); market dynamics or "why this matters" that isn't self-evident (why a floating-rate unwind cascades, why consolidation raises fees, why a data-center moratorium reshapes industrial demand). Write 2–4 short paragraphs: what happened, how the mechanism works (define each moving part in a clause), and the "so what" for real estate. Separate paragraphs with \\n\\n. Renders in a box under the full article as a supplement, never a replacement.
  - **Bias toward inclusion — when in doubt, write one.** The cost of an unneeded explainer is small (a reader skips it); the cost of a missing one is a reader who doesn't understand the story. Skip it ONLY for genuinely self-explanatory items: a straight building sale/lease, a home listing, a personnel move, a short deal blurb. Everything with an economic, policy, or structural angle gets one. Expect this to be the majority of non-transactional stories — roughly 6–12 on a normal day, not a rare flourish.
- Section names stay short and reusable day-to-day.
- `shortDef`/`definition` (dictionary terms): explain the mechanism, not just a synonym — a reader should understand *why* it matters, not just what to call it. No circular definitions ("a cap rate is a rate used to cap...").

Bad (color, no context): "S2 Capital's $400M first fund collapses as the Sun Belt syndication unwind claims another victim."
Bad (context, too wordy): "S2 Capital — a Dallas syndicator that built one of the Sun Belt's largest value-add apartment operations (roughly $11B transacted since 2012) on floating-rate debt — is dissolving its $400M first fund with zero return to investors."
Good: "S2 Capital, the Dallas syndicator that built ~$11B of Sun Belt apartments on floating-rate debt, is dissolving its $400M first fund at a total loss — rents fell 24%, interest costs rose 50%."
