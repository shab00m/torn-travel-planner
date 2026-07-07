import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COUNTRIES } from "./src/countries.js";
import { getFlightMatrix } from "./src/flight-times.js";
import { getHistory, getRestocks, getDepletionRates, getSnapshot, updateSnapshot, deleteSnapshot, deleteSnapshots, backfillRestocks, setRestockIgnored } from "./src/db.js";
import { startPolling, getLatest } from "./src/yata.js";
import { getPlayerInfo, getTravelStatus } from "./src/torn.js";
import { getMarketPrice, getCachedMarketPrices, enqueueStaleMarketRefresh, startMarketRefresh, CACHE_TTL_SEC } from "./src/market.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Validate a Torn API key and return player name + travel info.
// The key is only relayed to the Torn API, never stored server-side.
app.post("/api/login", async (req, res) => {
  const apiKey = req.body?.apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    res.status(400).json({ error: "apiKey is required" });
    return;
  }
  try {
    res.json(await getPlayerInfo(apiKey.trim()));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/market", async (req, res) => {
  const itemId = Number.parseInt(req.body?.itemId, 10);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    res.status(400).json({ error: "itemId must be a positive integer" });
    return;
  }
  const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey : undefined;
  try {
    const marketPrice = await getMarketPrice(itemId, apiKey);
    res.json({ itemId, marketPrice });
  } catch (err) {
    res.status(err.message === "API key required for market prices" ? 401 : 502).json({
      error: err.message,
    });
  }
});

app.get("/api/markets", (_req, res) => {
  const { prices, fetchedAt } = getCachedMarketPrices();
  enqueueStaleMarketRefresh();
  res.json({ prices, fetchedAt, cacheTtlSec: CACHE_TTL_SEC });
});

app.post("/api/travel", async (req, res) => {
  const apiKey = req.body?.apiKey;
  const country = req.body?.country;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    res.status(400).json({ error: "apiKey is required" });
    return;
  }
  if (typeof country !== "string" || !COUNTRIES[country]) {
    res.status(400).json({ error: "country is required" });
    return;
  }
  try {
    res.json(await getTravelStatus(apiKey.trim(), country));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/countries", (_req, res) => {
  const flights = getFlightMatrix();
  const enriched = {};
  for (const [code, meta] of Object.entries(COUNTRIES)) {
    enriched[code] = { ...meta, flightSec: flights[code] };
  }
  res.json(enriched);
});

// Latest stock levels for every country (from the most recent successful poll).
app.get("/api/stocks", (_req, res) => {
  const { payload, lastError } = getLatest();
  if (!payload) {
    res.status(503).json({ error: lastError || "No data fetched from YATA yet" });
    return;
  }
  res.json({ stocks: payload.stocks, timestamp: payload.timestamp, lastError });
});

// Lightweight poll probe so clients can detect new YATA snapshots without
// downloading the full stocks payload on every check.
app.get("/api/stocks/status", (_req, res) => {
  const { payload, lastError } = getLatest();
  if (!payload) {
    res.status(503).json({ error: lastError || "No data fetched from YATA yet" });
    return;
  }
  res.json({ timestamp: payload.timestamp, lastError });
});

// Shared validation for routes with :country/:itemId params.
// Sends the error response and returns null when invalid.
function parseItemParams(req, res) {
  const { country, itemId } = req.params;
  if (!COUNTRIES[country]) {
    res.status(400).json({ error: `Unknown country code '${country}'` });
    return null;
  }
  const id = Number.parseInt(itemId, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "itemId must be an integer" });
    return null;
  }
  return { country, id };
}

// Snapshot history for one item in one country.
// Query params: hours (default 24, 0 = everything)
app.get("/api/history/:country/:itemId", (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  const hours = Number.parseFloat(req.query.hours ?? "24");
  if (Number.isNaN(hours) || hours < 0) {
    res.status(400).json({ error: "hours must be a non-negative number" });
    return;
  }
  const since = hours === 0 ? 0 : Math.floor(Date.now() / 1000) - hours * 3600;
  res.json({ country: params.country, itemId: params.id, points: getHistory(params.country, params.id, since) });
});

// Recent out-of-stock periods and in-stock depletion-rate windows for one
// item (newest first). 50 = enough history for cycle table (10 rows) and
// sample averages.
app.get("/api/restocks/:country/:itemId", (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  res.json({
    restocks: getRestocks(params.country, params.id, 50),
    rates: getDepletionRates(params.country, params.id, 50),
  });
});

function parseDepletedTs(req, res) {
  const depletedTs = Number.parseInt(req.params.depletedTs, 10);
  if (!Number.isInteger(depletedTs) || depletedTs <= 0) {
    res.status(400).json({ error: "depletedTs must be a positive integer" });
    return null;
  }
  return depletedTs;
}

app.patch("/api/restocks/:country/:itemId/:depletedTs", (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  const depletedTs = parseDepletedTs(req, res);
  if (depletedTs == null) return;
  const ignored = req.body?.ignored;
  if (typeof ignored !== "boolean") {
    res.status(400).json({ error: "ignored must be a boolean" });
    return;
  }
  try {
    setRestockIgnored(params.country, params.id, depletedTs, ignored);
    res.json({
      ok: true,
      restocks: getRestocks(params.country, params.id, 50),
      rates: getDepletionRates(params.country, params.id, 50),
    });
  } catch (err) {
    res.status(err.message === "Restock cycle not found" ? 404 : 400).json({ error: err.message });
  }
});

function parseYataTs(req, res) {
  const yataTs = Number.parseInt(req.params.yataTs, 10);
  if (!Number.isInteger(yataTs) || yataTs <= 0) {
    res.status(400).json({ error: "yataTs must be a positive integer" });
    return null;
  }
  return yataTs;
}

function rerunRestocks(country, itemId) {
  backfillRestocks();
  return {
    restocks: getRestocks(country, itemId, 50),
    rates: getDepletionRates(country, itemId, 50),
  };
}

app.post("/api/snapshots/:country/:itemId/delete", (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  const list = req.body?.yata_ts;
  if (!Array.isArray(list) || !list.length) {
    res.status(400).json({ error: "yata_ts array is required" });
    return;
  }
  if (!list.every((ts) => Number.isInteger(ts) && ts > 0)) {
    res.status(400).json({ error: "yata_ts values must be positive integers" });
    return;
  }
  try {
    const deleted = deleteSnapshots(params.country, params.id, list);
    const { restocks, rates } = rerunRestocks(params.country, params.id);
    res.json({ ok: true, deleted, restocks, rates });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/snapshots/:country/:itemId/:yataTs", (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  const yataTs = parseYataTs(req, res);
  if (yataTs == null) return;
  const row = getSnapshot(params.country, params.id, yataTs);
  if (!row) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }
  res.json({ country: params.country, itemId: params.id, ...row });
});

app.patch("/api/snapshots/:country/:itemId/:yataTs", (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  const yataTs = parseYataTs(req, res);
  if (yataTs == null) return;
  const body = req.body ?? {};
  if (body.quantity != null && !Number.isInteger(body.quantity)) {
    res.status(400).json({ error: "quantity must be an integer" });
    return;
  }
  if (body.cost != null && !Number.isInteger(body.cost)) {
    res.status(400).json({ error: "cost must be an integer" });
    return;
  }
  if (body.yata_ts != null && !Number.isInteger(body.yata_ts)) {
    res.status(400).json({ error: "yata_ts must be an integer" });
    return;
  }
  try {
    const updated = updateSnapshot(params.country, params.id, yataTs, body);
    const { restocks, rates } = rerunRestocks(params.country, params.id);
    res.json({ ok: true, snapshot: updated, restocks, rates });
  } catch (err) {
    res.status(err.message === "Snapshot not found" ? 404 : 400).json({ error: err.message });
  }
});

app.delete("/api/snapshots/:country/:itemId/:yataTs", (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  const yataTs = parseYataTs(req, res);
  if (yataTs == null) return;
  try {
    deleteSnapshot(params.country, params.id, yataTs);
    const { restocks, rates } = rerunRestocks(params.country, params.id);
    res.json({ ok: true, restocks, rates });
  } catch (err) {
    res.status(err.message === "Snapshot not found" ? 404 : 400).json({ error: err.message });
  }
});

app.get("/item/:country/:itemId(\\d+)", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "item.html"));
});

app.get("/item/:country/:itemId(\\d+)/price", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "item-price.html"));
});

app.listen(PORT, () => {
  console.log(`Torn Travel Planner running at http://localhost:${PORT}`);
  startPolling();
  startMarketRefresh();
});
