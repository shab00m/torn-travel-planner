import { randomUUID } from "node:crypto";
import { getPool } from "./pg.js";

export function createSnapshotEvents(pool = getPool()) {
  const clients = new Set();
  const epoch = randomUUID();
  let sequence = 0;
  let generation = 0;
  const itemRevisions = new Map();
  let disconnectListener = null;
  let connection = null;
  let retry = null;
  let stopped = false;
  const revision = (country, itemId) => `${epoch}:${generation}:${country && itemId ? itemRevisions.get(`${country}:${itemId}`) ?? 0 : sequence}`;
  function broadcast(type, data) {
    for (const res of clients) {
      if (res.writableLength > 262144 || res.destroyed) { res.end(); clients.delete(res); continue; }
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }
  async function start() {
    if (stopped || connection) return;
    let client;
    let released = false;
    const disconnected = () => {
      if (released) return;
      released = true;
      if (connection === client) connection = null;
      client?.release(true);
      if (!stopped && !retry) retry = setTimeout(() => { retry = null; void start(); }, 1000).unref();
    };
    try {
      client = await pool.connect();
      if (stopped) { client.release(); return; }
      connection = client;
      disconnectListener = disconnected;
      client.on("error", disconnected);
      client.on("end", disconnected);
      client.on("notification", (event) => {
        if (event.channel !== "snapshot_updates") return;
        try {
          const item = JSON.parse(event.payload);
          if (typeof item.country !== "string" || !Number.isInteger(item.itemId)) return;
          sequence++;
          itemRevisions.set(`${item.country}:${item.itemId}`, sequence);
          broadcast("snapshots", { revision: revision(), items: [item] });
        } catch { /* Ignore invalid notifications from unrelated DB clients. */ }
      });
      await client.query("LISTEN snapshot_updates");
      generation++;
      itemRevisions.clear();
      broadcast("ready", { revision: revision() });
    } catch (err) {
      console.error("[snapshot-events] listener unavailable:", err.message);
      disconnected();
    }
  }
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": heartbeat\n\n");
  }, 20000).unref();
  function handler(req, res) {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write(`retry: 1000\nevent: ready\ndata: ${JSON.stringify({ revision: revision() })}\n\n`);
    clients.add(res);
    const remove = () => clients.delete(res);
    req.on("close", remove);
    res.on("close", remove);
    res.on("error", remove);
  }
  function close() {
    stopped = true;
    clearTimeout(retry);
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    clients.clear();
    disconnectListener?.();
    connection = null;
  }
  return { start, handler, revision, close };
}
