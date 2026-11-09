import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/item.js", import.meta.url), "utf8");
const start = source.indexOf("async function backfillItemRestocks(");
const fn = source.slice(start, source.indexOf("\n}", start) + 2);

function setup(job) {
  const calls = [];
  const messages = [];
  const disabled = [];
  const alerts = [];
  const context = vm.createContext({
    state: { item: { country: "can", itemId: 206 } }, el: { backfillRestocksBtn: {} },
    isAdminUser: () => true, confirm: () => true, alert: (message) => alerts.push(message),
    adminApiHeaders: () => ({ "X-Api-Key": "test-key" }),
    setCycleHistoryActionsDisabled: (value) => disabled.push(value),
    setCycleHistoryActionStatus: (message) => messages.push(message),
    setTimeout: (resolve) => resolve(),
    fetchJsonWithBody: async (url, options) => {
      calls.push({ url, options });
      return { jobId: "job-1", status: "running" };
    },
    fetch: async (url, options) => { calls.push({ url, options }); return job; },
    parseFetchResponse: async (value) => value,
    fetchJson: async (url) => { calls.push({ url }); return { restocks: [], rates: [] }; },
    loadRestockData() {}, reloadEmptyForBoundsUi: async () => {}, refreshRestockViews() {},
  });
  vm.runInContext(fn, context);
  return { context, calls, messages, disabled, alerts };
}

test("rebuild starts a background job, authenticates status polling, and loads results on completion", async () => {
  const { context, calls, messages, disabled, alerts } = setup({ status: "completed", result: { opened: 4, closed: 3 } });
  await context.backfillItemRestocks();
  assert.equal(calls[0].options.body.background, true);
  assert.equal(calls[1].url, "/api/restocks/can/206/backfill/job-1");
  assert.equal(calls[1].options.headers["X-Api-Key"], "test-key");
  assert.equal(calls[2].url, "/api/restocks/can/206?includeRateTod=false");
  assert.equal(messages.at(-1), "Rebuilt: 4 depleted, 3 restocked");
  assert.deepEqual(disabled, [true, false]);
  assert.deepEqual(alerts, []);
});

test("failed background jobs show their error and restore the maintenance buttons", async () => {
  const { context, calls, disabled, alerts } = setup({ status: "failed", error: "Item is busy" });
  await context.backfillItemRestocks();
  assert.deepEqual(alerts, ["Item is busy"]);
  assert.deepEqual(disabled, [true, false]);
  assert.equal(calls.length, 2);
});
