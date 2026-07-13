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

function marketPriceTitle(country, item) {
  const parts = [];
  const fetchedAt = state.marketPricesFetchedAt?.[item.id];
  if (fetchedAt != null) {
    parts.push(`Market price from ${fmtTime(fetchedAt)}`);
    const ageSec = Math.floor(Date.now() / 1000) - fetchedAt;
    if (ageSec > state.marketCacheTtlSec) {
      parts.push("(refreshing…)");
    }
  } else if (getSellPrice(country, item.id) == null) {
    parts.push("Market price not cached yet");
  }
  return parts.join(" · ");
}

const STOCK_TABLE_COLGROUP = `<colgroup>
    <col class="col-favorite" />
    <col class="col-item" />
    <col class="col-stock" />
    <col class="col-cost" />
    <col class="col-profit" />
  </colgroup>`;

const FAVORITES_TABLE_COLGROUP = `<colgroup>
    <col class="col-favorite" />
    <col class="col-item" />
    <col class="col-stock" />
    <col class="col-cost" />
    <col class="col-profit" />
    <col class="col-safe-window" />
    <col class="col-leave-by" />
  </colgroup>`;

const FAVORITES_SORT_COLUMNS = [
  { key: null, label: "" },
  { key: "item", label: "Item" },
  { key: "stock", label: "Stock" },
  { key: "cost", label: "Cost" },
  { key: "profit", label: "Profit/hr" },
  { key: "safeWindow", label: "Next safe window" },
  { key: "leaveBy", label: "Leave by" },
];

function favoritesTableHead() {
  const { column, dir } = state.favoritesSort;
  const cells = FAVORITES_SORT_COLUMNS.map(({ key, label }) => {
    if (!key) return "<th></th>";
    const active = column === key;
    const indicator = active ? (dir === "asc" ? " ▲" : " ▼") : "";
    return `<th><button type="button" class="favorites-sort${active ? " active" : ""}" data-sort="${key}">${label}${indicator}</button></th>`;
  }).join("");
  return `<thead><tr>${cells}</tr></thead>`;
}

function compareSortValues(a, b, dir) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a < b) return dir === "asc" ? -1 : 1;
  if (a > b) return dir === "asc" ? 1 : -1;
  return 0;
}

function favoriteSafeWindowSortValue(country, itemId) {
  const { data } = getSafeWindowDisplayData(country, itemId);
  return data?.available && data.safeWindow ? data.safeWindow.safeStart : null;
}

function favoriteLeaveBySortValue(country, itemId) {
  const { data } = getSafeWindowDisplayData(country, itemId);
  return data?.available && data.safeWindow ? data.safeWindow.leaveEarliest : null;
}

function sortFavoriteItems(favorites) {
  const { column, dir } = state.favoritesSort;
  const sorted = [...favorites];
  sorted.sort((a, b) => {
    let cmp = 0;
    switch (column) {
      case "stock":
        cmp = compareSortValues(a.item.quantity, b.item.quantity, dir);
        break;
      case "cost":
        cmp = compareSortValues(a.item.cost, b.item.cost, dir);
        break;
      case "profit":
        cmp = compareSortValues(
          getItemProfitPerHour(a.country, a.item),
          getItemProfitPerHour(b.country, b.item),
          dir
        );
        break;
      case "safeWindow":
        cmp = compareSortValues(
          favoriteSafeWindowSortValue(a.country, a.item.id),
          favoriteSafeWindowSortValue(b.country, b.item.id),
          dir
        );
        break;
      case "leaveBy":
        cmp = compareSortValues(
          favoriteLeaveBySortValue(a.country, a.item.id),
          favoriteLeaveBySortValue(b.country, b.item.id),
          dir
        );
        break;
      case "item":
      default:
        cmp = compareSortValues(a.item.name.toLowerCase(), b.item.name.toLowerCase(), dir);
        if (cmp === 0) cmp = compareSortValues(a.country, b.country, dir);
        break;
    }
    return cmp;
  });
  return sorted;
}

function getFilteredFavorites(query = state.search.trim().toLowerCase()) {
  const favorites = collectFavoriteItems();
  const filtered = favorites.filter(({ item }) => filterItems([item], query).length > 0);
  return sortFavoriteItems(filtered);
}

function favoriteRowHtml(country, item) {
  const meta = state.countries[country];
  const nameCell = `${meta.flag} ${highlight(item.name, state.search.trim())}`;
  return `
        <tr data-country="${country}" data-item="${item.id}" data-name="${escapeHtml(item.name)}" title="View item history">
          <td class="favorite-cell">${favoriteButtonHtml(country, item.id)}</td>
          <td>${nameCell}</td>
          <td class="${item.quantity === 0 ? "qty-zero" : "qty-ok"}">${fmtNum(item.quantity)}</td>
          <td>${fmtMoney(item.cost)}</td>
          ${profitHrCell(country, item)}
          ${safeWindowCell(country, item.id)}
          ${leaveByCell(country, item.id)}
        </tr>`;
}

function getSafeWindowDisplayData(country, itemId) {
  const key = favoriteItemKey(country, itemId);
  const data = state.safeWindows?.[key] ?? null;
  return {
    data,
    stale: state.safeWindowsStatus === "loading" && data != null,
  };
}

function safeWindowStatusCell(country, itemId, cellClass, render) {
  const { data, stale } = getSafeWindowDisplayData(country, itemId);
  if (!data) {
    if (state.safeWindowsStatus === "loading") {
      return `<td class="${cellClass} safe-window-loading">…</td>`;
    }
    return `<td class="${cellClass} safe-window-unavailable">—</td>`;
  }
  if (data.available && data.safeWindow) {
    return render(data.safeWindow, stale);
  }
  const labels = {
    insufficient_history: "No data",
    no_upcoming_restock: "—",
    missed: "Missed",
    no_stock_data: "—",
  };
  const text = labels[data.reason] ?? "—";
  const cls = data.reason === "missed" ? "safe-window-missed" : "safe-window-unavailable";
  const staleCls = stale ? " safe-window-stale" : "";
  const staleTitle = stale ? " (updating…)" : "";
  return `<td class="${cellClass} ${cls}${staleCls}" title="${escapeHtml((data.reason ?? "") + staleTitle)}">${text}</td>`;
}

function safeWindowCell(country, itemId) {
  return safeWindowStatusCell(country, itemId, "safe-window-cell", (sw, stale) => {
    const label = `${fmtTimeShort(sw.safeStart)} – ${fmtTimeShort(sw.safeEnd)}`;
    const title = `Safe ${fmtTime(sw.safeStart)} – ${fmtTime(sw.safeEnd)} · Leave ${fmtTime(sw.leaveEarliest)} – ${fmtTime(sw.leaveLatest)}${stale ? " (updating…)" : ""}`;
    const staleCls = stale ? " safe-window-stale" : "";
    return `<td class="safe-window-cell safe-window-ok${staleCls}" title="${escapeHtml(title)}">${label}</td>`;
  });
}

function leaveByCell(country, itemId) {
  return safeWindowStatusCell(country, itemId, "leave-by-cell", (sw, stale) => {
    const label = `${fmtTimeShort(sw.leaveEarliest)} – ${fmtTimeShort(sw.leaveLatest)}`;
    const title = `Leave ${fmtTime(sw.leaveEarliest)} – ${fmtTime(sw.leaveLatest)} · Safe ${fmtTime(sw.safeStart)} – ${fmtTime(sw.safeEnd)}${stale ? " (updating…)" : ""}`;
    const staleCls = stale ? " safe-window-stale" : "";
    return `<td class="leave-by-cell leave-by-ok${staleCls}" title="${escapeHtml(title)}">${label}</td>`;
  });
}

function itemRowHtml(country, item, { showCountry = false } = {}) {
  const meta = state.countries[country];
  const nameCell = showCountry
    ? `${meta.flag} ${highlight(item.name, state.search.trim())}`
    : highlight(item.name, state.search.trim());
  return `
        <tr data-country="${country}" data-item="${item.id}" data-name="${escapeHtml(item.name)}" title="View item history">
          <td class="favorite-cell">${favoriteButtonHtml(country, item.id)}</td>
          <td>${nameCell}</td>
          <td class="${item.quantity === 0 ? "qty-zero" : "qty-ok"}">${fmtNum(item.quantity)}</td>
          <td>${fmtMoney(item.cost)}</td>
          ${profitHrCell(country, item)}
        </tr>`;
}

function collectFavoriteItems() {
  const favorites = [];
  for (const key of Object.keys(getFavorites())) {
    const [country, itemIdStr] = key.split(":");
    const itemId = Number.parseInt(itemIdStr, 10);
    if (!state.countries[country] || !Number.isInteger(itemId)) continue;
    const data = state.stocks?.[country];
    const item = data?.stocks.find((it) => it.id === itemId);
    if (!item) continue;
    favorites.push({ country, item, update: data.update });
  }
  return favorites;
}

function filterItems(items, query) {
  let filtered = items;
  if (query) filtered = filtered.filter((it) => it.name.toLowerCase().includes(query));
  if (state.inStockOnly) filtered = filtered.filter((it) => it.quantity > 0);
  return filtered;
}

function profitHrCell(country, item) {
  const profitPerHour = getItemProfitPerHour(country, item);
  if (profitPerHour != null) {
    const cls = profitValueClass(profitPerHour);
    const title = marketPriceTitle(country, item);
    return `<td class="profit-hr ${cls}"${title ? ` title="${escapeHtml(title)}"` : ""}>${fmtProfitPerHour(profitPerHour)}</td>`;
  }
  const title =
    getSellPrice(country, item.id) == null && state.marketPricesStatus === "empty"
      ? "Market prices not cached yet — set TORN_API_KEY on the server or log in on an item page"
      : marketPriceTitle(country, item);
  return `<td class="profit-hr profit-unavailable"${title ? ` title="${escapeHtml(title)}"` : ""}>—</td>`;
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

async function loadMarketPrices() {
  try {
    const data = await fetchJson("/api/markets");
    state.marketPrices = data.prices ?? {};
    state.marketPricesFetchedAt = data.fetchedAt ?? {};
    state.marketCacheTtlSec = Number(data.cacheTtlSec) || 300;
    state.marketPricesStatus = Object.keys(state.marketPrices).length ? "ready" : "empty";
  } catch (err) {
    state.marketPrices = null;
    state.marketPricesFetchedAt = null;
    state.marketPricesStatus = "error";
    state.marketPricesError = err.message;
  }
  if (state.stocks) render();
}

async function loadStocks() {
  try {
    const data = await fetchJson("/api/stocks");
    state.stocks = data.stocks;
    lastStockTimestamp = data.timestamp;
    noteStockTimestamp(data.timestamp);
    el.status.textContent = `Last update: ${fmtTime(data.timestamp)} — updates when YATA polls (~every minute)`;
    el.status.classList.remove("error");
    render();
    await loadSafeWindows();
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

async function loadSafeWindows() {
  const favorites = collectFavoriteItems();
  if (!favorites.length) {
    state.safeWindows = {};
    state.safeWindowsStatus = null;
    return;
  }

  state.safeWindowsStatus = "loading";
  renderFavoritesOnly();

  const items = favorites.map(({ country, item }) => ({
    country,
    itemId: item.id,
    restockAmount: getRestockAmount(country, item.id) ?? undefined,
  }));

  try {
    const data = await fetchJsonWithBody("/api/safe-windows", {
      method: "POST",
      body: {
        items,
        travelType: state.travelType,
        flightTimeVariance: state.flightTimeVariance,
        safeWindowUseRateSelection: state.safeWindowUseRateSelection,
        avgSamples: state.avgSamples,
        avgRateSamples: state.avgRateSamples,
        stockoutTiming: state.stockoutTiming,
        rateTiming: state.rateTiming,
        predictionHours: 24,
      },
    });
    const windows = data.windows ?? {};
    state.safeWindows = { ...state.safeWindows, ...windows };
    saveSafeWindowsCache(windows);
    state.safeWindowsStatus = "ready";
  } catch {
    state.safeWindowsStatus = Object.keys(state.safeWindows).length ? "ready" : "error";
  }
  renderFavoritesOnly();
}

function renderFavoritesOnly() {
  const favoritesCard = el.countries.querySelector(".favorites-card");
  if (!favoritesCard) return;
  const filtered = getFilteredFavorites();
  const header = favoritesCard.querySelector(".country-header");
  if (header) {
    header.querySelector(".country-updated").textContent =
      `${filtered.length} item${filtered.length === 1 ? "" : "s"}`;
  }
  const existingTable = favoritesCard.querySelector("table");
  if (!filtered.length) {
    existingTable?.remove();
    if (!favoritesCard.querySelector(".empty-note")) {
      favoritesCard.insertAdjacentHTML(
        "beforeend",
        `<p class="empty-note">No favorites match the current filters.</p>`
      );
    }
    return;
  }
  favoritesCard.querySelector(".empty-note")?.remove();
  const rows = filtered.map(({ country, item }) => favoriteRowHtml(country, item)).join("");
  const tableHtml = `<table>
      ${FAVORITES_TABLE_COLGROUP}
      ${favoritesTableHead()}
      <tbody>${rows}</tbody>
    </table>`;
  if (existingTable) {
    existingTable.outerHTML = tableHtml;
  } else {
    favoritesCard.insertAdjacentHTML("beforeend", tableHtml);
  }
}

function renderFavoritesSection(query, frag) {
  const favorites = collectFavoriteItems();
  if (!favorites.length) return;

  const filtered = getFilteredFavorites(query);
  const card = document.createElement("section");
  card.className = "country-card favorites-card";
  card.innerHTML = `
    <div class="country-header">
      <h2>⭐ Favorites</h2>
      <span class="country-updated">${filtered.length} item${filtered.length === 1 ? "" : "s"}</span>
    </div>`;

  if (!filtered.length) {
    card.insertAdjacentHTML("beforeend", `<p class="empty-note">No favorites match the current filters.</p>`);
  } else {
    const rows = filtered.map(({ country, item }) => favoriteRowHtml(country, item)).join("");
    card.insertAdjacentHTML(
      "beforeend",
        `<table>
          ${FAVORITES_TABLE_COLGROUP}
          ${favoritesTableHead()}
          <tbody>${rows}</tbody>
        </table>`
    );
  }
  frag.appendChild(card);
}

function render() {
  if (!state.stocks) return;
  const query = state.search.trim().toLowerCase();
  const frag = document.createDocumentFragment();

  renderFavoritesSection(query, frag);

  for (const [code, meta] of Object.entries(state.countries)) {
    if (state.countryFilter && state.countryFilter !== code) continue;
    const data = state.stocks[code];
    if (!data) continue;

    const items = filterItems(data.stocks, query);
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
      const rows = items.map((it) => itemRowHtml(code, it)).join("");
      card.insertAdjacentHTML(
        "beforeend",
        `<table>
          ${STOCK_TABLE_COLGROUP}
          <thead><tr><th></th><th>Item</th><th>Stock</th><th>Cost</th><th>Profit/hr</th></tr></thead>
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
    el.status.textContent = `Last update: ${fmtTime(lastStockTimestamp)} — updates when YATA polls (~every minute)`;
  }
  render();
  renderFavoritesOnly();
});

window.addEventListener("travelsettingschange", () => {
  render();
  loadSafeWindows();
});

el.countries.addEventListener("click", (e) => {
  const sortBtn = e.target.closest(".favorites-sort");
  if (sortBtn) {
    e.stopPropagation();
    const column = sortBtn.dataset.sort;
    if (!column) return;
    if (state.favoritesSort.column === column) {
      state.favoritesSort.dir = state.favoritesSort.dir === "asc" ? "desc" : "asc";
    } else {
      state.favoritesSort = { column, dir: "asc" };
    }
    savePrefs({ favoritesSort: state.favoritesSort });
    if (el.countries.querySelector(".favorites-card")) {
      renderFavoritesOnly();
    } else {
      render();
    }
    return;
  }
  const favBtn = e.target.closest(".favorite-btn");
  if (favBtn) {
    e.stopPropagation();
    const country = favBtn.dataset.country;
    const itemId = Number.parseInt(favBtn.dataset.item, 10);
    if (!country || !Number.isInteger(itemId)) return;
    toggleFavorite(country, itemId);
    syncFavoriteButton(favBtn, country, itemId);
    render();
    return;
  }
  const row = e.target.closest("tr[data-item]");
  if (!row) return;
  window.location.href = itemUrl(row.dataset.country, row.dataset.item, row.dataset.name);
});

window.addEventListener("favoriteschange", () => {
  render();
  loadSafeWindows();
});

(async () => {
  await loadCountries();
  hydrateSafeWindowsFromCache();
  await populateCountryFilter();
  el.search.value = state.search;
  el.countryFilter.value = state.countryFilter;
  el.inStockOnly.checked = state.inStockOnly;
  await Promise.all([loadMarketPrices(), loadStocks()]);
  startStockUpdateWatcher(loadStocks);
  setInterval(loadMarketPrices, 60_000);
})();
