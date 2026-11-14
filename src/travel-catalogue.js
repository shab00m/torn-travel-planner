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
export async function saveTravelCatalogue(entries) {
  const listings = travelListings(entries);
  return withTransaction(async (client) => {
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
    return entries.length;
  });
}
