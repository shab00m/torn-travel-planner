// Lazy avg depletion-rate vs time-of-day chart (built only when toggled).
const rateTodChartUi = {
  chart: null,
};

const rateTodChartEl = {
  wrap: document.getElementById("rate-tod-chart-wrap"),
  canvas: document.getElementById("rate-tod-chart"),
  empty: document.getElementById("rate-tod-chart-empty"),
};

function zonedTimeParts(ts) {
  const parts = new Intl.DateTimeFormat("en-US", withDisplayTimeZone({
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })).formatToParts(new Date(ts * 1000));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { hour: get("hour"), minute: get("minute"), second: get("second") };
}

function secondsOfDay(ts) {
  const { hour, minute, second } = zonedTimeParts(ts);
  return hour * 3600 + minute * 60 + second;
}

function formatHourOfDayLabel(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  if (state.timeFormat === "us") {
    const period = h < 12 ? "AM" : "PM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:00 ${period}`;
  }
  return `${String(h).padStart(2, "0")}:00`;
}

/**
 * Weight each usable rate window into hour-of-day buckets by overlap minutes.
 * Respects History Time Range (clips windows to the selected span).
 */
function getRateTodChartPoints() {
  const nowTs = Math.floor(Date.now() / 1000);
  const sinceTs = historyRangeSinceTs(nowTs);
  const buckets = Array.from({ length: 24 }, () => ({ sum: 0, weight: 0, samples: 0 }));

  for (const w of getUsableRates()) {
    if (w.rate == null || w.rate <= 0 || w.start_ts == null || w.end_ts == null) continue;
    let start = w.start_ts;
    let end = w.end_ts;
    if (end <= start) continue;
    if (sinceTs > 0) {
      if (end <= sinceTs || start >= nowTs) continue;
      start = Math.max(start, sinceTs);
      end = Math.min(end, nowTs);
      if (end <= start) continue;
    }

    let t = start;
    while (t < end) {
      const sod = secondsOfDay(t);
      const hour = Math.floor(sod / 3600);
      const secLeftInHour = 3600 - (sod % 3600);
      const segSec = Math.min(secLeftInHour, end - t);
      const minutes = segSec / 60;
      if (minutes > 0) {
        buckets[hour].sum += w.rate * minutes;
        buckets[hour].weight += minutes;
        buckets[hour].samples += 1;
      }
      t += segSec;
    }
  }

  return buckets
    .map((b, hour) =>
      b.weight > 0
        ? {
            x: hour + 0.5,
            y: b.sum / b.weight,
            hour,
            samples: b.samples,
            weightMin: b.weight,
          }
        : null
    )
    .filter(Boolean);
}

function destroyRateTodChart() {
  if (rateTodChartUi.chart) {
    rateTodChartUi.chart.destroy();
    rateTodChartUi.chart = null;
  }
  const existing = rateTodChartEl.canvas ? Chart.getChart(rateTodChartEl.canvas) : null;
  if (existing) existing.destroy();
}

function rateTodNowX() {
  return secondsOfDay(Math.floor(Date.now() / 1000)) / 3600;
}

function rateTodNowAnnotation() {
  const x = rateTodNowX();
  return {
    type: "line",
    xMin: x,
    xMax: x,
    borderColor: "#ffea00",
    borderWidth: 2,
    borderDash: [4, 4],
    label: {
      display: true,
      content: "NOW",
      position: "start",
      backgroundColor: "rgba(23, 28, 38, 0.9)",
      color: "#ffea00",
      font: { size: 10, weight: "600" },
    },
  };
}

function rateTodChartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    parsing: false,
    interaction: { mode: "nearest", intersect: false, axis: "x" },
    plugins: {
      legend: {
        position: "top",
        align: "start",
        labels: { color: "#8b96a8" },
      },
      annotation: {
        annotations: {
          now: rateTodNowAnnotation(),
        },
      },
      tooltip: {
        backgroundColor: "rgba(23, 28, 38, 0.95)",
        titleColor: "#e6ebf2",
        bodyColor: "#e6ebf2",
        callbacks: {
          title: (items) => {
            const raw = items[0]?.raw;
            return raw ? formatHourOfDayLabel(raw.hour) : "";
          },
          label: (ctx) => {
            const raw = ctx.raw;
            if (!raw) return "";
            return `Avg rate: ${fmtRate(raw.y)}/min`;
          },
          afterLabel: (ctx) => {
            const raw = ctx.raw;
            if (!raw) return "";
            const hoursCovered = raw.weightMin / 60;
            const coverage =
              hoursCovered >= 1
                ? `${hoursCovered.toFixed(1)}h of data`
                : `${Math.round(raw.weightMin)} min of data`;
            return `${coverage} · ${raw.samples} window segment${raw.samples === 1 ? "" : "s"}`;
          },
        },
      },
    },
    scales: {
      x: {
        type: "linear",
        min: 0,
        max: 24,
        title: {
          display: true,
          text: "Time of day",
          color: "#8b96a8",
        },
        ticks: {
          color: "#8b96a8",
          stepSize: 2,
          callback: (value) => {
            if (value < 0 || value > 24 || value % 1 !== 0) return "";
            if (value === 24) return formatHourOfDayLabel(0);
            return formatHourOfDayLabel(value);
          },
        },
        grid: { color: "#2a3345" },
      },
      y: {
        type: "linear",
        min: 0,
        grace: "10%",
        title: {
          display: true,
          text: "Avg depletion rate",
          color: "#8b96a8",
        },
        ticks: {
          color: "#8b96a8",
          callback: (value) => `${fmtRate(value)}/min`,
        },
        grid: { color: "#2a3345" },
      },
    },
  };
}

function rateTodChartDataset(points) {
  return {
    label: "Avg depletion rate",
    data: points,
    showLine: true,
    borderColor: "#4ade80",
    backgroundColor: "rgba(74, 222, 128, 0.85)",
    pointRadius: 4,
    pointHoverRadius: 6,
    borderWidth: 2,
    tension: 0.2,
    spanGaps: false,
  };
}

/** Move the NOW line without rebuilding rate buckets. */
function patchRateTodNowMarker() {
  const chart = rateTodChartUi.chart;
  const ann = chart?.options?.plugins?.annotation?.annotations?.now;
  if (!ann) return;
  const x = rateTodNowX();
  if (ann.xMin === x && ann.xMax === x) return;
  ann.xMin = x;
  ann.xMax = x;
  chart.update("none");
}

/** Build or update the rate-by-hour chart. No-op unless that view is active. */
function syncRateTodChart() {
  if (typeof isItemChartView === "function" && !isItemChartView("rate-tod")) return;
  if (!rateTodChartEl.canvas || !rateTodChartEl.wrap) return;

  const points = getRateTodChartPoints();
  const hasPoints = points.length > 0;
  rateTodChartEl.empty?.classList.toggle("hidden", hasPoints);
  rateTodChartEl.canvas.classList.toggle("hidden", !hasPoints);

  if (!hasPoints) {
    destroyRateTodChart();
    return;
  }

  const options = rateTodChartOptions();
  const dataset = rateTodChartDataset(points);

  if (rateTodChartUi.chart) {
    rateTodChartUi.chart.data.datasets = [dataset];
    rateTodChartUi.chart.options = options;
    rateTodChartUi.chart.update("none");
    rateTodChartUi.chart.resize();
    return;
  }

  destroyRateTodChart();
  rateTodChartUi.chart = new Chart(rateTodChartEl.canvas, {
    type: "scatter",
    data: { datasets: [dataset] },
    options,
  });
}
