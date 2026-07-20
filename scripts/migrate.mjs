import { initDb, closePool } from "../src/db.js";

await initDb();
console.log("Migrations complete.");
await closePool();
