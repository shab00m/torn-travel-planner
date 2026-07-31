// Buy-price-over-time chart helpers + lazy toggle view on the item stock page.
const buyPriceChartUi = {
  chart: null,
};

const buyPriceChartEl = {
  wrap: document.getElementById("buy-price-chart-wrap"),
  canvas: document.getElementById("buy-price-chart"),
  empty: document.getElementById("buy-price-chart-empty"),
};

function buyPriceChartTimeUnit(spanMs) {
  const spanHours = spanMs / 3_600_000;
  return spanHours <= 6 ? "minute" : spanHours <= 48 ? "hour" : "day";
}

function buyPriceChartDataFromPoints(points) {
  // Drop zero/invalid costs — bad snapshots flatten the y-scale to 0.
  return points
    .filter((p) => Number.isFinite(p.cost) && p.cost > 0)
    .map((p) => ({
      x: p.yata_ts * 1000,
      y: p.cost,
      yata_ts: p.yata_ts,
    }));
}

function buyPriceChartRange(data) {
  if (!data.length) {
    throw new Error("buy price chart requires at least one point");
  }
  const xMin = data[0].x;
  const nowTs = Math.floor(Date.now() / 1000);
  const lastTs = data[data.length - 1].yata_ts;
  const xMax = Math.max(nowTs, lastTs) * 1000;
  return { xMin, xMax };
}

function buyPriceChartOptions(xMin, xMax) {
  const timeUnit = buyPriceChartTimeUnit(xMax - xMin);
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

function buyPriceChartDataset(data) {
  return {
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
}

function destroyBuyPriceChart() {
  if (buyPriceChartUi.chart) {
    buyPriceChartUi.chart.destroy();
    buyPriceChartUi.chart = null;
  }
  const existing = buyPriceChartEl.canvas ? Chart.getChart(buyPriceChartEl.canvas) : null;
  if (existing) existing.destroy();
}

/** Build or update the buy-price chart. No-op unless that view is active. */
function syncBuyPriceChart() {
  if (typeof isItemChartView === "function" && !isItemChartView("buy-price")) return;
  if (!buyPriceChartEl.canvas || !buyPriceChartEl.wrap) return;

  const data = buyPriceChartDataFromPoints(state.chartPoints ?? []);
  const hasPoints = data.length > 0;
  buyPriceChartEl.empty?.classList.toggle("hidden", hasPoints);
  buyPriceChartEl.canvas.classList.toggle("hidden", !hasPoints);

  if (!hasPoints) {
    destroyBuyPriceChart();
    return;
  }

  const { xMin, xMax } = buyPriceChartRange(data);
  const options = buyPriceChartOptions(xMin, xMax);
  const dataset = buyPriceChartDataset(data);

  if (buyPriceChartUi.chart) {
    buyPriceChartUi.chart.data.datasets = [dataset];
    buyPriceChartUi.chart.options = options;
    buyPriceChartUi.chart.update("none");
    buyPriceChartUi.chart.resize();
    return;
  }

  destroyBuyPriceChart();
  buyPriceChartUi.chart = new Chart(buyPriceChartEl.canvas, {
    type: "line",
    data: { datasets: [dataset] },
    options,
  });
}
