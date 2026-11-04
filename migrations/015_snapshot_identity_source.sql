ALTER TABLE snapshots DROP CONSTRAINT snapshots_pkey;
ALTER TABLE snapshots ADD PRIMARY KEY (country, item_id, snapshot_ts, source);

-- Keep both raw observations. Derived timelines need one value per instant;
-- prefer a direct API observation over YATA if the sources disagree.
CREATE VIEW effective_snapshots AS
SELECT DISTINCT ON (country, item_id, snapshot_ts)
       country, item_id, snapshot_ts, quantity, cost, source
FROM snapshots
ORDER BY country, item_id, snapshot_ts, source ASC;
