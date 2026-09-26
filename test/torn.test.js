import test from "node:test";
import assert from "node:assert/strict";
import { getPlayerInfo, tourismDayIsActive } from "../src/torn.js";

const ts = (date) => Date.parse(date) / 1000;
const event = {
  title: "World Tourism Day",
  start: ts("2026-09-26T12:00:00Z"),
  end: ts("2026-09-28T12:00:00Z"),
  fixed_start_time: false,
};

test("personal Tourism Day covers exactly 48 hours including September 26", () => {
  for (const time of ["10:00", "14:15", "16:00:00"]) {
    const start = ts(`2026-09-26T${time.length === 5 ? time + ":00" : time}Z`);
    assert.equal(tourismDayIsActive([event], time, start - 1), false);
    assert.equal(tourismDayIsActive([event], time, start), true);
    assert.equal(tourismDayIsActive([event], time, start + 172799), true);
    assert.equal(tourismDayIsActive([event], time, start + 172800), false);
  }
});

test("fixed events ignore personal time; unrelated events do not double capacity", () => {
  assert.equal(tourismDayIsActive([{ ...event, fixed_start_time: true }], null, event.start), true);
  assert.equal(tourismDayIsActive([{ ...event, title: "World Tiger Day" }], null, event.start), false);
  assert.equal(tourismDayIsActive([], null, event.start), false);
  assert.throws(() => tourismDayIsActive([event], "25:00", event.start));
  assert.throws(() => tourismDayIsActive(undefined, "12:00", event.start));
});

test("login applies calendar bonus to base, suitcase, faction, book and general job slots", async (t) => {
  const calls = [];
  const now = Math.floor(Date.now() / 1000);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(String(url));
    let data;
    if (String(url).includes("selections=basic,perks")) {
      data = {
        name: "Traveller", player_id: 123, level: 15,
        property_perks: ["Airstrip"],
        enhancer_perks: ["+ 5 travel items"],
        faction_perks: ["+ 10 travel item capacity"],
        book_perks: ["+ 10 travel items"],
        job_perks: ["+ 3 travel items", "+ 5 travel items (flowers only)"],
      };
    } else {
      assert.equal(options.headers.Authorization, "ApiKey test-key");
      data = { calendar: { events: [{ ...event, start: now - 60, end: now + 60, fixed_start_time: true }] } };
    }
    return { ok: true, json: async () => data };
  });
  const player = await getPlayerInfo("test-key");
  assert.equal(player.capacity, 86);
  assert.equal(player.baseCapacity, 15);
  assert.equal(player.bonusCapacity, 28);
  assert.equal(player.capacityMultiplier, 2);
  assert.equal(player.capacityWarning, null);
  assert.match(player.capacityPerks.at(-1), /Tourism Day/);
  assert.equal(calls.length, 2);
});

test("login reads the personal calendar and leaves normal capacity outside the event", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    const data = String(url).includes("selections=")
      ? { property_perks: ["Airstrip"], faction_perks: ["+ 8 travel items"], enhancer_perks: ["+ 5 travel items"] }
      : String(url).endsWith("/torn/calendar")
        ? { calendar: { events: [{ ...event, start: 100000, end: 272800 }] } }
        : { calendar: { start_time: "14:15" } };
    return { ok: true, json: async () => data };
  });
  const player = await getPlayerInfo("test-key");
  assert.equal(player.capacity, 28);
  assert.equal(player.capacityMultiplier, 1);
  assert.equal(player.capacityWarning, null);
  assert.equal(calls.at(-1), "https://api.torn.com/v2/user/calendar");
});

test("calendar permission errors preserve login and clearly mark capacity as unverified", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true,
    json: async () => String(url).includes("selections=")
      ? { name: "Traveller", player_id: 123 }
      : { error: { code: 16, error: "Access level too low" } },
  }));
  const player = await getPlayerInfo("test-key");
  assert.equal(player.name, "Traveller");
  assert.equal(player.capacity, 5);
  assert.match(player.capacityWarning, /unverified/);
});
