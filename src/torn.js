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

/**
 * Validate an API key against the Torn API and return player info.
 * Throws with a user-presentable message on failure.
 */
export async function getPlayerInfo(apiKey) {
  const url = `${TORN_URL}?selections=basic,perks&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Torn API responded with HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`Torn API error ${data.error.code}: ${data.error.error}`);
  }

  return {
    name: data.name,
    playerId: data.player_id,
    level: data.level,
    ...parseTravelPerks(data),
  };
}
