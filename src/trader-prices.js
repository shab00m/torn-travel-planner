import { loadCurrentStocks } from "./current-stocks.js";
import { query } from "./pg.js";
import { setTimeout as sleep } from "node:timers/promises";

export const TRADER_PRICE_TTL_SEC = 300;
export const DEFAULT_TRADER_MIN_RATING = 30;
const REFRESH_COOLDOWN_SEC = 30;
const CRON_REQUEST_INTERVAL_MS = 2000;
const CRON_BUDGET_MS = 210_000;
// Allow for the time spent pacing the previous sweep so later items can refresh on the next tick.
const CRON_MIN_CACHE_AGE_SEC = TRADER_PRICE_TTL_SEC - Math.ceil(CRON_BUDGET_MS / 1000);
const pending = new Map();

const nowSec = () => Math.floor(Date.now() / 1000);

export function parseTraderMinRating(value) {
  if (value == null) return DEFAULT_TRADER_MIN_RATING;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const rating = Number(value);
  return Number.isSafeInteger(rating) ? rating : null;
}

export function normalizeTraderOffers(data, itemId, now) {
  if (data?.item_id !== itemId || !Array.isArray(data.traders)) {
    throw new Error("TornW3B returned an invalid list of trader offers");
  }
  const offers = [];
  for (const trader of data.traders) {
    if (!trader || trader.sponsored || trader.is_sponsored || trader.advertised) continue;
    const { price, rating, last_action: lastAction, last_trade: lastTrade } = trader;
    if (!Number.isSafeInteger(price) || price <= 0 ||
        !Number.isSafeInteger(rating?.upvotes) || rating.upvotes < 0 ||
        !Number.isSafeInteger(rating?.downvotes) || rating.downvotes < 0 ||
        !Number.isSafeInteger(lastAction) || !Number.isSafeInteger(lastTrade)) continue;

    const score = rating.upvotes - rating.downvotes;
    // The public quote feed includes inactive traders. Apply the Sell tab's published activity windows.
    const expiresAt = Math.min(lastAction + 4 * 3600, lastTrade + 12 * 3600);
    if (expiresAt > now && score >= 1) offers.push({ price, rating: score, expiresAt });
  }
  return offers.sort((a, b) => b.price - a.price);
}

export function bestTraderPrice(offers, minRating, now) {
  return offers.find((offer) => offer.rating >= minRating && offer.expiresAt > now)?.price ?? null;
}

async function readRow(itemId) {
  const { rows } = await query("SELECT offers, fetched_at FROM trader_prices WHERE item_id = $1", [itemId]);
  return rows[0];
}

export async function getCachedTraderPrices(minRating) {
  const { rows } = await query("SELECT item_id, offers, fetched_at FROM trader_prices");
  const prices = {};
  const fetchedAt = {};
  const now = nowSec();
  for (const row of rows) {
    prices[row.item_id] = bestTraderPrice(row.offers, minRating, now);
    fetchedAt[row.item_id] = row.fetched_at;
  }
  return { prices, fetchedAt, cacheTtlSec: TRADER_PRICE_TTL_SEC };
}

async function fetchAndStoreRow(itemId) {
  const fetchedAt = nowSec();
  const res = await fetch(
    `https://weav3r.dev/api/marketplace/${itemId}/traders?sort=price&tradedWithinHours=12&limit=100`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok && res.status !== 404) {
    const error = new Error(`TornW3B responded with HTTP ${res.status}`);
    error.upstreamStatus = res.status;
    throw error;
  }
  const data = await res.json();
  const offers = res.status === 404 && data?.error === "Item not found"
    ? []
    : normalizeTraderOffers(data, itemId, nowSec());
  const { rows } = await query(
    `INSERT INTO trader_prices (item_id, offers, fetched_at) VALUES ($1, $2, $3)
     ON CONFLICT (item_id) DO UPDATE SET offers = EXCLUDED.offers, fetched_at = EXCLUDED.fetched_at
     WHERE trader_prices.fetched_at < EXCLUDED.fetched_at
     RETURNING offers, fetched_at`,
    [itemId, JSON.stringify(offers), fetchedAt],
  );
  return rows[0] ?? readRow(itemId);
}

async function refreshRow(itemId, maxAgeSec) {
  const row = await readRow(itemId);
  if (row && nowSec() - row.fetched_at < maxAgeSec) return row;
  if (pending.has(itemId)) return pending.get(itemId);

  const request = fetchAndStoreRow(itemId).finally(() => pending.delete(itemId));
  pending.set(itemId, request);
  return request;
}

export async function getTraderPrice(itemId, minRating, { refresh = false } = {}) {
  const row = refresh ? await refreshRow(itemId, REFRESH_COOLDOWN_SEC) : await readRow(itemId);
  return {
    itemId,
    traderPrice: row ? bestTraderPrice(row.offers, minRating, nowSec()) : null,
    fetchedAt: row?.fetched_at ?? null,
  };
}

export async function refreshStaleTraderPrices() {
  const startedAt = Date.now();
  const { stocks } = await loadCurrentStocks();
  const itemIds = new Set(Object.values(stocks).flatMap((country) =>
    country.stocks.filter((item) => item.cost != null).map((item) => item.id)));
  const { rows } = await query("SELECT item_id, fetched_at FROM trader_prices");
  const fetchedAt = new Map(rows.map((row) => [row.item_id, row.fetched_at]));
  const staleBefore = nowSec() - CRON_MIN_CACHE_AGE_SEC;
  const stale = [...itemIds]
    .filter((id) => (fetchedAt.get(id) ?? 0) <= staleBefore)
    .sort((a, b) => (fetchedAt.get(a) ?? 0) - (fetchedAt.get(b) ?? 0));

  let refreshed = 0;
  let failed = 0;
  for (const itemId of stale) {
    if (Date.now() - startedAt >= CRON_BUDGET_MS) break;
    const requestStartedAt = Date.now();
    try {
      await refreshRow(itemId, CRON_MIN_CACHE_AGE_SEC);
      refreshed++;
    } catch (err) {
      failed++;
      console.error(`[trader-prices] refresh item ${itemId} failed: ${err.message}`);
      if (err.upstreamStatus === 429 || err.upstreamStatus === 403) break;
    }
    if (refreshed + failed < stale.length) {
      await sleep(Math.max(0, CRON_REQUEST_INTERVAL_MS - (Date.now() - requestStartedAt)));
    }
  }
  return { refreshed, failed, deferred: stale.length - refreshed - failed };
}
