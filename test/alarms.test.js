import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/alarms.js", import.meta.url), "utf8");

function audioHarness() {
  const contexts = [];
  const timers = new Map();
  const listeners = new Map();
  let timerId = 0;
  let interacted = false;
  class AudioContext {
    state = "suspended";
    currentTime = 0;
    destination = {};
    notes = [];
    gains = [];
    pending = [];
    constructor() { contexts.push(this); }
    resume() {
      if (interacted) {
        this.state = "running";
        for (const resolve of this.pending.splice(0)) resolve();
        return Promise.resolve();
      }
      return new Promise((resolve) => this.pending.push(resolve));
    }
    createGain() {
      const gain = {
        gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        disconnected: false,
        disconnect() { this.disconnected = true; },
      };
      this.gains.push(gain);
      return gain;
    }
    createOscillator() {
      return {
        frequency: { value: 0 }, connect() {},
        start: (at) => this.notes.push(at), stop() {},
      };
    }
  }
  const sandbox = vm.createContext({
    window: { AudioContext, addEventListener() {} },
    document: {
      readyState: "loading",
      addEventListener(type, fn, options) { listeners.set(type, { fn, options }); },
    },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() {},
  });
  vm.runInContext(source, sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  const gesture = () => { interacted = true; run("unlockAlarmAudio({ isTrusted: true })"); };
  return { contexts, timers, listeners, run, gesture };
}

test("timer alarms reuse audio unlocked by a user gesture, including after dismissal", () => {
  const h = audioHarness();
  h.gesture();
  h.run('playAlarmBeep("first")');
  const ctx = h.contexts[0];
  assert.equal(ctx.state, "running");
  assert.equal(ctx.notes.length, 6);
  const master = ctx.gains[0];
  h.run('stopAlarmSound("different")');
  assert.equal(master.disconnected, false);
  h.run('stopAlarmSound("first")');
  assert.equal(master.disconnected, true);
  assert.equal(h.timers.size, 0);
  h.run('playAlarmBeep("second")');
  assert.equal(h.contexts.length, 1);
  assert.equal(ctx.notes.length, 12);
});

test("blocked audio waits for interaction without queuing silent notes", async () => {
  const h = audioHarness();
  h.run('playAlarmBeep("blocked")');
  assert.equal(h.contexts[0].notes.length, 0);
  h.gesture();
  await Promise.resolve();
  assert.equal(h.contexts[0].notes.length, 6);
});

test("dismissing a blocked alarm prevents playback after a later gesture", async () => {
  const h = audioHarness();
  h.run('playAlarmBeep("blocked"); stopAlarmSound("blocked")');
  h.gesture();
  await Promise.resolve();
  assert.equal(h.contexts[0].notes.length, 0);
  assert.equal(h.timers.size, 0);
});

test("test sound and alarm timeout silence audio while preserving the unlocked context", () => {
  const h = audioHarness();
  h.gesture();
  h.run("playAlarmBeep(null, ALARM_BEEP_PATTERN_MS + 50)");
  const timeout = [...h.timers.values()].find((timer) => timer.delay === 1370);
  assert.ok(timeout);
  timeout.fn();
  assert.equal(h.contexts[0].gains[0].disconnected, true);
  assert.equal(h.contexts[0].state, "running");
  assert.equal(h.timers.size, 0);
  h.run('playAlarmBeep("alarm")');
  assert.ok([...h.timers.values()].some((timer) => timer.delay === 60000));
});

test("initialization registers gesture capture before async alarm handlers", () => {
  const h = audioHarness();
  h.run(`
    loadAlarms = () => [];
    injectAlarmsPanel = injectAlarmSettings = startAlarmTicker = startTravelPollForAlarms = () => {};
    initAlarms();
  `);
  for (const type of ["click", "keydown", "touchend"]) {
    assert.equal(h.listeners.get(type).options.capture, true);
  }
  h.listeners.get("click").fn({ isTrusted: false });
  assert.equal(h.contexts.length, 0);
});
