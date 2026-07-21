// Client-side alarms: localStorage persistence, header panel, Notification + beep.
const ALARMS_KEY = "plannerAlarms";
const ALARMS_OPEN_KEY = "plannerAlarmsOpen";
const ALARM_TYPES = ["leave_regular", "leave_safe", "arrival"];

const alarmState = {
  alarms: [],
  tickerId: null,
  travelPollId: null,
  settingsBound: false,
};

function defaultAlarmPrefs() {
  return {
    leaveAlarmOffsetMin: 1,
    arrivalAlarmOffsetMin: 1,
    autoArrivalAlarm: false,
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

function activeAlarms() {
  const now = Math.floor(Date.now() / 1000);
  return alarmState.alarms
    .filter((a) => !a.firedAt && fireAt(a) > now - 2)
    .sort((a, b) => fireAt(a) - fireAt(b));
}

function newAlarmId() {
  return crypto.randomUUID();
}

function findLeaveAlarm(type, country, itemId, windowIndex) {
  return alarmState.alarms.find(
    (a) =>
      !a.firedAt &&
      a.type === type &&
      a.country === country &&
      Number(a.itemId) === Number(itemId) &&
      Number(a.windowIndex) === Number(windowIndex)
  );
}

function findArrivalAlarm() {
  return alarmState.alarms.find((a) => !a.firedAt && a.type === "arrival");
}

function hasLeaveAlarm(type, country, itemId, windowIndex) {
  return Boolean(findLeaveAlarm(type, country, itemId, windowIndex));
}

function hasArrivalAlarm() {
  return Boolean(findArrivalAlarm());
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

function playAlarmBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    osc.stop(ctx.currentTime + 0.5);
    setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch {
    /* ignore */
  }
}

function alarmTitle(alarm) {
  if (alarm.type === "arrival") {
    const dest = alarm.destination || alarm.country || "destination";
    return `Arriving: ${dest}`;
  }
  const kind = alarm.type === "leave_safe" ? "Safe leave" : "Leave";
  const item = alarm.itemName || `item ${alarm.itemId}`;
  return `${kind}: ${item}`;
}

function alarmBody(alarm) {
  const when = typeof fmtTimeShort === "function" ? fmtTimeShort(alarm.eventTs) : String(alarm.eventTs);
  const offsetMin = Math.round(alarm.offsetSec / 60);
  if (alarm.type === "arrival") {
    return `Landing at ${when} (${offsetMin}m offset)`;
  }
  return `Leave window starts ${when} (${offsetMin}m offset)`;
}

function fireAlarm(alarm) {
  alarm.firedAt = Math.floor(Date.now() / 1000);
  persistAlarms();
  playAlarmBeep();
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      new Notification(alarmTitle(alarm), { body: alarmBody(alarm), tag: alarm.id });
    } catch {
      /* ignore */
    }
  }
  renderAlarmsPanel();
  window.dispatchEvent(new CustomEvent("alarmschange"));
}

function removeAlarmById(id) {
  const before = alarmState.alarms.length;
  alarmState.alarms = alarmState.alarms.filter((a) => a.id !== id);
  if (alarmState.alarms.length !== before) {
    persistAlarms();
    renderAlarmsPanel();
    window.dispatchEvent(new CustomEvent("alarmschange"));
  }
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
  if (!ALARM_TYPES.includes(type) || type === "arrival") return;
  if (leaveEarliest == null || country == null || itemId == null || windowIndex == null) return;
  const existing = findLeaveAlarm(type, country, itemId, windowIndex);
  if (existing) {
    removeAlarmById(existing.id);
    return;
  }
  await ensureNotificationPermission();
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
  });
}

/**
 * Update leave alarm event times from latest predictions; drop missed/stale.
 * windows: [{ windowIndex, type, leaveEarliest, leaveLatest, missed }]
 */
function syncLeaveAlarmsForItem(country, itemId, windows) {
  if (!country || itemId == null) return;
  const byKey = new Map(
    (windows || []).map((w) => [`${w.type}:${w.windowIndex}`, w])
  );
  let changed = false;
  const next = [];
  for (const alarm of alarmState.alarms) {
    if (
      alarm.firedAt ||
      (alarm.type !== "leave_regular" && alarm.type !== "leave_safe") ||
      alarm.country !== country ||
      Number(alarm.itemId) !== Number(itemId)
    ) {
      next.push(alarm);
      continue;
    }
    const w = byKey.get(`${alarm.type}:${alarm.windowIndex}`);
    if (!w || w.missed || w.leaveEarliest == null) {
      changed = true;
      continue;
    }
    if (alarm.eventTs !== w.leaveEarliest) {
      alarm.eventTs = w.leaveEarliest;
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
  const desired = new Set();
  let changed = false;
  const offsetSec = getLeaveAlarmOffsetSec();

  for (const w of windows || []) {
    if (w.missed || w.leaveEarliest == null) continue;
    const fire = w.leaveEarliest - offsetSec;
    if (fire <= Math.floor(Date.now() / 1000)) continue;
    if (!isWithinAutoAlarmHours(fire)) continue;
    desired.add(Number(w.windowIndex));
    let alarm = findLeaveAlarm("leave_safe", country, itemId, w.windowIndex);
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
      });
      changed = true;
    } else {
      if (alarm.eventTs !== w.leaveEarliest) {
        alarm.eventTs = w.leaveEarliest;
        changed = true;
      }
      if (!alarm.auto) {
        // Keep manual alarm; mark as covering this window
        desired.add(Number(w.windowIndex));
      }
    }
  }

  const kept = [];
  for (const alarm of alarmState.alarms) {
    if (
      alarm.auto &&
      alarm.type === "leave_safe" &&
      alarm.country === country &&
      Number(alarm.itemId) === Number(itemId) &&
      !desired.has(Number(alarm.windowIndex))
    ) {
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
  const existing = findArrivalAlarm();
  const arriveTs = travel?.arriveTs;
  const inFlight = arriveTs != null && arriveTs > Math.floor(Date.now() / 1000);

  if (!inFlight) {
    if (existing?.auto) {
      removeAlarmById(existing.id);
    }
    return;
  }

  if (existing && !existing.auto) {
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
    if (existing?.auto) removeAlarmById(existing.id);
    return;
  }

  await ensureNotificationPermission();
  if (existing?.auto) {
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
  });
}

function alarmTypeLabel(type) {
  if (type === "leave_safe") return "Safe leave";
  if (type === "leave_regular") return "Leave";
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
    const when = list.querySelector(
      `.alarms-item[data-alarm-id="${alarm.id}"] .alarms-item-when`
    );
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
          : `${flag}${a.itemName || a.itemId}${meta ? ` · ${meta.name}` : a.country ? ` · ${a.country}` : ""}`;
      const offsetMin = Math.round((a.offsetSec / 60) * 10) / 10;
      const auto = a.auto ? `<span class="alarms-auto-tag">auto</span>` : "";
      return `<li class="alarms-item" data-alarm-id="${a.id}">
        <div class="alarms-item-main">
          <span class="alarms-item-type">${alarmTypeLabel(a.type)}${auto}</span>
          <span class="alarms-item-place">${place}</span>
          <span class="alarms-item-when">${alarmWhenText(a, now)}</span>
        </div>
        <label class="alarms-offset-field" title="Minutes before event">
          <span>Offset</span>
          <input type="number" class="alarms-offset-input" min="0" step="0.5" value="${offsetMin}" data-alarm-id="${a.id}" />
          <span>min</span>
        </label>
        <button type="button" class="alarms-dismiss-btn" data-alarm-id="${a.id}" title="Dismiss">✕</button>
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
      removeAlarmById(dismiss.dataset.alarmId);
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
      <label class="alarm-setting-field" title="Auto alarms only created if fire time is in this range">
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
      if (t.checked) await ensureNotificationPermission();
      refreshTravelForAlarms();
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
    if (alarm.firedAt) continue;
    if (fireAt(alarm) <= now) fireAlarm(alarm);
  }
  // Prune old fired alarms (keep list clean)
  const cutoff = now - 3600;
  const pruned = alarmState.alarms.filter((a) => !a.firedAt || a.firedAt > cutoff);
  if (pruned.length !== alarmState.alarms.length) {
    alarmState.alarms = pruned;
    persistAlarms();
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
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    // Settings panel is injected by shared.js on DOMContentLoaded; run after.
    queueMicrotask(initAlarms);
  });
} else {
  queueMicrotask(initAlarms);
}
