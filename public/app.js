const el = {
  status: document.getElementById("status"),
  pageError: document.getElementById("page-error"),
  homeMain: document.querySelector(".home-main"),
  favorites: document.getElementById("favorites"),
  countries: document.getElementById("countries"),
  search: document.getElementById("item-search"),
  stockGroupBy: document.getElementById("stock-group-by"),
  countryFilter: document.getElementById("country-filter"),
  countryFilterList: document.getElementById("country-filter-list"),
  itemTypeFilter: document.getElementById("item-type-filter"),
  itemTypeFilterList: document.getElementById("item-type-filter-list"),
  profitMin: document.getElementById("profit-min"),
  profitMax: document.getElementById("profit-max"),
  maxBudget: document.getElementById("max-budget"),
  inStockOnly: document.getElementById("in-stock-only"),
  showHidden: document.getElementById("show-hidden"),
};

function clearPageError() {
  el.pageError.textContent = "";
  el.pageError.classList.add("hidden");
}

function showPageError(message) {
  el.pageError.textContent = message;
  el.pageError.classList.remove("hidden");
}

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

const FAVORITES_TABLE_COLGROUP = `<colgroup>
    <col class="col-favorite" />
    <col class="col-item" />
    <col class="col-stock" />
    <col class="col-cost" />
    <col class="col-items" />
    <col class="col-total-cost" />
    <col class="col-profit" />
    <col class="col-safe-window" />
    <col class="col-leave-by" />
  </colgroup>`;

const FAVORITES_SORT_COLUMNS = [
  { key: null, label: "" },
  { key: "item", label: "Item" },
  { key: "stock", label: "Stock" },
  { key: "cost", label: "Cost" },
  { key: "items", label: "Items" },
  { key: "totalCost", label: "Total cost" },
  { key: "profit", label: "Profit/hr" },
  { key: "safeWindow", label: "Next safe window" },
  { key: "leaveBy", label: "Leave by" },
];

const STOCK_COL_CLASS = {
  favorite: "col-favorite",
  item: "col-item",
  country: "col-country",
  type: "col-type",
  stock: "col-stock",
  cost: "col-cost",
  items: "col-items",
  totalCost: "col-total-cost",
  profit: "col-profit",
};

/** Stock list columns; omit the dimension currently used for grouping. */
function stockTableColumns() {
  const cols = [
    { key: null, label: "", col: "favorite" },
    { key: "item", label: "Item", col: "item" },
  ];
  if (state.stockGroupBy !== "country") {
    cols.push({ key: "country", label: "Country", col: "country" });
  }
  if (state.stockGroupBy !== "type") {
    cols.push({ key: "type", label: "Type", col: "type" });
  }
  cols.push(
    { key: "stock", label: "Stock", col: "stock" },
    { key: "cost", label: "Cost", col: "cost" },
    { key: "items", label: "Items", col: "items" },
    { key: "totalCost", label: "Total cost", col: "totalCost" },
    { key: "profit", label: "Profit/hr", col: "profit" }
  );
  return cols;
}

function stockTableColgroup() {
  const cols = stockTableColumns()
    .map(({ col }) => `<col class="${STOCK_COL_CLASS[col]}" />`)
    .join("");
  return `<colgroup>${cols}</colgroup>`;
}

function sortableTableHead(columns, sortState, sortTarget) {
  const { column, dir } = sortState;
  const cells = columns.map(({ key, label }) => {
    if (!key) return "<th></th>";
    const active = column === key;
    const indicator = active ? (dir === "asc" ? " ▲" : " ▼") : "";
    return `<th class="sort-col-${key}"><button type="button" class="column-sort${active ? " active" : ""}" data-sort="${key}" data-sort-target="${sortTarget}">${label}${indicator}</button></th>`;
  }).join("");
  return `<thead><tr>${cells}</tr></thead>`;
}

function favoritesTableHead() {
  return sortableTableHead(FAVORITES_SORT_COLUMNS, state.favoritesSort, "favorites");
}

function stocksTableHead() {
  return sortableTableHead(stockTableColumns(), state.stocksSort, "stocks");
}

function ensureValidStocksSort() {
  const keys = stockTableColumns().map((c) => c.key).filter(Boolean);
  if (keys.includes(state.stocksSort.column)) return;
  state.stocksSort = { column: "item", dir: "asc" };
  savePrefs({ stocksSort: state.stocksSort });
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

function countrySortLabel(code) {
  return state.countries[code]?.name?.toLowerCase() ?? code;
}

function compareItemsBySort(aCountry, aItem, bCountry, bItem, sortState) {
  const { column, dir } = sortState;
  switch (column) {
    case "stock":
      return compareSortValues(aItem.quantity, bItem.quantity, dir);
    case "cost":
      return compareSortValues(aItem.cost, bItem.cost, dir);
    case "items":
      return compareSortValues(
        getMaxPurchaseQty(aCountry, aItem.id, aItem.cost),
        getMaxPurchaseQty(bCountry, bItem.id, bItem.cost),
        dir
      );
    case "totalCost":
      return compareSortValues(
        aItem.cost * getMaxPurchaseQty(aCountry, aItem.id, aItem.cost),
        bItem.cost * getMaxPurchaseQty(bCountry, bItem.id, bItem.cost),
        dir
      );
    case "profit":
      return compareSortValues(
        getItemProfitPerHour(aCountry, aItem),
        getItemProfitPerHour(bCountry, bItem),
        dir
      );
    case "country":
      return compareSortValues(countrySortLabel(aCountry), countrySortLabel(bCountry), dir);
    case "type":
      return compareSortValues(
        (getItemType(aItem.id) ?? "").toLowerCase(),
        (getItemType(bItem.id) ?? "").toLowerCase(),
        dir
      );
    case "safeWindow":
      return compareSortValues(
        favoriteSafeWindowSortValue(aCountry, aItem.id),
        favoriteSafeWindowSortValue(bCountry, bItem.id),
        dir
      );
    case "leaveBy":
      return compareSortValues(
        favoriteLeaveBySortValue(aCountry, aItem.id),
        favoriteLeaveBySortValue(bCountry, bItem.id),
        dir
      );
    case "item":
    default: {
      let cmp = compareSortValues(aItem.name.toLowerCase(), bItem.name.toLowerCase(), dir);
      if (cmp === 0) cmp = compareSortValues(aCountry, bCountry, dir);
      return cmp;
    }
  }
}

function sortFavoriteItems(favorites) {
  return [...favorites].sort((a, b) =>
    compareItemsBySort(a.country, a.item, b.country, b.item, state.favoritesSort)
  );
}

function sortStockRows(rows) {
  return [...rows].sort((a, b) =>
    compareItemsBySort(a.country, a.item, b.country, b.item, state.stocksSort)
  );
}

/** Favorites ignore search/type/profit filters; hidden items still apply unless Show hidden. */
function getSortedFavorites() {
  let favorites = collectFavoriteItems();
  if (!state.showHidden) {
    favorites = favorites.filter(({ country, item }) => !isHidden(country, item.id));
  }
  return sortFavoriteItems(favorites);
}

function getItemType(itemId) {
  return state.itemTypes?.[itemId] ?? null;
}

function itemMatchesFilters(item, country, query) {
  if (!state.showHidden && isHidden(country, item.id)) return false;
  if (query && !item.name.toLowerCase().includes(query)) return false;
  if (state.inStockOnly && item.quantity <= 0) return false;
  if (state.itemTypeFilters.length) {
    const type = getItemType(item.id);
    if (!type || !state.itemTypeFilters.includes(type)) return false;
  }
  if (state.profitMin != null || state.profitMax != null) {
    const profit = getItemProfitPerHour(country, item);
    if (profit == null) return false;
    if (state.profitMin != null && profit < state.profitMin) return false;
    if (state.profitMax != null && profit > state.profitMax) return false;
  }
  return true;
}

function availableItemTypesInStocks() {
  const types = new Set();
  for (const data of Object.values(state.stocks || {})) {
    for (const item of data.stocks || []) {
      const type = getItemType(item.id);
      if (type) types.add(type);
    }
  }
  return [...types].sort((a, b) => a.localeCompare(b));
}

function filterMenuSummaryLabel(selected, { all, one, many }) {
  if (!selected.length) return all;
  if (selected.length === 1) return one(selected[0]);
  return many(selected.length);
}

function syncFilterMenuSummary(menuEl, selected, labels) {
  const summary = menuEl?.querySelector(".filter-menu-summary");
  if (!summary) return;
  summary.textContent = filterMenuSummaryLabel(selected, labels);
  summary.classList.toggle("has-selection", selected.length > 0);
}

function renderCheckboxOptions(listEl, options, selected, onToggle) {
  listEl.replaceChildren();
  for (const { value, label } of options) {
    const row = document.createElement("label");
    row.className = "filter-menu-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = value;
    input.checked = selected.includes(value);
    input.addEventListener("change", () => onToggle(value, input.checked));
    const text = document.createElement("span");
    text.textContent = label;
    row.append(input, text);
    listEl.appendChild(row);
  }
}

function populateItemTypeFilter() {
  if (!el.itemTypeFilterList) return;
  const available = availableItemTypesInStocks();
  // Prune stale selections only after both catalogues are ready.
  if (state.itemTypesStatus === "ready" && state.stocks) {
    const pruned = state.itemTypeFilters.filter((type) => available.includes(type));
    if (pruned.length !== state.itemTypeFilters.length) {
      state.itemTypeFilters = pruned;
      savePrefs({ itemTypeFilters: state.itemTypeFilters });
    }
  }
  const extras = state.itemTypeFilters.filter((type) => !available.includes(type));
  const options = [...available, ...extras].map((type) => ({ value: type, label: type }));
  const typeLabels = {
    all: "All types",
    one: (t) => t,
    many: (n) => `Types (${n})`,
  };
  renderCheckboxOptions(el.itemTypeFilterList, options, state.itemTypeFilters, (value, checked) => {
    const next = new Set(state.itemTypeFilters);
    if (checked) next.add(value);
    else next.delete(value);
    state.itemTypeFilters = [...next];
    savePrefs({ itemTypeFilters: state.itemTypeFilters });
    syncFilterMenuSummary(el.itemTypeFilter, state.itemTypeFilters, typeLabels);
    render();
  });
  syncFilterMenuSummary(el.itemTypeFilter, state.itemTypeFilters, typeLabels);
}

function purchaseQtyCellsHtml(country, item) {
  const qty = getMaxPurchaseQty(country, item.id, item.cost);
  const titleParts = [`${state.travelCapacity} slots`];
  const restock = getRestockAmount(country, item.id);
  if (restock != null) titleParts.push(`restock ${fmtNum(restock)}`);
  if (state.maxBudget != null) titleParts.push(`budget ${fmtMoney(state.maxBudget)}`);
  const title = titleParts.join(" · ");
  return `
          <td title="${escapeHtml(title)}">${fmtNum(qty)}</td>
          <td title="${escapeHtml(title)}">${fmtMoney(item.cost * qty)}</td>`;
}

function favoriteRowHtml(country, item) {
  const meta = state.countries[country];
  const nameCell = `${meta.flag} ${escapeHtml(item.name)}`;
  const hidden = isHidden(country, item.id);
  return `
        <tr class="${hidden ? "is-hidden-row" : ""}" data-country="${country}" data-item="${item.id}" data-name="${escapeHtml(item.name)}" title="View item history">
          <td class="favorite-cell">${itemActionsHtml(country, item.id)}</td>
          <td>${nameCell}</td>
          <td class="${item.quantity === 0 ? "qty-zero" : "qty-ok"}">${fmtNum(item.quantity)}</td>
          <td>${fmtMoney(item.cost)}</td>
          ${purchaseQtyCellsHtml(country, item)}
          ${profitHrCell(country, item)}
          ${safeWindowCell(country, item.id)}
          ${leaveByCell(country, item.id, item.name)}
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

function leaveByCell(country, itemId, itemName) {
  return safeWindowStatusCell(country, itemId, "leave-by-cell", (sw, stale) => {
    const wallTs = Math.floor(Date.now() / 1000);
    const canAlarm =
      sw.leaveEarliest != null &&
      sw.leaveEarliest > wallTs &&
      typeof alarmButtonHtml === "function";
    const windowIndex =
      typeof FAVORITE_NEXT_WINDOW_INDEX === "number" ? FAVORITE_NEXT_WINDOW_INDEX : -1;
    const armed =
      canAlarm &&
      typeof hasLeaveAlarm === "function" &&
      hasLeaveAlarm("leave_safe", country, itemId, windowIndex);
    const btn = canAlarm
      ? ` ${alarmButtonHtml({
          armed,
          attrs: {
            "data-alarm-type": "leave_safe",
            "data-window-index": windowIndex,
            "data-leave-earliest": sw.leaveEarliest,
            "data-country": country,
            "data-item-id": itemId,
            "data-item-name": itemName ?? "",
          },
        })}`
      : "";
    const label = `${fmtTimeShort(sw.leaveEarliest)}${btn} – ${fmtTimeShort(sw.leaveLatest)}`;
    const title = `Leave ${fmtTime(sw.leaveEarliest)} – ${fmtTime(sw.leaveLatest)} · Safe ${fmtTime(sw.safeStart)} – ${fmtTime(sw.safeEnd)}${stale ? " (updating…)" : ""}`;
    const staleCls = stale ? " safe-window-stale" : "";
    return `<td class="leave-by-cell leave-by-ok${staleCls}" title="${escapeHtml(title)}">${label}</td>`;
  });
}

function stockRowHtml(country, item) {
  const meta = state.countries[country];
  const type = getItemType(item.id);
  const hidden = isHidden(country, item.id);
  const extraCols = [];
  if (state.stockGroupBy !== "country") {
    extraCols.push(`<td class="country-cell">${meta.flag} ${escapeHtml(meta.name)}</td>`);
  }
  if (state.stockGroupBy !== "type") {
    extraCols.push(
      `<td class="type-cell">${type ? escapeHtml(type) : '<span class="type-unknown">—</span>'}</td>`
    );
  }
  return `
        <tr class="${hidden ? "is-hidden-row" : ""}" data-country="${country}" data-item="${item.id}" data-name="${escapeHtml(item.name)}" title="View item history">
          <td class="favorite-cell">${itemActionsHtml(country, item.id)}</td>
          <td>${highlight(item.name, state.search.trim())}</td>
          ${extraCols.join("")}
          <td class="${item.quantity === 0 ? "qty-zero" : "qty-ok"}">${fmtNum(item.quantity)}</td>
          <td>${fmtMoney(item.cost)}</td>
          ${purchaseQtyCellsHtml(country, item)}
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

function filterItems(items, country, query) {
  return items.filter((it) => itemMatchesFilters(it, country, query));
}

function hasActiveListFilters(query) {
  return Boolean(
    query ||
      state.inStockOnly ||
      state.itemTypeFilters.length ||
      state.profitMin != null ||
      state.profitMax != null
  );
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

function countryFilterLabel(code) {
  const meta = state.countries[code];
  return meta ? `${meta.flag} ${meta.name}` : code;
}

function populateCountryFilter() {
  if (!el.countryFilterList) return;
  const codes = Object.keys(state.countries);
  const valid = state.countryFilters.filter((code) => codes.includes(code));
  if (valid.length !== state.countryFilters.length) {
    state.countryFilters = valid;
    savePrefs({ countryFilters: state.countryFilters });
  }
  const options = codes.map((code) => ({
    value: code,
    label: countryFilterLabel(code),
  }));
  const countryLabels = {
    all: "All countries",
    one: countryFilterLabel,
    many: (n) => `Countries (${n})`,
  };
  renderCheckboxOptions(el.countryFilterList, options, state.countryFilters, (value, checked) => {
    const next = new Set(state.countryFilters);
    if (checked) next.add(value);
    else next.delete(value);
    state.countryFilters = [...next];
    savePrefs({ countryFilters: state.countryFilters });
    syncFilterMenuSummary(el.countryFilter, state.countryFilters, countryLabels);
    render();
  });
  syncFilterMenuSummary(el.countryFilter, state.countryFilters, countryLabels);
}

function initFilterMenus() {
  const menus = [el.countryFilter, el.itemTypeFilter].filter(Boolean);
  for (const menu of menus) {
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      for (const other of menus) {
        if (other !== menu) other.open = false;
      }
    });
  }
  document.addEventListener("click", (e) => {
    for (const menu of menus) {
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    }
  });
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

async function loadItemTypes() {
  try {
    const data = await fetchJson("/api/item-types");
    state.itemTypes = data.types ?? {};
    state.itemTypesStatus = Object.keys(state.itemTypes).length ? "ready" : "empty";
  } catch {
    state.itemTypes = state.itemTypes ?? {};
    state.itemTypesStatus = "error";
  }
  populateItemTypeFilter();
  if (state.stocks) render();
}

async function loadStocks() {
  try {
    const data = await fetchJson("/api/stocks");
    state.stocks = data.stocks;
    lastStockTimestamp = data.timestamp;
    noteStockTimestamp(data.timestamp);
    clearPageError();
    el.status.textContent = `Last update: ${fmtTime(data.timestamp)} — updates when YATA polls (~every minute)`;
    populateItemTypeFilter();
    render();
    await loadSafeWindows();
  } catch (err) {
    el.status.textContent = "Unable to load stocks";
    showPageError(`Error: ${err.message}`);
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
    if (typeof syncFavoriteNextLeaveAlarms === "function") {
      syncFavoriteNextLeaveAlarms(state.safeWindows);
    }
  } catch {
    state.safeWindowsStatus = Object.keys(state.safeWindows).length ? "ready" : "error";
  }
  renderFavoritesOnly();
}

function favoritesCardHtml(favorites) {
  const rows = favorites.map(({ country, item }) => favoriteRowHtml(country, item)).join("");
  return `
    <section class="country-card favorites-card">
      <div class="country-header">
        <h2>⭐ Favorites</h2>
        <span class="country-updated">${favorites.length} item${favorites.length === 1 ? "" : "s"}</span>
      </div>
      <table>
        ${FAVORITES_TABLE_COLGROUP}
        ${favoritesTableHead()}
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderFavoritesOnly() {
  if (!el.favorites) return;
  const favorites = getSortedFavorites();
  if (!favorites.length) {
    el.favorites.replaceChildren();
    return;
  }
  const existingCard = el.favorites.querySelector(".favorites-card");
  if (!existingCard) {
    el.favorites.innerHTML = favoritesCardHtml(favorites);
    return;
  }
  const header = existingCard.querySelector(".country-header .country-updated");
  if (header) {
    header.textContent = `${favorites.length} item${favorites.length === 1 ? "" : "s"}`;
  }
  const tableHtml = `<table>
      ${FAVORITES_TABLE_COLGROUP}
      ${favoritesTableHead()}
      <tbody>${favorites.map(({ country, item }) => favoriteRowHtml(country, item)).join("")}</tbody>
    </table>`;
  const existingTable = existingCard.querySelector("table");
  if (existingTable) existingTable.outerHTML = tableHtml;
  else existingCard.insertAdjacentHTML("beforeend", tableHtml);
}

function renderFavoritesSection() {
  if (!el.favorites) return;
  const favorites = getSortedFavorites();
  el.favorites.innerHTML = favorites.length ? favoritesCardHtml(favorites) : "";
}

function collectStockRows(query) {
  const rows = [];
  for (const code of Object.keys(state.countries)) {
    if (state.countryFilters.length && !state.countryFilters.includes(code)) continue;
    const data = state.stocks[code];
    if (!data) continue;
    for (const item of filterItems(data.stocks, code, query)) {
      rows.push({ country: code, item, update: data.update });
    }
  }
  return rows;
}

function stockGroupTitle(groupBy, key) {
  if (groupBy === "none") return "All items";
  if (groupBy === "type") return key === "" ? "Unknown type" : key;
  const meta = state.countries[key];
  return meta ? `${meta.flag} ${meta.name}` : key;
}

/** Build display groups from filtered rows according to stockGroupBy. */
function buildStockGroups(rows, query) {
  const groupBy = state.stockGroupBy;
  if (groupBy === "none") {
    if (!rows.length) return [];
    const latest = rows.reduce((max, r) => Math.max(max, r.update ?? 0), 0);
    return [
      {
        key: "all",
        title: stockGroupTitle("none"),
        meta: `${rows.length} item${rows.length === 1 ? "" : "s"}`,
        updated: latest || null,
        rows: sortStockRows(rows),
        fullWidth: true,
      },
    ];
  }

  if (groupBy === "type") {
    const byType = new Map();
    for (const row of rows) {
      const type = getItemType(row.item.id) ?? "";
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(row);
    }
    const keys = [...byType.keys()].sort((a, b) => {
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b);
    });
    return keys.map((key) => {
      const groupRows = byType.get(key);
      const latest = groupRows.reduce((max, r) => Math.max(max, r.update ?? 0), 0);
      return {
        key: key || "unknown",
        title: stockGroupTitle("type", key),
        meta: `${groupRows.length} item${groupRows.length === 1 ? "" : "s"}`,
        updated: latest || null,
        rows: sortStockRows(groupRows),
        fullWidth: false,
      };
    });
  }

  // Group by country — preserve country order; keep empty countries when no filters.
  const groups = [];
  for (const [code, meta] of Object.entries(state.countries)) {
    if (state.countryFilters.length && !state.countryFilters.includes(code)) continue;
    const data = state.stocks[code];
    if (!data) continue;
    const groupRows = rows.filter((r) => r.country === code);
    // Keep truly empty countries only when no filters/hiding removed everything.
    if (!groupRows.length && (data.stocks.length > 0 || hasActiveListFilters(query))) continue;
    groups.push({
      key: code,
      title: `${meta.flag} ${meta.name}`,
      meta: `updated ${fmtTime(data.update)}`,
      updated: data.update,
      rows: sortStockRows(groupRows),
      fullWidth: false,
    });
  }
  return groups;
}

function stockGroupCardHtml(group) {
  const card = document.createElement("section");
  card.className = `country-card${group.fullWidth ? " stock-card-full" : ""}`;
  card.innerHTML = `
    <div class="country-header">
      <h2>${escapeHtml(group.title)}</h2>
      <span class="country-updated">${escapeHtml(group.meta)}</span>
    </div>`;

  if (!group.rows.length) {
    card.insertAdjacentHTML("beforeend", `<p class="empty-note">No items.</p>`);
    return card;
  }

  const body = group.rows.map(({ country, item }) => stockRowHtml(country, item)).join("");
  card.insertAdjacentHTML(
    "beforeend",
    `<table>
      ${stockTableColgroup()}
      ${stocksTableHead()}
      <tbody>${body}</tbody>
    </table>`
  );
  return card;
}

function render() {
  if (!state.stocks) return;
  ensureValidStocksSort();
  const query = state.search.trim().toLowerCase();
  const frag = document.createDocumentFragment();

  renderFavoritesSection();

  const rows = collectStockRows(query);
  const groups = buildStockGroups(rows, query);
  for (const group of groups) {
    frag.appendChild(stockGroupCardHtml(group));
  }

  el.countries.classList.toggle("countries-flat", state.stockGroupBy === "none");
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
el.stockGroupBy.addEventListener("change", () => {
  const value = el.stockGroupBy.value;
  if (!STOCK_GROUP_BY_OPTIONS.includes(value)) return;
  state.stockGroupBy = value;
  savePrefs({ stockGroupBy: state.stockGroupBy });
  ensureValidStocksSort();
  render();
});
function syncProfitRangeFromInputs() {
  state.profitMin = parseOptionalNumber(el.profitMin.value);
  state.profitMax = parseOptionalNumber(el.profitMax.value);
  if (state.profitMin != null && state.profitMax != null && state.profitMin > state.profitMax) {
    [state.profitMin, state.profitMax] = [state.profitMax, state.profitMin];
  }
  savePrefs({ profitMin: state.profitMin, profitMax: state.profitMax });
  render();
}
function syncMaxBudgetFromInput() {
  const budget = parseOptionalNumber(el.maxBudget.value);
  state.maxBudget = budget != null && budget >= 0 ? budget : null;
  savePrefs({ maxBudget: state.maxBudget });
  render();
}
el.profitMin.addEventListener("change", syncProfitRangeFromInputs);
el.profitMax.addEventListener("change", syncProfitRangeFromInputs);
el.profitMin.addEventListener("keydown", (e) => {
  if (e.key === "Enter") syncProfitRangeFromInputs();
});
el.profitMax.addEventListener("keydown", (e) => {
  if (e.key === "Enter") syncProfitRangeFromInputs();
});
el.maxBudget.addEventListener("change", syncMaxBudgetFromInput);
el.maxBudget.addEventListener("keydown", (e) => {
  if (e.key === "Enter") syncMaxBudgetFromInput();
});
el.inStockOnly.addEventListener("change", () => {
  state.inStockOnly = el.inStockOnly.checked;
  savePrefs({ inStockOnly: state.inStockOnly });
  render();
});
el.showHidden.addEventListener("change", () => {
  state.showHidden = el.showHidden.checked;
  savePrefs({ showHidden: state.showHidden });
  render();
});

window.addEventListener("hiddenitemschange", () => {
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

el.homeMain.addEventListener("click", async (e) => {
  const sortBtn = e.target.closest(".column-sort");
  if (sortBtn) {
    e.stopPropagation();
    const column = sortBtn.dataset.sort;
    const target = sortBtn.dataset.sortTarget;
    if (!column || (target !== "favorites" && target !== "stocks")) return;
    const sortKey = target === "favorites" ? "favoritesSort" : "stocksSort";
    if (state[sortKey].column === column) {
      state[sortKey].dir = state[sortKey].dir === "asc" ? "desc" : "asc";
    } else {
      state[sortKey] = { column, dir: "asc" };
    }
    savePrefs({ [sortKey]: state[sortKey] });
    if (target === "favorites" && el.favorites?.querySelector(".favorites-card")) {
      renderFavoritesOnly();
    } else {
      render();
    }
    return;
  }
  const alarmBtn = e.target.closest("button.alarm-set-btn");
  if (alarmBtn) {
    e.stopPropagation();
    e.preventDefault();
    if (typeof toggleLeaveAlarm !== "function") return;
    const country = alarmBtn.dataset.country;
    const itemId = Number.parseInt(alarmBtn.dataset.itemId, 10);
    const windowIndex = Number(alarmBtn.dataset.windowIndex);
    const leaveEarliest = Number(alarmBtn.dataset.leaveEarliest);
    if (!country || !Number.isInteger(itemId) || !Number.isFinite(windowIndex) || !Number.isFinite(leaveEarliest)) {
      return;
    }
    await toggleLeaveAlarm({
      type: alarmBtn.dataset.alarmType || "leave_safe",
      country,
      itemId,
      itemName: alarmBtn.dataset.itemName || null,
      windowIndex,
      leaveEarliest,
    });
    renderFavoritesOnly();
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
  const hideBtn = e.target.closest(".hide-btn");
  if (hideBtn) {
    e.stopPropagation();
    const country = hideBtn.dataset.country;
    const itemId = Number.parseInt(hideBtn.dataset.item, 10);
    if (!country || !Number.isInteger(itemId)) return;
    toggleHidden(country, itemId);
    // render() runs via hiddenitemschange
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

window.addEventListener("restockamountchange", () => {
  render();
  loadSafeWindows();
});

window.addEventListener("alarmschange", () => {
  if (el.favorites?.querySelector(".favorites-card")) renderFavoritesOnly();
});

(async () => {
  await window.authReady;
  await loadCountries();
  await loadRestockAmounts();
  hydrateSafeWindowsFromCache();
  initFilterMenus();
  populateCountryFilter();
  populateItemTypeFilter();
  el.search.value = state.search;
  el.stockGroupBy.value = state.stockGroupBy;
  el.profitMin.value = state.profitMin ?? "";
  el.profitMax.value = state.profitMax ?? "";
  el.maxBudget.value = state.maxBudget ?? "";
  el.inStockOnly.checked = state.inStockOnly;
  el.showHidden.checked = state.showHidden;
  await Promise.all([loadMarketPrices(), loadItemTypes(), loadStocks()]);
  startStockUpdateWatcher(loadStocks);
  setInterval(loadMarketPrices, 60_000);
})();
