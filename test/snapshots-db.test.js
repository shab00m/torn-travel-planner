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
  const importAndRebuild = async (records) => {
    const result = await db.saveApiSnapshots(records);
    if (result.inserted) {
      for (const { country, itemId } of new Map(records.map((r) => [`${r.country}:${r.itemId}`, r])).values()) {
        await db.backfillRestocksForItem(country, itemId);
      }
    }
    return result;
  };
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

    await t.test("source is part of identity and API wins timestamp ties only in derived views", async () => {
      assert.equal(await db.saveSnapshot(yata(60, 0)), 1);
      assert.deepEqual(await db.saveApiSnapshots([record(60, 0)]), { inserted: 1, skipped: 0 });
      assert.deepEqual(await db.saveApiSnapshots([record(60, 999)]), { inserted: 0, skipped: 1 });
      assert.equal((await db.getSnapshot("mex", itemId, ts + 60, "YATA")).quantity, 0);
      assert.equal((await db.getSnapshot("mex", itemId, ts + 60, "API")).quantity, 0);
      assert.deepEqual(await db.saveApiSnapshots([record(90, 50)]), { inserted: 1, skipped: 0 });
      assert.equal(await db.saveSnapshot(yata(90, 0)), 1);
      assert.equal(await db.saveSnapshot(yata(90, 888)), 0);
      assert.equal((await db.getSnapshot("mex", itemId, ts + 90, "YATA")).quantity, 0);
      assert.equal((await db.getSnapshot("mex", itemId, ts + 90, "API")).quantity, 50);
      const latest = await db.getLatestSnapshot("mex", itemId);
      assert.equal(latest.source, "API");
      assert.equal(latest.quantity, 50);
      assert.equal(latest.snapshot_ts, ts + 90);
      const { loadCurrentStocks } = await import("../src/current-stocks.js");
      const feed = await loadCurrentStocks();
      assert.equal(feed.stocks.mex.stocks.find((r) => r.id === itemId).quantity, 50);
      assert.equal(feed.stocks.mex.stocks.find((r) => r.id === itemId).source, "API");
      assert.equal(feed.timestamp, ts + 90);
      await db.saveSnapshot(yata(95, 25));
      const newer = await loadCurrentStocks();
      assert.equal(newer.stocks.mex.stocks.find((r) => r.id === itemId).quantity, 25);
      assert.equal(newer.stocks.mex.stocks.find((r) => r.id === itemId).source, "YATA");
      await db.deleteSnapshot("mex", itemId, ts + 95, "YATA");
      const effective = await db.getHistory("mex", itemId, 0, { effective: true });
      assert.equal(effective.filter((r) => r.snapshot_ts === ts + 90).length, 1);
      assert.equal(effective.at(-1).quantity, 50);
      assert.equal(effective.at(-1).source, "API");
      assert.equal((await pool.query("SELECT * FROM restocks")).rowCount, 0,
        "a conflicting YATA observation must not manufacture a depletion event");
    });

    await t.test("API uploads insert only snapshots even when an item maintenance lock is held", async () => {
      const onlyId = 999994;
      const writer = await pool.connect();
      const before = (await pool.query("SELECT * FROM restocks ORDER BY country, item_id, depleted_ts")).rows;
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`snapshots:mex:${onlyId}`]);
        await pool.query("INSERT INTO snapshots VALUES ('mex', $1, $2, 0, 300, 'YATA')", [onlyId, ts + 60]);
        const samples = [record(0, 100), record(60, 10), record(120, 100)].map((r) => ({ ...r, itemId: onlyId }));
        let deadline;
        try {
          const result = await Promise.race([
            db.saveApiSnapshots(samples),
            new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("API insert waited on maintenance")), 2000); }),
          ]);
          assert.deepEqual(result, { inserted: 3, skipped: 0 });
        } finally { clearTimeout(deadline); }
        assert.deepEqual(await db.saveApiSnapshots(samples), { inserted: 0, skipped: 3 });
        assert.equal((await pool.query("SELECT * FROM snapshots WHERE item_id=$1", [onlyId])).rowCount, 4);
        assert.equal((await pool.query("SELECT * FROM items WHERE item_id=$1", [onlyId])).rowCount, 0);
        assert.deepEqual((await pool.query("SELECT * FROM restocks ORDER BY country, item_id, depleted_ts")).rows, before);
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
        await pool.query("DELETE FROM snapshots WHERE item_id=$1", [onlyId]);
      }
    });

    await t.test("explicit backfills after API imports rebuild depletion/refill events chronologically", async () => {
      await importAndRebuild([record(30, 0)]);
      let { rows } = await pool.query("SELECT depleted_ts, restocked_ts, duration FROM restocks ORDER BY depleted_ts");
      assert.deepEqual(rows, [{ depleted_ts: ts + 30, restocked_ts: ts + 90, duration: 60 }]);
      await importAndRebuild([record(240, 100), record(120, 40), record(180, 0)]);
      ({ rows } = await pool.query("SELECT depleted_ts, restocked_ts FROM restocks ORDER BY depleted_ts"));
      assert.deepEqual(rows, [
        { depleted_ts: ts + 30, restocked_ts: ts + 90 },
        { depleted_ts: ts + 180, restocked_ts: ts + 240 },
      ]);
      const rates = await db.getDepletionRates("mex", itemId);
      assert.equal(rates.find((r) => r.start_ts === ts + 90).end_ts, ts + 120);
      const before = JSON.stringify(rows);
      assert.deepEqual(await importAndRebuild([record(180, 999)]), { inserted: 0, skipped: 1 });
      ({ rows } = await pool.query("SELECT depleted_ts, restocked_ts FROM restocks ORDER BY depleted_ts"));
      assert.equal(JSON.stringify(rows), before);
    });

    await t.test("concurrent YATA/API writes retain observations for an explicit backfill", async () => {
      await Promise.all([db.saveSnapshot(yata(300, 0)), db.saveApiSnapshots([record(360, 100)])]);
      await db.backfillRestocksForItem("mex", itemId);
      const { rows } = await pool.query("SELECT depleted_ts, restocked_ts FROM restocks ORDER BY depleted_ts DESC LIMIT 1");
      assert.deepEqual(rows, [{ depleted_ts: ts + 300, restocked_ts: ts + 360 }]);
      const history = await db.getHistory("mex", itemId, 0);
      assert.equal(history.length, 11);
      assert.equal(history.at(-1).source, "API");
      assert.ok(history.every((r) => Number.isSafeInteger(r.snapshot_ts)));
    });

    await t.test("explicit backfills discard short empty periods from uploaded snapshots", async () => {
      const blipId = 999996;
      const blip = (offset, quantity) => ({ ...record(offset, quantity),
        country: "can", itemId: blipId, name: "Xanax" });
      const rows = async () => (await pool.query(
        "SELECT depleted_ts, restocked_ts, duration FROM restocks WHERE item_id = $1 ORDER BY depleted_ts",
        [blipId]
      )).rows;
      try {
        // Repeated 1–2 second API oscillations and the 59-second boundary.
        for (const [offset, quantity] of [[0, 218], [10, 0], [11, 218],
          [20, 0], [22, 218], [30, 0], [89, 218]]) {
          await importAndRebuild([blip(offset, quantity)]);
        }
        assert.deepEqual(await rows(), []);
        // Starting with zero stock exercises recovery without an open cycle.
        await db.deleteSnapshots("can", blipId, [{ snapshot_ts: ts, source: "API" }]);
        assert.deepEqual(await rows(), []);
        // Keep genuine empty periods at and above the minimum, plus open ones.
        for (const [offset, quantity] of [[100, 0], [160, 218],
          [200, 0], [261, 218], [300, 0]]) {
          await importAndRebuild([blip(offset, quantity)]);
        }
        const expected = [
          { depleted_ts: ts + 100, restocked_ts: ts + 160, duration: 60 },
          { depleted_ts: ts + 200, restocked_ts: ts + 261, duration: 61 },
          { depleted_ts: ts + 300, restocked_ts: null, duration: null },
        ];
        assert.deepEqual(await rows(), expected);
        // Rebuild also removes short records created before this rule existed.
        await pool.query(`INSERT INTO restocks (country, item_id, depleted_ts, restocked_ts, duration)
          VALUES ('can', $1, $2, $3, 2)`, [blipId, ts + 20, ts + 22]);
        await db.backfillRestocksForItem("can", blipId);
        assert.deepEqual(await rows(), expected);
        await db.backfillRestocks();
        assert.deepEqual(await rows(), expected);
      } finally {
        await pool.query("DELETE FROM snapshots WHERE item_id = $1", [blipId]);
        await pool.query("DELETE FROM restocks WHERE item_id = $1", [blipId]);
      }
    });

    await t.test("configured window excludes explicitly replayed cycles and can flag existing history", async () => {
      const windowId = 999995;
      const sample = (offset, quantity) => ({ ...record(offset, quantity), itemId: windowId });
      const cycles = async () => (await db.getRestocks("mex", windowId))
        .sort((a, b) => a.depleted_ts - b.depleted_ts);
      try {
        // Three existing cycles: min endpoint, max endpoint, and above max.
        await importAndRebuild([[0, 100], [10, 0], [70, 100], [80, 0],
          [200, 100], [210, 0], [390, 100]].map(([ts, qty]) => sample(ts, qty)));
        await assert.rejects(db.flagRestocksOutsideWindow("mex", windowId), /Set both min and max/);
        await db.setEmptyForBounds("mex", windowId, { minEmptyFor: 60, maxEmptyFor: 120 });
        assert.ok((await cycles()).every((cycle) => !cycle.ignored), "saving bounds leaves existing flags alone");
        // Preserve an admin's exclusion inside the window.
        await db.setRestockIgnored("mex", windowId, ts + 10, true);
        const flagged = await db.flagRestocksOutsideWindow("mex", windowId);
        assert.deepEqual(flagged, { flagged: 1, depletedTs: [ts + 210] });
        assert.deepEqual((await cycles()).map((cycle) => cycle.ignored), [true, false, true]);
        assert.equal((await db.flagRestocksOutsideWindow("mex", windowId)).flagged, 0);
        assert.equal((await db.flagOutlierRestocks("mex", windowId)).flagged, 0);
        // Explicit replay uses the configured window without needing a baseline.
        await importAndRebuild([sample(400, 0)]);
        await importAndRebuild([sample(580, 100)]);
        assert.equal((await cycles()).at(-1).ignored, true);
        // Historical imports and rebuilds must apply the same automatic rule.
        await importAndRebuild([sample(600, 0), sample(780, 100)]);
        assert.equal((await cycles()).at(-1).ignored, true);
        await db.backfillRestocksForItem("mex", windowId);
        assert.deepEqual((await cycles()).map((cycle) => cycle.ignored), [true, false, true, true, true]);
      } finally {
        await pool.query("DELETE FROM snapshots WHERE item_id = $1", [windowId]);
        await pool.query("DELETE FROM restocks WHERE item_id = $1", [windowId]);
        await pool.query("DELETE FROM empty_for_bounds WHERE item_id = $1", [windowId]);
      }
    });

    await t.test("rebuild refuses a busy ingestion lock without deleting existing cycles", async () => {
      const writer = await pool.connect();
      const before = await db.getRestocks("mex", itemId);
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`snapshots:mex:${itemId}`]);
        await assert.rejects(db.backfillRestocksForItem("mex", itemId),
          (err) => err.code === "RESTOCK_REBUILD_BUSY");
        assert.deepEqual(await db.getRestocks("mex", itemId), before);
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
      }
      // The same rebuild succeeds once ingestion has released its lock.
      await db.backfillRestocksForItem("mex", itemId);
      assert.deepEqual(await db.getRestocks("mex", itemId), before);
    });

    await t.test("a failed batch inserts no observations or metadata", async () => {
      await assert.rejects(db.saveApiSnapshots([
        { ...record(400, 10), itemId: 999999, name: "Must roll back" },
        { ...record(401, 10), cost: "invalid bigint" },
      ]));
      assert.equal((await pool.query("SELECT * FROM items WHERE item_id = 999999")).rowCount, 0);
      assert.equal(await db.getSnapshot("mex", itemId, ts + 401), null);
    });

    await t.test("admin timestamp edits preserve the original source", async () => {
      const updated = await db.updateSnapshot("mex", itemId, ts + 360, { snapshot_ts: ts + 361 }, "API");
      assert.equal(updated.source, "API");
      assert.equal(await db.getSnapshot("mex", itemId, ts + 360), null);
      assert.equal((await db.getSnapshot("mex", itemId, ts + 361, "API")).source, "API");
    });

    await t.test("source-specific edits and deletions cannot affect the other source", async () => {
      await db.saveSnapshot(yata(600, 10));
      await importAndRebuild([record(600, 20)]);
      await db.updateSnapshot("mex", itemId, ts + 600, { quantity: 30 }, "API");
      assert.equal((await db.getSnapshot("mex", itemId, ts + 600, "YATA")).quantity, 10);
      assert.equal((await db.getSnapshot("mex", itemId, ts + 600, "API")).quantity, 30);
      // Moving an API observation onto an existing YATA timestamp is also valid.
      await db.updateSnapshot("mex", itemId, ts + 600, { snapshot_ts: ts }, "API");
      assert.equal((await db.getSnapshot("mex", itemId, ts, "YATA")).quantity, 100);
      assert.equal((await db.getSnapshot("mex", itemId, ts, "API")).quantity, 30);
      await db.deleteSnapshot("mex", itemId, ts, "API");
      assert.ok(await db.getSnapshot("mex", itemId, ts, "YATA"));
      assert.equal(await db.deleteSnapshots("mex", itemId, [{ snapshot_ts: ts + 600, source: "YATA" }]), 1);
    });

    await t.test("100 historical API observations leave derived history unchanged until an explicit backfill", async () => {
      const otherId = 999998;
      await pool.query("INSERT INTO items (item_id, name) VALUES ($1, 'Replay test')", [otherId]);
      await pool.query(`INSERT INTO snapshots (country,item_id,snapshot_ts,quantity,cost,source)
        SELECT 'mex',$1,$2 + n, CASE WHEN n % 100 >= 40 THEN 0 ELSE 100 - n % 100 END,300,'YATA'
        FROM generate_series(0,999) AS n`, [otherId, ts - 2000]);
      await db.backfillRestocksForItem("mex", otherId);
      const oldRows = (await pool.query("SELECT * FROM restocks WHERE item_id=$1 AND depleted_ts<$2 ORDER BY depleted_ts", [otherId, ts - 1300])).rows;
      const imported = Array.from({ length: 100 }, (_, n) => ({ ...record(0, n < 50 ? 50 : 0),
        itemId: otherId, snapshot_ts: ts - 1100 + n, name: "Replay test" }));
      const before = (await pool.query("SELECT * FROM restocks WHERE item_id=$1 ORDER BY depleted_ts", [otherId])).rows;
      assert.deepEqual(await db.saveApiSnapshots(imported), { inserted: 100, skipped: 0 });
      assert.deepEqual((await pool.query("SELECT * FROM restocks WHERE item_id=$1 ORDER BY depleted_ts", [otherId])).rows, before);
      await db.backfillRestocksForItem("mex", otherId);
      const partial = (await pool.query("SELECT * FROM restocks WHERE item_id=$1 ORDER BY depleted_ts", [otherId])).rows;
      assert.deepEqual((await pool.query("SELECT * FROM restocks WHERE item_id=$1 AND depleted_ts<$2 ORDER BY depleted_ts", [otherId, ts - 1300])).rows, oldRows);
      await db.backfillRestocksForItem("mex", otherId);
      assert.deepEqual((await pool.query("SELECT * FROM restocks WHERE item_id=$1 ORDER BY depleted_ts", [otherId])).rows, partial);
      assert.deepEqual(await importAndRebuild(imported), { inserted: 0, skipped: 100 });
      await pool.query("DELETE FROM snapshots WHERE item_id=$1", [otherId]);
    });

    await t.test("retention purges old observations from either source", async () => {
      const oldTs = ts - 31 * 86400;
      await pool.query("INSERT INTO snapshots VALUES ('mex', $1, $2, 1, 1, 'YATA'), ('mex', $1, $3, 1, 1, 'API')", [itemId, oldTs, oldTs + 1]);
      const { purgeOldSnapshots } = await import("../src/snapshot-retention.js");
      assert.equal((await purgeOldSnapshots()).deleted, 2);
      assert.equal((await db.getHistory("mex", itemId, 0)).length, 11);
    });
    await t.test("notifications arrive after commit, and rolled-back writes do not notify", async () => {
      const listener = await pool.connect();
      const writer = await pool.connect();
      const received = [];
      let delivered;
      const arrival = new Promise((resolve) => { delivered = resolve; });
      const onNotification = (event) => {
        const payload = JSON.parse(event.payload);
        if (payload.itemId === 999997) { received.push(payload); delivered(); }
      };
      listener.on("notification", onNotification);
      try {
        await listener.query("LISTEN snapshot_updates");
        await writer.query("BEGIN");
        await writer.query("INSERT INTO snapshots VALUES ('mex',999997,$1,1,1,'API')", [ts]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(received.length, 0);
        await writer.query("COMMIT");
        let deadline;
        try { await Promise.race([arrival, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("No commit notification")), 2000);
        })]); } finally { clearTimeout(deadline); }
        assert.equal(received.length, 1);
        assert.equal(received[0].snapshot_ts, ts);
        await writer.query("BEGIN");
        await writer.query("INSERT INTO snapshots VALUES ('mex',999997,$1,2,1,'API')", [ts + 1]);
        await writer.query("ROLLBACK");
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(received.length, 1);
      } finally {
        listener.removeListener("notification", onNotification);
        await listener.query("UNLISTEN snapshot_updates");
        listener.release(); writer.release();
      }
    });
  } finally {
    await closePool();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
