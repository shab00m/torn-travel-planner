import { getAllItemTypeRows, hasItemsMissingType, upsertItemTypes } from "./db.js";

const TORN_V2_ITEMS_URL = "https://api.torn.com/v2/torn/items";

/** Official TornItemCategory values (excluding All). */
export const TORN_ITEM_CATEGORIES = [
  "Alcohol",
  "Armor",
  "Artifact",
  "Book",
  "Booster",
  "Candy",
  "Car",
  "Clothing",
  "Collectible",
  "Defensive",
  "Drug",
  "Energy Drink",
  "Enhancer",
  "Flower",
  "Jewelry",
  "Material",
  "Medical",
  "Melee",
  "Other",
  "Plushie",
  "Primary",
  "Secondary",
  "Special",
  "Supply Pack",
  "Temporary",
  "Tool",
  "Unused",
  "Weapon",
];

let memoryCache = null; // { types: Record<number, string> } | null
let populatePromise = null;

function resolveServerApiKey() {
  const envKey = process.env.TORN_API_KEY;
  return typeof envKey === "string" && envKey.trim() ? envKey.trim() : null;
}

async function fetchTornJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Torn API responded with HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`Torn API error ${data.error.code}: ${data.error.error}`);
  }
  return data;
}

function entriesFromItems(items, fallbackType = null) {
  const entries = [];
  for (const item of items ?? []) {
    const id = Number(item?.id);
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const type =
      (typeof item?.type === "string" && item.type.trim()) ||
      (fallbackType && String(fallbackType)) ||
      "";
    if (!Number.isInteger(id) || id <= 0 || !name || !type) continue;
    entries.push({ id, name, type });
  }
  return entries;
}

/** Fetch Torn item catalogue (id, name, type). Prefers cat=All. */
async function fetchItemCatalogueFromTorn(apiKey) {
  const allUrl = `${TORN_V2_ITEMS_URL}?cat=All&key=${encodeURIComponent(apiKey)}&timestamp=${Date.now()}&comment=torn-travel-planner`;
  const allData = await fetchTornJson(allUrl);
  let entries = entriesFromItems(allData.items);

  if (entries.length > 0) return entries;

  // cat=All sometimes omits type; pull each category instead.
  const byId = new Map();
  for (const cat of TORN_ITEM_CATEGORIES) {
    const url = `${TORN_V2_ITEMS_URL}?cat=${encodeURIComponent(cat)}&key=${encodeURIComponent(apiKey)}&timestamp=${Date.now()}&comment=torn-travel-planner`;
    try {
      const data = await fetchTornJson(url);
      for (const entry of entriesFromItems(data.items, cat)) {
        byId.set(entry.id, entry);
      }
    } catch (err) {
      console.error(`[item-types] category ${cat} failed: ${err.message}`);
    }
  }
  return [...byId.values()];
}

async function loadTypesFromDb() {
  const rows = await getAllItemTypeRows();
  const types = {};
  for (const row of rows) {
    types[row.item_id] = row.item_type;
  }
  return types;
}

export async function getCachedItemTypes() {
  if (memoryCache) return { types: memoryCache.types };
  const types = await loadTypesFromDb();
  memoryCache = { types };
  return { types };
}

/**
 * One-time (or catch-up) populate of items.item_type from Torn.
 * Uses TORN_API_KEY only — never a user key. Skips when every item already has a type.
 */
export async function ensureItemTypesPopulated() {
  if (populatePromise) return populatePromise;
  populatePromise = (async () => {
    const missing = await hasItemsMissingType();
    const cached = await getCachedItemTypes();
    if (!missing && Object.keys(cached.types).length > 0) {
      return cached;
    }

    const apiKey = resolveServerApiKey();
    if (!apiKey) {
      console.error(
        "[item-types] TORN_API_KEY is not set; cannot populate items.item_type from Torn"
      );
      return cached;
    }

    try {
      const entries = await fetchItemCatalogueFromTorn(apiKey);
      if (!entries.length) {
        console.error("[item-types] Torn returned no items with types");
        return cached;
      }
      const count = await upsertItemTypes(entries);
      memoryCache = null;
      const types = await loadTypesFromDb();
      memoryCache = { types };
      console.log(`[item-types] populated item_type on ${count} items from Torn`);
      return { types };
    } catch (err) {
      console.error(`[item-types] populate failed: ${err.message}`);
      return cached;
    }
  })().finally(() => {
    populatePromise = null;
  });
  return populatePromise;
}
