import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { bestTraderPrice, normalizeTraderOffers, parseTraderMinRating } from "../src/trader-prices.js";

test("trader quotes use the highest eligible non-sponsored offer at each net rating", () => {
  const now = 1_795_518_000;
  const trader = (price, upvotes, downvotes = 0, fields = {}) => ({
    price, rating: { upvotes, downvotes }, last_action: now - 60, last_trade: now - 60, ...fields,
  });
  const offers = normalizeTraderOffers({ item_id: 206, traders: [
    trader(790_000, 65),
    trader(820_000, 100, 0, { sponsored: true }),
    trader(810_000, 40, 11),
    trader(825_000, 0),
    trader(830_000, 200, 0, { last_trade: now - 13 * 3600 }),
    trader(840_000, 200, 0, { last_action: now - 5 * 3600 }),
    trader(800_000, 40, 10, { last_action: now - 4 * 3600 + 10 }),
  ] }, 206, now);
  assert.equal(bestTraderPrice(offers, parseTraderMinRating(undefined), now), 800_000);
  assert.equal(bestTraderPrice(offers, 29, now), 810_000);
  assert.equal(bestTraderPrice(offers, 60, now), 790_000);
  assert.equal(bestTraderPrice(offers, 30, now + 10), 790_000);
  assert.equal(bestTraderPrice(offers, 100, now), null);
  assert.equal(parseTraderMinRating("30.5"), null);
  assert.throws(() => normalizeTraderOffers({ item_id: 205, traders: [] }, 206, now));
});

const shared = readFileSync(new URL("../public/shared.js", import.meta.url), "utf8");
function planner(initial = {}) {
  const storage = new Map(Object.entries(initial));
  const context = vm.createContext({
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    CustomEvent: class {},
    document: { readyState: "loading", addEventListener() {} },
    window: { addEventListener() {}, dispatchEvent() {} },
  });
  vm.runInContext(shared, context);
  return (expression) => vm.runInContext(expression, context);
}

test("sell price defaults to TornW3B for new browsers and preserves legacy manual prices", () => {
  const fresh = planner();
  assert.equal(fresh("state.sellPriceSource"), "tornw3b");
  assert.equal(fresh("state.traderMinRating"), 30);
  assert.equal(planner({ plannerPrefs: "{}" })("state.sellPriceSource"), "market");
  const saved = planner({ sellPrices: '{"mex:206":0}' });
  assert.equal(saved("state.sellPriceSource"), "manual");
  assert.equal(saved('getItemSellPrice("mex", 206)'), 0);
  assert.equal(saved('getItemSellPrice("uni", 206, 300)'), null);
  assert.equal(saved(`
    state.marketPrices = { 206: 201 };
    state.sellPriceSource = "market";
    getItemSellPrice("mex", 206);
  `), 190);
  assert.equal(saved(`
    state.traderPrices = { 206: 275 };
    state.traderPricesMinRating = 30;
    state.sellPriceSource = "tornw3b";
    getItemSellPrice("mex", 206);
  `), 275);
  assert.equal(saved('state.traderMinRating = 50; getItemSellPrice("mex", 206)'), null);
  assert.equal(saved('state.sellPriceSource = "manual"; getItemSellPrice("mex", 206)'), 0);
});
