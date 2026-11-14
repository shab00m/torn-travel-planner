import { getPool } from "./pg.js";
import { COUNTRIES } from "./countries.js";

/** Indexed last-observation lookups; never scan all snapshot history per request. */
export async function loadCurrentStocks() {
  const { rows } = await getPool().query(
    `SELECT c.country, i.item_id AS id, i.name, i.item_type, s.snapshot_ts, s.quantity,
            COALESCE(s.cost, t.cost) AS cost, s.source
     FROM unnest($1::text[]) AS c(country)
     CROSS JOIN items i
     LEFT JOIN travel_items t ON t.country = c.country AND t.item_id = i.item_id
     LEFT JOIN LATERAL (
       SELECT snapshot_ts, quantity, cost, source FROM snapshots
       WHERE country = c.country AND item_id = i.item_id
       ORDER BY snapshot_ts DESC, source ASC LIMIT 1
     ) s ON true
     WHERE (s.snapshot_ts IS NOT NULL OR t.item_id IS NOT NULL)
       AND NOT COALESCE(t.deprecated_override, t.catalogue_deprecated, FALSE)
     ORDER BY c.country, i.item_id`, [Object.keys(COUNTRIES)]);
  const stocks = {};
  let timestamp = null;
  for (const { country, ...item } of rows) {
    const destination = stocks[country] ??= { update: item.snapshot_ts, stocks: [] };
    if (item.snapshot_ts != null) {
      destination.update = Math.max(destination.update ?? 0, item.snapshot_ts);
      timestamp = Math.max(timestamp ?? 0, item.snapshot_ts);
    }
    destination.stocks.push(item);
  }
  return { stocks, timestamp, lastError: null };
}

/** Share reads across browsers, invalidate on committed DB notifications. */
export function createCurrentStocksReader(revision, load = loadCurrentStocks) {
  let cached = null;
  let cachedRevision = null;
  let expiresAt = 0;
  let pending = null;
  return async () => {
    const current = revision();
    if (cached && cachedRevision === current && Date.now() < expiresAt) return cached;
    if (pending?.revision === current) return pending.promise;
    const entry = { revision: current };
    entry.promise = load().then((data) => {
      // An older in-flight read must not overwrite a newer committed revision.
      if (revision() === current) {
        cached = data; cachedRevision = current; expiresAt = Date.now() + 2000;
      }
      return data;
    }).finally(() => { if (pending === entry) pending = null; });
    pending = entry;
    return entry.promise;
  };
}
