import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

test("snapshot compaction against PostgreSQL", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const schema = `compaction_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const { initDb } = await import("../src/db.js");
  const { getPool, closePool } = await import("../src/pg.js");
  const { compactUnchangedSnapshots } = await import("../src/snapshot-compaction.js");
  const nowSec = 1_800_000_000;
  const cutoff = nowSec - 86400;
  const compact = (options = {}) => compactUnchangedSnapshots({ nowSec, ...options });
  const pool = getPool();
  const insert = async (rows) => {
    for (const [offset, quantity, cost, source = "YATA", country = "mex", itemId = 4260] of rows) {
      await pool.query("INSERT INTO snapshots VALUES ($1,$2,$3,$4,$5,$6)",
        [country, itemId, cutoff + offset, quantity, cost, source]);
    }
  };
  const remaining = async () => (await pool.query("SELECT snapshot_ts-$1 AS offset, quantity,cost,source,country,item_id FROM snapshots ORDER BY country,item_id,snapshot_ts,source DESC", [cutoff])).rows;
  try {
    await initDb();
    await t.test("keeps first and last rows of each quantity/cost run", async () => {
      await insert([[-800, 100, 300], [-700, 100, 300], [-600, 100, 300], [-500, 90, 300],
        [-400, 90, 400], [-300, 90, 400], [-200, 90, 400], [-100, 100, 300]]);
      assert.equal((await compact()).deleted, 2);
      assert.deepEqual((await remaining()).map((r) => r.offset), [-800, -600, -500, -400, -200, -100]);
      assert.equal((await compact()).deleted, 0);
    });
    await t.test("2500,1234,0,0,0,0 preserves the first zero and last zero", async () => {
      await pool.query("TRUNCATE snapshots");
      await insert([[-600,2500,300],[-500,1234,300],[-400,0,300],[-300,0,300],[-200,0,300],[-100,0,300]]);
      assert.equal((await compact()).deleted, 2);
      assert.deepEqual((await remaining()).map((r) => r.offset), [-600,-500,-400,-100]);
    });
    await t.test("compares across sources but never across countries or items", async () => {
      await pool.query("TRUNCATE snapshots");
      await insert([[-400, 10, 20, "API"], [-300, 10, 20, "YATA"], [-200, 10, 20, "API"],
        [-300, 10, 20, "YATA", "can"], [-300, 10, 20, "YATA", "mex", 4261]]);
      assert.equal((await compact()).deleted, 1);
      const rows = await remaining();
      assert.equal(rows.length, 4);
      assert.ok(rows.some((r) => r.source === "API" && r.offset === -200));
    });
    await t.test("recent rows and the exact 24-hour boundary are protected", async () => {
      await pool.query("TRUNCATE snapshots");
      await insert([[-2, 10, 20], [-1, 10, 20], [0, 10, 20], [1, 10, 20], [2, 10, 20, "API"]]);
      assert.equal((await compact()).deleted, 1);
      assert.deepEqual((await remaining()).map((r) => r.offset), [-2, 0, 1, 2]);
    });
    await t.test("equal-time identical sources keep API and preserve conflicting observations", async () => {
      await pool.query("TRUNCATE snapshots");
      await insert([[-400, 10, 20, "YATA"], [-400, 10, 20, "API"],
        [-200, 200, 20, "YATA"], [-200, 100, 20, "API"], [-100, 100, 20, "API"]]);
      assert.equal((await compact()).deleted, 1);
      const rows = await remaining();
      assert.equal(rows.length, 4);
      assert.equal(rows.find((r) => r.offset === -400).source, "API");
      assert.equal(rows.filter((r) => r.offset === -200).length, 2,
        "deleting an API duplicate must not reveal a conflicting YATA observation");
    });
    await t.test("dry run counts candidates without deleting records", async () => {
      await pool.query("TRUNCATE snapshots");
      await insert([[-300, 10, 20], [-200, 10, 20, "API"], [-100, 10, 20]]);
      const before = await remaining();
      const result = await compact({ dryRun: true });
      assert.equal(result.eligible, 1);
      assert.equal(result.deleted, 0);
      assert.deepEqual(await remaining(), before);
    });
    await t.test("busy item locks are skipped while other items are cleaned", async () => {
      await pool.query("TRUNCATE snapshots");
      await insert([[-300, 10, 20], [-200, 10, 20], [-100, 10, 20], [-300, 10, 20, "API", "can"], [-200, 10, 20, "API", "can"], [-100, 10, 20, "API", "can"]]);
      const blocker = await pool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["snapshots:mex:4260"]);
        const result = await compact();
        assert.equal(result.skippedBusy, 1);
        assert.equal(result.deleted, 1);
        assert.equal((await remaining()).filter((r) => r.country === "mex").length, 3);
      } finally { await blocker.query("ROLLBACK"); blocker.release(); }
      assert.equal((await compact()).deleted, 1);
    });
    await t.test("large runs cross delete-batch boundaries without losing their first or last row", async () => {
      await pool.query("TRUNCATE snapshots");
      await pool.query(`INSERT INTO snapshots
        SELECT 'mex',4260,$1+n,10,20,CASE WHEN n%2=0 THEN 'YATA' ELSE 'API' END
        FROM generate_series(0,6001) n`, [cutoff - 10000]);
      assert.equal((await compact()).deleted, 6000);
      assert.deepEqual((await remaining()).map((r) => r.offset), [-10000, -3999]);
    });
    await t.test("persisted restocks and depletion-rate endpoints are left unchanged", async () => {
      await pool.query("TRUNCATE snapshots, restocks");
      await insert([[-600, 0, 300], [-500, 0, 300], [-400, 0, 300], [-300, 100, 300], [-200, 100, 300], [-100, 100, 300]]);
      await pool.query(`INSERT INTO restocks
        (country,item_id,depleted_ts,restocked_ts,duration,rate_start_qty,rate_end_ts,rate_end_qty)
        VALUES ('mex',4260,$1,$2,200,100,$3,50)`, [cutoff - 600, cutoff - 300, cutoff - 250]);
      const before = (await pool.query("SELECT * FROM restocks")).rows;
      assert.equal((await compact()).deleted, 2);
      assert.deepEqual((await pool.query("SELECT * FROM restocks")).rows, before);
    });
    await t.test("a database containing only recent data has no cleanup candidates", async () => {
      await pool.query("TRUNCATE snapshots");
      await insert([[0, 10, 20], [100, 10, 20]]);
      const result = await compact();
      assert.equal(result.deleted, 0);
      assert.equal(result.itemsProcessed, 0);
      assert.equal((await remaining()).length, 2);
    });
  } finally {
    await closePool();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
