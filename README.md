# Real Estate Briefing

Personal daily briefing compiled from real estate newsletters (Inman, CRE Daily, CRE Daily New York, The Real Deal).

- **App**: static site (this repo), hosted on GitHub Pages at briefing.pierrepontcompanies.com
- **Data**: Supabase (`days` and `weeks` tables) — the app reads it live, so data updates never require a deploy
- **Pipeline**: a scheduled Claude agent reads the newsletters from Gmail several times a day, synthesizes the briefing, and upserts to Supabase via `scripts/push_data.py`

See `CLAUDE.md` for the pipeline procedure and data schemas.
