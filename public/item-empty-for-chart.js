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

function getEmptyForChartPoints() {
  const sinceTs = historyRangeSinceTs();
  const swapped = emptyForChartUi.axesSwapped;
  return getCycleHistoryRows()
    .filter(
      (r) =>
        !r.ignored &&
        r.emptyForSec != null &&
        r.emptyForSec >= 0 &&
        r.restocked_ts != null &&
        (sinceTs === 0 || r.restocked_ts >= sinceTs)
    )
    .map((r) => {
      const timeMs = r.restocked_ts * 1000;
      return {
        x: swapped ? timeMs : r.emptyForSec,
        y: swapped ? r.emptyForSec : timeMs,
        depleted_ts: r.depleted_ts,
        restocked_ts: r.restocked_ts,
        emptyForSec: r.emptyForSec,
      };
    })
    .sort((a, b) => a.restocked_ts - b.restocked_ts);
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

function emptyForChartOptions(points) {
  const durationValues = points.map((p) => p.emptyForSec);
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
            return `Empty for: ${fmtDurationDetailed(raw.emptyForSec)}`;
          },
          afterLabel: (ctx) => {
            const raw = ctx.raw;
            if (!raw) return "";
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

function emptyForChartDataset(points) {
  return {
    label: "Empty for",
    data: points,
    showLine: false,
    borderColor: "#f0a36b",
    backgroundColor: "rgba(240, 163, 107, 0.85)",
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

  const points = getEmptyForChartPoints();
  const hasPoints = points.length > 0;
  emptyForChartEl.empty?.classList.toggle("hidden", hasPoints);
  emptyForChartEl.canvas.classList.toggle("hidden", !hasPoints);

  if (!hasPoints) {
    destroyEmptyForChart();
    return;
  }

  const options = emptyForChartOptions(points);
  const dataset = emptyForChartDataset(points);

  if (emptyForChartUi.chart) {
    emptyForChartUi.chart.data.datasets = [dataset];
    emptyForChartUi.chart.options = options;
    emptyForChartUi.chart.update("none");
    emptyForChartUi.chart.resize();
    return;
  }

  destroyEmptyForChart();
  emptyForChartUi.chart = new Chart(emptyForChartEl.canvas, {
    type: "scatter",
    data: { datasets: [dataset] },
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
