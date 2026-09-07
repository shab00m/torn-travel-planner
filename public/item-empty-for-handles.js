// Range-band handles for the empty-for chart. Sit outside the plot so they
// do not start offset/scale pan. Dragging writes min/max empty-for (seconds).
const emptyForRangeHandleUi = {
  drag: null,
};

const emptyForRangeHandleEl = {
  min: document.getElementById("empty-for-range-handle-min"),
  max: document.getElementById("empty-for-range-handle-max"),
  minWrap: document.getElementById("empty-for-range-handle-min-wrap"),
  maxWrap: document.getElementById("empty-for-range-handle-max-wrap"),
  minValue: document.getElementById("empty-for-range-handle-min-value"),
  maxValue: document.getElementById("empty-for-range-handle-max-value"),
};

function emptyForRangeHandleParts(side) {
  return side === "min"
    ? {
        handle: emptyForRangeHandleEl.min,
        wrap: emptyForRangeHandleEl.minWrap,
        value: emptyForRangeHandleEl.minValue,
      }
    : {
        handle: emptyForRangeHandleEl.max,
        wrap: emptyForRangeHandleEl.maxWrap,
        value: emptyForRangeHandleEl.maxValue,
      };
}

function canEditEmptyForRangeHandles() {
  return typeof isAdminUser === "function" && isAdminUser();
}

function emptyForRangeHandleBounds() {
  return emptyForRangeHandleUi.drag?.bounds ?? currentEmptyForChartBounds();
}

function applyEmptyForRangeDraft(bounds) {
  if (typeof setEmptyForBoundInputValues === "function") {
    setEmptyForBoundInputValues(bounds);
  }
  const chart = emptyForChartUi.chart;
  if (chart) {
    chart.options.plugins.annotation.annotations = emptyForRangeAnnotations(
      emptyForChartUi.axesSwapped,
      bounds.minEmptyFor,
      bounds.maxEmptyFor
    );
    chart.update("none");
  }
  syncEmptyForRangeHandles();
}

function emptyForDurationAtPointer(clientX, clientY, chart, swapped) {
  const pos = chartClientPoint(clientX, clientY, chart);
  const scale = swapped ? chart.scales.y : chart.scales.x;
  const pixel = swapped ? pos.y : pos.x;
  const raw = scale.getValueForPixel(pixel);
  if (!Number.isFinite(raw)) throw new Error("empty-for handle is off the duration scale");
  const lo = Math.min(scale.min, scale.max);
  const hi = Math.max(scale.min, scale.max);
  return Math.max(0, Math.round(Math.min(hi, Math.max(lo, raw))));
}

function clampEmptyForHandleSec(field, sec, bounds) {
  if (field === "minEmptyFor" && bounds.maxEmptyFor != null) {
    return Math.min(sec, bounds.maxEmptyFor);
  }
  if (field === "maxEmptyFor" && bounds.minEmptyFor != null) {
    return Math.max(sec, bounds.minEmptyFor);
  }
  return sec;
}

function positionEmptyForRangeHandle(side, sec, chart, swapped, chartWrap) {
  const { handle, wrap, value } = emptyForRangeHandleParts(side);
  if (!handle || !wrap) return;
  if (sec == null || !chart?.chartArea || !chartWrap) {
    wrap.classList.add("hidden");
    return;
  }
  const scale = swapped ? chart.scales.y : chart.scales.x;
  const pixel = scale.getPixelForValue(sec);
  const { left, right, top, bottom } = chart.chartArea;
  const inView = swapped ? pixel >= top && pixel <= bottom : pixel >= left && pixel <= right;
  if (!Number.isFinite(pixel) || !inView) {
    wrap.classList.add("hidden");
    return;
  }
  const wrapRect = chartWrap.getBoundingClientRect();
  const canvasRect = chart.canvas.getBoundingClientRect();
  const ox = canvasRect.left - wrapRect.left;
  const oy = canvasRect.top - wrapRect.top;
  wrap.classList.remove("hidden");
  if (swapped) {
    wrap.style.left = `${ox + right}px`;
    wrap.style.top = `${oy + pixel}px`;
  } else {
    wrap.style.left = `${ox + pixel}px`;
    wrap.style.top = `${oy + top}px`;
  }
  const format = window.EmptyForBounds?.formatEmptyForHms;
  const text = format ? format(sec) : "";
  if (value) value.textContent = text;
  handle.title = text ? `${fieldTitleForHandle(handle)}: ${text}` : fieldTitleForHandle(handle);
}

function fieldTitleForHandle(handle) {
  return handle === emptyForRangeHandleEl.min ? "Min empty for" : "Max empty for";
}

function syncEmptyForRangeHandles() {
  const chartWrap = emptyForChartEl.wrap;
  const chart = emptyForChartUi.chart;
  const onEmptyFor = typeof isItemChartView === "function" && isItemChartView("empty-for");
  const bounds = emptyForRangeHandleBounds();
  if (!onEmptyFor || !chart || !chartWrap || !canEditEmptyForRangeHandles()) {
    emptyForRangeHandleEl.minWrap?.classList.add("hidden");
    emptyForRangeHandleEl.maxWrap?.classList.add("hidden");
    return;
  }
  const swapped = emptyForChartUi.axesSwapped;
  positionEmptyForRangeHandle("min", bounds.minEmptyFor, chart, swapped, chartWrap);
  positionEmptyForRangeHandle("max", bounds.maxEmptyFor, chart, swapped, chartWrap);
}

function endEmptyForRangeHandleDrag() {
  const drag = emptyForRangeHandleUi.drag;
  emptyForRangeHandleUi.drag = null;
  emptyForRangeHandleEl.min?.classList.remove("is-dragging");
  emptyForRangeHandleEl.max?.classList.remove("is-dragging");
  return drag;
}

function startEmptyForRangeHandleDrag(field, handle, event) {
  if (!canEditEmptyForRangeHandles()) return;
  const chart = emptyForChartUi.chart;
  if (!chart?.chartArea) return;
  const bounds = { ...currentEmptyForChartBounds() };
  if (bounds[field] == null) return;
  event.preventDefault();
  event.stopPropagation();
  handle.setPointerCapture(event.pointerId);
  handle.classList.add("is-dragging");
  emptyForRangeHandleUi.drag = { field, bounds, pointerId: event.pointerId };
}

function moveEmptyForRangeHandleDrag(event) {
  const drag = emptyForRangeHandleUi.drag;
  const chart = emptyForChartUi.chart;
  if (!drag || !chart) return;
  const swapped = emptyForChartUi.axesSwapped;
  const sec = clampEmptyForHandleSec(
    drag.field,
    emptyForDurationAtPointer(event.clientX, event.clientY, chart, swapped),
    drag.bounds
  );
  drag.bounds = { ...drag.bounds, [drag.field]: sec };
  applyEmptyForRangeDraft(drag.bounds);
}

async function finishEmptyForRangeHandleDrag(event) {
  const drag = endEmptyForRangeHandleDrag();
  if (!drag) return;
  if (event?.currentTarget?.hasPointerCapture?.(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const saved = currentEmptyForChartBounds();
  if (saved.minEmptyFor === drag.bounds.minEmptyFor && saved.maxEmptyFor === drag.bounds.maxEmptyFor) {
    applyEmptyForRangeDraft(saved);
    return;
  }
  if (typeof persistEmptyForBounds !== "function") {
    throw new Error("persistEmptyForBounds is not available");
  }
  await persistEmptyForBounds(drag.bounds);
}

function bindEmptyForRangeHandle(handle, field) {
  if (!handle) return;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button != null && event.button !== 0) return;
    startEmptyForRangeHandleDrag(field, handle, event);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!emptyForRangeHandleUi.drag || emptyForRangeHandleUi.drag.pointerId !== event.pointerId) return;
    moveEmptyForRangeHandleDrag(event);
  });
  handle.addEventListener("pointerup", (event) => {
    if (!emptyForRangeHandleUi.drag || emptyForRangeHandleUi.drag.pointerId !== event.pointerId) return;
    finishEmptyForRangeHandleDrag(event);
  });
  handle.addEventListener("pointercancel", (event) => {
    if (!emptyForRangeHandleUi.drag || emptyForRangeHandleUi.drag.pointerId !== event.pointerId) return;
    const drag = endEmptyForRangeHandleDrag();
    if (drag) applyEmptyForRangeDraft(currentEmptyForChartBounds());
  });
}

function initEmptyForRangeHandles() {
  bindEmptyForRangeHandle(emptyForRangeHandleEl.min, "minEmptyFor");
  bindEmptyForRangeHandle(emptyForRangeHandleEl.max, "maxEmptyFor");
}

initEmptyForRangeHandles();
