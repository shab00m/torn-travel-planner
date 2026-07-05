// Shared app state and helpers used by the dashboard and item detail pages.
const state = {
  countries: {},
  stocks: null,
  search: "",
  countryFilter: "",
  inStockOnly: false,
  chart: null,
  chartPoints: [],
  restocks: [],
  rates: [],
  avgSamples: 5,
  avgRateSamples: 5,
  item: null, // { country, itemId, name } on the item detail page
  rangeHours: 24,
  predictionHours: 0,
  predictedEvents: [],
  travelType: "Standard",
};

const PREFS_KEY = "plannerPrefs";
const SAMPLE_OPTIONS = [1, 3, 5, 10, 20];
const RANGE_HOURS_OPTIONS = [1, 6, 24, 168, 0];
const PREDICTION_HOURS_OPTIONS = [0, 1, 2, 3, 6, 12, 24];

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePrefs(updates) {
  localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...updates }));
}

function pickOption(value, options, fallback) {
  const n = Number(value);
  return options.includes(n) ? n : fallback;
}

function applyStoredPrefs() {
  const prefs = loadPrefs();
  state.rangeHours = pickOption(prefs.rangeHours, RANGE_HOURS_OPTIONS, 24);
  state.predictionHours = pickOption(prefs.predictionHours, PREDICTION_HOURS_OPTIONS, 0);
  state.avgSamples = pickOption(prefs.avgSamples, SAMPLE_OPTIONS, 5);
  state.avgRateSamples = pickOption(prefs.avgRateSamples, SAMPLE_OPTIONS, 5);
  state.search = typeof prefs.search === "string" ? prefs.search : "";
  state.countryFilter = typeof prefs.countryFilter === "string" ? prefs.countryFilter : "";
  state.inStockOnly = prefs.inStockOnly === true;
}

function syncHourButtons(container, hours) {
  if (!container) return;
  container.querySelectorAll("button[data-hours]").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.hours) === hours);
  });
}

applyStoredPrefs();

const fmtNum = (n) => n.toLocaleString("en-US");
const fmtMoney = (n) => "$" + fmtNum(n);
const fmtTime = (ts) => new Date(ts * 1000).toLocaleString();
const fmtTimeShort = (ts) =>
  new Date(ts * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function loadCountries() {
  state.countries = await fetchJson("/api/countries");
  return state.countries;
}

function itemUrl(country, itemId, name) {
  return `/item/${country}/${itemId}?name=${encodeURIComponent(name)}`;
}

const RESTOCK_AMOUNTS_KEY = "restockAmounts";

function getRestockAmount(country, itemId) {
  const all = JSON.parse(localStorage.getItem(RESTOCK_AMOUNTS_KEY) || "{}");
  const v = all[`${country}:${itemId}`];
  return typeof v === "number" && v > 0 ? v : null;
}

function setRestockAmount(country, itemId, amount) {
  const all = JSON.parse(localStorage.getItem(RESTOCK_AMOUNTS_KEY) || "{}");
  const key = `${country}:${itemId}`;
  if (amount == null) delete all[key];
  else all[key] = amount;
  localStorage.setItem(RESTOCK_AMOUNTS_KEY, JSON.stringify(all));
}
