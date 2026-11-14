import { getPool } from "./pg.js";

/** Keep raw YATA snapshots for this many days; restock events are retained separately. */
export const SNAPSHOT_RETENTION_DAYS = 30;

/**
 * Delete snapshots older than {@link SNAPSHOT_RETENTION_DAYS}.
 * Does not touch restocks or other derived tables.
 * @returns {Promise<{ deleted: number, cutoffTs: number }>}
 */
export async function purgeOldSnapshots() {
  const cutoffTs = Math.floor(Date.now() / 1000) - SNAPSHOT_RETENTION_DAYS * 86_400;
  const result = await getPool().query(
    `DELETE FROM snapshots s WHERE snapshot_ts < $1 AND NOT EXISTS (
       SELECT 1 FROM travel_items t WHERE t.country = s.country AND t.item_id = s.item_id
         AND COALESCE(t.deprecated_override, t.catalogue_deprecated)
     )`, [cutoffTs]);
  return { deleted: result.rowCount ?? 0, cutoffTs };
}
