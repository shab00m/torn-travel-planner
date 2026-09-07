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

/** Display seconds as `h:mm:ss` (hours unpadded; minutes and seconds always two digits). */
export function formatEmptyForHms(sec) {
  if (sec == null) return "";
  if (!Number.isInteger(sec) || sec < 0) {
    throw new Error("empty-for duration must be a non-negative integer (seconds)");
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Parse an `h:mm:ss` input. Blank → null. Invalid → throws. */
export function parseEmptyForHmsInput(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const match = String(raw).trim().match(/^(\d+):([0-5]?\d):([0-5]?\d)$/);
  if (!match) {
    throw new Error("empty-for range must be h:mm:ss");
  }
  const h = Number.parseInt(match[1], 10);
  const m = Number.parseInt(match[2], 10);
  const s = Number.parseInt(match[3], 10);
  if (m > 59 || s > 59) {
    throw new Error("empty-for range must be h:mm:ss");
  }
  return h * 3600 + m * 60 + s;
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
