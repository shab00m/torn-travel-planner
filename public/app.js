const el = {
  status: document.getElementById("status"),
  countries: document.getElementById("countries"),
  search: document.getElementById("item-search"),
  countryFilter: document.getElementById("country-filter"),
  inStockOnly: document.getElementById("in-stock-only"),
};

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

async function populateCountryFilter() {
  for (const [code, meta] of Object.entries(state.countries)) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${meta.flag} ${meta.name}`;
    el.countryFilter.appendChild(opt);
  }
}

let stocksRetryTimer = null;
let lastStockTimestamp = null;

async function loadStocks() {
  try {
    const data = await fetchJson("/api/stocks");
    state.stocks = data.stocks;
    lastStockTimestamp = data.timestamp;
    el.status.textContent = `Last update: ${fmtTime(data.timestamp)} — auto-refreshes every minute`;
    el.status.classList.remove("error");
    render();
  } catch (err) {
    el.status.textContent = `Error: ${err.message}`;
    el.status.classList.add("error");
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
        <tr data-country="${code}" data-item="${it.id}" data-name="${escapeHtml(it.name)}" title="View item history">
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

el.search.addEventListener("input", () => {
  state.search = el.search.value;
  savePrefs({ search: state.search });
  render();
});
el.countryFilter.addEventListener("change", () => {
  state.countryFilter = el.countryFilter.value;
  savePrefs({ countryFilter: state.countryFilter });
  render();
});
el.inStockOnly.addEventListener("change", () => {
  state.inStockOnly = el.inStockOnly.checked;
  savePrefs({ inStockOnly: state.inStockOnly });
  render();
});

window.addEventListener("timeformatchange", () => {
  if (lastStockTimestamp != null) {
    el.status.textContent = `Last update: ${fmtTime(lastStockTimestamp)} — auto-refreshes every minute`;
  }
  render();
});

el.countries.addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-item]");
  if (!row) return;
  window.location.href = itemUrl(row.dataset.country, row.dataset.item, row.dataset.name);
});

(async () => {
  await loadCountries();
  await populateCountryFilter();
  el.search.value = state.search;
  el.countryFilter.value = state.countryFilter;
  el.inStockOnly.checked = state.inStockOnly;
  await loadStocks();
  setInterval(loadStocks, 60_000);
})();
