import test from "node:test";
import assert from "node:assert/strict";
import { isCycleOutlier } from "../src/outliers.js";

const baseline = { durations: [600, 601, 599, 602, 598, 600] };

test("manual empty-for window overrides the historical cluster, with inclusive endpoints", () => {
  const bounds = { minEmptyFor: 600, maxEmptyFor: 1800 };
  assert.equal(isCycleOutlier({ duration: 1800 }, baseline), true);
  for (const duration of [600, 1200, 1800]) {
    assert.equal(isCycleOutlier({ duration }, baseline, bounds), false);
  }
  for (const duration of [599, 1801]) {
    assert.equal(isCycleOutlier({ duration }, { durations: [] }, bounds), true);
  }
});

test("range exclusion uses adjusted duration when available and observed duration otherwise", () => {
  const bounds = { minEmptyFor: 500, maxEmptyFor: 700 };
  assert.equal(isCycleOutlier({ duration: 600, adjusted_duration: 701 }, baseline, bounds), true);
  assert.equal(isCycleOutlier({ duration: 800, adjusted_duration: 600 }, baseline, bounds), false);
  assert.equal(isCycleOutlier({ duration: 800, adjusted_duration: null }, baseline, bounds), true);
  assert.equal(isCycleOutlier({ duration: null }, baseline, bounds), false);
});

test("unset bounds retain cluster detection; a single bound only limits its configured side", () => {
  assert.equal(isCycleOutlier({ duration: 1800 }, baseline, { minEmptyFor: null, maxEmptyFor: null }), true);
  assert.equal(isCycleOutlier({ duration: 1800 }, { durations: [] }), false);
  assert.equal(isCycleOutlier({ duration: 1800 }, baseline, { minEmptyFor: 600 }), false);
  assert.equal(isCycleOutlier({ duration: 599 }, baseline, { minEmptyFor: 600 }), true);
  assert.equal(isCycleOutlier({ duration: 601 }, baseline, { maxEmptyFor: 600 }), true);
});
