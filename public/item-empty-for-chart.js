// Lazy empty-for scatter chart on the item stock page (built only when toggled).
const emptyForChartUi = {
  type: "stock",
  chart: null,
};

const emptyForChartEl = {
  buttons: document.getElementById("chart-type-buttons"),
  stockWrap: document.getElementById("stock-chart-wrap"),
  wrap: document.getElementById("empty-for-chart-wrap"),
  canvas: document.getElementById("empty-for-chart"),
  empty: document.getElementById("empty-for-chart-empty"),
};

function getEmptyForChartPoints() {
  return getCycleHistoryRows()
    .filter(
      (r) =>
        !r.ignored &&
        r.emptyForSec != null &&
        r.emptyForSec >= 0 &&
        r.restocked_ts != null
    )
    .map((r) => ({
      x: r.emptyForSec,
      y: r.restocked_ts * 1000,
      depleted_ts: r.depleted_ts,
      restocked_ts: r.restocked_ts,
      emptyForSec: r.emptyForSec,
    }))
    .sort((a, b) => a.y - b.y);
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

function emptyForChartOptions(points) {
  const xValues = points.map((p) => p.x);
  const yValues = points.map((p) => p.y);
  const xMinData = Math.min(...xValues);
  const xMaxData = Math.max(...xValues);
  const xPadSec = 10 * 60;
  const xMin = Math.max(0, xMinData - xPadSec);
  const xMax = xMaxData + xPadSec;
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  const pad = Math.max((yMax - yMin) * 0.05, 60_000);
  const spanMs = Math.max(yMax - yMin, 60_000);
  const timeUnit = emptyForChartTimeUnit(spanMs);

  return {
    responsive: true,
    maintainAspectRatio: false,
    parsing: false,
    interaction: { mode: "nearest", intersect: true },
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
            return [
              `Empty for: ${fmtDuration(raw.emptyForSec)}`,
              `Depleted: ${fmtTime(raw.depleted_ts)}`,
            ];
          },
        },
      },
    },
    scales: {
      x: {
        type: "linear",
        min: xMin,
        max: xMax,
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
      },
      y: {
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
      },
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
    borderWidth: 1.5,
    tension: 0,
  };
}

/** Build or update the empty-for chart. No-op unless that view is active. */
function syncEmptyForChart() {
  if (emptyForChartUi.type !== "empty-for") return;
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

function setItemChartType(type) {
  if (type !== "stock" && type !== "empty-for") {
    throw new Error(`Unknown chart type: ${type}`);
  }
  emptyForChartUi.type = type;

  emptyForChartEl.buttons?.querySelectorAll("button[data-chart]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.chart === type);
  });
  emptyForChartEl.stockWrap?.classList.toggle("hidden", type !== "stock");
  emptyForChartEl.wrap?.classList.toggle("hidden", type !== "empty-for");

  if (type === "empty-for") {
    syncEmptyForChart();
    return;
  }

  if (state.chart) state.chart.resize();
}

function initItemChartTypeToggle() {
  if (!emptyForChartEl.buttons) return;
  emptyForChartEl.buttons.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-chart]");
    if (!btn) return;
    const type = btn.dataset.chart;
    if (type === emptyForChartUi.type) return;
    setItemChartType(type);
  });
}

initItemChartTypeToggle();
