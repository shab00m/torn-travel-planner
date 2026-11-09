import test from "node:test";
import assert from "node:assert/strict";
import { buildReplayHints } from "../src/restock-replay.js";

const sample = (snapshot_ts, quantity, country = "can", item_id = 206) =>
  ({ country, item_id, snapshot_ts, quantity });

test("replay identifies short zero runs and keeps the first zero across repeated observations", () => {
  const rows = [sample(0, 218), sample(10, 0), sample(11, 218),
    sample(20, 0), sample(21, 0), sample(22, 218), sample(30, 0), sample(90, 218), sample(100, 0)];
  const hints = buildReplayHints(rows, new Map([["can:206", 2500]]));
  assert.equal(hints[1].nextRestockTs, 11);
  assert.equal(hints[2].observedZeroTs, 10);
  assert.equal(hints[3].nextRestockTs, 22);
  assert.equal(hints[5].observedZeroTs, 20);
  assert.equal(hints[6].nextRestockTs, 90);
  assert.equal(hints[8].nextRestockTs, null, "unfinished periods have no predicted refill");
  assert.ok(hints.every((hint) => hint.restockAmount === 2500 && !hint.persistRates));
});

test("small sell-backs do not count as real refills during replay lookahead", () => {
  const rows = [sample(0, 218), sample(10, 0), sample(11, 1), sample(12, 0), sample(200, 218)];
  const hints = buildReplayHints(rows, new Map([["can:206", 2500]]));
  assert.equal(hints[1].nextRestockTs, 200);
  assert.equal(hints[3].nextRestockTs, 200);
  assert.equal(hints[4].observedZeroTs, 12);
  assert.equal(buildReplayHints(rows, new Map())[1].nextRestockTs, 11,
    "without a configured quantity every positive refill counts");
});

test("lookahead never crosses item or country boundaries, including histories starting empty", () => {
  const rows = [sample(10, 0), sample(20, 218), sample(30, 0),
    sample(10, 0, "can", 999), sample(90, 218, "can", 999),
    sample(10, 0, "mex"), sample(90, 218, "mex")];
  const hints = buildReplayHints(rows, new Map());
  assert.equal(hints[1].observedZeroTs, 10);
  assert.equal(hints[2].nextRestockTs, null);
  assert.equal(hints[3].observedZeroTs, null);
  assert.equal(hints[3].nextRestockTs, 90);
  assert.equal(hints[5].observedZeroTs, null);
  assert.equal(hints[6].observedZeroTs, 10);
});

test("large oscillating histories can be classified without any database calls", () => {
  const rows = Array.from({ length: 20000 }, (_, i) => sample(i, i % 2 ? 0 : 218));
  const hints = buildReplayHints(rows, new Map());
  assert.equal(hints.length, rows.length);
  for (let i = 1; i < hints.length - 1; i += 2) {
    assert.equal(hints[i].nextRestockTs, i + 1);
    assert.equal(hints[i + 1].observedZeroTs, i);
  }
});
