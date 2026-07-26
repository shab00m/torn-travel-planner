// Shared stock / empty-for / rate-by-hour chart view toggle on the item page.
const ITEM_CHART_TYPES = ["stock", "empty-for", "rate-tod"];

const itemChartViewUi = {
  type: "stock",
};

const itemChartViewEl = {
  buttons: document.getElementById("chart-type-buttons"),
  wraps: {
    stock: document.getElementById("stock-chart-wrap"),
    "empty-for": document.getElementById("empty-for-chart-wrap"),
    "rate-tod": document.getElementById("rate-tod-chart-wrap"),
  },
};

function isItemChartView(type) {
  return itemChartViewUi.type === type;
}

/** Refresh whichever secondary chart is visible (no-op for stock). */
function syncActiveItemChartView() {
  if (itemChartViewUi.type === "empty-for" && typeof syncEmptyForChart === "function") {
    syncEmptyForChart();
  } else if (itemChartViewUi.type === "rate-tod" && typeof syncRateTodChart === "function") {
    syncRateTodChart();
  }
  if (typeof syncEmptyForSwapAxesButton === "function") syncEmptyForSwapAxesButton();
}

function setItemChartType(type) {
  if (!ITEM_CHART_TYPES.includes(type)) {
    throw new Error(`Unknown chart type: ${type}`);
  }
  itemChartViewUi.type = type;

  itemChartViewEl.buttons?.querySelectorAll("button[data-chart]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.chart === type);
  });
  for (const [key, wrap] of Object.entries(itemChartViewEl.wraps)) {
    wrap?.classList.toggle("hidden", key !== type);
  }

  if (type === "stock") {
    if (typeof syncEmptyForSwapAxesButton === "function") syncEmptyForSwapAxesButton();
    if (state.chart) state.chart.resize();
    return;
  }

  syncActiveItemChartView();
}

function initItemChartTypeToggle() {
  if (!itemChartViewEl.buttons) return;
  itemChartViewEl.buttons.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-chart]");
    if (!btn) return;
    const type = btn.dataset.chart;
    if (type === itemChartViewUi.type) return;
    setItemChartType(type);
  });
}

initItemChartTypeToggle();
