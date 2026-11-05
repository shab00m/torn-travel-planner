import test from "node:test";
import assert from "node:assert/strict";
import { createCurrentStocksReader } from "../src/current-stocks.js";

test("stock reads are shared and invalidated by API/DB revision changes", async () => {
  let revision = "one";
  let loads = 0;
  const read = createCurrentStocksReader(() => revision, async () => ({ timestamp: ++loads }));
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(a.timestamp, 1);
  assert.equal(b.timestamp, 1);
  assert.equal(loads, 1);
  assert.equal((await read()).timestamp, 1);
  revision = "two";
  assert.equal((await read()).timestamp, 2);
});

test("old in-flight reads cannot replace data from a newer committed revision", async () => {
  let revision = "one";
  let finish;
  let loads = 0;
  const read = createCurrentStocksReader(() => revision, async () => {
    loads++;
    if (loads === 1) return new Promise((resolve) => { finish = resolve; });
    return { timestamp: 2 };
  });
  const old = read();
  revision = "two";
  assert.equal((await read()).timestamp, 2);
  finish({ timestamp: 1 });
  await old;
  assert.equal((await read()).timestamp, 2);
  assert.equal(loads, 2);
});

test("stock read cache expires even if a change produces no insert notification", async (t) => {
  let now = 1000;
  let loads = 0;
  t.mock.method(Date, "now", () => now);
  const read = createCurrentStocksReader(() => "one", async () => ({ timestamp: ++loads }));
  await read();
  now += 2001;
  assert.equal((await read()).timestamp, 2);
});
