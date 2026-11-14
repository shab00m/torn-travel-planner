-- Shop availability is catalogue metadata, never a stock observation.
CREATE TABLE travel_items (
  country TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(item_id),
  cost BIGINT CHECK (cost >= 0),
  PRIMARY KEY (country, item_id)
);

CREATE FUNCTION notify_travel_item_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('snapshot_updates', json_build_object(
    'country', NEW.country, 'itemId', NEW.item_id, 'snapshot_ts', NULL)::text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER travel_items_notification
AFTER INSERT OR UPDATE ON travel_items
FOR EACH ROW EXECUTE FUNCTION notify_travel_item_change();
