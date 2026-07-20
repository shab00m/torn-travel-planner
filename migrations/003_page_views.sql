CREATE TABLE IF NOT EXISTS page_views (
  id         BIGSERIAL PRIMARY KEY,
  created_at BIGINT NOT NULL,
  url        TEXT   NOT NULL,
  ip_address TEXT,
  player_id  INTEGER,
  name       TEXT
);

CREATE INDEX IF NOT EXISTS idx_page_views_created_at
  ON page_views (created_at DESC);
