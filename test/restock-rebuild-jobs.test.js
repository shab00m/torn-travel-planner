import test from "node:test";
import assert from "node:assert/strict";
import { createRestockRebuildJobs } from "../src/restock-rebuild-jobs.js";

const logger = { log() {}, error() {} };
const tick = () => new Promise(setImmediate);

test("background rebuilds return immediately, join duplicates, and run one item at a time", async () => {
  const calls = [];
  let finish;
  const jobs = createRestockRebuildJobs(async (country, itemId) => {
    calls.push([country, itemId]);
    if (itemId === 206) await new Promise((resolve) => { finish = resolve; });
    return { opened: 4, closed: 3 };
  }, { logger });
  const first = jobs.start("can", 206);
  assert.equal(first.status, "queued");
  const second = jobs.start("can", 999);
  assert.equal(jobs.start("can", 206).jobId, first.jobId);
  await tick();
  assert.equal(jobs.get("can", 206, first.jobId).status, "running");
  assert.equal(jobs.get("can", 999, second.jobId).status, "queued");
  assert.equal(jobs.get("mex", 206, first.jobId), null);
  assert.deepEqual(calls, [["can", 206]]);
  finish();
  await tick();
  assert.deepEqual(calls, [["can", 206], ["can", 999]]);
  assert.deepEqual(jobs.get("can", 206, first.jobId).result, { opened: 4, closed: 3 });
  assert.equal(jobs.get("can", 999, second.jobId).status, "completed");
});

test("a failed rebuild exposes its error and does not prevent the next rebuild", async () => {
  const jobs = createRestockRebuildJobs(async (_country, itemId) => {
    if (itemId === 206) throw Object.assign(new Error("statement timeout"), { code: "57014" });
    return { opened: 0, closed: 0 };
  }, { logger });
  const first = jobs.start("can", 206);
  const next = jobs.start("mex", 999);
  await tick();
  assert.equal(jobs.get("can", 206, first.jobId).status, "failed");
  assert.match(jobs.get("can", 206, first.jobId).error, /database time limit/);
  assert.equal(jobs.get("mex", 999, next.jobId).status, "completed");
});

test("finished rebuilds expire without expiring an active rebuild", async () => {
  let time = 0;
  let finish;
  const jobs = createRestockRebuildJobs(async (_country, itemId) => {
    if (itemId === 999) await new Promise((resolve) => { finish = resolve; });
    return { opened: 0, closed: 0 };
  }, { logger, now: () => time });
  const done = jobs.start("can", 206);
  await tick();
  const active = jobs.start("can", 999);
  await tick();
  time = 31 * 60_000;
  jobs.start("mex", 1);
  assert.equal(jobs.get("can", 206, done.jobId), null);
  assert.equal(jobs.get("can", 999, active.jobId).status, "running");
  finish();
  await tick();
});
