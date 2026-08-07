import { getPool } from "./pg.js";
import { adjustRestockTime, rateFromEndpoints } from "../public/adjust-restock-time.js";

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 * @param {string} text
 * @param {unknown[]} [params]
 */
async function one(db, text, params = []) {
  const { rows } = await db.query(text, params);
  return rows[0];
}

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 * @param {string} text
 * @param {unknown[]} [params]
 */
async function many(db, text, params = []) {
  const { rows } = await db.query(text, params);
  return rows;
}

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
async function fetchRestockAmount(db, country, itemId) {
  const row = await one(
    db,
    `SELECT amount FROM restock_amounts WHERE country = $1 AND item_id = $2`,
    [country, itemId]
  );
  return row?.amount ?? null;
}

function buildLastZeroLookup(points) {
  if (!points.length) return null;
  const prefixLastZero = new Array(points.length);
  let lastZero = null;
  for (let i = 0; i < points.length; i++) {
    if (points[i].quantity === 0) lastZero = points[i].yata_ts;
    prefixLastZero[i] = lastZero;
  }
  return { points, prefixLastZero };
}

function lastZeroBeforeRestock(lookup, restockedTs, depletedTs) {
  if (!lookup) return depletedTs ?? null;
  const { points, prefixLastZero } = lookup;
  let lo = 0;
  let hi = points.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].yata_ts < restockedTs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return depletedTs ?? null;
  return prefixLastZero[idx] ?? depletedTs ?? null;
}

function fallbackRatePerMin(cycle, startQty) {
  if (
    cycle.rate_end_ts == null ||
    startQty == null ||
    cycle.rate_end_qty == null ||
    cycle.restocked_ts == null
  ) {
    return null;
  }
  return rateFromEndpoints(
    cycle.restocked_ts,
    cycle.rate_end_ts,
    startQty,
    cycle.rate_end_qty
  );
}

function resolveStartQty(cycle, points) {
  if (cycle.rate_start_qty != null && cycle.rate_start_qty > 0) return cycle.rate_start_qty;
  const snap = points.find((p) => p.yata_ts === cycle.restocked_ts);
  return snap?.quantity ?? null;
}

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
async function clearAdjustedRestocks(db, country, itemId) {
  await db.query(
    `UPDATE restocks
     SET adjusted_restocked_ts = NULL, adjusted_duration = NULL
     WHERE country = $1 AND item_id = $2`,
    [country, itemId]
  );
}

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
async function writeAdjusted(db, country, itemId, depletedTs, adjustedTs, adjustedDuration) {
  await db.query(
    `UPDATE restocks
     SET adjusted_restocked_ts = $1, adjusted_duration = $2
     WHERE country = $3 AND item_id = $4 AND depleted_ts = $5`,
    [adjustedTs, adjustedDuration, country, itemId, depletedTs]
  );
}

/**
 * Compute and persist adjusted restock time for one closed cycle.
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
export async function recomputeAdjustedRestockCycle(db, country, itemId, depletedTs) {
  const amount = await fetchRestockAmount(db, country, itemId);
  const cycle = await one(
    db,
    `SELECT depleted_ts, restocked_ts, duration, rate_start_qty, rate_end_ts, rate_end_qty
     FROM restocks
     WHERE country = $1 AND item_id = $2 AND depleted_ts = $3`,
    [country, itemId, depletedTs]
  );
  if (!cycle?.restocked_ts) return false;

  if (amount == null) {
    await writeAdjusted(db, country, itemId, depletedTs, null, null);
    return true;
  }

  // Snapshots from empty start through a bit after restock (for early A→B rate).
  const points = await many(
    db,
    `SELECT yata_ts, quantity FROM snapshots
     WHERE country = $1 AND item_id = $2
       AND yata_ts >= $3 AND yata_ts <= $4
     ORDER BY yata_ts ASC`,
    [country, itemId, cycle.depleted_ts, cycle.restocked_ts + 3600]
  );
  const startQty = resolveStartQty(cycle, points);
  if (startQty == null || startQty <= 0) {
    await writeAdjusted(db, country, itemId, depletedTs, cycle.restocked_ts, cycle.duration);
    return true;
  }

  const lookup = buildLastZeroLookup(points);
  const adjustedTs = adjustRestockTime({
    restockedTs: cycle.restocked_ts,
    observedQty: startQty,
    fallbackRatePerMin: fallbackRatePerMin(cycle, startQty),
    restockAmount: amount,
    depletedTs: cycle.depleted_ts,
    lastZero: lastZeroBeforeRestock(lookup, cycle.restocked_ts, cycle.depleted_ts),
    points,
  });
  await writeAdjusted(
    db,
    country,
    itemId,
    depletedTs,
    adjustedTs,
    adjustedTs - cycle.depleted_ts
  );
  return true;
}

/**
 * Recompute adjusted columns for every closed cycle of one item.
 * Clears columns when no restock amount is configured.
 * @param {string} country
 * @param {number} itemId
 * @param {import("pg").PoolClient | import("pg").Pool} [db]
 */
export async function recomputeAdjustedRestocksForItem(country, itemId, db = getPool()) {
  const amount = await fetchRestockAmount(db, country, itemId);
  if (amount == null) {
    await clearAdjustedRestocks(db, country, itemId);
    return { updated: 0, cleared: true };
  }

  const cycles = await many(
    db,
    `SELECT depleted_ts, restocked_ts, duration, rate_start_qty, rate_end_ts, rate_end_qty
     FROM restocks
     WHERE country = $1 AND item_id = $2 AND restocked_ts IS NOT NULL
     ORDER BY depleted_ts ASC`,
    [country, itemId]
  );
  if (!cycles.length) return { updated: 0, cleared: false };

  const minTs = Math.min(...cycles.map((c) => c.depleted_ts));
  const maxTs = Math.max(...cycles.map((c) => c.restocked_ts)) + 3600;
  const points = await many(
    db,
    `SELECT yata_ts, quantity FROM snapshots
     WHERE country = $1 AND item_id = $2
       AND yata_ts >= $3 AND yata_ts <= $4
     ORDER BY yata_ts ASC`,
    [country, itemId, minTs, maxTs]
  );
  const lookup = buildLastZeroLookup(points);
  let updated = 0;

  for (const cycle of cycles) {
    const startQty = resolveStartQty(cycle, points);
    let adjustedTs = cycle.restocked_ts;
    let adjustedDuration = cycle.duration;
    if (startQty != null && startQty > 0) {
      adjustedTs = adjustRestockTime({
        restockedTs: cycle.restocked_ts,
        observedQty: startQty,
        fallbackRatePerMin: fallbackRatePerMin(cycle, startQty),
        restockAmount: amount,
        depletedTs: cycle.depleted_ts,
        lastZero: lastZeroBeforeRestock(lookup, cycle.restocked_ts, cycle.depleted_ts),
        points,
      });
      adjustedDuration = adjustedTs - cycle.depleted_ts;
    }
    await writeAdjusted(db, country, itemId, cycle.depleted_ts, adjustedTs, adjustedDuration);
    updated += 1;
  }
  return { updated, cleared: false };
}

/**
 * Fill missing adjusted columns for items that have a configured restock amount.
 * Safe to run after listen — does not need to block startup.
 */
export async function ensureAdjustedRestocks() {
  const pool = getPool();
  const items = await many(
    pool,
    `SELECT DISTINCT r.country, r.item_id
     FROM restocks r
     INNER JOIN restock_amounts a
       ON a.country = r.country AND a.item_id = r.item_id
     WHERE r.restocked_ts IS NOT NULL
       AND (r.adjusted_restocked_ts IS NULL OR r.adjusted_duration IS NULL)
     ORDER BY r.country, r.item_id`
  );
  let itemsUpdated = 0;
  let cyclesUpdated = 0;
  for (const row of items) {
    const result = await recomputeAdjustedRestocksForItem(row.country, row.item_id, pool);
    if (result.updated > 0) {
      itemsUpdated += 1;
      cyclesUpdated += result.updated;
    }
  }
  return { itemsUpdated, cyclesUpdated };
}
