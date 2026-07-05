// Item history modal: chart with out-of-stock annotations plus the restock
// duration panel. Uses the shared `state` / `el` / `fetchJson` from app.js.
Chart.register(window["chartjs-plugin-annotation"]);

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

// One source for both sample-size button groups (restock avg + rate avg).
const SAMPLE_OPTIONS = [1, 3, 5, 10, 20];
function initAvgButtons(container, defaultN, onSelect) {
  container.innerHTML = SAMPLE_OPTIONS.map(
    (n) => `<button data-n="${n}" class="${n === defaultN ? "active" : ""}">${n}</button>`
  ).join("");
  container.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-n]");
    if (!btn) return;
    container.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    onSelect(Number(btn.dataset.n));
  });
}

// Maps a timestamp to the index of the first snapshot at or after it
// (the x-axis is a category scale, one entry per snapshot).
function tsToIndex(points, ts) {
  const idx = points.findIndex((p) => p.yata_ts >= ts);
  return idx === -1 ? points.length - 1 : idx;
}

// Shaded boxes over the periods the item was out of stock (labelled with the
// restock duration) plus dashed trend lines over in-stock windows showing the
// depletion rate.
function buildAnnotations(points, restocks, rates) {
  const annotations = {};
  if (!points.length) return annotations;
  const firstTs = points[0].yata_ts;
  const lastTs = points[points.length - 1].yata_ts;

  restocks.forEach((r, i) => {
    if ((r.restocked_ts ?? Infinity) < firstTs || r.depleted_ts > lastTs) return;
    const endIdx = r.restocked_ts != null ? tsToIndex(points, r.restocked_ts) : points.length - 1;
    annotations[`restock${i}`] = {
      type: "box",
      xMin: tsToIndex(points, r.depleted_ts),
      xMax: endIdx,
      backgroundColor: "rgba(242, 106, 106, 0.12)",
      borderColor: "rgba(242, 106, 106, 0.45)",
      borderWidth: 1,
      label: {
        display: true,
        content: r.duration != null ? fmtDuration(r.duration) : "out of stock",
        position: { x: "center", y: "start" },
        color: "#f26a6a",
        font: { size: 11, weight: "600" },
      },
    };
  });

  rates.forEach((w, i) => {
    if (w.end_ts < firstTs || w.start_ts > lastTs) return;
    // Clamp the window to the visible range and interpolate the quantities
    // so the line keeps the true slope when partially visible.
    const slope = (w.end_qty - w.start_qty) / (w.end_ts - w.start_ts);
    const startTs = Math.max(w.start_ts, firstTs);
    const endTs = Math.min(w.end_ts, lastTs);
    annotations[`rate${i}`] = {
      type: "line",
      xMin: tsToIndex(points, startTs),
      xMax: tsToIndex(points, endTs),
      yMin: w.start_qty + slope * (startTs - w.start_ts),
      yMax: w.start_qty + slope * (endTs - w.start_ts),
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
  return annotations;
}

function renderRestockPanel() {
  const completed = state.restocks.filter((r) => r.duration != null);
  const open = state.restocks.find((r) => r.restocked_ts == null);

  const rows = [];
  if (open) {
    rows.push(
      `<li class="ongoing">Out of stock since ${fmtTime(open.depleted_ts)} — not restocked yet</li>`
    );
  }
  for (const r of completed.slice(0, 5)) {
    rows.push(
      `<li>Depleted ${fmtTime(r.depleted_ts)} → restocked ${fmtTime(r.restocked_ts)}
       <strong>${fmtDuration(r.duration)}</strong></li>`
    );
  }
  el.restockList.innerHTML =
    rows.join("") || `<li class="ongoing">No depletion/restock cycles observed yet.</li>`;

  const sample = completed.slice(0, state.avgSamples);
  if (sample.length) {
    const avg = sample.reduce((sum, r) => sum + r.duration, 0) / sample.length;
    el.restockAvg.textContent = `${fmtDuration(avg)} (${sample.length} sample${sample.length === 1 ? "" : "s"})`;
  } else {
    el.restockAvg.textContent = "no samples yet";
  }
}

function renderRatePanel() {
  const sample = state.rates.slice(0, state.avgRateSamples);
  if (sample.length) {
    const avg = sample.reduce((sum, w) => sum + w.rate, 0) / sample.length;
    el.rateAvg.textContent = `${fmtRate(avg)} items/min (${sample.length} sample${sample.length === 1 ? "" : "s"})`;
  } else {
    el.rateAvg.textContent = "no samples yet";
  }
}

async function drawChart() {
  const { country, itemId } = state.modalItem;
  const [history, restockData] = await Promise.all([
    fetchJson(`/api/history/${country}/${itemId}?hours=${state.rangeHours}`),
    fetchJson(`/api/restocks/${country}/${itemId}`),
  ]);
  const points = history.points;
  state.chartPoints = points;
  state.restocks = restockData.restocks;
  state.rates = restockData.rates;

  el.modalEmpty.classList.toggle("hidden", points.length > 0);
  renderRestockPanel();
  renderRatePanel();

  const labels = points.map((p) => new Date(p.yata_ts * 1000).toLocaleString());
  const quantities = points.map((p) => p.quantity);
  const annotations = buildAnnotations(points, state.restocks, state.rates);

  // Update in place when the chart already exists (live refresh without flicker).
  if (state.chart) {
    state.chart.data.labels = labels;
    const ds = state.chart.data.datasets[0];
    ds.data = quantities;
    ds.pointRadius = points.length > 200 ? 0 : 2;
    state.chart.options.plugins.annotation.annotations = annotations;
    state.chart.update();
    return;
  }

  state.chart = new Chart(el.chartCanvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Stock quantity",
          data: quantities,
          borderColor: "#4f9cf9",
          backgroundColor: "rgba(79, 156, 249, 0.15)",
          fill: true,
          pointRadius: points.length > 200 ? 0 : 2,
          tension: 0.15,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#8b96a8" } },
        annotation: { annotations },
        tooltip: {
          callbacks: {
            afterLabel: (ctx) =>
              `Cost: $${state.chartPoints[ctx.dataIndex].cost.toLocaleString("en-US")}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: "#8b96a8", maxTicksLimit: 10 }, grid: { color: "#2a3345" } },
        y: {
          beginAtZero: true,
          ticks: { color: "#8b96a8", precision: 0 },
          grid: { color: "#2a3345" },
        },
      },
    },
  });
}

async function openModal(country, itemId, name) {
  state.modalItem = { country, itemId, name };
  const meta = state.countries[country];
  el.modalTitle.textContent = name;
  el.modalSubtitle.textContent = `${meta.flag} ${meta.name}`;
  el.modal.classList.remove("hidden");
  await drawChart();
}

function closeModal() {
  el.modal.classList.add("hidden");
  state.modalItem = null;
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
}

// --- modal events ---
el.modalClose.addEventListener("click", closeModal);
el.modal.addEventListener("click", (e) => {
  if (e.target === el.modal) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

el.rangeButtons.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-hours]");
  if (!btn || !state.modalItem) return;
  state.rangeHours = Number(btn.dataset.hours);
  el.rangeButtons.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
  drawChart();
});

initAvgButtons(el.avgButtons, state.avgSamples, (n) => {
  state.avgSamples = n;
  renderRestockPanel();
});
initAvgButtons(el.rateAvgButtons, state.avgRateSamples, (n) => {
  state.avgRateSamples = n;
  renderRatePanel();
});
