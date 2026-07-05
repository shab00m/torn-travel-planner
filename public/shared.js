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

const fmtNum = (n) => n.toLocaleString("en-US");
const fmtMoney = (n) => "$" + fmtNum(n);
const fmtTime = (ts) => new Date(ts * 1000).toLocaleString();

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
