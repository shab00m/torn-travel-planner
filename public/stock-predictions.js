/** Resolve an unconfirmed restock without inventing stock before now. */
export function nextRestock({
  depletedTs, selectedSec, avgEmptySec, maxEmptySec, durations = [],
  nowTs, restockQty, rateAt,
}) {
  let depleted = depletedTs;
  // A missed cycle uses average empty time, then the expected sell-out time.
  // These inferred cycles are scheduling anchors only, never chart events.
  if (maxEmptySec != null && avgEmptySec != null && avgEmptySec >= 0) {
    while (nowTs > depleted + maxEmptySec) {
      const missedRestock = depleted + avgEmptySec;
      const rate = rateAt(missedRestock);
      const nextDepleted = Math.round(missedRestock + (restockQty / rate) * 60);
      if (!Number.isFinite(nextDepleted) || nextDepleted <= depleted) break;
      depleted = nextDepleted;
    }
  }
  let sec = selectedSec;
  if (depleted + sec <= nowTs) {
    sec = [...durations].sort((a, b) => a - b)
      .find((d) => d > 0 && depleted + d > nowTs) ?? sec;
  }
  return {
    ts: Math.max(Math.ceil(nowTs + 60), Math.round(depleted + sec)),
    depletedTs: depleted,
  };
}

/** Shared by the item chart and the server's regular travel predictions. */
export function simulateStockPredictions({
  startTs, endTs, startQty, averages, nowTs = startTs,
  openDepletedTs = null, openCycleKey = null,
  avgEmptySec = null, maxEmptySec = null, durations = [], rateForCycle,
}) {
  const { restockSec, rate: avgRate, restockQty } = averages;
  const events = [];
  const segments = [];
  if (!(avgRate > 0) || !(restockQty > 0) || !(restockSec >= 0)) return { events, segments };
  const rateAt = (ts) => rateForCycle(ts, startTs, startQty, avgRate);
  let t = startTs;
  let qty = startQty;
  let depletedTs = startQty === 0 ? openDepletedTs ?? startTs : null;
  let cycleKey = openCycleKey;

  while (t < endTs) {
    if (qty === 0) {
      const next = nextRestock({
        depletedTs, selectedSec: restockSec, avgEmptySec, maxEmptySec,
        durations, nowTs, restockQty, rateAt,
      });
      const restockTs = Math.max(t, next.ts);
      if (restockTs > endTs) {
        if (t > startTs) events.push({ type: "out_of_stock", start: t, end: endTs, duration: endTs - t });
        break;
      }
      if (t > startTs) {
        events.push({ type: "out_of_stock", start: t, end: restockTs, duration: restockTs - t });
      }
      events.push({ type: "restock", ts: restockTs, qty: restockQty,
        depleted_ts: next.depletedTs === depletedTs ? cycleKey : next.depletedTs });
      t = restockTs;
      qty = restockQty;
    }

    const rate = rateAt(t);
    if (!(rate > 0)) break;
    const depleteTs = Math.max(t + 1, Math.round(t + (qty / rate) * 60));
    const segmentEnd = Math.min(depleteTs, endTs);
    segments.push({ start_ts: t, end_ts: segmentEnd, start_qty: qty,
      end_qty: segmentEnd === depleteTs ? 0 : Math.max(0, qty - rate * ((segmentEnd - t) / 60)), rate });
    if (depleteTs >= endTs) break;
    events.push({ type: "deplete", ts: depleteTs });
    t = depleteTs;
    qty = 0;
    depletedTs = depleteTs;
    cycleKey = depleteTs;
  }
  return { events, segments };
}
