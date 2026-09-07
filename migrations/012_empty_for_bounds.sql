CREATE TABLE IF NOT EXISTS empty_for_bounds (
  country        TEXT    NOT NULL,
  item_id        INTEGER NOT NULL,
  min_empty_for  INTEGER,
  max_empty_for  INTEGER,
  PRIMARY KEY (country, item_id),
  CHECK (min_empty_for IS NULL OR min_empty_for >= 0),
  CHECK (max_empty_for IS NULL OR max_empty_for >= 0),
  CHECK (
    min_empty_for IS NULL
    OR max_empty_for IS NULL
    OR min_empty_for <= max_empty_for
  )
);
