CREATE TABLE IF NOT EXISTS items (
  item_id INTEGER PRIMARY KEY,
  name    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  country   TEXT    NOT NULL,
  item_id   INTEGER NOT NULL,
  yata_ts   BIGINT  NOT NULL,
  quantity  BIGINT  NOT NULL,
  cost      BIGINT  NOT NULL,
  PRIMARY KEY (country, item_id, yata_ts)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_item
  ON snapshots (country, item_id, yata_ts DESC);

CREATE TABLE IF NOT EXISTS restocks (
  country      TEXT    NOT NULL,
  item_id      INTEGER NOT NULL,
  depleted_ts  BIGINT  NOT NULL,
  restocked_ts BIGINT,
  duration     INTEGER,
  ignored      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (country, item_id, depleted_ts)
);

CREATE TABLE IF NOT EXISTS market_prices (
  item_id      INTEGER PRIMARY KEY,
  market_price BIGINT,
  fetched_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS restock_amounts (
  country TEXT    NOT NULL,
  item_id INTEGER NOT NULL,
  amount  BIGINT  NOT NULL,
  PRIMARY KEY (country, item_id)
);

CREATE TABLE IF NOT EXISTS users (
  player_id     INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  is_allowed    INTEGER NOT NULL DEFAULT 0,
  created_at    BIGINT  NOT NULL,
  updated_at    BIGINT  NOT NULL,
  last_login_at BIGINT
);
