// Shared state and DOM refs; the modal/chart half lives in chart.js.
const state = {
  countries: {},   // code -> { name, flag }
  stocks: null,    // code -> { update, stocks: [...] }
  search: "",
  countryFilter: "",
  inStockOnly: false,
  chart: null,
  chartPoints: [], // history points backing the current chart (used by tooltips)
  restocks: [],    // recent out-of-stock periods for the open modal item
  rates: [],       // recent in-stock depletion-rate windows for the modal item
  avgSamples: 5,   // sample count for the restock duration average
  avgRateSamples: 5, // sample count for the depletion rate average
  modalItem: null, // { country, itemId, name }
  rangeHours: 24,
};

const el = {
  status: document.getElementById("status"),
  countries: document.getElementById("countries"),
  search: document.getElementById("item-search"),
  countryFilter: document.getElementById("country-filter"),
  inStockOnly: document.getElementById("in-stock-only"),
  modal: document.getElementById("modal"),
  modalTitle: document.getElementById("modal-title"),
  modalSubtitle: document.getElementById("modal-subtitle"),
  modalClose: document.getElementById("modal-close"),
  modalEmpty: document.getElementById("modal-empty"),
  rangeButtons: document.getElementById("range-buttons"),
  chartCanvas: document.getElementById("history-chart"),
  avgButtons: document.getElementById("avg-buttons"),
  restockAvg: document.getElementById("restock-avg"),
  restockList: document.getElementById("restock-list"),
  rateAvgButtons: document.getElementById("rate-avg-buttons"),
  rateAvg: document.getElementById("rate-avg"),
};

const fmtNum = (n) => n.toLocaleString("en-US");
const fmtMoney = (n) => "$" + fmtNum(n);
const fmtTime = (ts) => new Date(ts * 1000).toLocaleString();
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function highlight(name, query) {
  const safe = escapeHtml(name);
  if (!query) return safe;
  const idx = name.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return safe;
  return (
    escapeHtml(name.slice(0, idx)) +
    "<mark>" + escapeHtml(name.slice(idx, idx + query.length)) + "</mark>" +
    escapeHtml(name.slice(idx + query.length))
  );
}

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function loadCountries() {
  state.countries = await fetchJson("/api/countries");
  for (const [code, meta] of Object.entries(state.countries)) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${meta.flag} ${meta.name}`;
    el.countryFilter.appendChild(opt);
  }
}

let stocksRetryTimer = null;

async function loadStocks() {
  try {
    const data = await fetchJson("/api/stocks");
    state.stocks = data.stocks;
    el.status.textContent = `Last update: ${fmtTime(data.timestamp)} — auto-refreshes every minute`;
    el.status.classList.remove("error");
    render();
    if (state.modalItem) await drawChart();
  } catch (err) {
    el.status.textContent = `Error: ${err.message}`;
    el.status.classList.add("error");
    // Retry quickly instead of waiting for the next minute tick
    // (e.g. right after a server restart before its first YATA poll).
    if (!stocksRetryTimer) {
      stocksRetryTimer = setTimeout(() => {
        stocksRetryTimer = null;
        loadStocks();
      }, 5000);
    }
  }
}

function render() {
  if (!state.stocks) return;
  const query = state.search.trim().toLowerCase();
  const frag = document.createDocumentFragment();

  for (const [code, meta] of Object.entries(state.countries)) {
    if (state.countryFilter && state.countryFilter !== code) continue;
    const data = state.stocks[code];
    if (!data) continue;

    let items = data.stocks;
    if (query) items = items.filter((it) => it.name.toLowerCase().includes(query));
    if (state.inStockOnly) items = items.filter((it) => it.quantity > 0);
    if (!items.length && (query || state.inStockOnly)) continue;

    const card = document.createElement("section");
    card.className = "country-card";
    card.innerHTML = `
      <div class="country-header">
        <h2>${meta.flag} ${meta.name}</h2>
        <span class="country-updated">updated ${fmtTime(data.update)}</span>
      </div>`;

    if (!items.length) {
      card.insertAdjacentHTML("beforeend", `<p class="empty-note">No items.</p>`);
    } else {
      const rows = items
        .map(
          (it) => `
        <tr data-country="${code}" data-item="${it.id}" data-name="${escapeHtml(it.name)}" title="Click for history">
          <td>${highlight(it.name, state.search.trim())}</td>
          <td class="${it.quantity === 0 ? "qty-zero" : "qty-ok"}">${fmtNum(it.quantity)}</td>
          <td>${fmtMoney(it.cost)}</td>
        </tr>`
        )
        .join("");
      card.insertAdjacentHTML(
        "beforeend",
        `<table>
          <thead><tr><th>Item</th><th>Stock</th><th>Cost</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      );
    }
    frag.appendChild(card);
  }

  el.countries.replaceChildren(frag);
  if (!el.countries.children.length) {
    el.countries.innerHTML = `<p class="empty-note">Nothing matches the current filters.</p>`;
  }
}

// --- events ---
el.search.addEventListener("input", () => {
  state.search = el.search.value;
  render();
});
el.countryFilter.addEventListener("change", () => {
  state.countryFilter = el.countryFilter.value;
  render();
});
el.inStockOnly.addEventListener("change", () => {
  state.inStockOnly = el.inStockOnly.checked;
  render();
});

el.countries.addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-item]");
  if (!row) return;
  openModal(row.dataset.country, Number(row.dataset.item), row.dataset.name);
});

// --- init ---
(async () => {
  await loadCountries();
  await loadStocks();
  setInterval(loadStocks, 60_000);
})();
