# Torn Travel Planner

A web app that displays live foreign stock data for [Torn](https://www.torn.com) travel destinations, powered by the [YATA travel export API](https://yata.yt/api/v1/travel/export/).

## Features

- Live stock levels (quantity + cost) for all 11 travel destinations
- Automatic polling of the YATA API every 60 seconds
- Every poll is stored as a snapshot in PostgreSQL, deduplicated by YATA's per-country update timestamp
- Click any item to see a graph of its stock quantity over time (1h / 6h / 24h / 7d / all)
- Restock tracking: depletion (stock hits 0) and refill events are detected on every poll and stored in a `restocks` table. The item popup shades out-of-stock periods on the graph with the restock duration, lists the last 5 restock times, and shows an average over the last 1 / 3 / 5 / 10 / 20 samples
- Depletion rate per in-stock window (restock -> last snapshot before stock hits 0, or -> now while stock lasts) in items/minute, with the same sample-average selector and dashed trend lines overlaid on the graph
- Search filter for items, dropdown filter for countries, and an "in stock only" toggle
- Log in with a Torn API key (**Minimal** access level or higher) to see your alias, travel type (Standard / Airstrip / Private) and total travel item capacity in the header. Capacity is derived from your perks (base capacity + suitcase/faction/book/job bonuses). Business Class Ticket access is not detectable via the API since inventory data is no longer exposed. The key is stored only in your browser's localStorage and relayed to the Torn API per login; the server never persists it. Public keys are not enough — login needs `user` selections `basic` and `perks`. Travel status and market prices use additional selections (`travel`, `itemmarket`). See the API Terms of Service page at `/tos` for how keys and data are stored and shared (Torn’s required disclosure format).

## Requirements

- Node.js >= 20
- PostgreSQL (local via Docker, or Railway)

## Running

```bash
# Local Postgres
docker compose up -d
# PowerShell:
$env:DATABASE_URL = "postgres://travel:travel@localhost:5432/travel_planner"

npm install
npm run migrate
npm start
```

Then open http://localhost:3000.

`DATABASE_URL` is required. Schema is applied by `npm run migrate` (also runs on server startup).

`npm run backfill` replays stored snapshots through the restock detection logic. Closed restocks older than the oldest remaining snapshot per item are preserved.

`npm run backfill-depletion-rates` fills closed restock cycles that are still missing persisted depletion-rate columns. This is not run on server startup.

To import an old SQLite file into Postgres (requires Node >= 23.4 for `node:sqlite`):

```bash
npm run import-sqlite -- data/travel.db
```

## Railway

Production project (do not create a second one):

| Field | Value |
| --- | --- |
| Dashboard | https://railway.com/project/18b99ba3-c5d4-42a3-a572-4342dca87fd9 |
| Project ID | `18b99ba3-c5d4-42a3-a572-4342dca87fd9` |
| Environment | production (`7cae12f4-51c9-43d0-b65b-a0a810d8f83d`) |
| App service | torn-travel-planner (`8daf31fe-ce79-4d68-bd2d-3e813ad431a4`) |
| Daily cron | torn-travel-planner-cron (`bf4e9c38-c473-4611-affb-e8bd5eafc118`) |
| Market cron | torn-travel-planner-market-cron (`3315805b-fe01-4379-84c1-a939d0987685`) |
| Database | Postgres (`8cbfa40a-04c3-4c31-9308-612200e19bf1`) |

App and both cron services should have `DATABASE_URL=${{Postgres.DATABASE_URL}}`. The market cron also needs `TORN_API_KEY`.

### Daily cron

`torn-travel-planner-cron` runs `node scripts/cron-daily.mjs` daily at **04:00 UTC** (`railway.cron.toml`). It:

1. Deletes `snapshots` older than 30 days (restock/depletion events in `restocks` are kept)
2. Rebuilds `depletion_rate_tod` averages

Config-as-code path is `railway.cron.toml`. Local run: `npm run cron-daily`.

### Market cron

`torn-travel-planner-market-cron` runs `node scripts/cron-market.mjs` every **5 minutes** (`railway.market-cron.toml`). It refreshes stale Torn item-market prices into Postgres (rate-limited). The web app only reads that cache.

Config-as-code path is `railway.market-cron.toml`. Local run: `npm run cron-market`.

Rebuild restocks only replaces cycles that still have matching snapshot history; closed restocks older than the oldest remaining snapshot are preserved.

## Project structure

| Path | Purpose |
| --- | --- |
| `server.js` | Express app, API routes, static file serving |
| `scripts/backfill-depletion-rates.mjs` | Manual backfill of missing depletion-rate windows |
| `scripts/cron-daily.mjs` | Daily cron entrypoint (snapshot purge + TOD rebuild) |
| `scripts/cron-market.mjs` | Market cron entrypoint (stale Torn price refresh) |
| `railway.cron.toml` | Config-as-code for the daily cron service only |
| `railway.market-cron.toml` | Config-as-code for the market cron service only |
| `src/yata.js` | YATA API polling loop |
| `src/db.js` | Postgres access, snapshot writes, history queries |
| `src/snapshot-retention.js` | Snapshot age purge (keeps restocks) |
| `src/migrate.js` | SQL migration runner |
| `migrations/` | Versioned schema SQL |
| `src/countries.js` | Country code -> name/flag mapping |
| `src/torn.js` | Torn API key validation + travel perk parsing |
| `src/flight-times.js` | One-way flight duration lookup by country and travel method |
| `public/` | Frontend (vanilla JS + Chart.js) |
| `public/tos.html` | Torn API Terms of Service (key/data disclosure) |
| `public/api-tos.js` | Shared ToS table markup for `/tos` and login forms |
| `docs/API.md` | Full HTTP API reference |
| `docs/ARCHITECTURE.md` | Runtime topology, data flow, schema, and maint commands |

## Docs

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the system is put together (crons, DB, market refresh, maintenance scripts)
- **[docs/API.md](docs/API.md)** — HTTP endpoints, parameters, and response shapes
