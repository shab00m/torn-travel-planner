-- Indexes for restock/rate lookup patterns used by live YATA saves,
-- include/exclude toggles, open-cycle detection, and rate backfill.

-- Previous restock / finalizeRateWindowOnDepletion:
--   WHERE country, item_id, restocked_ts IS NOT NULL AND restocked_ts < $ts
--   ORDER BY restocked_ts DESC
CREATE INDEX IF NOT EXISTS idx_restocks_item_restocked
  ON restocks (country, item_id, restocked_ts DESC)
  WHERE restocked_ts IS NOT NULL;

-- Open (not yet restocked) cycles:
--   WHERE country, item_id, restocked_ts IS NULL ORDER BY depleted_ts DESC
CREATE INDEX IF NOT EXISTS idx_restocks_item_open
  ON restocks (country, item_id, depleted_ts DESC)
  WHERE restocked_ts IS NULL;

-- Startup rate-window backfill candidates:
--   ignored = 0 AND restocked_ts IS NOT NULL AND rate_end_ts IS NULL
CREATE INDEX IF NOT EXISTS idx_restocks_missing_rate
  ON restocks (country, item_id)
  WHERE ignored = 0 AND restocked_ts IS NOT NULL AND rate_end_ts IS NULL;

-- Last positive snapshot before depletion (finalizeRateWindowOnDepletion):
--   WHERE country, item_id, yata_ts < $ts AND quantity > 0 ORDER BY yata_ts DESC
CREATE INDEX IF NOT EXISTS idx_snapshots_item_positive
  ON snapshots (country, item_id, yata_ts DESC)
  WHERE quantity > 0;
