# Torn Travel Planner

A web app that displays live foreign stock data for [Torn](https://www.torn.com) travel destinations, powered by the [YATA travel export API](https://yata.yt/api/v1/travel/export/).

## Features

- Live stock levels (quantity + cost) for all 11 travel destinations
- Automatic polling of the YATA API every 60 seconds
- Every poll is stored as a snapshot in a local SQLite database, deduplicated by YATA's per-country update timestamp
- Click any item to see a graph of its stock quantity over time (1h / 6h / 24h / 7d / all)
- Restock tracking: depletion (stock hits 0) and refill events are detected on every poll and stored in a `restocks` table. The item popup shades out-of-stock periods on the graph with the restock duration, lists the last 5 restock times, and shows an average over the last 1 / 3 / 5 / 10 / 20 samples
- Depletion rate per in-stock window (restock -> last snapshot before stock hits 0, or -> now while stock lasts) in items/minute, with the same sample-average selector and dashed trend lines overlaid on the graph
- Search filter for items, dropdown filter for countries, and an "in stock only" toggle
- Log in with a Torn API key (public access level is enough) to see your alias, travel type (Standard / Airstrip / Private) and total travel item capacity in the header. Capacity is derived from your perks (base capacity + suitcase/faction/book/job bonuses). Business Class Ticket access is not detectable via the API since inventory data is no longer exposed. The key is stored only in your browser's localStorage and relayed to the Torn API per login; the server never persists it.

## Requirements

- Node.js >= 23.4 (uses the built-in `node:sqlite` module — no native build tools needed)

## Running

```bash
npm install
npm start
```

Then open http://localhost:3000.

The SQLite database is created automatically at `data/travel.db`. History accumulates while the server is running.

`npm run backfill` replays all stored snapshots through the restock detection logic and rebuilds the restocks table from scratch.

## Project structure

| Path | Purpose |
| --- | --- |
| `server.js` | Express app, API routes, static file serving |
| `src/yata.js` | YATA API polling loop |
| `src/db.js` | SQLite schema, snapshot writes, history queries |
| `src/countries.js` | Country code -> name/flag mapping |
| `src/torn.js` | Torn API key validation + travel perk parsing |
| `src/flight-times.js` | One-way flight duration lookup by country and travel method |
| `public/` | Frontend (vanilla JS + Chart.js) |

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/countries` | Country code metadata |
| `GET /api/stocks` | Latest YATA payload |
| `GET /api/history/:country/:itemId?hours=24` | Snapshot history (`hours=0` for all) |
| `GET /api/restocks/:country/:itemId` | Recent out-of-stock periods with durations plus depletion-rate windows, newest first |
| `POST /api/login` | Body `{ "apiKey": "..." }` — validates the key and returns player + travel info |
