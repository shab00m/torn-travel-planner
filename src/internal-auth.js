import { timingSafeEqual } from "node:crypto";

export function requireInternalKey(req, res, next) {
  const key = process.env.INTERNAL_API_KEY?.trim();
  if (!key) {
    res.status(503).json({ error: "Internal API is not configured" });
    return;
  }
  const supplied = req.get("x-internal-key");
  const expected = Buffer.from(key);
  const candidate = Buffer.from(typeof supplied === "string" ? supplied : "");
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    res.status(401).json({ error: "Invalid internal API key" });
    return;
  }
  next();
}
