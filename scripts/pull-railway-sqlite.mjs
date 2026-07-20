/**
 * Download /app/data/travel.db (+ WAL/SHM) from the Railway app volume.
 * Usage: node scripts/pull-railway-sqlite.mjs [outPath]
 * Default outPath: data/travel.railway.db
 */
import { spawn } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  existsSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { execFileSync } from "node:child_process";

const outPath = path.resolve(process.argv[2] ?? "data/travel.railway.db");
mkdirSync(path.dirname(outPath), { recursive: true });

const railwayJsCandidates = [
  path.join(path.dirname(process.execPath), "node_modules", "@railway", "cli", "bin", "railway.js"),
  "C:/Program Files/nodejs/node_modules/@railway/cli/bin/railway.js",
];
const railwayJs = railwayJsCandidates.find((p) => existsSync(p));
if (!railwayJs) {
  throw new Error("Could not find @railway/cli railway.js");
}

function spawnRailway(args) {
  return spawn(process.execPath, [railwayJs, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

function runRailway(args) {
  return new Promise((resolve, reject) => {
    const child = spawnRailway(args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`railway ${args.join(" ")} failed (${code}):\n${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

class Base64Decoder extends Transform {
  constructor() {
    super();
    this._buf = "";
  }
  _transform(chunk, _enc, cb) {
    this._buf += chunk.toString("utf8").replace(/\s+/g, "");
    const take = this._buf.length - (this._buf.length % 4);
    if (take > 0) {
      this.push(Buffer.from(this._buf.slice(0, take), "base64"));
      this._buf = this._buf.slice(take);
    }
    cb();
  }
  _flush(cb) {
    if (this._buf.length) this.push(Buffer.from(this._buf, "base64"));
    cb();
  }
}

async function downloadBase64Command(remoteCmd, destPath) {
  await new Promise((resolve, reject) => {
    const child = spawnRailway(["ssh", "--", remoteCmd]);
    let stderr = "";
    let settled = false;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const ok = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", fail);

    const out = createWriteStream(destPath);
    pipeline(child.stdout, new Base64Decoder(), out)
      .then(() => {
        if (child.exitCode && child.exitCode !== 0) {
          fail(new Error(`download failed (${child.exitCode}): ${stderr}`));
          return;
        }
        ok();
      })
      .catch(fail);

    child.on("close", (code) => {
      if (code !== 0 && code != null) {
        // Give pipeline a moment; if still open, fail.
        setTimeout(() => {
          if (!settled) fail(new Error(`download failed (${code}): ${stderr}`));
        }, 50);
      }
    });
  });
}

console.log("Checking remote /app/data …");
const listing = await runRailway(["ssh", "--", "ls -la /app/data"]);
process.stdout.write(listing.stdout);

const tarGzPath = `${outPath}.tar.gz`;
console.log("Downloading db+wal+shm as tar.gz (may take a few minutes) …");
await downloadBase64Command(
  "tar czf - -C /app/data travel.db travel.db-wal travel.db-shm | openssl base64 -A",
  tarGzPath
);

console.log("Extracting …");
const extractDir = path.join(path.dirname(outPath), ".railway-sqlite-extract");
mkdirSync(extractDir, { recursive: true });
execFileSync("tar", ["-xzf", tarGzPath, "-C", extractDir], { stdio: "inherit" });

const { copyFileSync, statSync } = await import("node:fs");
copyFileSync(path.join(extractDir, "travel.db"), outPath);
copyFileSync(path.join(extractDir, "travel.db-wal"), `${outPath}-wal`);
copyFileSync(path.join(extractDir, "travel.db-shm"), `${outPath}-shm`);

console.log(`Wrote ${outPath} (${statSync(outPath).size} bytes)`);
console.log(`Wrote ${outPath}-wal (${statSync(`${outPath}-wal`).size} bytes)`);

// Quick sanity check with local Node sqlite (includes WAL).
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(outPath, { readOnly: true });
const max = db.prepare("SELECT MAX(yata_ts) AS m FROM snapshots").get();
const users = db.prepare("SELECT COUNT(*) AS n FROM users").get();
const snaps = db.prepare("SELECT COUNT(*) AS n FROM snapshots").get();
db.close();
console.log(
  `Sanity: snapshots=${snaps.n} users=${users.n} max_yata_ts=${max.m} (${new Date(max.m * 1000).toISOString()})`
);

unlinkSync(tarGzPath);
