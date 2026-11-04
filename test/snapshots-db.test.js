import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

// Run against a dedicated local test database; never uses DATABASE_URL implicitly.
test("snapshot migration and ingestion against PostgreSQL", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const schema = `snapshot_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const { getPool, closePool } = await import("../src/pg.js");
  const db = await import("../src/db.js");
  const pool = getPool();
  const ts = Math.floor(Date.now() / 1000) - 1000;
  const itemId = 260;
  const record = (offset, quantity) => ({
    country: "mex", itemId, name: "Dahlia", snapshot_ts: ts + offset, quantity, cost: 300,
  });
  const yata = (offset, quantity) => ({ mex: {
    update: ts + offset, stocks: [{ id: itemId, name: "Dahlia", quantity, cost: 300 }],
  } });
  try {
    // Reproduce an existing database, including an observation recorded before
    // the rename. Historical migrations must remain untouched and runnable.
    const dir = new URL("../migrations/", import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql") && f < "014").sort();
    await pool.query("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())");
    for (const file of files) {
      await pool.query(await readFile(new URL(file, dir), "utf8"));
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file.replace(/\.sql$/, "")]);
    }
    await pool.query("INSERT INTO items (item_id, name) VALUES ($1, 'Dahlia')", [itemId]);
    await pool.query("INSERT INTO snapshots (country, item_id, yata_ts, quantity, cost) VALUES ('mex', $1, $2, 100, 300)", [itemId, ts]);
    await db.initDb();

    await t.test("migration preserves observations, primary keys and source attribution", async () => {
      assert.deepEqual(await db.getSnapshot("mex", itemId, ts), {
        snapshot_ts: ts, quantity: 100, cost: 300, source: "YATA",
      });
      const { rows } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'snapshots'", [schema]);
      assert.ok(rows.some((r) => r.column_name === "snapshot_ts"));
      assert.ok(!rows.some((r) => r.column_name === "yata_ts"));
      await assert.rejects(pool.query("INSERT INTO snapshots VALUES ('mex', $1, $2, 1, 1, 'OTHER')", [itemId, ts + 1]), /check constraint/);
      await db.initDb(); // Already-applied migrations are safe to rerun.
    });

    await t.test("YATA and API ingestion retain distinct sources and skip existing identities", async () => {
      assert.equal(await db.saveSnapshot(yata(60, 0)), 1);
      assert.deepEqual(await db.saveApiSnapshots([record(60, 999)]), { inserted: 0, skipped: 1 });
      assert.equal((await db.getSnapshot("mex", itemId, ts + 60)).source, "YATA");
      assert.equal((await db.getSnapshot("mex", itemId, ts + 60)).quantity, 0);
      assert.deepEqual(await db.saveApiSnapshots([record(90, 50)]), { inserted: 1, skipped: 0 });
      assert.equal((await db.getSnapshot("mex", itemId, ts + 90)).source, "API");
      assert.equal(await db.saveSnapshot(yata(90, 0)), 0);
      assert.equal((await db.getSnapshot("mex", itemId, ts + 90)).quantity, 50);
      assert.equal((await pool.query("SELECT * FROM restocks")).rowCount, 1,
        "an ignored conflicting payload must not create a depletion event");
    });

    await t.test("historical API imports rebuild depletion/refill events chronologically", async () => {
      await db.saveApiSnapshots([record(30, 0)]);
      let { rows } = await pool.query("SELECT depleted_ts, restocked_ts, duration FROM restocks ORDER BY depleted_ts");
      assert.deepEqual(rows, [{ depleted_ts: ts + 30, restocked_ts: ts + 90, duration: 60 }]);
      await db.saveApiSnapshots([record(240, 100), record(120, 40), record(180, 0)]);
      ({ rows } = await pool.query("SELECT depleted_ts, restocked_ts FROM restocks ORDER BY depleted_ts"));
      assert.deepEqual(rows, [
        { depleted_ts: ts + 30, restocked_ts: ts + 90 },
        { depleted_ts: ts + 180, restocked_ts: ts + 240 },
      ]);
      const rates = await db.getDepletionRates("mex", itemId);
      assert.equal(rates.find((r) => r.start_ts === ts + 90).end_ts, ts + 120);
      const before = JSON.stringify(rows);
      assert.deepEqual(await db.saveApiSnapshots([record(180, 999)]), { inserted: 0, skipped: 1 });
      ({ rows } = await pool.query("SELECT depleted_ts, restocked_ts FROM restocks ORDER BY depleted_ts"));
      assert.equal(JSON.stringify(rows), before);
    });

    await t.test("concurrent YATA/API writes serialize transitions for the same item", async () => {
      await Promise.all([db.saveSnapshot(yata(300, 0)), db.saveApiSnapshots([record(330, 100)])]);
      const { rows } = await pool.query("SELECT depleted_ts, restocked_ts FROM restocks ORDER BY depleted_ts DESC LIMIT 1");
      assert.deepEqual(rows, [{ depleted_ts: ts + 300, restocked_ts: ts + 330 }]);
      const history = await db.getHistory("mex", itemId, 0);
      assert.equal(history.length, 9);
      assert.equal(history.at(-1).source, "API");
      assert.ok(history.every((r) => Number.isSafeInteger(r.snapshot_ts)));
    });

    await t.test("a failed batch rolls back metadata and all observations", async () => {
      await assert.rejects(db.saveApiSnapshots([
        { ...record(400, 10), itemId: 999999, name: "Must roll back" },
        { ...record(401, 10), cost: "invalid bigint" },
      ]));
      assert.equal((await pool.query("SELECT * FROM items WHERE item_id = 999999")).rowCount, 0);
      assert.equal(await db.getSnapshot("mex", itemId, ts + 401), null);
    });

    await t.test("admin timestamp edits preserve the original source", async () => {
      const updated = await db.updateSnapshot("mex", itemId, ts + 330, { snapshot_ts: ts + 331 });
      assert.equal(updated.source, "API");
      assert.equal(await db.getSnapshot("mex", itemId, ts + 330), null);
      assert.equal((await db.getSnapshot("mex", itemId, ts + 331)).source, "API");
    });

    await t.test("retention purges old observations from either source", async () => {
      const oldTs = ts - 31 * 86400;
      await pool.query("INSERT INTO snapshots VALUES ('mex', $1, $2, 1, 1, 'YATA'), ('mex', $1, $3, 1, 1, 'API')", [itemId, oldTs, oldTs + 1]);
      const { purgeOldSnapshots } = await import("../src/snapshot-retention.js");
      assert.equal((await purgeOldSnapshots()).deleted, 2);
      assert.equal((await db.getHistory("mex", itemId, 0)).length, 9);
    });
  } finally {
    await closePool();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
