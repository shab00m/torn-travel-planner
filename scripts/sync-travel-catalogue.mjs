// One-off catalogue reconciliation without running daily history maintenance.
import "./load-local-env.mjs";
import { initDb, closePool } from "../src/db.js";
import { reconcileTravelCatalogueFromTorn } from "../src/item-types.js";

try {
  await initDb();
  console.log("[catalogue]", await reconcileTravelCatalogueFromTorn());
} catch (err) {
  console.error("[catalogue] reconciliation failed:", err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
