import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const railwayJs = "C:/Program Files/nodejs/node_modules/@railway/cli/bin/railway.js";

const local = new DatabaseSync("data/travel.db", { readOnly: true });
for (const t of ["snapshots", "restocks", "items", "users"]) {
  console.log("local", t, local.prepare(`select count(*) as c from ${t}`).get().c);
}
local.close();

const b64 = readFileSync("scripts/remote-count-db.mjs").toString("base64");
const cmd = `sh -c "echo ${b64} | openssl base64 -d -A > /tmp/remote-count-db.mjs && node /tmp/remote-count-db.mjs"`;
const r = spawnSync(process.execPath, [railwayJs, "ssh", "--", cmd], {
  encoding: "utf8",
  env: process.env,
  timeout: 60_000,
});
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(r.status ?? 1);
