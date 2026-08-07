-- Align depleted timestamps with the restocked pattern:
--   depleted_ts            = first observed qty=0 snapshot (raw)
--   adjusted_depleted_ts   = rate-extrapolated empty start (was stored in depleted_ts)
--
-- Rebuilds the table because depleted_ts is part of the primary key.

CREATE TABLE restocks_migrated (
  country               TEXT    NOT NULL,
  item_id               INTEGER NOT NULL,
  depleted_ts           BIGINT  NOT NULL,
  restocked_ts          BIGINT,
  duration              INTEGER,
  ignored               INTEGER NOT NULL DEFAULT 0,
  rate_start_qty        BIGINT,
  rate_end_ts           BIGINT,
  rate_end_qty          BIGINT,
  adjusted_restocked_ts BIGINT,
  adjusted_duration     INTEGER,
  adjusted_depleted_ts  BIGINT,
  PRIMARY KEY (country, item_id, depleted_ts)
);

WITH mapped AS (
  SELECT
    r.country,
    r.item_id,
    r.depleted_ts AS old_depleted_ts,
    r.restocked_ts,
    r.ignored,
    r.rate_start_qty,
    r.rate_end_ts,
    r.rate_end_qty,
    r.adjusted_restocked_ts,
    COALESCE(
      (
        SELECT MIN(s.yata_ts)
        FROM snapshots s
        WHERE s.country = r.country
          AND s.item_id = r.item_id
          AND s.quantity = 0
          AND s.yata_ts >= r.depleted_ts
          AND (r.restocked_ts IS NULL OR s.yata_ts < r.restocked_ts)
      ),
      r.depleted_ts
    ) AS observed_depleted_ts
  FROM restocks r
)
INSERT INTO restocks_migrated (
  country,
  item_id,
  depleted_ts,
  restocked_ts,
  duration,
  ignored,
  rate_start_qty,
  rate_end_ts,
  rate_end_qty,
  adjusted_restocked_ts,
  adjusted_duration,
  adjusted_depleted_ts
)
SELECT DISTINCT ON (country, item_id, observed_depleted_ts)
  country,
  item_id,
  observed_depleted_ts,
  restocked_ts,
  CASE
    WHEN restocked_ts IS NOT NULL THEN restocked_ts - observed_depleted_ts
    ELSE NULL
  END,
  ignored,
  rate_start_qty,
  rate_end_ts,
  rate_end_qty,
  adjusted_restocked_ts,
  CASE
    WHEN restocked_ts IS NOT NULL
    THEN COALESCE(adjusted_restocked_ts, restocked_ts) - old_depleted_ts
    ELSE NULL
  END,
  old_depleted_ts
FROM mapped
ORDER BY country, item_id, observed_depleted_ts, old_depleted_ts ASC;

DROP TABLE restocks;
ALTER TABLE restocks_migrated RENAME TO restocks;

CREATE INDEX IF NOT EXISTS idx_restocks_item_restocked
  ON restocks (country, item_id, restocked_ts DESC)
  WHERE restocked_ts IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_restocks_item_open
  ON restocks (country, item_id, depleted_ts DESC)
  WHERE restocked_ts IS NULL;

CREATE INDEX IF NOT EXISTS idx_restocks_missing_rate
  ON restocks (country, item_id)
  WHERE ignored = 0 AND restocked_ts IS NOT NULL AND rate_end_ts IS NULL;
