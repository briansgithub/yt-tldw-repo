/* YT-TLDW content script (isolated world) — GPL-3.0
 * Skip scheduling inspired by SponsorBlock (ajayyy/SponsorBlock). */

(() => {
  const BRIDGE = "YT_TLDW_BRIDGE";
  const CONTROLS_ID = "yt-tldw-player-controls";
  const BTN_ID = "yt-tldw-player-btn"; // legacy single-button id (removed on inject)
  const DEBUG_ID = "yt-tldw-debug";
  const PANEL_ID = "yt-tldw-moments";
  const WATCH_PARTY_PANEL_ID = "watch-party-panel";
  const S = self.YtTldwSettings;
  const api = globalThis.browser || chrome;
  const Queue = globalThis.YtTldwQueuePlayback;
  const mobile = location.hostname === "m.youtube.com";
  const autoSeek = () => Queue.isActive() ? !Queue.full() : autoJump;
  const STORAGE_DEFAULTS = { ...S.DEFAULTS };

  let enabled = false;
  let method = "auto";
  let debug = true;
  let genre = "facts";
  let intensity = "mild";
  let autoJump = true;
  let askTemplate = null;
  let videoId = null;
  let playableWindows = [];
  let sponsorSkips = [];
  let scheduleTimer = null;
  let scheduleInterval = null;
  let watchPartyOpen = false;
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
  let momentsPanelCollapsed = false;
  let momentsShowAskIo = false;
  let lastUsedMethod = "";
  let activeWindowIdx = -1;
  let lastAskPrompt = "";
  let lastAskResponse = "";
  const SKIP_BUFFER = 0.12;
  const DOM_BRIDGE_TIMEOUT_MS = 32000;
  /** Global ceiling: always reach fallback + method-result even if DOM hangs. */
  const RUN_HARD_TIMEOUT_MS = 34000;
  const DEFAULT_MOMENT_DUR = 35;
  const ASK_WAIT_MS = 15000;

  function log(...args) {
    if (!debug) return;
    console.log("[YT-TLDW]", ...args);
  }

  let renderDebugTimer = null;
  let logFlushTimer = null;
  const remoteLogQueue = [];
  const LOG_CAP = 40;

  function enqueueRemoteLog(row) {
    if (!debug) return;
    remoteLogQueue.push(row);
    if (remoteLogQueue.length > 80) remoteLogQueue.splice(0, remoteLogQueue.length - 80);
    if (logFlushTimer) return;
    logFlushTimer = setTimeout(flushRemoteLogs, 400);
  }

  function flushRemoteLogs() {
    logFlushTimer = null;
    if (!debug) {
      remoteLogQueue.length = 0;
      return;
    }
    if (!remoteLogQueue.length) return;
    const lines = remoteLogQueue.splice(0, remoteLogQueue.length);
    try {
      api.runtime.sendMessage({ type: "YT_TLDW_LOG", lines }).catch(() => {});
    } catch (_) {}
  }

  function clearDebugLogging() {
    remoteLogQueue.length = 0;
    if (logFlushTimer) {
      clearTimeout(logFlushTimer);
      logFlushTimer = null;
    }
    document.getElementById(DEBUG_ID)?.remove();
  }

  function debugPush(entry) {
    if (!debug) return;
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
    // Keep generated ranges and Ask text in the tab, including when the desktop log server is running.
    const fields = ["event", "videoId", "method", "usedMethod", "effectiveMethod", "count", "latencyMs",
      "ok", "genre", "intensity", "status", "windows", "sponsors"];
    const summary = { t: new Date().toISOString() };
    for (const field of fields) {
      const value = row[field];
      if (["string", "number", "boolean"].includes(typeof value)) summary[field] = value;
    }
    enqueueRemoteLog(summary);
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
          clearDebugLogging();
          api.storage.local.set({ debug: false }).catch(() => {});
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
    if (!el.firstChild) {
      const copy = element("button", "", "Copy log");
      copy.type = "button";
      copy.id = "yt-tldw-debug-copy";
      const close = element("button", "", "×");
      close.type = "button";
      close.id = "yt-tldw-debug-x";
      el.append(element("div", "yt-tldw-debug-hd", element("span"), element("span", "yt-tldw-debug-actions", copy, close)),
        element("pre"), element("div", "yt-tldw-debug-seg"));
    }
    const detail = genre + "/" + intensity + " · method=" + method + (askTemplate ? " · tpl" : "");
    el.querySelector(".yt-tldw-debug-hd span").replaceChildren("YT-TLDW ", element("small", "", detail));
    const preEl = el.querySelector("pre");
    const segEl = el.querySelector(".yt-tldw-debug-seg");
    if (preEl) preEl.textContent = lastDebug.slice(-14).map((r) => JSON.stringify(r)).join("\n");
    if (segEl) {
      segEl.textContent =
        playableWindows.map((w) => `${fmt(w.start)}–${fmt(w.end)} ${w.title || w.source || ""}`).join("\n") ||
        "(no windows)";
    }
  }

  function element(tag, className = "", ...children) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.append(...children);
    return node;
  }

  function svg(markup) {
    return new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
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
      const data = await api.storage.local.get(STORAGE_DEFAULTS);
      enabled = !!data.enabled || Queue.isActive();
      method = S.normalizeMethod(data.method);
      debug = data.debug !== false;
      genre = S.normalizeGenre(data.genre);
      intensity = S.normalizeIntensity(data.intensity);
      autoJump = data.autoJump !== false;
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
          api.storage.local.remove("askTemplate").catch(() => {});
        }
      }
      if (typeof data.momentsPanelCollapsed === "boolean") {
        momentsPanelCollapsed = data.momentsPanelCollapsed;
      }
      if (typeof data.momentsShowAskIo === "boolean") {
        momentsShowAskIo = data.momentsShowAskIo;
      }
    } catch (e) {
      log("refreshSettings failed", e);
    }
    return { enabled, method, debug, genre, intensity, autoJump, askTemplate };
  }

  function rememberAskExchange({ prompt, response } = {}) {
    if (typeof prompt === "string" && prompt.trim()) lastAskPrompt = prompt.trim();
    if (typeof response === "string") lastAskResponse = response;
  }

  function setMomentsShowAskIo(show) {
    momentsShowAskIo = !!show;
    api.storage.local.set({ momentsShowAskIo }).catch(() => {});
    renderMomentsPanel({ used: lastUsedMethod || undefined });
  }

  function currentPrompt() {
    return S.buildPrompt(genre, intensity);
  }

  function videoDurationSec() {
    const video = getVideoEl();
    if (video?.duration && isFinite(video.duration) && video.duration > 0) return video.duration;
    const pb = document.querySelector(".ytp-progress-bar");
    const v = parseInt(pb?.getAttribute("aria-valuemax") || "0", 10) || 0;
    return v > 0 ? v : 0;
  }

  function getVideoIdFromUrl() {
    return globalThis.YtTldwQueueModel.videoIdFromUrl(location.href);
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
        const composer = tpl.body?.formData?.inputComposerFormData;
        if (composer) {
          delete composer.userInputText;
          delete composer.playerOffsetMs;
        }
        askTemplate = tpl;
        api.storage.local.set({ askTemplate: tpl }).then(() => {
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

  function centerAutoSvg() {
    // Compact brand mark for the auto-jump toggle
    return svg(`<svg class="yt-tldw-icon" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
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
    </svg>`);
  }

  function findWindowIndexAt(t) {
    const inside = playableWindows.findIndex((w) => t >= w.start - 0.05 && t < w.end);
    if (inside >= 0) return inside;
    let prev = -1;
    for (let i = 0; i < playableWindows.length; i++) {
      if (playableWindows[i].start <= t) prev = i;
    }
    return prev;
  }

  function jumpToSegment(direction) {
    if (!enabled || !playableWindows.length) return;
    const video = getVideoEl();
    if (!video) return;
    const t = video.currentTime || 0;
    const idx = findWindowIndexAt(t);
    let target = null;
    if (direction < 0) {
      if (idx > 0) target = playableWindows[idx - 1];
      else if (idx === 0) {
        // Restart first segment if already near its start; else rewind to start
        const cur = playableWindows[0];
        target = cur;
      } else target = playableWindows[0];
    } else {
      if (idx >= 0 && idx < playableWindows.length - 1) target = playableWindows[idx + 1];
      else if (idx < 0) target = findNextWindow(t) || playableWindows[0];
      else target = playableWindows[playableWindows.length - 1];
    }
    if (!target) return;
    debugPush({
      event: direction < 0 ? "manual-prev-segment" : "manual-next-segment",
      from: t,
      to: target.start,
      title: target.title,
    });
    setCurrentTime(video, target.start + 0.01);
    highlightMomentsPanel(target.start + 0.05);
    if (video.paused) video.play?.().catch(() => {});
    if (autoJump) startSchedule();
  }

  async function setAutoJump(next) {
    autoJump = !!next;
    try {
      await api.storage.local.set({ autoJump });
    } catch (_) {}
    updateBtnUi();
    debugPush({ event: "auto-jump-toggled", autoJump });
    if (enabled && autoJump && playableWindows.length) startSchedule();
    else if (!autoJump) {
      // Keep sponsor-skip scheduling; drop pending window-end jumps by re-entering.
      if (enabled) startSchedule();
      else cancelSchedule();
    }
  }

  function setBtnStatus(status, count = 0) {
    btnStatus = status;
    btnCount = count;
    const root = document.getElementById(CONTROLS_ID);
    if (!root) return;
    root.hidden = !enabled;
    root.classList.toggle("yt-tldw-on", enabled);
    root.classList.toggle("yt-tldw-loading", status === "loading");
    root.classList.toggle("yt-tldw-ready", status === "ready");
    root.classList.toggle("yt-tldw-auto-off", enabled && !autoJump);
    const autoBtn = root.querySelector('[data-action="auto"]');
    const prevBtn = root.querySelector('[data-action="prev"]');
    const nextBtn = root.querySelector('[data-action="next"]');
    const spin = root.querySelector(".yt-tldw-spinner");
    const badge = root.querySelector(".yt-tldw-badge");
    if (spin) spin.hidden = status !== "loading";
    if (badge) {
      if (status === "ready" && count > 0) {
        badge.hidden = false;
        badge.textContent = String(count);
      } else {
        badge.hidden = true;
      }
    }
    const hasSeg = count > 0 && status === "ready";
    if (prevBtn) prevBtn.disabled = !hasSeg;
    if (nextBtn) nextBtn.disabled = !hasSeg;
    if (autoBtn) {
      autoBtn.classList.toggle("yt-tldw-auto-on", autoJump && !watchPartyOpen);
      autoBtn.setAttribute("aria-pressed", autoJump ? "true" : "false");
      autoBtn.title = watchPartyOpen
        ? "Watch Party is syncing this video. Auto-jump and sponsor skips are paused. Prev/next still seek for you."
        : autoJump
          ? status === "loading"
            ? "YT-TLDW: loading… (auto-jump ON)"
            : hasSeg
              ? `Auto-jump ON — ${count} segment${count === 1 ? "" : "s"} (click to pause auto-jump)`
              : "Auto-jump ON (click to pause)"
          : "Auto-jump OFF — manual prev/next only (click to resume)";
    }
    if (prevBtn) prevBtn.title = watchPartyOpen ? "Previous segment (Watch Party will follow if you can control playback)" : "Previous segment";
    if (nextBtn) nextBtn.title = watchPartyOpen ? "Next segment (Watch Party will follow if you can control playback)" : "Next segment";
  }

  function updateBtnUi() {
    setBtnStatus(enabled ? btnStatus : "idle", btnCount);
  }

  function injectPlayerButton() {
    if (!location.pathname.startsWith("/watch")) return;
    // Remove legacy single on/off button if YouTube rebuilt chrome around it
    document.getElementById(BTN_ID)?.remove();
    if (document.getElementById(CONTROLS_ID)) {
      updateBtnUi();
      return;
    }
    const controls =
      document.querySelector(".ytp-right-controls") ||
      document.querySelector(".ytp-chrome-controls") ||
      document.querySelector(".ytp-left-controls");
    if (!controls) return;

    const root = document.createElement("div");
    root.id = CONTROLS_ID;
    root.className = "yt-tldw-controls";
    root.dataset.ytTldwUi = "1";
    function playerButton(action, label, className, icon) {
      const btn = element("button", "ytp-button " + className, icon);
      btn.type = "button";
      btn.dataset.action = action;
      btn.setAttribute("aria-label", label);
      return btn;
    }
    function triangle(points) {
      const ns = "http://www.w3.org/2000/svg";
      const icon = document.createElementNS(ns, "svg");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("class", "yt-tldw-tri");
      icon.setAttribute("aria-hidden", "true");
      const polygon = document.createElementNS(ns, "polygon");
      polygon.setAttribute("points", points);
      polygon.setAttribute("fill", "currentColor");
      icon.append(polygon);
      return icon;
    }
    const auto = playerButton("auto", "Toggle auto-jump", "yt-tldw-btn yt-tldw-auto", centerAutoSvg());
    const spinner = element("span", "yt-tldw-spinner");
    const badge = element("span", "yt-tldw-badge");
    spinner.hidden = badge.hidden = true;
    auto.append(spinner, badge);
    root.append(playerButton("prev", "Previous segment", "yt-tldw-nav", triangle("16,4 6,12 16,20")),
      auto, playerButton("next", "Next segment", "yt-tldw-nav", triangle("8,4 18,12 8,20")));
    root.addEventListener("click", (e) => {
      const t = e.target.closest("[data-action]");
      if (!t || !root.contains(t)) return;
      e.preventDefault();
      e.stopPropagation();
      const action = t.getAttribute("data-action");
      if (action === "prev") jumpToSegment(-1);
      else if (action === "next") jumpToSegment(1);
      else if (action === "auto") setAutoJump(!autoJump);
    });
    if (controls.classList.contains("ytp-right-controls")) controls.insertBefore(root, controls.firstChild);
    else controls.appendChild(root);
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

  function watchPartyPanel() {
    const el = document.getElementById(WATCH_PARTY_PANEL_ID);
    return el && el.isConnected ? el : null;
  }

  /** Watch Party shows #watch-party-panel only while a room session is open. */
  function watchPartyActive() {
    return !!watchPartyPanel();
  }

  function syncWatchPartyChrome() {
    const active = watchPartyActive();
    const panel = document.getElementById(PANEL_ID);
    const dbg = document.getElementById(DEBUG_ID);
    if (panel) panel.classList.toggle("yt-tldw-party", active);
    if (dbg) dbg.classList.toggle("yt-tldw-party", active);
    if (active === watchPartyOpen) return active;
    watchPartyOpen = active;
    debugPush({ event: active ? "watch-party-yield" : "watch-party-resume" });
    updateBtnUi();
    if (panel) mountMomentsPanelHost(panel);
    return active;
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
    if (!enabled) return;
    syncWatchPartyChrome();
    if (watchPartyActive()) {
      // Party sync seeks and pauses the same <video>. Automatic jumps would
      // fight that loop and, for a controller, drag everyone to each segment.
      scheduleTimer = setTimeout(startSchedule, 1000);
      return;
    }
    const video = getVideoEl();
    if (!video || Queue.hold(video)) return;
    if (isAdPlaying()) {
      scheduleTimer = setTimeout(startSchedule, 400);
      return;
    }
    const t = video.currentTime || 0;
    const sp = findSponsorAt(t);
    if (sp) {
      const after = playableWindows.length ? findNextWindow(sp.end) : null;
      const target = after && autoSeek() ? Math.max(sp.end, after.start) : sp.end;
      debugPush({ event: "skip-sponsor", from: t, to: target, category: sp.category });
      setCurrentTime(video, target + 0.01);
      scheduleTimer = setTimeout(startSchedule, 200);
      return;
    }
    // Manual mode: keep watching for sponsors, but do not auto-seek segments.
    if (!autoSeek() || !playableWindows.length) {
      let untilSponsor = Infinity;
      for (const s of sponsorSkips) {
        if (s.start > t) {
          untilSponsor = s.start;
          break;
        }
      }
      if (!Number.isFinite(untilSponsor)) return;
      const rate = video.playbackRate || 1;
      const delay = Math.max(200, ((untilSponsor - t) * 1000) / rate - 60);
      scheduleTimer = setTimeout(() => {
        if (!enabled) return cancelSchedule();
        startSchedule();
      }, delay);
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
          Queue.done();
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
      if (watchPartyActive()) {
        startSchedule();
        return;
      }
      if (!autoSeek()) {
        startSchedule();
        return;
      }
      const now = v.currentTime || 0;
      // Still inside window (pause/seek/slow) — reschedule remainder
      if (now + SKIP_BUFFER < until - 0.05) {
        startSchedule();
        return;
      }
      if (until < win.end) {
        if (now < until) setCurrentTime(v, until + 0.01);
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
        Queue.done();
      }
    }, delay);
  }

  function bindVideoListeners(video) {
    if (!video || video.dataset.ytTldwBound) return;
    video.dataset.ytTldwBound = "1";
    const kick = () => {
      if (enabled && !Queue.hold(video)) startSchedule();
    };
    video.addEventListener("play", kick);
    video.addEventListener("playing", kick);
    video.addEventListener("seeked", kick);
    video.addEventListener("ratechange", kick);
    video.addEventListener("ended", () => {
      if (video === getVideoEl() && !isAdPlaying() && !watchPartyActive() && playableWindows.length) Queue.done();
    });
    // Highlight only — class swap when window index changes (no intervals)
    video.addEventListener("timeupdate", () => {
      if (!enabled || !playableWindows.length) return;
      highlightMomentsPanel(video.currentTime || 0);
    });
  }

  async function fetchSponsorBlock(id) {
    return await api.runtime.sendMessage({ type: "YT_TLDW_SPONSORBLOCK", videoId: id });
  }

  function methodOrder(preferred) {
    if (preferred === "dom") return ["dom", "fallback"];
    if (preferred === "api") return ["api", "dom", "fallback"];
    // Auto stays DOM-first until the server-commanded API path has broader live coverage.
    return ["dom", "fallback"];
  }

  async function trySteps(order, token, { forceFreshDom = false, cancelled = () => false } = {}) {
    const prompt = currentPrompt();
    rememberAskExchange({ prompt });
    const heatOpts = S.heatmapParams(intensity);
    let needFreshDom = !!forceFreshDom;
    for (const step of order) {
      if (token !== runToken || cancelled()) return { moments: [], used: "none", aborted: true };
      if (step === "dom") {
        try {
          if (needFreshDom) {
            try {
              await bridgeCall("resetDomSession", { hard: true }, 3000);
            } catch (_) {}
          }
          const res = await bridgeCall(
            "askDom",
            { forceFresh: needFreshDom || forceFreshDom, prompt },
            DOM_BRIDGE_TIMEOUT_MS
          );
          rememberAskExchange({ prompt, response: res.rawTextPreview || res.error || "" });
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
            genre,
            intensity,
          });
          if (res.ok && res.moments?.length) return { moments: res.moments, used: res.method || "dom" };
        } catch (e) {
          rememberAskExchange({ prompt, response: String(e) });
          debugPush({ event: "method-error", method: "dom", error: String(e) });
          try {
            await bridgeCall("resetDomSession", {}, 3000);
          } catch (_) {}
        }
      } else if (step === "api") {
        try {
          const res = await bridgeCall("askApi", { prompt }, 25000);
          rememberAskExchange({ prompt, response: res.rawTextPreview || res.error || "" });
          debugPush({
            event: "method-result",
            method: res.method || "api",
            ok: !!res.ok,
            latencyMs: res.latencyMs,
            count: res.moments?.length || 0,
            error: res.error,
            rawTextPreview: res.rawTextPreview,
            genre,
            intensity,
          });
          if (res.ok && res.moments?.length) return { moments: res.moments, used: res.method || "api" };
          needFreshDom = true;
          try {
            await bridgeCall("resetDomSession", { hard: true }, 3000);
          } catch (_) {}
          debugPush({ event: "dom-force-fresh-after-api", reason: res.error || "api-fail" });
        } catch (e) {
          const msg = String(e);
          debugPush({ event: "method-error", method: "api", error: msg });
          needFreshDom = true;
          try {
            await bridgeCall("resetDomSession", { hard: true }, 3000);
          } catch (_) {}
          debugPush({ event: "dom-force-fresh-after-api", reason: msg });
        }
      } else if (step === "heatmap") {
        try {
          const heat = await bridgeCall(
            "heatmap",
            { ...heatOpts, waitMs: genre === "popular" ? 5000 : 1200 },
            genre === "popular" ? 9000 : 6000
          );
          debugPush({
            event: "method-result",
            method: "heatmap",
            ok: !!heat.ok,
            latencyMs: heat.latencyMs,
            count: heat.moments?.length || 0,
            error: heat.error,
            genre,
            intensity,
            scoreThreshold: heatOpts.scoreThreshold,
            maxPeaks: heatOpts.maxPeaks,
            defaultDuration: heatOpts.defaultDuration,
            durationScale: heatOpts.durationScale,
            valleyBlend: heatOpts.valleyBlend,
            heatmapSource: heat.heatmapSource || null,
            sampleCount: heat.sampleCount,
            primary: true,
          });
          if (heat.ok && heat.moments?.length) {
            rememberAskExchange({
              prompt: `Popular heatmap (no Ask). peaks≤${heatOpts.maxPeaks}, threshold=${heatOpts.scoreThreshold}, valleyBlend=${heatOpts.valleyBlend}; edges lerp max-curvature→local min`,
              response: (heat.moments || [])
                .map((m) => `${m.title || "peak"} | ${fmt(m.start)} | ${Math.round((m.end || 0) - (m.start || 0))}`)
                .join("\n"),
            });
            return { moments: heat.moments, used: "heatmap" };
          }
        } catch (e) {
          debugPush({ event: "method-error", method: "heatmap", error: String(e), genre, intensity });
        }
      } else if (step === "fallback") {
        try {
          const heat = await bridgeCall("heatmap", { ...heatOpts, waitMs: 1200 }, 6000);
          debugPush({
            event: "method-result",
            method: "heatmap",
            ok: !!heat.ok,
            latencyMs: heat.latencyMs,
            count: heat.moments?.length || 0,
            error: heat.error,
            genre,
            intensity,
            scoreThreshold: heatOpts.scoreThreshold,
            maxPeaks: heatOpts.maxPeaks,
            defaultDuration: heatOpts.defaultDuration,
            durationScale: heatOpts.durationScale,
            valleyBlend: heatOpts.valleyBlend,
            heatmapSource: heat.heatmapSource || null,
            sampleCount: heat.sampleCount,
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

  async function labelPopularHeatmap(moments, token, { forceFreshDom = false } = {}) {
    const windows = Array.isArray(moments) ? moments : [];
    if (!windows.length) return windows;
    const prompt = S.buildPopularTitlePrompt(windows);
    rememberAskExchange({ prompt });
    try {
      const ready = await bridgeCall("waitAskReady", { timeoutMs: ASK_WAIT_MS }, ASK_WAIT_MS + 5000);
      debugPush({
        event: "popular-title-ask-ready",
        ok: !!ready.ok,
        waitedMs: ready.waitedMs,
      });
    } catch (e) {
      debugPush({ event: "popular-title-ask-ready-error", error: String(e) });
    }
    const askSteps = methodOrder(method).filter((s) => s === "api" || s === "dom");
    for (const step of askSteps) {
      if (token !== runToken) return windows;
      try {
        const res =
          step === "api"
            ? await bridgeCall("askApi", { prompt }, 25000)
            : await bridgeCall(
                "askDom",
                { forceFresh: !!forceFreshDom, prompt },
                DOM_BRIDGE_TIMEOUT_MS
              );
        rememberAskExchange({ prompt, response: res.rawTextPreview || res.error || "" });
        debugPush({
          event: "popular-titles",
          ok: !!res.ok,
          method: res.method || step,
          count: res.moments?.length || 0,
          error: res.error,
        });
        if (res.ok && res.moments?.length) {
          return S.applyAskTitlesToHeatmap(windows, res.moments);
        }
      } catch (e) {
        rememberAskExchange({ prompt, response: String(e) });
        debugPush({ event: "popular-titles", ok: false, method: step, error: String(e) });
      }
    }
    return windows;
  }

  async function resolveMoments(preferredMethod, token, { forceFreshDom = false } = {}) {
    await refreshSettings();
    let order;
    if (genre === "popular") {
      // Popular: heatmap chooses times; one later Ask pass titles those windows only.
      order = ["heatmap"];
    } else {
      order = methodOrder(preferredMethod, !!askTemplate);
    }
    debugPush({
      event: "resolve-order",
      preferredMethod,
      order,
      genre,
      intensity,
      hasTemplate: !!askTemplate,
      templateEndpoint: askTemplate?.endpoint || null,
      bodyKeys: askTemplate?.bodyKeys || null,
      apiInAuto: preferredMethod === "auto" ? false : undefined,
      apiNote:
        preferredMethod === "auto"
          ? "server-commanded API is opt-in; auto remains DOM-first"
          : undefined,
    });

    // Readiness wait only if we may touch Ask UI
    if (order.includes("dom") || order.includes("api")) {
      try {
        const wait = mobile ? 3000 : ASK_WAIT_MS;
        const ready = await bridgeCall("waitAskReady", { timeoutMs: wait }, wait + 5000);
        if (!ready.ok) order = ["fallback"];
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
        order = ["fallback"];
      }
    }

    let cancelled = false;
    let hardTimer;
    const work = trySteps(order, token, { forceFreshDom, cancelled: () => cancelled });
    const timeout = new Promise((resolve) =>
      hardTimer = setTimeout(
        () => resolve({ moments: [], used: "none", timedOut: true }),
        RUN_HARD_TIMEOUT_MS
      )
    );
    const result = await Promise.race([work, timeout]).finally(() => clearTimeout(hardTimer));
    if (token !== runToken) return { moments: [], used: "none", aborted: true };
    if (result.timedOut) {
      debugPush({
        event: "method-result",
        method: "hard-timeout",
        ok: false,
        count: 0,
        error: "run hard timeout",
        genre,
        intensity,
      });
      cancelled = true;
      if (genre === "popular") return { moments: [], used: "none", timedOut: true };
      try {
        await bridgeCall("resetDomSession", { hard: true }, 3000);
      } catch (_) {}
      const fb = await trySteps(["fallback"], token);
      debugPush({
        event: "method-result",
        method: "hard-timeout-fallback",
        ok: !!(fb.moments && fb.moments.length),
        count: fb.moments?.length || 0,
        used: fb.used,
      });
      if (fb.moments?.length) return fb;
      return { moments: [], used: "none", timedOut: true };
    }
    if (result.aborted) return result;
    if (genre === "popular") {
      if (!result.moments?.length) return result;
      const labeled = await labelPopularHeatmap(result.moments, token, { forceFreshDom });
      return { ...result, moments: labeled, used: result.used || "heatmap" };
    }
    if (result.moments?.length) return result;
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
    api.storage.local.set({ momentsPanelCollapsed }).catch(() => {});
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
    // Prefer secondary column (above related); fall back to fixed overlay.
    // Watch Party docks #watch-party-panel at the top of that column.
    const secondary =
      (mobile && document.querySelector("ytm-watch .watch-below-the-player, #watch-below-the-player, ytm-watch #below, ytm-slim-video-metadata-section")) ||
      document.querySelector("#secondary-inner") ||
      document.querySelector("#secondary") ||
      document.querySelector("#related");
    const party = watchPartyPanel();
    if (secondary) {
      panel.classList.add("yt-tldw-panel-inline");
      panel.classList.remove("yt-tldw-panel-overlay");
      if (party && secondary.contains(party)) {
        if (panel.previousElementSibling !== party) party.insertAdjacentElement("afterend", panel);
      } else if (panel.parentElement !== secondary) {
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

  function renderMomentsPanel({ used, emptyHint = null } = {}) {
    if (!enabled) {
      removeMomentsPanel();
      return;
    }
    if (!playableWindows.length && !sponsorSkips.length && !emptyHint && !momentsShowAskIo) {
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
        if (action === "toggle-ask-io") {
          ev.preventDefault();
          ev.stopPropagation();
          setMomentsShowAskIo(!momentsShowAskIo);
          return;
        }
        if (action === "seek") {
          const start = Number(t.getAttribute("data-start"));
          if (!isFinite(start)) return;
          const v = getVideoEl();
          if (!v) return;
          setCurrentTime(v, start + 0.01);
          if (v.paused) v.play?.().catch(() => {});
          if (enabled) startSchedule();
          highlightMomentsPanel(start + 0.05);
        }
      });
    }
    el.classList.toggle("yt-tldw-collapsed", momentsPanelCollapsed);
    el.classList.toggle("yt-tldw-show-ask-io", momentsShowAskIo);
    const methodLabel = lastUsedMethod || method || "—";
    const giLabel = S.labelGenre(genre) + " · " + S.labelIntensity(intensity);
    const keptLabel = fmt(kept) + (duration ? " / " + fmt(duration) : "");
    const meta = element("span", "yt-tldw-panel-meta", [giLabel, methodLabel, playableWindows.length, keptLabel].join(" · "));
    const title = element("div", "yt-tldw-panel-title", element("strong", "", "YT-TLDW"), meta);
    title.dataset.action = "toggle";
    const prompt = element("button", "yt-tldw-ask-io-toggle", "Prompt");
    prompt.type = "button";
    prompt.dataset.action = "toggle-ask-io";
    prompt.classList.toggle("is-on", momentsShowAskIo);
    prompt.title = "Show Ask prompt and response";
    prompt.setAttribute("aria-pressed", String(momentsShowAskIo));
    const chev = element("span", "yt-tldw-panel-chev");
    chev.dataset.action = "toggle";
    chev.setAttribute("aria-hidden", "true");
    const body = element("div", "yt-tldw-panel-body");
    if (momentsShowAskIo) {
      const askSection = (heading, text) => element("div", "yt-tldw-ask-io-sec",
        element("div", "yt-tldw-ask-io-h", heading), element("pre", "yt-tldw-ask-io-pre", text || "(none yet)"));
      body.append(element("div", "yt-tldw-ask-io",
        askSection("Prompt", lastAskPrompt), askSection("Response", lastAskResponse)));
    }
    function row(tag, className, segment, label) {
      const range = fmt(segment.start) + "–" + fmt(segment.end);
      const item = element(tag, className, element("span", "yt-tldw-row-t", range),
        element("span", "yt-tldw-row-l", label));
      item.dataset.start = segment.start;
      item.title = label + " · " + range;
      return item;
    }
    playableWindows.forEach((window, index) => {
      const item = row("button", "yt-tldw-row", window, window.title || "Moment");
      item.type = "button";
      item.dataset.action = "seek";
      item.dataset.idx = index;
      body.append(item);
    });
    sponsorSkips.forEach((skip) => body.append(row("div", "yt-tldw-row yt-tldw-sponsor", skip,
      "Skip: " + (skip.category || "sponsor"))));
    if (!playableWindows.length && !sponsorSkips.length) body.append(element("div", "yt-tldw-empty", emptyHint || "No moments"));
    el.replaceChildren(element("div", "yt-tldw-panel-hd", title, prompt, chev), body);
    mountMomentsPanelHost(el);
    activeWindowIdx = -1;
    highlightMomentsPanel(video?.currentTime || 0);
  }

  async function finishRun({ id, settings, moments, used, sb, t0, token, jumpToFirst = false }) {
    if (token !== runToken || id !== getVideoIdFromUrl()) return;
    if (Queue.isActive() && !getVideoEl()) {
      const deadline = Date.now() + 5000;
      while (!getVideoEl() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (token !== runToken || id !== getVideoIdFromUrl()) return;
      }
    }
    playableWindows = buildWindows(moments, sb?.segments || []);
    const totalMs = Math.round(performance.now() - t0);

    debugPush({
      event: "ready",
      usedMethod: used,
      effectiveMethod: settings.method,
      genre: settings.genre || genre,
      intensity: settings.intensity || intensity,
      latencyMs: totalMs,
      windows: playableWindows.length,
      jumpToFirst: !!jumpToFirst,
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
    const emptyHint =
      !playableWindows.length && genre === "popular"
        ? "No most-replayed graph on this video"
        : !playableWindows.length
          ? "No moments"
          : null;
    renderMomentsPanel({ used, emptyHint });
    updatePreviewBar();

    const video = getVideoEl();
    bindVideoListeners(video);
    const party = watchPartyActive();
    syncWatchPartyChrome();
    if (video && playableWindows.length) {
      const first = playableWindows[0];
      const t = video.currentTime || 0;
      if (party) {
        debugPush({ event: "watch-party-hold", note: "left playhead with Watch Party" });
      } else if (jumpToFirst && first) {
        debugPush({ event: "apply-jump-first", to: first.start, title: first.title });
        setCurrentTime(video, first.start + 0.01);
      } else if (autoSeek() && !findContainingWindow(t) && first) {
        setCurrentTime(video, first.start + 0.01);
      }
      startSchedule();
      highlightMomentsPanel(video.currentTime || 0);
      if (!party && Queue.isActive()) Queue.ready(video, true);
      else if (!party && (jumpToFirst || autoJump) && video.paused) video.play?.().catch(() => {});
    } else {
      if (!party) Queue.ready(video, false);
      if (enabled) startSchedule(); // sponsor skips may still apply
      debugPush({
        event: "no-windows",
        hint:
          genre === "popular"
            ? "Popular needs YouTube’s most-replayed scrub-bar graph (HEATSEEKER or ytp-modern-heat-map)."
            : "No moments. Check Copy log (get_panel pipe moments / template).",
        effectiveMethod: settings.method,
        genre,
      });
    }
  }

  async function runForCurrentVideo({ forceFresh = false, jumpToFirst = false } = {}) {
    const id = getVideoIdFromUrl();
    if (!id || (!forceFresh && runningForId === id)) return;
    const token = ++runToken;
    videoId = id;
    runningForId = id;
    cancelSchedule();
    playableWindows = [];
    sponsorSkips = [];
    activeWindowIdx = -1;

    await Queue.prepare(id, getVideoEl());
    Queue.hold(getVideoEl());
    const settings = await refreshSettings();
    if (token !== runToken || id !== getVideoIdFromUrl()) return;
    updateBtnUi();
    renderDebug();

    if (!settings.enabled || !id) {
      runningForId = null;
      setBtnStatus("idle", 0);
      removeMomentsPanel();
      previewBar?.clear();
      return;
    }
    setBtnStatus("loading", 0);

    const t0 = performance.now();
    debugPush({
      event: "start",
      videoId: id,
      method: settings.method,
      effectiveMethod: settings.method,
      genre: settings.genre,
      intensity: settings.intensity,
      hasTemplate: !!settings.askTemplate,
      forceFresh,
      jumpToFirst,
    });

    if (forceFresh) {
      lastAskResponse = "";
      rememberAskExchange({ prompt: currentPrompt() });
    }

    const sbPromise = fetchSponsorBlock(id).catch(() => null);
    try {
      await ensureBridge();
    } catch (e) {
      debugPush({ event: "bridge-failed", error: String(e) });
      debugPush({ event: "method-result", method: "none", ok: false, count: 0, error: String(e) });
      await finishRun({ id, settings, moments: [], used: "none", sb: await sbPromise, t0, token, jumpToFirst });
      return;
    }

    // Settings Apply is an explicit re-extraction. Cancel any in-flight MAIN-world
    // Ask before starting so it cannot be mistaken for the new prompt/session.
    if (forceFresh) {
      try {
        await bridgeCall("resetDomSession", { hard: true }, 3000);
      } catch (_) {}
      if (token !== runToken) return;
    }

    let resolved;
    try {
      resolved = await resolveMoments(settings.method, token, { forceFreshDom: !!forceFresh });
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
    // Popular must stay on the most-replayed graph — do not invent moments from SB POI/Ask.
    if (!moments.length && pois.length && genre !== "popular") {
      moments = pois.map((p) => ({
        start: p.start,
        end: p.start + DEFAULT_MOMENT_DUR,
        title: "SB highlight",
        source: "poi_highlight",
      }));
      used = "poi_highlight";
      debugPush({ event: "method-result", method: "poi_highlight", ok: true, count: moments.length, genre, intensity });
    }

    // Ask durations come from the model. Popular heatmap already caps peaks by intensity.
    await finishRun({ id, settings, moments, used, sb, t0, token, jumpToFirst });
  }

  let navigationTimer;
  let seenUrlVideo;
  function onNavigate() {
    const id = getVideoIdFromUrl();
    if (id === seenUrlVideo) return;
    seenUrlVideo = id;
    clearTimeout(navigationTimer);
    runToken++;
    runningForId = null;
    cancelSchedule();
    playableWindows = [];
    sponsorSkips = [];
    activeWindowIdx = -1;
    lastAskPrompt = "";
    lastAskResponse = "";
    lastDebug = [];
    lastUsedMethod = "";
    removeMomentsPanel();
    previewBar?.clear();
    setBtnStatus("idle", 0);
    Queue.prepare(id, getVideoEl());
    if (id) {
      navigationTimer = setTimeout(() => {
        injectPlayerButton();
        runForCurrentVideo();
      }, 450);
    }
  }

  api.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "YT_TLDW_STATE") {
      enabled = !!msg.enabled || Queue.isActive();
      updateBtnUi();
      if (enabled) {
        runForCurrentVideo();
      } else {
        runToken++;
        runningForId = null;
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

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    (async () => {
      const before = { method, genre, intensity, enabled };
      await refreshSettings();
      const settingsChanged = !!(changes.method || changes.genre || changes.intensity);
      const applied = !!changes.applyAt;
      if (settingsChanged || applied) {
        debugPush({
          event: settingsChanged ? "settings-changed" : "apply-refresh",
          from: before,
          method,
          genre,
          intensity,
          enabled,
          applyAt: changes.applyAt?.newValue,
        });
        if (enabled) {
          // Apply always re-extracts and starts playback at the first section.
          runForCurrentVideo({ forceFresh: true, jumpToFirst: true });
        }
      }
      if (changes.askTemplate) {
        askTemplate = changes.askTemplate.newValue || null;
        debugPush({ event: "template-updated", hasTemplate: !!askTemplate });
      }
      if (changes.debug) {
        debug = changes.debug.newValue !== false;
        if (!debug) clearDebugLogging();
        else renderDebug();
      }
      if (changes.momentsPanelCollapsed) {
        momentsPanelCollapsed = !!changes.momentsPanelCollapsed.newValue;
        const el = document.getElementById(PANEL_ID);
        if (el) el.classList.toggle("yt-tldw-collapsed", momentsPanelCollapsed);
      }
      if (changes.momentsShowAskIo) {
        momentsShowAskIo = !!changes.momentsShowAskIo.newValue;
        renderMomentsPanel({ used: lastUsedMethod || undefined });
      }
      if (changes.enabled) {
        enabled = !!changes.enabled.newValue || Queue.isActive();
        updateBtnUi();
        if (enabled) runForCurrentVideo();
        else {
          runToken++;
          runningForId = null;
          cancelSchedule();
          playableWindows = [];
          removeMomentsPanel();
          previewBar?.clear();
        }
      }
      if (changes.autoJump) {
        autoJump = changes.autoJump.newValue !== false;
        updateBtnUi();
        if (enabled) startSchedule();
      }
    })();
  });

  async function init() {
    await refreshSettings();
    injectPlayerButton();
    updateBtnUi();
    document.addEventListener("yt-navigate-finish", onNavigate);
    window.addEventListener("popstate", onNavigate);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) onNavigate();
    });
    let btnObsTimer = null;
    const obs = new MutationObserver((mutations) => {
      onNavigate();
      const partyBefore = watchPartyOpen;
      syncWatchPartyChrome();
      if (!partyBefore && watchPartyOpen && enabled) {
        cancelSchedule();
        scheduleTimer = setTimeout(startSchedule, 250);
      }
      // Ignore our own debug UI mutations
      for (const m of mutations) {
        const t = m.target;
        if (
          t?.closest?.("#yt-tldw-debug, #yt-tldw-moments, #yt-tldw-player-controls") ||
          t?.id === DEBUG_ID ||
          t?.id === PANEL_ID ||
          t?.id === CONTROLS_ID ||
          t?.dataset?.ytTldwUi
        )
          return;
      }
      if (document.getElementById(CONTROLS_ID)) return; // already present — do not touch (avoids class thrash loop)
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
      if (document.getElementById(CONTROLS_ID) || ++tries > 40) clearInterval(bootBtn);
    }, 500);
    onNavigate();
    log("content init", { enabled, method, genre, intensity, autoJump, hasTemplate: !!askTemplate });
  }

  init();
})();
