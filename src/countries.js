// Single source of truth for YATA country codes -> display metadata.
// Served to the frontend via GET /api/countries.
export const COUNTRIES = {
  mex: { name: "Mexico", flag: "🇲🇽" },
  cay: { name: "Cayman Islands", flag: "🇰🇾" },
  can: { name: "Canada", flag: "🇨🇦" },
  haw: { name: "Hawaii", flag: "🌺" },
  uni: { name: "United Kingdom", flag: "🇬🇧" },
  arg: { name: "Argentina", flag: "🇦🇷" },
  swi: { name: "Switzerland", flag: "🇨🇭" },
  jap: { name: "Japan", flag: "🇯🇵" },
  chi: { name: "China", flag: "🇨🇳" },
  uae: { name: "UAE", flag: "🇦🇪" },
  sou: { name: "South Africa", flag: "🇿🇦" },
};

// Torn API travel.destination values -> YATA country codes.
export const TORN_DESTINATION_TO_CODE = Object.fromEntries(
  Object.entries(COUNTRIES).map(([code, meta]) => [meta.name, code])
);
TORN_DESTINATION_TO_CODE["United Arab Emirates"] = "uae";

export function countryCodeFromTornDestination(destination) {
  if (typeof destination !== "string" || !destination) return null;
  return TORN_DESTINATION_TO_CODE[destination] ?? null;
}
