function apiKeyHeaders() {
  const apiKey = getStoredApiKey();
  if (!apiKey) throw new Error("Not logged in");
  return {
    "Content-Type": "application/json",
    "X-Api-Key": apiKey,
  };
}

function formatTs(ts) {
  if (ts == null) return "—";
  return fmtTime(ts);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function fetchUsers() {
  const res = await fetch("/api/users", { headers: apiKeyHeaders() });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.users;
}

function renderUsers(users) {
  const tbody = document.getElementById("users-tbody");
  const me = window.getCurrentUser?.();
  tbody.innerHTML = users
    .map((user) => {
      const isSelf = me?.playerId === user.playerId;
      return `
      <tr data-player-id="${user.playerId}">
        <td>${user.playerId}</td>
        <td>
          <input class="user-name-input" type="text" value="${escapeHtml(user.name)}" />
        </td>
        <td>
          <input class="user-allowed" type="checkbox" ${user.isAllowed ? "checked" : ""} ${isSelf ? "disabled" : ""} />
        </td>
        <td>
          <input class="user-admin" type="checkbox" ${user.isAdmin ? "checked" : ""} ${isSelf ? "disabled" : ""} />
        </td>
        <td>${escapeHtml(formatTs(user.lastLoginAt))}</td>
        <td class="user-row-actions">
          <button type="button" class="user-save-btn">Save</button>
          <button type="button" class="user-delete-btn" ${isSelf ? "disabled" : ""}>Delete</button>
        </td>
      </tr>`;
    })
    .join("");
}

async function loadUsers() {
  const users = await fetchUsers();
  renderUsers(users);
}

async function createUser(fields) {
  const res = await fetch("/api/users", {
    method: "POST",
    headers: apiKeyHeaders(),
    body: JSON.stringify(fields),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function patchUser(playerId, fields) {
  const res = await fetch(`/api/users/${playerId}`, {
    method: "PATCH",
    headers: apiKeyHeaders(),
    body: JSON.stringify(fields),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function removeUser(playerId) {
  const res = await fetch(`/api/users/${playerId}`, {
    method: "DELETE",
    headers: apiKeyHeaders(),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
}

function showPanel() {
  document.getElementById("users-gate").classList.add("hidden");
  document.getElementById("users-panel").classList.remove("hidden");
}

function showGate(message) {
  const gate = document.getElementById("users-gate");
  gate.textContent = message;
  gate.classList.remove("hidden");
  document.getElementById("users-panel").classList.add("hidden");
}

document.getElementById("user-create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const playerId = Number.parseInt(document.getElementById("new-player-id").value, 10);
  const name = document.getElementById("new-name").value.trim();
  const isAllowed = document.getElementById("new-allowed").checked;
  const isAdmin = document.getElementById("new-admin").checked;
  try {
    await createUser({ playerId, name, isAllowed, isAdmin });
    e.target.reset();
    document.getElementById("new-allowed").checked = true;
    await loadUsers();
  } catch (err) {
    alert(`Add failed: ${err.message}`);
  }
});

document.getElementById("users-tbody").addEventListener("click", async (e) => {
  const row = e.target.closest("tr[data-player-id]");
  if (!row) return;
  const playerId = Number.parseInt(row.dataset.playerId, 10);

  if (e.target.classList.contains("user-save-btn")) {
    const name = row.querySelector(".user-name-input").value.trim();
    const isAllowed = row.querySelector(".user-allowed").checked;
    const isAdmin = row.querySelector(".user-admin").checked;
    try {
      await patchUser(playerId, { name, isAllowed, isAdmin });
      await loadUsers();
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
    return;
  }

  if (e.target.classList.contains("user-delete-btn")) {
    if (!confirm(`Delete user ${playerId}?`)) return;
    try {
      await removeUser(playerId);
      await loadUsers();
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  }
});

window.authReady.then(async () => {
  const user = window.getCurrentUser?.();
  if (!user) {
    showGate("Log in with an admin account to manage users.");
    return;
  }
  if (!user.isAdmin) {
    showGate("Admin access required.");
    return;
  }
  try {
    showPanel();
    await loadUsers();
  } catch (err) {
    showGate(`Failed to load users: ${err.message}`);
  }
});
