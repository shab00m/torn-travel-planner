// Lazy empty-for scatter chart on the item stock page (built only when toggled).
const emptyForChartUi = {
  chart: null,
  axesSwapped: false,
};

const emptyForChartEl = {
  swapAxes: document.getElementById("empty-for-swap-axes"),
  wrap: document.getElementById("empty-for-chart-wrap"),
  canvas: document.getElementById("empty-for-chart"),
  empty: document.getElementById("empty-for-chart-empty"),
};

const EMPTY_FOR_INCLUDED_COLOR = "#f0a36b";
const EMPTY_FOR_EXCLUDED_FILL = "rgba(139, 150, 168, 0.28)";
const EMPTY_FOR_EXCLUDED_BORDER = "rgba(139, 150, 168, 0.4)";
const EMPTY_FOR_RANGE_FILL = "rgba(79, 156, 249, 0.10)";
const EMPTY_FOR_RANGE_BORDER = "rgba(79, 156, 249, 0.45)";

function emptyForChartRowToPoint(r, swapped) {
  const timeMs = r.restocked_ts * 1000;
  return {
    x: swapped ? timeMs : r.emptyForSec,
    y: swapped ? r.emptyForSec : timeMs,
    depleted_ts: r.depleted_ts,
    adjusted_depleted_ts: r.adjusted_depleted_ts ?? r.effective_depleted_ts ?? r.depleted_ts,
    restocked_ts: r.restocked_ts,
    emptyForSec: r.emptyForSec,
    ignored: Boolean(r.ignored),
  };
}

function getEmptyForChartData() {
  const swapped = emptyForChartUi.axesSwapped;
  const rows = getCycleHistoryRows({ includeIgnored: true }).filter(
    (r) => r.emptyForSec != null && r.emptyForSec >= 0 && r.restocked_ts != null
  );
  const byTime = (a, b) => a.restocked_ts - b.restocked_ts;
  return {
    included: rows.filter((r) => !r.ignored).map((r) => emptyForChartRowToPoint(r, swapped)).sort(byTime),
    excluded: rows.filter((r) => r.ignored).map((r) => emptyForChartRowToPoint(r, swapped)).sort(byTime),
  };
}

function emptyForChartTimeUnit(spanMs) {
  const spanHours = spanMs / 3_600_000;
  return spanHours <= 6 ? "minute" : spanHours <= 48 ? "hour" : "day";
}

function destroyEmptyForChart() {
  if (emptyForChartUi.chart) {
    emptyForChartUi.chart.destroy();
    emptyForChartUi.chart = null;
  }
  const existing = emptyForChartEl.canvas ? Chart.getChart(emptyForChartEl.canvas) : null;
  if (existing) existing.destroy();
}

function emptyForDurationScale(values) {
  const minData = Math.min(...values);
  const maxData = Math.max(...values);
  const padSec = 10 * 60;
  return {
    type: "linear",
    min: Math.max(0, minData - padSec),
    max: maxData + padSec,
    title: {
      display: true,
      text: "Empty for",
      color: "#8b96a8",
    },
    ticks: {
      color: "#8b96a8",
      callback: (value) => fmtDuration(value),
    },
    grid: { color: "#2a3345" },
  };
}

function emptyForTimeScale(valuesMs) {
  const yMin = Math.min(...valuesMs);
  const yMax = Math.max(...valuesMs);
  const pad = Math.max((yMax - yMin) * 0.05, 60_000);
  const spanMs = Math.max(yMax - yMin, 60_000);
  const timeUnit = emptyForChartTimeUnit(spanMs);
  return {
    type: "time",
    min: yMin - pad,
    max: yMax + pad,
    title: {
      display: true,
      text: "Restocked",
      color: "#8b96a8",
    },
    time: {
      unit: timeUnit,
      stepSize: timeUnit === "minute" ? 1 : undefined,
      displayFormats: chartTimeDisplayFormats(),
    },
    ticks: {
      color: "#8b96a8",
      maxTicksLimit: 12,
      callback: chartTimeTickCallback,
    },
    grid: { color: "#2a3345" },
  };
}

function currentEmptyForChartBounds() {
  if (!state.item) return { minEmptyFor: null, maxEmptyFor: null };
  return getEmptyForBounds(state.item.country, state.item.itemId);
}

function emptyForRangeAnnotations(swapped, minSec, maxSec) {
  if (minSec == null && maxSec == null) return {};
  const box = {
    type: "box",
    backgroundColor: EMPTY_FOR_RANGE_FILL,
    borderColor: EMPTY_FOR_RANGE_BORDER,
    borderWidth: 1,
    label: {
      display: true,
      content: "Range",
      color: "#8b96a8",
      font: { size: 11, weight: "600" },
      position: swapped ? { x: "start", y: "center" } : { x: "center", y: "start" },
    },
  };
  if (swapped) {
    if (minSec != null) box.yMin = minSec;
    if (maxSec != null) box.yMax = maxSec;
  } else {
    if (minSec != null) box.xMin = minSec;
    if (maxSec != null) box.xMax = maxSec;
  }
  return { emptyForRange: box };
}

function emptyForChartOptions(points, bounds) {
  const durationValues = points.map((p) => p.emptyForSec);
  if (bounds.minEmptyFor != null) durationValues.push(bounds.minEmptyFor);
  if (bounds.maxEmptyFor != null) durationValues.push(bounds.maxEmptyFor);
  const timeValues = points.map((p) => p.restocked_ts * 1000);
  const durationScale = emptyForDurationScale(durationValues);
  const timeScale = emptyForTimeScale(timeValues);
  const swapped = emptyForChartUi.axesSwapped;

  return {
    responsive: true,
    maintainAspectRatio: false,
    parsing: false,
    interaction: { mode: "nearest", intersect: true },
    onHover(event, elements) {
      const canvas = event.native?.target;
      if (canvas?.style) canvas.style.cursor = elements.length ? "pointer" : "default";
    },
    onClick(_event, elements, chart) {
      if (!elements.length) return;
      const el = elements[0];
      const raw = chart.data.datasets[el.datasetIndex]?.data?.[el.index];
      if (raw?.depleted_ts == null || typeof focusCycleHistoryRow !== "function") return;
      focusCycleHistoryRow(raw.depleted_ts);
    },
    plugins: {
      legend: {
        position: "top",
        align: "start",
        labels: { color: "#8b96a8" },
      },
      annotation: {
        annotations: emptyForRangeAnnotations(swapped, bounds.minEmptyFor, bounds.maxEmptyFor),
      },
      tooltip: {
        backgroundColor: "rgba(23, 28, 38, 0.95)",
        titleColor: "#e6ebf2",
        bodyColor: "#e6ebf2",
        callbacks: {
          title: (items) => {
            const raw = items[0]?.raw;
            return raw ? fmtTime(raw.restocked_ts) : "";
          },
          label: (ctx) => {
            const raw = ctx.raw;
            if (!raw) return "";
            const excluded = raw.ignored ? " (excluded)" : "";
            return `Empty for: ${fmtDurationDetailed(raw.emptyForSec)}${excluded}`;
          },
          afterLabel: (ctx) => {
            const raw = ctx.raw;
            if (!raw) return "";
            const adj = raw.adjusted_depleted_ts;
            if (adj != null && adj !== raw.depleted_ts) {
              return [
                `Depleted: ${fmtTime(raw.depleted_ts)}`,
                `Adj. depleted: ${fmtTime(adj)}`,
              ];
            }
            return `Depleted: ${fmtTime(raw.depleted_ts)}`;
          },
        },
      },
    },
    scales: {
      x: swapped ? timeScale : durationScale,
      y: swapped ? durationScale : timeScale,
    },
  };
}

function emptyForChartDataset(points, { excluded = false } = {}) {
  return {
    label: excluded ? "Excluded" : "Empty for",
    data: points,
    showLine: false,
    borderColor: excluded ? EMPTY_FOR_EXCLUDED_BORDER : EMPTY_FOR_INCLUDED_COLOR,
    backgroundColor: excluded ? EMPTY_FOR_EXCLUDED_FILL : "rgba(240, 163, 107, 0.85)",
    pointRadius: points.length > 200 ? 2 : 4,
    pointHoverRadius: 6,
    pointHitRadius: 8,
    borderWidth: 1.5,
    tension: 0,
  };
}

function syncEmptyForSwapAxesButton() {
  if (!emptyForChartEl.swapAxes) return;
  const onEmptyFor = typeof isItemChartView === "function" && isItemChartView("empty-for");
  emptyForChartEl.swapAxes.classList.toggle("hidden", !onEmptyFor);
  emptyForChartEl.swapAxes.classList.toggle("active", emptyForChartUi.axesSwapped);
  emptyForChartEl.swapAxes.setAttribute(
    "aria-pressed",
    emptyForChartUi.axesSwapped ? "true" : "false"
  );
}

/** Build or update the empty-for chart. No-op unless that view is active. */
function syncEmptyForChart() {
  syncEmptyForSwapAxesButton();
  if (typeof isItemChartView === "function" && !isItemChartView("empty-for")) return;
  if (!emptyForChartEl.canvas || !emptyForChartEl.wrap) return;

  const { included, excluded } = getEmptyForChartData();
  const points = included.concat(excluded);
  const hasPoints = points.length > 0;
  emptyForChartEl.empty?.classList.toggle("hidden", hasPoints);
  emptyForChartEl.canvas.classList.toggle("hidden", !hasPoints);

  if (!hasPoints) {
    destroyEmptyForChart();
    return;
  }

  const bounds = currentEmptyForChartBounds();
  const options = emptyForChartOptions(points, bounds);
  const datasets = [emptyForChartDataset(included)];
  if (excluded.length) datasets.push(emptyForChartDataset(excluded, { excluded: true }));

  if (emptyForChartUi.chart) {
    emptyForChartUi.chart.data.datasets = datasets;
    emptyForChartUi.chart.options = options;
    emptyForChartUi.chart.update("none");
    emptyForChartUi.chart.resize();
    return;
  }

  destroyEmptyForChart();
  emptyForChartUi.chart = new Chart(emptyForChartEl.canvas, {
    type: "scatter",
    data: { datasets },
    options,
  });
}

function setEmptyForAxesSwapped(swapped) {
  emptyForChartUi.axesSwapped = Boolean(swapped);
  // Scale types change (linear ↔ time); recreate instead of updating in place.
  destroyEmptyForChart();
  syncEmptyForChart();
}

function initEmptyForSwapAxesButton() {
  emptyForChartEl.swapAxes?.addEventListener("click", () => {
    setEmptyForAxesSwapped(!emptyForChartUi.axesSwapped);
  });
}

initEmptyForSwapAxesButton();
