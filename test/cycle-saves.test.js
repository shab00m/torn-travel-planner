import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/item.js", import.meta.url), "utf8");
const tick = () => new Promise(setImmediate);
function setup() {
  const requests = [];
  const state = { item: { country: "can", itemId: 206 },
    restocks: [{ depleted_ts: 10, ignored: false }, { depleted_ts: 20, ignored: false }], rates: [] };
  const pending = new Map();
  const context = vm.createContext({
    state, pendingCycleChanges: pending, cycleSaveQueue: Promise.resolve(),
    isAdminUser: () => true, adminApiHeaders: () => ({}),
    renderCycleHistory() {}, refreshRestockViews() {}, syncCycleHistoryActionButtons() {},
    storeEmptyForBounds() {}, fillEmptyForBoundInputs() {}, clearSafeWindowsCache() {},
    fetchJsonWithBody: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  });
  for (const name of ["loadRestockData", "setCycleIgnored"]) {
    const start = source.indexOf(`${name === "setCycleIgnored" ? "async " : ""}function ${name}(`);
    vm.runInContext(source.slice(start, source.indexOf("\n}", start) + 2), context);
  }
  return { context, requests, state, pending };
}

test("rapid checkbox clicks save serially and preserve other pending choices across refreshes", async () => {
  const { context, requests, state, pending } = setup();
  const first = context.setCycleIgnored(10, true);
  const second = context.setCycleIgnored(20, true);
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.body.includeViews, false);
  assert.deepEqual(state.restocks.map((r) => r.ignored), [true, true]);
  context.loadRestockData({ restocks: [{ depleted_ts: 10, ignored: false }, { depleted_ts: 20, ignored: false }] });
  assert.deepEqual(state.restocks.map((r) => r.ignored), [true, true]);
  requests[0].resolve({ ok: true, bounds: {}, rates: [] });
  await first;
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(pending.has(10), false);
  assert.equal(pending.has(20), true);
  requests[1].resolve({ ok: true, bounds: {}, rates: [] });
  await second;
  assert.equal(pending.size, 0);
  assert.deepEqual(state.restocks.map((r) => r.ignored), [true, true]);
});

test("a failed save restores only that checkbox and remaining queued saves still complete", async () => {
  const { context, requests, state, pending } = setup();
  const first = context.setCycleIgnored(10, true);
  const rejected = assert.rejects(first, /busy/);
  const second = context.setCycleIgnored(20, true);
  await tick();
  requests[0].reject(new Error("busy"));
  await rejected;
  await tick();
  assert.deepEqual(state.restocks.map((r) => r.ignored), [false, true]);
  assert.equal(requests.length, 2);
  requests[1].resolve({ ok: true, bounds: {}, rates: [] });
  await second;
  assert.equal(pending.size, 0);
});
