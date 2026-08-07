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
  const result = await getPool().query(`DELETE FROM snapshots WHERE yata_ts < $1`, [cutoffTs]);
  return { deleted: result.rowCount ?? 0, cutoffTs };
}
