// Decode a JWT and return its payload, or null if malformed
function decodeJwt(token) {
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}

// Returns true if the stored Bearer token exists and hasn't expired
function isTokenValid(auth) {
  if (!auth) return false;
  const raw = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  const payload = decodeJwt(raw);
  if (!payload?.exp) return false;
  // Give a 60-second buffer so we don't show green right before expiry
  return payload.exp > Math.floor(Date.now() / 1000) + 60;
}

let badgeState = null; // "ready" | "expired" | null

function setBadgeReady() {
  if (badgeState === "ready") return;
  badgeState = "ready";
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setIcon({
    path: {
      16: "icons/icon16-ready.png",
      48: "icons/icon48-ready.png",
      128: "icons/icon128-ready.png",
    },
  });
}

function setBadgeExpired() {
  if (badgeState === "expired") return;
  badgeState = "expired";
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setIcon({
    path: {
      16: "icons/icon16.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png",
    },
  });
}

function invalidateCredentials() {
  chrome.storage.session.remove(["wolt_auth", "wolt_session_id", "captured_at"]);
  setBadgeExpired();
}

// Restore badge state on service worker startup - check token expiry
chrome.storage.session.get("wolt_auth", (data) => {
  if (isTokenValid(data.wolt_auth)) {
    setBadgeReady();
  } else if (data.wolt_auth) {
    // Token present but expired - clear it
    invalidateCredentials();
  }
});

// Fallback: intercept Wolt API request headers when service worker is alive
let lastSeenAuth = null;
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    let auth = null;
    let sessionId = null;
    for (const header of details.requestHeaders || []) {
      const name = header.name.toLowerCase();
      if (name === "authorization" && header.value?.startsWith("Bearer ")) auth = header.value;
      if (name === "wolt-session-id") sessionId = header.value;
    }
    if (auth && isTokenValid(auth) && auth !== lastSeenAuth) {
      lastSeenAuth = auth;
      chrome.storage.session.set({
        wolt_auth: auth,
        ...(sessionId && { wolt_session_id: sessionId }),
        captured_at: Date.now(),
      });
      setBadgeReady();
    }
  },
  { urls: ["https://consumer-api.wolt.com/*"] },
  ["requestHeaders", "extraHeaders"]
);

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Primary credential capture: content script read token from localStorage
  if (message.action === "storeCredentials") {
    if (!isTokenValid(message.authorization)) return;
    if (message.authorization === lastSeenAuth) return;
    lastSeenAuth = message.authorization;
    const update = {
      wolt_auth: message.authorization,
      captured_at: Date.now(),
    };
    if (message.sessionId) update.wolt_session_id = message.sessionId;
    chrome.storage.session.set(update);
    setBadgeReady();
    return;
  }

  if (message.action === "sync") {
    handleSync()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getStatus") {
    chrome.storage.session.get(
      ["wolt_auth", "wolt_session_id", "captured_at"],
      (data) => {
        const valid = isTokenValid(data.wolt_auth);
        if (!valid) invalidateCredentials();
        sendResponse({
          hasCredentials: valid,
          capturedAt: valid ? (data.captured_at || null) : null,
        });
      }
    );
    return true;
  }
});

async function handleSync() {
  const data = await chrome.storage.session.get(["wolt_auth", "wolt_session_id"]);

  if (!isTokenValid(data.wolt_auth)) {
    invalidateCredentials();
    throw new Error("Session expired. Reload wolt.com to capture a fresh token.");
  }

  const reqHeaders = {
    Authorization: data.wolt_auth,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  };
  if (data.wolt_session_id) reqHeaders["wolt-session-id"] = data.wolt_session_id;

  const orders = [];
  let cursor = null;

  do {
    const url = new URL("https://consumer-api.wolt.com/order-tracking-api/v1/order_history/");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);

    const woltRes = await fetch(url.toString(), { headers: reqHeaders });

    if (woltRes.status === 401) {
      invalidateCredentials();
      throw new Error("Session expired (401). Reload wolt.com to capture a fresh token.");
    }

    if (!woltRes.ok) {
      const text = await woltRes.text();
      throw new Error(`Wolt API error ${woltRes.status}: ${text}`);
    }

    const page = await woltRes.json();
    orders.push(...(Array.isArray(page.orders) ? page.orders : []));
    cursor = page.next_cursor || page.nextCursor || page.cursor_next || page.next || null;
  } while (cursor);

  const backendRes = await fetch("http://jonsbo.local/wolt-ratings/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orders }),
    signal: AbortSignal.timeout(8000),
  });

  if (!backendRes.ok) {
    const text = await backendRes.text();
    throw new Error(`Backend error ${backendRes.status}: ${text}`);
  }

  const result = await backendRes.json();
  return { success: true, ...result };
}
