// Torn API key login. The key is kept in localStorage and only ever sent
// to our own backend, which relays it to the Torn API without storing it.
const KEY_STORAGE = "tornApiKey";

const authEl = {
  form: document.getElementById("login-form"),
  input: document.getElementById("api-key"),
  playerInfo: document.getElementById("player-info"),
};

const guestEl = {
  wrap: document.getElementById("guest-travel"),
  travelType: document.getElementById("guest-travel-type"),
  capacity: document.getElementById("guest-capacity"),
};

const TRAVEL_TYPE_ICONS = {
  Standard: "🎫",
  Airstrip: "🛩️",
  Private: "✈️",
  Business: "💼",
};

/** @type {{ playerId: number, name: string, isAdmin: boolean } | null} */
let currentUser = null;

function getStoredApiKey() {
  return localStorage.getItem(KEY_STORAGE);
}

function getCurrentUser() {
  return currentUser;
}

function setGuestTravelVisible(visible) {
  if (guestEl.wrap) guestEl.wrap.classList.toggle("hidden", !visible);
}

function syncGuestTravelControls() {
  if (!guestEl.travelType || !guestEl.capacity) return;
  guestEl.travelType.value = state.travelType;
  guestEl.capacity.value = String(state.travelCapacity);
}

function onGuestTravelChange() {
  const type = guestEl.travelType.value;
  if (!TRAVEL_TYPES.includes(type)) return;

  const cap = Number.parseInt(guestEl.capacity.value, 10);
  if (!Number.isInteger(cap) || cap < 1) {
    guestEl.capacity.value = String(state.travelCapacity);
    return;
  }

  state.travelType = type;
  state.travelCapacity = cap;
  savePrefs({ travelType: type, travelCapacity: cap });
  window.dispatchEvent(new CustomEvent("travelsettingschange"));
  if (typeof refreshTravelStatus === "function" && state.item) refreshTravelStatus();
  if (typeof loadCurrentStock === "function" && state.item) loadCurrentStock();
}

function initGuestTravelControls() {
  if (!guestEl.travelType || guestEl.travelType.dataset.bound) return;
  guestEl.travelType.dataset.bound = "1";
  guestEl.travelType.addEventListener("change", onGuestTravelChange);
  guestEl.capacity.addEventListener("change", onGuestTravelChange);
}

function showLoggedIn(player) {
  const icon = TRAVEL_TYPE_ICONS[player.travelType] ?? "🎫";
  const capacityTitle =
    `Base ${player.baseCapacity} (${player.travelType})` +
    (player.capacityPerks.length ? `\n${player.capacityPerks.join("\n")}` : "");
  const usersLink = player.isAdmin
    ? `<a href="/users" class="users-link">Users</a>`
    : "";
  authEl.playerInfo.innerHTML = `
    <span class="player-name">${player.name} <span class="player-id">[${player.playerId}]</span></span>
    <span class="player-stat" title="Travel type">${icon} ${player.travelType}</span>
    <span class="player-stat" title="${capacityTitle}">🧳 ${player.capacity} slots</span>
    ${usersLink}
    <button id="logout-btn" class="logout-btn" title="Log out">Log out</button>
  `;
  authEl.playerInfo.classList.remove("hidden");
  authEl.form.classList.add("hidden");
  setGuestTravelVisible(false);
  document.getElementById("logout-btn").addEventListener("click", logout);
}

function showLoggedOut() {
  currentUser = null;
  authEl.playerInfo.classList.add("hidden");
  authEl.playerInfo.innerHTML = "";
  authEl.form.classList.remove("hidden");
  setGuestTravelVisible(true);
  syncGuestTravelControls();
}

function logout() {
  localStorage.removeItem(KEY_STORAGE);
  currentUser = null;
  applyTravelSettings(loadPrefs());
  showLoggedOut();
  window.dispatchEvent(new CustomEvent("travelsettingschange"));
  if (typeof refreshTravelStatus === "function" && state.item) refreshTravelStatus();
  if (typeof loadCurrentStock === "function" && state.item) loadCurrentStock();
}

function isInvalidKeyError(err) {
  return /Torn API error (1|2):/.test(String(err?.message ?? ""));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function autoLogin() {
  const saved = localStorage.getItem(KEY_STORAGE);
  if (!saved) return;
  const retryDelays = [0, 2000, 5000];
  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    if (retryDelays[attempt] > 0) await sleep(retryDelays[attempt]);
    if (localStorage.getItem(KEY_STORAGE) !== saved) return;
    try {
      await login(saved);
      return;
    } catch (err) {
      if (isInvalidKeyError(err) || err?.statusCode === 403) {
        logout();
        return;
      }
    }
  }
  showLoggedOut();
}

async function login(apiKey) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.statusCode = res.status;
    if (res.status === 403) localStorage.removeItem(KEY_STORAGE);
    throw err;
  }
  localStorage.setItem(KEY_STORAGE, apiKey);
  currentUser = {
    playerId: body.playerId,
    name: body.name,
    isAdmin: Boolean(body.isAdmin),
  };
  state.travelType = body.travelType ?? "Standard";
  state.travelCapacity = body.capacity ?? BASE_TRAVEL_CAPACITY[state.travelType];
  showLoggedIn(body);
  window.dispatchEvent(new CustomEvent("travelsettingschange"));
  if (typeof refreshTravelStatus === "function" && state.item) refreshTravelStatus();
  if (typeof loadCurrentStock === "function" && state.item) loadCurrentStock();
}

authEl.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const apiKey = authEl.input.value.trim();
  if (!apiKey) return;
  const button = authEl.form.querySelector("button");
  button.disabled = true;
  button.textContent = "…";
  try {
    await login(apiKey);
    authEl.input.value = "";
  } catch (err) {
    alert(`Login failed: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Log in";
  }
});

initGuestTravelControls();
syncGuestTravelControls();

window.getStoredApiKey = getStoredApiKey;
window.getCurrentUser = getCurrentUser;
window.authReady = autoLogin();
