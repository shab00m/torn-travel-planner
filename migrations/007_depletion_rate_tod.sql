-- Minute-weighted average depletion rate by Torn City Time (UTC) hour-of-day.
-- Rebuilt daily from all completed (non-ignored) in-stock rate windows.
CREATE TABLE IF NOT EXISTS depletion_rate_tod (
  country         TEXT             NOT NULL,
  item_id         INTEGER          NOT NULL,
  hour_of_day     SMALLINT         NOT NULL CHECK (hour_of_day >= 0 AND hour_of_day < 24),
  avg_rate        DOUBLE PRECISION NOT NULL,
  weight_minutes  DOUBLE PRECISION NOT NULL,
  updated_at      BIGINT           NOT NULL,
  PRIMARY KEY (country, item_id, hour_of_day)
);

CREATE INDEX IF NOT EXISTS idx_depletion_rate_tod_item
  ON depletion_rate_tod (country, item_id);
