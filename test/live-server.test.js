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
    const mockFetch = `const real=globalThis.fetch;globalThis.fetch=(u,o)=>{
      if(String(u).includes('yata.yt')) return Promise.reject(new Error('YATA unavailable in this test'));
      if(String(u).startsWith('https://api.torn.com/user/')) return Promise.resolve({ok:true,json:async()=>({player_id:new URL(u).searchParams.get('key')==='admin-test-key'?4166571:123456,name:'Test player',level:50})});
      return real(u,o);
    };`;
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
    assert.equal((await fetch(`${base}/api/stocks`)).status, 200);
    const initialStatus = await (await fetch(`${base}/api/stocks/status`)).json();
    assert.equal(initialStatus.ready, false);
    // Uploads only write snapshots; item metadata belongs to the catalogue.
    await admin.query(`INSERT INTO ${schema}.items (item_id, name) VALUES (3460, 'Dahlia')`);
    const ts = Math.floor(Date.now() / 1000) - 120;
    const response = await fetch(`${base}/api/internal/snapshots`, {
      method: "PUT", headers: { "Content-Type": "application/json", "X-Internal-Key": "live-test-key" },
      body: JSON.stringify({ snapshots: [
        { country: "mex", itemId: 3460, name: "Dahlia", snapshot_ts: ts, quantity: 0, cost: 300 },
        { country: "mex", itemId: 3460, name: "Dahlia", snapshot_ts: ts + 60, quantity: 100, cost: 300 },
      ] }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true });
    while (!frames.includes('"country":"mex","itemId":3460')) frames += decoder.decode((await reader.read()).value);
    assert.match(frames, /"country":"mex","itemId":3460/);
    const stock = await (await fetch(`${base}/api/items/mex/3460/stock`)).json();
    assert.equal(stock.quantity, 100);
    assert.equal(stock.source, "API");
    const history = await (await fetch(`${base}/api/history/mex/3460`)).json();
    assert.equal(history.points.length, 2);
    const restocks = await (await fetch(`${base}/api/restocks/mex/3460`)).json();
    assert.deepEqual(restocks.restocks, []);
    const after = await (await fetch(`${base}/api/stocks/status?country=mex&itemId=3460`)).json();
    assert.equal(after.timestamp, ts + 60);
    assert.equal(after.ready, true);
    const feed = await (await fetch(`${base}/api/stocks`)).json();
    assert.equal(feed.timestamp, ts + 60);
    assert.equal(feed.lastError, null);
    assert.equal(feed.stocks.mex.update, ts + 60);
    const dahlia = feed.stocks.mex.stocks.find((r) => r.id === 3460);
    assert.equal(dahlia.quantity, 100);
    assert.equal(dahlia.source, "API");
    assert.equal(dahlia.snapshot_ts, ts + 60);
    const globalStatus = await (await fetch(`${base}/api/stocks/status`)).json();
    assert.equal(globalStatus.ready, true);
    assert.equal(globalStatus.timestamp, feed.timestamp);
    assert.notEqual(after.snapshotRevision, before.snapshotRevision);

    await admin.query(
      `INSERT INTO ${schema}.restocks
         (country, item_id, depleted_ts, restocked_ts, duration, rate_start_qty, rate_end_ts, rate_end_qty)
       VALUES ('mex', 3460, $1, $2, 3000, 20, $3, 0)`,
      [ts - 5400, ts - 2400, ts - 1200]
    );
    await admin.query(
      `INSERT INTO ${schema}.empty_for_bounds (country, item_id, avg_empty_for) VALUES ('mex', 3460, 3000)`
    );
    const estimate = (workdayHours, settings = {}) => fetch(`${base}/api/workday-trips`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ travelType: "Standard", workdayHours, items: [
        { country: "mex", itemId: 3460, itemsPerTrip: 5, settings },
        { country: "mex", itemId: 999999, itemsPerTrip: 5, settings },
      ] }),
    });
    const headers = { "Content-Type": "application/json", "X-Api-Key": "admin-test-key" };
    const regularHeaders = { "Content-Type": "application/json", "X-Api-Key": "regular-test-key" };
    // The outbound flight is 25 minutes, so buying and starting the return fits inside half an hour.
    const firstEstimate = await estimate(0.5);
    assert.equal(firstEstimate.status, 200);
    const saved = (await firstEstimate.json()).estimates["mex:3460"];
    assert.equal(saved.trips, 1);
    assert.equal((await (await estimate(0.25)).json()).estimates["mex:3460"].trips, 0);
    assert.deepEqual(await (await estimate(0.5, { rangeHours: 0.01 })).json(), { estimates: {} });
    assert.equal((await estimate(25)).status, 400);

    // Much faster depletion would make the first trip miss the stock window. A saved
    // count survives this history change until an authenticated admin refreshes it.
    await admin.query(`UPDATE ${schema}.restocks SET rate_start_qty = 10000 WHERE item_id = 3460`);
    assert.deepEqual((await (await estimate(0.5)).json()).estimates["mex:3460"], saved);
    const recalculate = (headers) => fetch(`${base}/api/items/mex/3460/workday-trips/recalculate`, {
      method: "POST", headers,
      body: JSON.stringify({ travelType: "Standard", workdayHours: 0.5, itemsPerTrip: 5 }),
    });
    assert.equal((await recalculate({ "Content-Type": "application/json" })).status, 401);
    assert.equal((await recalculate(regularHeaders)).status, 403);
    const recalculated = await recalculate(headers);
    assert.equal(recalculated.status, 200);
    const refreshed = (await recalculated.json()).estimate;
    assert.equal(refreshed.trips, 0);
    assert.deepEqual((await (await estimate(0.5)).json()).estimates["mex:3460"], refreshed);
    const persisted = await admin.query(`SELECT workday_trips FROM ${schema}.travel_items WHERE country = 'mex' AND item_id = 3460`);
    assert.equal(Object.keys(persisted.rows[0].workday_trips).length, 2);
    assert.ok(Object.values(persisted.rows[0].workday_trips).some((record) => record.trips === 0));
    while (!frames.includes('"workday_trips":true')) frames += decoder.decode((await reader.read()).value);
    frames = "";

    const deprecationUrl = `${base}/api/items/mex/3460/deprecation`;
    for (const method of ["GET", "PUT"]) {
      const body = method === "PUT" ? JSON.stringify({ deprecated: true }) : undefined;
      assert.equal((await fetch(deprecationUrl, { method, body, headers: { "Content-Type": "application/json" } })).status, 401);
      assert.equal((await fetch(deprecationUrl, { method, body, headers: { ...headers, "X-Api-Key": "regular-test-key" } })).status, 403);
    }
    assert.deepEqual(await (await fetch(deprecationUrl, { headers })).json(), {
      deprecated: false, catalogueDeprecated: false, override: null,
    });
    assert.equal((await fetch(deprecationUrl, { method: "PUT", headers, body: JSON.stringify({ deprecated: "true" }) })).status, 400);
    assert.equal((await fetch(`${base}/api/items/mex/999999/deprecation`, { method: "PUT", headers, body: JSON.stringify({ deprecated: true }) })).status, 404);
    const updated = await fetch(deprecationUrl, { method: "PUT", headers, body: JSON.stringify({ deprecated: true }) });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).deprecated, true);
    // Wait for the committed metadata notification before testing cached feeds.
    while (!frames.includes('"snapshot_ts":null')) frames += decoder.decode((await reader.read()).value);
    assert.deepEqual((await (await fetch(`${base}/api/stocks`)).json()).stocks, {});
    assert.deepEqual((await (await fetch(`${base}/api/history/mex/3460`)).json()).points, history.points);
    assert.equal((await fetch(`${base}/api/items/mex/3460/stock`)).status, 200);
    assert.equal((await (await fetch(deprecationUrl, { method: "PUT", headers, body: JSON.stringify({ deprecated: null }) })).json()).deprecated, false);
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    child.kill("SIGTERM");
    if (child.exitCode == null) await once(child, "exit");
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
