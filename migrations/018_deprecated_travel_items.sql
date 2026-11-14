ALTER TABLE travel_items
  ADD COLUMN catalogue_deprecated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN deprecated_override BOOLEAN;

-- Remember observed combinations even after their raw snapshots expire.
INSERT INTO travel_items (country, item_id)
SELECT observed.country, observed.item_id
FROM (
  SELECT country, item_id FROM snapshots
  UNION
  SELECT country, item_id FROM restocks
) observed JOIN items USING (item_id)
ON CONFLICT DO NOTHING;
