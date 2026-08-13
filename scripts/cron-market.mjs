/**
 * Railway market cron entrypoint: refresh stale Torn item-market prices.
 * Must exit cleanly (close the DB pool) so the next cron tick is not skipped.
 *
 * Usage: node scripts/cron-market.mjs
 */
import "./load-local-env.mjs";
import { initDb, closePool } from "../src/db.js";
import { refreshStaleMarketPrices } from "../src/market.js";

async function main() {
  await initDb();

  console.log("[cron] refreshing stale market prices…");
  const market = await refreshStaleMarketPrices();
  console.log(`[cron] market refresh: ${market.refreshed} updated, ${market.failed} failed`);
}

try {
  await main();
} catch (err) {
  console.error("[cron] failed:", err);
  process.exitCode = 1;
} finally {
  await closePool();
}
