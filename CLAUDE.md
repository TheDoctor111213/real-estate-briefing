# Real Estate News Briefing

A web app that compiles Matthew's real estate newsletters into a daily briefing with an in-app reader, deal map, weekly summary, players roster (accumulating people/company dossiers), and history archive.
Static site (no build step): `index.html` + `css/style.css` + `js/app.js`, pipeline helpers in `scripts/`. Leaflet (CDN) powers the map.

- **Hosting**: GitHub Pages, custom domain `briefing.pierrepontcompanies.com` (`CNAME` file). Deploys happen only when app code changes — data never requires a deploy. **When deploying js/css changes, bump the `?v=` query on both asset tags in `index.html`** — it prevents cached pages from pairing old code with new data shapes.
- **Data**: Supabase project `uhwdnmbxiopfysodydty` (org ptxdileqdzaovbezrplg) — tables `days` (pk `date`, `data` jsonb, `generated_at`), `weeks` (pk `week_of`, `data` jsonb, `generated_at`), and `players` (pk `slug`, `data` jsonb, `updated_at`). RLS is open read AND open write on the publishable key (owner's accepted tradeoff, single-user app). The app reads it live via PostgREST.
- **Local dev**: the `briefing` config in `.claude/launch.json` (python3 http.server, port 8420) — the app reads Supabase either way. `data/` holds the pipeline's working JSON files and is gitignored (also keeps subscriber-only article text out of the public repo).

## Architecture

1. Scheduled cloud routines on claude.ai (windows: 7:30, 8:00, 8:30, 9:00, 10:00 AM, 12:00, 2:00, 4:00 PM ET; hardware-independent — they run in Anthropic's cloud against this repo) read the day's real estate newsletters from Gmail, synthesizes ONE deduped story list, fetches full article text, geocodes deal locations, writes `data/YYYY-MM-DD.json`, updates the rolling week file `data/weeks/<monday>.json`, maintains `data/index.json` (`{dates: [], weeks: []}`), then **publishes with `python3 scripts/push_data.py`** (upserts days + weeks to Supabase). Runs are idempotent: each rebuilds today's file from ALL of today's emails (`after:` today, America/New_York — not `newer_than:1d`), keeping existing story ids stable.
2. The app has six hash-routed views — Briefing (`#/day/DATE`), Map (`#/map`), Weekly (`#/weekly`), Players (`#/players`, profiles at `#/player/SLUG`), History (`#/history`), Rates (`#/rates`) — plus a full-screen reader overlay (`#/story/DATE/ID`). A masthead refresh button (and auto-refetch every 10 min / on tab focus) re-queries Supabase and re-renders when `generatedAt` changes; pulling NEW emails always happens through a task run, not the page.

## Newsletter sources (Gmail senders)

- Inman — `select@inman.com` (Morning Headlines) and `headlines@inman.com` (Afternoon Headlines / Newsflash), both daily
- CRE Daily — `mail@news.credaily.com` (daily; often carries full story text in the email)
- CRE Daily New York — `mail@newyork.credaily.com` (daily)
- The Real Deal — `elerts@e.therealdeal.com` (mix of daily elerts, weekly recaps, and special/breaking blasts)
- Traded — senders on BOTH `traded.co` and `tradedmedia.co` (e.g. `hello@tradedmedia.co`); search both domains (National digest ~2×/week; treat regular editions as `daily` cadence). Traded editions are lists of individual closings/listings — each deal (address, price, buyer/seller/broker) becomes its own story with a precise `locations` pin; these are the best map content we get. Group them under a market-level `section` (New York, National, ...) and don't mark routine deal items `featured` unless one is genuinely headline-scale.

Also include any other newsletter that is clearly real-estate news. Skip welcome/confirmation emails, job alerts, meetup blasts, and promotional one-offs.

## Daily update procedure (for the scheduled task)

1. Search Gmail: `from:(select@inman.com OR headlines@inman.com OR mail@news.credaily.com OR mail@newyork.credaily.com OR elerts@e.therealdeal.com OR traded.co OR tradedmedia.co) after:<today>` — plus a broader pass for other real-estate newsletters received today (America/New_York).
2. For each newsletter, get the message and extract stories from the HTML body. Large bodies get saved to a tool-results file; parse with python (`html.parser`), never by reading raw HTML into context. Tracking links like `link.therealdeal.com/click/<id>/<base64>` decode via urlsafe-base64 (pad with `=`) to the real article URL — strip query params.
3. **Classify cadence** per newsletter edition: `daily` (regular daily edition), `weekly` (weekly recap/digest), or `special` (breaking-news or one-off themed blast). Every story inherits its newsletter's cadence.
4. **Synthesize** ONE deduped story list. Same story in two newsletters → one entry, both names in `sources`. Assign each story a short reusable `section` (New York, Capital Markets, Residential, Development, Policy, Tech, ...). Mark the 3–5 most important `featured: true`.
5. **Classify** every story for the app's filters, chips, and map icons — all four fields, consistently:
   - `dealType` — exactly one of: `Sale`, `Financing`, `Lease`, `Development`, `Distress`, `Legal`, `Policy`, `Industry`, `Markets`. Pick the story's dominant nature (a bankruptcy-driven sale → Distress; a lawsuit → Legal; company/people/tech news → Industry; data/trend pieces → Markets).
   - `assetClass` — `Multifamily`, `Office`, `Retail`, `Industrial`, `Hotel`, `Residential` (single-family/condo/luxury homes), `Mixed-Use`, `Land`, or `null` when not asset-specific.
   - `market` — short reusable metro/region label. Reuse existing ones before inventing: New York, Los Angeles, SF Bay Area, South Florida, Texas, DFW, Chicago, Washington DC, Boston, New Jersey, Phoenix, Atlanta, Denver, Austin, San Diego, National.
   - `valueUsd` — the single deal size in dollars as a plain number (e.g. 81400000); `null` when there is no single figure (permit recaps, roundups, policy pieces).
5. **Geocode**: for stories tied to identifiable places (a property, site, submarket, or city), add `locations: [{label, lat, lng}]` — approximate coordinates from knowledge are fine (city/neighborhood precision; a specific address if confident). Stories with no meaningful geography (national policy, earnings) get `locations: []`.
6. **Reader content** per story, in order of preference: (a) full story text extracted from the email body itself when the newsletter carries it (CRE Daily often does) — include `<figure>/<img>/<figcaption>`; (b) `python3 scripts/fetch_article.py <url>` → JSON `{ok, title, image, html, words}`; if `ok`, use `html` as `content` and `image` as hero; (c) neither → `content: null` (app falls back to summary + link).
7. Write `data/YYYY-MM-DD.json` (schema below). Create the `data/` directory if it doesn't exist. (`data/index.json` is a legacy local-dev artifact — ignore it if absent; the app reads Supabase, not files.)
8. **Weekly rollup**: compute the week's Monday. Rewrite `data/weeks/<monday>.json` synthesizing ALL of that week's days so far (schema below) — synthesize across days, don't just concatenate. **In a fresh checkout (cloud runs) the earlier day files won't exist locally** — fetch them from Supabase instead: `GET <SUPABASE_URL>/rest/v1/days?date=gte.<monday>&date=lte.<today>&select=data` with the `apikey` header, using the URL and key found in `scripts/push_data.py`.
9. **Players roster**: maintain the persistent people/companies dossier set behind the app's Players tab. Fetch the current roster from Supabase (`GET <SUPABASE_URL>/rest/v1/players?select=slug,data` with the `apikey` header), merge today's stories into it, write the complete result to `data/players.json` (schema below). Curation rules — these keep the roster valuable instead of unwieldy:
   - **Who gets a profile.** People: only when a story is substantially *about* them (protagonist of a deal, fund event, lawsuit, interview, appointment). Companies: story subject, or a named principal (buyer / seller / developer / lender / borrower / landlord) in a deal ≥ $25M or a lease ≥ 100K sf.
   - **Who waits in `_candidates`.** Names appearing only as deal-party credits in digest items (Traded blurbs, permit recaps) — brokers, small-deal principals, execs named beside their firm — get a tally in the `_candidates` row instead of a profile. Promote to a full profile on the **second** sighting (any size), then remove the ledger entry.
   - **Who never enters.** Celebrities/athletes/entertainers in personal-home deals, private individuals buying homes, tenants/occupiers acting purely as space users (profile the landlord, not the tenant), reporters, quoted analysts.
   - **Updating an existing profile.** Append today's mention(s) newest-first (cap the array at 40 — `stats.mentions` keeps counting past the cap), update `stats` (`dealVolumeUsd` sums `valueUsd` only where the entity was a transaction principal, not a mere story subject), extend `markets`/`assetClasses`, refresh `lastSeen`. Rewrite `profile`/`tagline` only when today's news meaningfully changes the picture; otherwise leave the prose alone.
   - **One slug per entity, forever.** Check for aliases before creating (e.g. "Blackstone" vs "Blackstone Group"; people by full name). Never re-slug.
10. Validate all written files with `python3 -m json.tool`.
11. **Publish**: `python3 scripts/push_data.py` — upserts every local day and week file plus `data/players.json` to Supabase. The hosted app updates within seconds (no deploy involved).
12. **Rates**: `python3 scripts/fetch_rates.py` — pulls the daily Treasury par yield curve (treasury.gov) and SOFR + compounded averages (NY Fed), and publishes to the Supabase `rates` table. Feeds the app's Rates page and the masthead ticker. Run it every pipeline run; it's cheap and idempotent.

## Data schema — `data/YYYY-MM-DD.json`

```json
{
  "date": "YYYY-MM-DD",
  "generatedAt": "ISO-8601 UTC",
  "overview": "1–3 tight sentences: the day's signal, not a table of contents",
  "keyPoints": ["3–6 compact, number-rich facts of the day (deal sizes, rate moves, vacancy, votes)"],
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
      "featured": true,
      "url": "canonical article URL",
      "image": "hero image URL or null",
      "locations": [{ "label": "human-readable place", "lat": 0.0, "lng": 0.0 }],
      "content": "<p>sanitized article HTML (p/h2/h3/blockquote/ul/ol/li/img/figure/figcaption) or null</p>"
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

## Writing style

Overview and summaries in your own words — short, factual, concrete; lead with numbers where they exist. `keyPoints` are scannable data points, not headlines restated. `content` is mechanical extraction (email body or fetch_article.py output), not rewriting. Section names stay short and reusable day-to-day.
