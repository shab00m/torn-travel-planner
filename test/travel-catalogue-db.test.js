import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

test("catalogue discoveries appear without fabricating stock and later accept either source", {
  skip: !process.env.TEST_DATABASE_URL, timeout: 15000,
}, async () => {
  const schema = `catalogue_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const { getPool, closePool } = await import("../src/pg.js");
  const db = await import("../src/db.js");
  const { saveTravelCatalogue } = await import("../src/travel-catalogue.js");
  const { loadCurrentStocks } = await import("../src/current-stocks.js");
  const pool = getPool();
  let listener;
  const notifications = [];
  const ts = Math.floor(Date.now() / 1000) - 60;
  const entry = { id: 198, name: "Ketamine", type: "Drug",
    shops: [{ country: "South Africa", buy_price: null }] };
  try {
    await db.initDb();
    listener = await pool.connect();
    listener.on("notification", (event) => notifications.push(JSON.parse(event.payload)));
    await listener.query("LISTEN snapshot_updates");
    await saveTravelCatalogue([entry, { id: 1, name: "Torn-only item", type: "Tool", shops: [] }]);
    const feed = await loadCurrentStocks();
    assert.equal(feed.timestamp, null);
    assert.equal(feed.stocks.sou.update, null);
    assert.deepEqual(feed.stocks.sou.stocks, [{ id: 198, name: "Ketamine", item_type: "Drug",
      cost: null, quantity: null, snapshot_ts: null, source: null }]);
    assert.deepEqual(Object.keys(feed.stocks), ["sou"]);
    assert.equal((await pool.query("SELECT * FROM snapshots")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM restocks")).rowCount, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(notifications.some((r) => r.country === "sou" && r.itemId === 198 && r.snapshot_ts === null));

    await saveTravelCatalogue([{ ...entry, shops: [] }]);
    assert.equal((await loadCurrentStocks()).stocks.sou.stocks.length, 1, "partial catalogues retain discoveries");
    await db.saveApiSnapshots([{ country: "sou", itemId: 198, name: "Ketamine",
      snapshot_ts: ts, quantity: 100, cost: 55000 }]);
    let item = (await loadCurrentStocks()).stocks.sou.stocks[0];
    assert.equal(item.quantity, 100);
    assert.equal(item.source, "API");

    // A subsequent update adds a new country for an existing item and a new ID.
    await saveTravelCatalogue([entry, { id: 999999, name: "Future item", type: "Future category",
      shops: [{ country: "Canada", buy_price: 123 }] }]);
    let future = (await loadCurrentStocks()).stocks.can.stocks[0];
    assert.equal(future.cost, 123);
    assert.equal(future.quantity, null);
    await db.saveSnapshot({ sou: { update: ts + 1, stocks: [
      { id: 198, name: "Ketamine", quantity: 50, cost: 56000 },
      { id: 999998, name: "YATA-only new item", quantity: 10, cost: 200 },
    ] }, can: { update: ts + 1, stocks: [
      { id: 999999, name: "Future item", quantity: 0, cost: 125 },
    ] } });
    await saveTravelCatalogue([entry]);
    const updated = await loadCurrentStocks();
    item = updated.stocks.sou.stocks.find((r) => r.id === 198);
    assert.equal(item.quantity, 50);
    assert.equal(item.cost, 56000, "catalogue prices never overwrite observations");
    assert.equal(item.source, "YATA");
    assert.equal(updated.stocks.sou.stocks.find((r) => r.id === 999998).name, "YATA-only new item");
    future = updated.stocks.can.stocks[0];
    assert.equal(future.quantity, 0);
    assert.equal(future.cost, 125);
    assert.equal(updated.timestamp, ts + 1);

    const { getItemDeprecation, setItemDeprecation } = await import("../src/item-deprecation.js");
    const { purgeOldSnapshots } = await import("../src/snapshot-retention.js");
    const { compactUnchangedSnapshots } = await import("../src/snapshot-compaction.js");
    const old = ts - 45 * 86400;
    await db.saveApiSnapshots([0, 60, 120].map((offset) => ({
      country: "swi", itemId: 198, name: "Ketamine", snapshot_ts: old + offset, quantity: 0, cost: 1000,
    })));
    await pool.query("INSERT INTO restocks (country,item_id,depleted_ts) VALUES ('swi',198,$1)", [old]);
    const historyBefore = await db.getHistory("swi", 198, 0);
    const restocksBefore = await db.getRestocks("swi", 198);
    const result = await saveTravelCatalogue([entry], { reconcile: true });
    assert.equal(result.deprecated, 1);
    assert.deepEqual(await getItemDeprecation("swi", 198), {
      deprecated: true, catalogueDeprecated: true, override: null,
    });
    assert.ok(!(await loadCurrentStocks()).stocks.swi);
    assert.equal((await loadCurrentStocks()).stocks.sou.stocks[0].id, 198);
    assert.equal((await loadCurrentStocks()).stocks.can.stocks[0].id, 999999,
      "an absent catalogue item must not be treated as proof of removal");
    assert.deepEqual(await db.getHistory("swi", 198, 0), historyBefore);
    assert.deepEqual(await db.getRestocks("swi", 198), restocksBefore);

    // An old YATA listing cannot undo Torn's authoritative removal.
    await db.saveSnapshot({ swi: { update: ts + 2, stocks: [{ id: 198, name: "Ketamine", quantity: 0, cost: 1000 }] } });
    await saveTravelCatalogue([{ ...entry, shops: [{ country: "Switzerland", buy_price: 1000 }] }]);
    assert.equal((await getItemDeprecation("swi", 198)).deprecated, true);

    // Preserve old observations during both daily retention and compaction.
    await db.saveApiSnapshots([{ country: "can", itemId: 999999, name: "Future item", snapshot_ts: old, quantity: 1, cost: 123 }]);
    const preserved = await db.getHistory("swi", 198, 0);
    assert.equal((await purgeOldSnapshots()).deleted, 1);
    await compactUnchangedSnapshots();
    assert.deepEqual(await db.getHistory("swi", 198, 0), preserved);
    assert.deepEqual(await db.getRestocks("swi", 198), restocksBefore);

    await setItemDeprecation("swi", 198, false);
    await saveTravelCatalogue([entry], { reconcile: true });
    assert.equal((await getItemDeprecation("swi", 198)).deprecated, false, "admin restore persists");
    assert.ok((await loadCurrentStocks()).stocks.swi);
    await setItemDeprecation("swi", 198, null);
    assert.equal((await getItemDeprecation("swi", 198)).deprecated, true);
    const returned = { ...entry, shops: [...entry.shops, { country: "Switzerland", buy_price: 1000 }] };
    assert.equal((await saveTravelCatalogue([returned], { reconcile: true })).reactivated, 1);
    assert.equal((await getItemDeprecation("swi", 198)).deprecated, false);
    await setItemDeprecation("swi", 198, true);
    await saveTravelCatalogue([returned], { reconcile: true });
    assert.equal((await getItemDeprecation("swi", 198)).deprecated, true, "admin deprecation persists");
    assert.equal((await getItemDeprecation("sou", 198)).deprecated, false, "flags are country-specific");
    assert.equal(await setItemDeprecation("uae", 123456, true), null);
    await assert.rejects(saveTravelCatalogue([], { reconcile: true }), /incomplete/);
  } finally {
    listener?.release();
    await closePool();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
