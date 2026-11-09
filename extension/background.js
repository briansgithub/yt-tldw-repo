/* YT-TLDW — background service worker (GPL-3.0)
 * SponsorBlock API client adapted from ajayyy/SponsorBlock (GPL-3). */

if (typeof importScripts === "function") {
  importScripts("lib/settings.js", "lib/queue-model.js", "lib/queue-sync.js", "queue-background.js");
}

const { DEFAULTS, GENRES, INTENSITIES, normalizeGenre, normalizeIntensity, normalizeMethod } =
  self.YtTldwSettings;
const extension = globalThis.browser || chrome;
const menus = extension.contextMenus;
const localLogging = !navigator.userAgent.includes("Firefox/");

const LOG_ENDPOINT = "http://127.0.0.1:47321/log";
let logBuffer = [];
let logTimer = null;
let menusReady = false;

/** Cached; refreshed from storage so log POSTs stop immediately when debug is off. */
let debugLogging = true;

function queueLogs(lines) {
  if (!debugLogging || !localLogging) return;
  if (!Array.isArray(lines) || !lines.length) return;
  for (const line of lines) logBuffer.push(line);
  if (logBuffer.length > 200) logBuffer.splice(0, logBuffer.length - 200);
  if (logTimer) return;
  logTimer = setTimeout(flushLogs, 350);
}

async function flushLogs() {
  logTimer = null;
  if (!debugLogging) {
    logBuffer.length = 0;
    return;
  }
  if (!logBuffer.length) return;
  const lines = logBuffer.splice(0, logBuffer.length);
  try {
    await fetch(LOG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines }),
    });
  } catch (_) {
    /* log server optional */
  }
}

async function getState() {
  const data = await extension.storage.local.get(DEFAULTS);
  return {
    ...DEFAULTS,
    ...data,
    genre: normalizeGenre(data.genre ?? DEFAULTS.genre),
    intensity: normalizeIntensity(data.intensity ?? DEFAULTS.intensity),
    method: normalizeMethod(data.method ?? DEFAULTS.method),
    enabled: !!(data.enabled ?? DEFAULTS.enabled),
    debug: data.debug !== false,
    autoJump: data.autoJump !== false,
  };
}

async function updateBadge(enabled) {
  if (!extension.action?.setBadgeText) return;
  const text = enabled ? "ON" : "OFF";
  const color = enabled ? "#1a73e8" : "#666666";
  try {
    await extension.action.setBadgeText({ text });
    await extension.action.setBadgeBackgroundColor?.({ color });
  } catch {
    // Some mobile toolbar implementations do not show a badge.
  }
}

async function notifyTabsEnabled(enabled) {
  const tabs = await extension.tabs.query({ url: ["https://www.youtube.com/*", "https://m.youtube.com/*"] });
  for (const tab of tabs) {
    try {
      await extension.tabs.sendMessage(tab.id, { type: "YT_TLDW_STATE", enabled: !!enabled });
    } catch (_) {
      /* content script may not be ready */
    }
  }
}

async function setEnabled(enabled) {
  await extension.storage.local.set({ enabled: !!enabled });
  await updateBadge(!!enabled);
  await syncContextMenus();
  await notifyTabsEnabled(!!enabled);
}

async function patchSettings(partial) {
  const patch = {};
  if (partial.enabled !== undefined) patch.enabled = !!partial.enabled;
  if (partial.genre !== undefined) patch.genre = normalizeGenre(partial.genre);
  if (partial.intensity !== undefined) patch.intensity = normalizeIntensity(partial.intensity);
  if (partial.method !== undefined) patch.method = normalizeMethod(partial.method);
  if (partial.debug !== undefined) patch.debug = !!partial.debug;
  if (partial.autoJump !== undefined) patch.autoJump = !!partial.autoJump;
  if (partial.applyAt !== undefined) patch.applyAt = Number(partial.applyAt) || Date.now();
  if (!Object.keys(patch).length) return getState();
  await extension.storage.local.set(patch);
  if (patch.debug !== undefined) {
    debugLogging = !!patch.debug;
    if (!debugLogging) {
      logBuffer.length = 0;
      if (logTimer) {
        clearTimeout(logTimer);
        logTimer = null;
      }
    }
  }
  if (patch.enabled !== undefined) {
    await updateBadge(!!patch.enabled);
    await notifyTabsEnabled(!!patch.enabled);
  }
  await syncContextMenus();
  return getState();
}

async function syncContextMenus() {
  if (!menus) return;
  const state = await getState();
  try {
    await menus.removeAll();
  } catch (_) {}

  menus.create({
    id: "yt-tldw-enabled",
    type: "checkbox",
    title: "On",
    contexts: ["action"],
    checked: !!state.enabled,
  });

  menus.create({
    id: "yt-tldw-debug",
    type: "checkbox",
    title: "Debug log",
    contexts: ["action"],
    checked: state.debug !== false,
  });

  menus.create({
    id: "yt-tldw-genre",
    title: "Genre",
    contexts: ["action"],
  });
  for (const g of GENRES) {
    menus.create({
      id: `yt-tldw-genre-${g.id}`,
      parentId: "yt-tldw-genre",
      type: "radio",
      title: g.label,
      contexts: ["action"],
      checked: state.genre === g.id,
    });
  }

  menus.create({
    id: "yt-tldw-intensity",
    title: "Intensity",
    contexts: ["action"],
  });
  for (const i of INTENSITIES) {
    menus.create({
      id: `yt-tldw-intensity-${i.id}`,
      parentId: "yt-tldw-intensity",
      type: "radio",
      title: i.label,
      contexts: ["action"],
      checked: state.intensity === i.id,
    });
  }
  menusReady = true;
}

extension.runtime.onInstalled.addListener(async () => {
  const state = await getState();
  debugLogging = state.debug !== false;
  await updateBadge(state.enabled);
  await syncContextMenus();
});

extension.runtime.onStartup.addListener(async () => {
  const state = await getState();
  debugLogging = state.debug !== false;
  await updateBadge(state.enabled);
  await syncContextMenus();
});

// Also rebuild menus when SW wakes (MV3 ephemeral)
getState()
  .then(async (state) => {
    debugLogging = state.debug !== false;
    await updateBadge(state.enabled);
    if (!menusReady) await syncContextMenus();
  })
  .catch(() => {});

menus?.onClicked.addListener(async (info) => {
  const id = info.menuItemId;
  if (id === "yt-tldw-enabled") {
    await setEnabled(!!info.checked);
    return;
  }
  if (id === "yt-tldw-debug") {
    await patchSettings({ debug: !!info.checked });
    return;
  }
  if (String(id).startsWith("yt-tldw-genre-")) {
    await patchSettings({ genre: String(id).replace("yt-tldw-genre-", "") });
    return;
  }
  if (String(id).startsWith("yt-tldw-intensity-")) {
    await patchSettings({ intensity: String(id).replace("yt-tldw-intensity-", "") });
  }
});

extension.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.debug) {
    debugLogging = changes.debug.newValue !== false;
    if (!debugLogging) {
      logBuffer.length = 0;
      if (logTimer) {
        clearTimeout(logTimer);
        logTimer = null;
      }
    }
  }
  if (changes.enabled || changes.genre || changes.intensity || changes.debug) {
    syncContextMenus().catch(() => {});
  }
  if (changes.enabled) {
    updateBadge(!!changes.enabled.newValue).catch(() => {});
  }
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
    headers: { "X-CLIENT-NAME": "YT-TLDW/" + extension.runtime.getManifest().version },
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

extension.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type?.startsWith("YT_TLDW_")) return false;
  (async () => {
    if (msg?.type === "YT_TLDW_LOG") {
      if (debugLogging) queueLogs(msg.lines || []);
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
    if (msg?.type === "YT_TLDW_SET_SETTINGS") {
      sendResponse(await patchSettings(msg.settings || {}));
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
  })().catch(() => sendResponse({ ok: false, error: "YT-TLDW request failed" }));
  return true;
});
