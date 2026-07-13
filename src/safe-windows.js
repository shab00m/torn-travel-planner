import { getRestocks, getDepletionRates, getHistory } from "./db.js";
import { getLatest } from "./yata.js";
import { getFlightSeconds } from "./flight-times.js";

const FLIGHT_TIME_VARIANCE = 0.03;

function flightSecWithVariance(flightSec, kind) {
  if (kind === "fast") return Math.round(flightSec * (1 - FLIGHT_TIME_VARIANCE));
  return Math.round(flightSec * (1 + FLIGHT_TIME_VARIANCE));
}

function lastZeroBeforeRestock(chartPoints, restockedTs, depletedTs) {
  let lastZero = null;
  for (const p of chartPoints) {
    if (p.yata_ts < restockedTs && p.quantity === 0) lastZero = p.yata_ts;
  }
  return lastZero ?? depletedTs ?? null;
}

function adjustRestockTime(chartPoints, restockedTs, observedQty, ratePerMin, restockAmount, depletedTs) {
  if (!restockAmount || !ratePerMin || ratePerMin <= 0 || !observedQty) return restockedTs;
  if (observedQty >= restockAmount) return restockedTs;
  const adjustSec = ((restockAmount - observedQty) / ratePerMin) * 60;
  let adjusted = Math.round(restockedTs - adjustSec);
  const lastZero = lastZeroBeforeRestock(chartPoints, restockedTs, depletedTs);
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
}) {
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
      chartPoints,
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

  function adjustedRateWindow(w) {
    if (!restockAmount || w.start_qty >= restockAmount) return w;
    const restock = restocks.find((r) => r.restocked_ts === w.start_ts);
    const startTs = adjustRestockTime(
      chartPoints,
      w.start_ts,
      w.start_qty,
      w.rate,
      restockAmount,
      restock?.depleted_ts
    );
    return { ...w, start_ts: startTs, start_qty: restockAmount };
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
    return getAdjustedRates().filter((w) => !isRateWindowIgnored(w.start_ts));
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
    const elapsedMin = (refTs - w.start_ts) / 60;
    if (elapsedMin > 0) {
      const depleted = w.start_qty - qty;
      if (depleted > 0) return depleted / elapsedMin;
    }
    return w.rate > 0 ? w.rate : null;
  }

  function depletionRateForCycle(t, startTs, startQty, avgRate) {
    if (startQty > 0 && t === startTs) {
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

  function simulatePredictions(startTs, endTs, startQty, averages) {
    const { restockSec, rate: avgRate, restockQty } = averages;
    const events = [];
    const segments = [];
    const open = startQty === 0 ? restocks.find((r) => r.restocked_ts == null) : null;

    let t = startTs;
    let qty = startQty;
    let outOfStock = startQty === 0;
    let depletedTs = open?.depleted_ts ?? null;

    while (t < endTs) {
      if (outOfStock) {
        const restockTs = Math.round(
          depletedTs ? Math.max(t, depletedTs + restockSec) : t + restockSec
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

  function getSafeWindowAnchorRestocks(startTs, endTs, startQty) {
    const { maxEmptyFor } = getHistoricalExtents();
    const rate = rateFromHistory();
    if (maxEmptyFor == null || rate == null || startQty == null) return [];

    const qtySample = getUsableRates().slice(0, avgRateSamples);
    const qtySource = qtySample.length ? qtySample : getUsableRates();
    if (!restockAmount && !qtySource.length) return [];
    const restockQty =
      restockAmount ??
      Math.round(qtySource.reduce((sum, w) => sum + w.start_qty, 0) / qtySource.length);

    const { events } = simulatePredictions(startTs, endTs, startQty, {
      restockSec: maxEmptyFor,
      rate,
      restockQty,
    });
    return events.filter((e) => e.type === "restock" && e.ts >= startTs);
  }

  function safeWindowDepletionRate() {
    if (safeWindowUseRateSelection) return rateFromHistory();
    return getHistoricalExtents().maxRate;
  }

  function safeWindowBoundsForDepletedTs(depletedTs, qty) {
    const { minEmptyFor, maxEmptyFor } = getHistoricalExtents();
    const depletionRate = safeWindowDepletionRate();
    if (minEmptyFor == null || maxEmptyFor == null || depletionRate == null || depletedTs == null) {
      return null;
    }

    const effectiveQty = restockAmount ?? qty;
    const safeStart = Math.round(depletedTs + maxEmptyFor);
    const safeEnd = Math.round(depletedTs + minEmptyFor + (effectiveQty / depletionRate) * 60);

    if (safeStart >= safeEnd) return null;
    return { safeStart, safeEnd, depletedTs };
  }

  function safeWindowBoundsForEvent(event, index, anchors) {
    const anchor = anchors?.[index];
    const depletedTs = anchor?.depleted_ts ?? event.depleted_ts;
    return safeWindowBoundsForDepletedTs(depletedTs, event.qty);
  }

  function computeSafeWindows(dataTs, endTs, startQty) {
    const averages = getAverages();
    if (!averages) return [];

    const anchors = getSafeWindowAnchorRestocks(dataTs, endTs, startQty);
    const { events } = simulatePredictions(dataTs, endTs, startQty, averages);
    const upcomingRestocks = events.filter((e) => e.type === "restock" && e.ts >= dataTs);
    return upcomingRestocks
      .map((e, i) => safeWindowBoundsForEvent(e, i, anchors))
      .filter(Boolean);
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
export function computeNextSafeWindow(country, itemId, userOpts = {}) {
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

  const restocks = getRestocks(country, itemId, 50);
  const rates = getDepletionRates(country, itemId, 50);
  const chartPoints = getHistory(country, itemId, 0);

  const { payload } = getLatest();
  const countryData = payload?.stocks?.[country];
  const stockItem = countryData?.stocks?.find((i) => i.id === itemId);
  if (!stockItem || !countryData) {
    return { country, itemId, available: false, safeWindow: null, reason: "no_stock_data" };
  }

  const dataTs = countryData.update;
  const startQty = stockItem.quantity;

  const ctx = createContext({
    restocks,
    rates,
    chartPoints,
    restockAmount: opts.restockAmount,
    avgSamples: opts.avgSamples,
    avgRateSamples: opts.avgRateSamples,
    stockoutTiming: opts.stockoutTiming,
    rateTiming: opts.rateTiming,
    safeWindowUseRateSelection: opts.safeWindowUseRateSelection,
    currentQty: startQty,
    currentPollTs: dataTs,
  });

  const { minEmptyFor, maxEmptyFor } = ctx.getHistoricalExtents();
  if (minEmptyFor == null || maxEmptyFor == null) {
    return { country, itemId, available: false, safeWindow: null, reason: "insufficient_history" };
  }

  const endTs = dataTs + opts.predictionHours * 3600;
  const safeWindows = ctx.computeSafeWindows(dataTs, endTs, startQty);
  if (!safeWindows.length) {
    return { country, itemId, available: false, safeWindow: null, reason: "no_upcoming_restock" };
  }

  let flightSec;
  try {
    flightSec = getFlightSeconds(country, opts.travelType);
  } catch {
    return { country, itemId, available: false, safeWindow: null, reason: "unknown_travel_type" };
  }

  for (const bounds of safeWindows) {
    const leaveEarliest = opts.flightTimeVariance
      ? bounds.safeStart - flightSecWithVariance(flightSec, "fast")
      : bounds.safeStart - flightSec;
    const leaveLatest = opts.flightTimeVariance
      ? bounds.safeEnd - flightSecWithVariance(flightSec, "slow")
      : bounds.safeEnd - flightSec;

    if (leaveLatest > opts.wallTs) {
      return {
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
      };
    }
  }

  return { country, itemId, available: false, safeWindow: null, reason: "missed" };
}

export function computeSafeWindowsBatch(items, opts = {}) {
  const windows = {};
  for (const item of items) {
    const key = `${item.country}:${item.itemId}`;
    windows[key] = computeNextSafeWindow(item.country, item.itemId, {
      ...opts,
      restockAmount: item.restockAmount ?? opts.restockAmount ?? null,
    });
  }
  return windows;
}
