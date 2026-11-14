import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/item-deprecation.js", import.meta.url), "utf8");
function harness() {
  const elements = new Map();
  const events = new Map();
  let admin = false;
  let fail = false;
  let data = { deprecated: true, catalogueDeprecated: true, override: null };
  let reads = 0;
  const writes = [];
  const context = vm.createContext({
    state: { item: { country: "swi", itemId: 198 } },
    window: { getCurrentUser: () => ({ isAdmin: admin }), addEventListener: (name, handler) => events.set(name, handler) },
    document: { getElementById(id) {
      const el = { disabled: false, checked: false, textContent: "", hidden: true,
        classList: { toggle: (_name, hidden) => { el.hidden = hidden; } }, addEventListener() {} };
      elements.set(id, el); return el;
    } },
    adminApiHeaders: () => ({ "X-Api-Key": "admin-test-key" }),
    parseFetchResponse: async (r) => r,
    fetch: async () => { reads++; return data; },
    fetchJsonWithBody: async (url, options) => {
      writes.push({ url, options });
      if (fail) throw new Error("Failed");
      data = { ...data, override: options.body.deprecated,
        deprecated: options.body.deprecated ?? data.catalogueDeprecated };
      return data;
    },
  });
  vm.runInContext(source, context);
  return { context, elements, events, writes, reads: () => reads,
    admin: (value) => { admin = value; }, fail: (value) => { fail = value; } };
}

test("deprecation controls and reads are admin-only and are hidden on logout", async () => {
  const h = harness();
  const controls = h.elements.get("item-deprecation-controls");
  const toggle = h.elements.get("item-deprecated");
  await h.context.refreshItemDeprecation();
  await h.context.saveItemDeprecation(true);
  assert.equal(controls.hidden, true);
  assert.equal(toggle.disabled, true);
  assert.equal(h.reads(), 0);
  assert.equal(h.writes.length, 0);
  h.admin(true);
  await h.context.refreshItemDeprecation();
  assert.equal(controls.hidden, false);
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);
  h.admin(false);
  await h.context.refreshItemDeprecation();
  assert.equal(controls.hidden, true);
  assert.equal(toggle.disabled, true);
});

test("admin can override and restore automation; failed saves restore the saved checkbox", async () => {
  const h = harness();
  h.admin(true);
  await h.context.refreshItemDeprecation();
  await h.context.saveItemDeprecation(false);
  assert.equal(h.writes[0].options.headers["X-Api-Key"], "admin-test-key");
  assert.equal(h.writes[0].options.body.deprecated, false);
  assert.equal(h.elements.get("item-deprecated").checked, false);
  assert.equal(h.elements.get("item-deprecation-auto").disabled, false);
  h.fail(true);
  await h.context.saveItemDeprecation(true);
  assert.equal(h.elements.get("item-deprecated").checked, false);
  assert.match(h.elements.get("item-deprecation-status").textContent, /Could not save/);
  h.fail(false);
  await h.context.saveItemDeprecation(null);
  assert.equal(h.elements.get("item-deprecated").checked, true);
  assert.equal(h.elements.get("item-deprecation-auto").disabled, true);
});

test("stock ticks do not authenticate repeatedly; metadata changes refresh the control", async () => {
  const h = harness();
  h.admin(true);
  await h.context.refreshItemDeprecation();
  const event = h.events.get("snapshotsupdated");
  event({ detail: { items: [{ country: "swi", itemId: 198, snapshot_ts: 100 }] } });
  event({ detail: { items: [{ country: "sou", itemId: 198, snapshot_ts: null }] } });
  assert.equal(h.reads(), 1);
  event({ detail: { items: [{ country: "swi", itemId: 198, snapshot_ts: null }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.reads(), 2);
});
