// Replays all stored snapshots through the restock transition logic.
// Safe to run repeatedly. Closed restocks older than the oldest remaining
// snapshot per item are preserved; only in-window cycles are rebuilt.
// Usage: npm run backfill
import { initDb, backfillRestocks, closePool } from "../src/db.js";

await initDb();
const { opened, closed } = await backfillRestocks();
console.log(`Backfill complete: ${opened} depletion(s) recorded, ${closed} restock(s) closed.`);
await closePool();
