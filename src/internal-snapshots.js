import express from "express";
import { COUNTRIES } from "./countries.js";
import { saveApiSnapshots } from "./db.js";
import { requireInternalKey } from "./internal-auth.js";

const MAX_BATCH_SIZE = 100;

function validateBatch(body) {
  const records = body?.snapshots;
  if (!Array.isArray(records) || records.length < 1 || records.length > MAX_BATCH_SIZE) {
    throw new Error(`snapshots must be an array of 1–${MAX_BATCH_SIZE} records`);
  }
  const seen = new Set();
  return records.map((record, index) => {
    const fail = (message) => { throw new Error(`snapshots[${index}]: ${message}`); };
    if (!record || typeof record !== "object" || Array.isArray(record)) fail("must be an object");
    const { country, itemId, snapshot_ts, quantity, cost, name } = record;
    if (!Object.hasOwn(COUNTRIES, country)) fail("country must be a supported destination code");
    if (!Number.isSafeInteger(itemId) || itemId <= 0 || itemId > 2_147_483_647) {
      fail("itemId must be a positive 32-bit integer");
    }
    if (!Number.isSafeInteger(snapshot_ts) || snapshot_ts <= 0 || snapshot_ts > Math.floor(Date.now() / 1000) + 60) {
      fail("snapshot_ts must be positive Unix seconds, at most 60 seconds in the future");
    }
    for (const [field, value] of Object.entries({ quantity, cost })) {
      if (!Number.isSafeInteger(value) || value < 0) fail(`${field} must be a non-negative safe integer`);
    }
    if (typeof name !== "string" || !name.trim() || name.trim().length > 255) {
      fail("name must be a non-empty string of at most 255 characters");
    }
    if (Object.hasOwn(record, "source")) fail("source is assigned by the server; omit this field");
    const identity = `${country}:${itemId}:${snapshot_ts}`;
    if (seen.has(identity)) fail("duplicate country/itemId/snapshot_ts in this batch");
    seen.add(identity);
    return { country, itemId, snapshot_ts, quantity, cost, name: name.trim() };
  });
}

export function createInternalSnapshotsRouter(save = saveApiSnapshots) {
  const router = express.Router();
  router.put("/", requireInternalKey, async (req, res) => {
    let records;
    try {
      records = validateBatch(req.body);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    try {
      const result = await save(records);
      res.json({ ok: true, ...result, source: "API" });
    } catch (err) {
      console.error("[internal-snapshots] write failed:", err.message);
      res.status(500).json({ error: "Could not save snapshots" });
    }
  });
  return router;
}
