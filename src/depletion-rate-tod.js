import { getPool, withTransaction } from "./pg.js";
import { getDepletionRates } from "./db.js";

async function many(db, text, params = []) {
  const { rows } = await db.query(text, params);
  return rows;
}

const REBUILD_CHECK_MS = 60 * 60 * 1000; // hourly check; rebuild at most once per UTC day
let rebuildTimer = null;
let lastRebuildUtcDay = null;

/** UTC (Torn City Time) hour 0–23 for a unix timestamp. */
export function tctHourOfDay(ts) {
  return new Date(ts * 1000).getUTCHours();
}

/** UTC seconds since midnight for a unix timestamp. */
function tctSecondsOfDay(ts) {
  const d = new Date(ts * 1000);
  return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
}

/**
 * Minute-weighted average rate into 24 TCT hour buckets.
 * @param {{ start_ts: number, end_ts: number, rate: number, open?: boolean }[]} windows
 * @returns {{ hour: number, avgRate: number, weightMinutes: number }[]}
 */
export function bucketRatesByTctHour(windows) {
  const buckets = Array.from({ length: 24 }, () => ({ sum: 0, weight: 0 }));

  for (const w of windows) {
    if (w.open || w.rate == null || w.rate <= 0) continue;
    if (w.start_ts == null || w.end_ts == null || w.end_ts <= w.start_ts) continue;

    let t = w.start_ts;
    const end = w.end_ts;
    while (t < end) {
      const sod = tctSecondsOfDay(t);
      const hour = Math.floor(sod / 3600);
      const segSec = Math.min(3600 - (sod % 3600), end - t);
      const minutes = segSec / 60;
      if (minutes > 0) {
        buckets[hour].sum += w.rate * minutes;
        buckets[hour].weight += minutes;
      }
      t += segSec;
    }
  }

  const rows = [];
  for (let hour = 0; hour < 24; hour++) {
    const b = buckets[hour];
    if (b.weight <= 0) continue;
    rows.push({
      hour,
      avgRate: b.sum / b.weight,
      weightMinutes: b.weight,
    });
  }
  return rows;
}

async function listItemsWithRateHistory() {
  return many(
    getPool(),
    `SELECT DISTINCT country, item_id AS "itemId"
     FROM restocks
     WHERE restocked_ts IS NOT NULL AND ignored = 0
     ORDER BY country, item_id`
  );
}

/** Rebuild TOD averages for one item from full rate-window history. */
export async function rebuildDepletionRateTodForItem(country, itemId) {
  const windows = await getDepletionRates(country, itemId);
  const rows = bucketRatesByTctHour(windows);
  const updatedAt = Math.floor(Date.now() / 1000);

  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM depletion_rate_tod WHERE country = $1 AND item_id = $2`,
      [country, itemId]
    );
    for (const row of rows) {
      await client.query(
        `INSERT INTO depletion_rate_tod
           (country, item_id, hour_of_day, avg_rate, weight_minutes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [country, itemId, row.hour, row.avgRate, row.weightMinutes, updatedAt]
      );
    }
  });

  return { hoursWritten: rows.length, updatedAt };
}

/** Rebuild TOD averages for every item that has completed restock cycles. */
export async function rebuildAllDepletionRateTod() {
  const items = await listItemsWithRateHistory();
  let itemsUpdated = 0;
  let hoursWritten = 0;
  for (const item of items) {
    const result = await rebuildDepletionRateTodForItem(item.country, item.itemId);
    itemsUpdated += 1;
    hoursWritten += result.hoursWritten;
  }
  return { itemsUpdated, hoursWritten };
}

/**
 * @returns {Promise<{ hours: (number | null)[], updatedAt: number | null }>}
 */
export async function getDepletionRateTod(country, itemId) {
  const rows = await many(
    getPool(),
    `SELECT hour_of_day AS hour, avg_rate AS "avgRate", updated_at AS "updatedAt"
     FROM depletion_rate_tod
     WHERE country = $1 AND item_id = $2
     ORDER BY hour_of_day ASC`,
    [country, itemId]
  );
  const hours = Array.from({ length: 24 }, () => null);
  let updatedAt = null;
  for (const row of rows) {
    hours[row.hour] = row.avgRate;
    if (updatedAt == null || row.updatedAt > updatedAt) updatedAt = row.updatedAt;
  }
  return { hours, updatedAt };
}

/** Pick rate for a unix ts from a 24-length hours array; nearest hour, then fallback. */
export function rateFromTodHours(ts, hours, fallback) {
  if (!hours?.length) return fallback;
  const hour = tctHourOfDay(ts);
  if (hours[hour] != null && hours[hour] > 0) return hours[hour];
  for (let d = 1; d < 24; d++) {
    for (const dir of [-1, 1]) {
      const h = (hour + dir * d + 24) % 24;
      if (hours[h] != null && hours[h] > 0) return hours[h];
    }
  }
  return fallback;
}

function utcDayKey(ms = Date.now()) {
  return Math.floor(ms / 86_400_000);
}

async function maybeRebuildDepletionRateTod() {
  const day = utcDayKey();
  if (lastRebuildUtcDay === day) return;

  const latest = await many(
    getPool(),
    `SELECT MAX(updated_at) AS "updatedAt" FROM depletion_rate_tod`
  );
  const updatedAt = latest[0]?.updatedAt;
  if (updatedAt != null && utcDayKey(updatedAt * 1000) === day) {
    lastRebuildUtcDay = day;
    return;
  }

  console.log("[depletion-rate-tod] rebuilding daily TCT hour averages…");
  const result = await rebuildAllDepletionRateTod();
  lastRebuildUtcDay = day;
  console.log(
    `[depletion-rate-tod] rebuilt ${result.itemsUpdated} items (${result.hoursWritten} hour rows)`
  );
}

export function startDepletionRateTodRebuild() {
  if (rebuildTimer) return;
  const tick = () => {
    void maybeRebuildDepletionRateTod().catch((err) => {
      console.error("[depletion-rate-tod] rebuild failed:", err);
    });
  };
  tick();
  rebuildTimer = setInterval(tick, REBUILD_CHECK_MS);
}
