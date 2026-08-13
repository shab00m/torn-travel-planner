/**
 * Fill closed restock cycles that are still missing persisted depletion-rate columns.
 * Usage: npm run backfill-depletion-rates
 */
import "./load-local-env.mjs";
import { initDb, closePool, ensurePersistedRates } from "../src/db.js";

try {
  await initDb();
  const result = await ensurePersistedRates();
  if (!result.itemsUpdated && !result.failed) {
    console.log("[depletion-rates] no missing rate windows");
  } else {
    const failedNote = result.failed ? `, ${result.failed} failed` : "";
    console.log(
      `[depletion-rates] backfilled ${result.itemsUpdated} items (${result.windowsWritten} windows${failedNote})`
    );
  }
} catch (err) {
  console.error("[depletion-rates] backfill failed:", err);
  process.exitCode = 1;
} finally {
  await closePool();
}
