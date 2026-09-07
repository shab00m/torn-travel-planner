/**
 * Per-item min/max empty-for bounds (seconds).
 * Used by the item page, outlier flagging, and safe-window stockout MIN/MAX.
 */

/** Effective empty-for for range checks and MIN/MAX (adjusted, else observed). */
export function emptyForDurationSec(cycle) {
  const duration = cycle?.adjusted_duration ?? cycle?.duration;
  return duration != null && Number.isFinite(duration) ? duration : null;
}

/**
 * True when duration sits outside the configured [min, max] band.
 * Unset bounds are ignored.
 */
export function isOutsideEmptyForRange(durationSec, minEmptyFor, maxEmptyFor) {
  if (durationSec == null || !Number.isFinite(durationSec)) return false;
  if (minEmptyFor != null && durationSec < minEmptyFor) return true;
  if (maxEmptyFor != null && durationSec > maxEmptyFor) return true;
  return false;
}

/** Parse a bound from JSON/DB. Empty → null. Rejects negatives and non-integers. */
export function parseEmptyForBoundSec(value) {
  if (value == null || value === "") return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("empty-for bounds must be non-negative integers (seconds)");
  }
  return n;
}

/** Normalize a pair of bounds; throws when min > max. */
export function normalizeEmptyForBounds({ minEmptyFor, maxEmptyFor } = {}) {
  const min = parseEmptyForBoundSec(minEmptyFor);
  const max = parseEmptyForBoundSec(maxEmptyFor);
  if (min != null && max != null && min > max) {
    throw new Error("minEmptyFor must be <= maxEmptyFor");
  }
  return { minEmptyFor: min, maxEmptyFor: max };
}

export function emptyForSecToMinutes(sec) {
  if (sec == null) return null;
  return Math.round(sec / 60);
}

export function emptyForMinutesToSec(minutes) {
  if (minutes == null) return null;
  return minutes * 60;
}

/** Parse a minutes input field. Blank → null. Invalid → throws. */
export function parseEmptyForMinutesInput(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("empty-for minutes must be a non-negative integer");
  }
  return emptyForMinutesToSec(n);
}

/**
 * Overlay configured min/max onto extents computed from history.
 * Configured values win when set.
 */
export function applyConfiguredEmptyForExtents(computed, bounds) {
  return {
    ...computed,
    minEmptyFor: bounds?.minEmptyFor ?? computed.minEmptyFor ?? null,
    maxEmptyFor: bounds?.maxEmptyFor ?? computed.maxEmptyFor ?? null,
  };
}
