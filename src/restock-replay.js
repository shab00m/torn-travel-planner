import { isNegligibleRestockQty } from "../public/restock-qty.js";

/** Preload lookahead for history replay without querying history for each blip.
 * Snapshots must be ordered by country, item and timestamp.
 */
export function buildReplayHints(snapshots, amounts) {
  const hints = new Array(snapshots.length);
  let key = null;
  let nextRestockTs = null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const row = snapshots[i];
    const rowKey = `${row.country}:${row.item_id}`;
    if (key !== rowKey) nextRestockTs = null;
    const restockAmount = amounts.get(rowKey) ?? null;
    hints[i] = { persistRates: false, restockAmount, nextRestockTs };
    const prev = snapshots[i - 1];
    if (row.quantity > 0 && prev?.country === row.country && prev.item_id === row.item_id &&
        prev.quantity === 0 && !isNegligibleRestockQty(row.quantity, restockAmount)) {
      nextRestockTs = row.snapshot_ts;
    }
    key = rowKey;
  }
  let zeroTs = null;
  key = null;
  for (let i = 0; i < snapshots.length; i++) {
    const row = snapshots[i];
    const rowKey = `${row.country}:${row.item_id}`;
    if (key !== rowKey) zeroTs = null;
    hints[i].observedZeroTs = zeroTs;
    zeroTs = row.quantity === 0 ? zeroTs ?? row.snapshot_ts : null;
    key = rowKey;
  }
  return hints;
}
