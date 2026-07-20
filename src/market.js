import {
  getAllMarketPriceRows,
  getMarketPriceRow,
  getStaleMarketItemIds,
  upsertMarketPrice,
} from "./db.js";

const TORN_V2_MARKET_URL = "https://api.torn.com/v2/market";

const CACHE_TTL_SEC = Number.parseInt(process.env.MARKET_CACHE_TTL_SEC ?? "300", 10);
const CALLS_PER_MINUTE = Number.parseInt(process.env.MARKET_CALLS_PER_MINUTE ?? "50", 10);
const REFRESH_BATCH_SIZE = Number.parseInt(process.env.MARKET_REFRESH_BATCH_SIZE ?? "50", 10);
const REFRESH_INTERVAL_MS = Number.parseInt(process.env.MARKET_REFRESH_INTERVAL_MS ?? "30000", 10);

const refreshQueue = new Set();
let refreshRunning = false;
let refreshTimer = null;

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

function isFresh(fetchedAt, nowSec = Math.floor(Date.now() / 1000)) {
  return fetchedAt != null && nowSec - fetchedAt < CACHE_TTL_SEC;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MinuteRateLimiter {
  constructor(maxPerMinute) {
    this.maxPerMinute = Math.max(1, maxPerMinute);
    this.timestamps = [];
  }

  async acquire() {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
      if (this.timestamps.length < this.maxPerMinute) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = 60_000 - (now - this.timestamps[0]) + 25;
      await sleep(waitMs);
    }
  }
}

const rateLimiter = new MinuteRateLimiter(CALLS_PER_MINUTE);

async function storeMarketPrice(itemId, marketPrice, fetchedAt = Math.floor(Date.now() / 1000)) {
  await upsertMarketPrice(itemId, marketPrice, fetchedAt);
}

async function fetchAndStoreMarketPrice(itemId, apiKey) {
  const fetchedAt = Math.floor(Date.now() / 1000);
  try {
    const data = await fetchItemMarket(apiKey, itemId);
    const marketPrice = averageMarketPrice(data);
    await storeMarketPrice(itemId, marketPrice, fetchedAt);
    return marketPrice;
  } catch (err) {
    await storeMarketPrice(itemId, null, fetchedAt);
    throw err;
  }
}

async function readCachedMarketPrice(itemId) {
  const row = await getMarketPriceRow(itemId);
  if (!row) return null;
  return {
    marketPrice: row.market_price,
    fetchedAt: row.fetched_at,
    fresh: isFresh(row.fetched_at),
  };
}

export async function getCachedMarketPrices() {
  const prices = {};
  const fetchedAt = {};
  for (const row of await getAllMarketPriceRows()) {
    prices[row.item_id] = row.market_price;
    fetchedAt[row.item_id] = row.fetched_at;
  }
  return { prices, fetchedAt };
}

function scheduleMarketRefresh(itemIds) {
  for (const itemId of itemIds) refreshQueue.add(itemId);
  void runRefreshQueue();
}

export async function enqueueStaleMarketRefresh(limit = REFRESH_BATCH_SIZE) {
  const apiKey = resolveApiKey(null);
  if (!apiKey) return false;

  const staleBeforeTs = Math.floor(Date.now() / 1000) - CACHE_TTL_SEC;
  const itemIds = await getStaleMarketItemIds(staleBeforeTs, limit);
  if (!itemIds.length) return false;

  scheduleMarketRefresh(itemIds);
  return true;
}

async function runRefreshQueue() {
  if (refreshRunning) return;

  const apiKey = resolveApiKey(null);
  if (!apiKey || refreshQueue.size === 0) return;

  refreshRunning = true;
  try {
    while (refreshQueue.size > 0) {
      const itemId = refreshQueue.values().next().value;
      refreshQueue.delete(itemId);

      const cached = await readCachedMarketPrice(itemId);
      if (cached?.fresh) continue;

      await rateLimiter.acquire();
      try {
        await fetchAndStoreMarketPrice(itemId, apiKey);
      } catch (err) {
        console.error(`[market] refresh item ${itemId} failed: ${err.message}`);
      }
    }
  } finally {
    refreshRunning = false;
  }
}

/** Item market average price; reads DB cache first, then rate-limited Torn fetch. */
export async function getMarketPrice(itemId, userApiKey) {
  const cached = await readCachedMarketPrice(itemId);
  if (cached?.fresh && cached.marketPrice != null) {
    return cached.marketPrice;
  }

  const apiKey = resolveApiKey(userApiKey);
  if (!apiKey) {
    if (cached?.marketPrice != null) return cached.marketPrice;
    throw new Error("API key required for market prices");
  }

  if (cached?.fresh && cached.marketPrice == null) {
    throw new Error("Item market average price unavailable");
  }

  await rateLimiter.acquire();
  const marketPrice = await fetchAndStoreMarketPrice(itemId, apiKey);
  if (marketPrice == null) {
    throw new Error("Item market average price unavailable");
  }
  return marketPrice;
}

export function startMarketRefresh() {
  if (refreshTimer) return;

  const tick = () => {
    void enqueueStaleMarketRefresh();
  };

  tick();
  refreshTimer = setInterval(tick, REFRESH_INTERVAL_MS);
}

export { averageMarketPrice, CACHE_TTL_SEC };
