import { getPool, query, withTransaction, closePool } from "./pg.js";
import { runMigrations } from "./migrate.js";
import { isCycleOutlier } from "./outliers.js";

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 * @param {string} text
 * @param {unknown[]} [params]
 */
async function one(db, text, params = []) {
  const { rows } = await db.query(text, params);
  return rows[0];
}

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 * @param {string} text
 * @param {unknown[]} [params]
 */
async function many(db, text, params = []) {
  const { rows } = await db.query(text, params);
  return rows;
}

/** Open pool and apply pending migrations. */
export async function initDb() {
  getPool();
  await runMigrations();
}

export { closePool };

/**
 * Items/min over [startTs, endTs] when stock fell from startQty to endQty.
 * @returns {number|null}
 */
function rateFromEndpoints(startTs, endTs, startQty, endQty) {
  const minutes = (endTs - startTs) / 60;
  if (minutes <= 0 || startQty <= endQty) return null;
  const rate = (startQty - endQty) / minutes;
  return rate > 0 ? rate : null;
}

/**
 * @param {import("pg").PoolClient} client
 */
async function depletionRateBefore(client, country, itemId, endTs, endQty) {
  const restockRow = await one(
    client,
    `SELECT restocked_ts FROM restocks
     WHERE country = $1 AND item_id = $2 AND restocked_ts IS NOT NULL AND restocked_ts <= $3
     ORDER BY restocked_ts DESC LIMIT 1`,
    [country, itemId, endTs]
  );
  const restockedTs = restockRow?.restocked_ts;
  if (restockedTs != null && restockedTs < endTs) {
    const startRow = await one(
      client,
      `SELECT quantity FROM snapshots WHERE country = $1 AND item_id = $2 AND yata_ts = $3`,
      [country, itemId, restockedTs]
    );
    if (startRow != null) {
      const rate = rateFromEndpoints(restockedTs, endTs, startRow.quantity, endQty);
      if (rate != null) return rate;
    }
  }

  const earlier = await one(
    client,
    `SELECT yata_ts, quantity FROM snapshots
     WHERE country = $1 AND item_id = $2 AND yata_ts < $3 AND quantity > 0
     ORDER BY yata_ts DESC LIMIT 1`,
    [country, itemId, endTs]
  );
  if (earlier && earlier.quantity > endQty) {
    const zeroHit = await one(
      client,
      `SELECT 1 AS hit FROM snapshots
       WHERE country = $1 AND item_id = $2 AND yata_ts > $3 AND yata_ts < $4 AND quantity = 0
       LIMIT 1`,
      [country, itemId, earlier.yata_ts, endTs]
    );
    if (!zeroHit) {
      return rateFromEndpoints(earlier.yata_ts, endTs, earlier.quantity, endQty);
    }
  }
  return null;
}

/**
 * @param {import("pg").PoolClient} client
 */
async function estimateDepletedTs(client, country, itemId, observedZeroTs, prevTs, prevQty) {
  if (prevTs == null || prevQty == null || prevQty <= 0 || prevTs >= observedZeroTs) {
    return observedZeroTs;
  }
  const rate = await depletionRateBefore(client, country, itemId, prevTs, prevQty);
  if (rate == null) return observedZeroTs;
  const estimated = Math.round(prevTs + (prevQty / rate) * 60);
  return Math.min(observedZeroTs, Math.max(prevTs + 1, estimated));
}

/**
 * @param {import("pg").PoolClient} client
 * @returns {Promise<"depleted"|"restocked"|null>}
 */
async function applyTransition(client, country, itemId, ts, prevTs, prevQuantity, quantity) {
  if (prevQuantity > 0 && quantity === 0) {
    const depletedTs = await estimateDepletedTs(client, country, itemId, ts, prevTs, prevQuantity);
    const res = await client.query(
      `INSERT INTO restocks (country, item_id, depleted_ts) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [country, itemId, depletedTs]
    );
    return res.rowCount > 0 ? "depleted" : null;
  }
  if (prevQuantity === 0 && quantity > 0) {
    let open = await one(
      client,
      `SELECT depleted_ts FROM restocks
       WHERE country = $1 AND item_id = $2 AND restocked_ts IS NULL AND depleted_ts < $3
       ORDER BY depleted_ts DESC LIMIT 1`,
      [country, itemId, ts]
    );
    let depletedTs = open?.depleted_ts;
    if (depletedTs == null) {
      const missed = await one(
        client,
        `SELECT s.yata_ts FROM snapshots s
         WHERE s.country = $1 AND s.item_id = $2 AND s.yata_ts < $3 AND s.quantity = 0
           AND (
             SELECT p.quantity FROM snapshots p
             WHERE p.country = s.country AND p.item_id = s.item_id AND p.yata_ts < s.yata_ts
             ORDER BY p.yata_ts DESC LIMIT 1
           ) > 0
         ORDER BY s.yata_ts DESC LIMIT 1`,
        [country, itemId, ts]
      );
      const firstZero = missed
        ? null
        : await one(
            client,
            `SELECT yata_ts FROM snapshots
             WHERE country = $1 AND item_id = $2 AND yata_ts < $3 AND quantity = 0
             ORDER BY yata_ts ASC LIMIT 1`,
            [country, itemId, ts]
          );
      const observedZero = missed?.yata_ts ?? firstZero?.yata_ts ?? null;
      if (observedZero != null) {
        const prev = await one(
          client,
          `SELECT yata_ts, quantity FROM snapshots
           WHERE country = $1 AND item_id = $2 AND yata_ts < $3
           ORDER BY yata_ts DESC LIMIT 1`,
          [country, itemId, observedZero]
        );
        depletedTs =
          prev && prev.quantity > 0
            ? await estimateDepletedTs(
                client,
                country,
                itemId,
                observedZero,
                prev.yata_ts,
                prev.quantity
              )
            : observedZero;
        const existing = await one(
          client,
          `SELECT depleted_ts, restocked_ts FROM restocks
           WHERE country = $1 AND item_id = $2 AND depleted_ts = $3`,
          [country, itemId, depletedTs]
        );
        if (existing?.restocked_ts != null) return null;
        await client.query(
          `INSERT INTO restocks (country, item_id, depleted_ts) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [country, itemId, depletedTs]
        );
      }
    }
    if (depletedTs != null) {
      const res = await client.query(
        `UPDATE restocks
         SET restocked_ts = $1, duration = $1 - depleted_ts
         WHERE country = $2 AND item_id = $3 AND depleted_ts = $4 AND restocked_ts IS NULL`,
        [ts, country, itemId, depletedTs]
      );
      return res.rowCount > 0 ? "restocked" : null;
    }
  }
  return null;
}

/**
 * @param {import("pg").PoolClient} client
 * @param {{ yata_ts: number, quantity: number } | null | undefined} [prevHint]
 *   Optional preloaded previous snapshot; when omitted, loads from DB.
 */
async function trackRestock(client, country, itemId, ts, quantity, prevHint) {
  const prev =
    prevHint !== undefined
      ? prevHint
      : await one(
          client,
          `SELECT yata_ts, quantity FROM snapshots
           WHERE country = $1 AND item_id = $2 AND yata_ts < $3
           ORDER BY yata_ts DESC LIMIT 1`,
          [country, itemId, ts]
        );
  if (!prev) return null;
  const result = await applyTransition(
    client,
    country,
    itemId,
    ts,
    prev.yata_ts,
    prev.quantity,
    quantity
  );
  if (result === "restocked") {
    await autoIgnoreOutlierAfterRestock(client, country, itemId, ts);
  }
  return result;
}

/**
 * Replay the whole snapshot history through the transition logic.
 * Clears existing restock rows first so logic fixes take effect on rerun.
 */
export async function backfillRestocks() {
  return withTransaction(async (client) => {
    const ignoredRows = await many(
      client,
      `SELECT country, item_id, depleted_ts FROM restocks WHERE ignored = 1`
    );

    await client.query("DELETE FROM restocks");
    let opened = 0;
    let closed = 0;
    let key = null;
    let prevTs = null;
    let prevQuantity = null;

    const snapshots = await many(
      client,
      `SELECT country, item_id, yata_ts, quantity
       FROM snapshots
       ORDER BY country, item_id, yata_ts ASC`
    );

    for (const row of snapshots) {
      const rowKey = `${row.country}:${row.item_id}`;
      if (rowKey === key) {
        const result = await applyTransition(
          client,
          row.country,
          row.item_id,
          row.yata_ts,
          prevTs,
          prevQuantity,
          row.quantity
        );
        if (result === "depleted") opened += 1;
        else if (result === "restocked") closed += 1;
      }
      key = rowKey;
      prevTs = row.yata_ts;
      prevQuantity = row.quantity;
    }

    for (const row of ignoredRows) {
      const match = await one(
        client,
        `SELECT depleted_ts FROM restocks
         WHERE country = $1 AND item_id = $2
           AND depleted_ts <= $3
           AND (restocked_ts IS NULL OR restocked_ts > $3)
         ORDER BY depleted_ts DESC LIMIT 1`,
        [row.country, row.item_id, row.depleted_ts]
      );
      if (match) {
        await client.query(
          `UPDATE restocks SET ignored = 1
           WHERE country = $1 AND item_id = $2 AND depleted_ts = $3`,
          [row.country, row.item_id, match.depleted_ts]
        );
      }
    }

    return { opened, closed };
  });
}

/**
 * Persist one YATA export payload. Returns the number of new rows stored.
 * @param {object} stocks - the "stocks" object from the YATA export
 */
export async function saveSnapshot(stocks) {
  return withTransaction(async (client) => {
    let inserted = 0;
    const itemEntries = [];
    const snapshotEntries = [];

    for (const [country, data] of Object.entries(stocks)) {
      for (const item of data.stocks) {
        itemEntries.push({ id: item.id, name: item.name });
        snapshotEntries.push({
          country,
          itemId: item.id,
          yataTs: data.update,
          quantity: item.quantity,
          cost: item.cost,
        });
      }
    }

    if (itemEntries.length) {
      // Same item can appear in multiple countries; Postgres rejects
      // ON CONFLICT DO UPDATE when a row is proposed twice in one INSERT.
      const byId = new Map();
      for (const entry of itemEntries) byId.set(entry.id, entry.name);
      const ids = [...byId.keys()];
      const names = [...byId.values()];
      await client.query(
        `INSERT INTO items (item_id, name)
         SELECT * FROM UNNEST($1::int[], $2::text[])
         ON CONFLICT (item_id) DO UPDATE SET name = EXCLUDED.name`,
        [ids, names]
      );
    }

    // One query for prior quantities instead of per-item lookups.
    const prevByKey = new Map();
    if (snapshotEntries.length) {
      const countries = snapshotEntries.map((e) => e.country);
      const itemIds = snapshotEntries.map((e) => e.itemId);
      const yataTs = snapshotEntries.map((e) => e.yataTs);
      const { rows } = await client.query(
        `WITH req AS (
           SELECT * FROM UNNEST($1::text[], $2::int[], $3::bigint[])
             AS t(country, item_id, yata_ts)
         )
         SELECT req.country, req.item_id, p.yata_ts, p.quantity
         FROM req
         JOIN LATERAL (
           SELECT yata_ts, quantity FROM snapshots
           WHERE country = req.country AND item_id = req.item_id AND yata_ts < req.yata_ts
           ORDER BY yata_ts DESC LIMIT 1
         ) p ON true`,
        [countries, itemIds, yataTs]
      );
      for (const row of rows) {
        prevByKey.set(`${row.country}:${row.item_id}`, {
          yata_ts: row.yata_ts,
          quantity: row.quantity,
        });
      }
    }

    for (const entry of snapshotEntries) {
      const prev = prevByKey.get(`${entry.country}:${entry.itemId}`) ?? null;
      await trackRestock(
        client,
        entry.country,
        entry.itemId,
        entry.yataTs,
        entry.quantity,
        prev
      );
    }

    if (snapshotEntries.length) {
      const countries = snapshotEntries.map((e) => e.country);
      const itemIds = snapshotEntries.map((e) => e.itemId);
      const yataTs = snapshotEntries.map((e) => e.yataTs);
      const quantities = snapshotEntries.map((e) => e.quantity);
      const costs = snapshotEntries.map((e) => e.cost);
      const res = await client.query(
        `INSERT INTO snapshots (country, item_id, yata_ts, quantity, cost)
         SELECT * FROM UNNEST($1::text[], $2::int[], $3::bigint[], $4::bigint[], $5::bigint[])
         ON CONFLICT DO NOTHING`,
        [countries, itemIds, yataTs, quantities, costs]
      );
      inserted = res.rowCount ?? 0;
    }

    return inserted;
  });
}

/**
 * @param {string} country - YATA country code
 * @param {number} itemId
 * @param {number} sinceTs - unix timestamp lower bound (0 for all)
 */
export async function getHistory(country, itemId, sinceTs) {
  return many(
    getPool(),
    `SELECT yata_ts, quantity, cost
     FROM snapshots
     WHERE country = $1 AND item_id = $2 AND yata_ts >= $3
     ORDER BY yata_ts ASC`,
    [country, itemId, sinceTs]
  );
}

/** Most recent out-of-stock periods, newest first (open period included). */
export async function getRestocks(country, itemId, limit) {
  const rows = await many(
    getPool(),
    `SELECT depleted_ts, restocked_ts, duration, ignored
     FROM restocks
     WHERE country = $1 AND item_id = $2
     ORDER BY depleted_ts DESC
     LIMIT $3`,
    [country, itemId, limit]
  );
  return rows.map((row) => ({
    ...row,
    ignored: Boolean(row.ignored),
  }));
}

/** Mark a completed restock cycle as ignored (excluded from averages). */
export async function setRestockIgnored(country, itemId, depletedTs, ignored) {
  const res = await query(
    `UPDATE restocks SET ignored = $1
     WHERE country = $2 AND item_id = $3 AND depleted_ts = $4`,
    [ignored ? 1 : 0, country, itemId, depletedTs]
  );
  if (res.rowCount === 0) throw new Error("Restock cycle not found");
}

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
async function loadCompletedRestocks(db, country, itemId) {
  const rows = await many(
    db,
    `SELECT depleted_ts, restocked_ts, duration, ignored
     FROM restocks
     WHERE country = $1 AND item_id = $2 AND duration IS NOT NULL
     ORDER BY depleted_ts ASC`,
    [country, itemId]
  );
  return rows.map((row) => ({
    depleted_ts: row.depleted_ts,
    restocked_ts: row.restocked_ts,
    duration: row.duration,
    ignored: Boolean(row.ignored),
  }));
}

function durationOutlierBaseline(cycles, excludeDepletedTs) {
  const durations = [];
  for (const cycle of cycles) {
    if (cycle.ignored) continue;
    if (cycle.depleted_ts === excludeDepletedTs) continue;
    if (cycle.duration != null && cycle.duration >= 0) durations.push(cycle.duration);
  }
  return { durations };
}

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
async function maybeIgnoreCycle(db, country, itemId, cycle, cycles) {
  if (!cycle || cycle.ignored || cycle.duration == null) return false;
  const baseline = durationOutlierBaseline(cycles, cycle.depleted_ts);
  if (!isCycleOutlier({ duration: cycle.duration }, baseline)) return false;
  await db.query(
    `UPDATE restocks SET ignored = 1
     WHERE country = $1 AND item_id = $2 AND depleted_ts = $3`,
    [country, itemId, cycle.depleted_ts]
  );
  cycle.ignored = true;
  return true;
}

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 */
async function autoIgnoreOutlierAfterRestock(db, country, itemId, restockedTs) {
  const cycles = await loadCompletedRestocks(db, country, itemId);
  const cycle = cycles.find((r) => r.restocked_ts === restockedTs);
  await maybeIgnoreCycle(db, country, itemId, cycle, cycles);
}

const MAX_OUTLIER_PASSES = 20;

/**
 * Scan all completed cycles for an item and uncheck Count on empty-for outliers.
 * @returns {Promise<{ flagged: number, depletedTs: number[] }>}
 */
export async function flagOutlierRestocks(country, itemId) {
  return withTransaction(async (client) => {
    const cycles = await loadCompletedRestocks(client, country, itemId);
    const depletedTs = [];

    for (let pass = 0; pass < MAX_OUTLIER_PASSES; pass++) {
      const batch = [];
      for (const cycle of cycles) {
        if (cycle.ignored || cycle.duration == null) continue;
        const baseline = durationOutlierBaseline(cycles, cycle.depleted_ts);
        if (!isCycleOutlier({ duration: cycle.duration }, baseline)) continue;
        batch.push(cycle);
      }
      if (!batch.length) break;

      for (const cycle of batch) {
        await client.query(
          `UPDATE restocks SET ignored = 1
           WHERE country = $1 AND item_id = $2 AND depleted_ts = $3`,
          [country, itemId, cycle.depleted_ts]
        );
        cycle.ignored = true;
        depletedTs.push(cycle.depleted_ts);
      }
    }

    return { flagged: depletedTs.length, depletedTs };
  });
}

export async function getSnapshot(country, itemId, yataTs) {
  return (
    (await one(
      getPool(),
      `SELECT yata_ts, quantity, cost FROM snapshots
       WHERE country = $1 AND item_id = $2 AND yata_ts = $3`,
      [country, itemId, yataTs]
    )) ?? null
  );
}

/**
 * Update quantity, cost, and/or timestamp for one snapshot row.
 * Changing yata_ts replaces the primary-key row.
 */
export async function updateSnapshot(country, itemId, yataTs, fields) {
  return withTransaction(async (client) => {
    const row = await one(
      client,
      `SELECT yata_ts, quantity, cost FROM snapshots
       WHERE country = $1 AND item_id = $2 AND yata_ts = $3`,
      [country, itemId, yataTs]
    );
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
      await client.query(
        `DELETE FROM snapshots WHERE country = $1 AND item_id = $2 AND yata_ts = $3`,
        [country, itemId, yataTs]
      );
      await client.query(
        `INSERT INTO snapshots (country, item_id, yata_ts, quantity, cost)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (country, item_id, yata_ts) DO UPDATE SET
           quantity = EXCLUDED.quantity,
           cost = EXCLUDED.cost`,
        [country, itemId, newYataTs, quantity, cost]
      );
      return { yata_ts: newYataTs, quantity, cost };
    }

    await client.query(
      `UPDATE snapshots SET quantity = $1, cost = $2
       WHERE country = $3 AND item_id = $4 AND yata_ts = $5`,
      [quantity, cost, country, itemId, yataTs]
    );
    return { yata_ts: yataTs, quantity, cost };
  });
}

export async function deleteSnapshot(country, itemId, yataTs) {
  const res = await query(
    `DELETE FROM snapshots WHERE country = $1 AND item_id = $2 AND yata_ts = $3`,
    [country, itemId, yataTs]
  );
  if (res.rowCount === 0) throw new Error("Snapshot not found");
}

/** Delete many snapshots for one item. Returns the number of rows removed. */
export async function deleteSnapshots(country, itemId, yataTsList) {
  return withTransaction(async (client) => {
    let deleted = 0;
    for (const ts of yataTsList) {
      const res = await client.query(
        `DELETE FROM snapshots WHERE country = $1 AND item_id = $2 AND yata_ts = $3`,
        [country, itemId, ts]
      );
      deleted += res.rowCount ?? 0;
    }
    return deleted;
  });
}

/**
 * Last snapshot with quantity > 0 and yata_ts < beforeTs.
 * @param {{ yata_ts: number, quantity: number }[]} snapshots ascending by yata_ts
 */
function lastPositiveBefore(snapshots, beforeTs) {
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
 * In-stock windows with their depletion rate, newest first.
 * Loads restocks + snapshots in two queries (avoids per-cycle round trips).
 */
export async function getDepletionRates(country, itemId, limit) {
  const pool = getPool();
  const [events, snapshots] = await Promise.all([
    many(
      pool,
      `SELECT depleted_ts, restocked_ts, ignored FROM restocks
       WHERE country = $1 AND item_id = $2
       ORDER BY depleted_ts ASC`,
      [country, itemId]
    ),
    many(
      pool,
      `SELECT yata_ts, quantity FROM snapshots
       WHERE country = $1 AND item_id = $2
       ORDER BY yata_ts ASC`,
      [country, itemId]
    ),
  ]);

  const qtyAt = new Map();
  for (const row of snapshots) qtyAt.set(row.yata_ts, row.quantity);
  const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;

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

export async function getMarketPriceRow(itemId) {
  return one(
    getPool(),
    `SELECT market_price, fetched_at FROM market_prices WHERE item_id = $1`,
    [itemId]
  );
}

export async function getAllMarketPriceRows() {
  return many(getPool(), `SELECT item_id, market_price, fetched_at FROM market_prices`);
}

export async function upsertMarketPrice(itemId, marketPrice, fetchedAt) {
  await query(
    `INSERT INTO market_prices (item_id, market_price, fetched_at) VALUES ($1, $2, $3)
     ON CONFLICT (item_id) DO UPDATE SET
       market_price = EXCLUDED.market_price,
       fetched_at = EXCLUDED.fetched_at`,
    [itemId, marketPrice, fetchedAt]
  );
}

/** Item ids missing from cache or older than staleBeforeTs, oldest first. */
export async function getStaleMarketItemIds(staleBeforeTs, limit) {
  const rows = await many(
    getPool(),
    `SELECT i.item_id
     FROM items i
     LEFT JOIN market_prices m ON m.item_id = i.item_id
     WHERE m.item_id IS NULL OR m.fetched_at < $1
     ORDER BY COALESCE(m.fetched_at, 0) ASC
     LIMIT $2`,
    [staleBeforeTs, limit]
  );
  return rows.map((row) => row.item_id);
}

export async function getRestockAmount(country, itemId) {
  const row = await one(
    getPool(),
    `SELECT amount FROM restock_amounts WHERE country = $1 AND item_id = $2`,
    [country, itemId]
  );
  return row?.amount ?? null;
}

/** All stored restock amounts keyed as "country:itemId". */
export async function getAllRestockAmounts() {
  const rows = await many(getPool(), `SELECT country, item_id, amount FROM restock_amounts`);
  const amounts = {};
  for (const row of rows) {
    amounts[`${row.country}:${row.item_id}`] = row.amount;
  }
  return amounts;
}

export async function setRestockAmount(country, itemId, amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("amount must be a positive integer");
  }
  await query(
    `INSERT INTO restock_amounts (country, item_id, amount) VALUES ($1, $2, $3)
     ON CONFLICT (country, item_id) DO UPDATE SET amount = EXCLUDED.amount`,
    [country, itemId, amount]
  );
}

export async function deleteRestockAmount(country, itemId) {
  await query(`DELETE FROM restock_amounts WHERE country = $1 AND item_id = $2`, [
    country,
    itemId,
  ]);
}
