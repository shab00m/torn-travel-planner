-- Existing timestamps and indexes are preserved by PostgreSQL's column rename.
ALTER TABLE snapshots RENAME COLUMN yata_ts TO snapshot_ts;

-- All observations recorded before this migration came from YATA.
ALTER TABLE snapshots
  ADD COLUMN source TEXT NOT NULL DEFAULT 'YATA'
  CHECK (source IN ('YATA', 'API'));
