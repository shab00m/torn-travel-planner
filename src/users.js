import { query } from "./pg.js";

/** Bootstrap admin — always ensured present on startup. */
export const BOOTSTRAP_ADMIN = {
  playerId: 4166571,
  name: "CptSpork",
};

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function mapUser(row) {
  if (!row) return null;
  return {
    playerId: row.player_id,
    name: row.name,
    isAdmin: Boolean(row.is_admin),
    isAllowed: Boolean(row.is_allowed),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? null,
  };
}

/** Ensure the bootstrap admin exists (insert only; never overwrite flags). */
export async function seedBootstrapAdmin() {
  const existing = await getUser(BOOTSTRAP_ADMIN.playerId);
  if (existing) return existing;
  const ts = nowTs();
  await query(
    `INSERT INTO users (player_id, name, is_admin, is_allowed, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (player_id) DO NOTHING`,
    [BOOTSTRAP_ADMIN.playerId, BOOTSTRAP_ADMIN.name, 1, 1, ts, ts]
  );
  return getUser(BOOTSTRAP_ADMIN.playerId);
}

export async function getUser(playerId) {
  const { rows } = await query(`SELECT * FROM users WHERE player_id = $1`, [playerId]);
  return mapUser(rows[0]);
}

/**
 * Return the user row, creating one with isAllowed=true (non-admin) if missing.
 * Existing rows are never overwritten — use this for first-login allow-by-default.
 */
export async function ensureUser(playerId, name) {
  const existing = await getUser(playerId);
  if (existing) return existing;

  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new Error("name is required");

  const ts = nowTs();
  await query(
    `INSERT INTO users (player_id, name, is_admin, is_allowed, created_at, updated_at)
     VALUES ($1, $2, 0, 1, $3, $4)
     ON CONFLICT (player_id) DO NOTHING`,
    [playerId, trimmed, ts, ts]
  );
  return getUser(playerId);
}

export async function listUsers() {
  const { rows } = await query(
    `SELECT * FROM users ORDER BY is_admin DESC, lower(name) ASC`
  );
  return rows.map(mapUser);
}

/**
 * @param {{ playerId: number, name: string, isAdmin?: boolean, isAllowed?: boolean }} fields
 */
export async function createUser(fields) {
  const playerId = fields.playerId;
  if (!Number.isInteger(playerId) || playerId <= 0) {
    throw new Error("playerId must be a positive integer");
  }
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  if (!name) throw new Error("name is required");

  const isAdmin = Boolean(fields.isAdmin);
  const isAllowed = fields.isAllowed !== undefined ? Boolean(fields.isAllowed) : true;
  const ts = nowTs();

  try {
    await query(
      `INSERT INTO users (player_id, name, is_admin, is_allowed, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [playerId, name, isAdmin ? 1 : 0, isAllowed ? 1 : 0, ts, ts]
    );
  } catch (err) {
    if (err?.code === "23505") {
      throw new Error("User already exists");
    }
    throw err;
  }
  return getUser(playerId);
}

/**
 * @param {number} playerId
 * @param {{ name?: string, isAdmin?: boolean, isAllowed?: boolean }} fields
 */
export async function updateUser(playerId, fields) {
  const existing = await getUser(playerId);
  if (!existing) throw new Error("User not found");

  const name =
    fields.name !== undefined ? String(fields.name).trim() : existing.name;
  if (!name) throw new Error("name is required");

  const isAdmin =
    fields.isAdmin !== undefined ? Boolean(fields.isAdmin) : existing.isAdmin;
  const isAllowed =
    fields.isAllowed !== undefined ? Boolean(fields.isAllowed) : existing.isAllowed;

  if (existing.isAdmin && existing.isAllowed && (!isAdmin || !isAllowed)) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM users WHERE is_admin = 1 AND is_allowed = 1`
    );
    if (rows[0].n <= 1) {
      throw new Error("Cannot demote or disallow the last admin");
    }
  }

  await query(
    `UPDATE users
     SET name = $1, is_admin = $2, is_allowed = $3, updated_at = $4
     WHERE player_id = $5`,
    [name, isAdmin ? 1 : 0, isAllowed ? 1 : 0, nowTs(), playerId]
  );
  return getUser(playerId);
}

export async function deleteUser(playerId) {
  const existing = await getUser(playerId);
  if (!existing) throw new Error("User not found");

  if (existing.isAdmin && existing.isAllowed) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM users WHERE is_admin = 1 AND is_allowed = 1`
    );
    if (rows[0].n <= 1) {
      throw new Error("Cannot delete the last admin");
    }
  }

  const res = await query(`DELETE FROM users WHERE player_id = $1`, [playerId]);
  if (res.rowCount === 0) throw new Error("User not found");
}

/** Sync display name and last login after a successful allow check. */
export async function recordLogin(playerId, name) {
  const ts = nowTs();
  await query(
    `UPDATE users SET name = $1, last_login_at = $2, updated_at = $3 WHERE player_id = $4`,
    [name, ts, ts, playerId]
  );
  return getUser(playerId);
}
