import { getLatestSnapshot } from "./db.js";
import { query } from "./pg.js";
import { computeWorkdayEstimates } from "./safe-windows.js";

function tripRequest(item, { travelType, workdayHours }) {
  const { rangeHours, avgRateSamples = 3, rateTiming = "avg", historicalRatePrediction = false,
    historicalRateMaxAgeDays = null } = item.settings;
  // The shorter key also skips saved estimates from the load-dependent calculation.
  const profile = JSON.stringify([travelType, workdayHours, rangeHours,
    avgRateSamples, rateTiming, historicalRatePrediction, historicalRateMaxAgeDays]);
  return { ...item, key: `${item.country}:${item.itemId}`, profile };
}

async function readEstimates(requests) {
  const { rows } = await query(
    `SELECT t.country, t.item_id, t.workday_trips -> requested.profile AS estimate
     FROM unnest($1::text[], $2::integer[], $3::text[]) AS requested(country, item_id, profile)
     JOIN travel_items t USING (country, item_id)
     WHERE t.workday_trips ? requested.profile`,
    [requests.map((item) => item.country), requests.map((item) => item.itemId), requests.map((item) => item.profile)]
  );
  return Object.fromEntries(rows.map(({ country, item_id, estimate }) => [`${country}:${item_id}`, estimate]));
}

async function saveEstimates(entries, replace = false) {
  // Keep the newest profiles to bound each catalogue row across different settings.
  // Concurrent cache fills keep the first saved estimate. An admin can replace it.
  await query(
    `WITH saved AS (
       INSERT INTO travel_items (country, item_id, workday_trips)
       SELECT country, item_id, jsonb_build_object(profile, estimate)
       FROM jsonb_to_recordset($1::jsonb) AS incoming(country text, item_id integer, profile text, estimate jsonb)
       ORDER BY country, item_id
       ON CONFLICT (country, item_id) DO UPDATE SET workday_trips = (
         SELECT jsonb_object_agg(key, value) FROM (
           SELECT key, value FROM jsonb_each(travel_items.workday_trips || EXCLUDED.workday_trips)
           ORDER BY (EXCLUDED.workday_trips ? key) DESC, (value->>'calculatedAt')::bigint DESC, key
           LIMIT 64
         ) recent
       )
       WHERE $2 OR NOT (travel_items.workday_trips ?| ARRAY(SELECT jsonb_object_keys(EXCLUDED.workday_trips)))
       RETURNING country, item_id
     )
     SELECT pg_notify('snapshot_updates', json_build_object(
       'country', country, 'itemId', item_id, 'snapshot_ts', NULL, 'workday_trips', TRUE)::text)
     FROM saved WHERE $2`,
    [JSON.stringify(entries), replace]
  );
}

async function loadSingleStock({ country, itemId }) {
  const stock = await getLatestSnapshot(country, itemId);
  return { [country]: { stocks: stock ? [{ ...stock, id: itemId }] : [] } };
}

export async function getSavedWorkdayEstimates(items, options, readStocks) {
  const requests = items.map((item) => tripRequest(item, options));
  const saved = await readEstimates(requests);
  const missing = requests.filter(({ key }) => !Object.hasOwn(saved, key));
  if (!missing.length) return saved;

  const stocks = missing.length === 1 ? await loadSingleStock(missing[0]) : (await readStocks()).stocks;
  const calculatedAt = Math.floor(Date.now() / 1000);
  const estimates = await computeWorkdayEstimates(missing, stocks, { ...options, startTs: calculatedAt });
  const entries = missing.filter(({ key }) => estimates[key] != null).map(({ country, itemId, key, profile }) => ({
    country, item_id: itemId, profile, estimate: { ...estimates[key], calculatedAt },
  }));
  if (!entries.length) return saved;

  await saveEstimates(entries);
  const persisted = await readEstimates(missing);
  return { ...saved, ...persisted };
}

export async function recalculateWorkdayEstimate(item, options) {
  const request = tripRequest(item, options);
  const stocks = await loadSingleStock(item);
  const calculatedAt = Math.floor(Date.now() / 1000);
  const results = await computeWorkdayEstimates([item], stocks, { ...options, startTs: calculatedAt });
  const day = results[request.key];
  if (!day) return null;

  const estimate = { ...day, calculatedAt };
  await saveEstimates([{ country: item.country, item_id: item.itemId, profile: request.profile, estimate }], true);
  return estimate;
}
