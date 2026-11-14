import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { travelListings } from "../src/travel-catalogue.js";

const ketamine = { id: 198, name: "Ketamine", type: "Drug", value: { shops: [
  { country: "South Africa", shop: "Black Market", buy_price: null },
] } };

test("shop discovery includes new combinations and new IDs without per-item configuration", () => {
  assert.deepEqual(travelListings([
    { ...ketamine, shops: ketamine.value.shops },
    { id: 999999, shops: [
      { country: "Canada", buy_price: 250 },
      { country: "Canada", buy_price: 300 },
      { country: "United Arab Emirates", buy_price: null },
      { country: "Torn", buy_price: 100 },
      { country: "Unrecognized", buy_price: 100 },
    ] },
    { id: 1 },
  ]), [
    { country: "can", itemId: 999999, cost: 250 },
    { country: "sou", itemId: 198, cost: null },
    { country: "uae", itemId: 999999, cost: null },
  ]);
});

const source = readFileSync(new URL("../src/item-types.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replaceAll("export ", "");
function harness() {
  let now = 1_000_000;
  const saved = [];
  const savedOptions = [];
  const intervals = [];
  let items = [ketamine];
  let fail = false;
  let calls = 0;
  const context = vm.createContext({
    process: { env: { TORN_API_KEY: "test-server-key" } },
    Date: { now: () => now }, AbortSignal,
    console: { log() {}, error() {} },
    getAllItemTypeRows: async () => [{ item_id: 198, item_type: "Drug" }],
    saveTravelCatalogue: async (entries, options) => { saved.push(entries); savedOptions.push(options); return entries.length; },
    fetch: async () => {
      calls++;
      if (fail) throw new Error("Unavailable");
      return { ok: true, json: async () => ({ items }) };
    },
    setInterval(fn, ms) { intervals.push({ fn, ms }); return { unref() {} }; },
  });
  vm.runInContext(source, context);
  return { context, saved, savedOptions, intervals, calls: () => calls,
    advance: (ms) => { now += ms; }, items: (value) => { items = value; },
    fail: (value) => { fail = value; } };
}

test("catalogue refresh keeps discovering items when existing types are complete", async () => {
  const h = harness();
  await Promise.all([h.context.ensureItemTypesPopulated(), h.context.ensureItemTypesPopulated()]);
  assert.equal(h.calls(), 1, "concurrent refreshes share a request");
  assert.equal(h.saved[0][0].shops[0].country, "South Africa");
  h.advance(5 * 60_000);
  await h.context.ensureItemTypesPopulated();
  assert.equal(h.calls(), 1);
  h.items([ketamine, { id: 999999, name: "Future item", type: "Future category",
    value: { shops: [{ country: "Japan", buy_price: 123 }] } }]);
  h.advance(55 * 60_000);
  await h.context.ensureItemTypesPopulated();
  assert.equal(h.calls(), 2);
  assert.equal(h.saved[1][1].id, 999999);
  assert.equal(h.saved[1][1].shops[0].country, "Japan");
});

test("catalogue failures retain cached types and retry after five minutes", async () => {
  const h = harness();
  h.fail(true);
  assert.equal((await h.context.ensureItemTypesPopulated()).types[198], "Drug");
  await h.context.ensureItemTypesPopulated();
  assert.equal(h.calls(), 1);
  assert.equal(h.saved.length, 0);
  h.advance(5 * 60_000);
  h.fail(false);
  await h.context.ensureItemTypesPopulated();
  assert.equal(h.calls(), 2);
  assert.equal(h.saved.length, 1);
});

test("startup installs recurring catalogue refreshes", async () => {
  const h = harness();
  h.context.startItemCataloguePolling();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls(), 1);
  assert.equal(h.intervals[0].ms, 5 * 60_000);
  h.advance(60 * 60_000);
  h.intervals[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls(), 2);
});

test("daily reconciliation fetches current shops even after the hourly refresh", async () => {
  const h = harness();
  await h.context.ensureItemTypesPopulated();
  await h.context.reconcileTravelCatalogueFromTorn();
  assert.equal(h.calls(), 2);
  assert.equal(h.savedOptions[0], undefined);
  assert.equal(h.savedOptions[1].reconcile, true);
});

test("daily reconciliation rejects failed, empty and malformed catalogues before any writes", async () => {
  const h = harness();
  for (const items of [[], null, {}, [ketamine, ketamine],
    [{ ...ketamine, value: {} }], [{ ...ketamine, type: null }],
    [{ ...ketamine, value: { shops: [null] } }]]) {
    h.items(items);
    await assert.rejects(h.context.reconcileTravelCatalogueFromTorn());
  }
  h.fail(true);
  await assert.rejects(h.context.reconcileTravelCatalogueFromTorn());
  h.context.process.env.TORN_API_KEY = "";
  await assert.rejects(h.context.reconcileTravelCatalogueFromTorn(), /TORN_API_KEY/);
  assert.equal(h.saved.length, 0);
});
