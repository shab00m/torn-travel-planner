# Technical architecture

Developer-oriented overview of how Torn Travel Planner is put together. Product setup and Railway IDs live in [README.md](../README.md). HTTP contracts live in [API.md](./API.md).

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js >= 20, ESM (`"type": "module"`) |
| HTTP | Express (`server.js`) |
| Database | PostgreSQL (`pg` pool in `src/pg.js`) |
| Frontend | Vanilla JS + Chart.js under `public/` (no bundler) |
| Hosting | One Railway project: web app, two cron services, Postgres |

There is no framework, ORM, or test runner. Schema is versioned SQL in `migrations/`, applied by `src/migrate.js` on `npm run migrate` and again when the server starts (`initDb()`).

## Runtime topology

```mermaid
flowchart LR
  browser[Browser]
  web[torn-travel-planner<br/>Express + YATA poll]
  daily[torn-travel-planner-cron<br/>04:00 UTC]
  market[torn-travel-planner-market-cron<br/>every 5 min]
  pg[(Postgres)]
  yata[YATA travel export]
  torn[Torn API v2]

  browser --> web
  web --> pg
  web --> yata
  web --> torn
  daily --> pg
  market --> pg
  market --> torn
```

- **Web** serves static files and JSON APIs, polls YATA every 60s, and writes snapshots/restocks. It does **not** refresh Torn market prices in the background.
- **Daily cron** purges snapshots older than 30 days and rebuilds hour-of-day depletion averages. It does not touch restock events.
- **Market cron** refreshes stale item-market average prices for travel items only (IDs that appear in `snapshots`), rate-limited to 50 Torn calls/min.

Do not point the web service at `railway.cron.toml` or `railway.market-cron.toml`. Do not create a second Railway project.

## Request and data flow

### Live stocks (home page)

1. `startPolling()` in `src/yata.js` fetches `https://yata.yt/api/v1/travel/export/` every 60s.
2. The latest payload is kept in memory and served as `GET /api/stocks`.
3. Persistence is queued separately so a slow `saveSnapshot` cannot skip the next fetch.
4. `saveSnapshot` inserts new `(country, item_id, yata_ts)` rows (deduped on YATA’s per-country update time) and opens/closes `restocks` rows when quantity hits 0 or returns.

### Item page

The item page loads history, restocks, depletion rates, market price, travel status, and safe windows from `/api/*`. Chart math and restock-time adjustment helpers in `public/` are imported by the server where the same formula must stay a single source of truth (`public/adjust-restock-time.js`, `public/empty-for-bounds.js`).

### Market prices

| Path | Who calls Torn | Key used |
| --- | --- | --- |
| `GET /api/markets` | Nobody | Reads `market_prices` cache only |
| `POST /api/market` | Web, on cache miss | Visitor’s API key only |
| `npm run cron-market` | Market cron | Server `TORN_API_KEY` |

`items` may contain the full Torn catalogue (populated once for `item_type`). Market refresh **must not** iterate that table — only distinct `snapshots.item_id` values. Unused catalogue IDs (e.g. Torn error 6 “Incorrect ID”) are not travel goods.

Failed fetches still write `market_price = null` and `fetched_at = now`, so the row is treated as fresh for `MARKET_CACHE_TTL_SEC` (default 300s).

## Postgres

Timestamps are Unix seconds (`BIGINT`). `pg` parses `INT8` as JS numbers.

| Table | Role |
| --- | --- |
| `items` | Catalogue (`item_id`, `name`, `item_type`) |
| `snapshots` | Raw YATA stock samples; PK `(country, item_id, yata_ts)` |
| `restocks` | Depletion/refill cycles; PK `(country, item_id, depleted_ts)` |
| `market_prices` | Cached Torn average item-market price |
| `restock_amounts` | Admin-set typical restock quantity |
| `empty_for_bounds` | Optional per-item min/max empty-for (seconds); drives stockout MIN/MAX and range outlier exclusion |
| `users` | Allow-list / admin flags (no API keys) |
| `page_views` | Page-load analytics |
| `depletion_rate_tod` | Minute-weighted average rate by UTC hour-of-day |
| `schema_migrations` | Applied migration IDs |

Important `restocks` columns beyond the PK:

- `restocked_ts`, `duration`, `ignored`
- `rate_start_qty`, `rate_end_ts`, `rate_end_qty` — persisted in-stock depletion window
- `adjusted_restocked_ts`, `adjusted_depleted_ts`, `adjusted_duration` — rate-extrapolated times; raw snapshot keys stay on `depleted_ts` / `restocked_ts`

Country codes: `mex`, `cay`, `can`, `haw`, `uni`, `arg`, `swi`, `jap`, `chi`, `uae`, `sou`.

## Domain logic

### Restock cycles

A cycle starts when stock hits 0 (`depleted_ts` = first observed empty snapshot) and closes when stock returns (`restocked_ts`). Admins can ignore outliers. Closed cycles older than the oldest remaining snapshot for that item are **kept** when restocks are rebuilt; only in-window cycles are replaced.

Live YATA saves finalize the previous cycle’s rate window (`finalizeRateWindowOnDepletion`). That is the normal write path for depletion rates.

### Depletion rates

Rate = items/minute over `[restocked_ts, last positive snapshot before next depletion]` (or “now” while still in stock).

`ensurePersistedRates()` fills closed cycles that never got `rate_end_ts`. It is **not** run on startup. After a healthy period of live polling it should be a no-op. If gaps exist (timeouts, old data), run the maintenance script:

```bash
npm run backfill-depletion-rates
```

That command:

1. Checks whether any non-ignored closed cycle is missing rate columns.
2. If none, prints `no missing rate windows` and exits.
3. Otherwise recomputes windows from snapshots for those items only.
4. Logs and continues if a single item fails (e.g. statement timeout).

Related: `npm run backfill` rebuilds restock **events** from snapshots (different job).

### Time-of-day rates

`depletion_rate_tod` is rebuilt by the daily cron from completed, non-ignored rate windows. Used by safe-window estimates when hour-of-day matters.

### Safe windows

`src/safe-windows.js` estimates when you can leave Torn City, fly, shop, and still find stock, using flight times (`src/flight-times.js`), restock history, depletion rate, and optional TOD rates. Favorites on the home page batch this via `/api/safe-windows`.

### Auth

- Torn API keys live in the **browser** (`localStorage`) only. The server relays them to Torn and never stores them.
- First login auto-creates a `users` row with `is_allowed = true` (blacklist by unchecking Allowed).
- Admin routes use `requireAdmin` (`X-Api-Key` or JSON `apiKey`).
- A bootstrap admin is seeded on startup (`src/users.js` `BOOTSTRAP_ADMIN`). Existing flags are never overwritten.

## Frontend

| Page | Files |
| --- | --- |
| Home (stocks + favorites) | `index.html`, `app.js`, `shared.js` |
| Item history | `item.html`, `item.js`, chart helpers |
| Item price | `item-price.html`, `item-price.js` |
| Users (admin) | `users.html`, `users.js` |
| Analytics (admin) | `analytics.html`, `analytics.js` |
| API ToS | `tos.html`, `api-tos.js` |

`public/shared.js` holds shared state, favorites/hidden-item localStorage, and formatting. Prefer extending an existing helper over copying UI logic.

## Environment

Scripts that need DB/API config import `scripts/load-local-env.mjs` first. It loads `.env` via `process.loadEnvFile` when the file exists and does not override variables already set (Railway wins). `.env` is gitignored.

| Variable | Required by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Web, both crons, all DB scripts | Local Docker: `postgres://travel:travel@localhost:5432/travel_planner`. From a laptop against Railway, use `DATABASE_PUBLIC_URL` (internal `*.railway.internal` hosts do not resolve off-platform). |
| `DATABASE_SSL` | Optional | `true` forces SSL. Also auto-enabled for `proxy.rlwy.net` / `railway.app` / `sslmode=require`. |
| `TORN_API_KEY` | Market cron; item-type populate | Server key. Not used per browser client for market refresh. |
| `PORT` | Web | Default `3000` locally; Railway injects this. |
| `MARKET_CACHE_TTL_SEC` | Market | Default `300`. |
| `MARKET_CALLS_PER_MINUTE` | Market | Default `50`. |

Pool settings (`src/pg.js`): `statement_timeout` 60s (startup parameter, not a racing `SET` on connect), connect timeout 15s.

## npm scripts

| Command | What it does |
| --- | --- |
| `npm start` | `scripts/start.mjs` — frees local port 3000 if needed, then boots `server.js` |
| `npm run migrate` | Apply `migrations/*.sql` in ID order |
| `npm run backfill` | Replay snapshots into restock open/close events |
| `npm run backfill-depletion-rates` | Fill missing persisted depletion-rate columns (manual) |
| `npm run cron-daily` | Snapshot purge + TOD rebuild (same as daily Railway cron) |
| `npm run cron-market` | Refresh stale travel-item market prices (same as market cron) |
| `npm run import-sqlite -- data/travel.db` | Copy an old SQLite file into Postgres (Node >= 23.4) |
| `npm run pull-railway-sqlite` | Historical helper for pulling a remote SQLite file |
| `npm run db-counts` | Print row counts for main tables |

## Local development

```bash
docker compose up -d
# PowerShell if you are not using .env:
$env:DATABASE_URL = "postgres://travel:travel@localhost:5432/travel_planner"
npm install
npm run migrate
npm start
```

Or put `DATABASE_URL` (and optionally `TORN_API_KEY`) in `.env`.

If you point local `npm start` at **production** Postgres:

- You share the live dataset. Be careful with writes (ignore flags, snapshot deletes, user admin).
- Do not run a second market refresh against the same `TORN_API_KEY` as production (rate limit error 5). Local web no longer background-refreshes prices; `npm run cron-market` still would.

On Windows PowerShell, `curl` is `Invoke-WebRequest`. Use `curl.exe` or `node --input-type=module -e "…fetch…"` to hit local APIs.

## Logging

There is no API-call log table. Torn/YATA errors go to process stdout/stderr.

- Local: the terminal running `npm start` or a script.
- Railway: service → Deployments → latest run → Logs. Cron jobs create a new short-lived deployment each tick.
  - Market: `torn-travel-planner-market-cron`, filter `[market]`
  - Daily: `torn-travel-planner-cron`
  - Web: `torn-travel-planner`

```powershell
railway logs --service torn-travel-planner-market-cron
```

## Conventions

- Prefer one implementation of a formula (share `public/` helpers with the server if both need it).
- Do not add hardcoded fallback values; fail loudly if config or data is missing.
- Keep modules focused. `src/db.js` is already large — new query families belong in their own module (see `depletion-rates.js`, `snapshot-retention.js`).
- Railway: add services to project `18b99ba3-c5d4-42a3-a572-4342dca87fd9` only. Wire `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
- A `PoolClient` cannot run two queries at once (`Promise.all` on the same client will break in `pg@9`). Parallel queries must use the pool, not a checked-out client.
