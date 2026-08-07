-- Persisted restock-time back-extrapolation (observed restocked_ts stays as the
-- first in-stock snapshot key for rate windows / snapshot joins).
ALTER TABLE restocks
  ADD COLUMN IF NOT EXISTS adjusted_restocked_ts BIGINT,
  ADD COLUMN IF NOT EXISTS adjusted_duration INTEGER;
