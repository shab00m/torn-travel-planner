// Standard one-way flight times from Torn City (seconds).
// Source: https://www.torntravel.com/handbook/getting-started
// Actual flights vary ±3%; method bonuses match the Torn wiki.
const STANDARD_SECONDS = {
  mex: 25 * 60,
  cay: 33 * 60,
  can: 39 * 60,
  haw: 127 * 60,
  uni: 151 * 60,
  arg: 166 * 60,
  swi: 158 * 60,
  jap: 213 * 60,
  chi: 229 * 60,
  uae: 257 * 60,
  sou: 281 * 60,
};

const TRAVEL_SPEED = {
  Standard: 1,
  Airstrip: 0.7, // 30% faster
  Private: 0.5, // 50% faster (WLT private jet)
  Business: 0.3, // 70% faster (BCT)
};

/** One-way flight duration in seconds for a country and travel method. */
export function getFlightSeconds(country, travelType = "Standard") {
  const base = STANDARD_SECONDS[country];
  if (base == null) {
    throw new Error(`Unknown country code '${country}'`);
  }
  const mult = TRAVEL_SPEED[travelType];
  if (mult == null) {
    throw new Error(`Unknown travel type '${travelType}'`);
  }
  return Math.round(base * mult);
}

/** Flight durations for all travel methods, keyed by country code. */
export function getFlightMatrix() {
  const matrix = {};
  for (const country of Object.keys(STANDARD_SECONDS)) {
    matrix[country] = {};
    for (const travelType of Object.keys(TRAVEL_SPEED)) {
      matrix[country][travelType] = getFlightSeconds(country, travelType);
    }
  }
  return matrix;
}
