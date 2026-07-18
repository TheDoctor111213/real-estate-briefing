# Real Estate News Briefing

A web app that compiles Matthew's real estate newsletters into a daily briefing with an in-app reader, deal map, weekly summary, players roster (accumulating people/company dossiers), a dictionary of jargon/concepts, and a history archive.
Static site (no build step): `index.html` + `css/style.css` + `js/app.js`, pipeline helpers in `scripts/`. Leaflet (CDN) powers the map.

- **Hosting**: GitHub Pages, custom domain `briefing.pierrepontcompanies.com` (`CNAME` file). Deploys happen only when app code changes — data never requires a deploy. **When deploying js/css changes, bump the `?v=` query on both asset tags in `index.html`** — it prevents cached pages from pairing old code with new data shapes.
- **Data**: Supabase project `uhwdnmbxiopfysodydty` (org ptxdileqdzaovbezrplg) — tables `days` (pk `date`, `data` jsonb, `generated_at`), `weeks` (pk `week_of`, `data` jsonb, `generated_at`), `players` (pk `slug`, `data` jsonb, `updated_at`), and `terms` (pk `slug`, `data` jsonb, `updated_at`). RLS is open read AND open write on the publishable key (owner's accepted tradeoff, single-user app); DELETE is revoked at the DB level on all four tables. The app reads it live via PostgREST.
- **Local dev**: the `briefing` config in `.claude/launch.json` (python3 http.server, port 8420) — the app reads Supabase either way. `data/` holds the pipeline's working JSON files and is gitignored (also keeps subscriber-only article text out of the public repo).

## Architecture

1. Scheduled cloud routines on claude.ai (windows: 7:30, 8:00, 8:30, 9:00, 10:00 AM, 12:00, 2:00, 4:00 PM ET; hardware-independent — they run in Anthropic's cloud against this repo) read the day's real estate newsletters from Gmail, synthesizes ONE deduped story list, fetches full article text, geocodes deal locations, writes `data/YYYY-MM-DD.json`, updates the rolling week file `data/weeks/<monday>.json`, maintains `data/index.json` (`{dates: [], weeks: []}`), then **publishes with `python3 scripts/push_data.py`** (upserts days + weeks + players + terms to Supabase). Runs are idempotent: each rebuilds today's file from ALL of today's emails (`after:` today, America/New_York — not `newer_than:1d`), keeping existing story ids stable.
2. The app has six hash-routed views — Briefing (`#/day/DATE`), Map (`#/map`), Weekly (`#/weekly`), Players (`#/players`, profiles at `#/player/SLUG`), Dictionary (`#/dictionary`, entries at `#/term/SLUG`), Rates (`#/rates`) — plus History (`#/history`, reached by tapping the masthead date, not a tab) and a full-screen reader overlay (`#/story/DATE/ID`). A masthead refresh button (and auto-refetch every 10 min / on tab focus) re-queries Supabase and re-renders when `generatedAt` changes; pulling NEW emails always happens through a task run, not the page.

## Newsletter sources (Gmail senders)

- Inman — `select@inman.com` (Morning Headlines) and `headlines@inman.com` (Afternoon Headlines / Newsflash), both daily
- CRE Daily — `mail@news.credaily.com` (daily; often carries full story text in the email)
- CRE Daily New York — `mail@newyork.credaily.com` (daily)
- The Real Deal — `elerts@e.therealdeal.com` (mix of daily elerts, weekly recaps, and special/breaking blasts)
- Traded — senders on BOTH `traded.co` and `tradedmedia.co` (e.g. `hello@tradedmedia.co`); search both domains (National digest ~2×/week; treat regular editions as `daily` cadence). Traded editions are lists of individual closings/listings — each deal (address, price, buyer/seller/broker) becomes its own story with a precise `locations` pin; these are the best map content we get. Group them under a market-level `section` (New York, National, ...) and don't mark routine deal items `featured` unless one is genuinely headline-scale.
- Bisnow — senders on `bisnow.com` (search the domain; they mail from subdomains). The owner subscribes to MANY Bisnow newsletters — most asset classes, most of NYC, Philadelphia, and DC — with mixed cadence (daily / weekly / biweekly / occasional). These are volume feeds: apply the story budget and market tiers (step 4) hard — most Bisnow items belong in `brief` one-liners, the record layer, or as corroboration merged into existing stories, NOT as new full stories. Bisnow articles fetch free (no hard paywall observed); if some content turns out gated, a session cookie can be stored with `python3 scripts/trd_session.py --cookie --domain bisnow.com`. Skip their event promos and sponsored/"Studio B" content entirely.

Also include any other newsletter that is clearly real-estate news. Skip welcome/confirmation emails, job alerts, meetup blasts, and promotional one-offs.

## Daily update procedure (for the scheduled task)

1. Search Gmail: `from:(select@inman.com OR headlines@inman.com OR mail@news.credaily.com OR mail@newyork.credaily.com OR elerts@e.therealdeal.com OR traded.co OR tradedmedia.co OR bisnow.com) after:<today>` — plus a broader pass for other real-estate newsletters received today (America/New_York).
2. For each newsletter, get the message and extract stories from the HTML body. Large bodies get saved to a tool-results file; parse with python (`html.parser`), never by reading raw HTML into context. Tracking links like `link.therealdeal.com/click/<id>/<base64>` decode via urlsafe-base64 (pad with `=`) to the real article URL — strip query params.
   - **CRE Daily / CRE Daily New York (beehiiv) — use the PLAINTEXT for real URLs.** These newsletters rewrite every article link in the HTML body to an opaque `link.mail.beehiiv.com` tracking wrapper that can NOT be decoded and is Cloudflare-walled (so it can't be fetched or resolved server-side). But the message's **plaintext part** (`plaintextBody` / `text/plain`) carries the REAL destination URLs as `[label](https://real-publisher-url): blurb` markdown. Parse those and take each story's canonical `url` from the plaintext link — strip `utm_*` / `_bhlid` query params. Match each story to its markdown item by the blurb/label text. This is what surfaces CRE Daily's *root sources* (it's a partial aggregator: items link to credaily.com's own articles AND to CommercialSearch, Multi-Housing News, Bisnow, Commercial Observer, GlobeSt, Connect CRE, CoStar, AltsWire, WSJ, …). The real URL is what drives correct publisher crediting (step 6) and lets `fill_content.py` fetch the actual site. **Caveat:** the plaintext doesn't always list every secondary blurb — if a story has no plaintext markdown link, keep its beehiiv href as `url`; `fill_content.py` will flag it `sourceBlocked` and the app makes it a tap-through (only a real browser can follow those, which the routine can't do).
3. **Classify cadence** per newsletter edition: `daily` (regular daily edition), `weekly` (weekly recap/digest), or `special` (breaking-news or one-off themed blast). Every story inherits its newsletter's cadence.
4. **Synthesize & rank.** The reader's time is fixed; input volume is not. As sources grow, **input scales, output doesn't** — more newsletters must produce *better-corroborated* stories, never more of them.
   - **Merge, don't multiply.** Dedupe into ONE story list: the same story in N newsletters → one entry, every outlet in `sources`. Corroboration is a ranking signal (a story three desks covered outranks a similar one desk covered); take each fact from the best version and prefer the most authoritative numbers. When outlets' versions genuinely differ, record the extra takes in the story's `coverage` array (schema below): the main `content`/`url`/`publisher` hold the PRIMARY version (fullest text, most authoritative outlet), and each other outlet contributes `{publisher, url, title, content|null, note}` — `note` is a ≤10-word phrase for what that version adds ("adds construction financing details"), null when it's just the same story. The app renders these as "Also covered by" rows in the reader.
   - **Weekly/biweekly digests merge, never multiply.** A weekly-recap item matching a story from the past week adds its outlet to that story's `sources`/`coverage` (and updates numbers if newer) — it does NOT create a new story. Weeklies exist to fill gaps we missed and to corroborate.
   - **Story budget: ~30 full stories/day** (thinner early in the day is fine — later runs keep adding as editions arrive). Everything newsworthy beyond the budget becomes a one-liner: set `brief: true` and give it only `title`, `summary` (one short sentence), classification fields, `url`, `locations`, `valueUsd` — no featured, no content fetch, no explainer. The app shows briefs as an "Also today" strip at the feed's bottom; they still feed the map, ledger, and players. Routine digest closings (small Traded/Bisnow items), minor leases, and watch-tier markets' day-to-day deals belong here.
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
   - `market` — short reusable metro/region label. Reuse existing ones before inventing: New York, Los Angeles, SF Bay Area, South Florida, Texas, DFW, Chicago, Washington DC, Boston, New Jersey, Phoenix, Atlanta, Denver, Austin, San Diego, National. **`market` = where the real estate is, not where the story "feels" like it belongs.** `National` is reserved for stories with genuinely no single geography: federal policy/regulators, nationwide lawsuits or company/industry news with no single asset, national data prints (rent/vacancy/sales indices), REIT- or company-level M&A. Any story about a specific property, site, portfolio-in-one-metro, or named project — even inside a sector-trend piece — gets that metro (invent a clean label when needed: "Louisiana", "Nashville", "Bahamas"→International). Real estate transactions are almost never National.
   - `valueUsd` — the single deal size in dollars as a plain number (e.g. 81400000); `null` when there is no single figure (permit recaps, roundups, policy pieces).
   - `sizeSqft` / `units` — the deal's size when a single clear figure is stated: square footage (office / retail / industrial / mixed-use) or unit count (multifamily / residential apartments). Plain numbers; omit either when not stated. The app derives a `$/sf` or `$/unit` chip from these plus `valueUsd` (it prefers `$/unit` when `units` is present).
5. **Geocode**: for stories tied to identifiable places (a property, site, submarket, or city), add `locations: [{label, lat, lng}]` — approximate coordinates from knowledge are fine (city/neighborhood precision; a specific address if confident). Stories with no meaningful geography (national policy, earnings, data prints) get `locations: []`. **Every story whose `market` is a metro/region MUST carry at least one pin** — a regional story with `locations: []` is a bug. A trend piece anchored on one or two named projects should pin those projects even if the theme is national.
6. **Reader content** per story, in order of preference: (a) full story text extracted from the email body itself when the newsletter carries it (CRE Daily often does) — include `<figure>/<img>/<figcaption>`; (b) `python3 scripts/fetch_article.py <url>` → JSON `{ok, title, image, html, words}`; if `ok`, use `html` as `content` and `image` as hero; (c) neither → `content: null` for now — step 7b's `fill_content.py` will loop back and fetch it deterministically, so you don't have to fetch every story inline here; you just have to run that step.
   - **Credit the real publisher.** When a newsletter item is a pointer to another outlet's article (CRE Daily roundups constantly do this — the blurb says "per CommercialSearch", "via Multi-Housing News", "The Wall Street Journal reports"), set the story's `publisher` to that outlet's name. The app credits `publisher` first, then the resolved article-URL domain, then the newsletter — so a reroute is attributed correctly even when its link is a `beehiiv`/Mailchimp wrapper that couldn't be resolved. Leave `publisher` unset when the newsletter is itself the publisher (its own credaily.com/therealdeal.com/inman.com article).
   - **fetch_article.py fetches through a fallback chain**: direct HTTP first, then the Supabase `fetch-proxy` edge function when the direct fetch fails, times out, hits a bot wall, or the run environment's egress is blocked (cloud runs). The proxy fetches from Supabase's network (always reachable), follows redirects (Traded's `us.list-manage.com` links resolve to `traded.co`), and forwards the TRD cookie. This is why article fetches succeed in the cloud even though direct egress to news sites is blocked. Inman and The Real Deal both use client-side (Piano) paywalls — the full article ships in the page HTML, so no login is needed once the page is fetched; Inman just also sits behind Cloudflare, which the proxy's clean egress IP passes.
   - **The Real Deal (subscriber articles)**: fetch_article.py automatically sends the owner's TRD session cookie (stored in the Supabase `secrets` table, row `trd_session`). TRD's reader site is Next.js with its own (non-WordPress) login, so the session is captured by the owner pasting their browser cookie header into `python3 scripts/trd_session.py --cookie` — the pipeline never sees a password. If a therealdeal.com fetch returns `paywalled: true`, the session has expired: still write the story with `content: null`, and say in the day's `notes` that the TRD session needs a refresh (`python3 scripts/trd_session.py --cookie`).
7. Write `data/YYYY-MM-DD.json` (schema below). Create the `data/` directory if it doesn't exist. (`data/index.json` is a legacy local-dev artifact — ignore it if absent; the app reads Supabase, not files.)
7b. **Reader content is filled by the GitHub Actions heartbeat — you don't need working egress.** A scheduled workflow (`.github/workflows/fill-content.yml`, every 30 min) runs `scripts/fill_browser.py` on GitHub's runners: a REAL headless browser (Playwright) that fetches every story still missing content, passes Cloudflare JS challenges, resolves tracking-link redirects to canonical publisher URLs, and republishes the day. So: write each story's `url` (and any content available in the email body itself) and move on — text you can't fetch will fill itself within ~30 minutes. If your sandbox happens to have egress, you MAY still run `python3 scripts/fill_content.py <date> --no-push` as a fast first pass; its failures are expected and non-fatal when egress is blocked (do not spend run time retrying, and mention it in `notes` only if the heartbeat also hasn't filled yesterday's stories — that would mean the workflow itself is broken). This is the reliability backstop for step 6: a plain code loop over **every** story that fetches full article text for any still missing it (`content: null` or under ~120 words) via `fetch_article.py` (direct → Supabase proxy → TRD cookie). Fetching articles is therefore **not** a per-story judgment call you can partially skip — this loop guarantees each story is attempted. It is idempotent (stories that already have content are left alone), throttled with one retry pass so tracking-link hosts (beehiiv/Mailchimp) don't rate-limit the batch, and any story that fails transiently is retried automatically on the **next** scheduled window — so coverage self-heals without manual steps. Read its `SUMMARY:` line: if it reports persistent `failed` ids or `TRD-paywalled`, fold that into the day's `notes` (for TRD, refresh the session with `python3 scripts/trd_session.py --cookie`). `--no-push` fills only the local file; step 12's `push_data.py` publishes it.
8. **Weekly rollup**: compute the week's Monday. Rewrite `data/weeks/<monday>.json` synthesizing ALL of that week's days so far (schema below) — synthesize across days, don't just concatenate. **In a fresh checkout (cloud runs) the earlier day files won't exist locally** — fetch them from Supabase instead: `GET <SUPABASE_URL>/rest/v1/days?date=gte.<monday>&date=lte.<today>&select=data` with the `apikey` header, using the URL and key found in `scripts/push_data.py`.
9. **Players roster**: maintain the persistent people/companies dossier set behind the app's Players tab. Fetch the current roster from Supabase (`GET <SUPABASE_URL>/rest/v1/players?select=slug,data` with the `apikey` header), merge today's stories into it, write the complete result to `data/players.json` (schema below). Curation rules — these keep the roster valuable instead of unwieldy:
   - **Who gets a profile.** People: only when a story is substantially *about* them (protagonist of a deal, fund event, lawsuit, interview, appointment). Companies: story subject, or a named principal (buyer / seller / developer / lender / borrower / landlord) in a deal ≥ $25M or a lease ≥ 100K sf.
   - **Who waits in `_candidates`.** Names appearing only as deal-party credits in digest items (Traded blurbs, permit recaps) — brokers, small-deal principals, execs named beside their firm — get a tally in the `_candidates` row instead of a profile. Promote to a full profile on the **second** sighting (any size), then remove the ledger entry.
   - **Who never enters.** Celebrities/athletes/entertainers in personal-home deals, private individuals buying homes, tenants/occupiers acting purely as space users (profile the landlord, not the tenant), reporters, quoted analysts.
   - **Updating an existing profile.** Append today's mention(s) newest-first — the full mention history is kept forever, never trimmed. Update `stats` (`dealVolumeUsd` sums `valueUsd` only where the entity was a transaction principal, not a mere story subject), extend `markets`/`assetClasses`, refresh `lastSeen`. Rewrite `profile`/`tagline` only when today's news meaningfully changes the picture; otherwise leave the prose alone.
   - **Profiles are permanent.** Never delete a profile, a mention, or a `_candidates` tally (the only removal ever allowed is a candidate's ledger entry at the moment it's promoted to a full profile). Dormant entities are not cleaned up — the app's recency-weighted ranking simply sinks them, and search still finds them. The database also enforces this: the publishable key has no DELETE permission on `players` (or `days`/`weeks`/`rates`).
   - **One slug per entity, forever.** Check for aliases before creating (e.g. "Blackstone" vs "Blackstone Group"; people by full name). Never re-slug.
   - **Aliases** (`aliases` field): short alternate names the app auto-links wherever they appear in prose (summaries, articles, dossiers) — e.g. "NAR", "Elliman", "Brookfield", "Oren Alexander". Add them when an entity is commonly referenced by a shorter or different name. Keep them unambiguous and case-exact: never a common English word, never something that could be a different entity. (People with simple two-word names get bare-surname linking automatically — no alias needed for that.)
   - **Profile image** (`image` field): source a stable square image URL when creating a profile, in order of preference:
     1. Companies: `https://www.google.com/s2/favicons?domain=<their domain>&sz=128` — verify with `curl -sL` that the followed redirect returns HTTP 200 (a 404 means no logo that size). Find the real domain first (a web search is fine — e.g. Lift Partners is liftrp.com, not liftpartners.com).
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
11. Validate all written files with `python3 -m json.tool`.
12. **Publish**: `python3 scripts/push_data.py` — upserts every local day and week file plus `data/players.json` and `data/terms.json` to Supabase. The hosted app updates within seconds (no deploy involved).
13. **Rates**: **Rates are maintained server-side and need no action from the routine.** A Supabase `pg_cron` job (`rates-heartbeat`, every 30 min) calls the `rates-live` edge function, which fetches the Treasury curve + SOFR from *Supabase's* network (clean egress) and refreshes `rates_cache` — what the app's Rates page and masthead actually read. This is fully independent of the routine's own egress. You MAY run `python3 scripts/fetch_rates.py` as a redundant belt-and-suspenders, but **a failure is expected and non-fatal in sandboxes that block all outbound HTTP (including *.supabase.co) — do NOT record it in the day's `notes`.** The site's rates stay fresh regardless. (Only worth flagging if the app itself shows stale rates, which would mean the edge function or heartbeat is down — a separate infra issue, not a routine failure.)

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
      "sizeSqft": 250000,
      "units": 120,
      "featured": true,
      "url": "canonical article URL",
      "publisher": "real publisher's display name when the item points to ANOTHER outlet (common in CRE Daily roundups, which credit e.g. CommercialSearch, Multi-Housing News, The Wall Street Journal) — read it from the blurb's attribution so the app credits the true source, not the newsletter; omit when the newsletter itself is the publisher",
      "sourceBlocked": "set by fill_content.py only — true when full text lives at a source that couldn't be fetched; the app then turns the card into a tap-through to that source (do not set by hand)",
      "brief": "true for sub-budget one-liners (see step 4) — the app renders them in the 'Also today' strip, not as cards; omit for full stories",
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
