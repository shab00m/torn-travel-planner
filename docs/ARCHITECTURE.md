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

There is no frontend framework or ORM. Tests use Node's built-in runner (`npm test`). Schema is versioned SQL in `migrations/`, applied by `src/migrate.js` on `npm run migrate` and again when the server starts (`initDb()`).

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
- **Daily cron** purges snapshots older than 30 days, compacts unchanged observations older than 24 hours, and rebuilds hour-of-day depletion averages. It does not touch restock events.
- **Market cron** refreshes stale item-market average prices for travel items only (IDs that appear in `snapshots`), rate-limited to 50 Torn calls/min.

Do not point the web service at `railway.cron.toml` or `railway.market-cron.toml`. Do not create a second Railway project.

## Request and data flow

### Live browser updates

`016_snapshot_notifications.sql` installs an AFTER INSERT statement trigger that
sends one `snapshot_updates` PostgreSQL notification per affected country/item.
Notifications are delivered after commit, including writes made outside Express.
One dedicated pool connection per web process listens and relays them through
`GET /api/snapshots/events` as server-sent events. It reconnects on DB interruption,
maintains global/per-item revision tokens, and sends periodic heartbeats.

Each browser tab shares one EventSource connection. Item and price charts coalesce
pushes for about 100 ms, filter unrelated items, and queue a follow-up if an insert
arrives during an existing refresh. A lightweight two-second revision poll covers
missed/disconnected streams, and returning to a visible tab refreshes immediately.
Only changed revisions redraw the chart; the fallback does not poll full history
every two seconds. Restock alarms bypass their throttle on matching push events;
their normal fallback checks are every two seconds when due or five seconds while
armed. DB-backed latest-stock reads ensure API observations reach quantities and
alarms immediately, without waiting for YATA's separate 60-second polling loop.

### Live stocks (home page)

1. `startPolling()` in `src/yata.js` fetches `https://yata.yt/api/v1/travel/export/` every 60s.
   A 15-second deadline covers both the fetch and response body. It aborts the request and releases the poller even if the network operation fails to settle after abort; late responses are discarded.
2. The latest YATA payload is kept internally in memory; public stock endpoints read committed DB observations from both sources.
3. Persistence is queued separately so a slow `saveSnapshot` cannot skip the next fetch.
4. `saveSnapshot` inserts new `(country, item_id, snapshot_ts, source)` rows (deduped per source on the observation timestamp) and opens/closes `restocks` rows when quantity hits 0 or returns.

`src/current-stocks.js` builds `/api/stocks` using indexed latest-row lookups per
known item/destination, instead of repeatedly scanning raw history. The original
country-grouped response shape remains compatible, with per-item `source` and
`snapshot_ts` added. Country and global timestamps are maxima of the selected DB
observations. Shared reads expire after two seconds and invalidate on snapshot
revision changes; an older in-flight query cannot overwrite a newer revision.
`/api/stocks/status` also uses DB readiness/timestamps, with a direct indexed lookup
for a scoped item. Both endpoints work with API-only data while YATA is unavailable.

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

### Daily snapshot compaction

After the 30-day age purge, `compactUnchangedSnapshots()` removes redundant raw
observations older than 24 hours. For each country/item, agreeing same-time
source duplicates are represented by the API row (or YATA when no API row exists),
then ordered by timestamp. A row is redundant only when both its previous and
next observations have exactly the same quantity and cost, regardless of source.
Thus the first and last rows of each unchanged run survive, retaining the time a
quantity or price first changed. A return to an earlier value after an intervening
change starts a separate run. For `2500,1234,0,0,0,0`, rows 1,2,3,6 survive.

The cutoff is fixed at job start and strictly excludes the most recent 24 hours,
including the exact boundary. Protected recent rows participate in the comparison
but are never deleted; the first row of an old run still survives when that run
continues into the protected window. Conflicting source observations at the same
timestamp are left intact so removing an API observation cannot expose a
previously ignored YATA value. If tied observations agree, only API is retained
when the duplicate is old enough for compaction.

Cleanup commits batches of at most 5,000 deletions per country/item, using the
same advisory key as ingestion. `pg_try_advisory_xact_lock` skips busy items
instead of waiting; the next daily run retries them. Materialized candidate
batches and tuple-ID deletion avoid repeatedly computing window functions for
each deleted row. `--dry-run` counts candidates without acquiring ingest locks
or deleting rows.

Persisted restock events and depletion-rate windows are not modified. Raw history
becomes less granular: an explicit future backfill can only reconstruct cycles
from the retained observations. Normal autovacuum makes deleted space reusable;
existing database/index files may retain their allocated size.

| Table | Role |
| --- | --- |
| `items` | Catalogue (`item_id`, `name`, `item_type`) |
| `snapshots` | YATA/API stock observations; PK `(country, item_id, snapshot_ts, source)` |
| `effective_snapshots` (view) | One observation per country/item/timestamp, preferring `API` over `YATA` for derived calculations |
| `restocks` | Depletion/refill cycles; PK `(country, item_id, depleted_ts)` |
| `market_prices` | Cached Torn average item-market price |
| `restock_amounts` | Admin-set typical restock quantity |
| `empty_for_bounds` | Optional per-item min/max empty-for (seconds) plus stored `avg_empty_for`; drives stockout AVG/MIN/MAX and range outlier exclusion |
| `users` | Allow-list / admin flags (no API keys) |
| `page_views` | Page-load analytics |
| `depletion_rate_tod` | Minute-weighted average rate by UTC hour-of-day |
| `schema_migrations` | Applied migration IDs |

`014_snapshot_source.sql` renames `yata_ts` to `snapshot_ts` without rewriting the
timestamps or dropping indexes, and attributes existing rows to `YATA`. Current
queries, frontend data fields, admin tools, retention, and SQLite import targets
use `snapshot_ts`; legacy SQLite source files still use `yata_ts`.

`015_snapshot_identity_source.sql` extends the primary key with `source`, allowing
both observations at the same timestamp. The `effective_snapshots` view prefers
API for timestamp ties, so derived restock and rate calculations remain deterministic
without duplicate-time transitions. Raw history and source-specific admin tools
retain access to both records; stock/price charts use the same precedence.

`PUT /api/internal/snapshots` accepts up to 100 observations using the server's
`INTERNAL_API_KEY` environment variable via `X-Internal-Key`. Missing or blank
configuration disables ingestion (503); no hardcoded key is used. Source is assigned by the
server. The API upload path validates/authenticates and returns 202 immediately,
then a bounded in-memory background writer inserts each batch using one atomic,
deduplicating SQL statement. It only writes `snapshots`: no metadata updates,
advisory locks, predecessor lookups, restock tracking, or historical replay.
The submitted name remains validated for compatibility; listings use the existing
item catalogue. A full queue returns 503. Completion/errors are logged with the
response's request ID; process exit can lose queued/in-flight uploads.

Committed API inserts use the same database notification/SSE path described above.
Armed browser alarms check authoritative stock without needing restock calculations
to finish. These are item-change notifications, not durable restock jobs.

YATA ingestion retains its ordered per-item advisory locks and derived-history
updates. Its predecessor lookup reads `snapshots` directly with
`ORDER BY snapshot_ts DESC, source ASC LIMIT 1`. It replays an affected suffix when
an inserted observation has newer data or a same-time peer source; otherwise it
tracks the new observation incrementally. API uploads never invoke either path.
Explicit maintenance backfills can incorporate uploaded history into restock/rate
calculations; there is no new automatic derived-history worker.

The column rename is incompatible with old running code. Coordinate the web and
cron rollout so old processes cannot query the database after migration, especially
the daily cron's retention query. No Railway project or service identities change.

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
| `INTERNAL_API_KEY` | Web, when internal ingestion is enabled | Shared secret sent as `X-Internal-Key`. Missing/blank disables ingestion; never exposed to browsers. |
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
| `npm run cron-daily` | Snapshot purge + compaction + TOD rebuild (same as daily Railway cron) |
| `npm run compact-snapshots` | Compact unchanged snapshots older than 24 hours; add `-- --dry-run` to count only |
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
