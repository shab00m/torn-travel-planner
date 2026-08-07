/**
 * Railway cron entrypoint: short-lived daily maintenance.
 * Runs snapshot retention purge, then rebuilds depletion-rate TOD averages.
 * Must exit cleanly (close the DB pool) so the next cron tick is not skipped.
 *
 * Usage: node scripts/cron-daily.mjs
 */
import { initDb, closePool } from "../src/db.js";
import { purgeOldSnapshots, SNAPSHOT_RETENTION_DAYS } from "../src/snapshot-retention.js";
import { rebuildAllDepletionRateTod } from "../src/depletion-rate-tod.js";

async function main() {
  await initDb();

  console.log(`[cron] purging snapshots older than ${SNAPSHOT_RETENTION_DAYS} days…`);
  const purge = await purgeOldSnapshots();
  console.log(
    `[cron] deleted ${purge.deleted} snapshot(s) older than ${new Date(purge.cutoffTs * 1000).toISOString()}`
  );

  console.log("[cron] rebuilding depletion-rate TOD averages…");
  const tod = await rebuildAllDepletionRateTod();
  console.log(
    `[cron] rebuilt TOD for ${tod.itemsUpdated} item(s) (${tod.hoursWritten} hour row(s))`
  );
}

try {
  await main();
} catch (err) {
  console.error("[cron] failed:", err);
  process.exitCode = 1;
} finally {
  await closePool();
}
