-- Persist completed in-stock depletion-rate windows on the restock row that
-- started them (restocked_ts). Closed when the next depletion is recorded.
-- Open windows keep rate_end_ts NULL and are derived at read time from the
-- latest snapshot.
ALTER TABLE restocks
  ADD COLUMN IF NOT EXISTS rate_start_qty BIGINT,
  ADD COLUMN IF NOT EXISTS rate_end_ts BIGINT,
  ADD COLUMN IF NOT EXISTS rate_end_qty BIGINT;
