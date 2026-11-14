import { countryCodeFromTornDestination } from "./countries.js";
import { upsertItemTypes } from "./db.js";
import { withTransaction } from "./pg.js";

/** Torn's shops list identifies availability; it does not report live stock. */
export function travelListings(entries) {
  const listings = new Map();
  for (const item of entries) {
    for (const shop of item.shops ?? []) {
      const country = countryCodeFromTornDestination(shop?.country);
      if (!country) continue;
      const cost = Number.isSafeInteger(shop.buy_price) && shop.buy_price >= 0
        ? shop.buy_price : null;
      const key = `${country}:${item.id}`;
      const previous = listings.get(key);
      listings.set(key, { country, itemId: item.id,
        cost: previous?.cost == null ? cost : cost == null ? previous.cost : Math.min(previous.cost, cost) });
    }
  }
  return [...listings.values()].sort((a, b) => a.country.localeCompare(b.country) || a.itemId - b.itemId);
}

/** Keep discoveries across incomplete upstream responses; never fabricate snapshots. */
export async function saveTravelCatalogue(entries, { reconcile = false } = {}) {
  if (reconcile && (!entries.length || entries.some((item) => !Array.isArray(item.shops)))) {
    throw new Error("Cannot reconcile an empty or incomplete shop catalogue");
  }
  const listings = travelListings(entries);
  return withTransaction(async (client) => {
    // Serialize web discovery with daily reconciliation across service processes.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('travel_catalogue', 0))");
    await upsertItemTypes([...entries].sort((a, b) => a.id - b.id), client);
    if (listings.length) {
      await client.query(
        `INSERT INTO travel_items (country, item_id, cost)
         SELECT * FROM UNNEST($1::text[], $2::int[], $3::bigint[])
         ON CONFLICT (country, item_id) DO UPDATE SET cost = EXCLUDED.cost
         WHERE travel_items.cost IS DISTINCT FROM EXCLUDED.cost`,
        [listings.map((r) => r.country), listings.map((r) => r.itemId), listings.map((r) => r.cost)]
      );
    }
    if (!reconcile) return entries.length;
    const ids = entries.map((item) => item.id);
    // Include legacy/YATA-only combinations, not just previous Torn discoveries.
    await client.query(
      `INSERT INTO travel_items (country, item_id)
       SELECT country, item_id FROM (
         SELECT country, item_id FROM snapshots WHERE item_id = ANY($1::int[])
         UNION SELECT country, item_id FROM restocks WHERE item_id = ANY($1::int[])
       ) observed
       ON CONFLICT DO NOTHING`, [ids]);
    // An omitted item is not proof of removal. Only reconcile items whose own
    // explicit shops array was fetched; partial responses cannot hide other IDs.
    const { rows } = await client.query(
      `WITH active AS (
         SELECT * FROM UNNEST($1::text[], $2::int[]) AS t(country, item_id)
       ), desired AS (
         SELECT t.country, t.item_id, NOT EXISTS (
           SELECT 1 FROM active a WHERE a.country = t.country AND a.item_id = t.item_id
         ) AS deprecated
         FROM travel_items t WHERE t.item_id = ANY($3::int[])
       )
       UPDATE travel_items t SET catalogue_deprecated = d.deprecated
       FROM desired d WHERE t.country = d.country AND t.item_id = d.item_id
         AND t.catalogue_deprecated IS DISTINCT FROM d.deprecated
       RETURNING t.catalogue_deprecated`,
      [listings.map((r) => r.country), listings.map((r) => r.itemId), ids]);
    return { items: entries.length,
      deprecated: rows.filter((r) => r.catalogue_deprecated).length,
      reactivated: rows.filter((r) => !r.catalogue_deprecated).length };
  });
}
