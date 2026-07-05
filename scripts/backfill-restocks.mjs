// Replays all stored snapshots through the restock transition logic.
// Safe to run repeatedly — rebuilds restocks from snapshot history.
// Usage: npm run backfill
import { backfillRestocks } from "../src/db.js";

const { opened, closed } = backfillRestocks();
console.log(`Backfill complete: ${opened} depletion(s) recorded, ${closed} restock(s) closed.`);
