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
  const context = vm.createContext({
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
    "clampChartOffsetSec", "getVisibleChartRange", "chartTimeUnitForSpan", "applyChartView",
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
