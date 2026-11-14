import { getPool, withTransaction } from "./pg.js";

export async function getItemDeprecation(country, itemId, db = getPool()) {
  const { rows } = await db.query(
    `SELECT COALESCE(t.deprecated_override, t.catalogue_deprecated, FALSE) AS deprecated,
            COALESCE(t.catalogue_deprecated, FALSE) AS "catalogueDeprecated",
            t.deprecated_override AS override
     FROM items i LEFT JOIN travel_items t ON t.item_id = i.item_id AND t.country = $1
     WHERE i.item_id = $2 AND (t.item_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM snapshots WHERE country = $1 AND item_id = $2)
       OR EXISTS (SELECT 1 FROM restocks WHERE country = $1 AND item_id = $2))`,
    [country, itemId]);
  return rows[0] ?? null;
}

/** null returns control to the daily catalogue sync; booleans persist as overrides. */
export async function setItemDeprecation(country, itemId, deprecated) {
  if (deprecated !== null && typeof deprecated !== "boolean") {
    throw new Error("deprecated must be a boolean or null for automatic tracking");
  }
  return withTransaction(async (client) => {
    if (!await getItemDeprecation(country, itemId, client)) return null;
    await client.query(
      `INSERT INTO travel_items (country, item_id, deprecated_override) VALUES ($1, $2, $3)
       ON CONFLICT (country, item_id) DO UPDATE SET deprecated_override = EXCLUDED.deprecated_override
       WHERE travel_items.deprecated_override IS DISTINCT FROM EXCLUDED.deprecated_override`,
      [country, itemId, deprecated]);
    return getItemDeprecation(country, itemId, client);
  });
}
