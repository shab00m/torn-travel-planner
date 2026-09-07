import { getPool } from "./pg.js";
import { refreshAvgEmptyFor } from "./avg-empty-for.js";
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

/** Effective empty-start for clamps / adjusted empty-for. */
function effectiveDepletedTs(cycle) {
  return cycle.adjusted_depleted_ts ?? cycle.depleted_ts;
}

/**
 * Clear restock-amount back-extrapolation; keep adjusted_depleted_ts and
 * refresh adjusted_duration from observed restock − adjusted deplete.
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
async function clearAdjustedRestocks(db, country, itemId) {
  await db.query(
    `UPDATE restocks
     SET adjusted_restocked_ts = NULL,
         adjusted_duration = CASE
           WHEN restocked_ts IS NOT NULL
           THEN restocked_ts - COALESCE(adjusted_depleted_ts, depleted_ts)
           ELSE NULL
         END
     WHERE country = $1 AND item_id = $2`,
    [country, itemId]
  );
}

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
async function writeAdjusted(
  db,
  country,
  itemId,
  depletedTs,
  adjustedRestockedTs,
  adjustedDuration
) {
  await db.query(
    `UPDATE restocks
     SET adjusted_restocked_ts = $1, adjusted_duration = $2
     WHERE country = $3 AND item_id = $4 AND depleted_ts = $5`,
    [adjustedRestockedTs, adjustedDuration, country, itemId, depletedTs]
  );
}

/**
 * Compute and persist adjusted restock time / empty-for for one closed cycle.
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
export async function recomputeAdjustedRestockCycle(db, country, itemId, depletedTs) {
  const amount = await fetchRestockAmount(db, country, itemId);
  const cycle = await one(
    db,
    `SELECT depleted_ts, restocked_ts, duration, rate_start_qty, rate_end_ts, rate_end_qty,
            adjusted_depleted_ts
     FROM restocks
     WHERE country = $1 AND item_id = $2 AND depleted_ts = $3`,
    [country, itemId, depletedTs]
  );
  if (!cycle?.restocked_ts) return false;

  const adjDepleted = effectiveDepletedTs(cycle);

  if (amount == null) {
    await writeAdjusted(
      db,
      country,
      itemId,
      depletedTs,
      null,
      cycle.restocked_ts - adjDepleted
    );
    return true;
  }

  // Snapshots from empty start through a bit after restock (for early A→B rate).
  const points = await many(
    db,
    `SELECT yata_ts, quantity FROM snapshots
     WHERE country = $1 AND item_id = $2
       AND yata_ts >= $3 AND yata_ts <= $4
     ORDER BY yata_ts ASC`,
    [country, itemId, adjDepleted, cycle.restocked_ts + 3600]
  );
  const startQty = resolveStartQty(cycle, points);
  if (startQty == null || startQty <= 0) {
    await writeAdjusted(
      db,
      country,
      itemId,
      depletedTs,
      null,
      cycle.restocked_ts - adjDepleted
    );
    return true;
  }

  const lookup = buildLastZeroLookup(points);
  const adjustedTs = adjustRestockTime({
    restockedTs: cycle.restocked_ts,
    observedQty: startQty,
    fallbackRatePerMin: fallbackRatePerMin(cycle, startQty),
    restockAmount: amount,
    depletedTs: adjDepleted,
    lastZero: lastZeroBeforeRestock(lookup, cycle.restocked_ts, adjDepleted),
    points,
  });
  await writeAdjusted(db, country, itemId, depletedTs, adjustedTs, adjustedTs - adjDepleted);
  return true;
}

/**
 * Recompute adjusted columns for every closed cycle of one item.
 * When no restock amount: clears adjusted_restocked_ts but keeps adjusted empty-for
 * from adjusted_depleted_ts.
 * @param {string} country
 * @param {number} itemId
 * @param {import("pg").PoolClient | import("pg").Pool} [db]
 * @param {{ sinceDepletedTs?: number }} [options]
 *   When set, only cycles with depleted_ts >= sinceDepletedTs are updated.
 */
export async function recomputeAdjustedRestocksForItem(
  country,
  itemId,
  db = getPool(),
  options = {}
) {
  const sinceDepletedTs = options.sinceDepletedTs;
  const amount = await fetchRestockAmount(db, country, itemId);
  if (amount == null) {
    if (sinceDepletedTs != null) {
      await db.query(
        `UPDATE restocks
         SET adjusted_restocked_ts = NULL,
             adjusted_duration = CASE
               WHEN restocked_ts IS NOT NULL
               THEN restocked_ts - COALESCE(adjusted_depleted_ts, depleted_ts)
               ELSE NULL
             END
         WHERE country = $1 AND item_id = $2 AND depleted_ts >= $3`,
        [country, itemId, sinceDepletedTs]
      );
    } else {
      await clearAdjustedRestocks(db, country, itemId);
    }
    return { updated: 0, cleared: true };
  }

  const cycleParams = [country, itemId];
  let cycleSql = `SELECT depleted_ts, restocked_ts, duration, rate_start_qty, rate_end_ts, rate_end_qty,
            adjusted_depleted_ts
     FROM restocks
     WHERE country = $1 AND item_id = $2 AND restocked_ts IS NOT NULL`;
  if (sinceDepletedTs != null) {
    cycleSql += ` AND depleted_ts >= $3`;
    cycleParams.push(sinceDepletedTs);
  }
  cycleSql += ` ORDER BY depleted_ts ASC`;

  const cycles = await many(db, cycleSql, cycleParams);
  if (!cycles.length) return { updated: 0, cleared: false };

  const minTs = Math.min(...cycles.map((c) => effectiveDepletedTs(c)));
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
    const adjDepleted = effectiveDepletedTs(cycle);
    const startQty = resolveStartQty(cycle, points);
    // Without a usable start qty (e.g. snapshots purged), leave existing adjusted columns.
    if (startQty == null || startQty <= 0) continue;
    const adjustedTs = adjustRestockTime({
      restockedTs: cycle.restocked_ts,
      observedQty: startQty,
      fallbackRatePerMin: fallbackRatePerMin(cycle, startQty),
      restockAmount: amount,
      depletedTs: adjDepleted,
      lastZero: lastZeroBeforeRestock(lookup, cycle.restocked_ts, adjDepleted),
      points,
    });
    await writeAdjusted(
      db,
      country,
      itemId,
      cycle.depleted_ts,
      adjustedTs,
      adjustedTs - adjDepleted
    );
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
      await refreshAvgEmptyFor(pool, row.country, row.item_id);
    }
  }
  return { itemsUpdated, cyclesUpdated };
}
