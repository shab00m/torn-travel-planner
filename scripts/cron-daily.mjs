/**
 * Railway daily cron: snapshot retention purge, compaction, then TOD rebuild.
 * Must exit cleanly (close the DB pool) so the next cron tick is not skipped.
 *
 * Usage: node scripts/cron-daily.mjs
 */
import "./load-local-env.mjs";
import { initDb, closePool } from "../src/db.js";
import { purgeOldSnapshots, SNAPSHOT_RETENTION_DAYS } from "../src/snapshot-retention.js";
import { rebuildAllDepletionRateTod } from "../src/depletion-rate-tod.js";
import { compactUnchangedSnapshots } from "../src/snapshot-compaction.js";
import { reconcileTravelCatalogueFromTorn } from "../src/item-types.js";

async function main() {
  await initDb();

  // Reconcile before retention so newly removed items keep their remaining history.
  console.log("[cron] reconciling Torn foreign shops…");
  const catalogue = await reconcileTravelCatalogueFromTorn();
  console.log(`[cron] catalogue: ${catalogue.items} items, ${catalogue.deprecated} deprecated, ${catalogue.reactivated} reactivated`);

  console.log(`[cron] purging snapshots older than ${SNAPSHOT_RETENTION_DAYS} days…`);
  const purge = await purgeOldSnapshots();
  console.log(
    `[cron] deleted ${purge.deleted} snapshot(s) older than ${new Date(purge.cutoffTs * 1000).toISOString()}`
  );

  console.log("[cron] compacting unchanged snapshots older than 24 hours…");
  const compaction = await compactUnchangedSnapshots();
  console.log(`[cron] snapshot compaction: ${compaction.deleted} deleted, ${compaction.itemsProcessed} items processed, ${compaction.skippedBusy} busy items deferred`);

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
