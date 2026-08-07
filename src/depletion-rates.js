/**
 * Persisted in-stock depletion-rate windows on `restocks`.
 * Closed windows are written once when a cycle depletes; reads avoid full
 * snapshot scans. Open windows use the unfinished restock row + latest qty.
 */
import { getPool, withTransaction } from "./pg.js";
import { recomputeAdjustedRestockCycle } from "./adjusted-restocks.js";

async function one(db, text, params = []) {
  const { rows } = await db.query(text, params);
  return rows[0];
}

async function many(db, text, params = []) {
  const { rows } = await db.query(text, params);
  return rows;
}

/**
 * Last snapshot with quantity > 0 and yata_ts < beforeTs.
 * @param {{ yata_ts: number, quantity: number }[]} snapshots ascending by yata_ts
 */
export function lastPositiveBefore(snapshots, beforeTs) {
  let lo = 0;
  let hi = snapshots.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid].yata_ts < beforeTs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  for (let i = idx; i >= 0; i--) {
    if (snapshots[i].quantity > 0) return snapshots[i];
  }
  return null;
}

/**
 * Build rate windows from restock events + full snapshot history (backfill only).
 * @param {{ depleted_ts: number, restocked_ts: number|null, ignored?: boolean|number }[]} events
 * @param {{ yata_ts: number, quantity: number }[]} snapshots
 */
export function computeRateWindowsFromSnapshots(events, snapshots) {
  const qtyAt = new Map();
  for (const row of snapshots) qtyAt.set(row.yata_ts, row.quantity);
  const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;

  /** @type {{ depleted_ts: number, start_ts: number, end_ts: number, start_qty: number, end_qty: number, open: boolean }[]} */
  const windows = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].ignored) continue;
    const startTs = events[i].restocked_ts;
    if (startTs == null) continue;
    const startQty = qtyAt.get(startTs);
    if (!startQty) continue;

    let endTs;
    let endQty;
    let open = false;
    const nextDepletion = events[i + 1]?.depleted_ts;
    if (nextDepletion != null) {
      const lastPositive = lastPositiveBefore(snapshots, nextDepletion);
      if (lastPositive && lastPositive.yata_ts > startTs) {
        endTs = lastPositive.yata_ts;
        endQty = lastPositive.quantity;
      } else {
        endTs = nextDepletion;
        endQty = 0;
      }
    } else {
      if (!latest || latest.quantity === 0) continue;
      endTs = latest.yata_ts;
      endQty = latest.quantity;
      open = true;
    }

    if (endTs <= startTs) continue;
    windows.push({
      depleted_ts: events[i].depleted_ts,
      start_ts: startTs,
      end_ts: endTs,
      start_qty: startQty,
      end_qty: endQty,
      open,
    });
  }
  return windows;
}

/**
 * Write closed (and open start qty) rate fields onto restock rows.
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
export async function persistRateWindows(db, country, itemId, windows) {
  for (const w of windows) {
    if (w.open) {
      await db.query(
        `UPDATE restocks
         SET rate_start_qty = $1, rate_end_ts = NULL, rate_end_qty = NULL
         WHERE country = $2 AND item_id = $3 AND depleted_ts = $4`,
        [w.start_qty, country, itemId, w.depleted_ts]
      );
      continue;
    }
    await db.query(
      `UPDATE restocks
       SET rate_start_qty = $1, rate_end_ts = $2, rate_end_qty = $3
       WHERE country = $4 AND item_id = $5 AND depleted_ts = $6`,
      [w.start_qty, w.end_ts, w.end_qty, country, itemId, w.depleted_ts]
    );
  }
}

/**
 * Recompute and persist rate windows for one item from its snapshots.
 * @param {import("pg").PoolClient | import("pg").Pool} db
 * @param {{ sinceDepletedTs?: number }} [options]
 *   When set, only cycles with depleted_ts >= sinceDepletedTs are updated
 *   (older persisted rate windows are left untouched).
 */
export async function fillRateWindowsForItem(db, country, itemId, options = {}) {
  const sinceDepletedTs = options.sinceDepletedTs;
  const eventParams = [country, itemId];
  let eventSql = `SELECT depleted_ts, restocked_ts, ignored FROM restocks
       WHERE country = $1 AND item_id = $2`;
  if (sinceDepletedTs != null) {
    eventSql += ` AND depleted_ts >= $3`;
    eventParams.push(sinceDepletedTs);
  }
  eventSql += ` ORDER BY depleted_ts ASC`;

  const [events, snapshots] = await Promise.all([
    many(db, eventSql, eventParams),
    many(
      db,
      `SELECT yata_ts, quantity FROM snapshots
       WHERE country = $1 AND item_id = $2
       ORDER BY yata_ts ASC`,
      [country, itemId]
    ),
  ]);
  const windows = computeRateWindowsFromSnapshots(events, snapshots);
  await persistRateWindows(db, country, itemId, windows);
  return windows.length;
}

/** Finalize the in-stock window that ends at this depletion (live poll path). */
export async function finalizeRateWindowOnDepletion(client, country, itemId, depletedTs) {
  const prev = await one(
    client,
    `SELECT depleted_ts, restocked_ts, rate_start_qty FROM restocks
     WHERE country = $1 AND item_id = $2
       AND restocked_ts IS NOT NULL AND restocked_ts < $3
     ORDER BY restocked_ts DESC
     LIMIT 1`,
    [country, itemId, depletedTs]
  );
  if (!prev?.restocked_ts) return;

  let startQty = prev.rate_start_qty;
  if (startQty == null || startQty <= 0) {
    const start = await one(
      client,
      `SELECT quantity FROM snapshots
       WHERE country = $1 AND item_id = $2 AND yata_ts = $3`,
      [country, itemId, prev.restocked_ts]
    );
    startQty = start?.quantity;
  }
  if (!startQty) return;

  const lastPositive = await one(
    client,
    `SELECT yata_ts, quantity FROM snapshots
     WHERE country = $1 AND item_id = $2 AND yata_ts < $3 AND quantity > 0
     ORDER BY yata_ts DESC
     LIMIT 1`,
    [country, itemId, depletedTs]
  );

  let endTs;
  let endQty;
  if (lastPositive && lastPositive.yata_ts > prev.restocked_ts) {
    endTs = lastPositive.yata_ts;
    endQty = lastPositive.quantity;
  } else {
    endTs = depletedTs;
    endQty = 0;
  }
  if (endTs <= prev.restocked_ts) return;

  await client.query(
    `UPDATE restocks
     SET rate_start_qty = $1, rate_end_ts = $2, rate_end_qty = $3
     WHERE country = $4 AND item_id = $5 AND depleted_ts = $6`,
    [startQty, endTs, endQty, country, itemId, prev.depleted_ts]
  );
  // Rate window completion improves fallback rate for restock-time adjustment.
  await recomputeAdjustedRestockCycle(client, country, itemId, prev.depleted_ts);
}

/**
 * In-stock windows with their depletion rate, newest first.
 * Reads persisted columns; only hits snapshots for the open window's latest qty.
 * @param {number | null | undefined} limit Max windows; omit/null for all.
 */
export async function getDepletionRates(country, itemId, limit) {
  const pool = getPool();
  const [events, latest] = await Promise.all([
    many(
      pool,
      `SELECT depleted_ts, restocked_ts, ignored,
              rate_start_qty, rate_end_ts, rate_end_qty
       FROM restocks
       WHERE country = $1 AND item_id = $2
       ORDER BY depleted_ts ASC`,
      [country, itemId]
    ),
    one(
      pool,
      `SELECT yata_ts, quantity FROM snapshots
       WHERE country = $1 AND item_id = $2
       ORDER BY yata_ts DESC
       LIMIT 1`,
      [country, itemId]
    ),
  ]);

  const windows = [];
  for (let i = 0; i < events.length; i++) {
    const row = events[i];
    if (row.ignored) continue;
    const startTs = row.restocked_ts;
    if (startTs == null) continue;

    if (row.rate_end_ts != null && row.rate_start_qty != null && row.rate_end_qty != null) {
      const minutes = (row.rate_end_ts - startTs) / 60;
      if (minutes <= 0) continue;
      windows.push({
        start_ts: startTs,
        end_ts: row.rate_end_ts,
        start_qty: row.rate_start_qty,
        end_qty: row.rate_end_qty,
        rate: (row.rate_start_qty - row.rate_end_qty) / minutes,
        open: false,
      });
      continue;
    }

    // Open in-stock window: only the latest restock cycle can still be depleting.
    if (i !== events.length - 1 || row.rate_end_ts != null) continue;
    if (!latest || latest.quantity === 0) continue;
    if (latest.yata_ts <= startTs) continue;
    const startQty = row.rate_start_qty;
    if (!startQty) continue;
    const minutes = (latest.yata_ts - startTs) / 60;
    if (minutes <= 0) continue;
    windows.push({
      start_ts: startTs,
      end_ts: latest.yata_ts,
      start_qty: startQty,
      end_qty: latest.quantity,
      rate: (startQty - latest.quantity) / minutes,
      open: true,
    });
  }

  const ordered = windows.reverse();
  return limit == null ? ordered : ordered.slice(0, limit);
}

/** True when any non-ignored closed cycle is still missing persisted rate endpoints. */
export async function hasMissingPersistedRates() {
  const row = await one(
    getPool(),
    `SELECT EXISTS (
       SELECT 1 FROM restocks r
       WHERE r.ignored = 0
         AND r.restocked_ts IS NOT NULL
         AND r.rate_end_ts IS NULL
         AND EXISTS (
           SELECT 1 FROM restocks n
           WHERE n.country = r.country
             AND n.item_id = r.item_id
             AND n.depleted_ts > r.restocked_ts
         )
     ) AS missing`
  );
  return Boolean(row?.missing);
}

/** One-time / startup backfill of persisted rate windows for items still missing them. */
export async function backfillAllPersistedRates() {
  const items = await many(
    getPool(),
    `SELECT DISTINCT r.country, r.item_id AS "itemId"
     FROM restocks r
     WHERE r.ignored = 0
       AND r.restocked_ts IS NOT NULL
       AND r.rate_end_ts IS NULL
       AND EXISTS (
         SELECT 1 FROM restocks n
         WHERE n.country = r.country
           AND n.item_id = r.item_id
           AND n.depleted_ts > r.restocked_ts
       )
     ORDER BY r.country, r.item_id`
  );
  let itemsUpdated = 0;
  let windowsWritten = 0;
  for (const item of items) {
    const n = await withTransaction((client) =>
      fillRateWindowsForItem(client, item.country, item.itemId)
    );
    itemsUpdated += 1;
    windowsWritten += n;
  }
  return { itemsUpdated, windowsWritten };
}
