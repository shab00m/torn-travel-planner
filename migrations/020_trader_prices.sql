CREATE TABLE trader_prices (
  item_id    INTEGER PRIMARY KEY,
  offers     JSONB NOT NULL,
  fetched_at BIGINT NOT NULL
);
