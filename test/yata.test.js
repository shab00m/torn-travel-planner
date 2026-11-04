import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/yata.js", import.meta.url), "utf8")
  .replace('import { saveSnapshot } from "./db.js";', "")
  .replaceAll("export function", "function");

function harness(fetch, saveSnapshot = async () => 1) {
  const timers = new Map();
  const intervals = [];
  const saved = [];
  let nextId = 0;
  const context = vm.createContext({
    fetch, AbortController,
    saveSnapshot: async (stocks) => { saved.push(stocks); return saveSnapshot(stocks); },
    console: { log() {}, warn() {}, error() {} },
    setTimeout(fn, delay) { timers.set(++nextId, { fn, delay }); return nextId; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay) { intervals.push({ fn, delay }); },
  });
  vm.runInContext(source, context);
  return { context, timers, intervals, saved };
}

const response = (timestamp) => ({ ok: true, json: async () => ({ stocks: {}, timestamp }) });
const flush = () => new Promise((resolve) => setImmediate(resolve));

for (const stage of ["fetch", "body"]) {
  test(`polling recovers when ${stage} hangs despite abort; late results are discarded`, async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    let firstSignal;
    const h = harness(async (_url, { signal }) => {
      calls++;
      if (calls > 1) return response(2);
      firstSignal = signal;
      return stage === "fetch" ? pending : { ok: true, json: () => pending };
    });
    const firstPoll = h.context.poll();
    await flush();
    await h.context.poll();
    assert.equal(calls, 1, "a healthy in-flight request must not overlap");
    const deadline = [...h.timers.values()][0];
    assert.equal(deadline.delay, 15_000);
    deadline.fn();
    await firstPoll;
    assert.equal(firstSignal.aborted, true);
    assert.match(h.context.getLatest().lastError, /timed out/);
    assert.equal(h.timers.size, 0);

    await h.context.poll();
    assert.equal(calls, 2);
    assert.equal(h.context.getLatest().payload.timestamp, 2);
    assert.equal(h.context.getLatest().lastError, null);
    release(stage === "fetch" ? response(1) : { stocks: {}, timestamp: 1 });
    await flush();
    assert.equal(h.context.getLatest().payload.timestamp, 2);
    assert.equal(h.saved.length, 1, "a timed-out response must never be persisted");
    assert.equal(h.timers.size, 0);
  });
}

test("slow persistence does not block minute polling and queues only the latest payload", async () => {
  let timestamp = 0;
  let releaseSave;
  const pendingSave = new Promise((resolve) => { releaseSave = resolve; });
  const h = harness(async () => response(++timestamp), () => pendingSave);
  h.context.startPolling();
  await flush();
  assert.equal(h.intervals[0].delay, 60_000);
  await h.intervals[0].fn();
  await h.intervals[0].fn();
  assert.equal(timestamp, 3);
  assert.equal(h.context.getLatest().payload.timestamp, 3);
  assert.equal(h.saved.length, 1);
  releaseSave(1);
  await flush();
  assert.equal(h.saved.length, 2, "only one queued save should follow the original save");
  assert.equal(h.timers.size, 0);
});

test("HTTP and malformed payload errors clear the deadline and allow retry", async () => {
  const responses = [
    { ok: false, status: 503 },
    { ok: true, json: async () => ({}) },
    response(3),
  ];
  const h = harness(async () => responses.shift());
  await h.context.poll();
  assert.match(h.context.getLatest().lastError, /HTTP 503/);
  await h.context.poll();
  assert.match(h.context.getLatest().lastError, /missing/);
  await h.context.poll();
  assert.equal(h.context.getLatest().payload.timestamp, 3);
  assert.equal(h.context.getLatest().lastError, null);
  assert.equal(h.timers.size, 0);
});
