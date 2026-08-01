/**
 * Market sell-backs can briefly put a few units in stock after a real stockout.
 * Ignore quantities below this fraction of the configured full restock size.
 * Used by the server (restock cycle detection) and the client (restock alarms).
 */
export const MIN_RESTOCK_QTY_FRACTION = 0.01;

/** True when qty is a negligible fraction of the configured full restock (sell-back noise). */
export function isNegligibleRestockQty(quantity, restockAmount) {
  if (restockAmount == null || restockAmount <= 0 || quantity <= 0) return false;
  return quantity < restockAmount * MIN_RESTOCK_QTY_FRACTION;
}
