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
    ignored      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (country, item_id, depleted_ts)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS market_prices (
    item_id      INTEGER PRIMARY KEY,
    market_price INTEGER,
    fetched_at   INTEGER NOT NULL
  );
`);

try {
  db.exec(`ALTER TABLE restocks ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0`);
} catch {
  // column already exists
}

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
  const ignoredRows = db
    .prepare(
      `SELECT country, item_id, depleted_ts FROM restocks WHERE ignored = 1`
    )
    .all();
  const restoreIgnoredStmt = db.prepare(
    `UPDATE restocks SET ignored = 1
     WHERE country = ? AND item_id = ? AND depleted_ts = ?`
  );

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

  for (const row of ignoredRows) {
    restoreIgnoredStmt.run(row.country, row.item_id, row.depleted_ts);
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
  `SELECT depleted_ts, restocked_ts, duration, ignored
   FROM restocks
   WHERE country = ? AND item_id = ?
   ORDER BY depleted_ts DESC
   LIMIT ?`
);

/** Most recent out-of-stock periods, newest first (open period included). */
export function getRestocks(country, itemId, limit) {
  return restocksStmt.all(country, itemId, limit).map((row) => ({
    ...row,
    ignored: Boolean(row.ignored),
  }));
}

const restockEventsAscStmt = db.prepare(
  `SELECT depleted_ts, restocked_ts, ignored FROM restocks
   WHERE country = ? AND item_id = ?
   ORDER BY depleted_ts ASC`
);

const setRestockIgnoredStmt = db.prepare(
  `UPDATE restocks SET ignored = ?
   WHERE country = ? AND item_id = ? AND depleted_ts = ?`
);

/** Mark a completed restock cycle as ignored (excluded from averages). */
export function setRestockIgnored(country, itemId, depletedTs, ignored) {
  const res = setRestockIgnoredStmt.run(ignored ? 1 : 0, country, itemId, depletedTs);
  if (res.changes === 0) throw new Error("Restock cycle not found");
}

const quantityAtStmt = db.prepare(
  `SELECT quantity FROM snapshots WHERE country = ? AND item_id = ? AND yata_ts = ?`
);

const snapshotStmt = db.prepare(
  `SELECT yata_ts, quantity, cost FROM snapshots
   WHERE country = ? AND item_id = ? AND yata_ts = ?`
);

const updateSnapshotStmt = db.prepare(
  `UPDATE snapshots SET quantity = ?, cost = ?
   WHERE country = ? AND item_id = ? AND yata_ts = ?`
);

const deleteSnapshotStmt = db.prepare(
  `DELETE FROM snapshots WHERE country = ? AND item_id = ? AND yata_ts = ?`
);

const upsertSnapshotStmt = db.prepare(
  `INSERT OR REPLACE INTO snapshots (country, item_id, yata_ts, quantity, cost)
   VALUES (?, ?, ?, ?, ?)`
);

export function getSnapshot(country, itemId, yataTs) {
  return snapshotStmt.get(country, itemId, yataTs) ?? null;
}

/**
 * Update quantity, cost, and/or timestamp for one snapshot row.
 * Changing yata_ts replaces the primary-key row.
 */
export function updateSnapshot(country, itemId, yataTs, fields) {
  const row = snapshotStmt.get(country, itemId, yataTs);
  if (!row) throw new Error("Snapshot not found");

  const quantity = fields.quantity ?? row.quantity;
  const cost = fields.cost ?? row.cost;
  const newYataTs = fields.yata_ts;

  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error("quantity must be a non-negative integer");
  }
  if (!Number.isInteger(cost) || cost < 0) {
    throw new Error("cost must be a non-negative integer");
  }

  if (newYataTs != null && newYataTs !== yataTs) {
    if (!Number.isInteger(newYataTs) || newYataTs <= 0) {
      throw new Error("yata_ts must be a positive integer");
    }
    db.exec("BEGIN");
    try {
      deleteSnapshotStmt.run(country, itemId, yataTs);
      upsertSnapshotStmt.run(country, itemId, newYataTs, quantity, cost);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { yata_ts: newYataTs, quantity, cost };
  }

  updateSnapshotStmt.run(quantity, cost, country, itemId, yataTs);
  return { yata_ts: yataTs, quantity, cost };
}

export function deleteSnapshot(country, itemId, yataTs) {
  const res = deleteSnapshotStmt.run(country, itemId, yataTs);
  if (res.changes === 0) throw new Error("Snapshot not found");
}

/** Delete many snapshots for one item. Returns the number of rows removed. */
export function deleteSnapshots(country, itemId, yataTsList) {
  let deleted = 0;
  db.exec("BEGIN");
  try {
    for (const ts of yataTsList) {
      deleted += deleteSnapshotStmt.run(country, itemId, ts).changes;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return deleted;
}

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
    if (events[i].ignored) continue;
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

const getMarketPriceRowStmt = db.prepare(
  `SELECT market_price, fetched_at FROM market_prices WHERE item_id = ?`
);

const getAllMarketPriceRowsStmt = db.prepare(
  `SELECT item_id, market_price, fetched_at FROM market_prices`
);

const upsertMarketPriceStmt = db.prepare(
  `INSERT INTO market_prices (item_id, market_price, fetched_at) VALUES (?, ?, ?)
   ON CONFLICT(item_id) DO UPDATE SET
     market_price = excluded.market_price,
     fetched_at = excluded.fetched_at`
);

const staleMarketItemIdsStmt = db.prepare(
  `SELECT i.item_id
   FROM items i
   LEFT JOIN market_prices m ON m.item_id = i.item_id
   WHERE m.item_id IS NULL OR m.fetched_at < ?
   ORDER BY COALESCE(m.fetched_at, 0) ASC
   LIMIT ?`
);

export function getMarketPriceRow(itemId) {
  return getMarketPriceRowStmt.get(itemId);
}

export function getAllMarketPriceRows() {
  return getAllMarketPriceRowsStmt.all();
}

export function upsertMarketPrice(itemId, marketPrice, fetchedAt) {
  upsertMarketPriceStmt.run(itemId, marketPrice, fetchedAt);
}

/** Item ids missing from cache or older than staleBeforeTs, oldest first. */
export function getStaleMarketItemIds(staleBeforeTs, limit) {
  return staleMarketItemIdsStmt.all(staleBeforeTs, limit).map((row) => row.item_id);
}

export default db;
