import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/item.js", import.meta.url), "utf8");
const functions = ["snapshotIdentity", "isSnapshotSelected", "selectSnapshot",
  "selectSnapshotsInRange", "snapshotByTs", "renderSnapshotInspector"];

test("inspector selects and renders same-time observations as independent source rows", () => {
  const rows = [
    { snapshot_ts: 100, source: "YATA", quantity: 10, cost: 300 },
    { snapshot_ts: 100, source: "API", quantity: 20, cost: 400 },
  ];
  const selected = new Set();
  const body = { innerHTML: "" };
  const context = vm.createContext({
    state: { snapshotRows: rows, chartPoints: [rows[1]] },
    snapshotInspector: { selected, enabled: true },
    refreshSnapshotHighlight() {}, fmtTime: String,
    el: {
      snapshotInspectorBody: body, snapshotInspectorHint: {},
      snapshotInspectorEmpty: { classList: { toggle() {} } }, snapshotDeleteAllBtn: {},
    },
  });
  for (const name of functions) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0);
    vm.runInContext(source.slice(start, source.indexOf("\n}", start) + 2), context);
  }
  context.selectSnapshot(100, { source: "API" });
  assert.deepEqual([...selected], ["100:API"]);
  assert.equal(context.isSnapshotSelected(100, "YATA"), false);
  assert.equal(context.snapshotByTs("100:API").quantity, 20);
  context.selectSnapshot(100, { source: "YATA", additive: true });
  assert.equal(selected.size, 2);
  assert.equal(context.snapshotByTs("100:YATA").quantity, 10);
  context.renderSnapshotInspector();
  assert.match(body.innerHTML, /data-snapshot-key="100:API"/);
  assert.match(body.innerHTML, /data-snapshot-key="100:YATA"/);
  assert.match(body.innerHTML, /<td>API<\/td>/);
  assert.match(body.innerHTML, /<td>YATA<\/td>/);
  context.selectSnapshot(100, { source: "API", additive: true, toggle: true });
  assert.deepEqual([...selected], ["100:YATA"]);
  context.selectSnapshotsInRange(99, 101);
  assert.equal(selected.size, 2, "range selection includes both raw observations");
});
