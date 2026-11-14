// The server independently authenticates every read/write as an allowed admin.
const deprecationControls = document.getElementById("item-deprecation-controls");
const deprecatedToggle = document.getElementById("item-deprecated");
const deprecationAuto = document.getElementById("item-deprecation-auto");
const deprecationStatus = document.getElementById("item-deprecation-status");
let deprecationData = null;
let deprecationRequest = 0;
let deprecationSaving = false;

function renderDeprecationControl() {
  const allowed = Boolean(window.getCurrentUser?.()?.isAdmin);
  deprecationControls?.classList.toggle("hidden", !allowed);
  if (!deprecatedToggle) return;
  deprecatedToggle.disabled = !allowed || !deprecationData || deprecationSaving;
  deprecationAuto.disabled = deprecatedToggle.disabled || deprecationData?.override == null;
  deprecatedToggle.checked = Boolean(deprecationData?.deprecated);
  if (!allowed) deprecationStatus.textContent = "";
}

async function refreshItemDeprecation() {
  renderDeprecationControl();
  if (deprecationSaving) return;
  const request = ++deprecationRequest;
  const item = state.item;
  if (!window.getCurrentUser?.()?.isAdmin || !item) {
    deprecationData = null;
    renderDeprecationControl();
    return;
  }
  try {
    const response = await fetch(`/api/items/${item.country}/${item.itemId}/deprecation`, {
      headers: adminApiHeaders(),
    });
    const data = await parseFetchResponse(response);
    if (request !== deprecationRequest || !window.getCurrentUser?.()?.isAdmin) return;
    deprecationData = data;
    deprecationStatus.textContent = data.override == null
      ? "Updated automatically from Torn each day."
      : "Admin override; daily updates will keep this choice.";
  } catch (err) {
    if (request !== deprecationRequest || !window.getCurrentUser?.()?.isAdmin) return;
    deprecationData = null;
    deprecationStatus.textContent = err.message;
  }
  renderDeprecationControl();
}

async function saveItemDeprecation(deprecated) {
  if (!window.getCurrentUser?.()?.isAdmin || !state.item || deprecationSaving || !deprecationData) return;
  deprecationSaving = true;
  ++deprecationRequest; // Discard an older read that might arrive after this write.
  renderDeprecationControl();
  const { country, itemId } = state.item;
  try {
    deprecationData = await fetchJsonWithBody(`/api/items/${country}/${itemId}/deprecation`, {
      method: "PUT", headers: adminApiHeaders(), body: { deprecated },
    });
    deprecationStatus.textContent = deprecationData.override == null
      ? "Updated automatically from Torn each day."
      : "Admin override saved; daily updates will keep this choice.";
  } catch (err) {
    deprecationStatus.textContent = `Could not save: ${err.message}`;
  } finally {
    deprecationSaving = false;
    renderDeprecationControl();
  }
}

deprecatedToggle?.addEventListener("change", () => { void saveItemDeprecation(deprecatedToggle.checked); });
deprecationAuto?.addEventListener("click", () => { void saveItemDeprecation(null); });
window.addEventListener("travelsettingschange", () => { void refreshItemDeprecation(); });
window.addEventListener("snapshotsupdated", (event) => {
  const items = event.detail?.items;
  // Stock ticks do not need another authenticated metadata request.
  if (items == null || items.some((item) => item.snapshot_ts === null
    && item.country === state.item?.country && item.itemId === state.item?.itemId)) {
    void refreshItemDeprecation();
  }
});
