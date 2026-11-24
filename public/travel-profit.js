export function planWorkdayTrips({ stock, averages, startTs, workdayHours, flightSec, simulatePredictions }) {
  const endTs = startTs + workdayHours * 3600;
  if (startTs + flightSec > endTs) return { trips: 0, waitingSec: 0 };
  if (!stock || !averages || !(averages.rate > 0) || !(averages.restockQty > 0)) return null;

  // Include the cutoff itself in the forecast for a return flight leaving right then.
  const { segments } = simulatePredictions(stock.snapshot_ts, endTs + 1, stock.quantity, averages, startTs);
  return schedulePurchaseTrips({ segments, startTs, endTs, flightSec });
}

/** Treat any arrival during a predicted in-stock window as a full load. */
export function schedulePurchaseTrips({ segments, startTs, endTs, flightSec }) {
  let readyTs = startTs;
  let trips = 0;
  let waitingSec = 0;
  if (!(flightSec > 0)) return { trips, waitingSec };

  for (const segment of segments) {
    let arriveTs = Math.max(readyTs + flightSec, segment.start_ts);
    while (arriveTs < segment.end_ts && arriveTs <= endTs) {
      waitingSec += arriveTs - flightSec - readyTs;
      readyTs = arriveTs + flightSec;
      trips++;
      arriveTs = readyTs + flightSec;
    }
    if (readyTs + flightSec > endTs) break;
  }

  return { trips, waitingSec };
}
