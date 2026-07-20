import { query } from "./pg.js";
import { getUser } from "./users.js";

const MAX_URL_LENGTH = 2048;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function mapPageView(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    url: row.url,
    ipAddress: row.ip_address ?? null,
    playerId: row.player_id ?? null,
    name: row.name ?? null,
  };
}

/**
 * Normalize a client-reported page URL (path + optional query).
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizePageUrl(raw) {
  if (typeof raw !== "string") {
    throw new Error("url is required");
  }
  const url = raw.trim();
  if (!url.startsWith("/") || url.startsWith("//")) {
    throw new Error("url must be a site-relative path");
  }
  if (url.length > MAX_URL_LENGTH) {
    throw new Error(`url must be at most ${MAX_URL_LENGTH} characters`);
  }
  return url;
}

/**
 * @param {{ url: string, ipAddress: string | null, playerId?: number | null }} fields
 */
export async function recordPageView(fields) {
  const url = normalizePageUrl(fields.url);
  const ipAddress =
    typeof fields.ipAddress === "string" && fields.ipAddress.trim()
      ? fields.ipAddress.trim().slice(0, 128)
      : null;

  let playerId = null;
  let name = null;
  const rawPlayerId = fields.playerId;
  if (rawPlayerId != null) {
    const parsed = Number.parseInt(String(rawPlayerId), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("playerId must be a positive integer");
    }
    playerId = parsed;
    const user = await getUser(playerId);
    if (user) name = user.name;
  }

  const { rows } = await query(
    `INSERT INTO page_views (created_at, url, ip_address, player_id, name)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [nowTs(), url, ipAddress, playerId, name]
  );
  return mapPageView(rows[0]);
}

/**
 * @param {{ limit?: number, offset?: number }} options
 */
export async function listPageViews(options = {}) {
  const limit = Number.parseInt(String(options.limit ?? DEFAULT_LIST_LIMIT), 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
  }

  const offset = Number.parseInt(String(options.offset ?? 0), 10);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative integer");
  }

  const { rows } = await query(
    `SELECT * FROM page_views
     ORDER BY created_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows.map(mapPageView);
}

/** Client IP from Express (requires `trust proxy` behind Railway/reverse proxies). */
export function getClientIp(req) {
  const ip = req.ip || req.socket?.remoteAddress;
  if (typeof ip !== "string" || !ip.trim()) return null;
  // Express may return IPv4-mapped IPv6 (:ffff:x.x.x.x)
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}
