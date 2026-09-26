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
function parseTravelPerks(data, tourismDay = false) {
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
      // Item-specific flower/plushie bonuses are not general carrying slots.
      if (match && !/flower|plushie/i.test(perk)) {
        bonus += Number(match[1]);
        perkDetails.push(perk.trim());
      }
    }
  }

  const normalCapacity = BASE_CAPACITY[travelType] + bonus;
  if (tourismDay) perkDetails.push("World Tourism Day: ×2 travel capacity");
  return {
    travelType,
    capacity: normalCapacity * (tourismDay ? 2 : 1),
    capacityMultiplier: tourismDay ? 2 : 1,
    baseCapacity: BASE_CAPACITY[travelType],
    bonusCapacity: bonus,
    capacityPerks: perkDetails,
  };
}

async function fetchTornUser(apiKey, selections) {
  const url = `${TORN_URL}?selections=${selections}&key=${encodeURIComponent(apiKey)}&timestamp=${Date.now()}`;
  return fetchTornJson(url);
}

async function fetchTornJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Torn API responded with HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`Torn API error ${data.error.code}: ${data.error.error}`);
  }
  return data;
}

/** Calendar timestamps are seconds; personal event times are expressed in TCT (UTC). */
export function tourismDayIsActive(events, startTime, now = Date.now() / 1000) {
  if (!Array.isArray(events)) throw new Error("Missing Torn calendar events");
  return events.some((event) => {
    if (!/^(?:world\s+)?tourism day$/i.test(event.title?.trim() ?? "")) return false;
    let { start, end } = event;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error("Invalid Tourism Day dates");
    }
    if (event.fixed_start_time !== true) {
      const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(startTime ?? "");
      if (!match || +match[1] > 23 || +match[2] > 59 || +(match[3] ?? 0) > 59) {
        throw new Error("Missing personal calendar start time");
      }
      const date = new Date(start * 1000);
      date.setUTCHours(+match[1], +match[2], +(match[3] ?? 0), 0);
      const offset = date.getTime() / 1000 - start;
      start += offset;
      end += offset;
    }
    return now >= start && now < end;
  });
}

async function getTourismDay(apiKey) {
  const options = { headers: { Authorization: `ApiKey ${apiKey}` } };
  const { calendar } = await fetchTornJson("https://api.torn.com/v2/torn/calendar", options);
  if (!Array.isArray(calendar?.events)) throw new Error("Missing Torn calendar events");
  const needsPersonalTime = calendar.events.some((event) =>
    /^(?:world\s+)?tourism day$/i.test(event.title?.trim() ?? "") && event.fixed_start_time !== true
  );
  const personal = needsPersonalTime
    ? await fetchTornJson("https://api.torn.com/v2/user/calendar", options)
    : null;
  return tourismDayIsActive(calendar.events, personal?.calendar?.start_time);
}

/**
 * Validate an API key against the Torn API and return player info.
 * Throws with a user-presentable message on failure.
 */
export async function getPlayerInfo(apiKey) {
  const data = await fetchTornUser(apiKey, "basic,perks");
  let tourismDay = false;
  let capacityWarning = null;
  try {
    tourismDay = await getTourismDay(apiKey);
  } catch {
    // Existing custom keys may not include the new calendar selections.
    capacityWarning = "Event bonus unverified; showing normal capacity. Retry or enable torn/calendar and user/calendar on your API key.";
  }
  return {
    name: data.name,
    playerId: data.player_id,
    level: data.level,
    ...parseTravelPerks(data, tourismDay),
    capacityWarning,
  };
}

/**
 * Return in-flight travel, if any.
 * travel.timestamp is the landing time while en route.
 */
export function parseActiveTravel(travel) {
  if (!travel?.destination || travel.timestamp == null) return null;
  const nowTs = Math.floor(Date.now() / 1000);
  if (travel.timestamp <= nowTs) return null;
  return {
    arriveTs: travel.timestamp,
    destination: travel.destination,
    country: countryCodeFromTornDestination(travel.destination),
  };
}

/**
 * Return in-flight travel to a specific country, if any.
 */
export function parseTravelToCountry(travel, countryCode) {
  const active = parseActiveTravel(travel);
  if (!active || active.country !== countryCode) return null;
  return { arriveTs: active.arriveTs };
}

/**
 * Travel status for the key owner.
 * When countryCode is set, flyingToCountry is true only if flying to that country.
 * When omitted, returns any active flight (for arrival alarms).
 */
export async function getTravelStatus(apiKey, countryCode = null) {
  const data = await fetchTornUser(apiKey, "travel");
  const active = parseActiveTravel(data.travel);
  if (!active) {
    return {
      flyingToCountry: false,
      arriveTs: null,
      destination: null,
      country: null,
    };
  }
  const flyingToCountry = countryCode != null && active.country === countryCode;
  return {
    flyingToCountry,
    arriveTs: countryCode != null && !flyingToCountry ? null : active.arriveTs,
    destination: active.destination,
    country: active.country,
  };
}
