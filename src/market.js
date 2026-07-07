const TORN_V2_MARKET_URL = "https://api.torn.com/v2/market";
const CACHE_TTL_MS = 60_000;

const cache = new Map();

function resolveApiKey(userKey) {
  if (typeof userKey === "string" && userKey.trim()) return userKey.trim();
  const envKey = process.env.TORN_API_KEY;
  if (typeof envKey === "string" && envKey.trim()) return envKey.trim();
  return null;
}

function averageMarketPrice(data) {
  const raw = data?.itemmarket?.item?.average_price;
  const price = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  return Number.isFinite(price) && price > 0 ? price : null;
}

async function fetchTornJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Torn API responded with HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`Torn API error ${data.error.code}: ${data.error.error}`);
  }
  return data;
}

async function fetchItemMarket(apiKey, itemId) {
  const url = `${TORN_V2_MARKET_URL}/${itemId}/itemmarket?limit=20&offset=0&key=${encodeURIComponent(apiKey)}&timestamp=${Date.now()}`;
  return fetchTornJson(url);
}

/** Item market average price for an item, cached for 60 seconds. */
export async function getMarketPrice(itemId, userApiKey) {
  const apiKey = resolveApiKey(userApiKey);
  if (!apiKey) {
    throw new Error("API key required for market prices");
  }

  const cached = cache.get(itemId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.marketPrice;
  }

  const data = await fetchItemMarket(apiKey, itemId);
  const marketPrice = averageMarketPrice(data);
  if (marketPrice == null) {
    throw new Error("Item market average price unavailable");
  }

  cache.set(itemId, { marketPrice, at: Date.now() });
  return marketPrice;
}

export { averageMarketPrice };
