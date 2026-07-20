/**
 * One-shot copy from a SQLite travel.db into Postgres (DATABASE_URL).
 * Usage: npm run import-sqlite -- data/travel.db
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { initDb, closePool } from "../src/db.js";
import { withTransaction } from "../src/pg.js";

const sqlitePath = process.argv[2];
if (!sqlitePath) {
  console.error("Usage: node scripts/import-sqlite-to-postgres.mjs <path-to-travel.db>");
  process.exit(1);
}

const sqlite = new DatabaseSync(path.resolve(sqlitePath), { readOnly: true });

function all(sql) {
  return sqlite.prepare(sql).all();
}

await initDb();

await withTransaction(async (client) => {
  const items = all(`SELECT item_id, name FROM items`);
  for (const row of items) {
    await client.query(
      `INSERT INTO items (item_id, name) VALUES ($1, $2)
       ON CONFLICT (item_id) DO UPDATE SET name = EXCLUDED.name`,
      [row.item_id, row.name]
    );
  }
  console.log(`items: ${items.length}`);

  const snapshots = all(
    `SELECT country, item_id, yata_ts, quantity, cost FROM snapshots`
  );
  const batchSize = 500;
  for (let i = 0; i < snapshots.length; i += batchSize) {
    const chunk = snapshots.slice(i, i + batchSize);
    const countries = chunk.map((r) => r.country);
    const itemIds = chunk.map((r) => r.item_id);
    const yataTs = chunk.map((r) => r.yata_ts);
    const quantities = chunk.map((r) => r.quantity);
    const costs = chunk.map((r) => r.cost);
    await client.query(
      `INSERT INTO snapshots (country, item_id, yata_ts, quantity, cost)
       SELECT * FROM UNNEST($1::text[], $2::int[], $3::bigint[], $4::bigint[], $5::bigint[])
       ON CONFLICT DO NOTHING`,
      [countries, itemIds, yataTs, quantities, costs]
    );
  }
  console.log(`snapshots: ${snapshots.length}`);

  const restocks = all(
    `SELECT country, item_id, depleted_ts, restocked_ts, duration, ignored FROM restocks`
  );
  for (const row of restocks) {
    await client.query(
      `INSERT INTO restocks (country, item_id, depleted_ts, restocked_ts, duration, ignored)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [
        row.country,
        row.item_id,
        row.depleted_ts,
        row.restocked_ts,
        row.duration,
        row.ignored ?? 0,
      ]
    );
  }
  console.log(`restocks: ${restocks.length}`);

  const market = all(`SELECT item_id, market_price, fetched_at FROM market_prices`);
  for (const row of market) {
    await client.query(
      `INSERT INTO market_prices (item_id, market_price, fetched_at) VALUES ($1, $2, $3)
       ON CONFLICT (item_id) DO UPDATE SET
         market_price = EXCLUDED.market_price,
         fetched_at = EXCLUDED.fetched_at`,
      [row.item_id, row.market_price, row.fetched_at]
    );
  }
  console.log(`market_prices: ${market.length}`);

  const amounts = all(`SELECT country, item_id, amount FROM restock_amounts`);
  for (const row of amounts) {
    await client.query(
      `INSERT INTO restock_amounts (country, item_id, amount) VALUES ($1, $2, $3)
       ON CONFLICT (country, item_id) DO UPDATE SET amount = EXCLUDED.amount`,
      [row.country, row.item_id, row.amount]
    );
  }
  console.log(`restock_amounts: ${amounts.length}`);

  const users = all(
    `SELECT player_id, name, is_admin, is_allowed, created_at, updated_at, last_login_at FROM users`
  );
  for (const row of users) {
    await client.query(
      `INSERT INTO users (player_id, name, is_admin, is_allowed, created_at, updated_at, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (player_id) DO NOTHING`,
      [
        row.player_id,
        row.name,
        row.is_admin,
        row.is_allowed,
        row.created_at,
        row.updated_at,
        row.last_login_at,
      ]
    );
  }
  console.log(`users: ${users.length}`);
});

sqlite.close();
await closePool();
console.log("Import complete.");
