const el = {
  status: document.getElementById("status"),
  rangeButtons: document.getElementById("range-buttons"),
  chartCanvas: document.getElementById("price-chart"),
  itemEmpty: document.getElementById("item-empty"),
};

const tsMs = (ts) => ts * 1000;

function chartTimeUnitForSpan(spanMs) {
  const spanHours = spanMs / 3_600_000;
  return spanHours <= 6 ? "minute" : spanHours <= 48 ? "hour" : "day";
}

function destroyChart() {
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
  const existing = Chart.getChart(el.chartCanvas);
  if (existing) existing.destroy();
}

function priceChartOptions(xMin, xMax) {
  const timeUnit = chartTimeUnitForSpan(xMax - xMin);
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "nearest", axis: "x", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "rgba(23, 28, 38, 0.95)",
        titleColor: "#e6ebf2",
        bodyColor: "#e6ebf2",
        callbacks: {
          title: (items) => fmtTime(Math.round(items[0].parsed.x / 1000)),
          label: (ctx) => `Buy price: ${fmtMoney(ctx.parsed.y)}`,
        },
      },
    },
    scales: {
      x: {
        type: "time",
        min: xMin,
        max: xMax,
        time: {
          unit: timeUnit,
          stepSize: timeUnit === "minute" ? 1 : undefined,
          displayFormats: chartTimeDisplayFormats(),
        },
        ticks: {
          color: "#8b96a8",
          maxTicksLimit: 14,
          callback: chartTimeTickCallback,
        },
        grid: { color: "#2a3345" },
      },
      y: {
        beginAtZero: false,
        grace: "5%",
        ticks: {
          color: "#8b96a8",
          callback: (v) => fmtMoney(v),
        },
        grid: { color: "#2a3345" },
      },
    },
  };
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

    const data = history.points.map((p) => ({
      x: tsMs(p.yata_ts),
      y: p.cost,
      yata_ts: p.yata_ts,
    }));

    const xMin = data[0].x;
    const nowTs = Math.floor(Date.now() / 1000);
    const lastTs = history.points[history.points.length - 1].yata_ts;
    const xMax = tsMs(Math.max(nowTs, lastTs));
    const options = priceChartOptions(xMin, xMax);
    const dataset = {
      label: "Buy price",
      data,
      borderColor: "#4f9cf9",
      backgroundColor: "rgba(79, 156, 249, 0.08)",
      fill: true,
      stepped: true,
      pointRadius: data.length > 200 ? 0 : 2,
      pointHoverRadius: 5,
      borderWidth: 2,
    };

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
