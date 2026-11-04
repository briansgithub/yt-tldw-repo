/* YT-TLDW — background service worker (GPL-3.0)
 * SponsorBlock API client adapted from ajayyy/SponsorBlock (GPL-3). */

const DEFAULTS = {
  enabled: false,
  method: "auto", // auto | api | dom
  debug: true,
};

const LOG_ENDPOINT = "http://127.0.0.1:47321/log";
let logBuffer = [];
let logTimer = null;

function queueLogs(lines) {
  if (!Array.isArray(lines) || !lines.length) return;
  for (const line of lines) {
    logBuffer.push(line);
  }
  if (logBuffer.length > 200) logBuffer.splice(0, logBuffer.length - 200);
  if (logTimer) return;
  logTimer = setTimeout(flushLogs, 350);
}

async function flushLogs() {
  logTimer = null;
  if (!logBuffer.length) return;
  const lines = logBuffer.splice(0, logBuffer.length);
  try {
    await fetch(LOG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines }),
    });
  } catch (_) {
    /* log server optional — ignore */
  }
}

async function getState() {
  const data = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...data };
}

async function setEnabled(enabled) {
  await chrome.storage.local.set({ enabled: !!enabled });
  await updateBadge(!!enabled);
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "YT_TLDW_STATE", enabled: !!enabled });
    } catch (_) {
      /* content script may not be ready */
    }
  }
}

async function updateBadge(enabled) {
  const text = enabled ? "ON" : "OFF";
  const color = enabled ? "#1a73e8" : "#666666";
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(null);
  const patch = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (cur[k] === undefined) patch[k] = v;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  const state = await getState();
  await updateBadge(state.enabled);
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();
  await updateBadge(state.enabled);
});

chrome.action.onClicked.addListener(async () => {
  const state = await getState();
  await setEnabled(!state.enabled);
});

/** SHA-256 once (SponsorBlock k-anonymity uses times=1 for videoID). */
async function sha256Hex(value) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Fetch skip segments via hashed prefix (SponsorBlock privacy method).
 * Categories: sponsor + selfpromo + interaction always; poi_highlight for fallback.
 */
async function fetchSponsorBlock(videoId) {
  const hash = await sha256Hex(videoId);
  const prefix = hash.slice(0, 4);
  const categories = encodeURIComponent(
    JSON.stringify(["sponsor", "selfpromo", "interaction", "poi_highlight", "filler", "intro", "outro"])
  );
  const actionTypes = encodeURIComponent(JSON.stringify(["skip", "mute", "poi", "full"]));
  const url =
    `https://sponsor.ajay.app/api/skipSegments/${prefix}?categories=${categories}&actionTypes=${actionTypes}`;
  const res = await fetch(url, {
    headers: { "X-CLIENT-NAME": "YT-TLDW/0.1.10" },
  });
  if (res.status === 404) return { ok: true, segments: [], status: 404 };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}`, segments: [] };
  }
  const data = await res.json();
  const match = Array.isArray(data) ? data.find((v) => v.videoID === videoId) : null;
  const segments = (match?.segments || []).map((s) => ({
    start: s.segment[0],
    end: s.segment[1],
    category: s.category,
    actionType: s.actionType,
    UUID: s.UUID,
  }));
  return { ok: true, segments, status: res.status, prefix };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "YT_TLDW_LOG") {
      queueLogs(msg.lines || []);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "YT_TLDW_GET_STATE") {
      sendResponse(await getState());
      return;
    }
    if (msg?.type === "YT_TLDW_SET_ENABLED") {
      await setEnabled(!!msg.enabled);
      sendResponse(await getState());
      return;
    }
    if (msg?.type === "YT_TLDW_TOGGLE") {
      const state = await getState();
      await setEnabled(!state.enabled);
      sendResponse(await getState());
      return;
    }
    if (msg?.type === "YT_TLDW_SPONSORBLOCK") {
      try {
        sendResponse(await fetchSponsorBlock(msg.videoId));
      } catch (e) {
        sendResponse({ ok: false, error: String(e), segments: [] });
      }
      return;
    }
    sendResponse({ ok: false, error: "unknown message" });
  })();
  return true;
});
