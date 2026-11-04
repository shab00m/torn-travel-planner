import { timingSafeEqual } from "node:crypto";

// Server-only shared key for internal snapshot ingestion.
export const INTERNAL_API_KEY = "003c0807ae2f17d2107f79ac363a9ea9f102be5e2a63f06a60d61c3485fd66de";

export function requireInternalKey(req, res, next) {
  const supplied = req.get("x-internal-key");
  const expected = Buffer.from(INTERNAL_API_KEY);
  const candidate = Buffer.from(typeof supplied === "string" ? supplied : "");
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    res.status(401).json({ error: "Invalid internal API key" });
    return;
  }
  next();
}
