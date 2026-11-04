import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { nextRestock, simulateStockPredictions } from "../public/stock-predictions.js";

const defaults = {
  startTs: 1000, endTs: 10000, startQty: 0, nowTs: 2000,
  openDepletedTs: 900, openCycleKey: 900,
  averages: { restockSec: 600, rate: 60, restockQty: 600 },
  avgEmptySec: 600, maxEmptySec: null, durations: [],
  rateForCycle: () => 60,
};
const simulate = (overrides = {}) => simulateStockPredictions({ ...defaults, ...overrides });
const restocks = (result) => result.events.filter((e) => e.type === "restock");

test("overdue unconfirmed restock waits until at least now plus one minute", () => {
  const result = simulate();
  assert.equal(restocks(result)[0].ts, 2060);
  assert.ok(result.segments.every((s) => s.start_ts >= 2060));
  assert.ok(restocks(result).every((e) => e.ts >= 2060));
});

test("a future historical duration remains usable before the maximum expires", () => {
  assert.equal(restocks(simulate({ durations: [600, 1400], maxEmptySec: 1600 }))[0].ts, 2300);
});

test("missed restock uses average empty time and sell-out time to anchor next cycle", () => {
  const result = simulate({ maxEmptySec: 1000 });
  // 900 + 600 empty -> missed restock at 1500; +600 in stock -> depleted at 2100.
  assert.equal(restocks(result)[0].ts, 2700);
  assert.equal(restocks(result)[0].depleted_ts, 2100);
  assert.ok(result.segments.every((s) => s.start_ts >= 2700));
  assert.ok(result.events.every((e) => e.ts == null || e.ts >= 2000));
});

test("long outages advance through multiple missed cycles", () => {
  const result = simulate({ nowTs: 5000, maxEmptySec: 1000 });
  assert.equal(restocks(result)[0].ts, 5100);
  assert.equal(restocks(result)[0].depleted_ts, 4500);
  assert.ok(result.segments.every((s) => s.start_ts >= 5100));
});

test("missed cycles use average empty time independently of the selected timing", () => {
  const result = simulate({ maxEmptySec: 1000,
    averages: { ...defaults.averages, restockSec: 900 } });
  assert.equal(restocks(result)[0].ts, 3000);
});

test("maximum must be exceeded, and missing average does not invent missed cycles", () => {
  assert.equal(restocks(simulate({ nowTs: 1900, maxEmptySec: 1000 }))[0].depleted_ts, 900);
  assert.equal(restocks(simulate({ maxEmptySec: 1000, avgEmptySec: null }))[0].ts, 2060);
});

test("observed positive stock may deplete in the past, but its next restock stays future", () => {
  const result = simulate({ startQty: 300 });
  assert.equal(result.events[0].ts, 1300);
  assert.equal(restocks(result)[0].ts, 2060);
  assert.equal(result.segments[0].start_ts, 1000);
  assert.equal(result.segments[1].start_ts, 2060);
});

test("ordinary future cycles retain their selected timing and depletion rate", () => {
  assert.deepEqual(restocks(simulate({ nowTs: 1000 })).slice(0, 2).map((e) => e.ts), [1500, 2700]);
});

test("no open stockout or forecast outside the horizon cannot create a past restock", () => {
  assert.equal(restocks(simulate({ openDepletedTs: null }))[0].ts, 2060);
  assert.equal(restocks(simulate({ endTs: 2050 })).length, 0);
});

test("zero-length empty periods still advance and invalid rates cannot loop", () => {
  const result = simulate({ averages: { ...defaults.averages, restockSec: 0 }, maxEmptySec: 0, avgEmptySec: 0 });
  assert.ok(restocks(result).every((e) => e.ts >= 2060));
  assert.deepEqual(simulate({ averages: { ...defaults.averages, rate: 0 } }), { events: [], segments: [] });
});

for (const file of ["public/item.js", "src/safe-windows.js"]) {
  test(`${file} uses the same missed-cycle scheduling`, () => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const start = source.indexOf("function simulatePredictions(");
    const closing = file.startsWith("public") ? "\n}" : "\n  }";
    const end = source.indexOf(closing, start) + closing.length;
    const sandbox = vm.createContext({
      window: { StockPredictions: { simulateStockPredictions } }, simulateStockPredictions,
      state: { restocks: [{ depleted_ts: 900, restocked_ts: null }] },
      restocks: [{ depleted_ts: 900, restocked_ts: null }],
      effectiveDepletedTs: (r) => r.depleted_ts,
      currentEmptyForBounds: () => ({ avgEmptyFor: 600, maxEmptyFor: 1000 }),
      emptyForBounds: { avgEmptyFor: 600, maxEmptyFor: 1000 },
      getUsableCompletedRestocks: () => [], depletionRateForCycle: () => 60,
    });
    vm.runInContext(source.slice(start, end), sandbox);
    const result = vm.runInContext("simulatePredictions(1000, 10000, 0, { restockSec: 600, rate: 60, restockQty: 600 }, 2000)", sandbox);
    assert.equal(restocks(result)[0].ts, 2700);
  });
}

const itemSource = readFileSync(new URL("../public/item.js", import.meta.url), "utf8");
function itemFunction(name, nextName) {
  return itemSource.slice(itemSource.indexOf(`function ${name}(`), itemSource.indexOf(`function ${nextName}(`));
}

test("chart keeps stale observations separate and shows a full future prediction horizon", () => {
  const nowTs = 20000;
  const sandbox = vm.createContext({
    Date: { now: () => nowTs * 1000 },
    tsMs: (ts) => ts * 1000,
    state: { item: { country: "mex" } },
    getArriveTs: () => null,
    getAverages: () => defaults.averages,
    simulatePredictions: (startTs, endTs, startQty, averages, wallTs) => simulate({
      startTs, endTs, startQty, averages, nowTs: wallTs, maxEmptySec: 1000,
    }),
  });
  vm.runInContext(itemFunction("qtyAtPredicted", "buildTimeline") + itemFunction("buildTimeline", "buildAnnotations"), sandbox);
  const timeline = vm.runInContext("buildTimeline([{ snapshot_ts: 1000, quantity: 0, cost: 100 }], 6)", sandbox);
  assert.equal(timeline.actualData.length, 1);
  assert.equal(timeline.actualData[0].x, 1000000);
  assert.equal(timeline.xMax, (nowTs + 6 * 3600) * 1000);
  assert.ok(restocks(timeline).every((e) => e.ts >= nowTs + 60));
  assert.ok(timeline.predictedData.filter((p) => p.x < (nowTs + 60) * 1000).every((p) => p.y === 0));
  assert.ok(timeline.predictedData.some((p) => p.y > 0));
});

test("safe windows skip the missed cycle and start in the future", () => {
  const sandbox = vm.createContext({
    window: { StockPredictions: { nextRestock } },
    Date: { now: () => 2000000 },
    state: { historicalRatePrediction: false },
    getHistoricalExtents: () => ({ minEmptyFor: 200, maxEmptyFor: 1000 }),
    safeWindowDepletionRate: () => 60,
    restockQtyForSafeWindow: () => 1200,
    initialDepletionEnvelope: () => ({ earliestDepleted: 900, latestDepleted: 900 }),
    currentEmptyForBounds: () => ({ avgEmptyFor: 600, maxEmptyFor: 1000 }),
  });
  vm.runInContext(itemFunction("computeCompoundSafeWindows", "safeWindowBoundsForEvent"), sandbox);
  const windows = vm.runInContext("computeCompoundSafeWindows(1000, 10000, 0)", sandbox);
  // missed restock 1500 + 1200 seconds in stock -> next stockout 2700
  assert.equal(windows[0].depletedTs, 2700);
  assert.equal(windows[0].safeStart, 3700);
  assert.ok(windows.every((w) => w.safeStart >= 2060));
});

test("live ticker rebuilds a prediction before it slips inside the one-minute minimum", () => {
  let tick;
  let redraws = 0;
  const sandbox = vm.createContext({
    Date: { now: () => 2001000 },
    document: { hidden: false },
    state: {
      chart: {}, chartPoints: [{}], restocks: [],
      lastTimeline: { wallTs: 2000, predictionWallTs: 2000, events: [{ type: "restock", ts: 2060 }] },
    },
    chartPan: {}, snapshotInspector: {},
    CHART_LIVE_PATCH_MS: 15000,
    updateCurrentDepletionCountdown() {},
    currentEmptyForBounds: () => ({ maxEmptyFor: null }),
    redrawPrediction() { redraws++; },
    setInterval(fn) { tick = fn; },
  });
  vm.runInContext(itemFunction("startLiveChartTicker", "parseItemFromUrl") + "startLiveChartTicker();", sandbox);
  tick();
  assert.equal(redraws, 1);
});
