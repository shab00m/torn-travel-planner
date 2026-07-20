// Replays all stored snapshots through the restock transition logic.
// Safe to run repeatedly — rebuilds restocks from snapshot history.
// Usage: npm run backfill
import { initDb, backfillRestocks, closePool } from "../src/db.js";

await initDb();
const { opened, closed } = await backfillRestocks();
console.log(`Backfill complete: ${opened} depletion(s) recorded, ${closed} restock(s) closed.`);
await closePool();
