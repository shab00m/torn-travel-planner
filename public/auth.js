// Torn API key login. The key is kept in localStorage and only ever sent
// to our own backend, which relays it to the Torn API without storing it.
const KEY_STORAGE = "tornApiKey";

const authEl = {
  form: document.getElementById("login-form"),
  input: document.getElementById("api-key"),
  playerInfo: document.getElementById("player-info"),
};

const TRAVEL_TYPE_ICONS = {
  Standard: "🎫",
  Airstrip: "🛩️",
  Private: "✈️",
  Business: "💼",
};

function showLoggedIn(player) {
  const icon = TRAVEL_TYPE_ICONS[player.travelType] ?? "🎫";
  const capacityTitle =
    `Base ${player.baseCapacity} (${player.travelType})` +
    (player.capacityPerks.length ? `\n${player.capacityPerks.join("\n")}` : "");
  authEl.playerInfo.innerHTML = `
    <span class="player-name">${player.name} <span class="player-id">[${player.playerId}]</span></span>
    <span class="player-stat" title="Travel type">${icon} ${player.travelType}</span>
    <span class="player-stat" title="${capacityTitle}">🧳 ${player.capacity} slots</span>
    <button id="logout-btn" class="logout-btn" title="Log out">Log out</button>
  `;
  authEl.playerInfo.classList.remove("hidden");
  authEl.form.classList.add("hidden");
  document.getElementById("logout-btn").addEventListener("click", logout);
}

function showLoggedOut() {
  authEl.playerInfo.classList.add("hidden");
  authEl.playerInfo.innerHTML = "";
  authEl.form.classList.remove("hidden");
}

function logout() {
  localStorage.removeItem(KEY_STORAGE);
  state.travelType = "Standard";
  showLoggedOut();
  if (typeof redrawPrediction === "function" && state.item) redrawPrediction();
}

async function login(apiKey) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  localStorage.setItem(KEY_STORAGE, apiKey);
  state.travelType = body.travelType ?? "Standard";
  showLoggedIn(body);
  if (typeof redrawPrediction === "function" && state.item) redrawPrediction();
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

// Auto-login with a previously saved key.
(async () => {
  const saved = localStorage.getItem(KEY_STORAGE);
  if (!saved) return;
  try {
    await login(saved);
  } catch {
    logout();
  }
})();
