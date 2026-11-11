import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class Events {
  handlers = new Map();
  addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); }
  removeEventListener(type, fn) { this.handlers.get(type)?.delete(fn); }
  dispatchEvent(event) { for (const fn of this.handlers.get(event.type) ?? []) fn(event); }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness(update) {
  const window = new Events();
  const document = Object.assign(new Events(), { visibilityState: "visible" });
  const timers = new Map();
  const streams = [];
  let id = 0;
  let revision = "boot:0";
  let probes = 0;
  class Stream extends Events { constructor() { super(); streams.push(this); } close() {} }
  const context = vm.createContext({
    window, document, EventSource: Stream,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    state: { item: { country: "mex", itemId: 260 } }, lastKnownStockTimestamp: 100,
    fetchJson: async () => { probes++; return { snapshotRevision: revision, timestamp: 100 }; },
    setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const source = readFileSync(new URL("../public/shared.js", import.meta.url), "utf8");
  vm.runInContext(source.slice(source.indexOf("let snapshotEventStream"), source.indexOf("function itemUrl(")), context);
  const stop = context.startStockUpdateWatcher(update);
  return {
    stop, probes: () => probes, revision: (value) => { revision = value; },
    async timer(delay) { const entry = [...timers].find(([, value]) => value.delay === delay); assert.ok(entry, `no ${delay}ms timer`); timers.delete(entry[0]); void entry[1].fn(); await flush(); },
    push(items) { streams[0].dispatchEvent({ type: "snapshots", data: JSON.stringify({ items, revision: "boot:1" }) }); },
  };
}

test("DB push refreshes the item without waiting for a YATA timestamp or fallback tick", async () => {
  let refreshes = 0;
  const h = harness(async () => { refreshes++; });
  await flush(); await h.timer(100); // Initial catch-up.
  const probes = h.probes();
  h.push([{ country: "can", itemId: 260 }]);
  assert.equal(refreshes, 1);
  h.push([{ country: "mex", itemId: 260 }]);
  await h.timer(100);
  assert.equal(refreshes, 2);
  assert.equal(h.probes(), probes);
  h.stop();
});

test("two-second revision polling catches API writes while the YATA timestamp stays unchanged", async () => {
  let refreshes = 0;
  const h = harness(async () => { refreshes++; });
  await flush(); await h.timer(100);
  h.revision("boot:2");
  await h.timer(2000); await h.timer(100);
  assert.equal(refreshes, 2);
  await h.timer(2000);
  assert.equal(refreshes, 2, "unchanged revisions do not redraw charts");
  h.stop();
});

test("a commit arriving during refresh queues another refresh instead of being lost", async () => {
  let release;
  let refreshes = 0;
  const h = harness(() => { refreshes++; return refreshes === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(); });
  await flush(); await h.timer(100);
  h.push([{ country: "mex", itemId: 260 }]);
  assert.equal(refreshes, 1);
  release(); await flush(); await h.timer(200);
  assert.equal(refreshes, 2);
  h.stop();
});

test("restock alarm confirmation reads the DB-backed stock endpoint", async () => {
  const source = readFileSync(new URL("../public/alarms.js", import.meta.url), "utf8");
  const start = source.indexOf("async function resolveDueRestockAlarm(");
  const calls = [];
  let observed;
  const context = vm.createContext({
    fireAt: () => 0, ensureRestockAmountsForArmedAlarms: async () => {},
    fetch: async (url) => { calls.push(url); return { ok: true, json: async () => url.endsWith("/stock") ? { quantity: 777 } : { restocks: [], rates: [] } }; },
    tryFireRestockAlarmOnStock: (_alarm, quantity) => { observed = quantity; return true; },
  });
  vm.runInContext(source.slice(start, source.indexOf("\n}", start) + 2), context);
  await context.resolveDueRestockAlarm({ type: "restock", country: "mex", itemId: 260 });
  assert.equal(observed, 777);
  assert.ok(calls.includes("/api/items/mex/260/stock"));
  assert.ok(!calls.includes("/api/stocks"));
});


test("an armed alarm confirms positive stock without a derived restock row", async () => {
  const source = readFileSync(new URL("../public/alarms.js", import.meta.url), "utf8");
  let quantity = 0;
  const fired = [];
  const context = vm.createContext({
    fireAt: (alarm) => alarm.eventTs,
    ensureRestockAmountsForArmedAlarms: async () => {},
    fetch: async (url) => ({ ok: true, json: async () => url.endsWith("/stock")
      ? { quantity } : { restocks: [], rates: [] } }),
    isNegligibleAlarmStockQty: () => false,
    persistAlarms() {}, fireAlarm: (alarm) => { alarm.firedAt = Date.now(); fired.push(alarm); },
  });
  for (const name of ["async function resolveDueRestockAlarm(", "function tryFireRestockAlarmOnStock("]) {
    const start = source.indexOf(name);
    vm.runInContext(source.slice(start, source.indexOf("\n}", start) + 2), context);
  }
  const alarm = { type: "restock", country: "mex", itemId: 260,
    depletedTs: Math.floor(Date.now() / 1000) - 120,
    eventTs: Math.floor(Date.now() / 1000) + 120, awaitActual: true };
  await context.resolveDueRestockAlarm(alarm);
  assert.equal(fired.length, 0);
  quantity = 100;
  await context.resolveDueRestockAlarm(alarm);
  assert.equal(fired.length, 1);
  assert.equal(alarm.awaitActual, false);
});
