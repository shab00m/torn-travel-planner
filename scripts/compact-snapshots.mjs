/** Compact unchanged observations older than 24 hours. Use --dry-run to count only. */
import "./load-local-env.mjs";
import { initDb, closePool } from "../src/db.js";
import { compactUnchangedSnapshots } from "../src/snapshot-compaction.js";

try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run")) throw new Error("Usage: npm run compact-snapshots -- [--dry-run]");
  await initDb();
  const result = await compactUnchangedSnapshots({
    dryRun: args.includes("--dry-run"),
    onProgress: ({ country, itemId, deleted, eligible, busy }) => {
      console.log(`[snapshot-compaction] ${country}/${itemId}: ${busy ? "busy; deferred" : `${eligible} eligible, ${deleted} deleted`}`);
    },
  });
  console.log("[snapshot-compaction] complete:", JSON.stringify(result));
} catch (err) {
  console.error("[snapshot-compaction] failed:", err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
