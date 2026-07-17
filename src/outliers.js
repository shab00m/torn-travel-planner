/** Minimum non-ignored samples before outlier checks run. */
export const MIN_OUTLIER_SAMPLES = 5;

/**
 * Modified Z-score cutoff. Lower than the textbook 3.5 so a tight cluster
 * (e.g. 55–65m) also drops near-misses like 44m or 50m — including the
 * "ten records at ~55m, one at 50m" case.
 */
export const MAD_THRESHOLD = 1.5;

/**
 * Floor for MAD so a nearly-flat cluster does not treat normal poll jitter
 * as infinite-sigma outliers. Two minutes matches typical YATA spacing.
 */
export const MIN_MAD_SEC = 2 * 60;

/**
 * @param {number[]} values
 * @returns {number|null}
 */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median absolute deviation from the median.
 * @param {number[]} values
 * @returns {number|null}
 */
export function mad(values) {
  const med = median(values);
  if (med == null) return null;
  return median(values.map((v) => Math.abs(v - med)));
}

/**
 * Robust modified Z-score. Positive means above the median.
 * @param {number} value
 * @param {number[]} baseline
 * @returns {number|null}
 */
export function modifiedZScore(value, baseline) {
  if (baseline.length < MIN_OUTLIER_SAMPLES || !Number.isFinite(value)) return null;
  const med = median(baseline);
  if (med == null) return null;
  const deviation = Math.max(mad(baseline) ?? 0, MIN_MAD_SEC);
  return (0.6745 * (value - med)) / deviation;
}

/**
 * Empty-for outside this item's usual cluster (robust modified Z-score).
 * @param {number} duration
 * @param {number[]} baselineDurations other completed durations (exclude the candidate)
 */
export function isDurationOutlier(duration, baselineDurations) {
  if (duration == null || !Number.isFinite(duration) || duration < 0) return false;
  const z = modifiedZScore(duration, baselineDurations);
  return z != null && Math.abs(z) > MAD_THRESHOLD;
}

/**
 * Decide whether a completed cycle should be excluded from averages.
 * Rate follows automatically — ignored cycles are dropped from rate windows too.
 * @param {{ duration?: number|null }} cycle
 * @param {{ durations: number[] }} baseline values excluding this cycle
 */
export function isCycleOutlier(cycle, baseline) {
  return isDurationOutlier(cycle.duration, baseline.durations);
}
