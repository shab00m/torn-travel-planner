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
  inspectToggle: document.getElementById("inspect-toggle"),
  chartInspectLayer: document.getElementById("chart-inspect-layer"),
  chartSelectionBox: document.getElementById("chart-selection-box"),
  snapshotInspector: document.getElementById("snapshot-inspector"),
  snapshotInspectorHint: document.getElementById("snapshot-inspector-hint"),
  snapshotInspectorEmpty: document.getElementById("snapshot-inspector-empty"),
  snapshotInspectorBody: document.getElementById("snapshot-inspector-body"),
  snapshotClearBtn: document.getElementById("snapshot-clear-btn"),
  snapshotDeleteAllBtn: document.getElementById("snapshot-delete-all-btn"),
};

const snapshotInspector = {
  enabled: false,
  selected: new Set(),
  drag: null,
};

function fmtDuration(seconds) {
  const s = Math.round(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

const fmtRate = (r) => (Math.abs(r) >= 10 ? r.toFixed(0) : r.toFixed(1));
const CYCLE_HISTORY_LIMIT = 10;
const CHART_TOP_PADDING = 48;
const CHART_TIME_MARKER_LABEL_Y_ADJUST = -34;
const CHART_PREDICTION_LABEL_Y_ADJUST = 8;
const tsMs = (ts) => ts * 1000;

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

function getAdjustedRates() {
  return state.rates.map(adjustedRateWindow);
}

function getHistoricalExtents() {
  const restocks = getAdjustedCompletedRestocks();
  const durations = restocks
    .map((r) => r.adjusted_duration)
    .filter((d) => d != null && d > 0);
  const rates = getAdjustedRates()
    .map((w) => w.rate)
    .filter((r) => r != null && r > 0);
  return {
    minEmptyFor: durations.length ? Math.min(...durations) : null,
    maxEmptyFor: durations.length ? Math.max(...durations) : null,
    minRate: rates.length ? Math.min(...rates) : null,
    maxRate: rates.length ? Math.max(...rates) : null,
  };
}

function stockoutSecFromHistory() {
  const restocks = getAdjustedCompletedRestocks();
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
  const windows = getAdjustedRates();
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
  const qtySample = getAdjustedRates().slice(0, state.avgRateSamples);
  const qtySource = qtySample.length ? qtySample : getAdjustedRates();
  return {
    restockSec,
    rate,
    restockQty: configuredQty ?? Math.round(
      qtySource.reduce((sum, w) => sum + w.start_qty, 0) / qtySource.length
    ),
  };
}

function simulatePredictions(nowTs, endTs, startQty, averages) {
  const { restockSec, rate, restockQty } = averages;
  const events = [];
  const segments = [];
  const open =
    startQty === 0 ? state.restocks.find((r) => r.restocked_ts == null) : null;

  let t = nowTs;
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

function qtyAtPredicted(ts, nowTs, startQty, segments, events) {
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
  if (ts <= nowTs) return startQty;
  return 0;
}

// One point per minute from now through endTs, plus exact event timestamps.
function buildPredictedMinuteSeries(nowTs, endTs, startQty, segments, events, cost) {
  const tsSet = new Set([nowTs, endTs]);
  for (let ts = Math.ceil(nowTs / 60) * 60; ts <= endTs; ts += 60) tsSet.add(ts);
  for (const ev of events) {
    if (ev.ts != null) tsSet.add(ev.ts);
    if (ev.start != null) tsSet.add(ev.start);
    if (ev.end != null) {
      tsSet.add(ev.end);
      tsSet.add(ev.end - 1);
    }
  }

  const points = [...tsSet]
    .filter((ts) => ts >= nowTs && ts <= endTs)
    .sort((a, b) => a - b)
    .map((ts) => ({
      x: tsMs(ts),
      y: qtyAtPredicted(ts, nowTs, startQty, segments, events),
      cost,
      predicted: true,
    }));

  const restockTimes = new Set(
    events.filter((e) => e.type === "restock" && e.ts >= nowTs).map((e) => e.ts)
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
  const nowTs = Math.floor(Date.now() / 1000);
  if (!historicalPoints.length) {
    return { actualData: [], predictedData: [], nowTs, xMin: 0, xMax: 0, segments: [], events: [] };
  }

  const firstTs = historicalPoints[0].yata_ts;
  const lastHist = historicalPoints[historicalPoints.length - 1];

  const actualData = historicalPoints.map((p) => ({
    x: tsMs(p.yata_ts),
    y: p.quantity,
    cost: p.cost,
    yata_ts: p.yata_ts,
    predicted: false,
  }));

  if (nowTs > lastHist.yata_ts) {
    actualData.push({
      x: tsMs(nowTs),
      y: lastHist.quantity,
      cost: lastHist.cost,
      predicted: false,
      nowAnchor: true,
    });
  }

  let endTs = Math.max(nowTs, lastHist.yata_ts);
  let predictedData = [];
  let segments = [];
  let events = [];

  if (predictionHours > 0) {
    const averages = getAverages();
    if (averages) {
      endTs = nowTs + predictionHours * 3600;
      ({ events, segments } = simulatePredictions(nowTs, endTs, lastHist.quantity, averages));
      predictedData = buildPredictedMinuteSeries(
        nowTs,
        endTs,
        lastHist.quantity,
        segments,
        events,
        lastHist.cost
      );
    }
  }

  const arriveTs = getArriveTs(nowTs, state.item?.country);
  if (arriveTs != null) {
    endTs = Math.max(endTs, arriveTs);
  }

  return {
    actualData,
    predictedData,
    nowTs,
    xMin: tsMs(firstTs),
    xMax: tsMs(endTs),
    segments,
    events,
  };
}

function buildAnnotations(restocks, rates, timeline) {
  const annotations = {};
  const { nowTs, segments = [], events = [], xMin, xMax } = timeline;
  if (!xMax) return annotations;

  restocks.forEach((r, i) => {
    const adjusted = adjustedRestockRecord(r);
    const boxEnd = adjusted.adjusted_restocked_ts ?? nowTs;
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

  getAdjustedRates().forEach((w, i) => {
    if (tsMs(w.end_ts) < xMin || w.start_ts > nowTs) return;
    if (state.predictionHours > 0 && state.rates[i]?.open) return;
    const slope = (w.end_qty - w.start_qty) / (w.end_ts - w.start_ts);
    const startTs = Math.max(w.start_ts, xMin / 1000);
    const endTs = Math.min(w.end_ts, nowTs, xMax / 1000);
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
    xMin: tsMs(nowTs),
    xMax: tsMs(nowTs),
    borderColor: "#ffea00",
    borderWidth: 2,
    borderDash: [4, 4],
  };

  const arriveTs = getArriveTs(nowTs, state.item?.country);
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
      if (w.end_ts <= nowTs) return;
      const slope = (w.end_qty - w.start_qty) / (w.end_ts - w.start_ts);
      const startTs = Math.max(w.start_ts, nowTs);
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
    };
  });
}

function renderCycleHistory() {
  const open = state.restocks.find((r) => r.restocked_ts == null);
  el.cycleOpenNote.classList.toggle("hidden", !open);
  if (open) {
    el.cycleOpenNote.textContent = `Currently empty since ${fmtTime(open.depleted_ts)} — not restocked yet`;
  }

  const rows = getCycleHistoryRows();

  const stockoutSample = rows.slice(0, state.avgSamples);
  if (state.stockoutTiming === "min" || state.stockoutTiming === "max") {
    const { minEmptyFor, maxEmptyFor } = getHistoricalExtents();
    const value = state.stockoutTiming === "min" ? minEmptyFor : maxEmptyFor;
    const allRows = getCycleHistoryRows();
    if (value != null && allRows.length) {
      el.restockAvg.textContent = `${fmtDuration(value)} (${state.stockoutTiming.toUpperCase()} of ${allRows.length})`;
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

  const rateSample = rows.filter((r) => r.rate != null).slice(0, state.avgRateSamples);
  if (state.rateTiming === "min" || state.rateTiming === "max") {
    const { minRate, maxRate } = getHistoricalExtents();
    const value = state.rateTiming === "min" ? minRate : maxRate;
    const allRateRows = rows.filter((r) => r.rate != null);
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
      `<tr><td colspan="4" class="empty-note">No depletion/restock cycles observed yet.</td></tr>`;
    return;
  }

  el.cycleHistoryBody.innerHTML = rows
    .map(
      (r) => `<tr>
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

function predictedRestockBounds(e, averages, events, segments) {
  let restockEarliest = e.ts;
  const amount = currentRestockAmount();
  if (amount && averages?.rate) {
    restockEarliest = adjustRestockTime(
      e.ts,
      e.qty,
      averages.rate,
      amount,
      e.depleted_ts
    );
  }
  const depleteTs = depletionAfterRestock(e.ts, events, segments);
  const restockLatest = depleteTs ?? restockEarliest;
  return { restockEarliest, restockLatest };
}

function safeWindowBounds(e) {
  const { minEmptyFor, maxEmptyFor, maxRate } = getHistoricalExtents();
  if (minEmptyFor == null || maxEmptyFor == null || maxRate == null) return null;

  const depletedTs = e.depleted_ts;
  if (depletedTs == null) return null;

  const restockQty = currentRestockAmount() ?? e.qty;
  const safeStart = Math.round(depletedTs + maxEmptyFor);
  const safeEnd = Math.round(depletedTs + minEmptyFor + (restockQty / maxRate) * 60);

  if (safeStart >= safeEnd) return null;
  return { safeStart, safeEnd };
}

function formatSafeWindowLabel(bounds, i) {
  if (!bounds) return "";
  return `<span class="safe-window-label">#${i + 1} safe: ${fmtTimeShort(bounds.safeStart)} → ${fmtTimeShort(bounds.safeEnd)}</span>`;
}

function formatRestockLabel(e, i, averages, events, segments) {
  const { restockEarliest, restockLatest } = predictedRestockBounds(e, averages, events, segments);
  return `#${i + 1}: Window between ${fmtTimeShort(restockEarliest)} → ${fmtTimeShort(restockLatest)}`;
}

function formatLeaveWindow(restockEarliest, restockLatest, flightSec, nowTs) {
  if (flightSec == null || restockEarliest == null || restockLatest == null) return "";
  const leaveEarliest = restockEarliest - flightSec;
  const leaveLatest = restockLatest - flightSec;

  if (leaveLatest <= nowTs) {
    const missedSec = nowTs - leaveLatest;
    return `<span class="leave-missed">Missed window by ${fmtDuration(missedSec)}</span>`;
  }

  return `<span class="leave-by">Leave between ${fmtTimeShort(leaveEarliest)} and ${fmtTimeShort(leaveLatest)}</span>`;
}

function formatSafeLeaveWindow(bounds, flightSec, nowTs) {
  if (!bounds || flightSec == null) return "";
  return formatLeaveWindow(bounds.safeStart, bounds.safeEnd, flightSec, nowTs).replace(
    "leave-by",
    "safe-leave-by"
  );
}

function renderPredictionPanel(events, segments) {
  const show = state.predictionHours > 0;
  document.getElementById("prediction-section").classList.toggle("hidden", !show);
  if (!show) return;

  const country = state.item?.country;
  const flightSec = country ? getFlightSec(country) : null;
  el.predictionTravelNote.textContent = flightSec
    ? `Leave times assume ${state.travelType} travel (${fmtDuration(flightSec)} one-way)`
    : "";

  const nowTs = Math.floor(Date.now() / 1000);
  const averages = getAverages();
  const restocks = events.filter((e) => e.type === "restock" && e.ts >= nowTs);
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
        segments
      );
      const leaveHtml = formatLeaveWindow(restockEarliest, restockLatest, flightSec, nowTs);
      const safe = safeWindowBounds(e);
      const safeHtml = safe
        ? `<div class="safe-window-info">${formatSafeWindowLabel(safe, i)}${formatSafeLeaveWindow(safe, flightSec, nowTs)}</div>`
        : "";
      return `<li class="prediction-item">
        <div class="prediction-main">
          <span>${formatRestockLabel(e, i, averages, events, segments)}</span>
          ${leaveHtml}
        </div>
        ${safeHtml}
      </li>`;
    })
    .join("");
}

function getFlightSec(country) {
  return (
    state.countries[country]?.flightSec?.[state.travelType] ??
    state.countries[country]?.flightSec?.Standard ??
    null
  );
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
  if (raw?.nowAnchor) return 0;
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
  const spanMs = timeline.xMax - timeline.xMin;
  const spanHours = spanMs / 3_600_000;
  const timeUnit = spanHours <= 6 ? "minute" : spanHours <= 48 ? "hour" : "day";

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
        annotations: buildAnnotations(state.restocks, state.rates, timeline),
      },
      tooltip: {
        enabled: false,
        external: externalChartTooltip,
      },
    },
    scales: {
      x: {
        type: "time",
        min: timeline.xMin,
        max: timeline.xMax,
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

  const nowTs = Math.floor(Date.now() / 1000);
  const xMin = chart.options.scales.x.min;
  const xMax = chart.options.scales.x.max;

  const restocks = state.predictedEvents.filter(
    (e) => e.type === "restock" && e.ts >= nowTs
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
  state.predictedEvents = timeline.events ?? [];
  const nowTs = Math.floor(Date.now() / 1000);
  state.safeWindows = state.predictedEvents
    .filter((e) => e.type === "restock" && e.ts >= nowTs)
    .map((e) => safeWindowBounds(e))
    .filter(Boolean);
  renderPredictionPanel(state.predictedEvents, timeline.segments ?? []);
  const options = chartOptions(timeline);

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
    const data = await fetchJson("/api/stocks");
    const item = data.stocks[state.item.country]?.stocks.find(
      (i) => i.id === state.item.itemId
    );
    if (!item) {
      el.currentStock.classList.add("hidden");
      return;
    }
    el.currentStock.classList.remove("hidden");
    el.currentQty.textContent = fmtNum(item.quantity);
    el.currentQty.className = `current-qty ${item.quantity === 0 ? "qty-zero" : "qty-ok"}`;
    el.currentMeta.textContent = `${fmtMoney(item.cost)} each · polled ${fmtTime(data.timestamp)}`;
  } catch (err) {
    el.currentStock.classList.remove("hidden");
    el.currentQty.textContent = "—";
    el.currentQty.className = "current-qty";
    el.currentMeta.textContent = `Stock unavailable: ${err.message}`;
  }
}

function chartEventX(e) {
  const chart = state.chart;
  if (!chart) return null;
  const rect = chart.canvas.getBoundingClientRect();
  return e.clientX - rect.left;
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
    const drag = snapshotInspector.drag;
    if (!drag) return;
    const x = chartEventX(e);
    if (x == null) return;
    drag.currentX = x;
    if (Math.abs(drag.currentX - drag.startX) > 4) drag.moved = true;
    updateChartSelectionBox(drag);
  });

  window.addEventListener("mouseup", (e) => {
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
  state.restocks = restockData.restocks;
  state.rates = restockData.rates;

  el.itemEmpty.classList.toggle("hidden", history.points.length > 0);
  el.status.textContent = `${history.points.length} snapshots in range — auto-refreshes every minute`;
  renderCycleHistory();

  const timeline = buildTimeline(history.points, state.predictionHours);
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
  const m = window.location.pathname.match(/^\/item\/([^/]+)\/(\d+)\/?$/);
  if (!m) return null;
  const country = m[1];
  const itemId = Number.parseInt(m[2], 10);
  const name = new URLSearchParams(window.location.search).get("name") || "Item";
  if (!state.countries[country] || !Number.isInteger(itemId)) return null;
  return { country, itemId, name };
}

function setupItemPage(item) {
  state.item = item;
  const meta = state.countries[item.country];
  el.itemTitle.textContent = item.name;
  el.itemSubtitle.textContent = `${meta.flag} ${meta.name}`;
  document.title = `${item.name} — Torn Travel Planner`;
  const savedAmount = getRestockAmount(item.country, item.itemId);
  el.restockAmount.value = savedAmount ?? "";
}

function refreshRestockAdjustments() {
  renderCycleHistory();
  if (!state.chartPoints.length) return;
  const timeline = buildTimeline(state.chartPoints, state.predictionHours);
  refreshChart(timeline);
}

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
  setInterval(() => {
    drawChart();
    loadCurrentStock();
    refreshTravelStatus();
  }, 60_000);
})();
