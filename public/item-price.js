const el = {
  status: document.getElementById("status"),
  rangeButtons: document.getElementById("range-buttons"),
  chartCanvas: document.getElementById("price-chart"),
  itemEmpty: document.getElementById("item-empty"),
};

function destroyChart() {
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
  const existing = Chart.getChart(el.chartCanvas);
  if (existing) existing.destroy();
}

async function drawChart() {
  const { country, itemId } = state.item;
  try {
    const history = await fetchJson(`/api/history/${country}/${itemId}?hours=${state.rangeHours}`);
    state.chartPoints = history.points;

    el.itemEmpty.classList.toggle("hidden", history.points.length > 0);
    el.status.textContent = `${history.points.length} snapshots in range — updates when YATA polls (~every minute)`;
    el.status.classList.remove("error");

    if (!history.points.length) {
      destroyChart();
      return;
    }

    const data = buyPriceChartDataFromPoints(history.points);
    const { xMin, xMax } = buyPriceChartRange(data);
    const options = buyPriceChartOptions(xMin, xMax);
    const dataset = buyPriceChartDataset(data);

    if (state.chart) {
      state.chart.data.datasets = [dataset];
      state.chart.options = options;
      state.chart.update("none");
      return;
    }

    destroyChart();
    state.chart = new Chart(el.chartCanvas, {
      type: "line",
      data: { datasets: [dataset] },
      options,
    });
  } catch (err) {
    el.status.textContent = `Error: ${err.message}`;
    el.status.classList.add("error");
  }
}

function parseItemFromUrl() {
  const parsed = parseItemFromPath();
  if (!parsed || parsed.view !== "price") return null;
  if (!state.countries[parsed.country] || !Number.isInteger(parsed.itemId)) return null;
  return { country: parsed.country, itemId: parsed.itemId, name: parsed.name };
}

el.rangeButtons.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-hours]");
  if (!btn || !state.item) return;
  state.rangeHours = Number(btn.dataset.hours);
  savePrefs({ rangeHours: state.rangeHours });
  syncHourButtons(el.rangeButtons, state.rangeHours);
  drawChart();
});

syncHourButtons(el.rangeButtons, state.rangeHours);

window.addEventListener("timeformatchange", () => {
  if (state.item) drawChart();
});

(async () => {
  await window.authReady;
  await loadCountries();
  const item = parseItemFromUrl();
  if (!item) {
    el.status.textContent = "Invalid item URL";
    el.status.classList.add("error");
    return;
  }
  setupItemHeader(item, "price");
  await drawChart();
  startStockUpdateWatcher(drawChart);
})();
