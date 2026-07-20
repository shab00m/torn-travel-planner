-- Widen money/qty columns; Torn costs can exceed INT4 (e.g. 8e9).
ALTER TABLE snapshots
  ALTER COLUMN quantity TYPE BIGINT,
  ALTER COLUMN cost TYPE BIGINT;

ALTER TABLE market_prices
  ALTER COLUMN market_price TYPE BIGINT;

ALTER TABLE restock_amounts
  ALTER COLUMN amount TYPE BIGINT;
