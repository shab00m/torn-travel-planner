import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/item.js", import.meta.url), "utf8");
const hour = 3_600_000;
const origin = 1_700_000_000_000;
function timeline(start = origin, end = origin + 48 * hour) {
  return { xMin: start, xMax: end, wallTs: end / 1000, dataTs: end / 1000, events: [] };
}

function harness() {
  let nextTimeline = timeline();
  let now = origin + 36 * hour;
  let frameId = 0;
  let saves = 0;
  const frames = new Map();
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    performance: { now: () => 0 }, chartNowAnimation: null,
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    endActiveChartDrags() {}, saveCurrentItemSettings() { saves++; },
    CHART_VIEWPORT_HOURS: 24, CHART_MIN_VIEWPORT_SEC: 900,
    resetChartView: true,
    itemViewportRestore: { followLive: false },
    state: {
      item: { country: "mex", itemId: 260 }, chartOffsetSec: 0, chartScale: 1,
      predictionHours: 0, chart: { data: {}, options: {}, update() {} },
    },
    el: { itemEmpty: { classList: { toggle() {} } }, status: {} },
    window: {}, snapshotInspector: { selected: new Set() },
    fetchJson: async () => ({ points: [{ snapshot_ts: origin / 1000, quantity: 100 }] }),
    loadEmptyForBoundsForItem: async () => {},
    rebuildLastZeroLookup() {}, loadRestockData() {}, renderCycleHistory() {},
    buildTimeline: () => ({ ...nextTimeline }),
    predictionStartQty: () => null, renderPredictionPanel() {}, chartDatasets: () => [],
    syncOffsetInput() {}, syncScaleInput() {}, syncChartViewInteraction() {},
    updateChartMarkers() {}, repositionChartMarkers() {}, renderSnapshotInspector() {},
    buildAnnotations: () => ({}), updateTimeMarkers() {},
    tsMs: (ts) => ts * 1000, getArriveTs: () => null,
  });
  const names = ["getTimelineSpanSec", "getBaseChartViewportSpanSec", "getMinChartScale",
    "getMaxChartScale", "clampChartScale", "getChartViewportSpanSec", "getMaxChartOffsetSec",
    "getChartOffsetBounds", "clampChartOffsetSec", "getVisibleChartRange", "chartTimeUnitForSpan", "applyChartView",
    "cancelChartNowAnimation", "returnChartToNow", "syncChartReturnNow",
    "refreshChart", "drawChart", "redrawPrediction", "patchLiveChartTime"];
  for (const name of names) {
    const start = source.indexOf(`${name === "drawChart" ? "async " : ""}function ${name}(`);
    assert.ok(start >= 0, name);
    vm.runInContext(source.slice(start, source.indexOf("\n}", start) + 2), context);
  }
  context.chartOptions = (value) => {
    const { visMin, visMax } = context.getVisibleChartRange(value);
    return { scales: { x: { min: visMin, max: visMax, time: {} } },
      plugins: { annotation: { annotations: {} } } };
  };
  return { context, next(value) { nextTimeline = value; },
    now(value) { now = value; }, saves: () => saves,
    frame(time) {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((fn) => fn(time));
    },
    range() { const x = context.state.chart.options.scales.x; return [x.min, x.max]; } };
}

test("a manual pan stays put after the chart has followed a live update", async () => {
  const h = harness();
  const c = h.context;
  await c.drawChart();
  h.next(timeline(origin, origin + 48 * hour + 15_000));
  await c.drawChart();
  c.applyChartView(c.state.lastTimeline, { offsetSec: 3600 }, { live: true });
  const selected = h.range();
  for (let i = 2; i <= 5; i++) {
    h.next(timeline(origin, origin + 48 * hour + i * 15_000));
    c.redrawPrediction();
    await c.drawChart();
    assert.deepEqual(h.range(), selected);
  }
});

test("rolling history preserves the selected timestamps when its first snapshot changes", async () => {
  const h = harness();
  const c = h.context;
  await c.drawChart();
  c.applyChartView(c.state.lastTimeline, { offsetSec: 7200 });
  const selected = h.range();
  h.next(timeline(origin + hour, origin + 49 * hour));
  await c.drawChart();
  assert.deepEqual(h.range(), selected);
  assert.equal(c.state.chartOffsetSec, 3600);
});

test("prediction redraws and data refreshes consistently follow the live edge", async () => {
  const h = harness();
  const c = h.context;
  await c.drawChart();
  for (let i = 1; i <= 4; i++) {
    const end = origin + 48 * hour + i * 15_000;
    h.next(timeline(origin, end));
    c.redrawPrediction();
    assert.equal(h.range()[1], end);
    await c.drawChart();
    assert.equal(h.range()[1], end);
  }
});

test("the 15-second time patch checks live following before extending the timeline", async () => {
  const h = harness();
  const c = h.context;
  await c.drawChart();
  const end = origin + 48 * hour + 15_000;
  c.patchLiveChartTime(end / 1000);
  assert.equal(h.range()[1], end);
  c.applyChartView(c.state.lastTimeline, { offsetSec: 3600 });
  const selected = h.range();
  c.patchLiveChartTime((end + 15_000) / 1000);
  assert.deepEqual(h.range(), selected);
});

test("saved follow-live preference is restored once and does not override a later pan", async () => {
  const h = harness();
  const c = h.context;
  c.resetChartView = false;
  c.itemViewportRestore.followLive = true;
  await c.drawChart();
  assert.equal(h.range()[1], origin + 48 * hour);
  c.applyChartView(c.state.lastTimeline, { offsetSec: 3600 });
  const selected = h.range();
  await c.drawChart();
  assert.deepEqual(h.range(), selected);
});

test("NOW shortcut points toward the hidden marker and hides when NOW is visible", async () => {
  const h = harness();
  const c = h.context;
  await c.drawChart();
  const button = c.el.chartReturnNow = { dataset: {}, style: {} };
  const chart = c.state.chart;
  chart.chartArea = { left: 50, right: 750, top: 40, bottom: 340 };
  chart.canvas = { offsetLeft: 0, offsetTop: 32 };
  c.applyChartView(c.state.lastTimeline, { offsetSec: 0, scale: 4 });
  c.syncChartReturnNow(chart);
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, "NOW →");
  assert.equal(button.style.left, "742px");
  c.applyChartView(c.state.lastTimeline, { offsetSec: 40 * 3600 });
  c.syncChartReturnNow(chart);
  assert.equal(button.textContent, "← NOW");
  assert.equal(button.style.left, "58px");
  c.applyChartView(c.state.lastTimeline, { offsetSec: 33 * 3600 });
  c.syncChartReturnNow(chart);
  assert.equal(button.hidden, true);
});

for (const offsetSec of [0, 40 * 3600]) {
  test(`return to NOW animates from offset ${offsetSec}, centers, and retains zoom`, async () => {
    const h = harness();
    const c = h.context;
    await c.drawChart();
    c.applyChartView(c.state.lastTimeline, { offsetSec, scale: 4 });
    const start = h.range()[0];
    const target = origin + 33 * hour;
    c.returnChartToNow();
    h.frame(200);
    assert.ok(h.range()[0] > Math.min(start, target));
    assert.ok(h.range()[0] < Math.max(start, target));
    h.frame(400);
    assert.deepEqual(h.range(), [target, origin + 39 * hour]);
    assert.equal(c.state.chartScale, 4);
    assert.equal(h.saves(), 1);
    c.redrawPrediction();
    assert.deepEqual(h.range(), [target, origin + 39 * hour]);
  });
}

test("NOW centers without predictions and stays centered after a data refresh", async () => {
  const h = harness();
  const c = h.context;
  const now = origin + 48 * hour;
  h.now(now);
  await c.drawChart();
  c.applyChartView(c.state.lastTimeline, { offsetSec: 0 });
  c.window.matchMedia = () => ({ matches: true });
  c.returnChartToNow();
  assert.deepEqual(h.range(), [now - 12 * hour, now + 12 * hour]);
  h.next(timeline(origin + hour, now + 15_000));
  await c.drawChart();
  assert.deepEqual(h.range(), [now - 12 * hour, now + 12 * hour]);
  assert.equal(h.saves(), 1);
});

test("manual navigation cancels return-to-NOW without a later snap back", async () => {
  const h = harness();
  const c = h.context;
  await c.drawChart();
  c.applyChartView(c.state.lastTimeline, { offsetSec: 0, scale: 4 });
  c.returnChartToNow();
  h.frame(100);
  c.applyChartView(c.state.lastTimeline, { offsetSec: 3600 });
  const selected = h.range();
  h.frame(400);
  assert.deepEqual(h.range(), selected);
  assert.equal(h.saves(), 0);
});
