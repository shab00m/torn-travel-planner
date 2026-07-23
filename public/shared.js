// Shared app state and helpers used by the dashboard and item detail pages.
const state = {
  countries: {},
  stocks: null,
  search: "",
  countryFilters: [], // string[] — empty = all countries
  inStockOnly: false,
  showHidden: false,
  itemTypeFilters: [], // string[] — empty = all types
  stockGroupBy: "country", // "country" | "type" | "none"
  profitMin: null, // number | null — profit/hr lower bound
  profitMax: null, // number | null — profit/hr upper bound
  maxBudget: null, // number | null — cap purchase qty so total cost stays under this
  itemTypes: null, // { [itemId]: typeString } from items.item_type via /api/item-types
  itemTypesStatus: null, // null | "empty" | "ready" | "error"
  chart: null,
  chartPoints: [],
  restocks: [],
  rates: [],
  avgSamples: 5,
  avgRateSamples: 3,
  stockoutTiming: "avg", // "avg" | "min" | "max"
  rateTiming: "avg", // "avg" | "min" | "max"
  safeWindowUseRateSelection: true,
  item: null, // { country, itemId, name } on the item detail page
  rangeHours: 24,
  predictionHours: 6,
  timeFormat: "european",
  timeZone: "local", // "local" | "tct" (Torn City Time = UTC)
  flightTimeVariance: true,
  predictedEvents: [],
  chartOffsetSec: 0,
  chartScale: 1,
  lastTimeline: null,
  travelType: "Standard",
  travelCapacity: 5,
  activeTravel: null, // { flyingToCountry, arriveTs } when logged in and in flight
  marketPrices: null, // { [itemId]: number | null } from /api/markets
  marketPricesFetchedAt: null, // { [itemId]: unix ts }
  marketPricesStatus: null, // null | "empty" | "ready" | "error"
  marketCacheTtlSec: 300,
  // Item page: compound safe-window array. Favorites: { "mex:123": { available, safeWindow, reason } }.
  safeWindows: {},
  safeWindowsStatus: null, // null | "loading" | "ready" | "error"
  favoritesSort: { column: "item", dir: "asc" },
  stocksSort: { column: "item", dir: "asc" },
  restockAmounts: {}, // { "uni:206": 5000 } from /api/restock-amounts
};

const SORT_COLUMNS = ["item", "stock", "cost", "items", "totalCost", "profit", "safeWindow", "leaveBy"];
const STOCK_SORT_COLUMNS = ["item", "stock", "cost", "items", "totalCost", "profit", "country", "type"];
const STOCK_GROUP_BY_OPTIONS = ["country", "type", "none"];

function parseOptionalNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseSortPref(value, allowedColumns, fallback) {
  if (
    value &&
    allowedColumns.includes(value.column) &&
    (value.dir === "asc" || value.dir === "desc")
  ) {
    return { column: value.column, dir: value.dir };
  }
  return fallback;
}

/** Normalize multi-select prefs; also migrates legacy single-string values. */
function parseStringListPref(value, legacyValue) {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === "string" && v);
  }
  if (typeof legacyValue === "string" && legacyValue) return [legacyValue];
  return [];
}

const PREFS_KEY = "plannerPrefs";
const TRAVEL_TYPES = ["Standard", "Airstrip", "Private", "Business"];
const BASE_TRAVEL_CAPACITY = { Standard: 5, Airstrip: 15, Private: 15, Business: 15 };
const SAMPLE_OPTIONS = [1, 3, 5, 10, 20];
const RANGE_HOURS_OPTIONS = [1, 6, 24, 168, 0];
const PREDICTION_HOURS_OPTIONS = [0, 1, 2, 3, 6, 12, 24];
const TIME_FORMATS = ["european", "us"];
const TIME_ZONES = ["local", "tct"];
const FLIGHT_TIME_VARIANCE = 0.03;

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
  state.predictionHours = pickOption(prefs.predictionHours, PREDICTION_HOURS_OPTIONS, 6);
  state.avgSamples = pickOption(prefs.avgSamples, SAMPLE_OPTIONS, 5);
  state.avgRateSamples = pickOption(prefs.avgRateSamples, SAMPLE_OPTIONS, 3);
  state.stockoutTiming = ["avg", "min", "max"].includes(prefs.stockoutTiming)
    ? prefs.stockoutTiming
    : "avg";
  state.rateTiming = ["avg", "min", "max"].includes(prefs.rateTiming) ? prefs.rateTiming : "avg";
  state.safeWindowUseRateSelection = prefs.safeWindowUseRateSelection !== false;
  state.search = typeof prefs.search === "string" ? prefs.search : "";
  state.countryFilters = parseStringListPref(prefs.countryFilters, prefs.countryFilter);
  state.inStockOnly = prefs.inStockOnly === true;
  state.showHidden = prefs.showHidden === true;
  state.itemTypeFilters = parseStringListPref(prefs.itemTypeFilters, prefs.itemTypeFilter);
  state.stockGroupBy = STOCK_GROUP_BY_OPTIONS.includes(prefs.stockGroupBy)
    ? prefs.stockGroupBy
    : "country";
  state.profitMin = parseOptionalNumber(prefs.profitMin);
  state.profitMax = parseOptionalNumber(prefs.profitMax);
  const budget = parseOptionalNumber(prefs.maxBudget);
  state.maxBudget = budget != null && budget >= 0 ? budget : null;
  state.timeFormat = TIME_FORMATS.includes(prefs.timeFormat) ? prefs.timeFormat : "european";
  state.timeZone = TIME_ZONES.includes(prefs.timeZone) ? prefs.timeZone : "local";
  state.flightTimeVariance = prefs.flightTimeVariance !== false;
  state.favoritesSort = parseSortPref(prefs.favoritesSort, SORT_COLUMNS, state.favoritesSort);
  state.stocksSort = parseSortPref(prefs.stocksSort, STOCK_SORT_COLUMNS, state.stocksSort);
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

/** Intl timeZone option: UTC for TCT, omit for browser local. */
function displayTimeZone() {
  return state.timeZone === "tct" ? "UTC" : undefined;
}

function withDisplayTimeZone(options) {
  const timeZone = displayTimeZone();
  return timeZone ? { ...options, timeZone } : options;
}

const fmtNum = (n) => n.toLocaleString("en-US");
const fmtMoney = (n) => "$" + fmtNum(n);
const fmtTime = (ts) =>
  new Date(ts * 1000).toLocaleString(
    timeLocale(),
    withDisplayTimeZone({
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  );
const fmtTimeShort = (ts) =>
  new Date(ts * 1000).toLocaleTimeString(
    timeLocale(),
    withDisplayTimeZone({
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: state.timeFormat === "us",
    })
  );

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

/** Format a chart axis tick in the selected display timezone. */
function formatChartTick(ms, unit) {
  const date = new Date(ms);
  if (unit === "minute") {
    return date.toLocaleTimeString(
      timeLocale(),
      withDisplayTimeZone({
        hour: "2-digit",
        minute: "2-digit",
        hour12: state.timeFormat === "us",
      })
    );
  }
  if (unit === "day") {
    return date.toLocaleDateString(
      timeLocale(),
      withDisplayTimeZone({
        month: "short",
        day: "numeric",
      })
    );
  }
  return date.toLocaleString(
    timeLocale(),
    withDisplayTimeZone({
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: state.timeFormat === "us",
    })
  );
}

/** Chart.js tick callback; reads current time.unit so pan/zoom stays correct. */
function chartTimeTickCallback(value) {
  const unit = this.options?.time?.unit || "hour";
  return formatChartTick(value, unit);
}

function notifyTimeDisplayChange() {
  window.dispatchEvent(new CustomEvent("timeformatchange"));
}

function setTimeFormat(format) {
  if (!TIME_FORMATS.includes(format) || state.timeFormat === format) return;
  state.timeFormat = format;
  savePrefs({ timeFormat: format });
  syncTimeFormatButtons();
  notifyTimeDisplayChange();
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

function setTimeZone(zone) {
  if (!TIME_ZONES.includes(zone) || state.timeZone === zone) return;
  state.timeZone = zone;
  savePrefs({ timeZone: zone });
  syncTimeZoneButtons();
  notifyTimeDisplayChange();
}

function syncTimeZoneButtons() {
  document.querySelectorAll(".time-zone-buttons [data-time-zone]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.timeZone === state.timeZone);
  });
}

function initTimeZoneControls() {
  syncTimeZoneButtons();
  document.querySelectorAll(".time-zone-buttons").forEach((container) => {
    if (container.dataset.bound) return;
    container.dataset.bound = "1";
    container.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-time-zone]");
      if (!btn) return;
      setTimeZone(btn.dataset.timeZone);
    });
  });
}

const SETTINGS_OPEN_KEY = "plannerSettingsOpen";

function isSettingsOpen() {
  return localStorage.getItem(SETTINGS_OPEN_KEY) === "1";
}

function setSettingsOpen(open) {
  localStorage.setItem(SETTINGS_OPEN_KEY, open ? "1" : "0");
  const panel = document.getElementById("settings-panel");
  const toggle = document.getElementById("settings-toggle");
  if (panel) panel.classList.toggle("hidden", !open);
  if (toggle) {
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.classList.toggle("active", open);
  }
}

function siteSettingsPanelHtml() {
  return `
    <div id="settings-panel" class="settings-panel hidden">
      <div id="guest-travel" class="guest-travel settings-group">
        <span class="settings-group-title">Travel (guest)</span>
        <div class="settings-group-controls">
          <label class="guest-travel-field" title="Flight travel type">
            <span class="guest-travel-label">Flight</span>
            <select id="guest-travel-type">
              <option value="Standard">🎫 Standard</option>
              <option value="Airstrip">🛩️ Airstrip</option>
              <option value="Private">✈️ Private</option>
              <option value="Business">💼 Business</option>
            </select>
          </label>
          <label class="guest-travel-field" title="Travel item inventory slots">
            <span class="guest-travel-label">🧳</span>
            <input id="guest-capacity" type="number" min="1" max="50" step="1" />
            <span class="guest-travel-suffix">slots</span>
          </label>
        </div>
      </div>
      <div class="time-format-setting settings-group">
        <span class="settings-group-title">Time format</span>
        <div class="settings-group-controls">
          <div class="range-buttons time-format-buttons">
            <button type="button" data-time-format="european">24h</button>
            <button type="button" data-time-format="us">12h</button>
          </div>
        </div>
      </div>
      <div class="time-format-setting settings-group">
        <span class="settings-group-title">Time zone</span>
        <div class="settings-group-controls">
          <div class="range-buttons time-zone-buttons">
            <button type="button" data-time-zone="local" title="Your device's local time">Local</button>
            <button type="button" data-time-zone="tct" title="Torn City Time (UTC)">TCT</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function injectSiteSettings() {
  const header = document.querySelector("header");
  const headerMeta = document.querySelector(".header-meta");
  if (!header || !headerMeta || document.getElementById("settings-toggle")) return;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = "settings-toggle";
  toggle.className = "settings-toggle";
  toggle.setAttribute("aria-controls", "settings-panel");
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = "Settings";
  const auth = headerMeta.querySelector("#auth");
  if (auth) {
    auth.insertAdjacentElement("afterend", toggle);
  } else {
    headerMeta.appendChild(toggle);
  }

  const wrap = document.createElement("div");
  wrap.innerHTML = siteSettingsPanelHtml().trim();
  const panel = wrap.firstElementChild;
  header.appendChild(panel);

  toggle.addEventListener("click", () => {
    setSettingsOpen(!isSettingsOpen());
  });

  setSettingsOpen(isSettingsOpen());
}

function initSharedUi() {
  injectSiteSettings();
  initTimeFormatControls();
  initTimeZoneControls();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSharedUi);
} else {
  initSharedUi();
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

async function fetchJsonWithBody(url, { method, body, headers } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return parseFetchResponse(res);
}

async function loadCountries() {
  state.countries = await fetchJson("/api/countries");
  return state.countries;
}

let lastKnownStockTimestamp = null;

/** YATA export cadence — matches server poll interval in src/yata.js. */
const STOCK_UPDATE_PERIOD_SEC = 60;
const STOCK_UPDATE_SLACK_SEC = 1;
const STOCK_UPDATE_FAST_POLL_MS = 5000;

function noteStockTimestamp(timestamp) {
  if (Number.isInteger(timestamp) && timestamp > 0) {
    lastKnownStockTimestamp = timestamp;
  }
}

/** Ms until shortly after the next expected YATA timestamp (period + slack). */
function msUntilExpectedStockUpdate(timestamp) {
  const nextAtMs = (timestamp + STOCK_UPDATE_PERIOD_SEC + STOCK_UPDATE_SLACK_SEC) * 1000;
  return Math.max(0, nextAtMs - Date.now());
}

/**
 * Watch for new YATA snapshots and run onUpdate when the server timestamp changes.
 * After a fresh timestamp, sleep until ~period+1s later; if the update is late,
 * poll every 5s until it arrives, then sleep again.
 */
function startStockUpdateWatcher(onUpdate) {
  let busy = false;
  let timer = null;
  let stopped = false;

  function schedule(delayMs) {
    if (stopped) return;
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, delayMs);
  }

  async function check() {
    if (busy || stopped) return;
    busy = true;
    try {
      const data = await fetchJson("/api/stocks/status");
      if (!data.ready || !Number.isInteger(data.timestamp)) {
        schedule(STOCK_UPDATE_FAST_POLL_MS);
        return;
      }

      if (lastKnownStockTimestamp === null) {
        noteStockTimestamp(data.timestamp);
        schedule(msUntilExpectedStockUpdate(data.timestamp));
        return;
      }

      if (lastKnownStockTimestamp === data.timestamp) {
        // Expected refresh not in yet — poll quickly until it appears.
        schedule(STOCK_UPDATE_FAST_POLL_MS);
        return;
      }

      lastKnownStockTimestamp = data.timestamp;
      await onUpdate(data.timestamp);
      schedule(msUntilExpectedStockUpdate(data.timestamp));
    } catch {
      // Transient errors: retry soon.
      schedule(STOCK_UPDATE_FAST_POLL_MS);
    } finally {
      busy = false;
    }
  }

  void check();
  return () => {
    stopped = true;
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
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
  initFavoriteToggle(document.getElementById("favorite-toggle"), item.country, item.itemId);
  initHideToggle(document.getElementById("hide-toggle"), item.country, item.itemId);
}

const LEGACY_RESTOCK_AMOUNTS_KEY = "restockAmounts";
const RESTOCK_AMOUNTS_MIGRATED_KEY = "restockAmountsMigrated";

function restockAmountKey(country, itemId) {
  return `${country}:${itemId}`;
}

function getRestockAmount(country, itemId) {
  const v = state.restockAmounts[restockAmountKey(country, itemId)];
  return typeof v === "number" && v > 0 ? v : null;
}

async function migrateLocalRestockAmounts() {
  if (localStorage.getItem(RESTOCK_AMOUNTS_MIGRATED_KEY)) return;
  const raw = localStorage.getItem(LEGACY_RESTOCK_AMOUNTS_KEY);
  if (!raw) {
    localStorage.setItem(RESTOCK_AMOUNTS_MIGRATED_KEY, "1");
    return;
  }
  let all;
  try {
    all = JSON.parse(raw);
  } catch {
    localStorage.removeItem(LEGACY_RESTOCK_AMOUNTS_KEY);
    localStorage.setItem(RESTOCK_AMOUNTS_MIGRATED_KEY, "1");
    return;
  }
  localStorage.removeItem(LEGACY_RESTOCK_AMOUNTS_KEY);
  for (const [key, amount] of Object.entries(all)) {
    if (typeof amount !== "number" || amount <= 0) continue;
    const sep = key.indexOf(":");
    if (sep <= 0) continue;
    const country = key.slice(0, sep);
    const itemId = Number.parseInt(key.slice(sep + 1), 10);
    if (!Number.isInteger(itemId) || itemId <= 0) continue;
    try {
      await fetchJsonWithBody(`/api/restock-amounts/${country}/${itemId}`, {
        method: "PUT",
        body: { amount },
      });
    } catch {
      // partial migration is fine; user can re-enter missing values
    }
  }
  localStorage.setItem(RESTOCK_AMOUNTS_MIGRATED_KEY, "1");
}

async function loadRestockAmounts() {
  await migrateLocalRestockAmounts();
  const data = await fetchJson("/api/restock-amounts");
  state.restockAmounts = data.amounts ?? {};
}

async function loadRestockAmountForItem(country, itemId) {
  const data = await fetchJson(`/api/restock-amounts/${country}/${itemId}`);
  if (data.amount != null) {
    state.restockAmounts[restockAmountKey(country, itemId)] = data.amount;
  }
}

async function setRestockAmount(country, itemId, amount) {
  const key = restockAmountKey(country, itemId);
  if (amount == null) {
    await fetchJsonWithBody(`/api/restock-amounts/${country}/${itemId}`, {
      method: "PUT",
      body: { amount: null },
    });
    delete state.restockAmounts[key];
  } else {
    const data = await fetchJsonWithBody(`/api/restock-amounts/${country}/${itemId}`, {
      method: "PUT",
      body: { amount },
    });
    state.restockAmounts[key] = data.amount;
  }
  clearSafeWindowsCache();
  window.dispatchEvent(new CustomEvent("restockamountchange"));
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

const FAVORITES_KEY = "favoriteItems";
const HIDDEN_ITEMS_KEY = "hiddenItems";

function favoriteItemKey(country, itemId) {
  return `${country}:${itemId}`;
}

function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) || "{}");
  } catch {
    return {};
  }
}

function isFavorite(country, itemId) {
  return getFavorites()[favoriteItemKey(country, itemId)] === true;
}

function toggleFavorite(country, itemId) {
  const all = getFavorites();
  const key = favoriteItemKey(country, itemId);
  if (all[key]) delete all[key];
  else all[key] = true;
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(all));
  window.dispatchEvent(new CustomEvent("favoriteschange"));
  return !!all[key];
}

function syncFavoriteButton(btn, country, itemId) {
  if (!btn) return;
  const fav = isFavorite(country, itemId);
  btn.classList.toggle("is-favorite", fav);
  btn.textContent = fav ? "★" : "☆";
  btn.title = fav ? "Remove from favorites" : "Add to favorites";
  btn.setAttribute("aria-pressed", String(fav));
}

function favoriteButtonHtml(country, itemId) {
  const fav = isFavorite(country, itemId);
  return `<button type="button" class="favorite-btn${fav ? " is-favorite" : ""}" data-country="${country}" data-item="${itemId}" title="${fav ? "Remove from favorites" : "Add to favorites"}" aria-pressed="${fav}">${fav ? "★" : "☆"}</button>`;
}

function initFavoriteToggle(btn, country, itemId) {
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  syncFavoriteButton(btn, country, itemId);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(country, itemId);
    syncFavoriteButton(btn, country, itemId);
  });
}

function getHiddenItems() {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_ITEMS_KEY) || "{}");
  } catch {
    return {};
  }
}

function isHidden(country, itemId) {
  return getHiddenItems()[favoriteItemKey(country, itemId)] === true;
}

function toggleHidden(country, itemId) {
  const all = getHiddenItems();
  const key = favoriteItemKey(country, itemId);
  if (all[key]) delete all[key];
  else all[key] = true;
  localStorage.setItem(HIDDEN_ITEMS_KEY, JSON.stringify(all));
  window.dispatchEvent(new CustomEvent("hiddenitemschange"));
  return !!all[key];
}

function syncHideButton(btn, country, itemId) {
  if (!btn) return;
  const hidden = isHidden(country, itemId);
  btn.classList.toggle("is-hidden", hidden);
  btn.textContent = hidden ? "⊕" : "⊖";
  btn.title = hidden ? "Show item in lists" : "Hide item from lists";
  btn.setAttribute("aria-pressed", String(hidden));
}

function hideButtonHtml(country, itemId) {
  const hidden = isHidden(country, itemId);
  return `<button type="button" class="hide-btn${hidden ? " is-hidden" : ""}" data-country="${country}" data-item="${itemId}" title="${hidden ? "Show item in lists" : "Hide item from lists"}" aria-pressed="${hidden}">${hidden ? "⊕" : "⊖"}</button>`;
}

function itemActionsHtml(country, itemId) {
  return `${favoriteButtonHtml(country, itemId)}${hideButtonHtml(country, itemId)}`;
}

function initHideToggle(btn, country, itemId) {
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  syncHideButton(btn, country, itemId);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleHidden(country, itemId);
    syncHideButton(btn, country, itemId);
  });
}

const SAFE_WINDOWS_CACHE_KEY = "safeWindowsCache";

function getSafeWindowsCache() {
  try {
    return JSON.parse(localStorage.getItem(SAFE_WINDOWS_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function clearSafeWindowsCache() {
  localStorage.removeItem(SAFE_WINDOWS_CACHE_KEY);
  state.safeWindows = {};
}

function saveSafeWindowsCache(windows) {
  const cache = getSafeWindowsCache();
  const favorites = getFavorites();
  for (const [key, value] of Object.entries(windows)) {
    if (favorites[key]) cache[key] = value;
  }
  for (const key of Object.keys(cache)) {
    if (!favorites[key]) delete cache[key];
  }
  localStorage.setItem(SAFE_WINDOWS_CACHE_KEY, JSON.stringify(cache));
}

function hydrateSafeWindowsFromCache() {
  const cache = getSafeWindowsCache();
  for (const key of Object.keys(getFavorites())) {
    if (cache[key]) state.safeWindows[key] = cache[key];
  }
}

function getFlightSec(country) {
  return (
    state.countries[country]?.flightSec?.[state.travelType] ??
    state.countries[country]?.flightSec?.Standard ??
    null
  );
}

function flightSecWithVariance(flightSec, kind) {
  if (kind === "fast") return Math.round(flightSec * (1 - FLIGHT_TIME_VARIANCE));
  return Math.round(flightSec * (1 + FLIGHT_TIME_VARIANCE));
}

function fmtSignedMoney(amount) {
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? "-" : "";
  return `${sign}${fmtMoney(Math.abs(rounded))}`;
}

function fmtProfitPerHour(profitPerHour) {
  if (profitPerHour == null) return null;
  return `${fmtSignedMoney(profitPerHour)}/hr`;
}

function profitValueClass(value) {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

/**
 * Max items purchasable in one trip: travel capacity, optionally capped by
 * known restock amount and/or max budget (total cost = qty × buyPrice).
 */
function getMaxPurchaseQty(country, itemId, buyPrice) {
  let qty = state.travelCapacity;
  const restock = getRestockAmount(country, itemId);
  if (restock != null && restock < qty) qty = restock;
  if (state.maxBudget != null) {
    if (!(buyPrice > 0)) return 0;
    qty = Math.min(qty, Math.floor(state.maxBudget / buyPrice));
  }
  return Math.max(0, qty);
}

function computeProfitMetrics({ buyPrice, sellPrice, country, itemId }) {
  const flightSec = getFlightSec(country);
  if (flightSec == null || sellPrice == null) return null;
  const roundTripSec = flightSec * 2;
  if (roundTripSec <= 0) return null;
  const itemsPerTrip =
    itemId != null ? getMaxPurchaseQty(country, itemId, buyPrice) : state.travelCapacity;
  const profitPerItem = sellPrice - buyPrice;
  const totalCost = buyPrice * itemsPerTrip;
  const totalProfit = profitPerItem * itemsPerTrip;
  const profitPerHour = itemsPerTrip <= 0 ? 0 : totalProfit / (roundTripSec / 3600);
  return {
    buyPrice,
    sellPrice,
    profitPerItem,
    totalCost,
    totalProfit,
    profitPerHour,
    itemsPerTrip,
    roundTripSec,
  };
}

function getItemSellPrice(country, itemId, marketPrice) {
  const stored = getSellPrice(country, itemId);
  if (stored != null) return stored;
  return marketPrice ?? null;
}

function getItemProfitPerHour(country, item) {
  const marketPrice = state.marketPrices?.[item.id] ?? null;
  const sellPrice = getItemSellPrice(country, item.id, marketPrice);
  if (sellPrice == null) return null;
  return (
    computeProfitMetrics({
      buyPrice: item.cost,
      sellPrice,
      country,
      itemId: item.id,
    })?.profitPerHour ?? null
  );
}
