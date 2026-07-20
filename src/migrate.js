import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./pg.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Apply pending SQL files in migrations/ (lexicographic order).
 * @returns {Promise<string[]>} IDs of migrations applied this run
 */
export async function runMigrations() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const { rows: appliedRows } = await pool.query(`SELECT id FROM schema_migrations`);
  const applied = new Set(appliedRows.map((r) => r.id));
  const newlyApplied = [];

  for (const file of files) {
    const id = file.replace(/\.sql$/i, "");
    if (applied.has(id)) continue;

    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [id]);
      await client.query("COMMIT");
      newlyApplied.push(id);
      console.log(`[migrate] applied ${id}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  return newlyApplied;
}
