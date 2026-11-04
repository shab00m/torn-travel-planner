import { getPool, withTransaction } from "./pg.js";

export const SNAPSHOT_COMPACTION_AGE_HOURS = 24;
const DELETE_BATCH_SIZE = 5000;

// Collapse agreeing same-time source duplicates logically before finding run
// boundaries. Prefer API at a tie, but keep conflicting same-time rows intact.
const candidatesSql = `
  WITH at_time AS (
    SELECT ctid AS row_id, snapshot_ts, source, quantity, cost,
           ROW_NUMBER() OVER (PARTITION BY snapshot_ts ORDER BY source ASC) AS source_rank,
           MIN(quantity) OVER instant AS min_quantity,
           MAX(quantity) OVER instant AS max_quantity,
           MIN(cost) OVER instant AS min_cost,
           MAX(cost) OVER instant AS max_cost
    FROM snapshots
    WHERE country = $1 AND item_id = $2
    WINDOW instant AS (PARTITION BY snapshot_ts)
  ), sequenced AS MATERIALIZED (
    SELECT row_id, snapshot_ts, source, quantity, cost, min_quantity, max_quantity, min_cost, max_cost,
           LAG(snapshot_ts) OVER timeline AS prev_ts,
           LAG(quantity) OVER timeline AS prev_quantity,
           LAG(cost) OVER timeline AS prev_cost,
           LEAD(snapshot_ts) OVER timeline AS next_ts,
           LEAD(quantity) OVER timeline AS next_quantity,
           LEAD(cost) OVER timeline AS next_cost
    FROM at_time WHERE source_rank = 1
    WINDOW timeline AS (ORDER BY snapshot_ts ASC)
  )
  SELECT row_id, snapshot_ts, source FROM at_time
  WHERE snapshot_ts < $3 AND source_rank > 1
    AND min_quantity = max_quantity AND min_cost = max_cost
  UNION ALL
  SELECT row_id, snapshot_ts, source FROM sequenced
  WHERE snapshot_ts < $3
    AND min_quantity = max_quantity AND min_cost = max_cost
    AND prev_ts IS NOT NULL AND next_ts IS NOT NULL
    AND quantity = prev_quantity AND cost = prev_cost
    AND quantity = next_quantity AND cost = next_cost`;

/**
 * Keep the first and last observation of unchanged quantity/cost runs across sources.
 * Each batch commits independently. Busy items are retried by the next run;
 * no table-wide lock is taken and derived restock/rate rows are not modified.
 */
export async function compactUnchangedSnapshots({
  nowSec = Math.floor(Date.now() / 1000), dryRun = false, onProgress,
} = {}) {
  if (!Number.isSafeInteger(nowSec) || nowSec <= 0) throw new Error("nowSec must be positive Unix seconds");
  const cutoffTs = nowSec - SNAPSHOT_COMPACTION_AGE_HOURS * 3600;
  const pool = getPool();
  const { rows: items } = await pool.query(
    `SELECT DISTINCT country, item_id FROM snapshots
     WHERE snapshot_ts < $1 ORDER BY country, item_id`, [cutoffTs]);
  const result = { deleted: 0, eligible: 0, itemsProcessed: 0, skippedBusy: 0, cutoffTs, dryRun };
  for (const { country, item_id: itemId } of items) {
    const params = [country, itemId, cutoffTs];
    let deleted = 0;
    let eligible = 0;
    let busy = false;
    if (dryRun) {
      const { rows } = await pool.query(`SELECT COUNT(*)::bigint AS count FROM (${candidatesSql}) candidates`, params);
      eligible = rows[0].count;
    } else {
      for (;;) {
        const count = await withTransaction(async (client) => {
          // Same key as YATA/API ingestion; skip contention rather than wait.
          const { rows } = await client.query(
            `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked`,
            [`snapshots:${country}:${itemId}`]);
          if (!rows[0].locked) return null;
          const removed = await client.query(
            `WITH redundant AS MATERIALIZED (
               ${candidatesSql} ORDER BY snapshot_ts ASC, source DESC LIMIT $4
             )
             DELETE FROM snapshots
             WHERE ctid = ANY(ARRAY(SELECT row_id FROM redundant))
               AND snapshot_ts < $3`, [...params, DELETE_BATCH_SIZE]);
          return removed.rowCount;
        });
        if (count == null) { busy = true; break; }
        deleted += count;
        if (count < DELETE_BATCH_SIZE) break;
      }
      eligible = deleted;
    }
    result.deleted += deleted;
    result.eligible += eligible;
    if (busy) result.skippedBusy++;
    else result.itemsProcessed++;
    onProgress?.({ country, itemId, deleted, eligible, busy });
  }
  return result;
}
