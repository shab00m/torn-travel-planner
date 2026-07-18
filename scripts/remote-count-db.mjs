import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("/app/data/travel.db", { readOnly: true });
for (const t of ["snapshots", "restocks", "items", "users"]) {
  try {
    const r = db.prepare(`select count(*) as c from ${t}`).get();
    console.log(t, r.c);
  } catch (e) {
    console.log(t, e.message);
  }
}
const sample = db.prepare(
  "select country, item_id, count(*) as c from snapshots group by 1,2 order by c desc limit 5",
).all();
console.log("top snapshot series", sample);
const mex206 = db.prepare(
  "select count(*) as c from snapshots where country = ? and item_id = ?",
).get("mex", 206);
console.log("mex/206", mex206);
db.close();
console.log("COUNT_OK");
