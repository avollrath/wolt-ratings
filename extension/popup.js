const syncBtn       = document.getElementById("sync-btn");
const resultBox     = document.getElementById("result-box");
const lastSyncedTxt = document.getElementById("last-synced-text");

// Auth indicator
const authIcon  = document.getElementById("auth-icon");
const authLabel = document.getElementById("auth-label");
const authSub   = document.getElementById("auth-sub");
const authDot   = document.getElementById("auth-dot");

// Server indicator
const serverIcon  = document.getElementById("server-icon");
const serverLabel = document.getElementById("server-label");
const serverSub   = document.getElementById("server-sub");
const serverDot   = document.getElementById("server-dot");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatAge(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function setDot(el, iconEl, state) {
  el.className = "status-dot";
  iconEl.className = "status-icon";
  if (state === "ok")    { el.classList.add("dot-green");  iconEl.classList.add("ok"); }
  if (state === "warn")  { el.classList.add("dot-yellow"); iconEl.classList.add("warn"); }
  if (state === "error") { el.classList.add("dot-red");    iconEl.classList.add("error"); }
}

// ---------------------------------------------------------------------------
// Server health check
// ---------------------------------------------------------------------------
let serverOk = false;

async function checkServer() {
  try {
    const res = await fetch("http://jonsbo.local/wolt-ratings/health", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error();
    const data = await res.json();
    setDot(serverDot, serverIcon, "ok");
    serverLabel.textContent = "Backend running";
    serverSub.textContent   = `${data.total_orders} order${data.total_orders !== 1 ? "s" : ""} in database`;
    if (data.last_synced) {
      const diff = Math.floor((Date.now() - new Date(data.last_synced)) / 1000);
      let label;
      if (diff < 60)    label = `${diff}s ago`;
      else if (diff < 3600)  label = `${Math.floor(diff / 60)}m ago`;
      else if (diff < 86400) label = `${Math.floor(diff / 3600)}h ago`;
      else label = new Date(data.last_synced).toLocaleDateString();
      lastSyncedTxt.textContent = `Last synced ${label}`;
    } else {
      lastSyncedTxt.textContent = "Never synced";
    }
    serverOk = true;
  } catch {
    setDot(serverDot, serverIcon, "error");
    serverLabel.textContent = "Backend unreachable";
    serverSub.textContent   = "Check jonsbo.local/wolt-ratings";
    lastSyncedTxt.textContent = "";
    serverOk = false;
  }
  updateSyncBtn();
}

// ---------------------------------------------------------------------------
// Auth status
// ---------------------------------------------------------------------------
let authOk = false;

function checkAuth() {
  chrome.runtime.sendMessage({ action: "getStatus" }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setDot(authDot, authIcon, "error");
      authLabel.textContent = "Extension error";
      authSub.textContent   = chrome.runtime.lastError?.message || "";
      authOk = false;
      updateSyncBtn();
      return;
    }

    if (response.hasCredentials) {
      const ago = formatAge(response.capturedAt);
      setDot(authDot, authIcon, "ok");
      authLabel.textContent = "Session token captured";
      authSub.textContent   = ago ? `Captured ${ago}` : "Ready";
      authOk = true;
    } else {
      setDot(authDot, authIcon, "warn");
      authLabel.textContent = "No valid session token";
      authSub.textContent   = "Open wolt.com to capture";
      authOk = false;
    }
    updateSyncBtn();
  });
}

// ---------------------------------------------------------------------------
// Sync button state
// ---------------------------------------------------------------------------
function updateSyncBtn() {
  syncBtn.disabled = !(authOk && serverOk);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
syncBtn.addEventListener("click", () => {
  syncBtn.disabled = true;
  syncBtn.textContent = "Syncing...";
  resultBox.style.display = "none";

  chrome.runtime.sendMessage({ action: "sync" }, (response) => {
    syncBtn.disabled = !(authOk && serverOk);
    syncBtn.textContent = "Sync Now";

    if (chrome.runtime.lastError) {
      showResult("error", "Extension error", chrome.runtime.lastError.message);
      return;
    }

    if (response.success) {
      const msg = response.new_orders === 0
        ? "Already up to date"
        : `${response.new_orders} new order${response.new_orders !== 1 ? "s" : ""} added`;

      showResult("success", msg, null, {
        "New orders":    response.new_orders,
        "Already saved": response.existing_orders,
        "Total":         response.total_orders,
      });

      // Refresh server stats after sync
      checkServer();
    } else {
      // If 401, auth is now invalid
      if (response.error?.includes("401") || response.error?.includes("expired")) {
        setDot(authDot, authIcon, "warn");
        authLabel.textContent = "Session expired";
        authSub.textContent   = "Reload wolt.com";
        authOk = false;
        updateSyncBtn();
      }
      showResult("error", "Sync failed", response.error);
    }
  });
});

// ---------------------------------------------------------------------------
// Result display
// ---------------------------------------------------------------------------
function showResult(type, title, message, stats) {
  resultBox.className = `result ${type}`;

  const icon = type === "success" ? "OK" : "Error";
  let html = `<div class="result-title">${icon} ${escHtml(title)}</div>`;

  if (stats && type === "success") {
    html += Object.entries(stats).map(([k, v]) =>
      `<div class="result-stat"><span>${k}</span><span>${v}</span></div>`
    ).join("");
  } else if (message) {
    html += `<div style="margin-top:2px;opacity:.8">${escHtml(message)}</div>`;
  }

  resultBox.innerHTML = html;
  resultBox.style.display = "block";
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Boot - check server in parallel with auth status.
checkAuth();
checkServer();
setInterval(checkAuth, 10_000);

