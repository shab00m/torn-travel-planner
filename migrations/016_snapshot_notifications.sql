CREATE FUNCTION notify_snapshot_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed RECORD;
BEGIN
  FOR changed IN
    SELECT country, item_id, MAX(snapshot_ts) AS snapshot_ts
    FROM inserted_snapshots GROUP BY country, item_id
  LOOP
    PERFORM pg_notify('snapshot_updates', json_build_object(
      'country', changed.country, 'itemId', changed.item_id,
      'snapshot_ts', changed.snapshot_ts)::text);
  END LOOP;
  RETURN NULL;
END;
$$;

-- PostgreSQL delivers these notifications only after the transaction commits.
CREATE TRIGGER snapshots_insert_notification
AFTER INSERT ON snapshots REFERENCING NEW TABLE AS inserted_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION notify_snapshot_insert();
