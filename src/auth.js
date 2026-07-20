import { getPlayerInfo } from "./torn.js";
import { ensureUser, recordLogin } from "./users.js";

/** Read Torn API key from X-Api-Key header or JSON body. */
export function getApiKeyFromRequest(req) {
  const header = req.get("x-api-key");
  if (typeof header === "string" && header.trim()) return header.trim();
  if (typeof req.body?.apiKey === "string" && req.body.apiKey.trim()) {
    return req.body.apiKey.trim();
  }
  return null;
}

/**
 * Validate API key with Torn and return the local user row if allowed.
 * Missing users are auto-created with isAllowed=true (blacklist by unchecking Allowed).
 * @returns {Promise<{ player: object, user: object }>}
 */
export async function resolveAllowedUser(apiKey) {
  const player = await getPlayerInfo(apiKey);
  const user = await ensureUser(player.playerId, player.name);
  if (!user?.isAllowed) {
    const err = new Error("Access denied: your Torn account is not allowed");
    err.statusCode = 403;
    throw err;
  }
  return { player, user: await recordLogin(player.playerId, player.name) };
}

/** Express middleware: require an allowed admin (via X-Api-Key or body.apiKey). */
export async function requireAdmin(req, res, next) {
  const apiKey = getApiKeyFromRequest(req);
  if (!apiKey) {
    res.status(401).json({ error: "apiKey is required" });
    return;
  }
  try {
    const { player, user } = await resolveAllowedUser(apiKey);
    if (!user.isAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    req.auth = { player, user, apiKey };
    next();
  } catch (err) {
    const status = err.statusCode === 403 ? 403 : 502;
    res.status(status).json({ error: err.message });
  }
}
