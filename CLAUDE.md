# Real Estate News Briefing

A web app that compiles Matthew's real estate newsletters into a daily briefing with an in-app reader, deal map, weekly summary, and history archive.
Static site (no build step): `index.html` + `css/style.css` + `js/app.js`, pipeline helpers in `scripts/`. Leaflet (CDN) powers the map.

- **Hosting**: GitHub Pages, custom domain `briefing.pierrepontcompanies.com` (`CNAME` file). Deploys happen only when app code changes — data never requires a deploy.
- **Data**: Supabase project `uhwdnmbxiopfysodydty` (org ptxdileqdzaovbezrplg) — tables `days` (pk `date`, `data` jsonb, `generated_at`) and `weeks` (pk `week_of`, `data` jsonb, `generated_at`). RLS is open read AND open write on the publishable key (owner's accepted tradeoff, single-user app). The app reads it live via PostgREST.
- **Local dev**: the `briefing` config in `.claude/launch.json` (python3 http.server, port 8420) — the app reads Supabase either way. `data/` holds the pipeline's working JSON files and is gitignored (also keeps subscriber-only article text out of the public repo).

## Architecture

1. A scheduled Claude task (`daily-real-estate-briefing`, cron `10 8,17 * * *`, plus manual "Run now") reads the day's real estate newsletters from Gmail, synthesizes ONE deduped story list, fetches full article text, geocodes deal locations, writes `data/YYYY-MM-DD.json`, updates the rolling week file `data/weeks/<monday>.json`, maintains `data/index.json` (`{dates: [], weeks: []}`), then **publishes with `python3 scripts/push_data.py`** (upserts days + weeks to Supabase). Runs are idempotent: each rebuilds today's file from ALL of today's emails (`after:` today, America/New_York — not `newer_than:1d`), keeping existing story ids stable.
2. The app has four hash-routed views — Briefing (`#/day/DATE`), Map (`#/map`), Weekly (`#/weekly`), History (`#/history`) — plus a full-screen reader overlay (`#/story/DATE/ID`). A masthead refresh button (and auto-refetch every 10 min / on tab focus) re-queries Supabase and re-renders when `generatedAt` changes; pulling NEW emails always happens through a task run, not the page.

## Newsletter sources (Gmail senders)

- Inman Morning Headlines — `select@inman.com` (daily)
- CRE Daily — `mail@news.credaily.com` (daily; often carries full story text in the email)
- CRE Daily New York — `mail@newyork.credaily.com` (daily)
- The Real Deal — `elerts@e.therealdeal.com` (mix of daily elerts, weekly recaps, and special/breaking blasts)

Also include any other newsletter that is clearly real-estate news. Skip welcome/confirmation emails, job alerts, meetup blasts, and promotional one-offs.

## Daily update procedure (for the scheduled task)

1. Search Gmail: `from:(select@inman.com OR mail@news.credaily.com OR mail@newyork.credaily.com OR elerts@e.therealdeal.com) newer_than:1d` — plus a broader pass for other real-estate newsletters received today (America/New_York).
2. For each newsletter, get the message and extract stories from the HTML body. Large bodies get saved to a tool-results file; parse with python (`html.parser`), never by reading raw HTML into context. Tracking links like `link.therealdeal.com/click/<id>/<base64>` decode via urlsafe-base64 (pad with `=`) to the real article URL — strip query params.
3. **Classify cadence** per newsletter edition: `daily` (regular daily edition), `weekly` (weekly recap/digest), or `special` (breaking-news or one-off themed blast). Every story inherits its newsletter's cadence.
4. **Synthesize** ONE deduped story list. Same story in two newsletters → one entry, both names in `sources`. Assign each story a short reusable `section` (New York, Capital Markets, Residential, Development, Policy, Tech, ...). Mark the 3–5 most important `featured: true`.
5. **Geocode**: for stories tied to identifiable places (a property, site, submarket, or city), add `locations: [{label, lat, lng}]` — approximate coordinates from knowledge are fine (city/neighborhood precision; a specific address if confident). Stories with no meaningful geography (national policy, earnings) get `locations: []`.
6. **Reader content** per story, in order of preference: (a) full story text extracted from the email body itself when the newsletter carries it (CRE Daily often does) — include `<figure>/<img>/<figcaption>`; (b) `python3 scripts/fetch_article.py <url>` → JSON `{ok, title, image, html, words}`; if `ok`, use `html` as `content` and `image` as hero; (c) neither → `content: null` (app falls back to summary + link).
7. Write `data/YYYY-MM-DD.json` (schema below). Add the date to `dates` in `data/index.json`.
8. **Weekly rollup**: compute the week's Monday. Rewrite `data/weeks/<monday>.json` from ALL of that week's day files so far (schema below) — synthesize across days, don't just concatenate. Ensure the Monday date is in `weeks` in `data/index.json`.
9. Validate all written files with `python3 -m json.tool`.
10. **Publish**: `python3 scripts/push_data.py` — upserts every local day and week file to Supabase. The hosted app updates within seconds (no deploy involved).

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

## Writing style

Overview and summaries in your own words — short, factual, concrete; lead with numbers where they exist. `keyPoints` are scannable data points, not headlines restated. `content` is mechanical extraction (email body or fetch_article.py output), not rewriting. Section names stay short and reusable day-to-day.
