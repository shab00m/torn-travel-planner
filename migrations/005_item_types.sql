-- Torn item type (Plushie, Drug, Flower, …) stored on our items catalogue.
ALTER TABLE items ADD COLUMN IF NOT EXISTS item_type TEXT;

CREATE INDEX IF NOT EXISTS idx_items_item_type ON items (item_type);
