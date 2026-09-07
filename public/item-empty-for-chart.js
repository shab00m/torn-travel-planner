// Lazy empty-for scatter chart on the item stock page (built only when toggled).
const emptyForChartUi = {
  chart: null,
  axesSwapped: false,
  showExcluded: loadPrefs().emptyForShowExcluded !== false,
  offsetSec: 0,
  scale: null,
  timeline: null,
  skipNextClick: false,
};

const emptyForChartPan = {
  active: null,
};

const emptyForChartEl = {
  swapAxes: document.getElementById("empty-for-swap-axes"),
  showExcluded: document.getElementById("empty-for-show-excluded"),
  offset: document.getElementById("empty-for-chart-offset"),
  scale: document.getElementById("empty-for-chart-scale"),
  wrap: document.getElementById("empty-for-chart-wrap"),
  canvas: document.getElementById("empty-for-chart"),
  empty: document.getElementById("empty-for-chart-empty"),
};

const EMPTY_FOR_INCLUDED_COLOR = "#f0a36b";
const EMPTY_FOR_EXCLUDED_FILL = "rgba(139, 150, 168, 0.28)";
const EMPTY_FOR_EXCLUDED_BORDER = "rgba(139, 150, 168, 0.4)";
const EMPTY_FOR_RANGE_FILL = "rgba(79, 156, 249, 0.10)";
const EMPTY_FOR_RANGE_BORDER = "rgba(79, 156, 249, 0.45)";

function emptyForChartRowToPoint(r, swapped) {
  const timeMs = r.restocked_ts * 1000;
  return {
    x: swapped ? timeMs : r.emptyForSec,
    y: swapped ? r.emptyForSec : timeMs,
    depleted_ts: r.depleted_ts,
    adjusted_depleted_ts: r.adjusted_depleted_ts ?? r.effective_depleted_ts ?? r.depleted_ts,
    restocked_ts: r.restocked_ts,
    emptyForSec: r.emptyForSec,
    ignored: Boolean(r.ignored),
  };
}

function sortEmptyForChartPoints(a, b) {
  // parsing:false makes Chart.js update only an X-sorted slice. Sort by the
  // index-axis value (x), not restock time — leftover from when X was dates.
  const byIndex = a.x - b.x;
  return byIndex || a.restocked_ts - b.restocked_ts;
}

function getEmptyForChartData() {
  const swapped = emptyForChartUi.axesSwapped;
  const rows = getCycleHistoryRows({ includeIgnored: true }).filter(
    (r) => r.emptyForSec != null && r.emptyForSec >= 0 && r.restocked_ts != null
  );
  return {
    included: rows.filter((r) => !r.ignored).map((r) => emptyForChartRowToPoint(r, swapped)).sort(sortEmptyForChartPoints),
    excluded: rows.filter((r) => r.ignored).map((r) => emptyForChartRowToPoint(r, swapped)).sort(sortEmptyForChartPoints),
  };
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

function emptyForDurationScale(view) {
  return {
    type: "linear",
    min: Math.max(0, view.min),
    max: view.max,
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

function emptyForDurationTimeline(valuesSec) {
  return { xMin: Math.min(...valuesSec) * 1000, xMax: Math.max(...valuesSec) * 1000 };
}

function syncEmptyForViewInputs(timeline) {
  if (emptyForChartEl.offset) {
    const maxOffset = timeline ? getMaxChartOffsetSec(timeline, emptyForChartUi.scale) : 0;
    emptyForChartEl.offset.value = String(Math.round(emptyForChartUi.offsetSec));
    emptyForChartEl.offset.disabled = maxOffset <= 0;
    emptyForChartEl.offset.max = String(Math.round(maxOffset));
  }
  if (emptyForChartEl.scale) {
    const minScale = timeline ? getMinChartScale(timeline) : 1;
    const maxScale = timeline ? getMaxChartScale(timeline) : 1;
    emptyForChartEl.scale.value = emptyForChartUi.scale.toFixed(CHART_SCALE_INPUT_DECIMALS);
    emptyForChartEl.scale.disabled = maxScale <= minScale * 1.001;
    emptyForChartEl.scale.min = minScale.toFixed(CHART_SCALE_INPUT_DECIMALS);
    emptyForChartEl.scale.max = maxScale.toFixed(CHART_SCALE_INPUT_DECIMALS);
  }
}

function applyEmptyForViewport(durationValuesSec) {
  const timeline = emptyForDurationTimeline(durationValuesSec);
  if (emptyForChartUi.scale == null) {
    emptyForChartUi.scale = 1;
    emptyForChartUi.offsetSec = 0;
  }
  const { visMin, visMax, offsetSec, scale } = getVisibleChartRange(
    timeline,
    emptyForChartUi.offsetSec,
    emptyForChartUi.scale
  );
  emptyForChartUi.timeline = timeline;
  emptyForChartUi.offsetSec = offsetSec;
  emptyForChartUi.scale = scale;
  syncEmptyForViewInputs(timeline);
  syncEmptyForChartInteraction(timeline);
  return { visMin, visMax };
}

function syncEmptyForChartInteraction(timeline) {
  const adjustable = Boolean(timeline && canAdjustChartView(timeline, emptyForChartUi.scale));
  emptyForChartEl.wrap?.classList.toggle("can-pan", adjustable);
  if (!adjustable) endEmptyForChartPan();
}

function endEmptyForChartPan() {
  emptyForChartPan.active = null;
  emptyForChartEl.wrap?.classList.remove("is-panning");
}

function emptyForOffsetForScaleAtCenter(timeline, nextScale) {
  const { visMin, visMax } = getVisibleChartRange(
    timeline,
    emptyForChartUi.offsetSec,
    emptyForChartUi.scale
  );
  const anchorTimeMs = (visMin + visMax) / 2;
  return offsetSecForZoomPivot(timeline, nextScale, anchorTimeMs, 0.5);
}

function emptyForDisplayDurationRange(visMinMs, visMaxMs) {
  const span = Math.max(visMaxMs - visMinMs, 60_000);
  const pad = Math.max(span * 0.03, 10 * 60 * 1000);
  return { min: visMinMs - pad, max: visMaxMs + pad };
}

function emptyForTimeScale(valuesMs) {
  const min = Math.min(...valuesMs);
  const max = Math.max(...valuesMs);
  const pad = Math.max((max - min) * 0.03, 60_000);
  const yMin = min - pad;
  const yMax = max + pad;
  const spanMs = Math.max(yMax - yMin, 60_000);
  const timeUnit = emptyForChartTimeUnit(spanMs);
  return {
    type: "time",
    min: yMin,
    max: yMax,
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

function currentEmptyForChartBounds() {
  if (!state.item) return { minEmptyFor: null, maxEmptyFor: null };
  return getEmptyForBounds(state.item.country, state.item.itemId);
}

function emptyForRangeAnnotations(swapped, minSec, maxSec) {
  if (minSec == null && maxSec == null) return {};
  const box = {
    type: "box",
    backgroundColor: EMPTY_FOR_RANGE_FILL,
    borderColor: EMPTY_FOR_RANGE_BORDER,
    borderWidth: 1,
    label: {
      display: true,
      content: "Range",
      color: "#8b96a8",
      font: { size: 11, weight: "600" },
      position: swapped ? { x: "start", y: "center" } : { x: "center", y: "start" },
    },
  };
  if (swapped) {
    if (minSec != null) box.yMin = minSec;
    if (maxSec != null) box.yMax = maxSec;
  } else {
    if (minSec != null) box.xMin = minSec;
    if (maxSec != null) box.xMax = maxSec;
  }
  return { emptyForRange: box };
}

function emptyForChartOptions(points, bounds) {
  const timeValues = points.map((p) => p.restocked_ts * 1000);
  const durationValues = points.map((p) => p.emptyForSec);
  if (bounds.minEmptyFor != null) durationValues.push(bounds.minEmptyFor);
  if (bounds.maxEmptyFor != null) durationValues.push(bounds.maxEmptyFor);
  const { visMin, visMax } = applyEmptyForViewport(durationValues);
  const display = emptyForDisplayDurationRange(visMin, visMax);
  const durationScale = emptyForDurationScale({
    min: display.min / 1000,
    max: display.max / 1000,
  });
  const timeScale = emptyForTimeScale(timeValues);
  const swapped = emptyForChartUi.axesSwapped;

  return {
    responsive: true,
    maintainAspectRatio: false,
    parsing: false,
    interaction: { mode: "nearest", intersect: true },
    onHover(event, elements) {
      const canvas = event.native?.target;
      if (!canvas?.style) return;
      if (elements.length) canvas.style.cursor = "pointer";
      else if (emptyForChartEl.wrap?.classList.contains("can-pan")) canvas.style.cursor = "grab";
      else canvas.style.cursor = "default";
    },
    onClick(_event, elements, chart) {
      if (emptyForChartUi.skipNextClick) {
        emptyForChartUi.skipNextClick = false;
        return;
      }
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
      annotation: {
        annotations: emptyForRangeAnnotations(swapped, bounds.minEmptyFor, bounds.maxEmptyFor),
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
            const excluded = raw.ignored ? " (excluded)" : "";
            return `Empty for: ${fmtDurationDetailed(raw.emptyForSec)}${excluded}`;
          },
          afterLabel: (ctx) => {
            const raw = ctx.raw;
            if (!raw) return "";
            const adj = raw.adjusted_depleted_ts;
            if (adj != null && adj !== raw.depleted_ts) {
              return [
                `Depleted: ${fmtTime(raw.depleted_ts)}`,
                `Adj. depleted: ${fmtTime(adj)}`,
              ];
            }
            return `Depleted: ${fmtTime(raw.depleted_ts)}`;
          },
        },
      },
    },
    scales: {
      x: swapped ? timeScale : durationScale,
      y: swapped ? durationScale : timeScale,
    },
    onResize() {
      if (typeof syncEmptyForRangeHandles === "function") syncEmptyForRangeHandles();
    },
  };
}

function emptyForChartDataset(points, { excluded = false } = {}) {
  return {
    label: excluded ? "Excluded" : "Empty for",
    data: points,
    showLine: false,
    borderColor: excluded ? EMPTY_FOR_EXCLUDED_BORDER : EMPTY_FOR_INCLUDED_COLOR,
    backgroundColor: excluded ? EMPTY_FOR_EXCLUDED_FILL : "rgba(240, 163, 107, 0.85)",
    pointRadius: points.length > 200 ? 2 : 4,
    pointHoverRadius: 6,
    pointHitRadius: 8,
    borderWidth: 1.5,
    tension: 0,
  };
}

function syncEmptyForChartOptions() {
  const onEmptyFor = typeof isItemChartView === "function" && isItemChartView("empty-for");
  emptyForChartEl.wrap?.classList.toggle("axes-swapped", Boolean(emptyForChartUi.axesSwapped));
  if (!onEmptyFor) return;
  emptyForChartEl.swapAxes?.classList.toggle("active", emptyForChartUi.axesSwapped);
  emptyForChartEl.swapAxes?.setAttribute(
    "aria-pressed",
    emptyForChartUi.axesSwapped ? "true" : "false"
  );
  if (emptyForChartEl.showExcluded) {
    emptyForChartEl.showExcluded.checked = emptyForChartUi.showExcluded;
  }
}

function afterEmptyForChartSync() {
  if (typeof syncEmptyForRangeHandles === "function") syncEmptyForRangeHandles();
}

/** Build or update the empty-for chart. No-op unless that view is active. */
function syncEmptyForChart() {
  syncEmptyForChartOptions();
  if (typeof isItemChartView === "function" && !isItemChartView("empty-for")) {
    afterEmptyForChartSync();
    return;
  }
  if (!emptyForChartEl.canvas || !emptyForChartEl.wrap) {
    afterEmptyForChartSync();
    return;
  }

  const { included, excluded } = getEmptyForChartData();
  const visibleExcluded = emptyForChartUi.showExcluded ? excluded : [];
  const points = included.concat(visibleExcluded);
  const hasPoints = points.length > 0;
  emptyForChartEl.empty?.classList.toggle("hidden", hasPoints);
  emptyForChartEl.canvas.classList.toggle("hidden", !hasPoints);

  if (!hasPoints) {
    destroyEmptyForChart();
    emptyForChartUi.timeline = null;
    if (emptyForChartEl.offset) emptyForChartEl.offset.disabled = true;
    if (emptyForChartEl.scale) emptyForChartEl.scale.disabled = true;
    syncEmptyForChartInteraction(null);
    afterEmptyForChartSync();
    return;
  }

  const bounds = currentEmptyForChartBounds();
  const options = emptyForChartOptions(points, bounds);
  const datasets = [emptyForChartDataset(included)];
  if (visibleExcluded.length) datasets.push(emptyForChartDataset(visibleExcluded, { excluded: true }));

  if (emptyForChartUi.chart) {
    emptyForChartUi.chart.data.datasets = datasets;
    emptyForChartUi.chart.options = options;
    emptyForChartUi.chart.update("none");
    emptyForChartUi.chart.resize();
    afterEmptyForChartSync();
    return;
  }

  destroyEmptyForChart();
  emptyForChartUi.chart = new Chart(emptyForChartEl.canvas, {
    type: "scatter",
    data: { datasets },
    options,
  });
  afterEmptyForChartSync();
}

function setEmptyForAxesSwapped(swapped) {
  emptyForChartUi.axesSwapped = Boolean(swapped);
  // Scale types change (linear ↔ time); recreate instead of updating in place.
  destroyEmptyForChart();
  syncEmptyForChart();
}

function setEmptyForShowExcluded(show) {
  emptyForChartUi.showExcluded = Boolean(show);
  savePrefs({ emptyForShowExcluded: emptyForChartUi.showExcluded });
  destroyEmptyForChart();
  syncEmptyForChart();
}

function initEmptyForChartOptions() {
  emptyForChartEl.swapAxes?.addEventListener("click", () => {
    setEmptyForAxesSwapped(!emptyForChartUi.axesSwapped);
  });
  emptyForChartEl.showExcluded?.addEventListener("change", () => {
    setEmptyForShowExcluded(emptyForChartEl.showExcluded.checked);
  });
  if (emptyForChartEl.showExcluded) {
    emptyForChartEl.showExcluded.checked = emptyForChartUi.showExcluded;
  }
  emptyForChartEl.offset?.addEventListener("change", () => {
    const timeline = emptyForChartUi.timeline;
    if (!timeline) return;
    const raw = emptyForChartEl.offset.value.trim();
    const offsetSec = raw === "" ? 0 : Number.parseInt(raw, 10);
    if (!Number.isInteger(offsetSec) || offsetSec < 0) {
      syncEmptyForViewInputs(timeline);
      return;
    }
    emptyForChartUi.offsetSec = offsetSec;
    syncEmptyForChart();
  });
  emptyForChartEl.scale?.addEventListener("change", () => {
    const timeline = emptyForChartUi.timeline;
    if (!timeline) return;
    const raw = emptyForChartEl.scale.value.trim();
    const scale = raw === "" ? 1 : Number.parseFloat(raw);
    if (!Number.isFinite(scale) || scale <= 0) {
      syncEmptyForViewInputs(timeline);
      return;
    }
    emptyForChartUi.offsetSec = emptyForOffsetForScaleAtCenter(timeline, scale);
    emptyForChartUi.scale = scale;
    syncEmptyForChart();
  });
}

function emptyForDragChartView(timeline, pan, deltaX, deltaY, currentX, currentY, chart) {
  const { left, right, top, bottom } = chart.chartArea;
  const width = right - left;
  const height = bottom - top;
  if (emptyForChartUi.axesSwapped) {
    // Empty-for is on Y (increases upward). Drag along that axis pans; the other axis zooms.
    return dragChartViewAlongAxes(timeline, pan, {
      panDeltaPx: -deltaY,
      zoomDeltaPx: deltaX,
      cursorPx: top + bottom - currentY,
      panAxisStart: top,
      panAxisLength: height,
      zoomAxisLength: width,
    });
  }
  return dragChartViewAlongAxes(timeline, pan, {
    panDeltaPx: deltaX,
    zoomDeltaPx: deltaY,
    cursorPx: currentX,
    panAxisStart: left,
    panAxisLength: width,
    zoomAxisLength: height,
  });
}

function applyEmptyForChartView(timeline, { offsetSec, scale }) {
  emptyForChartUi.offsetSec = offsetSec;
  emptyForChartUi.scale = scale;
  syncEmptyForChart();
}

function initEmptyForChartPan() {
  const gestures = attachChartViewportGestures({
    canvas: emptyForChartEl.canvas,
    wrap: emptyForChartEl.wrap,
    panState: emptyForChartPan,
    getContext: () => {
      const timeline = emptyForChartUi.timeline;
      const chart = emptyForChartUi.chart;
      if (!timeline || !chart?.chartArea) return null;
      if (!canAdjustChartView(timeline, emptyForChartUi.scale)) return null;
      return {
        chart,
        timeline,
        offsetSec: emptyForChartUi.offsetSec,
        scale: emptyForChartUi.scale,
      };
    },
    applyView: (_ctx, view) => applyEmptyForChartView(emptyForChartUi.timeline, view),
    mouseDragView: emptyForDragChartView,
    panAxisFor: (ctx) =>
      emptyForChartUi.axesSwapped
        ? chartViewportPanAxisYInverted(ctx.chart)
        : chartViewportPanAxisX(ctx.chart),
    onPointerDown: () => {
      emptyForChartUi.skipNextClick = false;
    },
    onGestureActive: () => {
      emptyForChartUi.skipNextClick = true;
    },
  });

  window.addEventListener("blur", gestures.end);
  document.documentElement.addEventListener("mouseleave", (e) => {
    if (!e.relatedTarget) gestures.end();
  });
}

initEmptyForChartOptions();
initEmptyForChartPan();
