// Shared stock / empty-for / rate-by-hour / buy-price chart view toggle on the item page.
const ITEM_CHART_TYPES = ["stock", "empty-for", "rate-tod", "buy-price"];

const itemChartViewUi = {
  type: "stock",
};

const itemChartViewEl = {
  buttons: document.getElementById("chart-type-buttons"),
  wraps: {
    stock: document.getElementById("stock-chart-wrap"),
    "empty-for": document.getElementById("empty-for-chart-wrap"),
    "rate-tod": document.getElementById("rate-tod-chart-wrap"),
    "buy-price": document.getElementById("buy-price-chart-wrap"),
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
  } else if (itemChartViewUi.type === "buy-price" && typeof syncBuyPriceChart === "function") {
    syncBuyPriceChart();
  }
  if (typeof syncEmptyForChartOptions === "function") syncEmptyForChartOptions();
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
    if (typeof syncEmptyForChartOptions === "function") syncEmptyForChartOptions();
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
