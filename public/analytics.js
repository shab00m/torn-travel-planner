function apiKeyHeaders() {
  const apiKey = getStoredApiKey();
  if (!apiKey) throw new Error("Not logged in");
  return {
    "Content-Type": "application/json",
    "X-Api-Key": apiKey,
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTs(ts) {
  if (ts == null) return "—";
  return fmtTime(ts);
}

async function fetchPageViews() {
  const res = await fetch("/api/page-views?limit=200", { headers: apiKeyHeaders() });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.views;
}

function renderViews(views) {
  const tbody = document.getElementById("analytics-tbody");
  if (!views.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="analytics-empty">No page loads recorded yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = views
    .map((view) => {
      const userId = view.playerId != null ? String(view.playerId) : "—";
      const username = view.name ? escapeHtml(view.name) : "—";
      const ip = view.ipAddress ? escapeHtml(view.ipAddress) : "—";
      return `
      <tr>
        <td>${escapeHtml(formatTs(view.createdAt))}</td>
        <td>${escapeHtml(userId)}</td>
        <td>${username}</td>
        <td class="analytics-url">${escapeHtml(view.url)}</td>
        <td>${ip}</td>
      </tr>`;
    })
    .join("");
}

async function loadViews() {
  const views = await fetchPageViews();
  renderViews(views);
}

function showPanel() {
  document.getElementById("analytics-gate").classList.add("hidden");
  document.getElementById("analytics-panel").classList.remove("hidden");
}

function showGate(message) {
  const gate = document.getElementById("analytics-gate");
  gate.textContent = message;
  gate.classList.remove("hidden");
  document.getElementById("analytics-panel").classList.add("hidden");
}

document.getElementById("analytics-refresh").addEventListener("click", async () => {
  const btn = document.getElementById("analytics-refresh");
  btn.disabled = true;
  try {
    await loadViews();
  } catch (err) {
    alert(`Refresh failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

window.authReady.then(async () => {
  const user = window.getCurrentUser?.();
  if (!user) {
    showGate("Log in with an admin account to view analytics.");
    return;
  }
  if (!user.isAdmin) {
    showGate("Admin access required.");
    return;
  }
  try {
    showPanel();
    await loadViews();
  } catch (err) {
    showGate(`Failed to load analytics: ${err.message}`);
  }
});
