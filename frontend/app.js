const API_BASE = `${window.location.origin}/wolt-ratings`;

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {}
    throw new ApiError(message, res.status);
  }
  return res;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allOrders = [];
let lastSynced = null;
let demoMode = localStorage.getItem("demoMode") === "1";

// Infinite scroll
const PAGE_SIZE = 25;
let visibleCount = PAGE_SIZE;
let currentList  = [];

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const tbody            = document.getElementById("orders-tbody");
const searchInput      = document.getElementById("search-input");
const onlyRatedChk     = document.getElementById("only-rated");
const sortSelect       = document.getElementById("sort-select");
const countLabel       = document.getElementById("order-count");
const lastSyncedLabel  = document.getElementById("last-synced-label");
const tableContainer   = document.getElementById("table-container");
const emptyState       = document.getElementById("empty-state");
const errorState       = document.getElementById("error-state");
const loadingState     = document.getElementById("loading-state");
const skeletonTbody    = document.getElementById("skeleton-tbody");
const yearSelect       = document.getElementById("year-select");
const exportBtn        = document.getElementById("export-btn");
const importBtn        = document.getElementById("import-btn");
const importFile       = document.getElementById("import-file");
const demoBtn          = document.getElementById("demo-btn");
const perVenueChk      = document.getElementById("per-venue");
const unratedCard      = document.getElementById("stat-unrated-card");
const modalBackdrop    = document.getElementById("modal-backdrop");
const modalClose       = document.getElementById("modal-close");
const scrollSentinel   = document.getElementById("scroll-sentinel");

// ---------------------------------------------------------------------------
// Star SVG
// ---------------------------------------------------------------------------
const STAR_PATH = `<path d="M16.926 20.2a1 1 0 0 1-.466-.115l-4.471-2.352-4.471 2.348a1 1 0 0 1-1.451-1.054l.854-4.98L3.3 10.521a1 1 0 0 1 .555-1.706l5-.727 2.237-4.531A1 1 0 0 1 11.989 3a1 1 0 0 1 .9.558l2.236 4.53 5 .727a1 1 0 0 1 .555 1.706l-3.618 3.527.854 4.98a1 1 0 0 1-.99 1.172z"/>`;

function starSvg(filled, size = 26) {
  const color = filled ? "#00C2E8" : "#d1d5db";
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="${color}">${STAR_PATH}</svg>`;
}

// ---------------------------------------------------------------------------
// Skeleton rows
// ---------------------------------------------------------------------------
function buildSkeletonRows(n = 8) {
  const widths = [60, 80, 160, 160, 50, 110, 140];
  skeletonTbody.innerHTML = Array.from({ length: n }, () => `
    <tr class="skeleton-row">
      ${widths.map(w => `<td><span class="skeleton" style="width:${w}px;height:13px"></span></td>`).join("")}
    </tr>`).join("");
}

// ---------------------------------------------------------------------------
// Fetch & render
// ---------------------------------------------------------------------------
async function loadOrders() {
  buildSkeletonRows();
  try {
    const res = await apiFetch(`/orders${demoMode ? "?demo=1" : ""}`);
    const data = await res.json();
    // Always exclude failed orders
    allOrders = (data.orders || []).filter(o => o.status === "delivered");
    lastSynced = data.last_synced || null;
    updateLastSynced();
    populateYearSelect();
    renderTable();
  } catch {
    loadingState.style.display = "none";
    errorState.style.display = "flex";
  }
}

function updateLastSynced() {
  if (!lastSynced) { lastSyncedLabel.textContent = "Never synced"; return; }
  const diff = Math.floor((Date.now() - new Date(lastSynced)) / 1000);
  let label;
  if (diff < 0 || diff > 86400 * 365) label = new Date(lastSynced).toLocaleString();
  else if (diff < 60)    label = `${diff}s ago`;
  else if (diff < 3600)  label = `${Math.floor(diff / 60)}m ago`;
  else if (diff < 86400) label = `${Math.floor(diff / 3600)}h ago`;
  else if (diff < 86400 * 30) label = `${Math.floor(diff / 86400)}d ago`;
  else                   label = new Date(lastSynced).toLocaleDateString();
  lastSyncedLabel.textContent = `Last synced ${label}`;
}

function populateYearSelect() {
  const current = yearSelect.value;
  const years = [...new Set(allOrders.map(o => o.received_at?.split("/")[2]?.split(",")[0]).filter(Boolean))].sort((a, b) => b - a);
  yearSelect.innerHTML = `<option value="all">All years</option>` +
    years.map(y => `<option value="${y}"${y === current ? " selected" : ""}>${y}</option>`).join("");
}

function venueRatingScore(orders) {
  const rated = orders.filter(o => o.user_custom_data?.rating > 0);
  const avg = rated.length ? rated.reduce((s, o) => s + o.user_custom_data.rating, 0) / rated.length : 0;
  return avg * Math.log(rated.length + 1);
}

function aggregateByVenue(orders) {
  const map = new Map();
  for (const o of orders) {
    if (!map.has(o.venue_name)) map.set(o.venue_name, []);
    map.get(o.venue_name).push(o);
  }
  return [...map.entries()].map(([venue_name, group]) => {
    const sorted = group.slice().sort((a, b) => compareDates(a.received_at, b.received_at));
    const totalAmountEur = group.reduce((s, o) => s + amountEur(o), 0);
    const rated = group.filter(o => o.user_custom_data?.rating > 0);
    const avgRating = rated.length
      ? rated.reduce((s, o) => s + o.user_custom_data.rating, 0) / rated.length
      : 0;
    return {
      _venueRow: true,
      purchase_id: `venue-${venue_name}`,
      venue_name,
      received_at: sorted[0].received_at,
      received_at_last: sorted[sorted.length - 1].received_at,
      total_amount_eur: totalAmountEur,
      user_custom_data: { rating: Math.round(avgRating * 10) / 10, notes: "" },
      _avgRating: avgRating,
      _orderCount: group.length,
    };
  });
}

function getFiltered() {
  const q         = searchInput.value.trim().toLowerCase();
  const onlyRated = onlyRatedChk.checked;
  const perVenue  = perVenueChk.checked;
  const sort      = sortSelect.value;
  const year      = yearSelect.value;

  let list = allOrders.filter(o => {
    if (onlyRated && (!o.user_custom_data || o.user_custom_data.rating === 0)) return false;
    if (q && !`${o.venue_name} ${o.items}`.toLowerCase().includes(q)) return false;
    if (year !== "all" && !o.received_at?.includes(`/${year},`)) return false;
    return true;
  });

  if (perVenue) list = aggregateByVenue(list);

  if (sort === "rating_desc") {
    if (perVenue) {
      return list.slice().sort((a, b) => (b._avgRating || 0) * Math.log((b._orderCount || 1) + 1) - (a._avgRating || 0) * Math.log((a._orderCount || 1) + 1));
    }
    const venueScore = {};
    const venueGroups = {};
    for (const o of allOrders) {
      if (!venueGroups[o.venue_name]) venueGroups[o.venue_name] = [];
      venueGroups[o.venue_name].push(o);
    }
    for (const [venue, orders] of Object.entries(venueGroups)) {
      venueScore[venue] = venueRatingScore(orders);
    }
    return list.slice().sort((a, b) => (venueScore[b.venue_name] || 0) - (venueScore[a.venue_name] || 0));
  }

  return list.slice().sort((a, b) => {
    if (sort === "date_desc")   return compareDates(b._venueRow ? b.received_at_last : b.received_at, a._venueRow ? a.received_at_last : a.received_at);
    if (sort === "date_asc")    return compareDates(a.received_at, b.received_at);
    if (sort === "value_desc")  return amountEur(b) - amountEur(a);
    if (sort === "venue_asc")   return a.venue_name.localeCompare(b.venue_name);
    return 0;
  });
}

function renderTable(resetScroll = true) {
  loadingState.style.display = "none";

  currentList = getFiltered();
  if (resetScroll) visibleCount = PAGE_SIZE;

  updateStats(perVenueChk.checked ? allOrders : currentList);
  countLabel.textContent = perVenueChk.checked
    ? `${currentList.length} venues`
    : `${currentList.length} of ${allOrders.length} orders`;

  if (allOrders.length === 0) {
    tableContainer.classList.add("hidden");
    emptyState.style.display = "flex";
    return;
  }

  emptyState.style.display = "none";
  tableContainer.classList.remove("hidden");

  renderRows();
}

function renderRows() {
  tbody.innerHTML = "";
  const slice = currentList.slice(0, visibleCount);
  for (const order of slice) {
    const row = document.createElement("tr");
    row.className = "row-fade";
    row.dataset.id = order.purchase_id;
    row.innerHTML = renderRowHtml(order);
    bindRowEvents(row, order);
    tbody.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Infinite scroll via IntersectionObserver
// ---------------------------------------------------------------------------
const scrollObserver = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && visibleCount < currentList.length) {
    visibleCount += PAGE_SIZE;
    renderRows();
  }
}, { rootMargin: "200px" });

if (scrollSentinel) scrollObserver.observe(scrollSentinel);

const tableCard = document.getElementById("table-card");
const gradientObserver = new IntersectionObserver((entries) => {
  if (tableCard) tableCard.classList.toggle("scroll-end", entries[0].isIntersecting);
}, { rootMargin: "0px 0px -42px 0px" });
if (scrollSentinel) gradientObserver.observe(scrollSentinel);

// ---------------------------------------------------------------------------
// Stats - delivered only (failed already excluded from allOrders)
// ---------------------------------------------------------------------------
function updateStats(list) {
  const priced = list.filter(hasEurAmount);
  const spent = priced.reduce((sum, o) => sum + amountEur(o), 0);
  document.getElementById("stat-count").textContent      = list.length;
  document.getElementById("stat-spent").textContent      = priced.length ? fmtEuro(spent) : "-";
  document.getElementById("stat-avg-value").textContent  =
    priced.length ? fmtEuro(spent / priced.length) : "-";

  const rated = list.filter(o => o.user_custom_data?.rating > 0);
  const avgRating = rated.length
    ? (rated.reduce((s, o) => s + o.user_custom_data.rating, 0) / rated.length).toFixed(1)
    : "-";
  document.getElementById("stat-avg-rating-text").textContent = avgRating !== "-" ? avgRating : "-";
  document.getElementById("stat-avg-rating-star").style.display = "none";

  const venueCount = {};
  const venueSpent = {};
  for (const o of list) {
    venueCount[o.venue_name] = (venueCount[o.venue_name] || 0) + 1;
    venueSpent[o.venue_name] = (venueSpent[o.venue_name] || 0) + amountEur(o);
  }
  const topVenue = Object.entries(venueCount).sort((a, b) => b[1] - a[1])[0];
  document.getElementById("stat-top-venue").textContent = topVenue ? topVenue[0] : "-";
  document.getElementById("stat-top-venue-sub").textContent = topVenue
    ? `${topVenue[1]} order${topVenue[1] !== 1 ? "s" : ""} - ${fmtEuro(venueSpent[topVenue[0]])}` : "";

  const unratedCount = list.filter(o => !o.user_custom_data?.rating).length;
  document.getElementById("stat-unrated").textContent = unratedCount;
}

function amountEur(order) {
  const amount = Number(order?.total_amount_eur);
  return Number.isFinite(amount) ? amount : 0;
}

function hasEurAmount(order) {
  return Number.isFinite(Number(order?.total_amount_eur));
}

function fmtEuro(amount) {
  return `${amount.toFixed(2).replace(".", ",")}\u20ac`;
}

function convertedAmountHtml(order) {
  if (!hasEurAmount(order) || order.total_amount_currency === "EUR") return "";
  return `<div class="converted-amount">${escHtml(fmtEuro(amountEur(order)))}</div>`;
}

function originalAmount(order) {
  return order.total_amount || "-";
}

// ---------------------------------------------------------------------------
// Row builder
// ---------------------------------------------------------------------------
function renderRowHtml(order) {
  const userCustomData = order.user_custom_data || { rating: 0, notes: "", last_edited: null };

  if (order._venueRow) {
    const rating = order._avgRating || 0;
    const starsHtml = [1,2,3,4,5].map(v =>
      `<span class="modal-mini-star">${starSvg(v <= Math.round(rating), 26)}</span>`
    ).join("");
    const dateCell = order.received_at_last && order.received_at_last !== order.received_at
      ? `<div>${escHtml(order.received_at)}</div><div class="venue-row-date-last">${escHtml(order.received_at_last)}</div>`
      : escHtml(order.received_at);
    return `
      <td class="order-date-cell">${dateCell}</td>
      <td><button class="venue-link" title="${escHtml(order.venue_name)}">${escHtml(order.venue_name)}</button></td>
      <td class="items-cell venue-row-na">-</td>
      <td class="total-cell text-right">${escHtml(fmtEuro(amountEur(order)))}</td>
      <td><div class="stars-wrap">${starsHtml}</div></td>
      <td class="venue-row-na">-</td>`;
  }

  return `
    <td class="order-date-cell">${escHtml(order.received_at)}</td>
    <td><button class="venue-link" title="${escHtml(order.venue_name)}">${escHtml(order.venue_name)}</button></td>
    <td class="items-cell">
      ${splitItems(order.items).map(i => `<div class="item-line">${escHtml(i)}</div>`).join("")}
    </td>
    <td class="total-cell text-right">${escHtml(originalAmount(order))}${convertedAmountHtml(order)}</td>
    <td><div class="stars-wrap" id="stars-${escHtml(order.purchase_id)}">${buildStars(userCustomData.rating, order.purchase_id)}</div></td>
    <td>
      <textarea class="notes-area" placeholder="Add a note..." data-id="${escHtml(order.purchase_id)}">${escHtml(userCustomData.notes)}</textarea>
    </td>`;
}

function bindRowEvents(rowElement, order) {
  if (order._venueRow) {
    rowElement.querySelector(".venue-link").addEventListener("click", () => openModal(order.venue_name));
    return;
  }

  const userCustomData = order.user_custom_data || { rating: 0, notes: "", last_edited: null };
  order.user_custom_data = userCustomData;

  rowElement.querySelector(".venue-link").addEventListener("click", () => openModal(order.venue_name));
  bindStars(rowElement, order);

  const textarea = rowElement.querySelector("textarea");
  textarea.addEventListener("blur", () => {
    const notes = textarea.value;
    if (notes !== userCustomData.notes) {
      const previousNotes = userCustomData.notes;
      userCustomData.notes = notes;
      saveUpdate(order.purchase_id, { notes }, () => {
        userCustomData.notes = previousNotes;
        textarea.value = previousNotes;
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Stars — SVG
// ---------------------------------------------------------------------------
function buildStars(current, id) {
  return [1, 2, 3, 4, 5].map(v =>
    `<button class="star-btn${v <= current ? " filled" : ""}" data-id="${escHtml(id)}" data-value="${v}" title="${v} star${v > 1 ? "s" : ""}">${starSvg(v <= current)}</button>`
  ).join("");
}

function bindStars(tr, order) {
  const wrap = tr.querySelector(".stars-wrap");
  const userCustomData = order.user_custom_data;

  wrap.querySelectorAll(".star-btn").forEach(btn => {
    btn.addEventListener("mouseenter", () => {
      const hv = parseInt(btn.dataset.value, 10);
      wrap.querySelectorAll(".star-btn").forEach(b => {
        const v = parseInt(b.dataset.value, 10);
        b.innerHTML = starSvg(v <= hv);
      });
    });
    btn.addEventListener("mouseleave", () => {
      wrap.querySelectorAll(".star-btn").forEach(b => {
        const v = parseInt(b.dataset.value, 10);
        b.innerHTML = starSvg(v <= userCustomData.rating);
      });
    });
    btn.addEventListener("click", () => {
      const rating = parseInt(btn.dataset.value, 10);
      const previousRating = userCustomData.rating;
      userCustomData.rating = rating;
      wrap.innerHTML = buildStars(rating, order.purchase_id);
      bindStars(tr, order);
      updateStats(currentList);
      saveUpdate(order.purchase_id, { rating }, () => {
        userCustomData.rating = previousRating;
        wrap.innerHTML = buildStars(previousRating, order.purchase_id);
        bindStars(tr, order);
        updateStats(currentList);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Restaurant detail modal
// ---------------------------------------------------------------------------
function openModal(venueName) {
  const venueOrders = allOrders
    .filter(o => o.venue_name === venueName)
    .sort((a, b) => compareDates(b.received_at, a.received_at));
  const stats = getVenueStats(venueOrders, venueName);
  renderModal(venueName, stats, buildModalOrderHistory(venueOrders), venueOrders);
  modalBackdrop.classList.add("open");
  document.body.style.overflow = "hidden";
}

function getVenueStats(orders, venueName) {
  const spent = orders.reduce((s, o) => s + amountEur(o), 0);
  const rated = orders.filter(o => o.user_custom_data?.rating > 0);
  const avgRating = rated.length
    ? (rated.reduce((s, o) => s + o.user_custom_data.rating, 0) / rated.length).toFixed(1)
    : "-";

  const itemFreq = {};
  for (const order of orders) {
    for (const item of splitItems(order.items)) {
      itemFreq[item] = (itemFreq[item] || 0) + 1;
    }
  }

  return {
    venueName,
    orderCount: orders.length,
    spent,
    avgRating,
    firstOrder: orders[orders.length - 1]?.received_at || "",
    topItems: Object.entries(itemFreq).sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}

function buildModalStars(rating, purchaseId) {
  return [1, 2, 3, 4, 5].map(v =>
    `<button class="star-btn${v <= rating ? " filled" : ""}" data-id="${escHtml(purchaseId)}" data-value="${v}" title="${v} star${v > 1 ? "s" : ""}">${starSvg(v <= rating, 26)}</button>`
  ).join("");
}

function bindModalStars(container, order) {
  const userCustomData = order.user_custom_data;
  container.querySelectorAll(".star-btn").forEach(btn => {
    btn.addEventListener("mouseenter", () => {
      const hv = parseInt(btn.dataset.value, 10);
      container.querySelectorAll(".star-btn").forEach(b =>
        b.innerHTML = starSvg(parseInt(b.dataset.value, 10) <= hv, 26)
      );
    });
    btn.addEventListener("mouseleave", () => {
      container.querySelectorAll(".star-btn").forEach(b =>
        b.innerHTML = starSvg(parseInt(b.dataset.value, 10) <= userCustomData.rating, 26)
      );
    });
    btn.addEventListener("click", () => {
      const rating = parseInt(btn.dataset.value, 10);
      const previousRating = userCustomData.rating;
      userCustomData.rating = rating;
      container.innerHTML = buildModalStars(rating, order.purchase_id);
      bindModalStars(container, order);
      // Keep main table in sync
      const tableStarsWrap = document.getElementById(`stars-${order.purchase_id}`);
      if (tableStarsWrap) {
        tableStarsWrap.innerHTML = buildStars(rating, order.purchase_id);
        const tr = tableStarsWrap.closest("tr");
        if (tr) bindStars(tr, order);
      }
      updateStats(currentList);
      saveUpdate(order.purchase_id, { rating }, () => {
        userCustomData.rating = previousRating;
        container.innerHTML = buildModalStars(previousRating, order.purchase_id);
        bindModalStars(container, order);
      });
    });
  });
}

function buildModalOrderHistory(orders) {
  return orders.map(order => {
    const userCustomData = order.user_custom_data || { rating: 0, notes: "" };
    order.user_custom_data = userCustomData;
    const itemLines = splitItems(order.items)
      .map(item => `<div class="modal-item-line">${escHtml(item)}</div>`)
      .join("") || escHtml(order.items || "-");
    return `
      <div class="modal-order-row" data-purchase-id="${escHtml(order.purchase_id)}">
        <div class="modal-order-date">${escHtml(order.received_at)}</div>
        <div class="modal-order-items">
          ${itemLines}
          ${userCustomData.notes ? `<div class="modal-order-note">${escHtml(userCustomData.notes)}</div>` : ""}
        </div>
        <div class="modal-order-total">${escHtml(originalAmount(order))}${convertedAmountHtml(order)}</div>
        <div class="modal-order-stars" id="modal-stars-${escHtml(order.purchase_id)}">${buildModalStars(userCustomData.rating, order.purchase_id)}</div>
      </div>`;
  }).join("");
}

function renderModal(venue, stats, historyHtml, venueOrders) {
  document.getElementById("modal-venue-name").textContent = venue;
  document.getElementById("modal-venue-sub").textContent = `First order ${stats.firstOrder}`;
  document.getElementById("modal-stat-orders").textContent = stats.orderCount;
  document.getElementById("modal-stat-spent").textContent = fmtEuro(stats.spent);
  document.getElementById("modal-stat-rating-text").textContent = stats.avgRating !== "-" ? stats.avgRating : "-";
  document.getElementById("modal-stat-rating-star").style.display = stats.avgRating !== "-" ? "inline" : "none";

  document.getElementById("modal-items-list").innerHTML = stats.topItems.length
    ? stats.topItems.map(([name, count]) => `
        <span class="item-chip">
          ${escHtml(name)}
          ${count > 1 ? `<span class="item-chip-count">x${count}</span>` : ""}
        </span>`).join("")
    : `<p class="modal-empty-text">No item data available.</p>`;
  document.getElementById("modal-orders-list").innerHTML = historyHtml;

  venueOrders.forEach(order => {
    const container = document.getElementById(`modal-stars-${order.purchase_id}`);
    if (container) bindModalStars(container, order);
  });
}
function closeModal() {
  modalBackdrop.classList.remove("open");
  document.body.style.overflow = "";
}

modalClose.addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", e => { if (e.target === modalBackdrop) closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
const toastContainer = document.getElementById("toast-container");

function showToast(message, type = "info", duration = 4000) {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("out");
    toast.addEventListener("animationend", () => toast.remove());
  }, duration);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
importBtn.addEventListener("click", () => { if (!demoMode) importFile.click(); });

importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  if (!file) return;
  importFile.value = "";
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    const res  = await apiFetch("/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(json),
    });
    const result = await res.json();
    showToast(`Imported ${result.new_orders} new orders (${result.total_orders} total)`, "success");
    loadOrders();
  } catch (err) {
    showToast("Import failed - invalid file or backend not running", "error");
  }
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
exportBtn.addEventListener("click", async () => {
  if (demoMode) return;
  try {
    const res = await apiFetch("/export");
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = "orders_db.json"; a.click();
    URL.revokeObjectURL(url);
  } catch {
    showToast("Export failed - is the backend running?", "error");
  }
});

// ---------------------------------------------------------------------------
// Unrated card shortcut
// ---------------------------------------------------------------------------
unratedCard.addEventListener("click", () => {
  onlyRatedChk.checked = false;
  document.getElementById("chip-only-rated").classList.remove("active");
  searchInput.value = "";

  const list = allOrders.filter(o => !o.user_custom_data?.rating);
  currentList  = list;
  visibleCount = PAGE_SIZE;
  updateStats(list);
  countLabel.textContent = `${list.length} of ${allOrders.length} orders`;
  emptyState.style.display = list.length === 0 ? "flex" : "none";
  tableContainer.classList.toggle("hidden", list.length === 0);
  renderRows();
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function saveUpdate(purchaseId, fields, revert) {
  if (demoMode) return;
  try {
    await apiFetch("/orders/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purchase_id: purchaseId, ...fields }),
    });
  } catch (err) {
    revert?.();
    showToast(`Save failed - ${err.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function compareDates(a, b) { return parseDate(a) - parseDate(b); }

function parseDate(str) {
  if (!str) return 0;
  const [datePart, timePart] = str.split(", ");
  if (!datePart) return 0;
  const [d, m, y] = datePart.split("/");
  return new Date(`${y}-${m}-${d}T${timePart || "00:00"}:00`).getTime();
}

function splitItems(str) {
  if (!str) return [];
  return str.split(" and ").map(s => s.trim()).filter(Boolean);
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
searchInput.addEventListener("input", () => renderTable(true));
sortSelect.addEventListener("change", () => renderTable(true));
yearSelect.addEventListener("change", () => renderTable(true));

onlyRatedChk.addEventListener("change", () => {
  onlyRatedChk.closest(".filter-chip").classList.toggle("active", onlyRatedChk.checked);
  renderTable(true);
});

perVenueChk.addEventListener("change", () => {
  perVenueChk.closest(".filter-chip").classList.toggle("active", perVenueChk.checked);
  renderTable(true);
});

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------
function applyDemoMode() {
  demoBtn.classList.toggle("active", demoMode);
  importBtn.disabled = demoMode;
  exportBtn.disabled = demoMode;
}

demoBtn.addEventListener("click", () => {
  demoMode = !demoMode;
  localStorage.setItem("demoMode", demoMode ? "1" : "0");
  applyDemoMode();
  loadOrders();
});

applyDemoMode();

setInterval(updateLastSynced, 60_000);

loadOrders();
