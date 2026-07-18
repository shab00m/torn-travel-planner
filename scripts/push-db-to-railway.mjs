import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const railwayJs = "C:/Program Files/nodejs/node_modules/@railway/cli/bin/railway.js";
const url = process.argv[2] ?? "https://tmpfiles.org/dl/w7w6uAOsp0ew/travel.db.gz";

function railwaySsh(remoteCommand) {
  // Railway joins argv with spaces and re-parses on the remote, so pass ONE string.
  const r = spawnSync(process.execPath, [railwayJs, "ssh", "--", remoteCommand], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 50 * 1024 * 1024,
    timeout: 180_000,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    throw new Error(`railway ssh failed (${r.status}): ${remoteCommand}`);
  }
  return r;
}

console.log("Smoke test...");
railwaySsh('sh -c "ls -la /app/data"');

const b64 = readFileSync("scripts/remote-import-db.mjs").toString("base64");
console.log("Writing import script...");
railwaySsh(`sh -c "echo ${b64} | openssl base64 -d -A > /tmp/remote-import-db.mjs && wc -c /tmp/remote-import-db.mjs"`);

console.log("Importing DB from", url);
railwaySsh(`sh -c "node /tmp/remote-import-db.mjs '${url}'"`);

console.log("Verifying...");
railwaySsh('sh -c "ls -la /app/data"');
