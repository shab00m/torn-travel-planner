import { nextRestock, simulateStockPredictions } from "../public/stock-predictions.js";
import {
  getRestocks,
  getDepletionRates,
  getHistory,
  getTravelCatalogueCost,
  getWorkdayRestocks,
  getAllRestockAmounts,
  getAllEmptyForBounds,
  getRestockAmount as getStoredRestockAmount,
  getEmptyForBounds as getStoredEmptyForBounds,
} from "./db.js";
import { applyConfiguredEmptyForExtents } from "../public/empty-for-bounds.js";
import { getFlightSeconds } from "./flight-times.js";
import { depletionRatesFromRestocks } from "./depletion-rates.js";
import { planWorkdayTrips } from "../public/travel-profit.js";
import { getDepletionRateTod, rateFromTodHours, hoursFromRateWindows } from "./depletion-rate-tod.js";
import {
  adjustRestockTime as adjustRestockTimeCore,
  rateFromEndpoints,
} from "../public/adjust-restock-time.js";

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
    if (chartPoints[i].quantity === 0) lastZero = chartPoints[i].snapshot_ts;
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
    if (points[mid].snapshot_ts < restockedTs) {
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
  return adjustRestockTimeCore({
    restockedTs,
    observedQty,
    fallbackRatePerMin: ratePerMin,
    restockAmount,
    depletedTs,
    lastZero: lastZeroBeforeRestock(lookup, restockedTs, depletedTs),
    points: lookup?.points ?? null,
  });
}

function createContext({
  restocks,
  rates,
  chartPoints,
  restockAmount,
  avgRateSamples,
  stockoutTiming,
  rateTiming,
  safeWindowUseRateSelection,
  historicalRatePrediction,
  maxAgeDays,
  storedRateTodHours,
  historySinceTs,
  currentQty,
  currentPollTs,
  wallTs,
  emptyForBounds = { minEmptyFor: null, maxEmptyFor: null, avgEmptyFor: null },
}) {
  const lastZeroLookup = buildLastZeroLookup(chartPoints);
  const byRestockTime = new Map();
  for (const restock of restocks) {
    if (!byRestockTime.has(restock.restocked_ts)) byRestockTime.set(restock.restocked_ts, restock);
  }

  function rateWindowForRestock(restockedTs) {
    return rates.find((w) => w.start_ts === restockedTs);
  }

  function isRateWindowIgnored(startTs) {
    return Boolean(byRestockTime.get(startTs)?.ignored);
  }

  function effectiveDepletedTs(r) {
    return r.adjusted_depleted_ts ?? r.depleted_ts;
  }

  function adjustedRestockRecord(r) {
    const adjDepleted = effectiveDepletedTs(r);
    // Prefer server-persisted adjustment when present.
    if (r.adjusted_duration != null) {
      return {
        ...r,
        adjusted_depleted_ts: adjDepleted,
        adjusted_restocked_ts: r.adjusted_restocked_ts ?? r.restocked_ts,
        adjusted_duration: r.adjusted_duration,
      };
    }
    if (!restockAmount || r.restocked_ts == null) {
      return {
        ...r,
        adjusted_depleted_ts: adjDepleted,
        adjusted_restocked_ts: r.restocked_ts,
        adjusted_duration:
          r.restocked_ts != null && adjDepleted != null ? r.restocked_ts - adjDepleted : r.duration,
      };
    }
    const window = rateWindowForRestock(r.restocked_ts);
    if (!window) {
      return {
        ...r,
        adjusted_depleted_ts: adjDepleted,
        adjusted_restocked_ts: r.restocked_ts,
        adjusted_duration: r.restocked_ts - adjDepleted,
      };
    }
    const adjustedTs = adjustRestockTime(
      lastZeroLookup,
      r.restocked_ts,
      window.start_qty,
      window.rate,
      restockAmount,
      adjDepleted
    );
    return {
      ...r,
      adjusted_depleted_ts: adjDepleted,
      adjusted_restocked_ts: adjustedTs,
      adjusted_duration: adjustedTs - adjDepleted,
    };
  }

  function adjustedRateWindow(w) {
    if (!restockAmount || w.start_qty >= restockAmount) return w;
    const restock = byRestockTime.get(w.start_ts);
    const startTs =
      restock?.adjusted_restocked_ts != null
        ? restock.adjusted_restocked_ts
        : adjustRestockTime(
            lastZeroLookup,
            w.start_ts,
            w.start_qty,
            w.rate,
            restockAmount,
            restock ? effectiveDepletedTs(restock) : null
          );
    const rate = rateFromEndpoints(startTs, w.end_ts, restockAmount, w.end_qty) ?? w.rate;
    return { ...w, start_ts: startTs, start_qty: restockAmount, rate };
  }

  function getAdjustedCompletedRestocks() {
    return restocks.filter((r) => r.duration != null).map(adjustedRestockRecord);
  }

  function getUsableCompletedRestocks() {
    return getAdjustedCompletedRestocks().filter((r) =>
      !r.ignored && isInHistoryRange(r.adjusted_restocked_ts ?? r.restocked_ts)
    );
  }

  function getAdjustedRates() {
    return rates.map(adjustedRateWindow);
  }

  function getUsableRates() {
    // Filter on raw start_ts before adjustment — adjusted timestamps no longer match restocks.
    return rates.filter((w) => !isRateWindowIgnored(w.start_ts))
      .map(adjustedRateWindow)
      .filter((w) => isInHistoryRange(w.start_ts));
  }

  function isInHistoryRange(ts) {
    return historySinceTs === 0 || (ts != null && ts >= historySinceTs);
  }

  const liveRateTodHours = historicalRatePrediction
    ? hoursFromRateWindows(
        getUsableRates(),
        maxAgeDays == null ? 0 : wallTs - maxAgeDays * 86400,
        maxAgeDays == null ? Infinity : wallTs
      )
    : null;
  const rateTodHours = liveRateTodHours?.some((rate) => rate > 0) ? liveRateTodHours : storedRateTodHours;

  function getHistoricalExtents() {
    const completed = getUsableCompletedRestocks();
    const durations = completed
      .map((r) => r.adjusted_duration)
      .filter((d) => d != null && d > 0);
    const usableRates = getUsableRates()
      .map((w) => w.rate)
      .filter((r) => r != null && r > 0);
    return applyConfiguredEmptyForExtents(
      {
        minEmptyFor: durations.length ? Math.min(...durations) : null,
        maxEmptyFor: durations.length ? Math.max(...durations) : null,
        minRate: usableRates.length ? Math.min(...usableRates) : null,
        maxRate: usableRates.length ? Math.max(...usableRates) : null,
      },
      emptyForBounds
    );
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

  function meanTodRate() {
    const hours = (rateTodHours ?? []).filter((r) => r != null && r > 0);
    if (!hours.length) return null;
    return hours.reduce((sum, r) => sum + r, 0) / hours.length;
  }

  function rateForAverages() {
    if (historicalRatePrediction) return meanTodRate() ?? rateFromHistory();
    return rateFromHistory();
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
    return rateFromEndpoints(w.start_ts, refTs, w.start_qty, qty) ?? (w.rate > 0 ? w.rate : null);
  }

  function depletionRateForCycle(t, startTs, startQty, avgRate) {
    if (historicalRatePrediction) {
      return rateFromTodHours(t, rateTodHours, avgRate);
    }
    if (startQty > 0 && t === startTs) {
      // Continue the current open cycle at its observed rate — not the historical average.
      const w = getOpenRateWindow();
      if (w?.rate > 0) return w.rate;
      return getCurrentRestockRate(startQty, startTs) ?? avgRate;
    }
    return avgRate;
  }

  function stockoutSecFromHistory() {
    if (stockoutTiming === "min" || stockoutTiming === "max") {
      const { minEmptyFor, maxEmptyFor } = getHistoricalExtents();
      return stockoutTiming === "min" ? minEmptyFor : maxEmptyFor;
    }
    return emptyForBounds.avgEmptyFor ?? null;
  }

  function getAverages() {
    const restockSec = stockoutSecFromHistory();
    const rate = rateForAverages();
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
    const open = startQty === 0 ? restocks.find((r) => r.restocked_ts == null) : null;
    return simulateStockPredictions({
      startTs, endTs, startQty, averages, nowTs,
      openDepletedTs: open ? effectiveDepletedTs(open) : null,
      openCycleKey: open?.depleted_ts ?? null,
      avgEmptySec: emptyForBounds.avgEmptyFor,
      maxEmptySec: emptyForBounds.maxEmptyFor,
      durations: getUsableCompletedRestocks().map((r) => r.adjusted_duration),
      rateForCycle: depletionRateForCycle,
    });
  }

  function safeWindowDepletionRate() {
    if (safeWindowUseRateSelection) {
      if (historicalRatePrediction) return meanTodRate() ?? rateFromHistory();
      return rateFromHistory();
    }
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
      const depleted = effectiveDepletedTs(open);
      return { earliestDepleted: depleted, latestDepleted: depleted };
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
   * With historical TOD rates, each path looks up depletion rate at its restock time.
   */
  function computeCompoundSafeWindows(dataTs, endTs, startQty) {
    const { minEmptyFor, maxEmptyFor } = getHistoricalExtents();
    const fallbackRate = safeWindowDepletionRate();
    if (minEmptyFor == null || maxEmptyFor == null || fallbackRate == null || startQty == null) {
      return [];
    }

    const restockQty = restockQtyForSafeWindow();
    if (restockQty == null || restockQty <= 0) return [];

    const initial = initialDepletionEnvelope(dataTs, startQty, fallbackRate);
    if (!initial) return [];

    const rateAt = (ts) =>
      historicalRatePrediction && safeWindowUseRateSelection
        ? rateFromTodHours(ts, rateTodHours, fallbackRate)
        : fallbackRate;

    let { earliestDepleted, latestDepleted } = initial;
    const nowTs = wallTs ?? dataTs;
    const configured = emptyForBounds;
    const next = nextRestock({
      depletedTs: latestDepleted,
      selectedSec: configured.avgEmptyFor ?? minEmptyFor,
      avgEmptySec: configured.avgEmptyFor,
      maxEmptySec: configured.maxEmptyFor,
      nowTs, restockQty, rateAt,
    });
    const missedShift = next.depletedTs - latestDepleted;
    earliestDepleted += missedShift;
    latestDepleted += missedShift;
    const windows = [];

    for (let i = 0; i < 100; i++) {
      const restockEarliest = Math.max(nowTs + 60, earliestDepleted + minEmptyFor);
      const restockLatest = Math.max(nowTs + 60, latestDepleted + maxEmptyFor);
      const depleteSecEarliest = (restockQty / rateAt(restockEarliest)) * 60;
      const depleteSecLatest = (restockQty / rateAt(restockLatest)) * 60;

      const safeStart = Math.round(restockLatest);
      const safeEnd = Math.round(restockEarliest + depleteSecEarliest);

      if (safeStart > endTs) break;
      if (safeStart >= safeEnd) break;

      windows.push({
        safeStart,
        safeEnd,
        depletedTs: latestDepleted,
      });

      earliestDepleted = Math.round(restockEarliest + depleteSecEarliest);
      latestDepleted = Math.round(restockLatest + depleteSecLatest);
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
    simulatePredictions,
    getCurrentRestockRate,
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
    dataTs: lastPoint.snapshot_ts,
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

export async function computeNextSafeWindow(country, itemId, userOpts = {}) {
  const opts = {
    restockAmount: null,
    avgSamples: 5,
    avgRateSamples: 3,
    stockoutTiming: "avg",
    rateTiming: "avg",
    safeWindowUseRateSelection: true,
    historicalRatePrediction: false,
    historicalRateMaxAgeDays: null,
    travelType: "Standard",
    flightTimeVariance: true,
    predictionHours: 24,
    wallTs: Math.floor(Date.now() / 1000),
    ...userOpts,
  };
  const restockAmount =
    opts.restockAmount ?? (await getStoredRestockAmount(country, itemId));
  const emptyForBounds = await getStoredEmptyForBounds(country, itemId);

  const historicalRatePrediction = opts.historicalRatePrediction === true;
  const maxAgeDays =
    Number.isInteger(opts.historicalRateMaxAgeDays) && opts.historicalRateMaxAgeDays > 0
      ? opts.historicalRateMaxAgeDays
      : null;
  const historySinceTs = opts.rangeHours > 0
    ? Math.max(0, opts.wallTs - Math.round(opts.rangeHours * 3600))
    : 0;

  const [restocks, rates, chartPoints, rateTod] = await Promise.all([
    getRestocks(country, itemId),
    getDepletionRates(country, itemId),
    getHistory(country, itemId, 0, { effective: true }),
    historicalRatePrediction && maxAgeDays == null
      ? getDepletionRateTod(country, itemId)
      : Promise.resolve({ hours: null, updatedAt: null }),
  ]);

  const current = resolveCurrentStock(chartPoints);
  const buyPrice = current?.cost ?? (await getTravelCatalogueCost(country, itemId));
  const itemDetails = { country, itemId, buyPrice, restockAmount: restockAmount ?? null };
  if (!current || current.dataTs < historySinceTs) {
    return {
      ...itemDetails,
      available: false,
      safeWindow: null,
      reason: "no_stock_data",
      hint: current ? "No snapshot data in the requested history range."
        : safeWindowHint("no_stock_data", { restockAmount, startQty: null, restocks }),
    };
  }

  const dataTs = current.dataTs;
  const startQty = current.quantity;
  const predictionPoints = historySinceTs > 0
    ? chartPoints.filter((point) => point.snapshot_ts >= historySinceTs)
    : chartPoints;

  const ctx = createContext({
    restocks,
    rates,
    chartPoints: predictionPoints,
    restockAmount,
    avgSamples: opts.avgSamples,
    avgRateSamples: opts.avgRateSamples,
    stockoutTiming: opts.stockoutTiming,
    rateTiming: opts.rateTiming,
    safeWindowUseRateSelection: opts.safeWindowUseRateSelection,
    historicalRatePrediction,
    maxAgeDays,
    storedRateTodHours: rateTod.hours,
    historySinceTs,
    currentQty: startQty,
    currentPollTs: dataTs,
    wallTs: opts.wallTs,
    emptyForBounds,
  });

  const endTs = Math.max(dataTs, opts.wallTs) + opts.predictionHours * 3600;
  let flightSec;
  try {
    flightSec = getFlightSeconds(country, opts.travelType);
  } catch {
    return { ...itemDetails, available: false, safeWindow: null, nextWindow: null, reason: "unknown_travel_type" };
  }

  // Regular predictions use the same selected timing and rate as the item page.
  let nextWindow = null;
  const averages = ctx.getAverages();
  if (averages) {
    const { events, segments } = ctx.simulatePredictions(dataTs, endTs, startQty, averages);
    const upcoming = events.filter((e) => e.type === "restock" && e.ts >= dataTs);
    const lastZeroLookup = buildLastZeroLookup(predictionPoints);
    for (const event of upcoming) {
      let start = event.ts;
      if (restockAmount && averages.rate) {
        start = adjustRestockTime(
          lastZeroLookup, event.ts, event.qty,
          startQty > 0 && event === upcoming[0]
            ? ctx.getCurrentRestockRate(startQty, dataTs) ?? averages.rate
            : averages.rate,
          restockAmount, event.depleted_ts
        );
      }
      const end = events.find((e) => e.type === "deplete" && e.ts > event.ts)?.ts
        ?? segments.find((s) => s.start_ts >= event.ts && s.end_qty === 0)?.end_ts
        ?? start;
      const leaveEarliest = start - flightSec;
      const leaveLatest = end - flightSec;
      if (leaveLatest > opts.wallTs) {
        nextWindow = {
          start,
          end,
          leaveEarliest,
          leaveLatest,
          leaveInSeconds: Math.max(0, leaveEarliest - opts.wallTs),
        };
        break;
      }
    }
  }

  const safeWindows = ctx.computeSafeWindows(dataTs, endTs, startQty);
  if (!safeWindows.length) {
    const { minEmptyFor, maxEmptyFor } = ctx.getHistoricalExtents();
    const reason = minEmptyFor == null || maxEmptyFor == null
      ? "insufficient_history" : "no_upcoming_restock";
    return {
      ...itemDetails, nextWindow, available: false, safeWindow: null, reason,
      hint: safeWindowHint(reason, { restockAmount, startQty, restocks }),
    };
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
        ...itemDetails,
        available: true,
        nextWindow,
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

  return { ...itemDetails, nextWindow, available: false, safeWindow: null, reason: "missed" };
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
      ...item.settings,
      restockAmount,
    });
  }
  return windows;
}

export async function computeWorkdayEstimates(items, stocks, { travelType, workdayHours, startTs }) {
  const [amounts, bounds] = await Promise.all([getAllRestockAmounts(), getAllEmptyForBounds()]);
  const estimates = {};
  const forecasts = [];

  for (const item of items) {
    const { country, itemId, settings } = item;
    const key = `${country}:${itemId}`;
    const stock = stocks[country]?.stocks.find((row) => row.id === itemId);
    if (stock?.snapshot_ts == null) continue;
    const flightSec = getFlightSeconds(country, travelType);
    if (flightSec > workdayHours * 3600) {
      estimates[key] = { trips: 0, waitingSec: 0 };
    } else if (bounds[key]?.avgEmptyFor != null) {
      const sinceTs = settings.rangeHours > 0 ? startTs - Math.round(settings.rangeHours * 3600) : 0;
      forecasts.push({ ...item, key, stock, flightSec, sinceTs: Math.max(0, sinceTs) });
    }
  }
  if (!forecasts.length) return estimates;

  const history = await getWorkdayRestocks(forecasts);
  await Promise.all(forecasts.map(async ({ country, itemId, key, stock, flightSec, sinceTs, settings }) => {
    const events = history.get(key) ?? [];
    const rates = depletionRatesFromRestocks(events, stock);
    const restockAmount = amounts[key] ?? null;
    // Pre-adjustment records still need the chart snapshots for the existing fallback.
    const needsHistory = restockAmount != null && events.some((row) => !row.ignored &&
      row.restocked_ts != null && row.adjusted_restocked_ts == null &&
      row.rate_start_qty > 0 && row.rate_start_qty < restockAmount);
    const maxAgeDays = settings.historicalRateMaxAgeDays ?? null;
    const [chartPoints, rateTod] = await Promise.all([
      needsHistory ? getHistory(country, itemId, sinceTs, { effective: true }) : [],
      settings.historicalRatePrediction && maxAgeDays == null ? getDepletionRateTod(country, itemId) : null,
    ]);
    const ctx = createContext({
      restocks: events.toReversed(), rates, chartPoints, restockAmount,
      avgRateSamples: settings.avgRateSamples ?? 3,
      stockoutTiming: "avg", rateTiming: settings.rateTiming ?? "avg",
      historicalRatePrediction: settings.historicalRatePrediction === true,
      maxAgeDays, storedRateTodHours: rateTod?.hours,
      historySinceTs: sinceTs, currentQty: stock.quantity, currentPollTs: stock.snapshot_ts,
      wallTs: startTs, emptyForBounds: bounds[key],
    });
    const day = planWorkdayTrips({
      stock, averages: ctx.getAverages(), startTs, workdayHours, flightSec,
      simulatePredictions: ctx.simulatePredictions,
    });
    if (day) estimates[key] = day;
  }));
  return estimates;
}
