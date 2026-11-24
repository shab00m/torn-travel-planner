/** Schedule full-load trips whose return flights can depart by the workday cutoff. */
export function schedulePurchaseTrips({ segments, startTs, endTs, flightSec, itemsPerTrip }) {
  let readyTs = startTs;
  let trips = 0;
  let waitingSec = 0;
  if (!(flightSec > 0) || !(itemsPerTrip > 0)) return { trips, waitingSec };

  for (const segment of segments) {
    let purchased = 0;
    let arriveTs = Math.max(readyTs + flightSec, segment.start_ts);
    while (arriveTs < segment.end_ts && arriveTs <= endTs) {
      const remaining = segment.start_qty - segment.rate * ((arriveTs - segment.start_ts) / 60) - purchased;
      if (remaining < itemsPerTrip) break;

      waitingSec += arriveTs - flightSec - readyTs;
      readyTs = arriveTs + flightSec;
      trips++;
      purchased += itemsPerTrip;
      arriveTs = readyTs + flightSec;
    }
    if (readyTs + flightSec > endTs) break;
  }

  return { trips, waitingSec };
}
