import db from "./db.js";

/** Bootstrap admin — always ensured present on startup. */
export const BOOTSTRAP_ADMIN = {
  playerId: 4166571,
  name: "CptSpork",
};

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    player_id     INTEGER PRIMARY KEY,
    name          TEXT    NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    is_allowed    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );
`);

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

const getUserStmt = db.prepare(`SELECT * FROM users WHERE player_id = ?`);
const listUsersStmt = db.prepare(
  `SELECT * FROM users ORDER BY is_admin DESC, name COLLATE NOCASE ASC`
);
const insertUserStmt = db.prepare(
  `INSERT INTO users (player_id, name, is_admin, is_allowed, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const updateUserStmt = db.prepare(
  `UPDATE users
   SET name = ?, is_admin = ?, is_allowed = ?, updated_at = ?
   WHERE player_id = ?`
);
const deleteUserStmt = db.prepare(`DELETE FROM users WHERE player_id = ?`);
const touchLoginStmt = db.prepare(
  `UPDATE users SET name = ?, last_login_at = ?, updated_at = ? WHERE player_id = ?`
);
const adminCountStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND is_allowed = 1`
);

/** Ensure the bootstrap admin exists (insert only; never overwrite flags). */
export function seedBootstrapAdmin() {
  const existing = getUserStmt.get(BOOTSTRAP_ADMIN.playerId);
  if (existing) return mapUser(existing);
  const ts = nowTs();
  insertUserStmt.run(
    BOOTSTRAP_ADMIN.playerId,
    BOOTSTRAP_ADMIN.name,
    1,
    1,
    ts,
    ts
  );
  return getUser(BOOTSTRAP_ADMIN.playerId);
}

seedBootstrapAdmin();

export function getUser(playerId) {
  return mapUser(getUserStmt.get(playerId));
}

export function listUsers() {
  return listUsersStmt.all().map(mapUser);
}

/**
 * @param {{ playerId: number, name: string, isAdmin?: boolean, isAllowed?: boolean }} fields
 */
export function createUser(fields) {
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
    insertUserStmt.run(playerId, name, isAdmin ? 1 : 0, isAllowed ? 1 : 0, ts, ts);
  } catch (err) {
    if (String(err?.message ?? "").includes("UNIQUE")) {
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
export function updateUser(playerId, fields) {
  const existing = getUser(playerId);
  if (!existing) throw new Error("User not found");

  const name =
    fields.name !== undefined
      ? String(fields.name).trim()
      : existing.name;
  if (!name) throw new Error("name is required");

  const isAdmin =
    fields.isAdmin !== undefined ? Boolean(fields.isAdmin) : existing.isAdmin;
  const isAllowed =
    fields.isAllowed !== undefined ? Boolean(fields.isAllowed) : existing.isAllowed;

  if (existing.isAdmin && existing.isAllowed && (!isAdmin || !isAllowed)) {
    const admins = adminCountStmt.get().n;
    if (admins <= 1) {
      throw new Error("Cannot demote or disallow the last admin");
    }
  }

  updateUserStmt.run(name, isAdmin ? 1 : 0, isAllowed ? 1 : 0, nowTs(), playerId);
  return getUser(playerId);
}

export function deleteUser(playerId) {
  const existing = getUser(playerId);
  if (!existing) throw new Error("User not found");

  if (existing.isAdmin && existing.isAllowed) {
    const admins = adminCountStmt.get().n;
    if (admins <= 1) {
      throw new Error("Cannot delete the last admin");
    }
  }

  const res = deleteUserStmt.run(playerId);
  if (res.changes === 0) throw new Error("User not found");
}

/** Sync display name and last login after a successful whitelist check. */
export function recordLogin(playerId, name) {
  touchLoginStmt.run(name, nowTs(), nowTs(), playerId);
  return getUser(playerId);
}
