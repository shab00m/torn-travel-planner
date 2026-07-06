import { countryCodeFromTornDestination } from "./countries.js";

const TORN_URL = "https://api.torn.com/user/";

// Base travel capacities (see https://www.torntravel.com/handbook/capacity):
// Standard = 5; Airstrip, Private jet and Business Class all = 15.
const BASE_CAPACITY = { Standard: 5, Airstrip: 15, Private: 15, Business: 15 };

const PERK_ARRAYS = [
  "job_perks",
  "property_perks",
  "stock_perks",
  "merit_perks",
  "education_perks",
  "enhancer_perks",
  "company_perks",
  "faction_perks",
  "book_perks",
];

/**
 * Derive travel type and item capacity from the player's perk strings.
 * The Torn API has no direct capacity field; this mirrors what community
 * tools (Torn PDA etc.) do.
 */
function parseTravelPerks(data) {
  const propertyPerks = data.property_perks ?? [];
  const stockPerks = data.stock_perks ?? [];

  let travelType = "Standard";
  if (propertyPerks.some((p) => /airstrip/i.test(p))) {
    travelType = "Airstrip";
  } else if (stockPerks.some((p) => /private jet/i.test(p))) {
    travelType = "Private";
  }

  // Additive bonuses like "+ 2 Travel items", "+ 10 travel item capacity"
  // can appear in any perk array (suitcases, faction Excursion, books, jobs).
  let bonus = 0;
  const perkDetails = [];
  for (const arrayName of PERK_ARRAYS) {
    for (const perk of data[arrayName] ?? []) {
      const match = perk.match(/\+\s*(\d+)\s*travel item/i);
      if (match) {
        bonus += Number(match[1]);
        perkDetails.push(perk.trim());
      }
    }
  }

  return {
    travelType,
    capacity: BASE_CAPACITY[travelType] + bonus,
    baseCapacity: BASE_CAPACITY[travelType],
    bonusCapacity: bonus,
    capacityPerks: perkDetails,
  };
}

async function fetchTornUser(apiKey, selections) {
  const url = `${TORN_URL}?selections=${selections}&key=${encodeURIComponent(apiKey)}&timestamp=${Date.now()}`;
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

/**
 * Validate an API key against the Torn API and return player info.
 * Throws with a user-presentable message on failure.
 */
export async function getPlayerInfo(apiKey) {
  const data = await fetchTornUser(apiKey, "basic,perks");
  return {
    name: data.name,
    playerId: data.player_id,
    level: data.level,
    ...parseTravelPerks(data),
  };
}

/**
 * Return in-flight travel to a specific country, if any.
 * travel.timestamp is the landing time while en route.
 */
export function parseTravelToCountry(travel, countryCode) {
  if (!travel?.destination || travel.timestamp == null) return null;
  if (countryCodeFromTornDestination(travel.destination) !== countryCode) return null;
  const nowTs = Math.floor(Date.now() / 1000);
  if (travel.timestamp <= nowTs) return null;
  return { arriveTs: travel.timestamp };
}

/** Check whether the key owner is currently flying to countryCode. */
export async function getTravelStatus(apiKey, countryCode) {
  const data = await fetchTornUser(apiKey, "travel");
  const active = parseTravelToCountry(data.travel, countryCode);
  return {
    flyingToCountry: active != null,
    arriveTs: active?.arriveTs ?? null,
  };
}
