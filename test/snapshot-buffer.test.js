import test from "node:test";
import assert from "node:assert/strict";
import { createSnapshotBuffer } from "../src/snapshot-buffer.js";

const record = (snapshot_ts, quantity, overrides = {}) => ({
  country: "mex", itemId: 260, name: "Dahlia", cost: 300,
  snapshot_ts, quantity, ...overrides,
});
function fixture() {
  const saved = [];
  const write = createSnapshotBuffer(async (records) => {
    saved.push(...records);
    return { inserted: records.length, skipped: 0 };
  });
  return { saved, write };
}

for (const separateUploads of [false, true]) {
  test(`preserves the user's run boundaries ${separateUploads ? "across uploads" : "within a batch"}`, async () => {
    const { saved, write } = fixture();
    const quantities = [100, 50, 50, 25, 0, 0, 0, 100, 50, 50, 50, 25, 25, 0, 0, 0, 0, 100];
    const records = quantities.map((quantity, ts) => record(ts + 1, quantity));
    if (separateUploads) {
      for (const row of records) await write([row]);
    } else {
      await write(records);
    }
    assert.deepEqual(saved.map((r) => r.quantity), [100, 50, 50, 25, 0, 0, 100, 50, 50, 25, 25, 0, 0, 100]);
    assert.deepEqual(saved.map((r) => r.snapshot_ts), [1, 2, 3, 4, 5, 7, 8, 9, 11, 12, 13, 14, 17, 18]);
  });
}

test("mixed batches keep independent state for the same item in different countries and different items", async () => {
  const { saved, write } = fixture();
  const streams = [{}, { country: "can" }, { itemId: 261 }];
  await write(streams.map((key) => record(1, 100, key)));
  await write(streams.map((key) => record(2, 100, key)));
  await write([
    record(5, 50), record(3, 100), record(4, 100),
    record(3, 100, { country: "can" }), record(3, 0, { itemId: 261 }),
  ]);
  const timestamps = (country, id) => saved.filter((r) => r.country === country && r.itemId === id).map((r) => r.snapshot_ts);
  assert.deepEqual(timestamps("mex", 260), [1, 4, 5]);
  assert.deepEqual(timestamps("can", 260), [1]);
  assert.deepEqual(timestamps("mex", 261), [1, 2, 3]);
  await write([record(4, 0, { country: "can" })]);
  assert.deepEqual(timestamps("can", 260), [1, 3, 4]);
});

test("price-only changes preserve the preceding timestamp, and repeats stay held indefinitely", async () => {
  const { saved, write } = fixture();
  await write([record(1, 100), record(2, 100), record(3, 100)]);
  assert.deepEqual(saved.map((r) => r.snapshot_ts), [1]);
  const result = await write([record(4, 100, { name: "Renamed" })]);
  assert.equal(result.submitted, 0);
  await write([record(5, 100, { cost: 400 })]);
  assert.deepEqual(saved.map((r) => [r.snapshot_ts, r.cost]), [[1, 300], [4, 300], [5, 400]]);
});

test("a failed insert preserves the earlier held boundary and does not suppress a later retry", async () => {
  const saved = [];
  let fail = false;
  const write = createSnapshotBuffer(async (rows) => {
    if (fail) throw new Error("database unavailable");
    saved.push(...rows);
    return { inserted: rows.length, skipped: 0 };
  });
  await write([record(1, 100), record(2, 100)]);
  fail = true;
  await assert.rejects(write([record(3, 0)]), /database unavailable/);
  fail = false;
  await write([record(4, 0)]);
  assert.deepEqual(saved.map((r) => [r.snapshot_ts, r.quantity]), [[1, 100], [2, 100], [4, 0]]);
});

test("late observations and same-time conflicts pass through without losing a held endpoint", async () => {
  const { saved, write } = fixture();
  await write([record(10, 100), record(20, 100)]);
  await write([record(15, 50)]);
  assert.deepEqual(saved.map((r) => r.snapshot_ts), [10, 20, 15]);
  await write([record(30, 100), record(30, 0)]);
  await write([record(40, 100)]);
  assert.deepEqual(saved.slice(3).map((r) => [r.snapshot_ts, r.quantity]), [[30, 100], [30, 0], [40, 100]]);
});
