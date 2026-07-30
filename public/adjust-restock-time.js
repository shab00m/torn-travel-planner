/**
 * Back-extrapolate full restock time from the first observed in-stock snapshot.
 * Prefers the opening A→B depletion slope over the whole-cycle average rate.
 */

/** Items per minute between two quantity snapshots. */
export function rateFromEndpoints(startTs, endTs, startQty, endQty) {
  const minutes = (endTs - startTs) / 60;
  if (minutes <= 0) return null;
  const rate = (startQty - endQty) / minutes;
  return rate > 0 ? rate : null;
}

/**
 * Opening depletion rate from the restock snapshot and the next positive point.
 * @param {{ yata_ts: number, quantity: number }[]} points ascending by yata_ts
 * @param {number} restockedTs timestamp of the first in-stock snapshot
 * @returns {number|null} items/minute, or null if unusable
 */
export function earlyDepletionRate(points, restockedTs) {
  if (!points?.length || restockedTs == null) return null;
  let aIdx = -1;
  for (let i = 0; i < points.length; i++) {
    if (points[i].yata_ts === restockedTs && points[i].quantity > 0) {
      aIdx = i;
      break;
    }
    if (points[i].yata_ts > restockedTs) break;
  }
  if (aIdx < 0) return null;

  let bIdx = -1;
  for (let i = aIdx + 1; i < points.length; i++) {
    if (points[i].quantity > 0) {
      bIdx = i;
      break;
    }
  }
  if (bIdx < 0) return null;

  const a = points[aIdx];
  const b = points[bIdx];
  return rateFromEndpoints(a.yata_ts, b.yata_ts, a.quantity, b.quantity);
}

/**
 * Shift restock time earlier when the first snapshot is below the known full size.
 * Uses early A→B rate when available; otherwise fallbackRatePerMin (cycle average).
 * Clamps to depletedTs+1 / lastZero+1 so the estimate never precedes known empty stock.
 *
 * @param {object} opts
 * @param {number} opts.restockedTs first observed in-stock timestamp
 * @param {number} opts.observedQty quantity at restockedTs
 * @param {number|null|undefined} opts.fallbackRatePerMin whole-cycle rate (items/min)
 * @param {number} opts.restockAmount configured full restock size
 * @param {number|null|undefined} [opts.depletedTs]
 * @param {number|null|undefined} [opts.lastZero] last qty=0 timestamp before restockedTs
 * @param {{ yata_ts: number, quantity: number }[]|null|undefined} [opts.points]
 */
export function adjustRestockTime({
  restockedTs,
  observedQty,
  fallbackRatePerMin,
  restockAmount,
  depletedTs = null,
  lastZero = null,
  points = null,
}) {
  if (!restockAmount || !observedQty) return restockedTs;
  if (observedQty >= restockAmount) return restockedTs;

  const earlyRate = points ? earlyDepletionRate(points, restockedTs) : null;
  const rate =
    earlyRate ??
    (fallbackRatePerMin != null && fallbackRatePerMin > 0 ? fallbackRatePerMin : null);
  if (rate == null) return restockedTs;

  let adjusted = Math.round(restockedTs - ((restockAmount - observedQty) / rate) * 60);
  if (depletedTs != null) adjusted = Math.max(adjusted, depletedTs + 1);
  if (lastZero != null) adjusted = Math.max(adjusted, lastZero + 1);
  return adjusted;
}
