// Shared mouse + touch viewport gestures for item charts (offset / scale).
const CHART_PINCH_MIN_DISTANCE_PX = 16;

function chartClientPoint(clientX, clientY, chart) {
  const rect = chart.canvas.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function chartTouchPoints(e, chart) {
  return Array.from(e.touches, (t) => chartClientPoint(t.clientX, t.clientY, chart));
}

function chartPointDistance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function chartPointMid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function chartPointInArea(pos, chart) {
  const { left, right, top, bottom } = chart.chartArea;
  return pos.x >= left && pos.x <= right && pos.y >= top && pos.y <= bottom;
}

function chartViewportPanAxisX(chart) {
  const { left, right } = chart.chartArea;
  return {
    start: left,
    length: right - left,
    deltaPx: (dx) => dx,
    cursorPx: (pos) => pos.x,
  };
}

function chartViewportPanAxisYInverted(chart) {
  const { top, bottom } = chart.chartArea;
  return {
    start: top,
    length: bottom - top,
    deltaPx: (_dx, dy) => -dy,
    cursorPx: (pos) => top + bottom - pos.y,
  };
}

function panChartViewAlongAxis(timeline, gesture, panDeltaPx, panAxisLength) {
  const startSpanSec = getChartViewportSpanSec(timeline, gesture.startScale);
  return {
    offsetSec: gesture.startOffsetSec + pixelDeltaToOffsetSec(panDeltaPx, startSpanSec, panAxisLength),
    scale: gesture.startScale,
  };
}

function pinchChartViewAlongAxis(timeline, gesture, currentDistance, cursorPx, panAxis) {
  const ratio = gesture.startDistance > 0 ? currentDistance / gesture.startDistance : 1;
  const nextScale = clampChartScale(gesture.startScale * ratio, timeline);
  const startSpanSec = getChartViewportSpanSec(timeline, gesture.startScale);
  const cursorFraction = chartAxisFraction(cursorPx, panAxis.start, panAxis.length);
  const startVisMin =
    timeline.xMin + clampChartOffsetSec(gesture.startOffsetSec, timeline, gesture.startScale) * 1000;
  const cursorValueMs = startVisMin + cursorFraction * startSpanSec * 1000;
  return {
    offsetSec: offsetSecForZoomPivot(timeline, nextScale, cursorValueMs, cursorFraction),
    scale: nextScale,
  };
}

function startChartViewportGesture(ctx, extra) {
  return {
    startOffsetSec: ctx.offsetSec,
    startScale: ctx.scale,
    panning: false,
    mode: extra.mode,
    startX: extra.startX ?? 0,
    startY: extra.startY ?? 0,
    currentX: extra.currentX ?? extra.startX ?? 0,
    currentY: extra.currentY ?? extra.startY ?? 0,
    startDistance: extra.startDistance ?? 0,
    ...extra,
  };
}

/**
 * Bind mouse drag (offset + scale) and touch (drag = offset, pinch = scale).
 * @returns {{ end: () => void }}
 */
function attachChartViewportGestures({
  canvas,
  wrap,
  panState,
  getContext,
  applyView,
  mouseDragView,
  panAxisFor,
  onPointerDown,
  onGestureActive,
  onGestureEnd,
}) {
  function end() {
    const shouldPersist = Boolean(panState.active?.panning);
    panState.active = null;
    wrap?.classList.remove("is-panning");
    if (shouldPersist) onGestureEnd?.();
  }

  function markActive(gesture) {
    if (gesture.panning) return;
    gesture.panning = true;
    wrap?.classList.add("is-panning");
    onGestureActive?.();
  }

  function applyFromMouse(ctx, gesture, pos) {
    gesture.currentX = pos.x;
    gesture.currentY = pos.y;
    const deltaX = pos.x - gesture.startX;
    const deltaY = pos.y - gesture.startY;
    if (!gesture.panning) {
      if (
        Math.abs(deltaX) <= CHART_PAN_DRAG_THRESHOLD_PX &&
        Math.abs(deltaY) <= CHART_PAN_DRAG_THRESHOLD_PX
      ) {
        return;
      }
      markActive(gesture);
    }
    applyView(ctx, mouseDragView(ctx.timeline, gesture, deltaX, deltaY, pos.x, pos.y, ctx.chart));
  }

  function applyFromTouches(ctx, gesture, points) {
    const panAxis = panAxisFor(ctx);
    if (points.length >= 2 && gesture.mode === "pinch") {
      markActive(gesture);
      const mid = chartPointMid(points[0], points[1]);
      applyView(
        ctx,
        pinchChartViewAlongAxis(
          ctx.timeline,
          gesture,
          chartPointDistance(points[0], points[1]),
          panAxis.cursorPx(mid),
          panAxis
        )
      );
      return;
    }
    if (points.length !== 1 || gesture.mode !== "pan") return;
    const pos = points[0];
    const deltaX = pos.x - gesture.startX;
    const deltaY = pos.y - gesture.startY;
    if (!gesture.panning) {
      if (
        Math.abs(deltaX) <= CHART_PAN_DRAG_THRESHOLD_PX &&
        Math.abs(deltaY) <= CHART_PAN_DRAG_THRESHOLD_PX
      ) {
        return;
      }
      markActive(gesture);
    }
    applyView(
      ctx,
      panChartViewAlongAxis(ctx.timeline, gesture, panAxis.deltaPx(deltaX, deltaY), panAxis.length)
    );
  }

  function beginTouchGesture(ctx, points) {
    if (points.length >= 2) {
      const dist = chartPointDistance(points[0], points[1]);
      if (dist < CHART_PINCH_MIN_DISTANCE_PX) return;
      const mid = chartPointMid(points[0], points[1]);
      panState.active = startChartViewportGesture(ctx, {
        mode: "pinch",
        startDistance: dist,
        startX: mid.x,
        startY: mid.y,
        currentX: mid.x,
        currentY: mid.y,
      });
      markActive(panState.active);
      return;
    }
    const pos = points[0];
    if (panState.active?.mode !== "pinch" && !chartPointInArea(pos, ctx.chart)) return;
    panState.active = startChartViewportGesture(ctx, {
      mode: "pan",
      startX: pos.x,
      startY: pos.y,
      currentX: pos.x,
      currentY: pos.y,
    });
  }

  canvas?.addEventListener("mousedown", (e) => {
    const ctx = getContext();
    if (!ctx) return;
    const pos = chartClientPoint(e.clientX, e.clientY, ctx.chart);
    if (!chartPointInArea(pos, ctx.chart)) return;
    onPointerDown?.();
    panState.active = startChartViewportGesture(ctx, {
      mode: "mouse",
      startX: pos.x,
      startY: pos.y,
      currentX: pos.x,
      currentY: pos.y,
    });
  });

  window.addEventListener("mousemove", (e) => {
    if (isMouseButtonReleased(e)) {
      if (panState.active?.mode === "mouse") end();
      return;
    }
    const gesture = panState.active;
    if (!gesture || gesture.mode !== "mouse") return;
    const ctx = getContext();
    if (!ctx) return;
    applyFromMouse(ctx, gesture, chartClientPoint(e.clientX, e.clientY, ctx.chart));
  });

  document.addEventListener("mouseup", end);

  canvas?.addEventListener(
    "touchstart",
    (e) => {
      const ctx = getContext();
      if (!ctx) return;
      const points = chartTouchPoints(e, ctx.chart);
      if (e.touches.length >= 2) e.preventDefault();
      onPointerDown?.();
      beginTouchGesture(ctx, points);
    },
    { passive: false }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      const gesture = panState.active;
      if (!gesture || gesture.mode === "mouse") return;
      const ctx = getContext();
      if (!ctx) return;
      e.preventDefault();
      const points = chartTouchPoints(e, ctx.chart);
      if (e.touches.length >= 2 && gesture.mode !== "pinch") {
        beginTouchGesture(ctx, points);
      }
      applyFromTouches(ctx, panState.active, points);
    },
    { passive: false }
  );

  document.addEventListener("touchend", (e) => {
    const gesture = panState.active;
    if (!gesture || gesture.mode === "mouse") return;
    const ctx = getContext();
    if (!ctx || e.touches.length === 0) {
      end();
      return;
    }
    beginTouchGesture(ctx, chartTouchPoints(e, ctx.chart));
  });
  document.addEventListener("touchcancel", () => {
    if (panState.active?.mode !== "mouse") end();
  });

  return { end };
}

let stockChartGestures = null;

function endStockChartGestures() {
  stockChartGestures?.end();
}

function initStockChartGestures() {
  stockChartGestures = attachChartViewportGestures({
    canvas: el.chartCanvas,
    wrap: el.chartWrap,
    panState: chartPan,
    getContext: () => {
      const timeline = state.lastTimeline;
      const chart = state.chart;
      if (!timeline || !chart?.chartArea) return null;
      if (!canAdjustChartView(timeline) || snapshotInspector.enabled) return null;
      return {
        chart,
        timeline,
        offsetSec: state.chartOffsetSec,
        scale: state.chartScale,
      };
    },
    applyView: (ctx, view) => applyChartView(ctx.timeline, view),
    mouseDragView: (timeline, pan, deltaX, deltaY, currentX, _currentY, chart) =>
      dragChartView(timeline, pan, deltaX, deltaY, currentX, chart),
    panAxisFor: (ctx) => chartViewportPanAxisX(ctx.chart),
    onGestureEnd: () => saveCurrentItemSettings(),
  });
}

initStockChartGestures();
