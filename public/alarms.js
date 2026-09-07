// Client-side alarms: localStorage persistence, header panel, Notification + beep.
const ALARMS_KEY = "plannerAlarms";
const ALARMS_OPEN_KEY = "plannerAlarmsOpen";
const ALARM_TYPES = ["leave_regular", "leave_safe", "arrival", "restock"];

const alarmState = {
  alarms: [],
  tickerId: null,
  travelPollId: null,
  settingsBound: false,
  /** @type {{ ctx: AudioContext | null, timers: number[], alarmId: string | null } | null} */
  sound: null,
  /** @type {Record<string, number>} last resolve attempt (unix sec) per restock alarm id */
  restockCheckAt: {},
  /** @type {Set<string>} */
  restockCheckInFlight: new Set(),
};

const RESTOCK_CHECK_INTERVAL_DUE_SEC = 15;
const RESTOCK_CHECK_INTERVAL_ARMED_SEC = 30;

const ALARM_BEEP_PATTERN = [
  { t: 0, freq: 880, dur: 0.16 },
  { t: 0.2, freq: 1175, dur: 0.16 },
  { t: 0.4, freq: 880, dur: 0.16 },
  { t: 0.7, freq: 880, dur: 0.16 },
  { t: 0.9, freq: 1175, dur: 0.16 },
  { t: 1.1, freq: 880, dur: 0.22 },
];
const ALARM_BEEP_PATTERN_MS = 1320;
const ALARM_BEEP_PAUSE_MS = 2000;
const ALARM_BEEP_MAX_MS = 60 * 1000;

function defaultAlarmPrefs() {
  return {
    leaveAlarmOffsetMin: 1,
    arrivalAlarmOffsetMin: 1,
    autoArrivalAlarm: false,
    autoAlarmRestrictHours: false,
    autoAlarmAllowedStart: "00:00",
    autoAlarmAllowedEnd: "23:59",
    autoSafeAlarms: {},
  };
}

function loadAlarmPrefs() {
  const prefs = loadPrefs();
  const defaults = defaultAlarmPrefs();
  const leaveMin = Number(prefs.leaveAlarmOffsetMin);
  const arrivalMin = Number(prefs.arrivalAlarmOffsetMin);
  return {
    leaveAlarmOffsetMin:
      Number.isFinite(leaveMin) && leaveMin >= 0 ? leaveMin : defaults.leaveAlarmOffsetMin,
    arrivalAlarmOffsetMin:
      Number.isFinite(arrivalMin) && arrivalMin >= 0 ? arrivalMin : defaults.arrivalAlarmOffsetMin,
    autoArrivalAlarm: prefs.autoArrivalAlarm === true,
    autoAlarmRestrictHours: prefs.autoAlarmRestrictHours === true,
    autoAlarmAllowedStart: parseHhMm(prefs.autoAlarmAllowedStart) ?? defaults.autoAlarmAllowedStart,
    autoAlarmAllowedEnd: parseHhMm(prefs.autoAlarmAllowedEnd) ?? defaults.autoAlarmAllowedEnd,
    autoSafeAlarms:
      prefs.autoSafeAlarms && typeof prefs.autoSafeAlarms === "object" ? prefs.autoSafeAlarms : {},
  };
}

function parseHhMm(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function hhMmToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Whether a unix fire time falls inside the configured auto-alarm allowed hours. */
function isWithinAutoAlarmHours(fireTs) {
  const prefs = loadAlarmPrefs();
  if (!prefs.autoAlarmRestrictHours) return true;
  const start = hhMmToMinutes(prefs.autoAlarmAllowedStart);
  const end = hhMmToMinutes(prefs.autoAlarmAllowedEnd);
  const parts = new Date(fireTs * 1000).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(state.timeZone === "tct" ? { timeZone: "UTC" } : {}),
  });
  const [hh, mm] = parts.split(":").map(Number);
  const mins = hh * 60 + mm;
  if (start <= end) return mins >= start && mins <= end;
  // Overnight span (e.g. 22:00–08:00)
  return mins >= start || mins <= end;
}

function getLeaveAlarmOffsetSec() {
  return Math.round(loadAlarmPrefs().leaveAlarmOffsetMin * 60);
}

function getArrivalAlarmOffsetSec() {
  return Math.round(loadAlarmPrefs().arrivalAlarmOffsetMin * 60);
}

function loadAlarms() {
  try {
    const raw = JSON.parse(localStorage.getItem(ALARMS_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (a) =>
        a &&
        typeof a.id === "string" &&
        ALARM_TYPES.includes(a.type) &&
        typeof a.eventTs === "number" &&
        typeof a.offsetSec === "number"
    );
  } catch {
    return [];
  }
}

function persistAlarms() {
  localStorage.setItem(ALARMS_KEY, JSON.stringify(alarmState.alarms));
}

function fireAt(alarm) {
  return alarm.eventTs - alarm.offsetSec;
}

function isAlarmActive(alarm) {
  return Boolean(alarm) && !alarm.dismissedAt;
}

function activeAlarms() {
  // Pending + fired waiting for dismiss. Dismissed records stay in storage but are hidden.
  return alarmState.alarms.filter(isAlarmActive).sort((a, b) => {
    if (Boolean(a.firedAt) !== Boolean(b.firedAt)) return a.firedAt ? -1 : 1;
    return fireAt(a) - fireAt(b);
  });
}

function newAlarmId() {
  return crypto.randomUUID();
}

function matchesLeaveAlarm(a, type, country, itemId, windowIndex) {
  return (
    a.type === type &&
    a.country === country &&
    Number(a.itemId) === Number(itemId) &&
    Number(a.windowIndex) === Number(windowIndex)
  );
}

/** Armed (not fired, not dismissed) leave alarm — for UI toggle state. */
function findLeaveAlarm(type, country, itemId, windowIndex) {
  return alarmState.alarms.find(
    (a) =>
      isAlarmActive(a) &&
      !a.firedAt &&
      matchesLeaveAlarm(a, type, country, itemId, windowIndex)
  );
}

/** Any leave alarm record including fired/dismissed — for sync dedupe. */
function findLeaveAlarmRecord(type, country, itemId, windowIndex) {
  return alarmState.alarms.find((a) => matchesLeaveAlarm(a, type, country, itemId, windowIndex));
}

function findArrivalAlarm() {
  return alarmState.alarms.find((a) => isAlarmActive(a) && !a.firedAt && a.type === "arrival");
}

/** Any arrival record including fired/dismissed — for sync dedupe. */
function findArrivalAlarmRecord() {
  return alarmState.alarms.find((a) => a.type === "arrival");
}

function findRestockAlarm(country, itemId) {
  return alarmState.alarms.find(
    (a) =>
      isAlarmActive(a) &&
      !a.firedAt &&
      a.type === "restock" &&
      a.country === country &&
      Number(a.itemId) === Number(itemId)
  );
}

function hasLeaveAlarm(type, country, itemId, windowIndex) {
  return Boolean(findLeaveAlarm(type, country, itemId, windowIndex));
}

function hasArrivalAlarm() {
  return Boolean(findArrivalAlarm());
}

function hasRestockAlarm(country, itemId) {
  return Boolean(findRestockAlarm(country, itemId));
}

async function ensureNotificationPermission() {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

function stopAlarmSound(alarmId = null) {
  const sound = alarmState.sound;
  if (!sound) return;
  if (alarmId != null && sound.alarmId != null && sound.alarmId !== alarmId) return;
  for (const id of sound.timers) clearTimeout(id);
  sound.timers = [];
  if (sound.ctx) {
    try {
      sound.ctx.close();
    } catch {
      /* ignore */
    }
  }
  alarmState.sound = null;
}

function scheduleBeepPattern(ctx, master, offsetSec) {
  for (const { t, freq, dur } of ALARM_BEEP_PATTERN) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    const start = ctx.currentTime + offsetSec + t;
    const end = start + dur;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(1, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

/** Repeat the beep pattern (2s pause between) for up to 1 minute or until dismissed. */
function playAlarmBeep(alarmId) {
  stopAlarmSound();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);

    const sound = { ctx, timers: [], alarmId };
    alarmState.sound = sound;
    const startedAt = Date.now();
    const cycleMs = ALARM_BEEP_PATTERN_MS + ALARM_BEEP_PAUSE_MS;

    const playCycle = () => {
      if (alarmState.sound !== sound) return;
      if (Date.now() - startedAt >= ALARM_BEEP_MAX_MS) {
        stopAlarmSound(alarmId);
        return;
      }
      scheduleBeepPattern(ctx, master, 0);
      const timer = setTimeout(playCycle, cycleMs);
      sound.timers.push(timer);
    };

    const maxTimer = setTimeout(() => {
      if (alarmState.sound !== sound) return;
      stopAlarmSound(alarmId);
    }, ALARM_BEEP_MAX_MS);
    sound.timers.push(maxTimer);
    playCycle();
  } catch {
    alarmState.sound = null;
  }
}

function alarmTitle(alarm) {
  if (alarm.type === "arrival") {
    const dest = alarm.destination || alarm.country || "destination";
    return `Arriving: ${dest}`;
  }
  const item = alarm.itemName || `item ${alarm.itemId}`;
  if (alarm.type === "restock") return `Restock: ${item}`;
  const kind = alarm.type === "leave_safe" ? "Safe leave" : "Leave";
  return `${kind}: ${item}`;
}

function alarmBody(alarm) {
  const when = typeof fmtTimeShort === "function" ? fmtTimeShort(alarm.eventTs) : String(alarm.eventTs);
  const offsetMin = Math.round(alarm.offsetSec / 60);
  if (alarm.type === "arrival") {
    return `Landing at ${when} (${offsetMin}m offset)`;
  }
  if (alarm.type === "restock") {
    return `Restock at ${when} (${offsetMin}m offset)`;
  }
  return `Leave window starts ${when} (${offsetMin}m offset)`;
}

function fireAlarm(alarm) {
  if (alarm.firedAt || alarm.dismissedAt) return;
  alarm.firedAt = Math.floor(Date.now() / 1000);
  persistAlarms();
  playAlarmBeep(alarm.id);
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      new Notification(alarmTitle(alarm), { body: alarmBody(alarm), tag: alarm.id });
    } catch {
      /* ignore */
    }
  }
  setAlarmsOpen(true);
  renderAlarmsPanel();
  window.dispatchEvent(new CustomEvent("alarmschange"));
}

/** Hard-delete (manual toggle-off, sync cleanup when event is gone). */
function removeAlarmById(id) {
  stopAlarmSound(id);
  const before = alarmState.alarms.length;
  alarmState.alarms = alarmState.alarms.filter((a) => a.id !== id);
  if (alarmState.alarms.length !== before) {
    persistAlarms();
    renderAlarmsPanel();
    window.dispatchEvent(new CustomEvent("alarmschange"));
  }
}

/** Soft-dismiss auto alarms so sync does not recreate them; hard-delete manual ones. */
function dismissAlarmById(id) {
  stopAlarmSound(id);
  const alarm = alarmState.alarms.find((a) => a.id === id);
  if (!alarm || alarm.dismissedAt) return;
  if (!alarm.auto) {
    removeAlarmById(id);
    return;
  }
  alarm.dismissedAt = Math.floor(Date.now() / 1000);
  persistAlarms();
  renderAlarmsPanel();
  window.dispatchEvent(new CustomEvent("alarmschange"));
}

function upsertAlarm(alarm) {
  const idx = alarmState.alarms.findIndex((a) => a.id === alarm.id);
  if (idx >= 0) alarmState.alarms[idx] = alarm;
  else alarmState.alarms.push(alarm);
  persistAlarms();
  renderAlarmsPanel();
  window.dispatchEvent(new CustomEvent("alarmschange"));
}

async function toggleLeaveAlarm({ type, country, itemId, itemName, windowIndex, leaveEarliest }) {
  if (type !== "leave_regular" && type !== "leave_safe") return;
  if (leaveEarliest == null || country == null || itemId == null || windowIndex == null) return;
  const existing = findLeaveAlarm(type, country, itemId, windowIndex);
  if (existing) {
    removeAlarmById(existing.id);
    return;
  }
  await ensureNotificationPermission();
  const record = findLeaveAlarmRecord(type, country, itemId, windowIndex);
  if (record) {
    record.dismissedAt = null;
    record.firedAt = null;
    record.eventTs = leaveEarliest;
    record.offsetSec = getLeaveAlarmOffsetSec();
    record.auto = false;
    record.itemName = itemName || record.itemName;
    persistAlarms();
    renderAlarmsPanel();
    window.dispatchEvent(new CustomEvent("alarmschange"));
    return;
  }
  upsertAlarm({
    id: newAlarmId(),
    type,
    country,
    itemId: Number(itemId),
    itemName: itemName || null,
    windowIndex: Number(windowIndex),
    eventTs: leaveEarliest,
    offsetSec: getLeaveAlarmOffsetSec(),
    auto: false,
    firedAt: null,
    dismissedAt: null,
  });
}

async function toggleArrivalAlarm({ country, itemId, itemName, arriveTs, destination }) {
  if (arriveTs == null) return;
  const existing = findArrivalAlarm();
  if (existing) {
    removeAlarmById(existing.id);
    return;
  }
  await ensureNotificationPermission();
  const record = findArrivalAlarmRecord();
  if (record) {
    record.dismissedAt = null;
    record.firedAt = null;
    record.type = "arrival";
    record.country = country || null;
    record.itemId = itemId != null ? Number(itemId) : null;
    record.itemName = itemName || null;
    record.destination = destination || null;
    record.windowIndex = null;
    record.eventTs = arriveTs;
    record.offsetSec = getArrivalAlarmOffsetSec();
    record.auto = false;
    persistAlarms();
    renderAlarmsPanel();
    window.dispatchEvent(new CustomEvent("alarmschange"));
    return;
  }
  upsertAlarm({
    id: newAlarmId(),
    type: "arrival",
    country: country || null,
    itemId: itemId != null ? Number(itemId) : null,
    itemName: itemName || null,
    destination: destination || null,
    windowIndex: null,
    eventTs: arriveTs,
    offsetSec: getArrivalAlarmOffsetSec(),
    auto: false,
    firedAt: null,
    dismissedAt: null,
  });
}

async function toggleRestockAlarm({ country, itemId, itemName, restockTs, depletedTs }) {
  if (restockTs == null || country == null || itemId == null) return;
  const existing = findRestockAlarm(country, itemId);
  if (existing) {
    removeAlarmById(existing.id);
    return;
  }
  await ensureNotificationPermission();
  const now = Math.floor(Date.now() / 1000);
  const cycleDepletedTs = depletedTs != null ? Number(depletedTs) : null;
  // Overdue open cycle: wait for the actual restock instead of firing immediately.
  const awaitActual = restockTs <= now;
  const record = alarmState.alarms.find(
    (a) =>
      a.type === "restock" &&
      a.country === country &&
      Number(a.itemId) === Number(itemId)
  );
  if (record) {
    record.dismissedAt = null;
    record.firedAt = null;
    record.eventTs = restockTs;
    record.depletedTs = Number.isFinite(cycleDepletedTs) ? cycleDepletedTs : null;
    record.awaitActual = awaitActual;
    record.offsetSec = getLeaveAlarmOffsetSec();
    record.auto = false;
    record.itemName = itemName || record.itemName;
    persistAlarms();
    renderAlarmsPanel();
    window.dispatchEvent(new CustomEvent("alarmschange"));
    return;
  }
  upsertAlarm({
    id: newAlarmId(),
    type: "restock",
    country,
    itemId: Number(itemId),
    itemName: itemName || null,
    destination: null,
    windowIndex: 0,
    eventTs: restockTs,
    depletedTs: Number.isFinite(cycleDepletedTs) ? cycleDepletedTs : null,
    awaitActual,
    offsetSec: getLeaveAlarmOffsetSec(),
    auto: false,
    firedAt: null,
    dismissedAt: null,
  });
}

/**
 * Keep next-restock (#1) alarm in sync with the latest prediction.
 * Fires only when the armed cycle has actually restocked — never on prediction time alone.
 *
 * @param {string} country
 * @param {number} itemId
 * @param {number|null|{ nextTs?: number|null, nextDepletedTs?: number|null, armedCycleRestockedTs?: number|null }} info
 */
function syncRestockAlarmForItem(country, itemId, info) {
  if (!country || itemId == null) return;
  const existing = findRestockAlarm(country, itemId);
  if (!existing) return;
  const now = Math.floor(Date.now() / 1000);
  const payload =
    info != null && typeof info === "object"
      ? info
      : { nextTs: info ?? null };
  const nextTs = payload.nextTs ?? null;
  const nextDepletedTs =
    payload.nextDepletedTs != null && Number.isFinite(Number(payload.nextDepletedTs))
      ? Number(payload.nextDepletedTs)
      : null;
  const armedCycleRestockedTs =
    payload.armedCycleRestockedTs != null &&
    Number.isFinite(Number(payload.armedCycleRestockedTs))
      ? Number(payload.armedCycleRestockedTs)
      : null;

  // Armed cycle closed (possibly before the predicted time) — notify now.
  if (armedCycleRestockedTs != null) {
    existing.eventTs = armedCycleRestockedTs;
    existing.awaitActual = false;
    persistAlarms();
    fireAlarm(existing);
    return;
  }

  if (nextTs == null) {
    removeAlarmById(existing.id);
    return;
  }

  let changed = false;
  if (existing.eventTs !== nextTs) {
    existing.eventTs = nextTs;
    changed = true;
  }
  if (nextDepletedTs != null && Number(existing.depletedTs) !== nextDepletedTs) {
    existing.depletedTs = nextDepletedTs;
    changed = true;
  }

  // Overdue / inside offset window: wait for actual restock (ticker verifies + may reschedule).
  const due = fireAt(existing) <= now;
  if (due || nextTs <= now) {
    if (!existing.awaitActual) {
      existing.awaitActual = true;
      changed = true;
    }
  } else if (existing.awaitActual) {
    existing.awaitActual = false;
    changed = true;
  }

  if (changed) {
    persistAlarms();
    renderAlarmsPanel();
    window.dispatchEvent(new CustomEvent("alarmschange"));
  }
}

function usableRestockDurations(restocks) {
  return (restocks || [])
    .filter((r) => !r.ignored && r.duration != null && r.duration > 0)
    .map((r) => r.duration);
}

function selectedStockoutSec(restocks, country, itemId) {
  const settings =
    typeof itemSettingsFor === "function" ? itemSettingsFor(country, itemId) : {};
  const timing = ["avg", "min", "max"].includes(settings.stockoutTiming)
    ? settings.stockoutTiming
    : "avg";
  if ((timing === "min" || timing === "max") && country != null) {
    const bounds = getEmptyForBounds(country, itemId);
    const configured = timing === "min" ? bounds.minEmptyFor : bounds.maxEmptyFor;
    if (configured != null) return configured;
  }
  const rows = (restocks || []).filter((r) => !r.ignored && r.duration != null && r.duration > 0);
  if (!rows.length) return null;
  const durations = rows.map((r) => r.duration);
  if (timing === "min") return Math.min(...durations);
  if (timing === "max") return Math.max(...durations);
  const n = Number(settings.avgSamples);
  const sample = rows.slice(0, Number.isFinite(n) && n > 0 ? n : 5);
  return sample.reduce((sum, r) => sum + r.duration, 0) / sample.length;
}

function selectedDepletionRate(rates, country, itemId) {
  const settings =
    typeof itemSettingsFor === "function" ? itemSettingsFor(country, itemId) : {};
  const rows = (rates || []).filter((w) => !w.open && w.rate != null && w.rate > 0);
  if (!rows.length) return null;
  const timing = ["avg", "min", "max"].includes(settings.rateTiming) ? settings.rateTiming : "avg";
  const values = rows.map((w) => w.rate);
  if (timing === "min") return Math.min(...values);
  if (timing === "max") return Math.max(...values);
  const n = Number(settings.avgRateSamples);
  const sample = rows.slice(0, Number.isFinite(n) && n > 0 ? n : 3);
  return sample.reduce((sum, w) => sum + w.rate, 0) / sample.length;
}

/** Next predicted restock after now for alarm reschedule (open-cycle step or deplete+restock). */
function computeNextRestockAlarmTarget({ restocks, rates, quantity, now, country, itemId }) {
  const restockSec = selectedStockoutSec(restocks, country, itemId);
  if (restockSec == null) return null;
  const open = (restocks || []).find((r) => r.restocked_ts == null);

  if (quantity === 0 || open) {
    if (!open?.depleted_ts) return null;
    const depletedTs = open.depleted_ts;
    if (depletedTs + restockSec > now) {
      return { ts: Math.round(depletedTs + restockSec), depletedTs };
    }
    const nextDur = [...new Set(usableRestockDurations(restocks))]
      .sort((a, b) => a - b)
      .find((d) => depletedTs + d > now);
    if (nextDur == null) return null;
    return { ts: Math.round(depletedTs + nextDur), depletedTs };
  }

  if (quantity == null || quantity <= 0) return null;
  const rate = selectedDepletionRate(rates, country, itemId);
  if (rate == null || rate <= 0) return null;
  const depleteTs = Math.round(now + (quantity / rate) * 60);
  const restockTs = Math.round(depleteTs + restockSec);
  if (restockTs <= now) return null;
  return { ts: restockTs, depletedTs: depleteTs };
}

function stockQuantityForAlarm(stocksPayload, country, itemId) {
  const countryData = stocksPayload?.stocks?.[country];
  const item = countryData?.stocks?.find((i) => Number(i.id) === Number(itemId));
  return item?.quantity;
}

/**
 * When a restock alarm's countdown is due (or while awaiting actual): fire only if the
 * cycle has restocked; otherwise reschedule to the next future prediction.
 */
async function resolveDueRestockAlarm(alarm) {
  if (!alarm || alarm.firedAt || alarm.dismissedAt || alarm.type !== "restock") return;
  if (alarm.country == null || alarm.itemId == null) return;
  const now = Math.floor(Date.now() / 1000);
  const due = fireAt(alarm) <= now;

  try {
    await ensureRestockAmountsForArmedAlarms();
    const [restockRes, stocksRes] = await Promise.all([
      fetch(`/api/restocks/${encodeURIComponent(alarm.country)}/${alarm.itemId}`),
      fetch("/api/stocks"),
    ]);
    if (!restockRes.ok) throw new Error("restocks failed");
    const restockData = await restockRes.json();
    const stocksData = stocksRes.ok ? await stocksRes.json() : null;
    const restocks = restockData.restocks || [];
    const rates = restockData.rates || [];
    const quantity = stockQuantityForAlarm(stocksData, alarm.country, alarm.itemId);

    // Stock snapshot is authoritative: if we're waiting on a past/open cycle and
    // quantity is already > 0, fire even when the restocks row hasn't closed yet.
    // Negligible sell-back spikes are ignored (same rule as server restock detection).
    if (tryFireRestockAlarmOnStock(alarm, quantity, now, restocks)) return;

    // Before countdown: only fire on confirmed restock (early). Don't reschedule yet.
    if (!due) return;

    const next = computeNextRestockAlarmTarget({
      restocks,
      rates,
      quantity,
      now,
      country: alarm.country,
      itemId: alarm.itemId,
    });
    if (next?.ts != null && next.ts - (alarm.offsetSec || 0) > now) {
      let changed = false;
      if (alarm.eventTs !== next.ts) {
        alarm.eventTs = next.ts;
        changed = true;
      }
      if (next.depletedTs != null && Number(alarm.depletedTs) !== Number(next.depletedTs)) {
        alarm.depletedTs = next.depletedTs;
        changed = true;
      }
      if (alarm.awaitActual) {
        alarm.awaitActual = false;
        changed = true;
      }
      if (changed) {
        persistAlarms();
        renderAlarmsPanel();
        window.dispatchEvent(new CustomEvent("alarmschange"));
      }
      return;
    }

    // No future fire time — keep waiting for the actual restock.
    let changed = false;
    if (next?.ts != null && alarm.eventTs !== next.ts) {
      alarm.eventTs = next.ts;
      changed = true;
    }
    if (next?.depletedTs != null && Number(alarm.depletedTs) !== Number(next.depletedTs)) {
      alarm.depletedTs = next.depletedTs;
      changed = true;
    }
    if (!alarm.awaitActual) {
      alarm.awaitActual = true;
      changed = true;
    }
    if (changed) {
      persistAlarms();
      renderAlarmsPanel();
      window.dispatchEvent(new CustomEvent("alarmschange"));
    }
  } catch {
    /* retry on next throttle window — never fire on a failed check */
  }
}

/** Same sell-back noise filter as server restock detection (needs configured restock amount). */
function isNegligibleAlarmStockQty(quantity, country, itemId) {
  if (typeof isNegligibleRestockQty !== "function" || typeof getRestockAmount !== "function") {
    return false;
  }
  return isNegligibleRestockQty(quantity, getRestockAmount(country, itemId));
}

/**
 * Fire immediately when stock is back for a cycle we were waiting on.
 * Ignores future predicted deplete timestamps (in-stock multi-cycle alarms)
 * and negligible sell-back spikes (same rule as server restock detection).
 */
function tryFireRestockAlarmOnStock(alarm, quantity, now = Math.floor(Date.now() / 1000), restocks = null) {
  if (!alarm || alarm.firedAt || alarm.dismissedAt || alarm.type !== "restock") return false;

  if (alarm.depletedTs != null) {
    if (Number(alarm.depletedTs) > now) return false;
    const closed = Array.isArray(restocks)
      ? restocks.find(
          (r) =>
            Number(r.depleted_ts) === Number(alarm.depletedTs) && r.restocked_ts != null
        )
      : null;
    // Server-closed cycle already passed the negligible filter.
    if (closed) {
      alarm.eventTs = closed.restocked_ts;
      alarm.awaitActual = false;
      persistAlarms();
      fireAlarm(alarm);
      return true;
    }
    // Stocks can lead the restocks row — only fire on a non-negligible qty.
    if (quantity == null || quantity <= 0) return false;
    if (isNegligibleAlarmStockQty(quantity, alarm.country, alarm.itemId)) return false;
    alarm.eventTs = now;
    alarm.awaitActual = false;
    persistAlarms();
    fireAlarm(alarm);
    return true;
  }

  // Legacy: only when already due / awaiting, so in-stock future alarms don't false-fire.
  if (!(alarm.awaitActual || fireAt(alarm) <= now)) return false;
  if (quantity == null || quantity <= 0) return false;
  if (isNegligibleAlarmStockQty(quantity, alarm.country, alarm.itemId)) return false;
  const recent = Array.isArray(restocks)
    ? restocks
        .filter(
          (r) =>
            r.restocked_ts != null &&
            r.restocked_ts <= alarm.eventTs &&
            r.restocked_ts >= now - 300
        )
        .sort((a, b) => b.restocked_ts - a.restocked_ts)[0]
    : null;
  alarm.eventTs = recent?.restocked_ts ?? now;
  alarm.awaitActual = false;
  persistAlarms();
  fireAlarm(alarm);
  return true;
}

async function ensureRestockAmountsForArmedAlarms() {
  const armed = alarmState.alarms.filter(
    (a) => a.type === "restock" && !a.firedAt && !a.dismissedAt
  );
  await Promise.all(
    armed.map(async (a) => {
      if (typeof loadRestockAmountForItem === "function") {
        const haveAmount =
          typeof getRestockAmount === "function" && getRestockAmount(a.country, a.itemId) != null;
        if (!haveAmount) {
          try {
            await loadRestockAmountForItem(a.country, a.itemId);
          } catch {
            /* amount stays unknown → negligible check is a no-op (same as server) */
          }
        }
      }
      if (
        typeof loadEmptyForBoundsForItem === "function" &&
        !(restockAmountKey(a.country, a.itemId) in state.emptyForBounds)
      ) {
        try {
          await loadEmptyForBoundsForItem(a.country, a.itemId);
        } catch {
          /* bounds stay unset → MIN/MAX use historical extents */
        }
      }
    })
  );
}

/** Called when a fresh /api/stocks payload arrives — fire without waiting on the ticker throttle. */
async function refreshRestockAlarmsFromStocks(stocksPayload) {
  if (!stocksPayload) return;
  const armed = alarmState.alarms.some(
    (a) => a.type === "restock" && !a.firedAt && !a.dismissedAt
  );
  if (!armed) return;
  await ensureRestockAmountsForArmedAlarms();
  const now = Math.floor(Date.now() / 1000);
  for (const alarm of alarmState.alarms) {
    if (alarm.firedAt || alarm.dismissedAt || alarm.type !== "restock") continue;
    const qty = stockQuantityForAlarm(stocksPayload, alarm.country, alarm.itemId);
    if (tryFireRestockAlarmOnStock(alarm, qty, now)) continue;
  }
}

async function refreshRestockAlarmsOnStockUpdate() {
  try {
    const res = await fetch("/api/stocks");
    if (!res.ok) return;
    await refreshRestockAlarmsFromStocks(await res.json());
  } catch {
    /* ticker will retry */
  }
}

function scheduleRestockAlarmCheck(alarm, now, { force = false } = {}) {
  if (!alarm?.id || alarmState.restockCheckInFlight.has(alarm.id)) return;
  const due = fireAt(alarm) <= now;
  const interval = due || alarm.awaitActual ? RESTOCK_CHECK_INTERVAL_DUE_SEC : RESTOCK_CHECK_INTERVAL_ARMED_SEC;
  const last = alarmState.restockCheckAt[alarm.id] || 0;
  if (!force && now - last < interval) return;
  alarmState.restockCheckAt[alarm.id] = now;
  alarmState.restockCheckInFlight.add(alarm.id);
  resolveDueRestockAlarm(alarm).finally(() => {
    alarmState.restockCheckInFlight.delete(alarm.id);
  });
}

/** Favorites dashboard "next safe leave" alarms use this index (not item prediction #). */
const FAVORITE_NEXT_WINDOW_INDEX = -1;

function isItemLeaveAlarm(alarm, country, itemId, types) {
  return (
    types.includes(alarm.type) &&
    alarm.country === country &&
    Number(alarm.itemId) === Number(itemId) &&
    Number(alarm.windowIndex) !== FAVORITE_NEXT_WINDOW_INDEX
  );
}

/**
 * Bind each alarm to the closest unused window by leave time, not prediction #.
 * Prediction indices shift when an earlier restock drops off; the leave time stays
 * with the same window.
 */
function assignLeaveAlarmsToWindows(alarms, windows) {
  const pairs = [];
  for (const alarm of alarms) {
    for (const w of windows || []) {
      if (w.leaveEarliest == null) continue;
      if (w.type && w.type !== alarm.type) continue;
      pairs.push({
        alarm,
        w,
        dist: Math.abs(Number(w.leaveEarliest) - Number(alarm.eventTs)),
      });
    }
  }
  pairs.sort((a, b) => a.dist - b.dist);
  const usedAlarms = new Set();
  const usedWindows = new Set();
  const assigned = new Map();
  for (const { alarm, w } of pairs) {
    if (usedAlarms.has(alarm) || usedWindows.has(w)) continue;
    usedAlarms.add(alarm);
    usedWindows.add(w);
    assigned.set(alarm, w);
  }
  return assigned;
}

function applyLeaveWindowToAlarm(alarm, w) {
  let changed = false;
  if (Number(alarm.windowIndex) !== Number(w.windowIndex)) {
    alarm.windowIndex = Number(w.windowIndex);
    changed = true;
  }
  if (alarm.eventTs !== w.leaveEarliest) {
    alarm.eventTs = w.leaveEarliest;
    changed = true;
  }
  return changed;
}

/** Follow a window's current index; never push a due alarm onto a later time. */
function rebindLeaveAlarm(alarm, w, now = Math.floor(Date.now() / 1000)) {
  if (!w || w.missed || w.leaveEarliest == null) return false;
  if (fireAt(alarm) <= now && w.leaveEarliest > alarm.eventTs) return false;
  return applyLeaveWindowToAlarm(alarm, w);
}

/**
 * Update leave alarm event times from latest predictions; drop missed/stale.
 * Follows the same physical window when prediction #s are reordered.
 * windows: [{ windowIndex, type, leaveEarliest, leaveLatest, missed }]
 */
function syncLeaveAlarmsForItem(country, itemId, windows) {
  if (!country || itemId == null) return;
  const types = ["leave_regular", "leave_safe"];
  const now = Math.floor(Date.now() / 1000);
  const tracked = alarmState.alarms.filter(
    (a) =>
      !a.firedAt &&
      !a.dismissedAt &&
      isItemLeaveAlarm(a, country, itemId, types)
  );
  const assigned = assignLeaveAlarmsToWindows(tracked, windows || []);
  let changed = false;
  const next = [];
  for (const alarm of alarmState.alarms) {
    if (
      alarm.firedAt ||
      alarm.dismissedAt ||
      !isItemLeaveAlarm(alarm, country, itemId, types)
    ) {
      next.push(alarm);
      continue;
    }
    const w = assigned.get(alarm);
    if (fireAt(alarm) <= now) {
      if (rebindLeaveAlarm(alarm, w, now)) changed = true;
      next.push(alarm);
      continue;
    }
    if (!w || w.missed || w.leaveEarliest == null) {
      changed = true;
      continue;
    }
    if (rebindLeaveAlarm(alarm, w, now)) changed = true;
    next.push(alarm);
  }
  if (changed) {
    alarmState.alarms = next;
    persistAlarms();
    renderAlarmsPanel();
    window.dispatchEvent(new CustomEvent("alarmschange"));
  }
}

/**
 * Update favorites "next safe leave" alarms from /api/safe-windows results.
 * windowsByKey: { "country:itemId": { available, safeWindow, reason } }
 */
function syncFavoriteNextLeaveAlarms(windowsByKey) {
  if (!windowsByKey || typeof windowsByKey !== "object") return;
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  const next = [];
  for (const alarm of alarmState.alarms) {
    if (
      alarm.firedAt ||
      alarm.dismissedAt ||
      alarm.type !== "leave_safe" ||
      Number(alarm.windowIndex) !== FAVORITE_NEXT_WINDOW_INDEX
    ) {
      next.push(alarm);
      continue;
    }
    const key = `${alarm.country}:${alarm.itemId}`;
    const data = windowsByKey[key];
    const sw = data?.available ? data.safeWindow : null;
    if (!sw || sw.leaveEarliest == null || sw.leaveLatest <= now) {
      changed = true;
      continue;
    }
    if (alarm.eventTs !== sw.leaveEarliest) {
      alarm.eventTs = sw.leaveEarliest;
      changed = true;
    }
    next.push(alarm);
  }
  if (changed) {
    alarmState.alarms = next;
    persistAlarms();
    renderAlarmsPanel();
    window.dispatchEvent(new CustomEvent("alarmschange"));
  }
}

function itemAlarmKey(country, itemId) {
  return `${country}:${itemId}`;
}

function isAutoSafeAlarmsEnabled(country, itemId) {
  return loadAlarmPrefs().autoSafeAlarms[itemAlarmKey(country, itemId)] === true;
}

function setAutoSafeAlarmsEnabled(country, itemId, enabled) {
  const prefs = loadAlarmPrefs();
  const map = { ...prefs.autoSafeAlarms };
  const key = itemAlarmKey(country, itemId);
  if (enabled) map[key] = true;
  else delete map[key];
  savePrefs({ autoSafeAlarms: map });
}

/**
 * Sync auto leave_safe alarms for an item.
 * windows: [{ windowIndex, leaveEarliest, leaveLatest, missed }]
 * Dismissed/fired records are kept while their window is still relevant so they
 * are not recreated; obsolete dismissed records are hard-deleted.
 */
async function syncAutoSafeAlarms(country, itemId, itemName, windows) {
  if (!isAutoSafeAlarmsEnabled(country, itemId)) {
    const before = alarmState.alarms.length;
    alarmState.alarms = alarmState.alarms.filter(
      (a) =>
        !(
          a.auto &&
          a.type === "leave_safe" &&
          a.country === country &&
          Number(a.itemId) === Number(itemId)
        )
    );
    if (alarmState.alarms.length !== before) {
      persistAlarms();
      renderAlarmsPanel();
      window.dispatchEvent(new CustomEvent("alarmschange"));
    }
    return;
  }

  await ensureNotificationPermission();
  const records = alarmState.alarms.filter(
    (a) =>
      !a.firedAt &&
      !a.dismissedAt &&
      isItemLeaveAlarm(a, country, itemId, ["leave_safe"])
  );
  const assigned = assignLeaveAlarmsToWindows(records, windows || []);
  let changed = false;
  const now = Math.floor(Date.now() / 1000);
  for (const [alarm, w] of assigned) {
    if (rebindLeaveAlarm(alarm, w, now)) changed = true;
  }

  const desired = new Set();
  const offsetSec = getLeaveAlarmOffsetSec();

  for (const w of windows || []) {
    if (w.missed || w.leaveEarliest == null) continue;
    const fire = w.leaveEarliest - offsetSec;
    if (fire <= Math.floor(Date.now() / 1000)) continue;
    if (!isWithinAutoAlarmHours(fire)) continue;
    desired.add(Number(w.windowIndex));
    let alarm = findLeaveAlarmRecord("leave_safe", country, itemId, w.windowIndex);
    if (!alarm) {
      alarmState.alarms.push({
        id: newAlarmId(),
        type: "leave_safe",
        country,
        itemId: Number(itemId),
        itemName: itemName || null,
        windowIndex: Number(w.windowIndex),
        eventTs: w.leaveEarliest,
        offsetSec,
        auto: true,
        firedAt: null,
        dismissedAt: null,
      });
      changed = true;
    } else if (alarm.dismissedAt || alarm.firedAt) {
      // Keep record so we do not recreate this window's alarm.
      if (applyLeaveWindowToAlarm(alarm, w)) changed = true;
    } else {
      if (applyLeaveWindowToAlarm(alarm, w)) changed = true;
      if (!alarm.auto) {
        // Keep manual alarm; mark as covering this window
        desired.add(Number(w.windowIndex));
      }
    }
  }

  const kept = [];
  for (const alarm of alarmState.alarms) {
    const isAutoSafeForItem =
      alarm.auto &&
      alarm.type === "leave_safe" &&
      alarm.country === country &&
      Number(alarm.itemId) === Number(itemId);
    if (isAutoSafeForItem && !desired.has(Number(alarm.windowIndex))) {
      // Fired alarms stay visible until the user dismisses them.
      if (alarm.firedAt && !alarm.dismissedAt) {
        kept.push(alarm);
        continue;
      }
      // Drop obsolete pending or already-dismissed auto alarms.
      changed = true;
      continue;
    }
    kept.push(alarm);
  }
  if (changed) {
    alarmState.alarms = kept;
    persistAlarms();
    renderAlarmsPanel();
    window.dispatchEvent(new CustomEvent("alarmschange"));
  }
}

async function syncArrivalFromTravel(travel) {
  const prefs = loadAlarmPrefs();
  const existing = findArrivalAlarmRecord();
  const arriveTs = travel?.arriveTs;
  const inFlight = arriveTs != null && arriveTs > Math.floor(Date.now() / 1000);

  if (!inFlight) {
    if (existing?.auto) {
      removeAlarmById(existing.id);
    }
    return;
  }

  if (existing && !existing.auto) {
    if (existing.dismissedAt || existing.firedAt) return;
    if (existing.eventTs !== arriveTs) {
      existing.eventTs = arriveTs;
      existing.country = travel.country ?? existing.country;
      existing.destination = travel.destination ?? existing.destination;
      persistAlarms();
      renderAlarmsPanel();
      window.dispatchEvent(new CustomEvent("alarmschange"));
    }
    return;
  }

  if (!prefs.autoArrivalAlarm) {
    if (existing?.auto) removeAlarmById(existing.id);
    return;
  }

  const offsetSec = getArrivalAlarmOffsetSec();
  const fire = arriveTs - offsetSec;
  if (!isWithinAutoAlarmHours(fire) || fire <= Math.floor(Date.now() / 1000)) {
    // Keep dismissed/fired records while still in flight so sync does not recreate.
    if (existing?.auto && !existing.dismissedAt && !existing.firedAt) {
      removeAlarmById(existing.id);
    }
    return;
  }

  await ensureNotificationPermission();
  if (existing?.auto) {
    // Dismissed or fired for this flight: keep the record, never recreate.
    if (existing.dismissedAt || existing.firedAt) {
      if (existing.eventTs !== arriveTs) {
        existing.eventTs = arriveTs;
        existing.country = travel.country ?? existing.country;
        existing.destination = travel.destination ?? existing.destination;
        persistAlarms();
      }
      return;
    }
    existing.eventTs = arriveTs;
    existing.offsetSec = existing.offsetSec ?? offsetSec;
    existing.country = travel.country ?? null;
    existing.destination = travel.destination ?? null;
    persistAlarms();
    renderAlarmsPanel();
    window.dispatchEvent(new CustomEvent("alarmschange"));
    return;
  }

  upsertAlarm({
    id: newAlarmId(),
    type: "arrival",
    country: travel.country ?? null,
    itemId: null,
    itemName: null,
    destination: travel.destination ?? null,
    windowIndex: null,
    eventTs: arriveTs,
    offsetSec,
    auto: true,
    firedAt: null,
    dismissedAt: null,
  });
}

function alarmTypeLabel(type) {
  if (type === "leave_safe") return "Safe leave";
  if (type === "leave_regular") return "Leave";
  if (type === "restock") return "Restock";
  return "Arrival";
}

function formatCountdown(sec) {
  if (sec <= 0) return "now";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function notificationBannerHtml() {
  if (typeof Notification === "undefined") {
    return `<p class="alarms-banner">Browser notifications are not supported.</p>`;
  }
  if (Notification.permission === "denied") {
    return `<p class="alarms-banner">Notifications blocked — alarms still beep when this tab is open.</p>`;
  }
  return "";
}

function alarmWhenText(alarm, now = Math.floor(Date.now() / 1000)) {
  const eventLabel = typeof fmtTimeShort === "function" ? fmtTimeShort(alarm.eventTs) : "";
  if (alarm.firedAt) return `${eventLabel} · fired — dismiss to clear`;
  if (alarm.type === "restock" && alarm.awaitActual) {
    return `${eventLabel} · waiting for restock`;
  }
  return `${eventLabel} · fires in ${formatCountdown(fireAt(alarm) - now)}`;
}

function syncAlarmsToggleLabel() {
  const toggle = document.getElementById("alarms-toggle");
  if (!toggle) return;
  const n = activeAlarms().length;
  toggle.textContent = n ? `Alarms (${n})` : "Alarms";
}

/** Update countdown labels in place so offset inputs keep focus. */
function updateAlarmsCountdowns() {
  const list = document.getElementById("alarms-list");
  if (!list || !isAlarmsOpen()) {
    syncAlarmsToggleLabel();
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const alarms = activeAlarms();
  const ids = new Set(alarms.map((a) => a.id));
  // Structure changed (alarm added/removed/fired) — full rebuild needed.
  const rows = [...list.querySelectorAll(".alarms-item[data-alarm-id]")];
  if (
    list.querySelector(".alarms-empty") ||
    rows.length !== alarms.length ||
    rows.some((row) => !ids.has(row.dataset.alarmId))
  ) {
    renderAlarmsPanel();
    return;
  }
  for (const alarm of alarms) {
    const row = list.querySelector(`.alarms-item[data-alarm-id="${alarm.id}"]`);
    if (!row) continue;
    row.classList.toggle("alarms-item-fired", Boolean(alarm.firedAt));
    const when = row.querySelector(".alarms-item-when");
    if (when) when.textContent = alarmWhenText(alarm, now);
  }
  syncAlarmsToggleLabel();
}

function renderAlarmsPanel() {
  const list = document.getElementById("alarms-list");
  if (!list) return;
  const panel = document.getElementById("alarms-panel");
  if (panel) {
    const banner = panel.querySelector(".alarms-banner-slot");
    if (banner) banner.innerHTML = notificationBannerHtml();
  }

  const alarms = activeAlarms();
  syncAlarmsToggleLabel();

  const activeEl = document.activeElement;
  const focusedAlarmId =
    activeEl?.classList?.contains("alarms-offset-input") && list.contains(activeEl)
      ? activeEl.dataset.alarmId
      : null;
  const focusedValue = focusedAlarmId != null ? activeEl.value : null;
  const selectionStart = focusedAlarmId != null ? activeEl.selectionStart : null;
  const selectionEnd = focusedAlarmId != null ? activeEl.selectionEnd : null;

  if (!alarms.length) {
    list.innerHTML = `<li class="alarms-empty">No alarms set.</li>`;
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  list.innerHTML = alarms
    .map((a) => {
      const meta = state.countries?.[a.country];
      const flag = meta?.flag ? `${meta.flag} ` : "";
      const place =
        a.type === "arrival"
          ? a.destination || meta?.name || a.country || "Travel"
          : `${flag}${a.itemName || a.itemId}${
              meta ? ` · ${meta.name}` : a.country ? ` · ${a.country}` : ""
            }${a.type === "restock" ? " · #1" : ""}`;
      const offsetMin = Math.round((a.offsetSec / 60) * 10) / 10;
      const auto = a.auto ? `<span class="alarms-auto-tag">auto</span>` : "";
      const firedCls = a.firedAt ? " alarms-item-fired" : "";
      const offsetHtml = a.firedAt
        ? ""
        : `<label class="alarms-offset-field" title="Minutes before event">
          <span>Offset</span>
          <input type="number" class="alarms-offset-input" min="0" step="0.5" value="${offsetMin}" data-alarm-id="${a.id}" />
          <span>min</span>
        </label>`;
      return `<li class="alarms-item${firedCls}" data-alarm-id="${a.id}">
        <div class="alarms-item-main">
          <span class="alarms-item-type">${alarmTypeLabel(a.type)}${auto}</span>
          <span class="alarms-item-place">${place}</span>
          <span class="alarms-item-when">${alarmWhenText(a, now)}</span>
        </div>
        ${offsetHtml}
        <button type="button" class="alarms-dismiss-btn" data-alarm-id="${a.id}" title="Dismiss alarm">Dismiss</button>
      </li>`;
    })
    .join("");

  if (focusedAlarmId) {
    const input = list.querySelector(
      `.alarms-offset-input[data-alarm-id="${focusedAlarmId}"]`
    );
    if (input) {
      input.value = focusedValue;
      input.focus();
      if (selectionStart != null && selectionEnd != null) {
        try {
          input.setSelectionRange(selectionStart, selectionEnd);
        } catch {
          /* number inputs may not support selection in all browsers */
        }
      }
    }
  }
}

function isAlarmsOpen() {
  return localStorage.getItem(ALARMS_OPEN_KEY) === "1";
}

function setAlarmsOpen(open) {
  localStorage.setItem(ALARMS_OPEN_KEY, open ? "1" : "0");
  const panel = document.getElementById("alarms-panel");
  const toggle = document.getElementById("alarms-toggle");
  if (panel) panel.classList.toggle("hidden", !open);
  if (toggle) {
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.classList.toggle("active", open);
  }
}

function injectAlarmsPanel() {
  const header = document.querySelector("header");
  const headerMeta = document.querySelector(".header-meta");
  if (!header || !headerMeta || document.getElementById("alarms-toggle")) return;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = "alarms-toggle";
  toggle.className = "settings-toggle alarms-toggle";
  toggle.setAttribute("aria-controls", "alarms-panel");
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = "Alarms";

  const settingsToggle = headerMeta.querySelector("#settings-toggle");
  if (settingsToggle) {
    settingsToggle.insertAdjacentElement("afterend", toggle);
  } else {
    const auth = headerMeta.querySelector("#auth");
    if (auth) auth.insertAdjacentElement("afterend", toggle);
    else headerMeta.appendChild(toggle);
  }

  const panel = document.createElement("div");
  panel.id = "alarms-panel";
  panel.className = "alarms-panel hidden";
  panel.innerHTML = `
    <div class="alarms-panel-header">
      <span class="settings-group-title">Alarms</span>
      <div class="alarms-banner-slot"></div>
    </div>
    <ul id="alarms-list" class="alarms-list"></ul>
  `;
  header.appendChild(panel);

  toggle.addEventListener("click", () => {
    setAlarmsOpen(!isAlarmsOpen());
  });

  panel.addEventListener("click", (e) => {
    const dismiss = e.target.closest(".alarms-dismiss-btn");
    if (dismiss) {
      dismissAlarmById(dismiss.dataset.alarmId);
      return;
    }
  });

  panel.addEventListener("change", (e) => {
    const input = e.target.closest(".alarms-offset-input");
    if (!input) return;
    const alarm = alarmState.alarms.find((a) => a.id === input.dataset.alarmId);
    if (!alarm) return;
    const min = Number(input.value);
    if (!Number.isFinite(min) || min < 0) {
      input.value = Math.round((alarm.offsetSec / 60) * 10) / 10;
      return;
    }
    alarm.offsetSec = Math.round(min * 60);
    persistAlarms();
    const when = panel.querySelector(
      `.alarms-item[data-alarm-id="${alarm.id}"] .alarms-item-when`
    );
    if (when) when.textContent = alarmWhenText(alarm);
  });

  setAlarmsOpen(isAlarmsOpen());
  renderAlarmsPanel();
}

function updateAutoAlarmHoursVisibility() {
  const autoOn = document.getElementById("auto-arrival-alarm")?.checked === true;
  const restrictOn = document.getElementById("auto-alarm-restrict-hours")?.checked === true;
  document.getElementById("auto-alarm-restrict-hours-label")?.classList.toggle("hidden", !autoOn);
  document
    .getElementById("auto-alarm-allowed-field")
    ?.classList.toggle("hidden", !autoOn || !restrictOn);
}

function injectAlarmSettings() {
  const settingsPanel = document.getElementById("settings-panel");
  if (!settingsPanel || document.getElementById("alarm-settings-group")) return;

  const prefs = loadAlarmPrefs();
  const group = document.createElement("div");
  group.id = "alarm-settings-group";
  group.className = "settings-group alarm-settings";
  group.innerHTML = `
    <span class="settings-group-title">Alarms</span>
    <div class="settings-group-controls alarm-settings-controls">
      <label class="alarm-setting-field" title="Default minutes before leave-window start">
        <span>Leave offset</span>
        <input id="leave-alarm-offset" type="number" min="0" step="0.5" value="${prefs.leaveAlarmOffsetMin}" />
        <span>min</span>
      </label>
      <label class="alarm-setting-field" title="Default minutes before arrival">
        <span>Arrival offset</span>
        <input id="arrival-alarm-offset" type="number" min="0" step="0.5" value="${prefs.arrivalAlarmOffsetMin}" />
        <span>min</span>
      </label>
      <label class="checkbox" for="auto-arrival-alarm">
        <input id="auto-arrival-alarm" type="checkbox" ${prefs.autoArrivalAlarm ? "checked" : ""} />
        Auto-alarm arrival when travelling
      </label>
      <label
        id="auto-alarm-restrict-hours-label"
        class="checkbox${prefs.autoArrivalAlarm ? "" : " hidden"}"
        for="auto-alarm-restrict-hours"
      >
        <input
          id="auto-alarm-restrict-hours"
          type="checkbox"
          ${prefs.autoAlarmRestrictHours ? "checked" : ""}
        />
        Restrict hours
      </label>
      <label
        id="auto-alarm-allowed-field"
        class="alarm-setting-field${prefs.autoArrivalAlarm && prefs.autoAlarmRestrictHours ? "" : " hidden"}"
        title="Auto alarms only created if fire time is in this range"
      >
        <span>Auto allowed</span>
        <input id="auto-alarm-start" type="time" value="${prefs.autoAlarmAllowedStart}" />
        <span>–</span>
        <input id="auto-alarm-end" type="time" value="${prefs.autoAlarmAllowedEnd}" />
      </label>
    </div>
  `;
  settingsPanel.appendChild(group);

  if (alarmState.settingsBound) return;
  alarmState.settingsBound = true;

  settingsPanel.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.id === "leave-alarm-offset") {
      const v = Number(t.value);
      if (!Number.isFinite(v) || v < 0) return;
      savePrefs({ leaveAlarmOffsetMin: v });
      return;
    }
    if (t.id === "arrival-alarm-offset") {
      const v = Number(t.value);
      if (!Number.isFinite(v) || v < 0) return;
      savePrefs({ arrivalAlarmOffsetMin: v });
      return;
    }
    if (t.id === "auto-arrival-alarm") {
      savePrefs({ autoArrivalAlarm: t.checked });
      updateAutoAlarmHoursVisibility();
      if (t.checked) await ensureNotificationPermission();
      refreshTravelForAlarms();
      return;
    }
    if (t.id === "auto-alarm-restrict-hours") {
      savePrefs({ autoAlarmRestrictHours: t.checked });
      updateAutoAlarmHoursVisibility();
      refreshTravelForAlarms();
      window.dispatchEvent(new CustomEvent("alarmautosettingchange"));
      return;
    }
    if (t.id === "auto-alarm-start" || t.id === "auto-alarm-end") {
      const start = parseHhMm(document.getElementById("auto-alarm-start")?.value);
      const end = parseHhMm(document.getElementById("auto-alarm-end")?.value);
      if (!start || !end) return;
      savePrefs({ autoAlarmAllowedStart: start, autoAlarmAllowedEnd: end });
      window.dispatchEvent(new CustomEvent("alarmautosettingchange"));
    }
  });
}

function tickAlarms() {
  const now = Math.floor(Date.now() / 1000);
  for (const alarm of alarmState.alarms) {
    if (alarm.firedAt || alarm.dismissedAt) continue;
    if (alarm.type === "restock") {
      // Never timer-fire: confirm actual restock, else reschedule when due.
      scheduleRestockAlarmCheck(alarm, now);
      continue;
    }
    if (fireAt(alarm) <= now) fireAlarm(alarm);
  }
  updateAlarmsCountdowns();
}

async function refreshTravelForAlarms() {
  const apiKey = typeof getStoredApiKey === "function" ? getStoredApiKey() : null;
  if (!apiKey) {
    await syncArrivalFromTravel(null);
    return;
  }
  try {
    const res = await fetch("/api/travel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "travel failed");
    const travel =
      body.arriveTs != null
        ? {
            arriveTs: body.arriveTs,
            country: body.country ?? null,
            destination: body.destination ?? null,
          }
        : null;
    await syncArrivalFromTravel(travel);
  } catch {
    /* keep existing arrival alarm until next successful poll */
  }
}

function startAlarmTicker() {
  if (alarmState.tickerId) return;
  alarmState.tickerId = setInterval(tickAlarms, 1000);
  tickAlarms();
}

function startTravelPollForAlarms() {
  if (alarmState.travelPollId) return;
  const poll = () => {
    if (loadAlarmPrefs().autoArrivalAlarm || findArrivalAlarm()) {
      refreshTravelForAlarms();
    }
  };
  const start = () => {
    poll();
    alarmState.travelPollId = setInterval(poll, 60_000);
  };
  if (window.authReady && typeof window.authReady.then === "function") {
    window.authReady.then(start);
  } else {
    start();
  }
}

function alarmButtonHtml({ armed, attrs }) {
  const cls = armed ? "alarm-set-btn armed" : "alarm-set-btn";
  const title = armed ? "Remove alarm" : "Set alarm";
  const label = armed ? "🔔" : "🔕";
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${k}="${String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)
    .join(" ");
  return `<button type="button" class="${cls}" title="${title}" aria-label="${title}" ${attrStr}>${label}</button>`;
}

function initAlarms() {
  alarmState.alarms = loadAlarms();
  injectAlarmsPanel();
  injectAlarmSettings();
  startAlarmTicker();
  startTravelPollForAlarms();

  window.addEventListener("timeformatchange", () => renderAlarmsPanel());
  window.addEventListener("stocksupdated", () => {
    void refreshRestockAlarmsOnStockUpdate();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    // Settings panel is injected by shared.js on DOMContentLoaded; run after.
    queueMicrotask(initAlarms);
  });
} else {
  queueMicrotask(initAlarms);
}
