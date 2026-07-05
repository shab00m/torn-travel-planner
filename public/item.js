// Item detail page: chart, restock stats, and predictions.
Chart.register(window["chartjs-plugin-annotation"]);

const el = {
  status: document.getElementById("status"),
  itemTitle: document.getElementById("item-title"),
  itemSubtitle: document.getElementById("item-subtitle"),
  itemEmpty: document.getElementById("item-empty"),
  rangeButtons: document.getElementById("range-buttons"),
  chartCanvas: document.getElementById("history-chart"),
  avgButtons: document.getElementById("avg-buttons"),
  restockAvg: document.getElementById("restock-avg"),
  restockList: document.getElementById("restock-list"),
  rateAvgButtons: document.getElementById("rate-avg-buttons"),
  rateAvg: document.getElementById("rate-avg"),
  predictionButtons: document.getElementById("prediction-buttons"),
  predictionList: document.getElementById("prediction-list"),
  predictionTravelNote: document.getElementById("prediction-travel-note"),
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
const tsMs = (ts) => ts * 1000;

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

function getAverages() {
  const completed = state.restocks.filter((r) => r.duration != null);
  const restockSample = completed.slice(0, state.avgSamples);
  const rateSample = state.rates.slice(0, state.avgRateSamples);
  if (!restockSample.length || !rateSample.length) return null;
  return {
    restockSec:
      restockSample.reduce((sum, r) => sum + r.duration, 0) / restockSample.length,
    rate: rateSample.reduce((sum, w) => sum + w.rate, 0) / rateSample.length,
    restockQty: Math.round(
      rateSample.reduce((sum, w) => sum + w.start_qty, 0) / rateSample.length
    ),
  };
}

function simulatePredictions(nowTs, endTs, startQty, averages) {
  const { restockSec, rate, restockQty } = averages;
  const events = [];
  const segments = [];
  const open = state.restocks.find((r) => r.restocked_ts == null);

  let t = nowTs;
  let qty = startQty;
  let outOfStock = qty === 0 || open != null;
  let depletedTs = open?.depleted_ts ?? null;

  while (t < endTs) {
    if (outOfStock) {
      const restockTs = Math.round(
        depletedTs ? Math.max(t, depletedTs + restockSec) : t + restockSec
      );
      if (restockTs > endTs) break;
      events.push({ type: "restock", ts: restockTs, qty: restockQty });
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
    events.push({ type: "restock", ts: restockTs, qty: restockQty });
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

  return [...tsSet]
    .filter((ts) => ts >= nowTs && ts <= endTs)
    .sort((a, b) => a - b)
    .map((ts) => ({
      x: tsMs(ts),
      y: qtyAtPredicted(ts, nowTs, startQty, segments, events),
      cost,
      predicted: true,
    }));
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
    const boxEnd = r.restocked_ts ?? nowTs;
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
        content: r.duration != null ? fmtDuration(r.duration) : "out of stock",
        position: { x: "center", y: "start" },
        color: "#f26a6a",
        font: { size: 11, weight: "600" },
      },
    };
  });

  rates.forEach((w, i) => {
    if (tsMs(w.end_ts) < xMin || w.start_ts > nowTs) return;
    const slope = (w.end_qty - w.start_qty) / (w.end_ts - w.start_ts);
    const startTs = Math.max(w.start_ts, xMin / 1000);
    const endTs = Math.min(w.end_ts, nowTs);
    annotations[`rate${i}`] = {
      type: "line",
      xMin: tsMs(startTs),
      xMax: tsMs(endTs),
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

  annotations.now = {
    type: "line",
    xMin: tsMs(nowTs),
    xMax: tsMs(nowTs),
    borderColor: "rgba(255, 255, 255, 0.55)",
    borderWidth: 2,
    borderDash: [4, 4],
    label: {
      display: true,
      content: "Now",
      position: "start",
      backgroundColor: "rgba(23, 28, 38, 0.9)",
      color: "#e6ebf2",
      font: { size: 10, weight: "600" },
    },
  };

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
      const endTs = w.end_ts;
      annotations[`predRate${i}`] = {
        type: "line",
        xMin: tsMs(startTs),
        xMax: tsMs(endTs),
        yMin: w.start_qty + slope * (startTs - w.start_ts),
        yMax: w.start_qty + slope * (endTs - w.start_ts),
        borderColor: "rgba(167, 139, 250, 0.85)",
        borderWidth: 2,
        borderDash: [6, 4],
        label: {
          display: true,
          content: `${fmtRate(w.rate)}/min`,
          position: "center",
          backgroundColor: "rgba(23, 28, 38, 0.85)",
          color: "#a78bfa",
          font: { size: 10, weight: "600" },
        },
      };
    });

    events.forEach((ev, i) => {
      if (ev.type !== "restock" || ev.ts < nowTs) return;
      annotations[`predRestock${i}`] = {
        type: "point",
        xValue: tsMs(ev.ts),
        yValue: ev.qty,
        backgroundColor: "#a78bfa",
        borderColor: "#ffffff",
        borderWidth: 2,
        radius: 7,
        label: {
          display: true,
          content: "Restock",
          position: "top",
          backgroundColor: "rgba(23, 28, 38, 0.9)",
          color: "#a78bfa",
          font: { size: 10, weight: "600" },
        },
      };
    });
  }

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

function renderPredictionPanel(events) {
  const show = state.predictionHours > 0;
  document.getElementById("prediction-section").classList.toggle("hidden", !show);
  if (!show) return;

  const country = state.item?.country;
  const flightSec = country ? getFlightSec(country) : null;
  el.predictionTravelNote.textContent = flightSec
    ? `Leave times assume ${state.travelType} travel (${fmtDuration(flightSec)} one-way)`
    : "";

  const nowTs = Math.floor(Date.now() / 1000);
  const restocks = events.filter((e) => e.type === "restock" && e.ts >= nowTs);
  if (!restocks.length) {
    el.predictionList.innerHTML = `<li class="ongoing">Not enough data to predict restocks.</li>`;
    return;
  }

  el.predictionList.innerHTML = restocks
    .map((e, i) => {
      const leaveTs = flightSec != null ? e.ts - flightSec : null;
      let leaveHtml = "";
      if (leaveTs != null) {
        const cls = leaveTs <= nowTs ? "leave-now" : "leave-by";
        const label = leaveTs <= nowTs ? "Leave now" : `Leave by ${fmtTime(leaveTs)}`;
        leaveHtml = `<span class="${cls}">${label}</span>`;
      }
      return `<li>
        <span>${i === 0 ? "Next" : "Then"} restock ${fmtTime(e.ts)} · ~${fmtNum(e.qty)} items</span>
        ${leaveHtml}
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

function chartDatasets(timeline) {
  const ds = [
    {
      label: "Stock quantity",
      data: timeline.actualData,
      borderColor: "#4f9cf9",
      backgroundColor: "rgba(79, 156, 249, 0.15)",
      fill: true,
      pointRadius: timeline.actualData.length > 200 ? 0 : 2,
      tension: 0.15,
      spanGaps: false,
    },
  ];
  if (state.predictionHours > 0 && timeline.predictedData.length) {
    ds.push({
      label: "Predicted",
      data: timeline.predictedData,
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

function chartOptions(timeline) {
  const spanMs = timeline.xMax - timeline.xMin;
  const spanHours = spanMs / 3_600_000;
  const timeUnit = spanHours <= 6 ? "minute" : spanHours <= 48 ? "hour" : "day";

  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "nearest", axis: "x", intersect: false },
    plugins: {
      legend: { labels: { color: "#8b96a8" } },
      annotation: {
        annotations: buildAnnotations(state.restocks, state.rates, timeline),
      },
      tooltip: {
        callbacks: {
          title: (items) => {
            if (!items.length) return "";
            return new Date(items[0].parsed.x).toLocaleString();
          },
          afterLabel: (ctx) => {
            const raw = ctx.dataset.data[ctx.dataIndex];
            if (!raw?.cost) return raw?.predicted || ctx.datasetIndex === 1 ? " (predicted)" : "";
            const suffix = raw.predicted || ctx.datasetIndex === 1 ? " (predicted)" : "";
            return `Cost: $${raw.cost.toLocaleString("en-US")}${suffix}`;
          },
        },
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
          displayFormats: {
            minute: "HH:mm",
            hour: "MMM d HH:mm",
            day: "MMM d",
          },
        },
        ticks: { color: "#8b96a8", maxTicksLimit: 14, source: "auto" },
        grid: { color: "#2a3345" },
      },
      y: {
        beginAtZero: true,
        ticks: { color: "#8b96a8", precision: 0 },
        grid: { color: "#2a3345" },
      },
    },
  };
}

function refreshChart(timeline) {
  state.predictedEvents = timeline.events ?? [];
  renderPredictionPanel(state.predictedEvents);
  const options = chartOptions(timeline);

  if (state.chart) {
    state.chart.data.datasets = chartDatasets(timeline);
    state.chart.options = options;
    state.chart.update();
    return;
  }

  state.chart = new Chart(el.chartCanvas, {
    type: "line",
    data: { datasets: chartDatasets(timeline) },
    options,
  });
}

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
  renderRestockPanel();
  renderRatePanel();

  const timeline = buildTimeline(history.points, state.predictionHours);
  refreshChart(timeline);
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
}

el.rangeButtons.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-hours]");
  if (!btn || !state.item) return;
  state.rangeHours = Number(btn.dataset.hours);
  el.rangeButtons.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
  drawChart();
});

el.predictionButtons.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-hours]");
  if (!btn || !state.item) return;
  state.predictionHours = Number(btn.dataset.hours);
  el.predictionButtons.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
  redrawPrediction();
});

initAvgButtons(el.avgButtons, state.avgSamples, (n) => {
  state.avgSamples = n;
  renderRestockPanel();
  redrawPrediction();
});
initAvgButtons(el.rateAvgButtons, state.avgRateSamples, (n) => {
  state.avgRateSamples = n;
  renderRatePanel();
  redrawPrediction();
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
  await drawChart();
  setInterval(drawChart, 60_000);
})();
