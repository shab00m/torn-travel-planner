/**
 * Railway market cron entrypoint: refresh stale Torn item-market and TornW3B prices.
 * Must exit cleanly (close the DB pool) so the next cron tick is not skipped.
 *
 * Usage: node scripts/cron-market.mjs
 */
import "./load-local-env.mjs";
import { initDb, closePool } from "../src/db.js";
import { refreshStaleMarketPrices } from "../src/market.js";
import { refreshStaleTraderPrices } from "../src/trader-prices.js";

async function main() {
  await initDb();

  const [market, traders] = await Promise.allSettled([
    refreshStaleMarketPrices(),
    refreshStaleTraderPrices(),
  ]);
  for (const [source, result] of [["market", market], ["TornW3B", traders]]) {
    if (result.status === "rejected") {
      console.error(`[cron] ${source} refresh failed:`, result.reason);
      process.exitCode = 1;
      continue;
    }
    const { refreshed, failed, deferred = 0 } = result.value;
    console.log(`[cron] ${source} refresh: ${refreshed} updated, ${failed} failed, ${deferred} deferred`);
  }
}

try {
  await main();
} catch (err) {
  console.error("[cron] failed:", err);
  process.exitCode = 1;
} finally {
  await closePool();
}
