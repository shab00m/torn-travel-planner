ALTER TABLE travel_items
  ADD COLUMN workday_trips JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Filling a calculation cache does not change the stock feed. Admin refreshes
-- send their own notification so open pages can reload the saved estimate.
DROP TRIGGER travel_items_notification ON travel_items;
CREATE TRIGGER travel_items_notification
AFTER INSERT OR UPDATE OF cost, catalogue_deprecated, deprecated_override ON travel_items
FOR EACH ROW EXECUTE FUNCTION notify_travel_item_change();
