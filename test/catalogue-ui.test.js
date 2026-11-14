import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const shared = readFileSync(new URL("../public/shared.js", import.meta.url), "utf8");
function fn(source, name) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

test("catalogue-only rows show unknown stock and price without suggesting free purchases", () => {
  const state = { itemTypeFilters: [], inStockOnly: false, maxBudget: null,
    profitMin: null, profitMax: null, travelCapacity: 29 };
  const context = vm.createContext({ state,
    isHidden: () => false, getFlightSec: () => 100,
    fmtNum: (n) => n.toLocaleString("en-US"),
  });
  vm.runInContext([
    fn(app, "stockQuantityCellHtml"), fn(app, "purchaseQtyCellsHtml"),
    fn(app, "itemMatchesFilters"), fn(shared, "fmtListMoneyHtml"),
    fn(shared, "getMaxPurchaseQty"), fn(shared, "computeProfitMetrics"),
  ].join("\n"), context);
  const item = { id: 198, name: "Ketamine", quantity: null, cost: null };
  assert.match(context.stockQuantityCellHtml(item), /Unknown/);
  assert.doesNotMatch(context.stockQuantityCellHtml(item), /qty-ok|qty-zero/);
  assert.equal(context.fmtListMoneyHtml(null), "—");
  assert.doesNotMatch(context.purchaseQtyCellsHtml("sou", item), /\$0/);
  assert.equal(context.getMaxPurchaseQty("sou", 198, null), null);
  assert.equal(context.computeProfitMetrics({ buyPrice: null, sellPrice: 50000, country: "sou" }), null);
  assert.equal(context.itemMatchesFilters(item, "sou", "ketamine"), true);
  state.inStockOnly = true;
  assert.equal(context.itemMatchesFilters(item, "sou", ""), false);
  assert.equal(context.itemMatchesFilters({ ...item, quantity: 100 }, "sou", ""), true);
  assert.match(context.stockQuantityCellHtml({ ...item, quantity: 0 }), /qty-zero.*>0</);
});

test("stock refresh discovers new types while the initial type request is still pending", async () => {
  const state = { itemTypes: null };
  const context = vm.createContext({ state, lastStockTimestamp: null,
    el: { status: {} }, noteStockTimestamp() {}, clearPageError() {},
    populateItemTypeFilter() {}, render() {}, loadSafeWindows: async () => {},
    fetchJson: async () => ({ timestamp: null, stocks: { sou: { update: null, stocks: [
      { id: 198, name: "Ketamine", item_type: "Drug", quantity: null, cost: null },
    ] } } }),
  });
  vm.runInContext(`async ${fn(app, "loadStocks")}`, context);
  await context.loadStocks();
  assert.equal(state.itemTypes[198], "Drug");
  assert.match(context.el.status.textContent, /Awaiting stock reports/);
});
