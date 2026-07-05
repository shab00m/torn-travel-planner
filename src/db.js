import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "travel.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS items (
    item_id INTEGER PRIMARY KEY,
    name    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    country   TEXT    NOT NULL,
    item_id   INTEGER NOT NULL,
    yata_ts   INTEGER NOT NULL,
    quantity  INTEGER NOT NULL,
    cost      INTEGER NOT NULL,
    PRIMARY KEY (country, item_id, yata_ts)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_snapshots_item
    ON snapshots (country, item_id, yata_ts DESC);

  -- One row per out-of-stock period. restocked_ts / duration stay NULL
  -- until the item comes back in stock.
  CREATE TABLE IF NOT EXISTS restocks (
    country      TEXT    NOT NULL,
    item_id      INTEGER NOT NULL,
    depleted_ts  INTEGER NOT NULL,
    restocked_ts INTEGER,
    duration     INTEGER,
    PRIMARY KEY (country, item_id, depleted_ts)
  ) WITHOUT ROWID;
`);

const upsertItem = db.prepare(
  `INSERT INTO items (item_id, name) VALUES (?, ?)
   ON CONFLICT(item_id) DO UPDATE SET name = excluded.name`
);

// Same (country, yata_ts) batch may be fetched multiple times; ignore duplicates.
const insertSnapshot = db.prepare(
  `INSERT OR IGNORE INTO snapshots (country, item_id, yata_ts, quantity, cost)
   VALUES (?, ?, ?, ?, ?)`
);

const prevQuantityStmt = db.prepare(
  `SELECT quantity FROM snapshots
   WHERE country = ? AND item_id = ? AND yata_ts < ?
   ORDER BY yata_ts DESC LIMIT 1`
);

const openRestockStmt = db.prepare(
  `SELECT depleted_ts FROM restocks
   WHERE country = ? AND item_id = ? AND restocked_ts IS NULL AND depleted_ts < ?
   ORDER BY depleted_ts DESC LIMIT 1`
);

// Earliest zero snapshot before a restock — used when tracking started mid
// out-of-stock run with no prior in-stock snapshot.
const firstZeroBeforeStmt = db.prepare(
  `SELECT yata_ts FROM snapshots
   WHERE country = ? AND item_id = ? AND yata_ts < ? AND quantity = 0
   ORDER BY yata_ts ASC LIMIT 1`
);

// Most recent >0→0 transition before a restock — the missed depletion for the
// current out-of-stock run (not the first zero ever recorded).
const missedDepletionBeforeStmt = db.prepare(
  `SELECT s.yata_ts FROM snapshots s
   WHERE s.country = ? AND s.item_id = ? AND s.yata_ts < ? AND s.quantity = 0
     AND (
       SELECT p.quantity FROM snapshots p
       WHERE p.country = s.country AND p.item_id = s.item_id AND p.yata_ts < s.yata_ts
       ORDER BY p.yata_ts DESC LIMIT 1
     ) > 0
   ORDER BY s.yata_ts DESC LIMIT 1`
);

const restockRowStmt = db.prepare(
  `SELECT depleted_ts, restocked_ts FROM restocks
   WHERE country = ? AND item_id = ? AND depleted_ts = ?`
);

const insertRestockStmt = db.prepare(
  `INSERT OR IGNORE INTO restocks (country, item_id, depleted_ts) VALUES (?, ?, ?)`
);

const closeRestockStmt = db.prepare(
  `UPDATE restocks
   SET restocked_ts = ?, duration = ? - depleted_ts
   WHERE country = ? AND item_id = ? AND depleted_ts = ? AND restocked_ts IS NULL`
);

// >0 -> 0 opens an out-of-stock period, 0 -> >0 closes the most recent
// open period started before this timestamp and fixes the duration.
// Returns what happened so callers can report it.
function applyTransition(country, itemId, ts, prevQuantity, quantity) {
  if (prevQuantity > 0 && quantity === 0) {
    const res = insertRestockStmt.run(country, itemId, ts);
    return res.changes > 0 ? "depleted" : null;
  }
  if (prevQuantity === 0 && quantity > 0) {
    let depletedTs = openRestockStmt.get(country, itemId, ts)?.depleted_ts;
    // No open period — infer the depletion for this out-of-stock run.
    if (depletedTs == null) {
      depletedTs =
        missedDepletionBeforeStmt.get(country, itemId, ts)?.yata_ts ??
        firstZeroBeforeStmt.get(country, itemId, ts)?.yata_ts ??
        null;
      if (depletedTs != null) {
        const existing = restockRowStmt.get(country, itemId, depletedTs);
        if (existing?.restocked_ts != null) return null;
        insertRestockStmt.run(country, itemId, depletedTs);
      }
    }
    if (depletedTs != null) {
      const res = closeRestockStmt.run(ts, ts, country, itemId, depletedTs);
      return res.changes > 0 ? "restocked" : null;
    }
  }
  return null;
}

function trackRestock(country, itemId, ts, quantity) {
  const prev = prevQuantityStmt.get(country, itemId, ts);
  if (prev) applyTransition(country, itemId, ts, prev.quantity, quantity);
}

const allSnapshotsStmt = db.prepare(
  `SELECT country, item_id, yata_ts, quantity
   FROM snapshots
   ORDER BY country, item_id, yata_ts ASC`
);

/**
 * Replay the whole snapshot history through the transition logic.
 * Clears existing restock rows first so logic fixes take effect on rerun.
 */
export function backfillRestocks() {
  db.exec("DELETE FROM restocks");
  let opened = 0;
  let closed = 0;
  let key = null;
  let prevQuantity = null;
  for (const row of allSnapshotsStmt.all()) {
    const rowKey = `${row.country}:${row.item_id}`;
    if (rowKey === key) {
      const result = applyTransition(row.country, row.item_id, row.yata_ts, prevQuantity, row.quantity);
      if (result === "depleted") opened += 1;
      else if (result === "restocked") closed += 1;
    }
    key = rowKey;
    prevQuantity = row.quantity;
  }
  return { opened, closed };
}

/**
 * Persist one YATA export payload. Returns the number of new rows stored.
 * @param {object} stocks - the "stocks" object from the YATA export
 */
export function saveSnapshot(stocks) {
  let inserted = 0;
  for (const [country, data] of Object.entries(stocks)) {
    for (const item of data.stocks) {
      upsertItem.run(item.id, item.name);
      trackRestock(country, item.id, data.update, item.quantity);
      const res = insertSnapshot.run(country, item.id, data.update, item.quantity, item.cost);
      inserted += res.changes;
    }
  }
  return inserted;
}

const historyStmt = db.prepare(
  `SELECT yata_ts, quantity, cost
   FROM snapshots
   WHERE country = ? AND item_id = ? AND yata_ts >= ?
   ORDER BY yata_ts ASC`
);

/**
 * @param {string} country - YATA country code
 * @param {number} itemId
 * @param {number} sinceTs - unix timestamp lower bound (0 for all)
 */
export function getHistory(country, itemId, sinceTs) {
  return historyStmt.all(country, itemId, sinceTs);
}

const restocksStmt = db.prepare(
  `SELECT depleted_ts, restocked_ts, duration
   FROM restocks
   WHERE country = ? AND item_id = ?
   ORDER BY depleted_ts DESC
   LIMIT ?`
);

/** Most recent out-of-stock periods, newest first (open period included). */
export function getRestocks(country, itemId, limit) {
  return restocksStmt.all(country, itemId, limit);
}

const restockEventsAscStmt = db.prepare(
  `SELECT depleted_ts, restocked_ts FROM restocks
   WHERE country = ? AND item_id = ?
   ORDER BY depleted_ts ASC`
);

const quantityAtStmt = db.prepare(
  `SELECT quantity FROM snapshots WHERE country = ? AND item_id = ? AND yata_ts = ?`
);

const latestSnapshotStmt = db.prepare(
  `SELECT yata_ts, quantity FROM snapshots
   WHERE country = ? AND item_id = ?
   ORDER BY yata_ts DESC LIMIT 1`
);

const lastPositiveBeforeStmt = db.prepare(
  `SELECT yata_ts, quantity FROM snapshots
   WHERE country = ? AND item_id = ? AND yata_ts < ? AND quantity > 0
   ORDER BY yata_ts DESC LIMIT 1`
);

/**
 * In-stock windows with their depletion rate, newest first.
 * A window runs from a restock event to the last in-stock snapshot before
 * the next depletion (qty > 0), since stock usually hits 0 between polls.
 * Rate is in items per minute.
 */
export function getDepletionRates(country, itemId, limit) {
  const events = restockEventsAscStmt.all(country, itemId);
  const windows = [];
  for (let i = 0; i < events.length; i++) {
    const startTs = events[i].restocked_ts;
    if (startTs == null) continue;
    const startQty = quantityAtStmt.get(country, itemId, startTs)?.quantity;
    if (!startQty) continue;

    let endTs;
    let endQty;
    let open = false;
    const nextDepletion = events[i + 1]?.depleted_ts;
    if (nextDepletion != null) {
      const lastPositive = lastPositiveBeforeStmt.get(country, itemId, nextDepletion);
      if (lastPositive && lastPositive.yata_ts > startTs) {
        endTs = lastPositive.yata_ts;
        endQty = lastPositive.quantity;
      } else {
        endTs = nextDepletion;
        endQty = 0;
      }
    } else {
      const latest = latestSnapshotStmt.get(country, itemId);
      if (!latest || latest.quantity === 0) continue;
      endTs = latest.yata_ts;
      endQty = latest.quantity;
      open = true;
    }

    const minutes = (endTs - startTs) / 60;
    if (minutes <= 0) continue;
    windows.push({
      start_ts: startTs,
      end_ts: endTs,
      start_qty: startQty,
      end_qty: endQty,
      rate: (startQty - endQty) / minutes,
      open,
    });
  }
  return windows.reverse().slice(0, limit);
}

export default db;
