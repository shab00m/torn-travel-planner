-- Older draft of 005 used a separate item_types table; fold into items and drop it.
ALTER TABLE items ADD COLUMN IF NOT EXISTS item_type TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'item_types'
  ) THEN
    UPDATE items i
    SET item_type = t.item_type
    FROM item_types t
    WHERE i.item_id = t.item_id
      AND (i.item_type IS NULL OR i.item_type = '');
    DROP TABLE item_types;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_items_item_type ON items (item_type);
