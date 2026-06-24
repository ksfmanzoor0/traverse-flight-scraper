# traverse-flight-scraper

Queries the Aeroglobe agent portal API for domestic Pakistan flight fares (PIA, AirBlue, AirSial, Flyjinnah) every 12h via GitHub Actions and writes results to a Supabase `flight_routes` table consumed by the traverse-pakistan quote engine and `/admin/flight-fares` page.

## Why Aeroglobe (not scraping)

Traverse Pakistan already books flights through Aeroglobe. Their API returns
**agent-priced fares** (i.e. the actual price we'd pay at booking, with our
commission applied) — not public retail. Earlier attempts to scrape PIA / AirBlue
/ AirSial / Sastaticket / Gozayaan all failed on enterprise Cloudflare or
fingerprint-bound auth. This source bypasses all of that with our own credentials.

## Routes (`src/config.ts`)
KHI↔KDU · LHE↔KDU · ISB↔KDU · ISB↔GIL · KHI↔ISB · LHE↔ISB · KHI↔LHE · KHI↔GWD · ISB↔GWD

Per route, per cron run:
- 1 one-way fare at each of +7, +30, +60, +90 days
- 1 return-trip fare per [5-night, 7-night] gap at each horizon
- ~12 searches per route × 9 routes = ~108 searches per run (~24 min total)

Aeroglobe groups multiple airlines into a single response, so coverage of
PIA/AirBlue/AirSial is automatic.

## Local development

```bash
npm install
cp .env.example .env       # fill AEROGLOBE_EMAIL + AEROGLOBE_PASSWORD
npm run scrape:dry         # writes to ./out/fares-*.json, no Supabase needed
```

Once dry-run looks sane, create the Supabase tables (see below) and:

```bash
DRY_RUN=false npm run scrape:once
```

## Supabase tables

### `flight_routes` — scraped fares

```sql
create table flight_routes (
  id              uuid primary key default gen_random_uuid(),
  origin          text not null,
  destination     text not null,
  airline         text not null,
  flight_numbers  text[],
  route_type      text not null check (route_type in ('ONEWAY','RETURN')),
  depart_date     date not null,
  return_date     date,
  fare_total      integer not null,
  base_fare       integer,
  tax             integer,
  rbd             text,
  is_refundable   boolean,
  currency        text not null default 'PKR',
  source          text not null,                 -- 'aeroglobe' | 'manual'
  source_url      text,
  scraped_at      timestamptz not null default now(),
  unique (origin, destination, airline, route_type, depart_date, return_date, source)
);
create index flight_routes_lookup_idx
  on flight_routes (origin, destination, route_type, depart_date);
```

### `flight_scraper_config` — credentials + kill switch

```sql
create table flight_scraper_config (
  id                  text primary key default 'default',
  aeroglobe_email     text,
  aeroglobe_password  text,
  scrape_enabled      boolean default true,
  updated_at          timestamptz default now(),
  updated_by          text
);
insert into flight_scraper_config (id) values ('default') on conflict do nothing;
-- Service-role only — no anon/authenticated policies. The /admin page uses
-- the service-role key server-side.
alter table flight_scraper_config enable row level security;
```

The scraper looks up credentials in this order:
1. `flight_scraper_config` row (admin-managed via traverse-pakistan `/admin/flight-fares`)
2. `AEROGLOBE_EMAIL` / `AEROGLOBE_PASSWORD` env vars (GitHub Secrets fallback)

If `scrape_enabled = false` the runner exits early — a quick kill switch from /admin.

## GitHub Actions deploy

1. Push this repo to GitHub
2. In the repo: **Settings → Secrets and variables → Actions → New repository secret**
   - `SUPABASE_URL` — your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — service-role key
   - `AEROGLOBE_EMAIL` (optional fallback) — agent email
   - `AEROGLOBE_PASSWORD` (optional fallback) — agent password
3. The workflow at `.github/workflows/scrape-flights.yml` runs every 12h automatically
4. Manual trigger anytime: **Actions tab → Scrape Flight Fares → Run workflow**

Free for ~1440 min/month (12h × 24 min × 30 days) — well under the 2000 min/month free private-repo limit.

## Architecture

```
src/
├── config.ts              # 9 routes × 4 horizons × ONEWAY+RETURN[5n,7n]
├── credentials.ts         # Supabase config → env fallback resolution
├── runner.ts              # login + iterate routes/dates, dedupe, persist
├── storage.ts             # Supabase upsert OR ./out/*.json when DRY_RUN
├── types.ts               # FareRow shape
└── scrapers/
    └── aeroglobe.ts       # login + poll-loop search + parse flight_options
```

## Notes

- **JWT life**: access 3h, refresh 24h. With 12h cron we just re-login every run.
- **Polling**: `flight_options[]` arrives ~5-15s after first POST. Retry every 1.5s up to 15 times (~22s budget per search).
- **Empty results**: `keep_polling=false` with empty `flight_options` = no flights operate that date — we record nothing for that scrape rather than failing.
- **Multi-airline**: Aeroglobe consolidates PIA / AirBlue / AirSial / Flyjinnah into one response. Scraper normalizes airline names to a fixed enum.
- **Kill switch**: set `flight_scraper_config.scrape_enabled = false` from /admin to pause without disabling the workflow.
