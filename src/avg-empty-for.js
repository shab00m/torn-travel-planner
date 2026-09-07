/**
 * Persist the stored average empty-for for one item.
 * Single write path used when bounds or restock data change.
 */
import {
  AVG_EMPTY_FOR_SAMPLE_LIMIT,
  computeAvgEmptyForSec,
  emptyForDurationSec,
} from "../public/empty-for-bounds.js";

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
async function one(db, text, params = []) {
  const { rows } = await db.query(text, params);
  return rows[0];
}

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
async function many(db, text, params = []) {
  const { rows } = await db.query(text, params);
  return rows;
}

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
async function loadRecentEmptyForDurations(db, country, itemId) {
  const rows = await many(
    db,
    `SELECT adjusted_duration, duration
     FROM restocks
     WHERE country = $1 AND item_id = $2
       AND duration IS NOT NULL
       AND ignored = 0
     ORDER BY depleted_ts DESC
     LIMIT $3`,
    [country, itemId, AVG_EMPTY_FOR_SAMPLE_LIMIT]
  );
  return rows.map(emptyForDurationSec).filter((duration) => duration != null);
}

/**
 * Compute and upsert min/max/avg. Deletes the row when all three are unset.
 * @param {import("pg").PoolClient | import("pg").Pool} db
 * @returns {Promise<{ minEmptyFor: number|null, maxEmptyFor: number|null, avgEmptyFor: number|null }>}
 */
export async function persistEmptyForBoundsWithAvg(db, country, itemId, bounds) {
  const minEmptyFor = bounds.minEmptyFor ?? null;
  const maxEmptyFor = bounds.maxEmptyFor ?? null;
  const durations =
    minEmptyFor == null || maxEmptyFor == null
      ? await loadRecentEmptyForDurations(db, country, itemId)
      : [];
  const avgEmptyFor = computeAvgEmptyForSec(minEmptyFor, maxEmptyFor, durations);

  if (minEmptyFor == null && maxEmptyFor == null && avgEmptyFor == null) {
    await db.query(`DELETE FROM empty_for_bounds WHERE country = $1 AND item_id = $2`, [
      country,
      itemId,
    ]);
    return { minEmptyFor: null, maxEmptyFor: null, avgEmptyFor: null };
  }

  await db.query(
    `INSERT INTO empty_for_bounds (country, item_id, min_empty_for, max_empty_for, avg_empty_for)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (country, item_id) DO UPDATE
     SET min_empty_for = EXCLUDED.min_empty_for,
         max_empty_for = EXCLUDED.max_empty_for,
         avg_empty_for = EXCLUDED.avg_empty_for`,
    [country, itemId, minEmptyFor, maxEmptyFor, avgEmptyFor]
  );
  return { minEmptyFor, maxEmptyFor, avgEmptyFor };
}

/**
 * Recompute avg from the current stored min/max (or last 100 cycles).
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
export async function refreshAvgEmptyFor(db, country, itemId) {
  const row = await one(
    db,
    `SELECT min_empty_for, max_empty_for FROM empty_for_bounds
     WHERE country = $1 AND item_id = $2`,
    [country, itemId]
  );
  return persistEmptyForBoundsWithAvg(db, country, itemId, {
    minEmptyFor: row?.min_empty_for ?? null,
    maxEmptyFor: row?.max_empty_for ?? null,
  });
}
