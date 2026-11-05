import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSnapshotEvents } from "../src/snapshot-events.js";

test("snapshot streams send changed items, scope revisions, and release their connection", async () => {
  const connection = new EventEmitter();
  let releases = 0;
  connection.query = async (sql) => assert.equal(sql, "LISTEN snapshot_updates");
  connection.release = () => { releases++; connection.emit("end"); };
  const events = createSnapshotEvents({ connect: async () => connection });
  try {
    await events.start();
    const req = new EventEmitter();
    const res = new EventEmitter();
    const writes = [];
    res.set = (headers) => assert.equal(headers["Content-Type"], "text/event-stream");
    res.flushHeaders = () => {};
    res.write = (text) => writes.push(text);
    res.end = () => {};
    events.handler(req, res);
    assert.match(writes[0], /event: ready/);
    const before = events.revision("mex", 260);
    const other = events.revision("can", 260);
    connection.emit("notification", { channel: "snapshot_updates", payload: JSON.stringify({ country: "mex", itemId: 260, snapshot_ts: 100 }) });
    assert.match(writes.at(-1), /event: snapshots/);
    assert.match(writes.at(-1), /"itemId":260/);
    assert.notEqual(events.revision("mex", 260), before);
    assert.equal(events.revision("can", 260), other);
    const count = writes.length;
    connection.emit("notification", { channel: "snapshot_updates", payload: "invalid" });
    assert.equal(writes.length, count);
    req.emit("close");
    connection.emit("notification", { channel: "snapshot_updates", payload: JSON.stringify({ country: "mex", itemId: 260 }) });
    assert.equal(writes.length, count);
  } finally { events.close(); }
  assert.equal(releases, 1);
});
