/* YT-TLDW content script (isolated world) — GPL-3.0
 * Skip scheduling inspired by SponsorBlock (ajayyy/SponsorBlock). */

(() => {
  const BRIDGE = "YT_TLDW_BRIDGE";
  const BTN_ID = "yt-tldw-player-btn";
  const DEBUG_ID = "yt-tldw-debug";
  const PANEL_ID = "yt-tldw-moments";
  const STORAGE_DEFAULTS = { enabled: false, method: "auto", debug: true, askTemplate: null, momentsPanelCollapsed: false };

  let enabled = false;
  let method = "auto";
  let debug = true;
  let askTemplate = null;
  let videoId = null;
  let playableWindows = [];
  let sponsorSkips = [];
  let scheduleTimer = null;
  let scheduleInterval = null;
  /** @type {any} */
  let previewBar = null;
  let runningForId = null;
  let runToken = 0;
  let bridgeReady = false;
  let pending = new Map();
  let reqSeq = 0;
  let lastDebug = [];
  let btnStatus = "idle"; // idle | loading | ready | error
  let btnCount = 0;
  /** @type {Map<string, {moments:any[], used:string, at:number}>} */
  const momentsMemCache = new Map();

  const SKIP_BUFFER = 0.12;
  const DOM_BRIDGE_TIMEOUT_MS = 32000;
  const RUN_HARD_TIMEOUT_MS = 45000;
  const DEFAULT_MOMENT_DUR = 35;
  const ASK_WAIT_MS = 15000;

  function log(...args) {
    console.log("[YT-TLDW]", ...args);
  }

  let renderDebugTimer = null;
  let logFlushTimer = null;
  const remoteLogQueue = [];
  const LOG_CAP = 40;

  function enqueueRemoteLog(row) {
    remoteLogQueue.push(row);
    if (remoteLogQueue.length > 80) remoteLogQueue.splice(0, remoteLogQueue.length - 80);
    if (logFlushTimer) return;
    logFlushTimer = setTimeout(flushRemoteLogs, 400);
  }

  function flushRemoteLogs() {
    logFlushTimer = null;
    if (!remoteLogQueue.length) return;
    const lines = remoteLogQueue.splice(0, remoteLogQueue.length);
    try {
      chrome.runtime.sendMessage({ type: "YT_TLDW_LOG", lines }, () => void chrome.runtime.lastError);
    } catch (_) {}
  }

  function debugPush(entry) {
    const clean = { ...entry };
    if (clean.nearbyLabels) delete clean.nearbyLabels;
    if (clean.snap?.nearbyLabels) {
      clean.snap = { ...clean.snap };
      delete clean.snap.nearbyLabels;
      delete clean.snap.askButtons;
    }
    // Drop huge previews from UI/remote spam
    if (typeof clean.rawTextPreview === "string" && clean.rawTextPreview.length > 240) {
      clean.rawTextPreview = clean.rawTextPreview.slice(0, 240);
    }
    if (typeof clean.responsePreview === "string" && clean.responsePreview.length > 180) {
      clean.responsePreview = clean.responsePreview.slice(0, 180);
    }
    const row = { t: new Date().toISOString(), videoId: videoId || getVideoIdFromUrl(), ...clean };
    lastDebug.push(row);
    if (lastDebug.length > LOG_CAP) lastDebug.shift();
    log(clean.event || clean, clean.count != null ? clean.count : "");
    enqueueRemoteLog(row);
    scheduleRenderDebug();
  }

  function scheduleRenderDebug() {
    if (renderDebugTimer) return;
    renderDebugTimer = setTimeout(() => {
      renderDebugTimer = null;
      renderDebug();
    }, 300);
  }

  function renderDebug() {
    let el = document.getElementById(DEBUG_ID);
    if (!debug || !enabled) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("div");
      el.id = DEBUG_ID;
      // Mark so our MutationObserver ignores it
      el.dataset.ytTldwUi = "1";
      document.documentElement.appendChild(el);
      el.addEventListener("click", (ev) => {
        const t = ev.target;
        if (t?.id === "yt-tldw-debug-x") {
          debug = false;
          el.remove();
        } else if (t?.id === "yt-tldw-debug-copy") {
          const text = lastDebug.map((r) => JSON.stringify(r)).join("\n");
          navigator.clipboard.writeText(text).then(
            () => debugPush({ event: "log-copied", chars: text.length }),
            () => {
              const ta = document.createElement("textarea");
              ta.value = text;
              document.body.appendChild(ta);
              ta.select();
              document.execCommand("copy");
              ta.remove();
              debugPush({ event: "log-copied-fallback", chars: text.length });
            }
          );
        }
      });
    }
    const pre = el.querySelector("pre");
    const seg = el.querySelector(".yt-tldw-debug-seg");
    const hd = el.querySelector(".yt-tldw-debug-hd span");
    if (!pre) {
      el.innerHTML = `<div class="yt-tldw-debug-hd">
        <span>YT-TLDW <small>method=${escapeHtml(method)}${askTemplate ? " · tpl" : ""}</small></span>
        <span class="yt-tldw-debug-actions">
          <button type="button" id="yt-tldw-debug-copy">Copy log</button>
          <button type="button" id="yt-tldw-debug-x">×</button>
        </span>
      </div>
      <pre></pre>
      <div class="yt-tldw-debug-seg"></div>`;
    } else if (hd) {
      hd.innerHTML = `YT-TLDW <small>method=${escapeHtml(method)}${askTemplate ? " · tpl" : ""}</small>`;
    }
    const preEl = el.querySelector("pre");
    const segEl = el.querySelector(".yt-tldw-debug-seg");
    if (preEl) preEl.textContent = lastDebug.slice(-14).map((r) => JSON.stringify(r)).join("\n");
    if (segEl) {
      segEl.textContent =
        playableWindows.map((w) => `${fmt(w.start)}–${fmt(w.end)} ${w.title || w.source || ""}`).join("\n") ||
        "(no windows)";
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  }

  async function refreshSettings() {
    try {
      const data = await chrome.storage.local.get(STORAGE_DEFAULTS);
      enabled = !!data.enabled;
      method = data.method || "auto";
      debug = data.debug !== false;
      askTemplate = data.askTemplate || null;
      if (askTemplate?.body) {
        const b = askTemplate.body;
        const usable =
          b &&
          typeof b === "object" &&
          b.context &&
          b.formData?.inputComposerFormData &&
          typeof b.formData.inputComposerFormData === "object";
        if (!usable) {
          askTemplate = null;
          chrome.storage.local.remove("askTemplate").catch(() => {});
        }
      }
      if (typeof data.momentsPanelCollapsed === "boolean") {
        momentsPanelCollapsed = data.momentsPanelCollapsed;
      }
      if (!["auto", "api", "dom"].includes(method)) method = "auto";
    } catch (e) {
      log("refreshSettings failed", e);
    }
    return { enabled, method, debug, askTemplate };
  }

  function getVideoIdFromUrl() {
    try {
      const u = new URL(location.href);
      if (u.pathname === "/watch") return u.searchParams.get("v");
    } catch (_) {}
    return null;
  }

  function getVideoEl() {
    return document.querySelector("#movie_player video.html5-main-video") || document.querySelector("video");
  }

  function bridgeCall(action, payload = {}, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      const id = `r${++reqSeq}_${Date.now()}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`bridge timeout: ${action}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ source: BRIDGE, direction: "request", id, action, ...payload }, "*");
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== BRIDGE) return;
    if (data.direction === "event") {
      if (data.event === "ready") {
        bridgeReady = true;
        return;
      }
      if (data.event === "persist-template" && data.detail?.template) {
        const tpl = { ...data.detail.template };
        delete tpl._score;
        askTemplate = tpl;
        chrome.storage.local.set({ askTemplate: tpl }).then(() => {
          debugPush({
            event: "template-saved",
            endpoint: tpl.endpoint,
            bodyKeys: tpl.bodyKeys,
          });
        });
        return;
      }
      const allow = new Set([
        "ask-wait-done",
        "dom-click-ask",
        "dom-prompt-sent",
        "dom-reuse-session",
        "dom-stale-reset",
        "dom-session-reset",
        "dom-answer",
        "net-moments",
        "net-wait-done",
        "api-capture",
        "api-capture-body-skip",
        "api-template-candidate",
        "api-replay",
        "api-replay-reject",
        "api-replay-result",
        "nav-reset",
        "ask-cache",
      ]);
      if (allow.has(data.event)) {
        if (data.event === "ask-cache" && !data.detail?.added) return;
        // Skip duplicate session-reset spam
        if (data.event === "dom-session-reset") {
          const t = Date.now();
          if (window.__ytTldwLastResetLog && t - window.__ytTldwLastResetLog < 500) return;
          window.__ytTldwLastResetLog = t;
        }
        debugPush({ event: `bridge:${data.event}`, ...(data.detail || {}) });
      }
      return;
    }
    if (data.direction === "response" && data.id && pending.has(data.id)) {
      const { resolve, timer } = pending.get(data.id);
      clearTimeout(timer);
      pending.delete(data.id);
      resolve(data);
    }
  });

  async function ensureBridge() {
    if (bridgeReady) {
      try {
        await bridgeCall("ping", {}, 800);
        return;
      } catch (_) {
        bridgeReady = false;
      }
    }
    const t0 = Date.now();
    let lastErr = null;
    while (Date.now() - t0 < 10000) {
      try {
        const res = await bridgeCall("ping", {}, 700);
        if (res?.ok) {
          bridgeReady = true;
          return;
        }
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`page-bridge not ready: ${lastErr || "no ping"}`);
  }

  function playerBtnSvg() {
    // white/currentColor ring + 4 ticks; green-red-green triangles (matches extension icon)
    return `<svg class="yt-tldw-icon" viewBox="0 0 128 128" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="64" cy="64" r="54" fill="none" stroke="currentColor" stroke-width="9"/>
      <g stroke="currentColor" stroke-width="9" stroke-linecap="round">
        <line x1="64" y1="18" x2="64" y2="30"/>
        <line x1="110" y1="64" x2="98" y2="64"/>
        <line x1="64" y1="110" x2="64" y2="98"/>
        <line x1="18" y1="64" x2="30" y2="64"/>
      </g>
      <polygon points="34,44 54,64 34,84" fill="#3ddc97"/>
      <polygon points="54,44 74,64 54,84" fill="#e53935"/>
      <polygon points="74,44 94,64 74,84" fill="#3ddc97"/>
    </svg>
    <span class="yt-tldw-spinner" hidden></span>
    <span class="yt-tldw-badge" hidden></span>`;
  }

  function setBtnStatus(status, count = 0) {
    btnStatus = status;
    btnCount = count;
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.classList.toggle("yt-tldw-on", enabled);
    btn.classList.toggle("yt-tldw-loading", status === "loading");
    btn.classList.toggle("yt-tldw-ready", status === "ready");
    const spin = btn.querySelector(".yt-tldw-spinner");
    const badge = btn.querySelector(".yt-tldw-badge");
    if (spin) spin.hidden = status !== "loading";
    if (badge) {
      if (status === "ready" && count > 0) {
        badge.hidden = false;
        badge.textContent = String(count);
      } else {
        badge.hidden = true;
      }
    }
    btn.title =
      status === "loading"
        ? "YT-TLDW: loading key moments…"
        : status === "ready"
          ? `YT-TLDW ON — ${count} segment${count === 1 ? "" : "s"}`
          : enabled
            ? "YT-TLDW ON"
            : "YT-TLDW OFF";
  }

  function updateBtnUi() {
    setBtnStatus(enabled ? btnStatus : "idle", btnCount);
  }

  function injectPlayerButton() {
    if (!location.pathname.startsWith("/watch")) return;
    if (document.getElementById(BTN_ID)) {
      updateBtnUi();
      return;
    }
    const controls =
      document.querySelector(".ytp-right-controls") ||
      document.querySelector(".ytp-chrome-controls") ||
      document.querySelector(".ytp-left-controls");
    if (!controls) return;

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.className = "ytp-button yt-tldw-btn";
    btn.type = "button";
    btn.innerHTML = playerBtnSvg();
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "YT_TLDW_TOGGLE" });
    });
    if (controls.classList.contains("ytp-right-controls")) controls.insertBefore(btn, controls.firstChild);
    else controls.appendChild(btn);
    updateBtnUi();
  }

  function cancelSchedule() {
    if (scheduleTimer) {
      clearTimeout(scheduleTimer);
      scheduleTimer = null;
    }
    if (scheduleInterval) {
      clearInterval(scheduleInterval);
      scheduleInterval = null;
    }
  }

  function isAdPlaying() {
    const player = document.querySelector("#movie_player");
    return !!(player && player.classList.contains("ad-showing"));
  }

  function buildWindows(moments, sbSegments) {
    const alwaysSkip = (sbSegments || []).filter((s) =>
      ["sponsor", "selfpromo", "interaction"].includes(s.category)
    );
    sponsorSkips = alwaysSkip
      .map((s) => ({ start: s.start, end: s.end, category: s.category }))
      .sort((a, b) => a.start - b.start);

    let windows = (moments || [])
      .map((m) => ({
        start: Math.max(0, Number(m.start) || 0),
        end: Math.max(Number(m.start) || 0, Number(m.end) || (Number(m.start) || 0) + DEFAULT_MOMENT_DUR),
        title: m.title || "",
        source: m.source || "",
      }))
      .filter((w) => w.end > w.start + 1)
      .sort((a, b) => a.start - b.start);

    const merged = [];
    for (const w of windows) {
      const last = merged[merged.length - 1];
      // Merge only true overlaps (keep near-adjacent moments as separate windows)
      if (last && w.start < last.end) {
        last.end = Math.max(last.end, w.end);
        if (!last.title) last.title = w.title;
      } else merged.push({ ...w });
    }

    const punched = [];
    for (const w of merged) {
      let pieces = [w];
      for (const sp of sponsorSkips) {
        const next = [];
        for (const p of pieces) {
          if (sp.end <= p.start || sp.start >= p.end) {
            next.push(p);
            continue;
          }
          if (sp.start > p.start) next.push({ ...p, end: sp.start });
          if (sp.end < p.end) next.push({ ...p, start: sp.end });
        }
        pieces = next.filter((p) => p.end > p.start + 0.5);
      }
      punched.push(...pieces);
    }
    return punched.sort((a, b) => a.start - b.start);
  }

  function findContainingWindow(t) {
    return playableWindows.find((w) => t >= w.start - 0.05 && t < w.end);
  }
  function findNextWindow(t) {
    return playableWindows.find((w) => w.start >= t - 0.05) || null;
  }
  function findSponsorAt(t) {
    return sponsorSkips.find((s) => t >= s.start - 0.05 && t < s.end);
  }

  function setCurrentTime(video, time) {
    try {
      const duration = video.duration;
      if (duration && time >= duration - 0.05) {
        video.pause();
        video.currentTime = Math.max(0, duration - 0.05);
        return;
      }
      video.currentTime = Math.max(0, time);
    } catch (e) {
      log("setCurrentTime failed", e);
    }
  }

  function startSchedule() {
    cancelSchedule();
    if (!enabled || !playableWindows.length) return;
    const video = getVideoEl();
    if (!video) return;
    if (isAdPlaying()) {
      scheduleTimer = setTimeout(startSchedule, 400);
      return;
    }
    const t = video.currentTime || 0;
    const sp = findSponsorAt(t);
    if (sp) {
      const after = findNextWindow(sp.end);
      const target = after ? Math.max(sp.end, after.start) : sp.end;
      debugPush({ event: "skip-sponsor", from: t, to: target, category: sp.category });
      setCurrentTime(video, target + 0.01);
      scheduleTimer = setTimeout(startSchedule, 200);
      return;
    }
    const win = findContainingWindow(t);
    if (!win) {
      const next = findNextWindow(t);
      if (!next) {
        const last = playableWindows[playableWindows.length - 1];
        if (last && t < last.start) setCurrentTime(video, last.start);
        else if (last && t >= last.end) {
          debugPush({ event: "done-all-windows", t });
          try {
            video.pause();
          } catch (_) {}
          return;
        }
        scheduleTimer = setTimeout(startSchedule, 300);
        return;
      }
      debugPush({ event: "jump-to-window", from: t, to: next.start, title: next.title });
      setCurrentTime(video, next.start + 0.01);
      scheduleTimer = setTimeout(startSchedule, 200);
      return;
    }
    let until = win.end;
    for (const sp2 of sponsorSkips) {
      if (sp2.start > t && sp2.start < until) until = sp2.start;
    }
    // SB-style scheduled timeout (no polling interval). seeked/ratechange re-enter startSchedule.
    const rate = video.playbackRate || 1;
    const delay = Math.max(16, ((until - t) * 1000) / rate - 60);
    scheduleTimer = setTimeout(() => {
      if (!enabled) return cancelSchedule();
      const v = getVideoEl();
      if (!v) return;
      if (isAdPlaying()) {
        scheduleTimer = setTimeout(startSchedule, 300);
        return;
      }
      const now = v.currentTime || 0;
      // Still inside window (pause/seek/slow) — reschedule remainder
      if (now + SKIP_BUFFER < until - 0.05) {
        startSchedule();
        return;
      }
      const nxt = findNextWindow(Math.max(until, now) + 0.02);
      if (nxt) {
        debugPush({ event: "window-end-jump", from: now, to: nxt.start, title: nxt.title });
        setCurrentTime(v, nxt.start + 0.01);
        startSchedule();
      } else {
        debugPush({ event: "last-window-end", t: now, note: "pause-at-end" });
        try {
          v.pause();
        } catch (_) {}
      }
    }, delay);
  }

  function bindVideoListeners(video) {
    if (!video || video.dataset.ytTldwBound) return;
    video.dataset.ytTldwBound = "1";
    const kick = () => {
      if (enabled && playableWindows.length) startSchedule();
    };
    video.addEventListener("play", kick);
    video.addEventListener("playing", kick);
    video.addEventListener("seeked", kick);
    video.addEventListener("ratechange", kick);
    // Highlight only — class swap when window index changes (no intervals)
    video.addEventListener("timeupdate", () => {
      if (!enabled || !playableWindows.length) return;
      highlightMomentsPanel(video.currentTime || 0);
    });
  }

  async function fetchSponsorBlock(id) {
    return await chrome.runtime.sendMessage({ type: "YT_TLDW_SPONSORBLOCK", videoId: id });
  }

  async function loadSessionMomentsCache() {
    try {
      const data = await chrome.storage.session.get({ momentsByVideo: {} });
      const map = data.momentsByVideo || {};
      for (const [vid, entry] of Object.entries(map)) {
        if (entry?.moments?.length) momentsMemCache.set(vid, entry);
      }
    } catch (_) {
      /* session storage may be unavailable */
    }
  }

  async function saveMomentsCache(vid, moments, used) {
    if (!vid || !moments?.length) return;
    const entry = { moments, used, at: Date.now() };
    momentsMemCache.set(vid, entry);
    try {
      const data = await chrome.storage.session.get({ momentsByVideo: {} });
      const map = { ...(data.momentsByVideo || {}), [vid]: entry };
      // Cap entries
      const keys = Object.keys(map);
      if (keys.length > 40) {
        keys
          .sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
          .slice(0, keys.length - 40)
          .forEach((k) => delete map[k]);
      }
      await chrome.storage.session.set({ momentsByVideo: map });
    } catch (_) {}
  }

  function getCachedMoments(vid) {
    const hit = momentsMemCache.get(vid);
    if (hit?.moments?.length) return hit;
    return null;
  }

  function methodOrder(preferred, hasTemplate) {
    if (preferred === "dom") return ["dom", "fallback"];
    if (preferred === "api") return hasTemplate ? ["api", "dom", "fallback"] : ["dom", "fallback"];
    // auto: once template exists, try API first on (next) video, else DOM; always DOM fallback in-run
    return hasTemplate ? ["api", "dom", "fallback"] : ["dom", "fallback"];
  }

  async function trySteps(order, token, { forceFreshDom = false } = {}) {
    for (const step of order) {
      if (token !== runToken) return { moments: [], used: "none", aborted: true };
      if (step === "dom") {
        try {
          const res = await bridgeCall(
            "askDom",
            { forceFresh: forceFreshDom },
            DOM_BRIDGE_TIMEOUT_MS
          );
          debugPush({
            event: "method-result",
            method: res.method || "dom",
            ok: !!res.ok,
            latencyMs: res.latencyMs,
            count: res.moments?.length || 0,
            error: res.error,
            rawTextPreview: res.rawTextPreview,
            titles: (res.moments || []).slice(0, 6).map((m) => m.title),
            hasTemplate: !!res.hasTemplate,
          });
          if (res.ok && res.moments?.length) return { moments: res.moments, used: res.method || "dom" };
        } catch (e) {
          debugPush({ event: "method-error", method: "dom", error: String(e) });
          try {
            await bridgeCall("resetDomSession", {}, 3000);
          } catch (_) {}
        }
      } else if (step === "api") {
        if (!askTemplate) {
          debugPush({ event: "method-skip", method: "api", reason: "no template" });
          continue;
        }
        // Skip obviously corrupt templates (binary keys / missing composer)
        const bk = askTemplate.bodyKeys;
        const body = askTemplate.body;
        const usable =
          body &&
          typeof body === "object" &&
          body.context &&
          body.formData?.inputComposerFormData &&
          typeof body.formData.inputComposerFormData === "object";
        if (!usable) {
          debugPush({ event: "template-cleared", reason: "unusable-on-disk", bodyKeys: bk });
          askTemplate = null;
          try {
            await chrome.storage.local.remove("askTemplate");
          } catch (_) {}
          continue;
        }
        try {
          const res = await bridgeCall("askApi", { template: askTemplate }, 25000);
          debugPush({
            event: "method-result",
            method: res.method || "api",
            ok: !!res.ok,
            latencyMs: res.latencyMs,
            count: res.moments?.length || 0,
            error: res.error,
            rawTextPreview: res.rawTextPreview,
          });
          if (res.ok && res.moments?.length) return { moments: res.moments, used: res.method || "api" };
          // Soft fail / wrong-session template — clear so DOM path can capture a fresh one
          const errBlob = String(res.error || "") + " " + String(res.rawTextPreview || "");
          if (!res.ok && /unusable template/i.test(errBlob)) {
            debugPush({ event: "template-cleared", reason: res.error || "api-soft-fail" });
            askTemplate = null;
            try {
              await chrome.storage.local.remove("askTemplate");
            } catch (_) {}
          } else if (!res.ok && /HTTP 400|no timestamps|Something went wrong/i.test(errBlob)) {
            // Keep template (form shape OK); continuation priming may succeed next video
            debugPush({ event: "template-kept", reason: res.error || "api-soft-fail" });
          }
        } catch (e) {
          const msg = String(e);
          debugPush({ event: "method-error", method: "api", error: msg });
          if (/unusable template/i.test(msg)) {
            debugPush({ event: "template-cleared", reason: msg });
            askTemplate = null;
            try {
              await chrome.storage.local.remove("askTemplate");
            } catch (_) {}
          } else if (/HTTP 400|fresh continuation|Something went wrong/i.test(msg)) {
            // Keep composer template; next video will re-prime continuation
            debugPush({ event: "template-kept", reason: msg });
          }
        }
      } else if (step === "fallback") {
        try {
          const heat = await bridgeCall("heatmap", {}, 5000);
          debugPush({
            event: "method-result",
            method: "heatmap",
            ok: !!heat.ok,
            latencyMs: heat.latencyMs,
            count: heat.moments?.length || 0,
            error: heat.error,
          });
          if (heat.ok && heat.moments?.length) return { moments: heat.moments, used: "heatmap" };
        } catch (e) {
          debugPush({ event: "method-error", method: "heatmap", error: String(e) });
        }
        try {
          const ch = await bridgeCall("chapters", {}, 5000);
          debugPush({
            event: "method-result",
            method: "chapters",
            ok: !!ch.ok,
            latencyMs: ch.latencyMs,
            count: ch.moments?.length || 0,
            error: ch.error,
          });
          if (ch.ok && ch.moments?.length) return { moments: ch.moments, used: "chapters" };
        } catch (e) {
          debugPush({ event: "method-error", method: "chapters", error: String(e) });
        }
      }
    }
    return { moments: [], used: "none" };
  }

  async function resolveMoments(preferredMethod, token, { forceFreshDom = false } = {}) {
    await refreshSettings();
    const order = methodOrder(preferredMethod, !!askTemplate);
    debugPush({
      event: "resolve-order",
      preferredMethod,
      order,
      hasTemplate: !!askTemplate,
      templateEndpoint: askTemplate?.endpoint || null,
      bodyKeys: askTemplate?.bodyKeys || null,
    });

    // Readiness wait only if we may touch Ask UI
    if (order.includes("dom") || order.includes("api")) {
      try {
        const ready = await bridgeCall("waitAskReady", { timeoutMs: ASK_WAIT_MS }, ASK_WAIT_MS + 5000);
        debugPush({
          event: "ask-ready",
          ok: !!ready.ok,
          waitedMs: ready.waitedMs,
          askButtonCount: ready.askButtonCount,
          askLabel: ready.askLabel,
          commands: ready.commands,
          chips: ready.chips,
          panels: ready.panels,
        });
      } catch (e) {
        debugPush({ event: "ask-ready-error", error: String(e) });
      }
    }

    const work = trySteps(order, token, { forceFreshDom });
    const timeout = new Promise((resolve) =>
      setTimeout(
        () => resolve({ moments: [], used: "none", timedOut: true }),
        RUN_HARD_TIMEOUT_MS
      )
    );
    const result = await Promise.race([work, timeout]);
    if (result.timedOut) {
      debugPush({ event: "method-result", method: "hard-timeout", ok: false, count: 0, error: "run hard timeout" });
      try {
        await bridgeCall("resetDomSession", {}, 3000);
      } catch (_) {}
      // try quick fallbacks only
      const fb = await trySteps(["fallback"], token);
      if (fb.moments?.length) return fb;
    }
    if (result.aborted || result.moments?.length) return result;
    return trySteps(["fallback"], token);
  }


  function keptSeconds(windows) {
    return (windows || []).reduce((a, w) => a + Math.max(0, (w.end || 0) - (w.start || 0)), 0);
  }

  function removeMomentsPanel() {
    document.getElementById(PANEL_ID)?.remove();
    activeWindowIdx = -1;
    previewBar?.clear();
  }

  function setMomentsCollapsed(collapsed) {
    momentsPanelCollapsed = !!collapsed;
    chrome.storage.local.set({ momentsPanelCollapsed }).catch(() => {});
    const el = document.getElementById(PANEL_ID);
    if (el) el.classList.toggle("yt-tldw-collapsed", momentsPanelCollapsed);
  }

  function highlightMomentsPanel(t) {
    const el = document.getElementById(PANEL_ID);
    if (!el || !playableWindows.length) return;
    let idx = -1;
    for (let i = 0; i < playableWindows.length; i++) {
      const w = playableWindows[i];
      if (t >= w.start - 0.05 && t < w.end) {
        idx = i;
        break;
      }
    }
    if (idx === activeWindowIdx) return;
    activeWindowIdx = idx;
    const prev = el.querySelector(".yt-tldw-row.is-active");
    if (prev) prev.classList.remove("is-active");
    if (idx >= 0) {
      const row = el.querySelector(`.yt-tldw-row[data-idx="${idx}"]`);
      if (row) {
        row.classList.add("is-active");
        // Only scroll when expanded; avoid layout thrash when collapsed
        if (!momentsPanelCollapsed) {
          try {
            row.scrollIntoView({ block: "nearest" });
          } catch (_) {}
        }
      }
    }
  }

  function mountMomentsPanelHost(panel) {
    // Prefer secondary column (above related); fall back to fixed overlay
    const secondary =
      document.querySelector("#secondary-inner") ||
      document.querySelector("#secondary") ||
      document.querySelector("#related");
    if (secondary) {
      panel.classList.add("yt-tldw-panel-inline");
      panel.classList.remove("yt-tldw-panel-overlay");
      if (panel.parentElement !== secondary) {
        secondary.insertBefore(panel, secondary.firstChild);
      }
      return;
    }
    panel.classList.add("yt-tldw-panel-overlay");
    panel.classList.remove("yt-tldw-panel-inline");
    if (!panel.parentElement) document.documentElement.appendChild(panel);
  }



  function ensurePreviewBar() {
    if (previewBar) return previewBar;
    if (typeof TldwPreviewBar === "undefined") return null;
    previewBar = new TldwPreviewBar();
    return previewBar;
  }
  function updatePreviewBar() {
    ensurePreviewBar();
    if (!previewBar) return;
    if (!enabled || (!playableWindows.length && !sponsorSkips.length)) {
      previewBar.clear();
      return;
    }
    const video = getVideoEl();
    let duration = video?.duration && isFinite(video.duration) ? video.duration : 0;
    if (!duration) {
      const pb = document.querySelector(".ytp-progress-bar");
      duration = parseInt(pb?.getAttribute("aria-valuemax") || "0", 10) || 0;
    }
    if (!duration) return;
    const segs = [];
    for (const w of playableWindows) {
      segs.push({ start: w.start, end: w.end, kind: "good", title: w.title || "moment" });
    }
    for (const s of sponsorSkips) {
      segs.push({
        start: s.start,
        end: s.end,
        kind: "sponsor",
        title: s.category || "sponsor",
      });
    }
    previewBar.set(segs, duration);
    debugPush({
      event: "preview-bar-set",
      goods: playableWindows.length,
      sponsors: sponsorSkips.length,
      duration: Math.round(duration),
      sponsorColor: "#e53935",
    });
  }

  function renderMomentsPanel({ used } = {}) {
    if (!enabled) {
      removeMomentsPanel();
      return;
    }
    if (!playableWindows.length && !sponsorSkips.length) {
      removeMomentsPanel();
      return;
    }
    if (used) lastUsedMethod = used;
    const video = getVideoEl();
    const duration = video?.duration && isFinite(video.duration) ? video.duration : 0;
    const kept = keptSeconds(playableWindows);
    let el = document.getElementById(PANEL_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = PANEL_ID;
      el.dataset.ytTldwUi = "1";
      el.addEventListener("click", (ev) => {
        const t = ev.target.closest("[data-action]");
        if (!t || !el.contains(t)) return;
        const action = t.getAttribute("data-action");
        if (action === "toggle") {
          setMomentsCollapsed(!momentsPanelCollapsed);
          return;
        }
        if (action === "seek") {
          const start = Number(t.getAttribute("data-start"));
          if (!isFinite(start)) return;
          const v = getVideoEl();
          if (!v) return;
          setCurrentTime(v, start + 0.01);
          if (v.paused) v.play?.().catch(() => {});
          if (enabled && playableWindows.length) startSchedule();
          highlightMomentsPanel(start + 0.05);
        }
      });
    }
    el.classList.toggle("yt-tldw-collapsed", momentsPanelCollapsed);
    const methodLabel = escapeHtml(lastUsedMethod || method || "—");
    const keptLabel = `${fmt(kept)}${duration ? " / " + fmt(duration) : ""}`;
    const rows = [];
    playableWindows.forEach((w, i) => {
      const range = `${fmt(w.start)}–${fmt(w.end)}`;
      rows.push(
        `<button type="button" class="yt-tldw-row" data-action="seek" data-idx="${i}" data-start="${w.start}" title="${escapeHtml((w.title || "Moment") + " · " + range)}">` +
          `<span class="yt-tldw-row-t">${escapeHtml(range)}</span>` +
          `<span class="yt-tldw-row-l">${escapeHtml(w.title || "Moment")}</span>` +
        `</button>`
      );
    });
    sponsorSkips.forEach((s) => {
      const range = `${fmt(s.start)}–${fmt(s.end)}`;
      rows.push(
        `<div class="yt-tldw-row yt-tldw-sponsor" data-start="${s.start}" title="Skipped ${escapeHtml(s.category || "sponsor")}">` +
          `<span class="yt-tldw-row-t">${escapeHtml(range)}</span>` +
          `<span class="yt-tldw-row-l">Skip: ${escapeHtml(s.category || "sponsor")}</span>` +
        `</div>`
      );
    });
    el.innerHTML =
      `<div class="yt-tldw-panel-hd" data-action="toggle">` +
        `<div class="yt-tldw-panel-title">` +
          `<strong>YT-TLDW</strong>` +
          `<span class="yt-tldw-panel-meta">${methodLabel} · ${playableWindows.length} · ${escapeHtml(keptLabel)}</span>` +
        `</div>` +
        `<span class="yt-tldw-panel-chev" aria-hidden="true"></span>` +
      `</div>` +
      `<div class="yt-tldw-panel-body">${rows.join("") || '<div class="yt-tldw-empty">No moments</div>'}</div>`;
    mountMomentsPanelHost(el);
    activeWindowIdx = -1;
    highlightMomentsPanel(video?.currentTime || 0);
  }

  async function finishRun({ id, settings, moments, used, sb, t0, token }) {
    if (token !== runToken) return;
    playableWindows = buildWindows(moments, sb?.segments || []);
    const totalMs = Math.round(performance.now() - t0);

    if (moments?.length) await saveMomentsCache(id, moments, used);

    debugPush({
      event: "ready",
      usedMethod: used,
      effectiveMethod: settings.method,
      latencyMs: totalMs,
      windows: playableWindows.length,
      segments: playableWindows.map((w) => ({
        start: w.start,
        end: w.end,
        title: w.title,
        source: w.source,
      })),
      sponsors: sponsorSkips.length,
      hasTemplate: !!askTemplate,
    });

    if (playableWindows.length) setBtnStatus("ready", playableWindows.length);
    else setBtnStatus("error", 0);

    lastUsedMethod = used || "";
    renderMomentsPanel({ used });
    updatePreviewBar();

    const video = getVideoEl();
    bindVideoListeners(video);
    if (video && playableWindows.length) {
      const t = video.currentTime || 0;
      if (!findContainingWindow(t)) {
        const first = playableWindows[0];
        if (first) setCurrentTime(video, first.start + 0.01);
      }
      startSchedule();
      highlightMomentsPanel(video.currentTime || 0);
      if (video.paused) video.play?.().catch(() => {});
    } else {
      debugPush({
        event: "no-windows",
        hint: "No moments. Check Copy log (get_panel pipe moments / template).",
        effectiveMethod: settings.method,
      });
    }
    // Allow re-run on same video after completion (toggle, etc.)
    if (runningForId === id) runningForId = null;
  }

  async function runForCurrentVideo({ forceFresh = false } = {}) {
    const id = getVideoIdFromUrl();
    videoId = id;
    cancelSchedule();
    playableWindows = [];
    sponsorSkips = [];
    activeWindowIdx = -1;

    const settings = await refreshSettings();
    await loadSessionMomentsCache();
    updateBtnUi();
    renderDebug();

    if (!settings.enabled || !id) {
      runningForId = null;
      setBtnStatus("idle", 0);
      removeMomentsPanel();
      previewBar?.clear();
      return;
    }
    if (runningForId === id) return;
    runningForId = id;
    const token = ++runToken;
    setBtnStatus("loading", 0);

    const t0 = performance.now();
    debugPush({
      event: "start",
      videoId: id,
      method: settings.method,
      effectiveMethod: settings.method,
      hasTemplate: !!settings.askTemplate,
      forceFresh,
    });

    // Instant reuse of successful moments for same videoId
    const cached = !forceFresh ? getCachedMoments(id) : null;
    if (cached?.moments?.length) {
      debugPush({
        event: "method-result",
        method: "cache",
        ok: true,
        count: cached.moments.length,
        used: cached.used,
        ageMs: Date.now() - (cached.at || 0),
      });
      const sb = await fetchSponsorBlock(id);
      debugPush({
        event: "sponsorblock",
        ok: sb?.ok,
        count: sb?.segments?.length || 0,
        error: sb?.error,
        prefix: sb?.prefix,
      });
      await finishRun({
        id,
        settings,
        moments: cached.moments,
        used: cached.used || "cache",
        sb,
        t0,
        token,
      });
      return;
    }

    try {
      await ensureBridge();
    } catch (e) {
      debugPush({ event: "bridge-failed", error: String(e) });
      debugPush({ event: "method-result", method: "none", ok: false, count: 0, error: String(e) });
      await finishRun({ id, settings, moments: [], used: "none", sb: null, t0, token });
      return;
    }

    // Do NOT pre-reset here — askDom handles stale sessions; avoids reset storms
    const sbPromise = fetchSponsorBlock(id);
    let resolved;
    try {
      resolved = await resolveMoments(settings.method, token, { forceFreshDom: false });
    } catch (e) {
      debugPush({ event: "method-error", method: "resolve", error: String(e) });
      resolved = { moments: [], used: "none" };
    }
    if (token !== runToken) return;

    const sb = await sbPromise;
    debugPush({
      event: "sponsorblock",
      ok: sb?.ok,
      count: sb?.segments?.length || 0,
      error: sb?.error,
      prefix: sb?.prefix,
    });

    let moments = resolved.moments || [];
    let used = resolved.used || "none";

    const pois = (sb?.segments || []).filter((s) => s.category === "poi_highlight" || s.actionType === "poi");
    if (!moments.length && pois.length) {
      moments = pois.map((p) => ({
        start: p.start,
        end: p.start + DEFAULT_MOMENT_DUR,
        title: "SB highlight",
        source: "poi_highlight",
      }));
      used = "poi_highlight";
      debugPush({ event: "method-result", method: "poi_highlight", ok: true, count: moments.length });
    }

    await finishRun({ id, settings, moments, used, sb, t0, token });
  }

  function onNavigate() {
    const id = getVideoIdFromUrl();
    if (id !== videoId) {
      runningForId = null;
      runToken++;
      cancelSchedule();
      playableWindows = [];
      removeMomentsPanel();
      previewBar?.clear();
      setBtnStatus("idle", 0);
    }
    injectPlayerButton();
    setTimeout(async () => {
      injectPlayerButton();
      await refreshSettings();
      if (enabled) runForCurrentVideo();
    }, 800);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "YT_TLDW_STATE") {
      enabled = !!msg.enabled;
      updateBtnUi();
      if (enabled) {
        runningForId = null;
        runForCurrentVideo({ forceFresh: false });
      } else {
        cancelSchedule();
        playableWindows = [];
        setBtnStatus("idle", 0);
        document.getElementById(DEBUG_ID)?.remove();
        removeMomentsPanel();
        previewBar?.clear();
        debugPush({ event: "disabled" });
      }
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    (async () => {
      const before = method;
      await refreshSettings();
      if (changes.method) {
        debugPush({ event: "method-setting", from: before, effectiveMethod: method });
        if (enabled) {
          runningForId = null;
          runForCurrentVideo();
        }
      }
      if (changes.askTemplate) {
        askTemplate = changes.askTemplate.newValue || null;
        debugPush({ event: "template-updated", hasTemplate: !!askTemplate });
      }
      if (changes.debug) renderDebug();
      if (changes.momentsPanelCollapsed) {
        momentsPanelCollapsed = !!changes.momentsPanelCollapsed.newValue;
        const el = document.getElementById(PANEL_ID);
        if (el) el.classList.toggle("yt-tldw-collapsed", momentsPanelCollapsed);
      }
      if (changes.enabled) {
        enabled = !!changes.enabled.newValue;
        updateBtnUi();
        if (!enabled) {
          removeMomentsPanel();
          previewBar?.clear();
        }
      }
    })();
  });

  async function init() {
    await refreshSettings();
    injectPlayerButton();
    updateBtnUi();
    document.addEventListener("yt-navigate-finish", onNavigate);
    let btnObsTimer = null;
    const obs = new MutationObserver((mutations) => {
      // Ignore our own debug UI mutations
      for (const m of mutations) {
        const t = m.target;
        if (t?.closest?.("#yt-tldw-debug, #yt-tldw-moments") || t?.id === DEBUG_ID || t?.id === PANEL_ID || t?.dataset?.ytTldwUi) return;
      }
      if (document.getElementById(BTN_ID)) return; // already present — do not touch (avoids class thrash loop)
      if (btnObsTimer) return;
      btnObsTimer = setTimeout(() => {
        btnObsTimer = null;
        injectPlayerButton();
      }, 300);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    let tries = 0;
    const bootBtn = setInterval(() => {
      injectPlayerButton();
      if (document.getElementById(BTN_ID) || ++tries > 40) clearInterval(bootBtn);
    }, 500);
    if (enabled && getVideoIdFromUrl()) setTimeout(() => runForCurrentVideo(), 1000);
    log("content init", { enabled, method, hasTemplate: !!askTemplate });
  }

  init();
})();
