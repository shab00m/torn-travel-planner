# AGENTS.md

## Project overview

This repository is the Torn Travel Planner web app. It displays live foreign stock data for Torn travel destinations, powered by the YATA travel export API.

Key facts:
- Node.js 20+
- PostgreSQL-backed app with local Docker or Railway deployment
- Server is Express-based and serves the frontend in `public/`
- App stores snapshots and restock/depletion history in Postgres
- There are dedicated daily and market cron services for Railway

## Core repo guidance

- Keep the app working in its existing Railway project; do not create a second Railway project.
- Do not point the web app at either cron config file.
- Treat the existing service configuration as the source of truth for deployment.
- Prefer the existing project ID and service IDs already configured for this app.

## Shell and command constraints

The user runs Windows PowerShell. Do not use Unix-style shell pipelines such as `curl | node` for testing APIs. Those hang or fail in PowerShell because `curl` is an alias for `Invoke-WebRequest`.

Use one of the following patterns instead:

```powershell
node --input-type=module -e "const j = await (await fetch('http://localhost:3000/api/...')).json(); console.log(j);"
```

```powershell
curl.exe -s "http://localhost:3000/api/..."
```

Never blame the user for failures caused by shell commands the agent chose to run.

## Local development

Run the app with Postgres locally:

```powershell
docker compose up -d
$env:DATABASE_URL = "postgres://travel:travel@localhost:5432/travel_planner"
npm install
npm run migrate
npm start
```

Then open:

```text
http://localhost:3000
```

Notes:
- `DATABASE_URL` is required.
- Schema is applied with `npm run migrate` and also runs on startup.
- `npm run backfill` replays stored snapshots through restock detection.
- `npm run backfill-depletion-rates` fills missing persisted depletion-rate windows.
- `npm run import-sqlite -- data/travel.db` imports an old SQLite file into Postgres when needed.

## Railway deployment constraints

This app is already deployed on Railway. Use the existing project and do not create a new one.

Project details:
- Project name: `torn.automagical.click`
- Project ID: `18b99ba3-c5d4-42a3-a572-4342dca87fd9`
- Environment: production (`7cae12f4-51c9-43d0-b65b-a0a810d8f83d`)
- App service: `torn-travel-planner` (`8daf31fe-ce79-4d68-bd2d-3e813ad431a4`)
- Daily cron: `torn-travel-planner-cron` (`bf4e9c38-c473-4611-affb-e8bd5eafc118`)
- Market cron: `torn-travel-planner-market-cron` (`3315805b-fe01-4379-84c1-a939d0987685`)
- Postgres service: `Postgres` (`8cbfa40a-04c3-4c31-9308-612200e19bf1`)

Railway rules:
1. Always target project ID `18b99ba3-c5d4-42a3-a572-4342dca87fd9`.
2. Never call `project_create` for this app.
3. Add databases/services to this existing project and wire env vars into the relevant service.
4. Prefer Railway MCP tools over inventing a second project.
5. App and both cron services should have `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
6. The market cron also needs `TORN_API_KEY`.

## Cron configuration

Daily cron:
- Service: `torn-travel-planner-cron`
- command: `node scripts/cron-daily.mjs`
- schedule: `0 4 * * *` UTC
- config file: `railway.cron.toml`

Market cron:
- Service: `torn-travel-planner-market-cron`
- command: `node scripts/cron-market.mjs`
- schedule: `*/5 * * * *` UTC
- config file: `railway.market-cron.toml`

These cron services are not the web app; do not attach the web app to either cron config file.

## Repository layout

- `server.js` — Express app and API routes
- `scripts/` — maintenance and cron entrypoints
- `src/` — business logic, DB access, YATA polling, migration helpers
- `public/` — frontend assets and static HTML/JS
- `migrations/` — SQL schema migrations
- `docs/` — API and architecture docs
- `railway.cron.toml` — daily cron config
- `railway.market-cron.toml` — market cron config

## Useful commands

```bash
npm start
npm run migrate
npm run backfill
npm run backfill-depletion-rates
npm run cron-daily
npm run cron-market
```

## Important project notes

- This app uses a local Postgres database plus a scheduled YATA poll loop.
- Restock tracking is persisted and includes depletion/refill events.
- Snapshot retention logic keeps restock/depletion data while pruning old snapshots.
- The app contains a Torn API login flow; ensure you do not hardcode or persist secrets on the server.

## Summary

When working in this repo, follow the existing deployment setup, use PowerShell-safe commands, and avoid changing project identity or deployment topology unless explicitly required.
