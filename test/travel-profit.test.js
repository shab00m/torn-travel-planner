import test from "node:test";
import assert from "node:assert/strict";
import { simulateStockPredictions } from "../public/stock-predictions.js";
import { planWorkdayTrips, schedulePurchaseTrips } from "../public/travel-profit.js";

test("daily travel waits for restocks, skips windows during a trip, and can return after the workday", () => {
  const startTs = 1000;
  const endTs = startTs + 16 * 3600;
  const { segments } = simulateStockPredictions({
    startTs, endTs, startQty: 0,
    averages: { restockSec: 6000, rate: 1, restockQty: 20 },
    rateForCycle: () => 1,
  });
  const plan = { segments, startTs, flightSec: 4500 };

  // Buy 6,000, 20,400, 34,800 and 49,200 seconds into the day.
  // The preceding windows after each purchase end while the traveler is away
  // or can no longer be reached before depletion.
  assert.deepEqual(schedulePurchaseTrips({ ...plan, endTs }), { trips: 4, waitingSec: 17700 });
  assert.equal(schedulePurchaseTrips({ ...plan, endTs: startTs + 49200 }).trips, 4);
  assert.equal(schedulePurchaseTrips({ ...plan, endTs: startTs + 49199 }).trips, 3);
  assert.equal(schedulePurchaseTrips({ ...plan, endTs: startTs + 6000 }).trips, 1);
});

test("every in-stock arrival qualifies, including repeat trips late in the window", () => {
  const plan = {
    segments: [{ start_ts: 1000, end_ts: 3400, start_qty: 40, rate: 1 }],
    startTs: 1000, endTs: 3400, flightSec: 300,
  };
  // Arrivals on 1300, 1900, 2500 and 3100 all precede depletion at 3400.
  assert.deepEqual(schedulePurchaseTrips(plan), { trips: 4, waitingSec: 0 });
  assert.deepEqual(schedulePurchaseTrips({ ...plan, flightSec: 2400, endTs: 3500 }), { trips: 0, waitingSec: 0 });
});

test("the workday forecast includes a restock exactly at the return departure cutoff", () => {
  const startTs = 1000;
  const plan = {
    stock: { snapshot_ts: startTs, quantity: 0 },
    averages: { restockSec: 3600, rate: 1, restockQty: 20 },
    startTs, workdayHours: 1, flightSec: 1800,
    simulatePredictions: (startTs, endTs, startQty, averages, nowTs) => simulateStockPredictions({
      startTs, endTs, startQty, averages, nowTs, rateForCycle: () => 1,
    }),
  };
  assert.deepEqual(planWorkdayTrips(plan), { trips: 1, waitingSec: 1800 });
});
