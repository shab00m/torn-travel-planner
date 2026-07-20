import pg from "pg";

const { Pool, types } = pg;

// BIGINT unix timestamps fit in JS number; avoid string results from node-pg.
types.setTypeParser(types.builtins.INT8, (val) => Number.parseInt(val, 10));

/** @type {pg.Pool | null} */
let pool = null;

function buildPoolConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !connectionString.trim()) {
    throw new Error("DATABASE_URL is required");
  }

  const needsSsl =
    process.env.DATABASE_SSL === "true" ||
    /proxy\.rlwy\.net|railway\.app|sslmode=require/i.test(connectionString);

  return {
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  };
}

/** Shared connection pool. Throws if DATABASE_URL is missing. */
export function getPool() {
  if (!pool) {
    pool = new Pool(buildPoolConfig());
    pool.on("error", (err) => {
      console.error("[pg] idle client error:", err.message);
    });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

/**
 * @template T
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
