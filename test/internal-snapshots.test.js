import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createInternalSnapshotsRouter } from "../src/internal-snapshots.js";
const INTERNAL_API_KEY = "test-only-internal-key";

const record = () => ({
  country: "mex", itemId: 260, name: "Dahlia", snapshot_ts: 1_700_000_000,
  quantity: 100, cost: 300,
});

async function fixture(t, save = async () => ({ inserted: 1, skipped: 0 })) {
  const previous = process.env.INTERNAL_API_KEY;
  process.env.INTERNAL_API_KEY = INTERNAL_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = previous;
  });
  const app = express();
  app.use(express.json());
  app.use("/api/internal/snapshots", createInternalSnapshotsRouter(save));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return async (body, key = INTERNAL_API_KEY, suffix = "") => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/internal/snapshots${suffix}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(key == null ? {} : { "X-Internal-Key": key }) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
}

test("internal ingestion rejects missing, incorrect and query-only keys before writing", async (t) => {
  let writes = 0;
  const put = await fixture(t, async () => { writes++; });
  for (const key of [null, "wrong", "x".repeat(INTERNAL_API_KEY.length)]) {
    const result = await put({ snapshots: [record()] }, key);
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: "Invalid internal API key" });
  }
  assert.equal((await put({ snapshots: [record()] }, null, `?key=${INTERNAL_API_KEY}`)).status, 401);
  assert.equal(writes, 0);
});

test("authorized PUT passes normalized records and accepts without waiting for persistence", async (t) => {
  let received;
  const put = await fixture(t, async (records) => {
    received = records;
    return { inserted: 0, skipped: 1 };
  });
  const result = await put({ snapshots: [{ ...record(), name: "  Dahlia  " }] });
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, { accepted: true });
  assert.deepEqual(received, [record()]);
});

test("invalid batches are rejected in full, including source spoofing and millisecond timestamps", async (t) => {
  let writes = 0;
  const put = await fixture(t, async () => { writes++; });
  const invalid = [
    undefined, null, [], Array.from({ length: 101 }, record), [null],
    [record(), record()],
    ...[
      { country: "unknown" }, { country: "toString" }, { itemId: 0 }, { itemId: 2 ** 31 },
      { itemId: "260" }, { name: " " }, { name: "x".repeat(256) },
      { snapshot_ts: Date.now() }, { snapshot_ts: 0 }, { snapshot_ts: 1.5 },
      { quantity: -1 }, { quantity: Number.MAX_SAFE_INTEGER + 1 },
      { quantity: "100" }, { cost: -1 }, { source: "YATA" },
    ].map((change) => [record(), { ...record(), itemId: 261, ...change }]),
  ];
  for (const snapshots of invalid) {
    const result = await put({ snapshots });
    assert.equal(result.status, 400, JSON.stringify(snapshots));
  }
  assert.equal(writes, 0);
});

test("separate endpoint uploads share per-country/item run buffers", async (t) => {
  const saved = [];
  const put = await fixture(t, async (records) => {
    saved.push(...records);
    return { inserted: records.length, skipped: 0 };
  });
  const upload = async (offset, mexQuantity, canQuantity) => {
    const snapshots = [
      { ...record(), snapshot_ts: record().snapshot_ts + offset, quantity: mexQuantity },
      { ...record(), country: "can", snapshot_ts: record().snapshot_ts + offset, quantity: canQuantity },
    ];
    assert.equal((await put({ snapshots })).status, 202);
    await new Promise((resolve) => setImmediate(resolve));
  };
  await upload(0, 100, 100);
  await upload(1, 100, 100);
  await upload(2, 100, 50);
  await upload(3, 50, 50);
  assert.deepEqual(saved.filter((r) => r.country === "mex").map((r) => r.snapshot_ts - record().snapshot_ts), [0, 2, 3]);
  assert.deepEqual(saved.filter((r) => r.country === "can").map((r) => r.snapshot_ts - record().snapshot_ts), [0, 1, 2]);
});

test("a pending save does not delay acceptance, and a failure does not stop later uploads", async (t) => {
  let rejectSave;
  let started;
  const saving = new Promise((resolve) => { started = resolve; });
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  let writes = 0;
  let completed;
  const done = new Promise((resolve) => { completed = resolve; });
  const put = await fixture(t, () => {
    writes++;
    if (writes === 1) {
      started();
      return new Promise((_, reject) => { rejectSave = reject; });
    }
    completed();
    return { inserted: 1, skipped: 0 };
  });
  const result = await put({ snapshots: [record()] });
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, { accepted: true });
  await saving;
  assert.equal((await put({ snapshots: [{ ...record(), snapshot_ts: record().snapshot_ts + 1 }] })).status, 202);
  assert.equal(writes, 1);
  rejectSave(Object.assign(new Error(`statement timeout ${INTERNAL_API_KEY} postgres://user:password@db/app`), {
    code: "57014",
  }));
  await done;
  assert.equal(writes, 2);
  const details = JSON.parse(logs[0][1]);
  assert.match(details.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(details.code, "57014");
  assert.equal(details.recordCount, 1);
  assert.equal(details.retryable, true);
  assert.ok(!JSON.stringify(details).includes(INTERNAL_API_KEY));
  assert.ok(!JSON.stringify(details).includes("password"));
});

test("the background queue is bounded while the writer is stalled", async (t) => {
  t.mock.method(console, "log", () => {});
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  let completed;
  const done = new Promise((resolve) => { completed = resolve; });
  const put = await fixture(t, async () => {
    await waiting;
    if (++writes === 101) completed();
    return { inserted: 1, skipped: 0 };
  });
  try {
    for (let i = 0; i < 101; i++) {
      assert.equal((await put({ snapshots: [record()] })).status, 202);
    }
    assert.equal((await put({ snapshots: [record()] })).status, 503);
  } finally {
    release();
    await done;
    await new Promise((resolve) => setImmediate(resolve));
  }
});


test("unconfigured or blank environment keys disable ingestion without allowing empty credentials", async (t) => {
  let writes = 0;
  const put = await fixture(t, async () => { writes++; });
  for (const key of [undefined, "", "   "]) {
    if (key === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = key;
    for (const supplied of [null, "", INTERNAL_API_KEY]) {
      const result = await put({ snapshots: [record()] }, supplied);
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, { error: "Internal API is not configured" });
    }
  }
  assert.equal(writes, 0);
});

test("authentication uses the current environment key without a hardcoded fallback", async (t) => {
  const put = await fixture(t);
  process.env.INTERNAL_API_KEY = "rotated-test-key";
  assert.equal((await put({ snapshots: [record()] }, INTERNAL_API_KEY)).status, 401);
  assert.equal((await put({ snapshots: [record()] }, "rotated-test-key")).status, 202);
});
