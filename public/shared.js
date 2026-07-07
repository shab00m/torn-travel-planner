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
  stockoutTiming: "avg", // "avg" | "min" | "max"
  rateTiming: "avg", // "avg" | "min" | "max"
  item: null, // { country, itemId, name } on the item detail page
  rangeHours: 24,
  predictionHours: 0,
  timeFormat: "european",
  predictedEvents: [],
  safeWindows: [],
  chartOffsetSec: 0,
  chartScale: 1,
  lastTimeline: null,
  travelType: "Standard",
  travelCapacity: 5,
  activeTravel: null, // { flyingToCountry, arriveTs } when logged in and in flight
};

const PREFS_KEY = "plannerPrefs";
const TRAVEL_TYPES = ["Standard", "Airstrip", "Private", "Business"];
const BASE_TRAVEL_CAPACITY = { Standard: 5, Airstrip: 15, Private: 15, Business: 15 };
const SAMPLE_OPTIONS = [1, 3, 5, 10, 20];
const RANGE_HOURS_OPTIONS = [1, 6, 24, 168, 0];
const PREDICTION_HOURS_OPTIONS = [0, 1, 2, 3, 6, 12, 24];
const TIME_FORMATS = ["european", "us"];

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

function applyTravelSettings(prefs) {
  state.travelType = TRAVEL_TYPES.includes(prefs.travelType) ? prefs.travelType : "Standard";
  const cap = Number.parseInt(prefs.travelCapacity, 10);
  state.travelCapacity =
    Number.isInteger(cap) && cap > 0 ? cap : BASE_TRAVEL_CAPACITY[state.travelType];
}

function applyStoredPrefs() {
  const prefs = loadPrefs();
  applyTravelSettings(prefs);
  state.rangeHours = pickOption(prefs.rangeHours, RANGE_HOURS_OPTIONS, 24);
  state.predictionHours = pickOption(prefs.predictionHours, PREDICTION_HOURS_OPTIONS, 0);
  state.avgSamples = pickOption(prefs.avgSamples, SAMPLE_OPTIONS, 5);
  state.avgRateSamples = pickOption(prefs.avgRateSamples, SAMPLE_OPTIONS, 5);
  state.stockoutTiming = ["avg", "min", "max"].includes(prefs.stockoutTiming)
    ? prefs.stockoutTiming
    : "avg";
  state.rateTiming = ["avg", "min", "max"].includes(prefs.rateTiming) ? prefs.rateTiming : "avg";
  state.search = typeof prefs.search === "string" ? prefs.search : "";
  state.countryFilter = typeof prefs.countryFilter === "string" ? prefs.countryFilter : "";
  state.inStockOnly = prefs.inStockOnly === true;
  state.timeFormat = TIME_FORMATS.includes(prefs.timeFormat) ? prefs.timeFormat : "european";
}

function syncHourButtons(container, hours) {
  if (!container) return;
  container.querySelectorAll("button[data-hours]").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.hours) === hours);
  });
}

applyStoredPrefs();

function timeLocale() {
  return state.timeFormat === "us" ? "en-US" : "en-GB";
}

const fmtNum = (n) => n.toLocaleString("en-US");
const fmtMoney = (n) => "$" + fmtNum(n);
const fmtTime = (ts) =>
  new Date(ts * 1000).toLocaleString(timeLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const fmtTimeShort = (ts) =>
  new Date(ts * 1000).toLocaleTimeString(timeLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: state.timeFormat === "us",
  });

function chartTimeDisplayFormats() {
  if (state.timeFormat === "us") {
    return {
      minute: "h:mm a",
      hour: "MMM d, h:mm a",
      day: "MMM d",
    };
  }
  return {
    minute: "HH:mm",
    hour: "MMM d HH:mm",
    day: "MMM d",
  };
}

function setTimeFormat(format) {
  if (!TIME_FORMATS.includes(format) || state.timeFormat === format) return;
  state.timeFormat = format;
  savePrefs({ timeFormat: format });
  syncTimeFormatButtons();
  window.dispatchEvent(new CustomEvent("timeformatchange"));
}

function syncTimeFormatButtons() {
  document.querySelectorAll(".time-format-buttons [data-time-format]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.timeFormat === state.timeFormat);
  });
}

function initTimeFormatControls() {
  syncTimeFormatButtons();
  document.querySelectorAll(".time-format-buttons").forEach((container) => {
    if (container.dataset.bound) return;
    container.dataset.bound = "1";
    container.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-time-format]");
      if (!btn) return;
      setTimeFormat(btn.dataset.timeFormat);
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTimeFormatControls);
} else {
  initTimeFormatControls();
}

async function fetchJson(url) {
  const res = await fetch(url);
  return parseFetchResponse(res);
}

async function parseFetchResponse(res) {
  const text = await res.text();
  if (text.startsWith("<!DOCTYPE") || text.startsWith("<!")) {
    throw new Error(
      `API not available (HTTP ${res.status}). Restart the server after updating the app.`
    );
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Invalid API response (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function fetchJsonWithBody(url, { method, body }) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseFetchResponse(res);
}

async function loadCountries() {
  state.countries = await fetchJson("/api/countries");
  return state.countries;
}

function itemUrl(country, itemId, name) {
  return itemStockUrl(country, itemId, name);
}

function itemStockUrl(country, itemId, name) {
  return `/item/${country}/${itemId}?name=${encodeURIComponent(name)}`;
}

function itemPriceUrl(country, itemId, name) {
  return `/item/${country}/${itemId}/price?name=${encodeURIComponent(name)}`;
}

function parseItemFromPath(pathname = window.location.pathname) {
  const m = pathname.match(/^\/item\/([^/]+)\/(\d+)(?:\/price)?\/?$/);
  if (!m) return null;
  return {
    country: m[1],
    itemId: Number.parseInt(m[2], 10),
    name: new URLSearchParams(window.location.search).get("name") || "Item",
    view: pathname.includes("/price") ? "price" : "stock",
  };
}

function renderItemViewNav(activeView) {
  const nav = document.getElementById("item-view-nav");
  if (!nav || !state.item) return;
  const { country, itemId, name } = state.item;
  nav.innerHTML = `
    <a href="${itemStockUrl(country, itemId, name)}" class="${activeView === "stock" ? "active" : ""}">Stock</a>
    <a href="${itemPriceUrl(country, itemId, name)}" class="${activeView === "price" ? "active" : ""}">Buy price</a>
  `;
}

function setupItemHeader(item, activeView) {
  state.item = item;
  const meta = state.countries[item.country];
  const titleEl = document.getElementById("item-title");
  const subtitleEl = document.getElementById("item-subtitle");
  if (titleEl) titleEl.textContent = item.name;
  if (subtitleEl) subtitleEl.textContent = `${meta.flag} ${meta.name}`;
  document.title = `${item.name} — Torn Travel Planner`;
  renderItemViewNav(activeView);
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

const SELL_PRICES_KEY = "sellPrices";

function getSellPrice(country, itemId) {
  const all = JSON.parse(localStorage.getItem(SELL_PRICES_KEY) || "{}");
  const v = all[`${country}:${itemId}`];
  return typeof v === "number" && v >= 0 ? v : null;
}

function setSellPrice(country, itemId, price) {
  const all = JSON.parse(localStorage.getItem(SELL_PRICES_KEY) || "{}");
  const key = `${country}:${itemId}`;
  if (price == null) delete all[key];
  else all[key] = price;
  localStorage.setItem(SELL_PRICES_KEY, JSON.stringify(all));
}
