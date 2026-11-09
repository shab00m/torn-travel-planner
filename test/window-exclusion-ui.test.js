import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("window exclusion control is admin-only and needs both saved bounds", () => {
  const source = readFileSync(new URL("../public/item.js", import.meta.url), "utf8");
  const fn = source.match(/function syncWindowExclusionButton\(\) \{[\s\S]*?\n\}/)[0];
  let admin = false;
  let bounds = { minEmptyFor: 60, maxEmptyFor: 120 };
  let hidden;
  const button = { classList: { toggle: (name, value) => {
    assert.equal(name, "hidden"); hidden = value;
  } } };
  const context = vm.createContext({
    el: { flagOutsideWindowBtn: button }, cycleHistoryActionsBusy: false,
    currentEmptyForBounds: () => bounds, isAdminUser: () => admin,
  });
  const sync = () => vm.runInContext(`${fn}\nsyncWindowExclusionButton();`, context);
  sync();
  assert.equal(hidden, true);
  admin = true;
  sync();
  assert.equal(hidden, false);
  assert.equal(button.disabled, false);
  bounds.maxEmptyFor = null;
  sync();
  assert.equal(button.disabled, true);
  bounds = { minEmptyFor: 0, maxEmptyFor: 120 };
  sync();
  assert.equal(button.disabled, false);
  context.cycleHistoryActionsBusy = true;
  sync();
  assert.equal(button.disabled, true);
  admin = false;
  sync();
  assert.equal(hidden, true);
});
