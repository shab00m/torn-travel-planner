/**
 * Keep API run boundaries independently for each country/item across uploads.
 * Persist changed values immediately; retain only the newest unchanged repeat
 * until a change confirms it was the last observation of the preceding run.
 */
export function createSnapshotBuffer(save) {
  const items = new Map();
  // The caller serializes writes so a staged batch cannot race another batch.
  return async function write(records) {
    const staged = new Map();
    const output = [];
    for (const record of [...records].sort((a, b) => a.snapshot_ts - b.snapshot_ts)) {
      const key = `${record.country}:${record.itemId}`;
      const previous = staged.has(key) ? staged.get(key) : items.get(key);
      if (!previous) {
        output.push(record);
        staged.set(key, { last: record, held: false });
      } else if (record.snapshot_ts <= previous.last.snapshot_ts) {
        // Late uploads/retries cannot be classified against a newer run. Keep
        // them and any held boundary, then start fresh on the next observation.
        if (previous.held) output.push(previous.last);
        output.push(record);
        staged.set(key, null);
      } else if (record.quantity === previous.last.quantity && record.cost === previous.last.cost) {
        staged.set(key, { last: record, held: true });
      } else {
        if (previous.held) output.push(previous.last);
        output.push(record);
        staged.set(key, { last: record, held: false });
      }
    }
    const result = output.length ? await save(output) : { inserted: 0, skipped: 0 };
    // A failed atomic INSERT must not advance the filter past unsaved changes
    // or discard an earlier held boundary needed by a subsequent upload.
    for (const [key, state] of staged) {
      if (state) items.set(key, state);
      else items.delete(key);
    }
    return { ...result, submitted: output.length };
  };
}
