import { getRestocks, getDepletionRates, getHistory, getRestockAmount as getStoredRestockAmount } from "./db.js";
import { getFlightSeconds } from "./flight-times.js";

const FLIGHT_TIME_VARIANCE = 0.03;

function flightSecWithVariance(flightSec, kind) {
  if (kind === "fast") return Math.round(flightSec * (1 - FLIGHT_TIME_VARIANCE));
  return Math.round(flightSec * (1 + FLIGHT_TIME_VARIANCE));
}

function buildLastZeroLookup(chartPoints) {
  if (!chartPoints.length) return null;
  const prefixLastZero = new Array(chartPoints.length);
  let lastZero = null;
  for (let i = 0; i < chartPoints.length; i++) {
    if (chartPoints[i].quantity === 0) lastZero = chartPoints[i].yata_ts;
    prefixLastZero[i] = lastZero;
  }
  return { points: chartPoints, prefixLastZero };
}

function lastZeroBeforeRestock(lookup, restockedTs, depletedTs) {
  if (!lookup) return depletedTs ?? null;
  const { points, prefixLastZero } = lookup;
  let lo = 0;
  let hi = points.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].yata_ts < restockedTs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return depletedTs ?? null;
  return prefixLastZero[idx] ?? depletedTs ?? null;
}

function adjustRestockTime(lookup, restockedTs, observedQty, ratePerMin, restockAmount, depletedTs) {
  if (!restockAmount || !ratePerMin || ratePerMin <= 0 || !observedQty) return restockedTs;
  if (observedQty >= restockAmount) return restockedTs;
  const adjustSec = ((restockAmount - observedQty) / ratePerMin) * 60;
  let adjusted = Math.round(restockedTs - adjustSec);
  const lastZero = lastZeroBeforeRestock(lookup, restockedTs, depletedTs);
  if (lastZero != null) adjusted = Math.max(adjusted, lastZero + 1);
  return adjusted;
}

function createContext({
  restocks,
  rates,
  chartPoints,
  restockAmount,
  avgSamples,
  avgRateSamples,
  stockoutTiming,
  rateTiming,
  safeWindowUseRateSelection,
  currentQty,
  currentPollTs,
  wallTs,
}) {
  const lastZeroLookup = buildLastZeroLookup(chartPoints);

  function rateWindowForRestock(restockedTs) {
    return rates.find((w) => w.start_ts === restockedTs);
  }

  function isRateWindowIgnored(startTs) {
    const restock = restocks.find((r) => r.restocked_ts === startTs);
    return Boolean(restock?.ignored);
  }

  function adjustedRestockRecord(r) {
    if (!restockAmount || r.restocked_ts == null) {
      return { ...r, adjusted_restocked_ts: r.restocked_ts, adjusted_duration: r.duration };
    }
    const window = rateWindowForRestock(r.restocked_ts);
    if (!window) {
      return { ...r, adjusted_restocked_ts: r.restocked_ts, adjusted_duration: r.duration };
    }
    const adjustedTs = adjustRestockTime(
      lastZeroLookup,
      r.restocked_ts,
      window.start_qty,
      window.rate,
      restockAmount,
      r.depleted_ts
    );
    return {
      ...r,
      adjusted_restocked_ts: adjustedTs,
      adjusted_duration: adjustedTs - r.depleted_ts,
    };
  }

  function rateFromWindowEndpoints(startTs, endTs, startQty, endQty) {
    const minutes = (endTs - startTs) / 60;
    if (minutes <= 0) return null;
    const rate = (startQty - endQty) / minutes;
    return rate > 0 ? rate : null;
  }

  function adjustedRateWindow(w) {
    if (!restockAmount || w.start_qty >= restockAmount) return w;
    const restock = restocks.find((r) => r.restocked_ts === w.start_ts);
    const startTs = adjustRestockTime(
      lastZeroLookup,
      w.start_ts,
      w.start_qty,
      w.rate,
      restockAmount,
      restock?.depleted_ts
    );
    const rate = rateFromWindowEndpoints(startTs, w.end_ts, restockAmount, w.end_qty) ?? w.rate;
    return { ...w, start_ts: startTs, start_qty: restockAmount, rate };
  }

  function getAdjustedCompletedRestocks() {
    return restocks.filter((r) => r.duration != null).map(adjustedRestockRecord);
  }

  function getUsableCompletedRestocks() {
    return getAdjustedCompletedRestocks().filter((r) => !r.ignored);
  }

  function getAdjustedRates() {
    return rates.map(adjustedRateWindow);
  }

  function getUsableRates() {
    // Filter on raw start_ts before adjustment — adjusted timestamps no longer match restocks.
    return rates.filter((w) => !isRateWindowIgnored(w.start_ts)).map(adjustedRateWindow);
  }

  function getHistoricalExtents() {
    const completed = getUsableCompletedRestocks();
    const durations = completed
      .map((r) => r.adjusted_duration)
      .filter((d) => d != null && d > 0);
    const usableRates = getUsableRates()
      .map((w) => w.rate)
      .filter((r) => r != null && r > 0);
    return {
      minEmptyFor: durations.length ? Math.min(...durations) : null,
      maxEmptyFor: durations.length ? Math.max(...durations) : null,
      minRate: usableRates.length ? Math.min(...usableRates) : null,
      maxRate: usableRates.length ? Math.max(...usableRates) : null,
    };
  }

  function rateFromHistory() {
    const windows = getUsableRates();
    const rateValues = windows.map((w) => w.rate).filter((r) => r != null && r > 0);
    if (!rateValues.length) return null;
    if (rateTiming === "min") return Math.min(...rateValues);
    if (rateTiming === "max") return Math.max(...rateValues);
    const sample = windows.slice(0, avgRateSamples);
    if (!sample.length) return null;
    return sample.reduce((sum, w) => sum + w.rate, 0) / sample.length;
  }

  function getOpenRateWindow() {
    const raw = rates.find((w) => w.open);
    if (!raw || isRateWindowIgnored(raw.start_ts)) return null;
    return adjustedRateWindow(raw);
  }

  function getCurrentRestockRate(qty = currentQty, refTs = currentPollTs) {
    const w = getOpenRateWindow();
    if (!w) return null;
    if (qty == null || refTs == null || qty <= 0) return null;
    return rateFromWindowEndpoints(w.start_ts, refTs, w.start_qty, qty) ?? (w.rate > 0 ? w.rate : null);
  }

  function depletionRateForCycle(t, startTs, startQty, avgRate) {
    if (startQty > 0 && t === startTs) {
      // Continue the current open cycle at its observed rate — not the historical average.
      const w = getOpenRateWindow();
      if (w?.rate > 0) return w.rate;
      return getCurrentRestockRate(startQty, startTs) ?? avgRate;
    }
    return avgRate;
  }

  function stockoutSecFromHistory() {
    const completed = getUsableCompletedRestocks();
    if (!completed.length) return null;
    if (stockoutTiming === "min") {
      const durations = completed.map((r) => r.adjusted_duration).filter((d) => d != null && d > 0);
      return durations.length ? Math.min(...durations) : null;
    }
    if (stockoutTiming === "max") {
      const durations = completed.map((r) => r.adjusted_duration).filter((d) => d != null && d > 0);
      return durations.length ? Math.max(...durations) : null;
    }
    const sample = completed.slice(0, avgSamples);
    if (!sample.length) return null;
    return sample.reduce((sum, r) => sum + r.adjusted_duration, 0) / sample.length;
  }

  /** When the selected empty-for already elapsed, step up to the next historical duration after now. */
  function openCycleRestockSec(depletedTs, selectedRestockSec, nowTs) {
    if (depletedTs == null || nowTs == null) return selectedRestockSec;
    if (depletedTs + selectedRestockSec > nowTs) return selectedRestockSec;

    const durations = getUsableCompletedRestocks()
      .map((r) => r.adjusted_duration)
      .filter((d) => d != null && d > 0);
    const next = [...new Set(durations)]
      .sort((a, b) => a - b)
      .find((d) => depletedTs + d > nowTs);
    return next ?? selectedRestockSec;
  }

  function getAverages() {
    const restockSec = stockoutSecFromHistory();
    const rate = rateFromHistory();
    if (restockSec == null || rate == null) return null;
    const qtySample = getUsableRates().slice(0, avgRateSamples);
    const qtySource = qtySample.length ? qtySample : getUsableRates();
    return {
      restockSec,
      rate,
      restockQty:
        restockAmount ??
        Math.round(qtySource.reduce((sum, w) => sum + w.start_qty, 0) / qtySource.length),
    };
  }

  function simulatePredictions(startTs, endTs, startQty, averages, nowTs = wallTs ?? startTs) {
    const { restockSec, rate: avgRate, restockQty } = averages;
    const events = [];
    const segments = [];
    const open = startQty === 0 ? restocks.find((r) => r.restocked_ts == null) : null;

    let t = startTs;
    let qty = startQty;
    let outOfStock = startQty === 0;
    let depletedTs = open?.depleted_ts ?? null;
    let firstOpenCycle = outOfStock;

    while (t < endTs) {
      if (outOfStock) {
        const sec =
          firstOpenCycle && depletedTs != null
            ? openCycleRestockSec(depletedTs, restockSec, nowTs)
            : restockSec;
        firstOpenCycle = false;
        const restockTs = Math.round(
          depletedTs ? Math.max(t, depletedTs + sec) : t + sec
        );
        if (restockTs > endTs) break;
        events.push({ type: "restock", ts: restockTs, qty: restockQty, depleted_ts: depletedTs });
        t = restockTs;
        qty = restockQty;
        outOfStock = false;
        depletedTs = null;
        continue;
      }

      const rate = depletionRateForCycle(t, startTs, startQty, avgRate);
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
      events.push({ type: "restock", ts: restockTs, qty: restockQty, depleted_ts: depleteTs });
      t = restockTs;
      qty = restockQty;
    }

    return { events, segments };
  }

  function safeWindowDepletionRate() {
    if (safeWindowUseRateSelection) return rateFromHistory();
    return getHistoricalExtents().maxRate;
  }

  function restockQtyForSafeWindow() {
    if (restockAmount != null) return restockAmount;
    const qtySample = getUsableRates().slice(0, avgRateSamples);
    const qtySource = qtySample.length ? qtySample : getUsableRates();
    if (!qtySource.length) return null;
    return Math.round(qtySource.reduce((sum, w) => sum + w.start_qty, 0) / qtySource.length);
  }

  /** Initial [earliest, latest] depletion bounds before the first upcoming restock. */
  function initialDepletionEnvelope(dataTs, startQty, depletionRate) {
    if (startQty === 0) {
      const open = restocks.find((r) => r.restocked_ts == null);
      if (open?.depleted_ts == null) return null;
      return { earliestDepleted: open.depleted_ts, latestDepleted: open.depleted_ts };
    }
    if (startQty > 0) {
      const openWindow = getOpenRateWindow();
      const rate =
        openWindow?.rate > 0
          ? depletionRateForCycle(dataTs, dataTs, startQty, depletionRate)
          : depletionRate;
      const d = Math.round(dataTs + (startQty / rate) * 60);
      return { earliestDepleted: d, latestDepleted: d };
    }
    return null;
  }

  /**
   * Safe windows as [latest possible restock, earliest possible depletion].
   * Empty-for min/max compounds across cycles; depletion uses a single rate from
   * safeWindowDepletionRate() (selected rate when "Use for safe window" is on,
   * otherwise historical max). Stops when the envelope collapses.
   */
  function computeCompoundSafeWindows(dataTs, endTs, startQty) {
    const { minEmptyFor, maxEmptyFor } = getHistoricalExtents();
    const depletionRate = safeWindowDepletionRate();
    if (minEmptyFor == null || maxEmptyFor == null || depletionRate == null || startQty == null) {
      return [];
    }

    const restockQty = restockQtyForSafeWindow();
    if (restockQty == null || restockQty <= 0) return [];

    const initial = initialDepletionEnvelope(dataTs, startQty, depletionRate);
    if (!initial) return [];

    let { earliestDepleted, latestDepleted } = initial;
    const windows = [];
    const depleteSec = (restockQty / depletionRate) * 60;

    for (let i = 0; i < 100; i++) {
      const safeStart = Math.round(latestDepleted + maxEmptyFor);
      const safeEnd = Math.round(earliestDepleted + minEmptyFor + depleteSec);

      if (safeStart > endTs) break;
      if (safeStart >= safeEnd) break;

      windows.push({
        safeStart,
        safeEnd,
        depletedTs: latestDepleted,
      });

      // Compound empty-for uncertainty only; same depletion rate on both paths.
      earliestDepleted = Math.round(earliestDepleted + minEmptyFor + depleteSec);
      latestDepleted = Math.round(latestDepleted + maxEmptyFor + depleteSec);
      if (earliestDepleted > endTs) break;
    }

    return windows;
  }

  function computeSafeWindows(dataTs, endTs, startQty) {
    return computeCompoundSafeWindows(dataTs, endTs, startQty);
  }

  return {
    getHistoricalExtents,
    getAverages,
    computeSafeWindows,
  };
}

/**
 * Next leave window where the player can still arrive during a safe stock period.
 */
function resolveCurrentStock(chartPoints) {
  const lastPoint = chartPoints[chartPoints.length - 1];
  if (!lastPoint) return null;
  return {
    quantity: lastPoint.quantity,
    cost: lastPoint.cost,
    dataTs: lastPoint.yata_ts,
  };
}

function safeWindowHint(reason, { restockAmount, startQty, restocks }) {
  if (reason === "no_stock_data") {
    return "No snapshot data in the database for this item.";
  }
  if (reason === "no_upcoming_restock" && restockAmount == null) {
    const openCycle = restocks.some((r) => r.restocked_ts == null);
    if (startQty === 0 || openCycle) {
      return "Set restockAmount on the item detail page — it strongly affects safe window prediction for out-of-stock items.";
    }
  }
  if (reason === "no_upcoming_restock" && restockAmount != null) {
    return `Configured restock amount (${restockAmount}) does not produce a safe window with default rate settings. Try safeWindowUseRateSelection=true if "Use for safe window" is checked on the item page.`;
  }
  return null;
}

function safeWindowResponse(fields, restockAmount) {
  return { ...fields, restockAmount: restockAmount ?? null };
}

export async function computeNextSafeWindow(country, itemId, userOpts = {}) {
  const opts = {
    restockAmount: null,
    avgSamples: 5,
    avgRateSamples: 5,
    stockoutTiming: "avg",
    rateTiming: "avg",
    safeWindowUseRateSelection: false,
    travelType: "Standard",
    flightTimeVariance: false,
    predictionHours: 24,
    wallTs: Math.floor(Date.now() / 1000),
    ...userOpts,
  };
  const restockAmount =
    opts.restockAmount ?? (await getStoredRestockAmount(country, itemId));

  const restocks = await getRestocks(country, itemId, 50);
  const rates = await getDepletionRates(country, itemId, 50);
  const chartPoints = await getHistory(country, itemId, 0);

  const current = resolveCurrentStock(chartPoints);
  if (!current) {
    return safeWindowResponse(
      {
        country,
        itemId,
        available: false,
        safeWindow: null,
        reason: "no_stock_data",
        hint: safeWindowHint("no_stock_data", { restockAmount, startQty: null, restocks }),
      },
      restockAmount
    );
  }

  const dataTs = current.dataTs;
  const startQty = current.quantity;

  const ctx = createContext({
    restocks,
    rates,
    chartPoints,
    restockAmount,
    avgSamples: opts.avgSamples,
    avgRateSamples: opts.avgRateSamples,
    stockoutTiming: opts.stockoutTiming,
    rateTiming: opts.rateTiming,
    safeWindowUseRateSelection: opts.safeWindowUseRateSelection,
    currentQty: startQty,
    currentPollTs: dataTs,
    wallTs: opts.wallTs,
  });

  const { minEmptyFor, maxEmptyFor } = ctx.getHistoricalExtents();
  if (minEmptyFor == null || maxEmptyFor == null) {
    return safeWindowResponse(
      { country, itemId, available: false, safeWindow: null, reason: "insufficient_history" },
      restockAmount
    );
  }

  const endTs = dataTs + opts.predictionHours * 3600;
  const safeWindows = ctx.computeSafeWindows(dataTs, endTs, startQty);
  if (!safeWindows.length) {
    const reason = "no_upcoming_restock";
    return safeWindowResponse(
      {
        country,
        itemId,
        available: false,
        safeWindow: null,
        reason,
        hint: safeWindowHint(reason, {
          restockAmount,
          startQty,
          restocks,
        }),
      },
      restockAmount
    );
  }

  let flightSec;
  try {
    flightSec = getFlightSeconds(country, opts.travelType);
  } catch {
    return safeWindowResponse(
      { country, itemId, available: false, safeWindow: null, reason: "unknown_travel_type" },
      restockAmount
    );
  }

  for (const bounds of safeWindows) {
    const leaveEarliest = opts.flightTimeVariance
      ? bounds.safeStart - flightSecWithVariance(flightSec, "fast")
      : bounds.safeStart - flightSec;
    const leaveLatest = opts.flightTimeVariance
      ? bounds.safeEnd - flightSecWithVariance(flightSec, "slow")
      : bounds.safeEnd - flightSec;

    if (leaveLatest > opts.wallTs) {
      return safeWindowResponse(
        {
          country,
          itemId,
          available: true,
          safeWindow: {
            safeStart: bounds.safeStart,
            safeEnd: bounds.safeEnd,
            leaveEarliest,
            leaveLatest,
            depletedTs: bounds.depletedTs,
          },
          reason: null,
        },
        restockAmount
      );
    }
  }

  return safeWindowResponse(
    { country, itemId, available: false, safeWindow: null, reason: "missed" },
    restockAmount
  );
}

export async function computeSafeWindowsBatch(items, opts = {}) {
  const windows = {};
  for (const item of items) {
    const key = `${item.country}:${item.itemId}`;
    const restockAmount =
      item.restockAmount ??
      opts.restockAmount ??
      (await getStoredRestockAmount(item.country, item.itemId));
    windows[key] = await computeNextSafeWindow(item.country, item.itemId, {
      ...opts,
      restockAmount,
    });
  }
  return windows;
}
