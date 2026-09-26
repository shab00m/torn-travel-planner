import test from "node:test";
import assert from "node:assert/strict";
import { getPlayerInfo, tourismDayIsActive } from "../src/torn.js";

const ts = (date) => Date.parse(date) / 1000;
const event = {
  title: "World Tourism Day",
  // Public event dates observed in Torn's live calendar response.
  start: 1790467200,
  end: 1790553599,
  fixed_start_time: false,
};

test("personal Tourism Day covers exactly 48 hours including September 26", () => {
  for (const time of ["10:00", "10:15 TCT", "14:15 TCT", "16:00:00 TCT", " 10:15 TCT "]) {
    const clock = time.trim().replace(/ TCT$/, "");
    const start = ts(`2026-09-26T${clock.length === 5 ? clock + ":00" : clock}Z`);
    assert.equal(tourismDayIsActive([event], time, start - 1), false);
    assert.equal(tourismDayIsActive([event], time, start), true);
    assert.equal(tourismDayIsActive([event], time, start + 172799), true);
    assert.equal(tourismDayIsActive([event], time, start + 172800), false);
  }
});

test("already expanded personal event windows retain their duration", () => {
  const expanded = { ...event, start: ts("2026-09-26T12:00:00Z"), end: ts("2026-09-28T12:00:00Z") };
  assert.equal(tourismDayIsActive([expanded], "10:15 TCT", ts("2026-09-26T10:15:00Z")), true);
  assert.equal(tourismDayIsActive([expanded], "10:15 TCT", ts("2026-09-28T10:15:00Z")), false);
});

test("live calendar response format doubles 38 slots to 76 on September 26", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-09-26T18:00:00Z"));
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true,
    json: async () => String(url).includes("selections=")
      ? { property_perks: ["Airstrip"], faction_perks: ["+ 8 travel items"], enhancer_perks: ["+ 5 travel items"], book_perks: ["+ 10 travel items"] }
      : String(url).endsWith("/torn/calendar")
        ? { calendar: { events: [{ ...event, title: "Tourism Day" }] } }
        : { calendar: { start_time: "10:15 TCT" } },
  }));
  const player = await getPlayerInfo("test-key");
  assert.equal(player.capacity, 76);
  assert.equal(player.capacityMultiplier, 2);
  assert.equal(player.capacityWarning, null);
});

test("fixed events ignore personal time; unrelated events do not double capacity", () => {
  assert.equal(tourismDayIsActive([{ ...event, fixed_start_time: true }], null, event.start), true);
  assert.equal(tourismDayIsActive([{ ...event, title: "World Tiger Day" }], null, event.start), false);
  assert.equal(tourismDayIsActive([], null, event.start), false);
  assert.throws(() => tourismDayIsActive([event], "25:00", event.start));
  assert.throws(() => tourismDayIsActive(undefined, "12:00", event.start));
});

test("login applies calendar bonus to base, suitcase, faction, book and general job slots", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-09-26T18:00:00Z"));
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
  t.mock.method(Date, "now", () => Date.parse("2026-09-25T18:00:00Z"));
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
  t.mock.method(Date, "now", () => Date.parse("2026-09-26T18:00:00Z"));
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

test("calendar requests only run September 25–29 UTC, including in future years", async (t) => {
  let now;
  const calls = [];
  t.mock.method(Date, "now", () => Date.parse(now));
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => String(url).includes("selections=")
        ? { property_perks: ["Airstrip"], faction_perks: ["+ 8 travel items"] }
        : { calendar: { events: [] } },
    };
  });
  for (const [date, calendarExpected] of [
    ["2026-01-27T12:00:00Z", false],
    ["2026-09-24T23:59:59Z", false],
    ["2026-09-25T00:00:00Z", true],
    ["2026-09-29T23:59:59Z", true],
    ["2026-09-30T00:00:00Z", false],
    ["2026-10-27T12:00:00Z", false],
    ["2027-09-27T12:00:00Z", true],
    ["2026-09-25T01:00:00+02:00", false],
    ["2026-09-30T01:00:00+02:00", true],
  ]) {
    now = date;
    calls.length = 0;
    const player = await getPlayerInfo("test-key");
    assert.equal(calls.length, calendarExpected ? 2 : 1, date);
    assert.ok(calls[0].includes("selections=basic,perks"));
    assert.equal(player.capacity, 23);
    assert.equal(player.capacityMultiplier, 1);
    assert.equal(player.capacityWarning, null);
  }
});
