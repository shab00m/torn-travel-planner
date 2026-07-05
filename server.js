import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COUNTRIES } from "./src/countries.js";
import { getHistory, getRestocks, getDepletionRates } from "./src/db.js";
import { startPolling, getLatest } from "./src/yata.js";
import { getPlayerInfo } from "./src/torn.js";

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

app.get("/api/countries", (_req, res) => {
  res.json(COUNTRIES);
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
// item (newest first). 21 = up to 20 completed samples for averages plus a
// possible open one.
app.get("/api/restocks/:country/:itemId", (req, res) => {
  const params = parseItemParams(req, res);
  if (!params) return;
  res.json({
    restocks: getRestocks(params.country, params.id, 21),
    rates: getDepletionRates(params.country, params.id, 21),
  });
});

app.listen(PORT, () => {
  console.log(`Torn Travel Planner running at http://localhost:${PORT}`);
  startPolling();
});
