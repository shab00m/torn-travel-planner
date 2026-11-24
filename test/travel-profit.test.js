import test from "node:test";
import assert from "node:assert/strict";
import { simulateStockPredictions } from "../public/stock-predictions.js";
import { schedulePurchaseTrips } from "../public/travel-profit.js";

test("daily travel waits for restocks, skips windows during a trip, and can return after the workday", () => {
  const startTs = 1000;
  const endTs = startTs + 16 * 3600;
  const { segments } = simulateStockPredictions({
    startTs, endTs, startQty: 0,
    averages: { restockSec: 6000, rate: 1, restockQty: 20 },
    rateForCycle: () => 1,
  });
  const plan = { segments, startTs, flightSec: 4500, itemsPerTrip: 10 };

  // Buy 6,000, 20,400, 34,800 and 49,200 seconds into the day.
  // The preceding windows after each purchase end while the traveler is away
  // or can no longer be reached in time for a full load.
  assert.deepEqual(schedulePurchaseTrips({ ...plan, endTs }), { trips: 4, waitingSec: 17700 });
  assert.equal(schedulePurchaseTrips({ ...plan, endTs: startTs + 49200 }).trips, 4);
  assert.equal(schedulePurchaseTrips({ ...plan, endTs: startTs + 49199 }).trips, 3);
  assert.equal(schedulePurchaseTrips({ ...plan, endTs: startTs + 6000 }).trips, 1);
});

test("stock on arrival limits repeat trips within the same window", () => {
  const plan = {
    segments: [{ start_ts: 1000, end_ts: 3400, start_qty: 40, rate: 1 }],
    startTs: 1000, endTs: 3400, flightSec: 300, itemsPerTrip: 12,
  };
  // Stock drops to 35 and 25 before purchases. The third arrival would have
  // 15 units from the forecast, but 24 units have already been bought.
  assert.deepEqual(schedulePurchaseTrips(plan), { trips: 2, waitingSec: 0 });
  assert.deepEqual(schedulePurchaseTrips({ ...plan, itemsPerTrip: 36 }), { trips: 0, waitingSec: 0 });
});
