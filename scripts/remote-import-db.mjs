import { createReadStream, createWriteStream, statSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";

const url = process.argv[2];
if (!url) {
  console.error("Usage: node remote-import-db.mjs <url>");
  process.exit(1);
}

const dataDir = "/app/data";
const gzPath = `${dataDir}/travel.db.gz`;
const newPath = `${dataDir}/travel.db.new`;
const dbPath = `${dataDir}/travel.db`;

console.log("Downloading", url);
const res = await fetch(url);
if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

await pipeline(Readable.fromWeb(res.body), createWriteStream(gzPath));
console.log("gz bytes", statSync(gzPath).size);

await pipeline(createReadStream(gzPath), createGunzip(), createWriteStream(newPath));
console.log("db.new bytes", statSync(newPath).size);
unlinkSync(gzPath);

for (const f of [`${dbPath}-wal`, `${dbPath}-shm`, dbPath]) {
  if (existsSync(f)) unlinkSync(f);
}
renameSync(newPath, dbPath);
console.log("Installed", dbPath, "bytes", statSync(dbPath).size);
console.log("IMPORT_OK");
