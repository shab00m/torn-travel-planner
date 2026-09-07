// Per country/item graph and item-page settings (localStorage).
const ITEM_SETTINGS_KEY = "plannerItemSettings";
const ITEM_CHART_TYPES = ["stock", "empty-for", "rate-tod", "buy-price"];
const TIMING_OPTIONS = ["avg", "min", "max"];

const itemViewportRestore = {
  useSaved: false,
  followLive: false,
};

function loadAllItemSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ITEM_SETTINGS_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function loadItemSettings(country, itemId) {
  const raw = loadAllItemSettings()[restockAmountKey(country, itemId)];
  return raw && typeof raw === "object" ? raw : {};
}

function writeItemSettings(country, itemId, settings) {
  const all = loadAllItemSettings();
  all[restockAmountKey(country, itemId)] = settings;
  localStorage.setItem(ITEM_SETTINGS_KEY, JSON.stringify(all));
}

function optionalFiniteNumber(value, { min = null } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (min != null && n < min) return null;
  return n;
}

function pickTiming(value, fallback) {
  return TIMING_OPTIONS.includes(value) ? value : fallback;
}

function normalizeItemSettings(raw, fallback = {}) {
  const src = { ...fallback, ...raw };
  const maxAge = Number.parseInt(src.historicalRateMaxAgeDays, 10);
  return {
    rangeHours: pickOption(src.rangeHours, RANGE_HOURS_OPTIONS, 24),
    predictionHours: pickOption(src.predictionHours, PREDICTION_HOURS_OPTIONS, 6),
    avgSamples: pickOption(src.avgSamples, SAMPLE_OPTIONS, 5),
    avgRateSamples: pickOption(src.avgRateSamples, SAMPLE_OPTIONS, 3),
    stockoutTiming: pickTiming(src.stockoutTiming, "avg"),
    rateTiming: pickTiming(src.rateTiming, "avg"),
    historicalRatePrediction: src.historicalRatePrediction === true,
    historicalRateMaxAgeDays: Number.isInteger(maxAge) && maxAge > 0 ? maxAge : null,
    safeWindowUseRateSelection: src.safeWindowUseRateSelection !== false,
    flightTimeVariance: src.flightTimeVariance !== false,
    chartType: ITEM_CHART_TYPES.includes(src.chartType) ? src.chartType : "stock",
    chartOffsetSec: optionalFiniteNumber(src.chartOffsetSec, { min: 0 }),
    chartScale: optionalFiniteNumber(src.chartScale, { min: Number.MIN_VALUE }),
    chartFollowLive: src.chartFollowLive === true,
    emptyForOffsetSec: optionalFiniteNumber(src.emptyForOffsetSec, { min: 0 }),
    emptyForScale: optionalFiniteNumber(src.emptyForScale, { min: Number.MIN_VALUE }),
    emptyForAxesSwapped: src.emptyForAxesSwapped === true,
    emptyForShowExcluded: src.emptyForShowExcluded !== false,
  };
}

function itemSettingsFor(country, itemId) {
  if (country == null || itemId == null) return normalizeItemSettings({}, loadPrefs());
  return normalizeItemSettings(loadItemSettings(country, itemId), loadPrefs());
}

function isStockChartFollowingLive() {
  const timeline = state.lastTimeline;
  if (!timeline || typeof getMaxChartOffsetSec !== "function") return true;
  return state.chartOffsetSec >= getMaxChartOffsetSec(timeline, state.chartScale) - 0.5;
}

function collectLiveChartFields() {
  const fields = {
    chartFollowLive: isStockChartFollowingLive(),
  };
  if (Number.isFinite(state.chartScale) && state.chartScale > 0) {
    fields.chartScale = state.chartScale;
    fields.chartOffsetSec = state.chartOffsetSec;
  }
  if (typeof itemChartViewUi !== "undefined") {
    fields.chartType = itemChartViewUi.type;
  }
  if (typeof emptyForChartUi !== "undefined") {
    fields.emptyForAxesSwapped = emptyForChartUi.axesSwapped;
    fields.emptyForShowExcluded = emptyForChartUi.showExcluded;
    if (emptyForChartUi.scale != null) {
      fields.emptyForOffsetSec = emptyForChartUi.offsetSec;
      fields.emptyForScale = emptyForChartUi.scale;
    }
  }
  return fields;
}

function saveCurrentItemSettings(updates = {}) {
  if (!state.item) return;
  const { country, itemId } = state.item;
  const next = normalizeItemSettings({
    ...itemSettingsFor(country, itemId),
    ...collectLiveChartFields(),
    ...updates,
  });
  writeItemSettings(country, itemId, next);
}

function applyItemSettingsToState(settings) {
  state.rangeHours = settings.rangeHours;
  state.predictionHours = settings.predictionHours;
  state.avgSamples = settings.avgSamples;
  state.avgRateSamples = settings.avgRateSamples;
  state.stockoutTiming = settings.stockoutTiming;
  state.rateTiming = settings.rateTiming;
  state.historicalRatePrediction = settings.historicalRatePrediction;
  state.historicalRateMaxAgeDays = settings.historicalRateMaxAgeDays;
  state.safeWindowUseRateSelection = settings.safeWindowUseRateSelection;
  state.flightTimeVariance = settings.flightTimeVariance;
}

function applySavedItemChartUi(settings) {
  if (typeof emptyForChartUi !== "undefined") {
    emptyForChartUi.axesSwapped = settings.emptyForAxesSwapped;
    emptyForChartUi.showExcluded = settings.emptyForShowExcluded;
    if (settings.emptyForScale != null) {
      emptyForChartUi.scale = settings.emptyForScale;
      emptyForChartUi.offsetSec = settings.emptyForOffsetSec ?? 0;
    }
    if (typeof emptyForChartEl !== "undefined" && emptyForChartEl.showExcluded) {
      emptyForChartEl.showExcluded.checked = settings.emptyForShowExcluded;
    }
  }
  if (typeof setItemChartType === "function") {
    setItemChartType(settings.chartType, { persist: false });
  }
}

function applyItemPageSettings(country, itemId) {
  const settings = itemSettingsFor(country, itemId);
  applyItemSettingsToState(settings);
  if (settings.chartScale != null) {
    state.chartScale = settings.chartScale;
    state.chartOffsetSec = settings.chartOffsetSec ?? 0;
    itemViewportRestore.useSaved = true;
    itemViewportRestore.followLive = settings.chartFollowLive === true;
  } else {
    itemViewportRestore.useSaved = false;
    itemViewportRestore.followLive = false;
  }
  applySavedItemChartUi(settings);
  return settings;
}
