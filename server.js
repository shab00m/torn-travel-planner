import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COUNTRIES } from "./src/countries.js";
import { getFlightMatrix } from "./src/flight-times.js";
import {
  initDb,
  getHistory,
  getRestocks,
  getDepletionRates,
  getSnapshot,
  updateSnapshot,
  deleteSnapshot,
  deleteSnapshots,
  backfillRestocksForItem,
  setRestockIgnored,
  flagOutlierRestocks,
  getRestockAmount,
  getAllRestockAmounts,
  setRestockAmount,
  deleteRestockAmount,
} from "./src/db.js";
import { startPolling, getLatest } from "./src/yata.js";
import { getTravelStatus } from "./src/torn.js";
import {
  getMarketPrice,
  getCachedMarketPrices,
  enqueueStaleMarketRefresh,
  startMarketRefresh,
  CACHE_TTL_SEC,
} from "./src/market.js";
import { computeNextSafeWindow, computeSafeWindowsBatch } from "./src/safe-windows.js";
import { requireAdmin, resolveAllowedUser } from "./src/auth.js";
import { listUsers, createUser, updateUser, deleteUser, seedBootstrapAdmin } from "./src/users.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Validate a Torn API key, enforce whitelist, return player + role flags.
// The key is only relayed to the Torn API, never stored server-side.
app.post("/api/login", async (req, res) => {
  const apiKey = req.body?.apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    res.status(400).json({ error: "apiKey is required" });
    return;
  }
  try {
    const { player, user } = await resolveAllowedUser(apiKey.trim());
    res.json({
      ...player,
      isAdmin: user.isAdmin,
      isAllowed: user.isAllowed,
    });
  } catch (err) {
    const status = err.statusCode === 403 ? 403 : 502;
    res.status(status).json({ error: err.message });
  }
});

app.get("/api/users", requireAdmin, async (_req, res) => {
  res.json({ users: await listUsers() });
});

app.post("/api/users", requireAdmin, async (req, res) => {
  try {
    const playerId = Number.parseInt(req.body?.playerId, 10);
    const user = await createUser({
      playerId,
      name: req.body?.name,
      isAdmin: Boolean(req.body?.isAdmin),
      isAllowed: req.body?.isAllowed !== undefined ? Boolean(req.body.isAllowed) : true,
    });
    res.status(201).json(user);
  } catch (err) {
    const status = err.message === "User already exists" ? 409 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.patch("/api/users/:playerId", requireAdmin, async (req, res) => {
  const playerId = Number.parseInt(req.params.playerId, 10);
  if (!Number.isInteger(playerId) || playerId <= 0) {
    res.status(400).json({ error: "playerId must be a positive integer" });
    return;
  }
  const body = req.body ?? {};
  const fields = {};
  if (body.name !== undefined) fields.name = body.name;
  if (body.isAdmin !== undefined) fields.isAdmin = Boolean(body.isAdmin);
  if (body.isAllowed !== undefined) fields.isAllowed = Boolean(body.isAllowed);
  try {
    if (req.auth.user.playerId === playerId) {
      if (fields.isAdmin === false || fields.isAllowed === false) {
        res.status(400).json({ error: "Cannot demote or disallow your own account" });
        return;
      }
    }
    res.json(await updateUser(playerId, fields));
  } catch (err) {
    const status = err.message === "User not found" ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.delete("/api/users/:playerId", requireAdmin, async (req, res) => {
  const playerId = Number.parseInt(req.params.playerId, 10);
  if (!Number.isInteger(playerId) || playerId <= 0) {
    res.status(400).json({ error: "playerId must be a positive integer" });
    return;
  }
  if (req.auth.user.playerId === playerId) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }
  try {
    await deleteUser(playerId);
    res.json({ ok: true });
  } catch (err) {
    const status = err.message === "User not found" ? 404 : 400;
    res.status(status).json({ error: err.message });
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

app.get("/api/markets", async (_req, res) => {
  const { prices, fetchedAt } = await getCachedMarketPrices();
  void enqueueStaleMarketRefresh();
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
// Returns 200 even while warming up so the status watcher does not spam 503s.
app.get("/api/stocks/status", (_req, res) => {
  const { payload, lastError } = getLatest();
  res.json({
    ready: Boolean(payload),
    timestamp: payload?.timestamp ?? null,
    lastError,
  });
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
app.get("/api/history/:country/:itemId", async (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  const hours = Number.parseFloat(req.query.hours ?? "24");
  if (Number.isNaN(hours) || hours < 0) {
    res.status(400).json({ error: "hours must be a non-negative number" });
    return;
  }
  const since = hours === 0 ? 0 : Math.floor(Date.now() / 1000) - hours * 3600;
  res.json({
    country: params.country,
    itemId: params.id,
    points: await getHistory(params.country, params.id, since),
  });
});

// Recent out-of-stock periods and in-stock depletion-rate windows for one
// item (newest first). 50 = enough history for cycle table (10 rows) and
// sample averages.
app.get("/api/restocks/:country/:itemId", async (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  const [restocks, rates] = await Promise.all([
    getRestocks(params.country, params.id, 50),
    getDepletionRates(params.country, params.id, 50),
  ]);
  res.json({ restocks, rates });
});

app.get("/api/restock-amounts", async (_req, res) => {
  res.json({ amounts: await getAllRestockAmounts() });
});

app.get("/api/restock-amounts/:country/:itemId", async (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  res.json({
    country: params.country,
    itemId: params.id,
    amount: await getRestockAmount(params.country, params.id),
  });
});

app.put("/api/restock-amounts/:country/:itemId", async (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  const amount = req.body?.amount;
  if (amount == null) {
    await deleteRestockAmount(params.country, params.id);
    res.json({ country: params.country, itemId: params.id, amount: null });
    return;
  }
  const parsed = Number.parseInt(amount, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    res.status(400).json({ error: "amount must be a positive integer" });
    return;
  }
  try {
    await setRestockAmount(params.country, params.id, parsed);
    res.json({ country: params.country, itemId: params.id, amount: parsed });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function parseSafeWindowOptions(query = {}, body = {}) {
  const src = { ...query, ...body };
  const opts = {};
  if (src.restockAmount != null) {
    const amount = Number.parseInt(src.restockAmount, 10);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error("restockAmount must be a positive integer");
    }
    opts.restockAmount = amount;
  }
  if (src.travelType != null) {
    if (typeof src.travelType !== "string") throw new Error("travelType must be a string");
    opts.travelType = src.travelType;
  }
  if (src.flightTimeVariance != null) {
    opts.flightTimeVariance = src.flightTimeVariance === true || src.flightTimeVariance === "true";
  }
  if (src.safeWindowUseRateSelection != null) {
    opts.safeWindowUseRateSelection =
      src.safeWindowUseRateSelection === true || src.safeWindowUseRateSelection === "true";
  }
  if (src.predictionHours != null) {
    const hours = Number.parseFloat(src.predictionHours);
    if (Number.isNaN(hours) || hours <= 0) throw new Error("predictionHours must be a positive number");
    opts.predictionHours = hours;
  }
  for (const key of ["avgSamples", "avgRateSamples"]) {
    if (src[key] != null) {
      const n = Number.parseInt(src[key], 10);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${key} must be a positive integer`);
      opts[key] = n;
    }
  }
  for (const key of ["stockoutTiming", "rateTiming"]) {
    if (src[key] != null) {
      if (!["avg", "min", "max"].includes(src[key])) {
        throw new Error(`${key} must be avg, min, or max`);
      }
      opts[key] = src[key];
    }
  }
  return opts;
}

app.get("/api/safe-window/:country/:itemId", async (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  try {
    const opts = parseSafeWindowOptions(req.query);
    res.json(await computeNextSafeWindow(params.country, params.id, opts));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/safe-windows", async (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || !items.length) {
    res.status(400).json({ error: "items array is required" });
    return;
  }
  const parsed = [];
  for (const raw of items) {
    const country = raw?.country;
    const itemId = Number.parseInt(raw?.itemId, 10);
    if (typeof country !== "string" || !COUNTRIES[country]) {
      res.status(400).json({ error: "each item needs a valid country code" });
      return;
    }
    if (!Number.isInteger(itemId) || itemId <= 0) {
      res.status(400).json({ error: "each item needs a positive integer itemId" });
      return;
    }
    const entry = { country, itemId };
    if (raw.restockAmount != null) {
      const amount = Number.parseInt(raw.restockAmount, 10);
      if (!Number.isInteger(amount) || amount <= 0) {
        res.status(400).json({ error: "restockAmount must be a positive integer" });
        return;
      }
      entry.restockAmount = amount;
    }
    parsed.push(entry);
  }
  try {
    const opts = parseSafeWindowOptions({}, req.body);
    res.json({ windows: await computeSafeWindowsBatch(parsed, opts) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function parseDepletedTs(req, res) {
  const depletedTs = Number.parseInt(req.params.depletedTs, 10);
  if (!Number.isInteger(depletedTs) || depletedTs <= 0) {
    res.status(400).json({ error: "depletedTs must be a positive integer" });
    return null;
  }
  return depletedTs;
}

app.patch("/api/restocks/:country/:itemId/:depletedTs", requireAdmin, async (req, res) => {
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
    await setRestockIgnored(params.country, params.id, depletedTs, ignored);
    const [restocks, rates] = await Promise.all([
      getRestocks(params.country, params.id, 50),
      getDepletionRates(params.country, params.id, 50),
    ]);
    res.json({ ok: true, restocks, rates });
  } catch (err) {
    res.status(err.message === "Restock cycle not found" ? 404 : 400).json({ error: err.message });
  }
});

/** Exclude outlier cycles from averages for one item. */
app.post("/api/restocks/:country/:itemId/flag-outliers", requireAdmin, async (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  try {
    const result = await flagOutlierRestocks(params.country, params.id);
    const [restocks, rates] = await Promise.all([
      getRestocks(params.country, params.id, 50),
      getDepletionRates(params.country, params.id, 50),
    ]);
    res.json({
      ok: true,
      flagged: result.flagged,
      depletedTs: result.depletedTs,
      restocks,
      rates,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Rebuild restock cycles for one item from its snapshot history. */
app.post("/api/restocks/:country/:itemId/backfill", requireAdmin, async (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  try {
    const result = await backfillRestocksForItem(params.country, params.id);
    const [restocks, rates] = await Promise.all([
      getRestocks(params.country, params.id, 50),
      getDepletionRates(params.country, params.id, 50),
    ]);
    res.json({
      ok: true,
      opened: result.opened,
      closed: result.closed,
      restocks,
      rates,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
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

async function rerunRestocks(country, itemId) {
  await backfillRestocksForItem(country, itemId);
  const [restocks, rates] = await Promise.all([
    getRestocks(country, itemId, 50),
    getDepletionRates(country, itemId, 50),
  ]);
  return { restocks, rates };
}

app.post("/api/snapshots/:country/:itemId/delete", requireAdmin, async (req, res) => {
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
    const deleted = await deleteSnapshots(params.country, params.id, list);
    const { restocks, rates } = await rerunRestocks(params.country, params.id);
    res.json({ ok: true, deleted, restocks, rates });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/snapshots/:country/:itemId/:yataTs", async (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  const yataTs = parseYataTs(req, res);
  if (yataTs == null) return;
  const row = await getSnapshot(params.country, params.id, yataTs);
  if (!row) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }
  res.json({ country: params.country, itemId: params.id, ...row });
});

app.patch("/api/snapshots/:country/:itemId/:yataTs", requireAdmin, async (req, res) => {
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
    const updated = await updateSnapshot(params.country, params.id, yataTs, body);
    const { restocks, rates } = await rerunRestocks(params.country, params.id);
    res.json({ ok: true, snapshot: updated, restocks, rates });
  } catch (err) {
    res.status(err.message === "Snapshot not found" ? 404 : 400).json({ error: err.message });
  }
});

app.delete("/api/snapshots/:country/:itemId/:yataTs", requireAdmin, async (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  const yataTs = parseYataTs(req, res);
  if (yataTs == null) return;
  try {
    await deleteSnapshot(params.country, params.id, yataTs);
    const { restocks, rates } = await rerunRestocks(params.country, params.id);
    res.json({ ok: true, restocks, rates });
  } catch (err) {
    res.status(err.message === "Snapshot not found" ? 404 : 400).json({ error: err.message });
  }
});

app.get("/users", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "users.html"));
});

app.get("/item/:country/:itemId(\\d+)", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "item.html"));
});

app.get("/item/:country/:itemId(\\d+)/price", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "item-price.html"));
});

await initDb();
await seedBootstrapAdmin();

app.listen(PORT, () => {
  console.log(`Torn Travel Planner running at http://localhost:${PORT}`);
  startPolling();
  startMarketRefresh();
});
