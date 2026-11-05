import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import pg from "pg";

test("API-only commits update both stock endpoints and push SSE without a successful YATA poll", {
  skip: !process.env.TEST_DATABASE_URL, timeout: 15000,
}, async () => {
  const schema = `live_server_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const mockFetch = `const real=globalThis.fetch;globalThis.fetch=(u,o)=>String(u).includes('yata.yt')?Promise.reject(new Error('YATA unavailable in this test')):real(u,o);`;
  const child = spawn(process.execPath, ["--import", `data:text/javascript;base64,${Buffer.from(mockFetch).toString("base64")}`, "server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, DATABASE_URL: url.toString(), DATABASE_SSL: "false", PORT: String(port), INTERNAL_API_KEY: "live-test-key", TORN_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk) => { output += chunk; });
  const controller = new AbortController();
  let reader;
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("Torn Travel Planner running")) resolve();
      });
      child.once("exit", (code) => reject(new Error(`Server exited ${code}: ${output}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    const stream = await fetch(`${base}/api/snapshots/events`, { signal: controller.signal });
    assert.match(stream.headers.get("content-type"), /^text\/event-stream/);
    reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let frames = "";
    while (!frames.includes("event: ready")) frames += decoder.decode((await reader.read()).value);
    const before = await (await fetch(`${base}/api/stocks/status?country=mex&itemId=3460`)).json();
    assert.equal(before.ready, false);
    assert.equal(before.timestamp, null);
    assert.equal((await fetch(`${base}/api/stocks`)).status, 503);
    const initialStatus = await (await fetch(`${base}/api/stocks/status`)).json();
    assert.equal(initialStatus.ready, false);
    const ts = Math.floor(Date.now() / 1000) - 2;
    const response = await fetch(`${base}/api/internal/snapshots`, {
      method: "PUT", headers: { "Content-Type": "application/json", "X-Internal-Key": "live-test-key" },
      body: JSON.stringify({ snapshots: [
        { country: "mex", itemId: 3460, name: "Dahlia", snapshot_ts: ts, quantity: 0, cost: 300 },
        { country: "mex", itemId: 3460, name: "Dahlia", snapshot_ts: ts + 1, quantity: 100, cost: 300 },
      ] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).inserted, 2);
    while (!frames.includes('"country":"mex","itemId":3460')) frames += decoder.decode((await reader.read()).value);
    assert.match(frames, /"country":"mex","itemId":3460/);
    const stock = await (await fetch(`${base}/api/items/mex/3460/stock`)).json();
    assert.equal(stock.quantity, 100);
    assert.equal(stock.source, "API");
    const history = await (await fetch(`${base}/api/history/mex/3460`)).json();
    assert.equal(history.points.length, 2);
    const restocks = await (await fetch(`${base}/api/restocks/mex/3460`)).json();
    assert.equal(restocks.restocks[0].restocked_ts, ts + 1);
    const after = await (await fetch(`${base}/api/stocks/status?country=mex&itemId=3460`)).json();
    assert.equal(after.timestamp, ts + 1);
    assert.equal(after.ready, true);
    const feed = await (await fetch(`${base}/api/stocks`)).json();
    assert.equal(feed.timestamp, ts + 1);
    assert.equal(feed.lastError, null);
    assert.equal(feed.stocks.mex.update, ts + 1);
    const dahlia = feed.stocks.mex.stocks.find((r) => r.id === 3460);
    assert.equal(dahlia.quantity, 100);
    assert.equal(dahlia.source, "API");
    assert.equal(dahlia.snapshot_ts, ts + 1);
    const globalStatus = await (await fetch(`${base}/api/stocks/status`)).json();
    assert.equal(globalStatus.ready, true);
    assert.equal(globalStatus.timestamp, feed.timestamp);
    assert.notEqual(after.snapshotRevision, before.snapshotRevision);
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    child.kill("SIGTERM");
    if (child.exitCode == null) await once(child, "exit");
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
