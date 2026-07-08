// Item detail page: chart, restock stats, and predictions.
Chart.register(window["chartjs-plugin-annotation"]);

const el = {
  status: document.getElementById("status"),
  itemTitle: document.getElementById("item-title"),
  itemSubtitle: document.getElementById("item-subtitle"),
  itemEmpty: document.getElementById("item-empty"),
  rangeButtons: document.getElementById("range-buttons"),
  chartCanvas: document.getElementById("history-chart"),
  timeMarkers: document.getElementById("time-markers"),
  restockMarkers: document.getElementById("restock-markers"),
  safeWindowMarkers: document.getElementById("safe-window-markers"),
  avgButtons: document.getElementById("avg-buttons"),
  restockAvg: document.getElementById("restock-avg"),
  cycleOpenNote: document.getElementById("cycle-open-note"),
  cycleHistoryBody: document.getElementById("cycle-history-body"),
  rateAvgButtons: document.getElementById("rate-avg-buttons"),
  rateAvg: document.getElementById("rate-avg"),
  predictionButtons: document.getElementById("prediction-buttons"),
  predictionList: document.getElementById("prediction-list"),
  predictionTravelNote: document.getElementById("prediction-travel-note"),
  restockAmount: document.getElementById("restock-amount"),
  currentStock: document.getElementById("current-stock"),
  currentQty: document.getElementById("current-qty"),
  currentMeta: document.getElementById("current-meta"),
  currentDepletion: document.getElementById("current-depletion"),
  profitEstimate: document.getElementById("profit-estimate"),
  profitBuy: document.getElementById("profit-buy"),
  profitMarket: document.getElementById("profit-market"),
  profitSell: document.getElementById("profit-sell"),
  profitSellReset: document.getElementById("profit-sell-reset"),
  profitPerItem: document.getElementById("profit-per-item"),
  profitTotal: document.getElementById("profit-total"),
  profitPerHour: document.getElementById("profit-per-hour"),
  profitNote: document.getElementById("profit-note"),
  inspectToggle: document.getElementById("inspect-toggle"),
  chartInspectLayer: document.getElementById("chart-inspect-layer"),
  chartSelectionBox: document.getElementById("chart-selection-box"),
  snapshotInspector: document.getElementById("snapshot-inspector"),
  snapshotInspectorHint: document.getElementById("snapshot-inspector-hint"),
  snapshotInspectorEmpty: document.getElementById("snapshot-inspector-empty"),
  snapshotInspectorBody: document.getElementById("snapshot-inspector-body"),
  snapshotClearBtn: document.getElementById("snapshot-clear-btn"),
  snapshotDeleteAllBtn: document.getElementById("snapshot-delete-all-btn"),
  chartOffset: document.getElementById("chart-offset"),
  chartScale: document.getElementById("chart-scale"),
  chartWrap: document.querySelector(".chart-wrap"),
  flightVarianceToggle: document.getElementById("flight-variance-toggle"),
};

const snapshotInspector = {
  enabled: false,
  selected: new Set(),
  drag: null,
};

const chartPan = {
  active: null,
};

const profitSell = {
  marketPrice: null,
  item: null,
};

function setProfitSellEnabled(enabled) {
  if (el.profitSell) el.profitSell.disabled = !enabled;
  if (el.profitSellReset) el.profitSellReset.disabled = !enabled;
}

function parseSellPriceInput() {
  if (!el.profitSell || el.profitSell.disabled) return null;
  const raw = el.profitSell.value.trim();
  if (raw === "") return null;
  const price = Number.parseInt(raw, 10);
  return Number.isInteger(price) && price >= 0 ? price : null;
}

function syncSellPriceInput(marketPrice) {
  if (!el.profitSell || marketPrice == null || !state.item) return;
  const stored = getSellPrice(state.item.country, state.item.itemId);
  el.profitSell.value = String(stored ?? marketPrice);
}

function updateProfitCalcs() {
  const item = profitSell.item;
  if (!item || profitSell.marketPrice == null) return;

  const sellPrice = parseSellPriceInput();
  if (sellPrice == null) return;

  const metrics = computeProfitMetrics({
    buyPrice: item.cost,
    sellPrice,
    country: state.item.country,
  });
  if (!metrics) return;

  setProfitStat(el.profitPerItem, fmtSignedMoney(metrics.profitPerItem), profitValueClass(metrics.profitPerItem));
  setProfitStat(el.profitTotal, fmtSignedMoney(metrics.totalProfit), profitValueClass(metrics.totalProfit));
  setProfitStat(
    el.profitPerHour,
    fmtProfitPerHour(metrics.profitPerHour),
    profitValueClass(metrics.profitPerHour)
  );

  if (el.profitNote) {
    el.profitNote.textContent =
      `${fmtNum(metrics.itemsPerTrip)} item${metrics.itemsPerTrip === 1 ? "" : "s"} per trip · ${state.travelCapacity} slots · ${fmtDuration(metrics.roundTripSec)} round trip (${state.travelType})`;
    el.profitNote.classList.remove("hidden");
  }
}

function initProfitSellControls() {
  el.profitSell?.addEventListener("change", () => {
    if (!state.item) return;
    const price = parseSellPriceInput();
    if (price == null) {
      syncSellPriceInput(profitSell.marketPrice);
      updateProfitCalcs();
      return;
    }
    setSellPrice(state.item.country, state.item.itemId, price);
    el.profitSell.value = String(price);
    updateProfitCalcs();
  });

  el.profitSellReset?.addEventListener("click", () => {
    if (!state.item || profitSell.marketPrice == null) return;
    setSellPrice(state.item.country, state.item.itemId, null);
    syncSellPriceInput(profitSell.marketPrice);
    updateProfitCalcs();
  });
}

initProfitSellControls();

function fmtDuration(seconds) {
  const s = Math.round(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

const currentStockSnapshot = {
  pollTs: null,
  quantity: null,
};

function getOpenRateWindow() {
  const raw = state.rates.find((w) => w.open);
  if (!raw || isRateWindowIgnored(raw.start_ts)) return null;
  return adjustedRateWindow(raw);
}

function getCurrentRestockRate(
  qty = currentStockSnapshot.quantity,
  refTs = currentStockSnapshot.pollTs
) {
  const w = getOpenRateWindow();
  if (!w) return null;

  if (qty == null || refTs == null || qty <= 0) return null;

  const elapsedMin = (refTs - w.start_ts) / 60;
  if (elapsedMin > 0) {
    const depleted = w.start_qty - qty;
    if (depleted > 0) return depleted / elapsedMin;
  }

  return w.rate > 0 ? w.rate : null;
}

function depletionRateForCycle(t, startTs, startQty, avgRate) {
  if (startQty > 0 && t === startTs) {
    return getCurrentRestockRate(startQty, startTs) ?? avgRate;
  }
  return avgRate;
}

function getCurrentDepletionTs() {
  if (currentStockSnapshot.quantity == null || currentStockSnapshot.quantity <= 0) return null;
  const rate = getCurrentRestockRate();
  if (!rate || rate <= 0) return null;
  return currentStockSnapshot.pollTs + (currentStockSnapshot.quantity / rate) * 60;
}

function updateCurrentDepletionCountdown() {
  if (!el.currentDepletion) return;
  if (currentStockSnapshot.quantity === 0) {
    el.currentDepletion.textContent = "Out of stock";
    el.currentDepletion.className = "current-depletion-value qty-zero";
    return;
  }
  if (currentStockSnapshot.quantity == null) {
    el.currentDepletion.textContent = "—";
    el.currentDepletion.className = "current-depletion-value";
    return;
  }
  const depletionTs = getCurrentDepletionTs();
  if (depletionTs == null) {
    el.currentDepletion.textContent = "Unknown";
    el.currentDepletion.className = "current-depletion-value";
    return;
  }
  const remaining = depletionTs - Math.floor(Date.now() / 1000);
  if (remaining <= 0) {
    el.currentDepletion.textContent = "Depleted";
    el.currentDepletion.className = "current-depletion-value qty-zero";
    return;
  }
  el.currentDepletion.textContent = fmtDuration(remaining);
  el.currentDepletion.className = "current-depletion-value qty-ok";
}

function syncCurrentStockDepletion(quantity, pollTs) {
  currentStockSnapshot.quantity = quantity;
  currentStockSnapshot.pollTs = pollTs;
  updateCurrentDepletionCountdown();
}

const fmtRate = (r) => (Math.abs(r) >= 10 ? r.toFixed(0) : r.toFixed(1));
const CYCLE_HISTORY_LIMIT = 10;
const CHART_TOP_PADDING = 48;
const CHART_VIEWPORT_HOURS = 24;
const CHART_MIN_VIEWPORT_SEC = 15 * 60;
const CHART_PAN_DRAG_THRESHOLD_PX = 4;
const CHART_SCALE_INPUT_DECIMALS = 2;
const CHART_TIME_MARKER_LABEL_Y_ADJUST = -34;
const CHART_PREDICTION_LABEL_Y_ADJUST = 8;
const tsMs = (ts) => ts * 1000;

function getTimelineSpanSec(timeline) {
  return (timeline.xMax - timeline.xMin) / 1000;
}

function getBaseChartViewportSpanSec(timeline) {
  return Math.min(getTimelineSpanSec(timeline), CHART_VIEWPORT_HOURS * 3600);
}

function getMinChartScale(timeline) {
  const base = getBaseChartViewportSpanSec(timeline);
  const full = getTimelineSpanSec(timeline);
  if (!full) return 1;
  return base / full;
}

function getMaxChartScale(timeline) {
  const base = getBaseChartViewportSpanSec(timeline);
  return base / CHART_MIN_VIEWPORT_SEC;
}

function clampChartScale(scale, timeline) {
  if (!timeline?.xMax) return 1;
  return Math.max(getMinChartScale(timeline), Math.min(scale, getMaxChartScale(timeline)));
}

function getChartViewportSpanSec(timeline, scale = state.chartScale) {
  const base = getBaseChartViewportSpanSec(timeline);
  const full = getTimelineSpanSec(timeline);
  const span = base / scale;
  return Math.max(CHART_MIN_VIEWPORT_SEC, Math.min(full, span));
}

function getMaxChartOffsetSec(timeline, scale = state.chartScale) {
  return Math.max(0, getTimelineSpanSec(timeline) - getChartViewportSpanSec(timeline, scale));
}

function clampChartOffsetSec(offsetSec, timeline, scale = state.chartScale) {
  if (!timeline?.xMax) return 0;
  return Math.max(0, Math.min(offsetSec, getMaxChartOffsetSec(timeline, scale)));
}

function getVisibleChartRange(
  timeline,
  offsetSec = state.chartOffsetSec,
  scale = state.chartScale
) {
  const clampedScale = clampChartScale(scale, timeline);
  const clamped = clampChartOffsetSec(offsetSec, timeline, clampedScale);
  const visMin = timeline.xMin + clamped * 1000;
  const visMax = visMin + getChartViewportSpanSec(timeline, clampedScale) * 1000;
  return { visMin, visMax, offsetSec: clamped, scale: clampedScale };
}

function canAdjustChartView(timeline) {
  if (!timeline?.xMax) return false;
  const canPan = getMaxChartOffsetSec(timeline) > 0;
  const canScale = getMaxChartScale(timeline) > getMinChartScale(timeline) * 1.001;
  return canPan || canScale;
}

function pixelDeltaToOffsetSec(deltaPx, spanSec, chart) {
  if (!chart?.chartArea) return 0;
  const { left, right } = chart.chartArea;
  const width = right - left;
  if (!width || !spanSec) return 0;
  return -(deltaPx / width) * spanSec;
}

function scaleFromVerticalDrag(startScale, deltaPy, timeline, chart) {
  const startSpan = getChartViewportSpanSec(timeline, startScale);
  const full = getTimelineSpanSec(timeline);
  const { top, bottom } = chart.chartArea;
  const height = bottom - top;
  if (!height) return startScale;
  const deltaSpan = (deltaPy / height) * startSpan;
  const newSpan = Math.max(CHART_MIN_VIEWPORT_SEC, Math.min(full, startSpan + deltaSpan));
  const base = getBaseChartViewportSpanSec(timeline);
  return clampChartScale(base / newSpan, timeline);
}

function chartAreaFraction(pixel, chart) {
  const { left, right } = chart.chartArea;
  const width = right - left;
  if (!width) return 0.5;
  return (pixel - left) / width;
}

function offsetSecForZoomPivot(timeline, scale, anchorTimeMs, anchorFraction) {
  const spanSec = getChartViewportSpanSec(timeline, scale);
  const visMin = anchorTimeMs - anchorFraction * spanSec * 1000;
  return (visMin - timeline.xMin) / 1000;
}

function offsetSecForScaleAtViewCenter(timeline, scale) {
  const { visMin, visMax } = getVisibleChartRange(timeline);
  const anchorTimeMs = (visMin + visMax) / 2;
  return offsetSecForZoomPivot(timeline, scale, anchorTimeMs, 0.5);
}

function dragChartView(timeline, pan, deltaX, deltaY, currentX, chart) {
  const startSpanSec = getChartViewportSpanSec(timeline, pan.startScale);
  const nextScale = scaleFromVerticalDrag(pan.startScale, deltaY, timeline, chart);

  const pannedOffset = pan.startOffsetSec + pixelDeltaToOffsetSec(deltaX, startSpanSec, chart);
  const cursorFraction = chartAreaFraction(currentX, chart);
  const pannedVisMin =
    timeline.xMin + clampChartOffsetSec(pannedOffset, timeline, pan.startScale) * 1000;
  const cursorTimeMs = pannedVisMin + cursorFraction * startSpanSec * 1000;

  const nextOffset = offsetSecForZoomPivot(timeline, nextScale, cursorTimeMs, cursorFraction);
  return { offsetSec: nextOffset, scale: nextScale };
}

function chartTimeUnitForSpan(spanMs) {
  const spanHours = spanMs / 3_600_000;
  return spanHours <= 6 ? "minute" : spanHours <= 48 ? "hour" : "day";
}

function syncOffsetInput(timeline = state.lastTimeline) {
  if (!el.chartOffset) return;
  const maxOffset = timeline ? getMaxChartOffsetSec(timeline) : 0;
  el.chartOffset.value = String(Math.round(state.chartOffsetSec));
  el.chartOffset.disabled = maxOffset <= 0;
  el.chartOffset.max = String(Math.round(maxOffset));
}

function syncScaleInput(timeline = state.lastTimeline) {
  if (!el.chartScale) return;
  const minScale = timeline ? getMinChartScale(timeline) : 1;
  const maxScale = timeline ? getMaxChartScale(timeline) : 1;
  el.chartScale.value = state.chartScale.toFixed(CHART_SCALE_INPUT_DECIMALS);
  el.chartScale.disabled = maxScale <= minScale * 1.001;
  el.chartScale.min = minScale.toFixed(CHART_SCALE_INPUT_DECIMALS);
  el.chartScale.max = maxScale.toFixed(CHART_SCALE_INPUT_DECIMALS);
}

function syncChartViewInteraction(timeline = state.lastTimeline) {
  if (!el.chartWrap) return;
  const adjustable = timeline && canAdjustChartView(timeline) && !snapshotInspector.enabled;
  el.chartWrap.classList.toggle("can-pan", adjustable);
  if (!adjustable) endChartPan();
}

function endChartPan() {
  chartPan.active = null;
  el.chartWrap?.classList.remove("is-panning");
}

function endSnapshotDrag() {
  if (!snapshotInspector.drag) return;
  snapshotInspector.drag = null;
  el.chartSelectionBox?.classList.add("hidden");
}

function isMouseButtonReleased(e) {
  return e.buttons === 0;
}

function endActiveChartDrags() {
  endChartPan();
  endSnapshotDrag();
}

function applyChartView(
  timeline,
  { offsetSec = state.chartOffsetSec, scale = state.chartScale } = {}
) {
  const { visMin, visMax, offsetSec: clampedOffset, scale: clampedScale } = getVisibleChartRange(
    timeline,
    offsetSec,
    scale
  );
  state.chartOffsetSec = clampedOffset;
  state.chartScale = clampedScale;
  syncOffsetInput(timeline);
  syncScaleInput(timeline);
  syncChartViewInteraction(timeline);

  if (!state.chart) return { visMin, visMax };

  const spanMs = visMax - visMin;
  const timeUnit = chartTimeUnitForSpan(spanMs);
  state.chart.options.scales.x.min = visMin;
  state.chart.options.scales.x.max = visMax;
  state.chart.options.scales.x.time.unit = timeUnit;
  state.chart.options.scales.x.time.stepSize = timeUnit === "minute" ? 1 : undefined;
  state.chart.options.plugins.annotation.annotations = buildAnnotations(
    state.restocks,
    state.rates,
    { ...timeline, xMin: visMin, xMax: visMax }
  );
  state.chart.update("none");
  updateChartMarkers(state.chart);
  return { visMin, visMax };
}

function initSampleExtremaButtons(container, defaultN, timingKey, onSelect) {
  const timing = state[timingKey];
  const sampleHtml = SAMPLE_OPTIONS.map(
    (n) =>
      `<button data-n="${n}" class="${timing === "avg" && n === defaultN ? "active" : ""}">${n}</button>`
  ).join("");
  const extremaHtml = `<button data-mode="min" class="${timing === "min" ? "active" : ""}">MIN</button><button data-mode="max" class="${timing === "max" ? "active" : ""}">MAX</button>`;
  container.innerHTML = sampleHtml + extremaHtml;
  container.addEventListener("click", (e) => {
    const sampleBtn = e.target.closest("button[data-n]");
    if (sampleBtn) {
      container.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === sampleBtn));
      onSelect({ mode: "avg", n: Number(sampleBtn.dataset.n) });
      return;
    }
    const modeBtn = e.target.closest("button[data-mode]");
    if (!modeBtn) return;
    container.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === modeBtn));
    onSelect({ mode: modeBtn.dataset.mode });
  });
}

function currentRestockAmount() {
  const item = state.item;
  if (!item) return null;
  return getRestockAmount(item.country, item.itemId);
}

function lastZeroBeforeRestock(restockedTs, depletedTs) {
  let lastZero = null;
  for (const p of state.chartPoints) {
    if (p.yata_ts < restockedTs && p.quantity === 0) lastZero = p.yata_ts;
  }
  return lastZero ?? depletedTs ?? null;
}

/** Shift restock time earlier when the first snapshot is below the known full restock size. */
function adjustRestockTime(restockedTs, observedQty, ratePerMin, restockAmount, depletedTs) {
  if (!restockAmount || !ratePerMin || ratePerMin <= 0 || !observedQty) return restockedTs;
  if (observedQty >= restockAmount) return restockedTs;
  const adjustSec = ((restockAmount - observedQty) / ratePerMin) * 60;
  let adjusted = Math.round(restockedTs - adjustSec);
  const lastZero = lastZeroBeforeRestock(restockedTs, depletedTs);
  if (lastZero != null) adjusted = Math.max(adjusted, lastZero + 1);
  return adjusted;
}

function rateWindowForRestock(restockedTs) {
  return state.rates.find((w) => w.start_ts === restockedTs);
}

function adjustedRestockRecord(r) {
  const amount = currentRestockAmount();
  if (!amount || r.restocked_ts == null) {
    return { ...r, adjusted_restocked_ts: r.restocked_ts, adjusted_duration: r.duration };
  }
  const window = rateWindowForRestock(r.restocked_ts);
  if (!window) {
    return { ...r, adjusted_restocked_ts: r.restocked_ts, adjusted_duration: r.duration };
  }
  const adjustedTs = adjustRestockTime(
    r.restocked_ts,
    window.start_qty,
    window.rate,
    amount,
    r.depleted_ts
  );
  return {
    ...r,
    adjusted_restocked_ts: adjustedTs,
    adjusted_duration: adjustedTs - r.depleted_ts,
  };
}

function adjustedRateWindow(w) {
  const amount = currentRestockAmount();
  if (!amount || w.start_qty >= amount) return w;
  const restock = state.restocks.find((r) => r.restocked_ts === w.start_ts);
  const startTs = adjustRestockTime(
    w.start_ts,
    w.start_qty,
    w.rate,
    amount,
    restock?.depleted_ts
  );
  return { ...w, start_ts: startTs, start_qty: amount };
}

function getAdjustedCompletedRestocks() {
  return state.restocks.filter((r) => r.duration != null).map(adjustedRestockRecord);
}

function getUsableCompletedRestocks() {
  return getAdjustedCompletedRestocks().filter((r) => !r.ignored);
}

function isRateWindowIgnored(startTs) {
  const restock = state.restocks.find((r) => r.restocked_ts === startTs);
  return Boolean(restock?.ignored);
}

function getUsableRates() {
  return getAdjustedRates().filter((w) => !isRateWindowIgnored(w.start_ts));
}

function getAdjustedRates() {
  return state.rates.map(adjustedRateWindow);
}

function getHistoricalExtents() {
  const restocks = getUsableCompletedRestocks();
  const durations = restocks
    .map((r) => r.adjusted_duration)
    .filter((d) => d != null && d > 0);
  const rates = getUsableRates()
    .map((w) => w.rate)
    .filter((r) => r != null && r > 0);
  return {
    minEmptyFor: durations.length ? Math.min(...durations) : null,
    maxEmptyFor: durations.length ? Math.max(...durations) : null,
    minRate: rates.length ? Math.min(...rates) : null,
    maxRate: rates.length ? Math.max(...rates) : null,
  };
}

function maxEmptyForSec() {
  return getHistoricalExtents().maxEmptyFor;
}

/** Restock events chained with max historical empty-for — independent of avg/min/max timing. */
function getSafeWindowAnchorRestocks(startTs, endTs, startQty) {
  const maxEmptyFor = maxEmptyForSec();
  const rate = rateFromHistory();
  if (maxEmptyFor == null || rate == null || startQty == null) return [];

  const configuredQty = currentRestockAmount();
  const qtySample = getUsableRates().slice(0, state.avgRateSamples);
  const qtySource = qtySample.length ? qtySample : getUsableRates();
  if (!configuredQty && !qtySource.length) return [];
  const restockQty =
    configuredQty ??
    Math.round(qtySource.reduce((sum, w) => sum + w.start_qty, 0) / qtySource.length);

  const { events } = simulatePredictions(startTs, endTs, startQty, {
    restockSec: maxEmptyFor,
    rate,
    restockQty,
  });
  return events.filter((e) => e.type === "restock" && e.ts >= startTs);
}

function stockoutSecFromHistory() {
  const restocks = getUsableCompletedRestocks();
  if (!restocks.length) return null;
  if (state.stockoutTiming === "min") {
    const durations = restocks.map((r) => r.adjusted_duration).filter((d) => d != null && d > 0);
    return durations.length ? Math.min(...durations) : null;
  }
  if (state.stockoutTiming === "max") {
    const durations = restocks.map((r) => r.adjusted_duration).filter((d) => d != null && d > 0);
    return durations.length ? Math.max(...durations) : null;
  }
  const sample = restocks.slice(0, state.avgSamples);
  if (!sample.length) return null;
  return sample.reduce((sum, r) => sum + r.adjusted_duration, 0) / sample.length;
}

function rateFromHistory() {
  const windows = getUsableRates();
  const rates = windows.map((w) => w.rate).filter((r) => r != null && r > 0);
  if (!rates.length) return null;
  if (state.rateTiming === "min") return Math.min(...rates);
  if (state.rateTiming === "max") return Math.max(...rates);
  const sample = windows.slice(0, state.avgRateSamples);
  if (!sample.length) return null;
  return sample.reduce((sum, w) => sum + w.rate, 0) / sample.length;
}

function getAverages() {
  const restockSec = stockoutSecFromHistory();
  const rate = rateFromHistory();
  if (restockSec == null || rate == null) return null;
  const configuredQty = currentRestockAmount();
  const qtySample = getUsableRates().slice(0, state.avgRateSamples);
  const qtySource = qtySample.length ? qtySample : getUsableRates();
  return {
    restockSec,
    rate,
    restockQty: configuredQty ?? Math.round(
      qtySource.reduce((sum, w) => sum + w.start_qty, 0) / qtySource.length
    ),
  };
}

function simulatePredictions(startTs, endTs, startQty, averages) {
  const { restockSec, rate: avgRate, restockQty } = averages;
  const events = [];
  const segments = [];
  const open =
    startQty === 0 ? state.restocks.find((r) => r.restocked_ts == null) : null;

  let t = startTs;
  let qty = startQty;
  let outOfStock = startQty === 0;
  let depletedTs = open?.depleted_ts ?? null;

  while (t < endTs) {
    if (outOfStock) {
      const restockTs = Math.round(
        depletedTs ? Math.max(t, depletedTs + restockSec) : t + restockSec
      );
      if (restockTs > endTs) break;
      events.push({ type: "restock", ts: restockTs, qty: restockQty, depleted_ts: depletedTs });
      t = restockTs;
      qty = restockQty;
      outOfStock = false;
      depletedTs = null;
      continue;
    }

    const rate = depletionRateForCycle(t, startTs, startQty, avgRate);
    const depleteSec = (qty / rate) * 60;
    const depleteTs = Math.round(t + depleteSec);
    if (depleteTs >= endTs) {
      segments.push({
        start_ts: t,
        end_ts: endTs,
        start_qty: qty,
        end_qty: qty - rate * ((endTs - t) / 60),
        rate,
      });
      break;
    }

    segments.push({ start_ts: t, end_ts: depleteTs, start_qty: qty, end_qty: 0, rate });
    events.push({ type: "deplete", ts: depleteTs });

    const restockTs = Math.round(depleteTs + restockSec);
    if (restockTs > endTs) {
      events.push({ type: "out_of_stock", start: depleteTs, end: endTs, duration: endTs - depleteTs });
      break;
    }

    events.push({ type: "out_of_stock", start: depleteTs, end: restockTs, duration: restockSec });
    events.push({ type: "restock", ts: restockTs, qty: restockQty, depleted_ts: depleteTs });
    t = restockTs;
    qty = restockQty;
  }

  return { events, segments };
}

function qtyAtPredicted(ts, startTs, startQty, segments, events) {
  for (const ev of events) {
    if (ev.type === "out_of_stock" && ts >= ev.start && ts < ev.end) return 0;
  }
  for (const seg of segments) {
    if (ts >= seg.start_ts && ts <= seg.end_ts) {
      const span = seg.end_ts - seg.start_ts;
      if (span === 0) return seg.end_qty;
      const slope = (seg.end_qty - seg.start_qty) / span;
      return Math.max(0, Math.round(seg.start_qty + slope * (ts - seg.start_ts)));
    }
  }
  if (ts <= startTs) return startQty;
  return 0;
}

// One point per minute from the latest snapshot through endTs, plus exact event timestamps.
function buildPredictedMinuteSeries(startTs, endTs, startQty, segments, events, cost) {
  const tsSet = new Set([startTs, endTs]);
  for (let ts = Math.ceil(startTs / 60) * 60; ts <= endTs; ts += 60) tsSet.add(ts);
  for (const ev of events) {
    if (ev.ts != null) tsSet.add(ev.ts);
    if (ev.start != null) tsSet.add(ev.start);
    if (ev.end != null) {
      tsSet.add(ev.end);
      tsSet.add(ev.end - 1);
    }
  }

  const points = [...tsSet]
    .filter((ts) => ts >= startTs && ts <= endTs)
    .sort((a, b) => a - b)
    .map((ts) => ({
      x: tsMs(ts),
      y: qtyAtPredicted(ts, startTs, startQty, segments, events),
      cost,
      predicted: true,
    }));

  const restockTimes = new Set(
    events.filter((e) => e.type === "restock" && e.ts >= startTs).map((e) => e.ts)
  );

  const data = [];
  for (const pt of points) {
    const ts = Math.round(pt.x / 1000);
    if (restockTimes.has(ts)) {
      data.push({ x: pt.x, y: null, predicted: true });
    }
    data.push(pt);
  }
  return data;
}

function buildTimeline(historicalPoints, predictionHours) {
  const wallTs = Math.floor(Date.now() / 1000);
  if (!historicalPoints.length) {
    return {
      actualData: [],
      predictedData: [],
      dataTs: 0,
      wallTs,
      xMin: 0,
      xMax: 0,
      segments: [],
      events: [],
    };
  }

  const firstTs = historicalPoints[0].yata_ts;
  const lastHist = historicalPoints[historicalPoints.length - 1];
  const dataTs = lastHist.yata_ts;

  const actualData = historicalPoints.map((p) => ({
    x: tsMs(p.yata_ts),
    y: p.quantity,
    cost: p.cost,
    yata_ts: p.yata_ts,
    predicted: false,
  }));

  let endTs = dataTs;
  let predictedData = [];
  let segments = [];
  let events = [];

  if (predictionHours > 0) {
    const averages = getAverages();
    if (averages) {
      endTs = dataTs + predictionHours * 3600;
      ({ events, segments } = simulatePredictions(dataTs, endTs, lastHist.quantity, averages));
      predictedData = buildPredictedMinuteSeries(
        dataTs,
        endTs,
        lastHist.quantity,
        segments,
        events,
        lastHist.cost
      );
    }
  }

  const arriveTs = getArriveTs(wallTs, state.item?.country);
  if (arriveTs != null) {
    endTs = Math.max(endTs, arriveTs);
  }
  endTs = Math.max(endTs, wallTs);

  return {
    actualData,
    predictedData,
    dataTs,
    wallTs,
    xMin: tsMs(firstTs),
    xMax: tsMs(endTs),
    segments,
    events,
  };
}

function buildAnnotations(restocks, rates, timeline) {
  const annotations = {};
  const { dataTs, wallTs, segments = [], events = [], xMin, xMax } = timeline;
  if (!xMax) return annotations;

  restocks.filter((r) => !r.ignored).forEach((r, i) => {
    const adjusted = adjustedRestockRecord(r);
    const boxEnd = adjusted.adjusted_restocked_ts ?? dataTs;
    if (tsMs(boxEnd) < xMin || tsMs(r.depleted_ts) > xMax) return;
    annotations[`restock${i}`] = {
      type: "box",
      xMin: tsMs(r.depleted_ts),
      xMax: tsMs(boxEnd),
      backgroundColor: "rgba(242, 106, 106, 0.12)",
      borderColor: "rgba(242, 106, 106, 0.45)",
      borderWidth: 1,
      label: {
        display: true,
        content:
          adjusted.adjusted_duration != null
            ? fmtDuration(adjusted.adjusted_duration)
            : "out of stock",
        position: { x: "center", y: "start" },
        color: "#f26a6a",
        font: { size: 11, weight: "600" },
      },
    };
  });

  getUsableRates().forEach((w, i) => {
    if (tsMs(w.end_ts) < xMin || w.start_ts > dataTs) return;
    if (state.predictionHours > 0 && state.rates.find((r) => r.start_ts === w.start_ts)?.open) return;
    const slope = (w.end_qty - w.start_qty) / (w.end_ts - w.start_ts);
    const startTs = Math.max(w.start_ts, xMin / 1000);
    const endTs = Math.min(w.end_ts, dataTs, xMax / 1000);
    if (startTs >= endTs) return;
    annotations[`rate${i}`] = {
      type: "line",
      xMin: tsMs(startTs),
      xMax: tsMs(endTs),
      yMin: Math.max(0, w.start_qty + slope * (startTs - w.start_ts)),
      yMax: Math.max(0, w.start_qty + slope * (endTs - w.start_ts)),
      borderColor: "rgba(62, 207, 142, 0.8)",
      borderWidth: 2,
      borderDash: [6, 4],
      label: {
        display: true,
        content: `${fmtRate(w.rate)}/min`,
        position: "center",
        backgroundColor: "rgba(23, 28, 38, 0.85)",
        color: "#3ecf8e",
        font: { size: 10, weight: "600" },
      },
    };
  });

  annotations.now = {
    type: "line",
    xMin: tsMs(wallTs),
    xMax: tsMs(wallTs),
    borderColor: "#ffea00",
    borderWidth: 2,
    borderDash: [4, 4],
  };

  const arriveTs = getArriveTs(wallTs, state.item?.country);
  if (arriveTs != null) {
    annotations.arrive = {
      type: "line",
      xMin: tsMs(arriveTs),
      xMax: tsMs(arriveTs),
      borderColor: "#ff9800",
      borderWidth: 2,
      borderDash: [4, 4],
    };
  }

  if (state.predictionHours > 0) {
    events.forEach((ev, i) => {
      if (ev.type !== "out_of_stock") return;
      annotations[`predOos${i}`] = {
        type: "box",
        xMin: tsMs(ev.start),
        xMax: tsMs(ev.end),
        backgroundColor: "rgba(242, 106, 106, 0.08)",
        borderColor: "rgba(242, 106, 106, 0.35)",
        borderWidth: 1,
        borderDash: [4, 4],
        label: {
          display: true,
          content: fmtDuration(ev.duration),
          position: { x: "center", y: "start" },
          color: "#f26a6a",
          font: { size: 10, weight: "600" },
        },
      };
    });

    segments.forEach((w, i) => {
      if (w.end_ts <= dataTs) return;
      const slope = (w.end_qty - w.start_qty) / (w.end_ts - w.start_ts);
      const startTs = Math.max(w.start_ts, dataTs);
      const endTs = Math.min(w.end_ts, xMax / 1000);
      if (startTs >= endTs) return;
      const midTs = (startTs + endTs) / 2;
      const midQty = Math.max(0, w.start_qty + slope * (midTs - w.start_ts));
      // Label only — the Predicted dataset already draws these slopes; lines would duplicate it.
      annotations[`predRate${i}`] = {
        type: "label",
        xValue: tsMs(midTs),
        yValue: midQty,
        backgroundColor: "rgba(23, 28, 38, 0.85)",
        color: "#a78bfa",
        font: { size: 10, weight: "600" },
        content: `${fmtRate(w.rate)}/min`,
      };
    });

  }

  return annotations;
}

function getCycleHistoryRows() {
  const completed = getAdjustedCompletedRestocks();
  const adjustedRates = getAdjustedRates();
  return completed.slice(0, CYCLE_HISTORY_LIMIT).map((r) => {
    const origIdx = state.rates.findIndex((w) => w.start_ts === r.restocked_ts);
    const rate = origIdx >= 0 ? adjustedRates[origIdx]?.rate : null;
    return {
      depleted_ts: r.depleted_ts,
      restocked_ts: r.adjusted_restocked_ts,
      rate,
      emptyForSec: r.adjusted_duration,
      ignored: Boolean(r.ignored),
    };
  });
}

function getUsableCycleHistoryRows() {
  return getCycleHistoryRows().filter((r) => !r.ignored);
}

function renderCycleHistory() {
  updateCurrentDepletionCountdown();

  const open = state.restocks.find((r) => r.restocked_ts == null);
  el.cycleOpenNote.classList.toggle("hidden", !open);
  if (open) {
    el.cycleOpenNote.textContent = `Currently empty since ${fmtTime(open.depleted_ts)} — not restocked yet`;
  }

  const rows = getCycleHistoryRows();
  const usableRows = getUsableCycleHistoryRows();

  const stockoutSample = usableRows.slice(0, state.avgSamples);
  if (state.stockoutTiming === "min" || state.stockoutTiming === "max") {
    const { minEmptyFor, maxEmptyFor } = getHistoricalExtents();
    const value = state.stockoutTiming === "min" ? minEmptyFor : maxEmptyFor;
    if (value != null && usableRows.length) {
      el.restockAvg.textContent = `${fmtDuration(value)} (${state.stockoutTiming.toUpperCase()} of ${usableRows.length})`;
    } else {
      el.restockAvg.textContent = "no samples yet";
    }
  } else if (stockoutSample.length) {
    const avg =
      stockoutSample.reduce((sum, r) => sum + r.emptyForSec, 0) / stockoutSample.length;
    el.restockAvg.textContent = `${fmtDuration(avg)} (${stockoutSample.length} sample${stockoutSample.length === 1 ? "" : "s"})`;
  } else {
    el.restockAvg.textContent = "no samples yet";
  }

  const rateSample = usableRows.filter((r) => r.rate != null).slice(0, state.avgRateSamples);
  if (state.rateTiming === "min" || state.rateTiming === "max") {
    const { minRate, maxRate } = getHistoricalExtents();
    const value = state.rateTiming === "min" ? minRate : maxRate;
    const allRateRows = usableRows.filter((r) => r.rate != null);
    if (value != null && allRateRows.length) {
      el.rateAvg.textContent = `${fmtRate(value)}/min (${state.rateTiming.toUpperCase()} of ${allRateRows.length})`;
    } else {
      el.rateAvg.textContent = "no samples yet";
    }
  } else if (rateSample.length) {
    const avg = rateSample.reduce((sum, r) => sum + r.rate, 0) / rateSample.length;
    el.rateAvg.textContent = `${fmtRate(avg)}/min (${rateSample.length} sample${rateSample.length === 1 ? "" : "s"})`;
  } else {
    el.rateAvg.textContent = "no samples yet";
  }

  if (!rows.length) {
    el.cycleHistoryBody.innerHTML =
      `<tr><td colspan="5" class="empty-note">No depletion/restock cycles observed yet.</td></tr>`;
    return;
  }

  el.cycleHistoryBody.innerHTML = rows
    .map(
      (r) => `<tr class="${r.ignored ? "cycle-ignored" : ""}" data-depleted-ts="${r.depleted_ts}">
        <td class="cycle-count-cell">
          <input
            type="checkbox"
            class="cycle-count"
            data-depleted-ts="${r.depleted_ts}"
            ${r.ignored ? "" : "checked"}
            title="${r.ignored ? "Excluded from averages — click to include" : "Included in averages — click to exclude"}"
          />
        </td>
        <td>${fmtTime(r.restocked_ts)}</td>
        <td>${fmtTime(r.depleted_ts)}</td>
        <td class="rate-cell">${r.rate != null ? `${fmtRate(r.rate)}/min` : "—"}</td>
        <td class="duration-cell">${fmtDuration(r.emptyForSec)}</td>
      </tr>`
    )
    .join("");
}

function depletionAfterRestock(restockTs, events, segments) {
  const deplete = events.find((ev) => ev.type === "deplete" && ev.ts > restockTs);
  if (deplete) return deplete.ts;
  const seg = segments.find((s) => s.start_ts >= restockTs && s.end_qty === 0);
  return seg?.end_ts ?? null;
}

function predictedRestockBounds(e, averages, events, segments, { dataTs, startQty } = {}) {
  let restockEarliest = e.ts;
  const amount = currentRestockAmount();
  const isFirstFromCurrentCycle =
    startQty > 0 &&
    dataTs != null &&
    e.ts >= dataTs &&
    e === events.find((ev) => ev.type === "restock" && ev.ts >= dataTs);
  const rate =
    isFirstFromCurrentCycle && dataTs != null
      ? getCurrentRestockRate(startQty, dataTs) ?? averages?.rate
      : averages?.rate;
  if (amount && rate) {
    restockEarliest = adjustRestockTime(
      e.ts,
      e.qty,
      rate,
      amount,
      e.depleted_ts
    );
  }
  const depleteTs = depletionAfterRestock(e.ts, events, segments);
  const restockLatest = depleteTs ?? restockEarliest;
  return { restockEarliest, restockLatest };
}

function safeWindowBoundsForDepletedTs(depletedTs, qty) {
  const { maxEmptyFor, maxRate } = getHistoricalExtents();
  if (maxEmptyFor == null || maxRate == null || depletedTs == null) return null;

  const restockQty = currentRestockAmount() ?? qty;
  const safeStart = Math.round(depletedTs + maxEmptyFor);
  const safeEnd = Math.round(depletedTs + maxEmptyFor + (restockQty / maxRate) * 60);

  if (safeStart >= safeEnd) return null;
  return { safeStart, safeEnd };
}

function safeWindowBoundsForEvent(event, index) {
  const anchor = state.safeWindowAnchors?.[index];
  const depletedTs = anchor?.depleted_ts ?? event.depleted_ts;
  return safeWindowBoundsForDepletedTs(depletedTs, event.qty);
}

function formatSafeWindowLabel(bounds, i) {
  if (!bounds) return "";
  return `<span class="safe-window-label">#${i + 1} safe: ${fmtTimeShort(bounds.safeStart)} → ${fmtTimeShort(bounds.safeEnd)}</span>`;
}

function predictionStartQty() {
  const last = state.chartPoints[state.chartPoints.length - 1];
  return last?.quantity ?? null;
}

function formatRestockLabel(e, i, averages, events, segments, predictionCtx) {
  const { restockEarliest, restockLatest } = predictedRestockBounds(
    e,
    averages,
    events,
    segments,
    predictionCtx
  );
  return `#${i + 1}: Window between ${fmtTimeShort(restockEarliest)} → ${fmtTimeShort(restockLatest)}`;
}

function formatLeaveWindow(restockEarliest, restockLatest, flightSec, wallTs) {
  if (flightSec == null || restockEarliest == null || restockLatest == null) return "";
  const leaveEarliest = restockEarliest - flightSec;
  const leaveLatest = restockLatest - flightSec;

  if (leaveLatest <= wallTs) {
    const missedSec = wallTs - leaveLatest;
    return `<span class="leave-missed">Missed window by ${fmtDuration(missedSec)}</span>`;
  }

  return `<span class="leave-by">Leave between ${fmtTimeShort(leaveEarliest)} and ${fmtTimeShort(leaveLatest)}</span>`;
}

function formatSafeLeaveWindow(bounds, flightSec, wallTs) {
  if (!bounds || flightSec == null) return "";

  const leaveEarliest = state.flightTimeVariance
    ? bounds.safeStart - flightSecWithVariance(flightSec, "fast")
    : bounds.safeStart - flightSec;
  const leaveLatest = state.flightTimeVariance
    ? bounds.safeEnd - flightSecWithVariance(flightSec, "slow")
    : bounds.safeEnd - flightSec;

  if (leaveLatest <= wallTs) {
    const missedSec = wallTs - leaveLatest;
    return `<span class="safe-leave-missed">Missed window by ${fmtDuration(missedSec)}</span>`;
  }

  return `<span class="safe-leave-by">Leave between ${fmtTimeShort(leaveEarliest)} and ${fmtTimeShort(leaveLatest)}</span>`;
}

function renderPredictionPanel(events, segments) {
  const show = state.predictionHours > 0;
  document.getElementById("prediction-section").classList.toggle("hidden", !show);
  if (!show) return;

  const country = state.item?.country;
  const flightSec = country ? getFlightSec(country) : null;
  el.predictionTravelNote.textContent = flightSec
    ? `Leave times assume ${state.travelType} travel (${fmtDuration(flightSec)} one-way${
        state.flightTimeVariance
          ? "; safe leave windows use fastest flight for earliest leave and slowest for latest"
          : ""
      })`
    : "";

  const wallTs = Math.floor(Date.now() / 1000);
  const dataTs = state.lastTimeline?.dataTs ?? wallTs;
  const averages = getAverages();
  const predictionCtx = { dataTs, startQty: predictionStartQty() };
  const restocks = events.filter((e) => e.type === "restock" && e.ts >= dataTs);
  if (!restocks.length) {
    el.predictionList.innerHTML = `<li class="ongoing">Not enough data to predict restocks.</li>`;
    return;
  }

  el.predictionList.innerHTML = restocks
    .map((e, i) => {
      const { restockEarliest, restockLatest } = predictedRestockBounds(
        e,
        averages,
        events,
        segments,
        predictionCtx
      );
      const leaveHtml = formatLeaveWindow(restockEarliest, restockLatest, flightSec, wallTs);
      const safe = safeWindowBoundsForEvent(e, i);
      const safeHtml = safe
        ? `<div class="safe-window-info">${formatSafeWindowLabel(safe, i)}${formatSafeLeaveWindow(safe, flightSec, wallTs)}</div>`
        : "";
      return `<li class="prediction-item">
        <div class="prediction-main">
          <span>${formatRestockLabel(e, i, averages, events, segments, predictionCtx)}</span>
          ${leaveHtml}
        </div>
        ${safeHtml}
      </li>`;
    })
    .join("");
}

function setProfitStat(node, text, valueClass = null) {
  if (!node) return;
  node.textContent = text;
  node.classList.remove("positive", "negative", "neutral");
  if (valueClass) node.classList.add(valueClass);
}

async function fetchMarketPrice(itemId) {
  const apiKey = typeof getStoredApiKey === "function" ? getStoredApiKey() : null;
  const body = { itemId };
  if (apiKey) body.apiKey = apiKey;
  try {
    const data = await fetchJsonWithBody("/api/market", { method: "POST", body });
    return data.marketPrice ?? { error: "Average market price unavailable" };
  } catch (err) {
    if (err.message === "API key required for market prices") return "no-key";
    return { error: err.message };
  }
}

function renderProfitEstimate(item, marketPrice) {
  if (!el.profitEstimate) return;

  const resetValues = () => {
    for (const node of [el.profitBuy, el.profitMarket, el.profitPerItem, el.profitTotal, el.profitPerHour]) {
      setProfitStat(node, "—");
    }
  };

  const showNote = (text) => {
    if (!el.profitNote) return;
    el.profitNote.textContent = text;
    el.profitNote.classList.toggle("hidden", !text);
  };

  el.profitEstimate.classList.remove("hidden");
  resetValues();
  showNote("");
  setProfitSellEnabled(false);
  if (el.profitSell) el.profitSell.value = "";

  if (marketPrice === "no-key") {
    showNote("Log in for market prices (Torn API key with market access).");
    return;
  }

  if (typeof marketPrice === "object" && marketPrice?.error) {
    showNote(marketPrice.error);
    return;
  }

  if (marketPrice == null) {
    showNote("Market price unavailable.");
    return;
  }

  profitSell.item = item;
  profitSell.marketPrice = marketPrice;

  setProfitStat(el.profitBuy, fmtMoney(item.cost));
  setProfitStat(el.profitMarket, fmtMoney(marketPrice));
  setProfitSellEnabled(true);
  syncSellPriceInput(marketPrice);
  updateProfitCalcs();
}

function isFlyingToItem() {
  return state.activeTravel?.flyingToCountry === true;
}

function getArriveTs(nowTs, country) {
  if (!country) return null;
  if (state.activeTravel?.flyingToCountry && state.activeTravel.arriveTs != null) {
    return state.activeTravel.arriveTs;
  }
  const flightSec = getFlightSec(country);
  return flightSec != null ? nowTs + flightSec : null;
}

async function refreshTravelStatus() {
  if (!state.item) return;
  const apiKey = typeof getStoredApiKey === "function" ? getStoredApiKey() : null;
  if (!apiKey) {
    state.activeTravel = null;
    if (state.chartPoints.length) redrawPrediction();
    return;
  }
  try {
    const res = await fetch("/api/travel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, country: state.item.country }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    state.activeTravel = body;
  } catch {
    state.activeTravel = null;
  }
  if (state.chartPoints.length) redrawPrediction();
}

function chartMarkerTop(chart, chartArea, yAdjust) {
  return chart.canvas.offsetTop + chartArea.top + yAdjust;
}

function isSnapshotSelected(yataTs) {
  return yataTs != null && snapshotInspector.selected.has(yataTs);
}

function snapshotPointRadius(ctx, defaultRadius) {
  const raw = ctx.raw;
  if (snapshotInspector.enabled && raw?.yata_ts != null) {
    if (isSnapshotSelected(raw.yata_ts)) return 7;
    return defaultRadius > 0 ? Math.max(defaultRadius, 4) : 4;
  }
  return defaultRadius;
}

function chartDatasets(timeline) {
  const defaultRadius = timeline.actualData.length > 200 ? 0 : 2;
  const ds = [
    {
      label: "Stock quantity",
      data: timeline.actualData,
      borderColor: "#4f9cf9",
      backgroundColor: "rgba(79, 156, 249, 0.15)",
      fill: true,
      pointRadius: (ctx) => snapshotPointRadius(ctx, defaultRadius),
      pointBackgroundColor: (ctx) =>
        isSnapshotSelected(ctx.raw?.yata_ts) ? "#ff6b6b" : "#4f9cf9",
      pointBorderColor: (ctx) =>
        isSnapshotSelected(ctx.raw?.yata_ts) ? "#ff6b6b" : "#4f9cf9",
      tension: 0,
      spanGaps: false,
    },
  ];
  if (state.predictionHours > 0 && timeline.predictedData.length) {
    ds.push({
      label: "Predicted",
      data: timeline.predictedData,
      order: 1,
      borderColor: "#a78bfa",
      backgroundColor: "rgba(167, 139, 250, 0.08)",
      fill: false,
      pointRadius: 0,
      tension: 0,
      borderDash: [8, 4],
      spanGaps: false,
    });
  }
  return ds;
}

function chartTooltipEl(chart) {
  const parent = chart.canvas.parentNode;
  let el = parent.querySelector(".chart-tooltip");
  if (!el) {
    el = document.createElement("div");
    el.className = "chart-tooltip";
    parent.appendChild(el);
  }
  return el;
}

function externalChartTooltip(context) {
  const { chart, tooltip } = context;
  const el = chartTooltipEl(chart);
  if (tooltip.opacity === 0) {
    el.style.opacity = "0";
    return;
  }

  const items = tooltip.dataPoints ?? [];
  if (!items.length) {
    el.style.opacity = "0";
    return;
  }

  const title = fmtTime(Math.floor(items[0].parsed.x / 1000));
  const body = items
    .map((item) => {
      const raw = item.raw;
      const predicted = raw?.predicted || item.datasetIndex === 1;
      let line = `${item.dataset.label}: ${fmtNum(item.parsed.y)}`;
      if (raw?.cost) {
        line += `<br>Cost: $${fmtNum(raw.cost)}${predicted ? " (predicted)" : ""}`;
      } else if (predicted) {
        line += " (predicted)";
      }
      return `<div>${line}</div>`;
    })
    .join("");

  el.innerHTML = `<div class="chart-tooltip-title">${title}</div>${body}`;

  const parent = chart.canvas.parentNode;
  const pad = 8;
  const caretX = chart.canvas.offsetLeft + tooltip.caretX;
  const caretY = chart.canvas.offsetTop + tooltip.caretY;

  el.style.opacity = "1";
  el.style.left = `${caretX}px`;
  el.style.top = `${caretY}px`;
  el.style.transform = "translate(-50%, calc(-100% - 8px))";

  const tw = el.offsetWidth;
  const th = el.offsetHeight;
  const x = Math.max(pad + tw / 2, Math.min(parent.clientWidth - pad - tw / 2, caretX));
  const flipBelow = caretY - th - 8 < pad;
  el.style.left = `${x}px`;
  el.style.top = `${caretY}px`;
  el.style.transform = flipBelow ? "translate(-50%, 8px)" : "translate(-50%, calc(-100% - 8px))";
}

function chartOptions(timeline) {
  const { visMin, visMax } = getVisibleChartRange(timeline);
  const spanMs = visMax - visMin;
  const timeUnit = chartTimeUnitForSpan(spanMs);

  return {
    responsive: true,
    maintainAspectRatio: false,
    onResize(chart) {
      updateChartMarkers(chart);
    },
    layout: {
      padding: { top: CHART_TOP_PADDING },
    },
    interaction: {
      mode: "nearest",
      axis: "x",
      intersect: snapshotInspector.enabled,
    },
    plugins: {
      legend: {
        position: "top",
        align: "start",
        labels: { color: "#8b96a8" },
      },
      annotation: {
        annotations: buildAnnotations(state.restocks, state.rates, { ...timeline, xMin: visMin, xMax: visMax }),
      },
      tooltip: {
        enabled: false,
        external: externalChartTooltip,
      },
    },
    scales: {
      x: {
        type: "time",
        min: visMin,
        max: visMax,
        time: {
          unit: timeUnit,
          stepSize: timeUnit === "minute" ? 1 : undefined,
          displayFormats: chartTimeDisplayFormats(),
        },
        ticks: { color: "#8b96a8", maxTicksLimit: 14, source: "auto" },
        grid: { color: "#2a3345" },
      },
      y: {
        min: 0,
        beginAtZero: true,
        grace: "10%",
        ticks: { color: "#8b96a8", precision: 0 },
        grid: { color: "#2a3345" },
      },
    },
  };
}

function destroyChart() {
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
  const existing = Chart.getChart(el.chartCanvas);
  if (existing) existing.destroy();
  if (el.restockMarkers) el.restockMarkers.replaceChildren();
  if (el.safeWindowMarkers) el.safeWindowMarkers.replaceChildren();
  if (el.timeMarkers) el.timeMarkers.replaceChildren();
  el.chartCanvas?.parentNode?.querySelector(".chart-tooltip")?.remove();
}

function updateTimeMarkers(chart) {
  if (!el.timeMarkers) return;
  el.timeMarkers.replaceChildren();
  if (!chart?.chartArea) return;

  const { chartArea, scales } = chart;
  const xScale = scales.x;
  if (!xScale) return;

  const nowTs = Math.floor(Date.now() / 1000);
  const xMin = chart.options.scales.x.min;
  const xMax = chart.options.scales.x.max;
  const nowLabel = isFlyingToItem() ? "✈️ NOW" : "NOW";
  const markers = [{ ts: nowTs, label: nowLabel, color: "#ffea00" }];
  const arriveTs = getArriveTs(nowTs, state.item?.country);
  if (arriveTs != null) {
    markers.push({ ts: arriveTs, label: "ARRIVE", color: "#ff9800" });
  }

  markers.forEach(({ ts, label, color }) => {
    const xMs = tsMs(ts);
    if (xMs < xMin || xMs > xMax) return;

    const x = xScale.getPixelForValue(xMs);
    if (x < chartArea.left || x > chartArea.right) return;

    const markerLabel = document.createElement("span");
    markerLabel.className = "chart-time-marker-label";
    markerLabel.style.left = `${x}px`;
    markerLabel.style.top = `${chartMarkerTop(chart, chartArea, CHART_TIME_MARKER_LABEL_Y_ADJUST)}px`;
    markerLabel.style.color = color;
    markerLabel.innerHTML = `${label}<br>${fmtTimeShort(ts)}`;
    el.timeMarkers.appendChild(markerLabel);
  });
}

function updateRestockMarkers(chart) {
  if (!el.restockMarkers) return;
  el.restockMarkers.replaceChildren();
  if (!chart?.chartArea || state.predictionHours <= 0 || !state.predictedEvents?.length) return;

  const { chartArea, scales } = chart;
  const xScale = scales.x;
  if (!xScale) return;

  const dataTs = state.lastTimeline?.dataTs ?? Math.floor(Date.now() / 1000);
  const xMin = chart.options.scales.x.min;
  const xMax = chart.options.scales.x.max;

  const restocks = state.predictedEvents.filter(
    (e) => e.type === "restock" && e.ts >= dataTs
  );

  restocks.forEach((ev, i) => {
    const xMs = tsMs(ev.ts);
    if (xMs < xMin || xMs > xMax) return;

    const x = xScale.getPixelForValue(xMs);
    if (x < chartArea.left || x > chartArea.right) return;

    const line = document.createElement("div");
    line.className = "restock-marker";
    const canvasTop = chart.canvas.offsetTop;
    line.style.left = `${x}px`;
    line.style.top = `${canvasTop + chartArea.top}px`;
    line.style.height = `${chartArea.bottom - chartArea.top}px`;

    const label = document.createElement("span");
    label.className = "restock-marker-label";
    label.innerHTML = `#${i + 1}<br>${fmtTimeShort(ev.ts)}`;
    label.style.left = `${x}px`;
    label.style.top = `${chartMarkerTop(chart, chartArea, CHART_PREDICTION_LABEL_Y_ADJUST)}px`;

    el.restockMarkers.appendChild(line);
    el.restockMarkers.appendChild(label);
  });
}

function updateSafeWindowMarkers(chart) {
  if (!el.safeWindowMarkers) return;
  el.safeWindowMarkers.replaceChildren();
  if (!chart?.chartArea || state.predictionHours <= 0 || !state.safeWindows?.length) return;

  const { chartArea, scales } = chart;
  const xScale = scales.x;
  if (!xScale) return;

  const xMin = chart.options.scales.x.min;
  const xMax = chart.options.scales.x.max;
  const canvasTop = chart.canvas.offsetTop;

  state.safeWindows.forEach(({ safeStart, safeEnd }, i) => {
    const startMs = tsMs(safeStart);
    const endMs = tsMs(safeEnd);
    if (endMs < xMin || startMs > xMax) return;

    const x1 = xScale.getPixelForValue(Math.max(startMs, xMin));
    const x2 = xScale.getPixelForValue(Math.min(endMs, xMax));
    if (x2 <= chartArea.left || x1 >= chartArea.right) return;

    const left = Math.max(x1, chartArea.left);
    const right = Math.min(x2, chartArea.right);
    const width = right - left;
    if (width <= 0) return;

    const box = document.createElement("div");
    box.className = "safe-window-overlay";
    box.style.left = `${left}px`;
    box.style.top = `${canvasTop + chartArea.top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${chartArea.bottom - chartArea.top}px`;
    box.title = `Safe window #${i + 1}: ${fmtTimeShort(safeStart)} → ${fmtTimeShort(safeEnd)}`;
    el.safeWindowMarkers.appendChild(box);
  });
}

function updateChartMarkers(chart) {
  updateTimeMarkers(chart);
  updateSafeWindowMarkers(chart);
  updateRestockMarkers(chart);
}

function refreshChart(timeline) {
  state.lastTimeline = timeline;
  state.chartScale = clampChartScale(state.chartScale, timeline);
  state.chartOffsetSec = clampChartOffsetSec(state.chartOffsetSec, timeline);
  state.predictedEvents = timeline.events ?? [];
  const dataTs = timeline.dataTs;
  const endTs = Math.round(timeline.xMax / 1000);
  const startQty = predictionStartQty();
  if (state.predictionHours > 0 && startQty != null && dataTs > 0) {
    state.safeWindowAnchors = getSafeWindowAnchorRestocks(dataTs, endTs, startQty);
  } else {
    state.safeWindowAnchors = [];
  }
  const upcomingRestocks = state.predictedEvents.filter(
    (e) => e.type === "restock" && e.ts >= dataTs
  );
  state.safeWindows = upcomingRestocks
    .map((e, i) => safeWindowBoundsForEvent(e, i))
    .filter(Boolean);
  renderPredictionPanel(state.predictedEvents, timeline.segments ?? []);
  const options = chartOptions(timeline);
  syncOffsetInput(timeline);
  syncScaleInput(timeline);
  syncChartViewInteraction(timeline);

  if (state.chart) {
    state.chart.data.datasets = chartDatasets(timeline);
    state.chart.options = options;
    state.chart.update("none");
    updateChartMarkers(state.chart);
    return;
  }

  destroyChart();
  state.chart = new Chart(el.chartCanvas, {
    type: "line",
    data: { datasets: chartDatasets(timeline) },
    options,
  });
  updateChartMarkers(state.chart);
}

async function loadCurrentStock() {
  if (!state.item) return;
  try {
    const [data, marketPrice] = await Promise.all([
      fetchJson("/api/stocks"),
      fetchMarketPrice(state.item.itemId),
    ]);
    const countryData = data.stocks[state.item.country];
    const item = countryData?.stocks.find((i) => i.id === state.item.itemId);
    if (!item || !countryData) {
      el.currentStock.classList.add("hidden");
      el.profitEstimate?.classList.add("hidden");
      syncCurrentStockDepletion(null, null);
      return;
    }
    el.currentStock.classList.remove("hidden");
    el.currentQty.textContent = fmtNum(item.quantity);
    el.currentQty.className = `current-qty ${item.quantity === 0 ? "qty-zero" : "qty-ok"}`;
    el.currentMeta.textContent = `${fmtMoney(item.cost)} each · updated ${fmtTime(countryData.update)}`;
    noteStockTimestamp(data.timestamp);
    syncCurrentStockDepletion(item.quantity, countryData.update);
    renderProfitEstimate(item, marketPrice);
  } catch (err) {
    el.currentStock.classList.remove("hidden");
    el.currentQty.textContent = "—";
    el.currentQty.className = "current-qty";
    el.currentMeta.textContent = `Stock unavailable: ${err.message}`;
    syncCurrentStockDepletion(null, null);
    el.profitEstimate?.classList.add("hidden");
  }
}

function chartEventX(e) {
  const chart = state.chart;
  if (!chart) return null;
  const rect = chart.canvas.getBoundingClientRect();
  return e.clientX - rect.left;
}

function chartEventY(e) {
  const chart = state.chart;
  if (!chart) return null;
  const rect = chart.canvas.getBoundingClientRect();
  return e.clientY - rect.top;
}

function refreshSnapshotHighlight() {
  if (state.chart) state.chart.update("none");
  renderSnapshotInspector();
}

function clearSnapshotSelection() {
  snapshotInspector.selected.clear();
  refreshSnapshotHighlight();
}

function selectSnapshot(yataTs, { additive = false, toggle = false } = {}) {
  if (yataTs == null) return;
  if (!additive) snapshotInspector.selected.clear();
  if (toggle && snapshotInspector.selected.has(yataTs)) {
    snapshotInspector.selected.delete(yataTs);
  } else {
    snapshotInspector.selected.add(yataTs);
  }
  refreshSnapshotHighlight();
}

function selectSnapshotsInRange(minTs, maxTs, { additive = false } = {}) {
  const lo = Math.min(minTs, maxTs);
  const hi = Math.max(minTs, maxTs);
  if (!additive) snapshotInspector.selected.clear();
  for (const p of state.chartPoints) {
    if (p.yata_ts >= lo && p.yata_ts <= hi) snapshotInspector.selected.add(p.yata_ts);
  }
  refreshSnapshotHighlight();
}

function selectNearestSnapshot(pixelX, opts) {
  const chart = state.chart;
  if (!chart?.scales?.x) return;
  const xScale = chart.scales.x;
  let nearest = null;
  let minDist = Infinity;
  for (const p of state.chartPoints) {
    const px = xScale.getPixelForValue(tsMs(p.yata_ts));
    const dist = Math.abs(px - pixelX);
    if (dist < minDist) {
      minDist = dist;
      nearest = p;
    }
  }
  if (!nearest || minDist > 14) return;
  selectSnapshot(nearest.yata_ts, opts);
}

function updateChartSelectionBox(drag) {
  if (!el.chartSelectionBox || !state.chart?.chartArea) return;
  const chart = state.chart;
  const { top, bottom } = chart.chartArea;
  const canvasTop = chart.canvas.offsetTop;
  const left = Math.min(drag.startX, drag.currentX);
  const width = Math.abs(drag.currentX - drag.startX);
  el.chartSelectionBox.style.left = `${left}px`;
  el.chartSelectionBox.style.top = `${canvasTop + top}px`;
  el.chartSelectionBox.style.width = `${width}px`;
  el.chartSelectionBox.style.height = `${bottom - top}px`;
}

function setInspectMode(enabled) {
  snapshotInspector.enabled = enabled;
  el.inspectToggle?.classList.toggle("active", enabled);
  el.snapshotInspector?.classList.toggle("hidden", !enabled);
  el.chartInspectLayer?.classList.toggle("hidden", !enabled);
  syncChartViewInteraction();
  if (!enabled) {
    snapshotInspector.selected.clear();
    snapshotInspector.drag = null;
    el.chartSelectionBox?.classList.add("hidden");
  }
  if (state.chart) {
    state.chart.options.interaction.intersect = enabled;
    state.chart.update("none");
  }
  renderSnapshotInspector();
}

function snapshotByTs(yataTs) {
  return state.chartPoints.find((p) => p.yata_ts === yataTs) ?? null;
}

function renderSnapshotInspector() {
  if (!el.snapshotInspectorBody) return;

  const selected = [...snapshotInspector.selected].sort((a, b) => a - b);
  el.snapshotInspectorHint.textContent = snapshotInspector.enabled
    ? `${selected.length} selected · click a point or drag on the chart · Shift+click to toggle`
    : "";
  el.snapshotInspectorEmpty.classList.toggle(
    "hidden",
    !snapshotInspector.enabled || selected.length > 0
  );
  el.snapshotDeleteAllBtn.disabled = selected.length === 0;

  if (!selected.length) {
    el.snapshotInspectorBody.innerHTML = "";
    return;
  }

  el.snapshotInspectorBody.innerHTML = selected
    .map((yataTs) => {
      const row = snapshotByTs(yataTs);
      if (!row) return "";
      return `<tr data-yata-ts="${yataTs}">
        <td>
          <input data-field="yata_ts" type="number" min="1" step="1" value="${yataTs}" title="${fmtTime(yataTs)}" />
          <span class="snapshot-ts-label">${fmtTime(yataTs)}</span>
        </td>
        <td><input data-field="quantity" type="number" min="0" step="1" value="${row.quantity}" /></td>
        <td><input data-field="cost" type="number" min="0" step="1" value="${row.cost}" /></td>
        <td class="snapshot-row-actions">
          <button type="button" class="snapshot-save-btn" data-action="save">Save</button>
          <button type="button" class="snapshot-delete-btn" data-action="delete">Delete</button>
        </td>
      </tr>`;
    })
    .join("");
}

async function saveSnapshotRow(originalTs) {
  const item = state.item;
  if (!item) return;
  const tr = el.snapshotInspectorBody.querySelector(`tr[data-yata-ts="${originalTs}"]`);
  if (!tr) return;

  const yata_ts = Number.parseInt(tr.querySelector('[data-field="yata_ts"]').value, 10);
  const quantity = Number.parseInt(tr.querySelector('[data-field="quantity"]').value, 10);
  const cost = Number.parseInt(tr.querySelector('[data-field="cost"]').value, 10);
  if (!Number.isInteger(yata_ts) || yata_ts <= 0) {
    alert("Timestamp must be a positive integer (unix seconds).");
    return;
  }
  if (!Number.isInteger(quantity) || quantity < 0) {
    alert("Quantity must be a non-negative integer.");
    return;
  }
  if (!Number.isInteger(cost) || cost < 0) {
    alert("Cost must be a non-negative integer.");
    return;
  }

  const btn = tr.querySelector('[data-action="save"]');
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const body = await fetchJsonWithBody(
      `/api/snapshots/${item.country}/${item.itemId}/${originalTs}`,
      { method: "PATCH", body: { yata_ts, quantity, cost } }
    );
    snapshotInspector.selected.delete(originalTs);
    snapshotInspector.selected.add(body.snapshot.yata_ts);
    await drawChart();
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save";
  }
}

async function deleteSnapshotRows(yataTsList) {
  const item = state.item;
  if (!item || !yataTsList.length) return;
  if (
    !confirm(
      `Delete ${yataTsList.length} snapshot${yataTsList.length === 1 ? "" : "s"}? Restock history will be rebuilt.`
    )
  ) {
    return;
  }

  el.snapshotDeleteAllBtn.disabled = true;
  try {
    if (yataTsList.length === 1) {
      const ts = yataTsList[0];
      const res = await fetch(`/api/snapshots/${item.country}/${item.itemId}/${ts}`, {
        method: "DELETE",
      });
      await parseFetchResponse(res);
    } else {
      await fetchJsonWithBody(`/api/snapshots/${item.country}/${item.itemId}/delete`, {
        method: "POST",
        body: { yata_ts: yataTsList },
      });
    }
    for (const ts of yataTsList) snapshotInspector.selected.delete(ts);
    await drawChart();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  } finally {
    renderSnapshotInspector();
  }
}

let resetChartView = true;

function initChartViewControls() {
  el.chartOffset?.addEventListener("change", () => {
    const timeline = state.lastTimeline;
    if (!timeline) return;
    const raw = el.chartOffset.value.trim();
    const offsetSec = raw === "" ? 0 : Number.parseInt(raw, 10);
    if (!Number.isInteger(offsetSec) || offsetSec < 0) {
      syncOffsetInput(timeline);
      return;
    }
    applyChartView(timeline, { offsetSec });
  });

  el.chartScale?.addEventListener("change", () => {
    const timeline = state.lastTimeline;
    if (!timeline) return;
    const raw = el.chartScale.value.trim();
    const scale = raw === "" ? 1 : Number.parseFloat(raw);
    if (!Number.isFinite(scale) || scale <= 0) {
      syncScaleInput(timeline);
      return;
    }
    applyChartView(timeline, {
      scale,
      offsetSec: offsetSecForScaleAtViewCenter(timeline, scale),
    });
  });

  el.chartCanvas?.addEventListener("mousedown", (e) => {
    const timeline = state.lastTimeline;
    if (!timeline || !canAdjustChartView(timeline) || snapshotInspector.enabled || !state.chart?.chartArea) {
      return;
    }
    const x = chartEventX(e);
    const y = chartEventY(e);
    if (x == null || y == null) return;
    const { left, right, top, bottom } = state.chart.chartArea;
    if (x < left || x > right || y < top || y > bottom) return;
    chartPan.active = {
      startX: x,
      startY: y,
      currentX: x,
      currentY: y,
      startOffsetSec: state.chartOffsetSec,
      startScale: state.chartScale,
      panning: false,
    };
  });

  window.addEventListener("mousemove", (e) => {
    if (isMouseButtonReleased(e)) {
      endActiveChartDrags();
      return;
    }
    const pan = chartPan.active;
    const timeline = state.lastTimeline;
    const chart = state.chart;
    if (!pan || !timeline || !chart?.chartArea) return;
    const x = chartEventX(e);
    const y = chartEventY(e);
    if (x == null || y == null) return;
    pan.currentX = x;
    pan.currentY = y;
    const deltaX = pan.currentX - pan.startX;
    const deltaY = pan.currentY - pan.startY;
    if (!pan.panning) {
      if (
        Math.abs(deltaX) <= CHART_PAN_DRAG_THRESHOLD_PX &&
        Math.abs(deltaY) <= CHART_PAN_DRAG_THRESHOLD_PX
      ) {
        return;
      }
      pan.panning = true;
      el.chartWrap?.classList.add("is-panning");
    }
    const { offsetSec: nextOffset, scale: nextScale } = dragChartView(
      timeline,
      pan,
      deltaX,
      deltaY,
      pan.currentX,
      chart
    );
    applyChartView(timeline, { offsetSec: nextOffset, scale: nextScale });
  });

  document.addEventListener("mouseup", endChartPan);
  window.addEventListener("blur", endActiveChartDrags);
  document.documentElement.addEventListener("mouseleave", (e) => {
    if (!e.relatedTarget) endActiveChartDrags();
  });
}

initChartViewControls();

function initSnapshotInspector() {
  el.inspectToggle?.addEventListener("click", () => setInspectMode(!snapshotInspector.enabled));
  el.snapshotClearBtn?.addEventListener("click", clearSnapshotSelection);
  el.snapshotDeleteAllBtn?.addEventListener("click", () => {
    deleteSnapshotRows([...snapshotInspector.selected]);
  });

  el.snapshotInspectorBody?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const tr = btn.closest("tr[data-yata-ts]");
    if (!tr) return;
    const originalTs = Number.parseInt(tr.dataset.yataTs, 10);
    if (btn.dataset.action === "save") saveSnapshotRow(originalTs);
    else if (btn.dataset.action === "delete") deleteSnapshotRows([originalTs]);
  });

  el.chartInspectLayer?.addEventListener("mousedown", (e) => {
    if (!snapshotInspector.enabled || !state.chart?.chartArea) return;
    const x = chartEventX(e);
    if (x == null) return;
    const { left, right } = state.chart.chartArea;
    if (x < left || x > right) return;
    e.preventDefault();
    snapshotInspector.drag = { startX: x, currentX: x, moved: false, shiftKey: e.shiftKey };
    el.chartSelectionBox.classList.remove("hidden");
    updateChartSelectionBox(snapshotInspector.drag);
  });

  window.addEventListener("mousemove", (e) => {
    if (isMouseButtonReleased(e)) {
      endActiveChartDrags();
      return;
    }
    const drag = snapshotInspector.drag;
    if (!drag) return;
    const x = chartEventX(e);
    if (x == null) return;
    drag.currentX = x;
    if (Math.abs(drag.currentX - drag.startX) > 4) drag.moved = true;
    updateChartSelectionBox(drag);
  });

  document.addEventListener("mouseup", (e) => {
    const drag = snapshotInspector.drag;
    if (!drag) return;
    snapshotInspector.drag = null;
    el.chartSelectionBox.classList.add("hidden");

    const chart = state.chart;
    if (!chart?.scales?.x) return;

    if (drag.moved) {
      const xScale = chart.scales.x;
      const minTs = Math.floor(xScale.getValueForPixel(Math.min(drag.startX, drag.currentX)) / 1000);
      const maxTs = Math.floor(xScale.getValueForPixel(Math.max(drag.startX, drag.currentX)) / 1000);
      selectSnapshotsInRange(minTs, maxTs, { additive: drag.shiftKey });
    } else {
      selectNearestSnapshot(drag.startX, { additive: drag.shiftKey, toggle: drag.shiftKey });
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && snapshotInspector.enabled) {
      if (snapshotInspector.selected.size) clearSnapshotSelection();
      else setInspectMode(false);
    }
  });
}

initSnapshotInspector();

async function drawChart() {
  const { country, itemId } = state.item;
  const [history, restockData] = await Promise.all([
    fetchJson(`/api/history/${country}/${itemId}?hours=${state.rangeHours}`),
    fetchJson(`/api/restocks/${country}/${itemId}`),
  ]);
  state.chartPoints = history.points;
  loadRestockData(restockData);

  el.itemEmpty.classList.toggle("hidden", history.points.length > 0);
  el.status.textContent = `${history.points.length} snapshots in range — updates when YATA polls (~every minute)`;
  renderCycleHistory();

  const timeline = buildTimeline(history.points, state.predictionHours);
  if (resetChartView) {
    state.chartScale = 1;
    state.chartOffsetSec = getMaxChartOffsetSec(timeline, 1);
    resetChartView = false;
  } else {
    state.chartScale = clampChartScale(state.chartScale, timeline);
    state.chartOffsetSec = clampChartOffsetSec(state.chartOffsetSec, timeline);
  }
  refreshChart(timeline);
  for (const ts of snapshotInspector.selected) {
    if (!snapshotByTs(ts)) snapshotInspector.selected.delete(ts);
  }
  renderSnapshotInspector();
}

function redrawPrediction() {
  if (!state.item || !state.chartPoints.length) return;
  const timeline = buildTimeline(state.chartPoints, state.predictionHours);
  refreshChart(timeline);
}

function parseItemFromUrl() {
  const parsed = parseItemFromPath();
  if (!parsed || parsed.view !== "stock") return null;
  if (!state.countries[parsed.country] || !Number.isInteger(parsed.itemId)) return null;
  return { country: parsed.country, itemId: parsed.itemId, name: parsed.name };
}

function setupItemPage(item) {
  setupItemHeader(item, "stock");
  const savedAmount = getRestockAmount(item.country, item.itemId);
  el.restockAmount.value = savedAmount ?? "";
}

function refreshRestockAdjustments() {
  renderCycleHistory();
  if (!state.chartPoints.length) return;
  const timeline = buildTimeline(state.chartPoints, state.predictionHours);
  refreshChart(timeline);
}

function loadRestockData({ restocks, rates } = {}) {
  if (restocks) state.restocks = restocks;
  if (rates) state.rates = rates;
}

function refreshRestockViews() {
  renderCycleHistory();
  if (state.chartPoints.length) {
    const timeline = buildTimeline(state.chartPoints, state.predictionHours);
    refreshChart(timeline);
  }
}

async function setCycleIgnored(depletedTs, ignored) {
  const { country, itemId } = state.item;
  const row = state.restocks.find((r) => r.depleted_ts === depletedTs);
  if (!row) return;
  const prevIgnored = row.ignored;
  row.ignored = ignored;
  refreshRestockViews();

  try {
    const data = await fetchJsonWithBody(
      `/api/restocks/${country}/${itemId}/${depletedTs}`,
      { method: "PATCH", body: { ignored } }
    );
    loadRestockData(data);
    refreshRestockViews();
  } catch (err) {
    row.ignored = prevIgnored;
    refreshRestockViews();
    throw err;
  }
}

el.cycleHistoryBody.addEventListener("change", async (e) => {
  const input = e.target.closest("input.cycle-count");
  if (!input || !state.item) return;
  const depletedTs = Number.parseInt(input.dataset.depletedTs, 10);
  if (!Number.isInteger(depletedTs)) return;
  const ignored = !input.checked;
  input.disabled = true;
  try {
    await setCycleIgnored(depletedTs, ignored);
  } catch (err) {
    alert(err.message || "Failed to save — restart the server if you just updated the app.");
  } finally {
    input.disabled = false;
  }
});

el.restockAmount.addEventListener("change", () => {
  const item = state.item;
  if (!item) return;
  const raw = el.restockAmount.value.trim();
  if (raw === "") {
    setRestockAmount(item.country, item.itemId, null);
    refreshRestockAdjustments();
    return;
  }
  const amount = Number.parseInt(raw, 10);
  if (!Number.isInteger(amount) || amount <= 0) {
    el.restockAmount.value = getRestockAmount(item.country, item.itemId) ?? "";
    return;
  }
  setRestockAmount(item.country, item.itemId, amount);
  el.restockAmount.value = amount;
  refreshRestockAdjustments();
});

el.rangeButtons.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-hours]");
  if (!btn || !state.item) return;
  state.rangeHours = Number(btn.dataset.hours);
  savePrefs({ rangeHours: state.rangeHours });
  syncHourButtons(el.rangeButtons, state.rangeHours);
  resetChartView = true;
  drawChart();
});

el.predictionButtons.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-hours]");
  if (!btn || !state.item) return;
  state.predictionHours = Number(btn.dataset.hours);
  savePrefs({ predictionHours: state.predictionHours });
  syncHourButtons(el.predictionButtons, state.predictionHours);
  redrawPrediction();
});

syncHourButtons(el.rangeButtons, state.rangeHours);
syncHourButtons(el.predictionButtons, state.predictionHours);

if (el.flightVarianceToggle) {
  el.flightVarianceToggle.checked = state.flightTimeVariance;
  el.flightVarianceToggle.addEventListener("change", () => {
    state.flightTimeVariance = el.flightVarianceToggle.checked;
    savePrefs({ flightTimeVariance: state.flightTimeVariance });
    redrawPrediction();
  });
}

initSampleExtremaButtons(el.avgButtons, state.avgSamples, "stockoutTiming", ({ mode, n }) => {
  if (mode === "avg") {
    state.stockoutTiming = "avg";
    state.avgSamples = n;
    savePrefs({ stockoutTiming: "avg", avgSamples: n });
  } else {
    state.stockoutTiming = mode;
    savePrefs({ stockoutTiming: mode });
  }
  renderCycleHistory();
  redrawPrediction();
});
initSampleExtremaButtons(el.rateAvgButtons, state.avgRateSamples, "rateTiming", ({ mode, n }) => {
  if (mode === "avg") {
    state.rateTiming = "avg";
    state.avgRateSamples = n;
    savePrefs({ rateTiming: "avg", avgRateSamples: n });
  } else {
    state.rateTiming = mode;
    savePrefs({ rateTiming: mode });
  }
  renderCycleHistory();
  redrawPrediction();
});

window.addEventListener("timeformatchange", () => {
  if (!state.item) return;
  renderCycleHistory();
  loadCurrentStock();
  if (state.chartPoints.length) {
    const timeline = buildTimeline(state.chartPoints, state.predictionHours);
    refreshChart(timeline);
  }
});

(async () => {
  await loadCountries();
  const item = parseItemFromUrl();
  if (!item) {
    el.status.textContent = "Invalid item URL";
    el.status.classList.add("error");
    return;
  }
  setupItemPage(item);
  await Promise.all([drawChart(), loadCurrentStock(), refreshTravelStatus()]);
  setInterval(updateCurrentDepletionCountdown, 1000);
  startStockUpdateWatcher(async () => {
    await Promise.all([drawChart(), loadCurrentStock(), refreshTravelStatus()]);
  });
})();
