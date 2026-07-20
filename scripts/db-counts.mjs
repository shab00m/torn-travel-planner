import { initDb, closePool } from "../src/db.js";
import { query } from "../src/pg.js";

const tables = [
  "items",
  "snapshots",
  "restocks",
  "market_prices",
  "restock_amounts",
  "users",
];

await initDb();
for (const table of tables) {
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM ${table}`);
  console.log(`${table}: ${rows[0].n}`);
}
await closePool();
