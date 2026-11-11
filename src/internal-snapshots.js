import express from "express";
import { randomUUID } from "node:crypto";
import { COUNTRIES } from "./countries.js";
import { saveApiSnapshots } from "./db.js";
import { requireInternalKey } from "./internal-auth.js";
import { createSnapshotBuffer } from "./snapshot-buffer.js";

const MAX_BATCH_SIZE = 100;

function errorDetails(err) {
  let message = String(err.message || "Unknown persistence error");
  for (const name of ["INTERNAL_API_KEY", "TORN_API_KEY", "DATABASE_URL"]) {
    const secret = process.env[name];
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  message = message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database URL]").slice(0, 500);
  const code = typeof err.code === "string" && /^[A-Z0-9_]{2,40}$/.test(err.code) ? err.code : "INTERNAL_ERROR";
  return {
    code, message,
    stage: err.snapshotContext?.stage ?? "save_snapshots",
    ...err.snapshotContext,
    retryable: ["57014", "55P03", "40P01", "40001", "53300", "08006", "ECONNRESET", "ETIMEDOUT"].includes(code),
  };
}

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
  // Bounded, serial background writer: callers never wait for database work.
  const pending = [];
  const write = createSnapshotBuffer(save);
  let running = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const { records, context, started } = pending.shift();
        try {
          const result = await write(records);
          console.log("[internal-snapshots] write completed:", JSON.stringify({
            ...context, ...result, durationMs: Math.round(performance.now() - started),
          }));
        } catch (err) {
          console.error("[internal-snapshots] write failed:", JSON.stringify({
            ...errorDetails(err), ...context, durationMs: Math.round(performance.now() - started),
          }));
        }
      }
    } finally {
      running = false;
    }
  }
  router.put("/", requireInternalKey, (req, res) => {
    const requestId = randomUUID();
    const started = performance.now();
    res.set("X-Request-Id", requestId);
    let records;
    try {
      records = validateBatch(req.body);
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    const context = {
      requestId, recordCount: records.length,
      itemCount: new Set(records.map((r) => `${r.country}:${r.itemId}`)).size,
    };
    if (pending.length >= 100) {
      res.status(503).json({ error: "Snapshot upload queue is full" });
      return;
    }
    pending.push({ records, context, started });
    res.status(202).json({ accepted: true });
    setImmediate(() => { void drain(); });
  });
  return router;
}
