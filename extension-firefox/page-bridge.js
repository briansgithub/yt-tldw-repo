/* YT-TLDW page-bridge — MAIN world (GPL-3.0) v0.1.27 */

(function () {
  if (window.__ytTldwBridgeInstalled) return;
  window.__ytTldwBridgeInstalled = true;

  const CHANNEL = "YT_TLDW_BRIDGE";
  let ACTIVE_PROMPT =
    "List the essential / most important moments in this video. " +
    "For each moment give: a short title, the start timestamp, and approximate duration in seconds. " +
    "Prefer the parts viewers must watch to understand the video; skip intros, outros, and sponsor reads. " +
    "Format each as: TITLE | MM:SS | DURATION_SECONDS";

  function setActivePrompt(prompt) {
    if (typeof prompt === "string" && prompt.trim().length > 20) ACTIVE_PROMPT = prompt.trim();
  }

  const askCache = {
    commands: [],
    chips: [],
    panelIds: new Set(),
    continuations: [],
    lastSource: "",
    hasTemplateShape: false,
    /** @type {{videoId:string, continuation:string, at:number}|null} */
    lastContinuation: null,
  };

  const domSession = {
    videoId: null,
    prompted: false,
    promptSentAt: 0,
    baselineFingerprints: new Set(),
    /** Set while askViaDom is waiting; get_panel moments resolve this. */
    netWait: null,
  };

  let captureArmed = false;
  let sessionResolved = false; // stop heavy work once moments settle
  const capturedCalls = [];
  let lastTemplateCandidate = null;
  let lastBodySample = "";

  function emit(event, detail) {
    window.postMessage(
      { source: CHANNEL, direction: "event", event, detail: { event, t: Date.now(), ...(detail || {}) } },
      "*"
    );
  }

  function reply(id, payload) {
    window.postMessage({ source: CHANNEL, direction: "response", id, ...payload }, "*");
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function deepQuery(selector, root = document) {
    const hit = root.querySelector?.(selector);
    if (hit) return hit;
    for (const el of root.querySelectorAll?.("*") || []) {
      if (el.shadowRoot) {
        const nested = deepQuery(selector, el.shadowRoot);
        if (nested) return nested;
      }
    }
    return null;
  }

  function deepQueryAll(selector, root = document, acc = []) {
    try {
      root.querySelectorAll?.(selector)?.forEach((el) => acc.push(el));
    } catch (_) {}
    for (const el of root.querySelectorAll?.("*") || []) {
      if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, acc);
    }
    return acc;
  }

  function waitFor(fn, timeoutMs = 12000, intervalMs = 150) {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const tick = () => {
        try {
          const v = fn();
          if (v) return resolve(v);
        } catch (_) {}
        if (performance.now() - t0 > timeoutMs) return reject(new Error("timeout"));
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  function parseTimestampToSeconds(text) {
    if (text == null) return null;
    if (typeof text === "number" && Number.isFinite(text)) return text;
    const s = String(text).trim();
    const hms = s.match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
    if (hms) {
      const h = hms[1] ? parseInt(hms[1], 10) : 0;
      return h * 3600 + parseInt(hms[2], 10) * 60 + parseInt(hms[3], 10);
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function isProbablyTimestampLabel(s) {
    return /^\d{1,2}:\d{2}(?::\d{2})?$/.test(String(s || "").trim());
  }

  function dedupeMoments(moments) {
    const sorted = moments
      .filter((m) => m && Number.isFinite(m.start) && m.start >= 0 && m.end > m.start)
      .sort((a, b) => a.start - b.start);
    const out = [];
    for (const m of sorted) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.start - m.start) < 2) {
        last.end = Math.max(last.end, m.end);
        if ((!last.title || isProbablyTimestampLabel(last.title)) && m.title && !isProbablyTimestampLabel(m.title)) {
          last.title = m.title;
        }
        continue;
      }
      out.push({ ...m });
    }
    return out;
  }

  function stripMd(s) {
    return String(s || "")
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*[*•\-]\s+/, "")
      .replace(/\*\*/g, "")
      .replace(/__|`/g, "")
      .trim();
  }

  /** Prefer TITLE | MM:SS | DURATION; tolerate markdown bullets. */
  function parseMomentsFromText(text, defaultDuration = 35, sourcePrefix = "text") {
    const moments = [];
    if (!text) return moments;
    const lines = String(text).split(/\n+/);

    for (const raw of lines) {
      const line = stripMd(raw);
      if (!line || /^essential moments/i.test(line)) continue;

      const pipe = line.match(
        /^(.+?)\s*\|\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\|\s*(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:onds)?)?)?\s*$/i
      );
      if (pipe) {
        const start = parseTimestampToSeconds(pipe[2]);
        const dur = parseFloat(pipe[3]);
        if (start != null && dur > 0) {
          moments.push({
            start,
            end: start + dur,
            title: pipe[1].trim().slice(0, 100),
            source: sourcePrefix + "-pipe",
            duration: dur,
          });
          continue;
        }
      }
      // Inline pipe with trailing junk
      const pipeLoose = line.match(
        /(.+?)\s*\|\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\|\s*(\d+(?:\.\d+)?)/
      );
      if (pipeLoose) {
        const start = parseTimestampToSeconds(pipeLoose[2]);
        const dur = parseFloat(pipeLoose[3]);
        const title = stripMd(pipeLoose[1]).slice(0, 100);
        if (start != null && dur > 0 && title && !isProbablyTimestampLabel(title)) {
          moments.push({
            start,
            end: start + dur,
            title,
            source: sourcePrefix + "-pipe",
            duration: dur,
          });
          continue;
        }
      }

      const titled = line.match(
        /^(.{3,80}?)\s*[-–—:]\s*(\d{1,2}:\d{2}(?::\d{2})?)\b(?:.*?(\d{1,3})\s*(?:s|sec|seconds))?/i
      );
      if (titled && !isProbablyTimestampLabel(titled[1])) {
        const start = parseTimestampToSeconds(titled[2]);
        const dur = titled[3] ? parseFloat(titled[3]) : defaultDuration;
        if (start != null) {
          moments.push({
            start,
            end: start + dur,
            title: titled[1].replace(/^\d+[\).\s]+/, "").trim().slice(0, 100),
            source: sourcePrefix + "-titled",
            duration: dur,
          });
          continue;
        }
      }
      const range = line.match(
        /(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—to]+\s*(\d{1,2}:\d{2}(?::\d{2})?)/i
      );
      if (range) {
        const start = parseTimestampToSeconds(range[1]);
        const end = parseTimestampToSeconds(range[2]);
        if (start != null && end != null && end > start) {
          const title = line.replace(range[0], "").replace(/[|•]/g, " ").trim().slice(0, 100);
          moments.push({
            start,
            end,
            title: title && !isProbablyTimestampLabel(title) ? title : "",
            source: sourcePrefix + "-range",
          });
          continue;
        }
      }
      const ts = line.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
      if (ts) {
        const start = parseTimestampToSeconds(ts[1]);
        if (start != null) {
          let title = line.replace(ts[1], "").replace(/[|•\-–—]/g, " ").trim().slice(0, 100);
          if (isProbablyTimestampLabel(title)) title = "";
          moments.push({ start, end: start + defaultDuration, title, source: sourcePrefix + "-ts" });
        }
      }
    }
    return dedupeMoments(moments);
  }

  function parsePipeMomentsOnly(text, source = "ask-network") {
    return parseMomentsFromText(text, 35, "pipe")
      .filter((m) => m.source.includes("pipe"))
      .map((m) => ({ ...m, source }));
  }

  function parseMomentsFromMessageEl(el, defaultDuration = 35) {
    if (!el) return [];
    const moments = [];
    const anchors = el.querySelectorAll?.('a[href*="t="], a[href*="start="]') || [];
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const t = href.match(/[?&#]t=(\d+)/) || href.match(/start=(\d+)/);
      if (!t) continue;
      const start = parseInt(t[1], 10);
      let title = (a.textContent || "").trim();
      if (isProbablyTimestampLabel(title)) {
        const row = a.closest("li, p, div, span, yt-formatted-string") || a.parentElement;
        const rowText = (row?.innerText || "").replace(title, "").replace(/\s+/g, " ").trim();
        title = stripMd(rowText).slice(0, 100);
        if (isProbablyTimestampLabel(title)) title = "";
      }
      let dur = defaultDuration;
      const near = (a.parentElement?.innerText || el.innerText || "").slice(0, 500);
      const durMatch = near.match(/\|\s*(\d{1,3})\s*(?:s(?:ec(?:onds)?)?)?\b/i);
      if (durMatch) dur = parseFloat(durMatch[1]);
      moments.push({ start, end: start + dur, title, source: "dom-link", duration: dur });
    }
    return dedupeMoments(moments.concat(parseMomentsFromText(el.innerText || "", defaultDuration, "dom")));
  }

  function getYtcfgValue(key) {
    try {
      if (window.ytcfg?.get) return window.ytcfg.get(key);
    } catch (_) {}
    try {
      return window.ytcfg?.data_?.[key];
    } catch (_) {}
    return undefined;
  }

  function getInnertubeContext() {
    const ctx = getYtcfgValue("INNERTUBE_CONTEXT");
    if (ctx) return JSON.parse(JSON.stringify(ctx));
    return {
      client: {
        clientName: "WEB",
        clientVersion: getYtcfgValue("INNERTUBE_CLIENT_VERSION") || "2.20260101.00.00",
        hl: "en",
        gl: "US",
      },
    };
  }

  function getVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname === "/watch") return u.searchParams.get("v");
    } catch (_) {}
    return null;
  }

  function getYtInitialData() {
    const watch = document.querySelector("ytm-watch");
    const data = watch?.data || watch?.__data?.data;
    const id = getVideoId();
    if (data && id && (data.currentVideoEndpoint?.watchEndpoint?.videoId === id ||
        data.videoId === id)) return data;
    // window.ytInitialData is only the first page load; after SPA navigation it describes a
    // different video, so never hand its chapters/heatmap/Ask commands to the current one.
    const init = window.ytInitialData || null;
    const initId = init?.currentVideoEndpoint?.watchEndpoint?.videoId;
    if (init && id && initId && initId !== id) return null;
    return init;
  }

  function findYouChatStructures(obj, acc = { panels: [], commands: [], chips: [], texts: [] }, depth = 0) {
    if (!obj || depth > 40) return acc;
    if (Array.isArray(obj)) {
      for (const item of obj) findYouChatStructures(item, acc, depth + 1);
      return acc;
    }
    if (typeof obj !== "object") return acc;
    if (obj.targetId === "PAyouchat" || obj.panelIdentifier === "PAyouchat") acc.panels.push(obj);
    if (obj.chatInputViewModel?.sendUserQueryCommand) {
      acc.commands.push(obj.chatInputViewModel.sendUserQueryCommand);
    }
    if (obj.youChatItemViewModel?.sendUserQueryCommand) {
      acc.commands.push(obj.youChatItemViewModel.sendUserQueryCommand);
    }
    if (obj.chipData?.continuation) acc.chips.push(obj.chipData);
    if (obj.youChatItemViewModel?.text?.content) acc.texts.push(obj.youChatItemViewModel.text.content);
    for (const k of Object.keys(obj)) {
      if (k === "loggingContext" || k === "trackingParams") continue;
      findYouChatStructures(obj[k], acc, depth + 1);
    }
    return acc;
  }

  function extractContinuation(command) {
    const c =
      command?.innertubeCommand?.continuationCommand ||
      command?.continuationCommand ||
      command?.command?.continuationCommand;
    const continuation = c?.token || c?.continuation;
    const request = c?.request;
    const clickTrackingParams =
      command?.innertubeCommand?.clickTrackingParams || command?.clickTrackingParams;
    if (
      !continuation ||
      !clickTrackingParams ||
      (request && request !== "CONTINUATION_REQUEST_TYPE_GET_PANEL")
    ) {
      return null;
    }
    return {
      continuation,
      clickTrackingParams,
    };
  }

  function mergeAskFindings(found, source) {
    let addedCmd = 0;
    let addedChip = 0;
    let addedPanel = 0;
    for (const c of found.commands || []) {
      const ex = extractContinuation(c);
      if (!ex) continue;
      if (!askCache.commands.some((x) => x.continuation === ex.continuation)) {
        askCache.commands.push({ ...ex, raw: c });
        addedCmd++;
      }
    }
    for (const chip of found.chips || []) {
      if (!chip.continuation) continue;
      if (!askCache.chips.some((x) => x.continuation === chip.continuation)) {
        askCache.chips.push(chip);
        addedChip++;
      }
    }
    for (const p of found.panels || []) {
      const id = p.targetId || p.panelIdentifier || "panel";
      if (!askCache.panelIds.has(id)) {
        askCache.panelIds.add(id);
        addedPanel++;
      }
    }
    const grab = (o, d = 0) => {
      if (!o || d > 35) return;
      if (Array.isArray(o)) return o.forEach((x) => grab(x, d + 1));
      if (typeof o !== "object") return;
      if (o.continuationCommand?.continuation) {
        const cont = o.continuationCommand.continuation;
        if (!askCache.continuations.includes(cont)) askCache.continuations.push(cont);
      }
      for (const k of Object.keys(o)) grab(o[k], d + 1);
    };
    grab(found);
    askCache.lastSource = source;
    if (addedCmd || addedChip || addedPanel) {
      emit("ask-cache", {
        source,
        commands: askCache.commands.length,
        chips: askCache.chips.length,
        panels: askCache.panelIds.size,
        conts: askCache.continuations.length,
        added: { addedCmd, addedChip, addedPanel },
      });
    }
  }

  function ingestJsonForAsk(json, source) {
    if (!json || sessionResolved) return;
    // After prompt, skip heavy cache walks — moments come from maybeCapture
    if (domSession.prompted) return;
    mergeAskFindings(findYouChatStructures(json), source);
  }

  function collectAssistantTexts(json) {
    const found = findYouChatStructures(json || {});
    const texts = [...found.texts];
    const walk = (o, d = 0) => {
      if (!o || d > 30 || texts.length > 40) return;
      if (typeof o === "string") {
        if ((o.includes("|") && /\d{1,2}:\d{2}/.test(o)) || (/\d{1,2}:\d{2}/.test(o) && o.length > 20 && o.length < 12000)) {
          texts.push(o);
        }
        return;
      }
      if (Array.isArray(o)) return o.forEach((x) => walk(x, d + 1));
      if (typeof o === "object") {
        if (typeof o.content === "string") walk(o.content, d + 1);
        for (const k of Object.keys(o)) walk(o[k], d + 1);
      }
    };
    walk(json);
    return [...new Set(texts)];
  }

  function bodyKeySummary(body) {
    try {
      const o = typeof body === "string" ? JSON.parse(body) : body;
      if (!o || typeof o !== "object") return [];
      const keys = Object.keys(o).filter((k) => /^[\x20-\x7e]{1,64}$/.test(k)).slice(0, 24);
      if (!keys.length) return ["(nonprintable-keys:" + Object.keys(o).length + ")"];
      const nested = [];
      if (o.formData) nested.push("formData:" + Object.keys(o.formData).filter((k) => /^[\x20-\x7e]+$/.test(k)).join(","));
      if (o.formData?.inputComposerFormData) {
        nested.push("inputComposer:" + Object.keys(o.formData.inputComposerFormData).join(","));
      }
      if (o.continuation) nested.push("continuation:yes");
      if (o.context?.client) nested.push("client:" + (o.context.client.clientName || "?"));
      return keys.concat(nested);
    } catch (_) {
      return typeof body === "string" && body.length ? ["(unparsed:" + body.length + ")"] : [];
    }
  }

  function sanitizeHeaders(h) {
    const out = {};
    const allow = [
      "content-type",
      "x-youtube-client-name",
      "x-youtube-client-version",
      "x-goog-visitor-id",
      "x-youtube-bootstrap-logged-in",
    ];
    let src = {};
    try {
      if (h instanceof Headers) src = Object.fromEntries(h.entries());
      else if (Array.isArray(h)) src = Object.fromEntries(h);
      else if (h && typeof h === "object") src = h;
    } catch (_) {}
    for (const [k, v] of Object.entries(src)) {
      const lk = String(k).toLowerCase();
      if (allow.includes(lk)) out[lk] = v;
    }
    return out;
  }

  function looksMostlyBinary(s) {
    if (!s || typeof s !== "string") return false;
    // gzip magic as Latin-1 chars
    if (s.length >= 2 && s.charCodeAt(0) === 0x1f && s.charCodeAt(1) === 0x8b) return true;
    let bad = 0;
    const n = Math.min(s.length, 256);
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      if (c === 0 || c > 127) bad++;
    }
    return bad / n > 0.25;
  }

  function stringToU8(s) {
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
    return u8;
  }

  async function gunzipToText(bytes) {
    if (!bytes || bytes.length < 2) return null;
    // Exact gzip magic
    let u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8[0] !== 0x1f || u8[1] !== 0x8b) return null;
    try {
      if (typeof DecompressionStream === "undefined") return null;
      const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
      const text = await new Response(stream).text();
      return text;
    } catch (e) {
      try {
        // Some environments need the buffer copied (detached views)
        const copy = u8.slice();
        const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("gzip"));
        return await new Response(stream).text();
      } catch (_) {
        return null;
      }
    }
  }

  function bytesToLatin1(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    // Build in chunks to avoid argument limits
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return s;
  }

  async function bodyToBytes(body) {
    if (body == null) return null;
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      return new Uint8Array(await body.arrayBuffer());
    }
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
      return new Uint8Array(await new Response(body).arrayBuffer());
    }
    return null;
  }

  function isUsableAskTemplateBody(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    if (!body.context || typeof body.context !== "object") return false;
    // Continuation-only panel loads are NOT ask prompts — replay needs composer+userInput
    const composer = body.formData?.inputComposerFormData;
    if (!composer || typeof composer !== "object") return false;
    const keys = Object.keys(body);
    if (!keys.length) return false;
    const printable = keys.filter((k) => /^[A-Za-z0-9_./$-]+$/.test(k));
    if (printable.length < Math.min(2, keys.length)) return false;
    return true;
  }

  function isPersistableAskTemplate(body, pipeCount, afterPrompt) {
    if (!isUsableAskTemplateBody(body)) return false;
    const userInput = body.formData?.inputComposerFormData?.userInputText;
    const hasUser = typeof userInput === "string" && userInput.trim().length > 0;
    // 0.1.13: never persist on afterPrompt alone — our own API replays set
    // prompted + async fetch-hook capture after _apiReplaying clears, which
    // regressed the 0.1.8 "don't save empty replays" fix. Require real moments.
    if (pipeCount >= 1 && hasUser) return true;
    return false;
  }

  function isApiReplaying() {
    return (
      !!domSession._apiReplaying ||
      (!!domSession._apiReplayUntil && Date.now() < domSession._apiReplayUntil)
    );
  }

  /** Collect continuation tokens from an Innertube JSON blob (poll/follow). */
  function findContinuationTokens(json) {
    const out = [];
    const walk = (o, d = 0) => {
      if (!o || d > 28 || out.length > 10) return;
      if (typeof o === "string") return;
      if (Array.isArray(o)) return o.forEach((x) => walk(x, d + 1));
      if (typeof o !== "object") return;
      if (typeof o.continuation === "string" && o.continuation.length > 24) out.push(o.continuation);
      const cc = o.continuationCommand?.continuation;
      if (typeof cc === "string" && cc.length > 24) out.push(cc);
      for (const k of Object.keys(o)) walk(o[k], d + 1);
    };
    walk(json);
    return [...new Set(out)];
  }

  function tryParseRequestBody(bodyStr) {
    if (bodyStr == null) return { ok: false, obj: null, sample: "", note: "empty" };
    if (typeof bodyStr !== "string") {
      try {
        if (typeof bodyStr === "object" && !ArrayBuffer.isView(bodyStr) && !(bodyStr instanceof ArrayBuffer)) {
          return { ok: true, obj: bodyStr, sample: "", note: "object" };
        }
      } catch (_) {}
      return { ok: false, obj: null, sample: String(bodyStr).slice(0, 200), note: "non-string" };
    }
    let s = bodyStr.replace(/^\uFEFF/, "");
    // gzip-as-latin1 → should have been decompressed in bodyToString; still guard
    if (looksMostlyBinary(s)) {
      return {
        ok: false,
        obj: null,
        sample: "gzip/binary len=" + s.length + " head=" + Array.from(stringToU8(s.slice(0, 8))).map((b) => b.toString(16).padStart(2, "0")).join(""),
        note: "gzip-or-binary",
      };
    }
    s = s.trim();
    if (s.startsWith(")]}'")) {
      s = s.replace(/^\)\]\}'\n?/, "").trim();
    }
    const sample = s.slice(0, 200);
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return { ok: true, obj: JSON.parse(s), sample, note: "json" };
      } catch (_) {}
    }
    // URL-encoded only if it looks like real form data (printable keys)
    if (/^[A-Za-z0-9_.%+-]+=/.test(s) && s.includes("=")) {
      try {
        const params = new URLSearchParams(s);
        const asObj = {};
        let goodKeys = 0;
        for (const [k, v] of params.entries()) {
          if (!/^[A-Za-z0-9_./$-]+$/.test(k)) continue;
          goodKeys++;
          asObj[k] = v;
          if ((k === "json" || k === "body" || k.endsWith("Json")) && typeof v === "string" && v.trim().startsWith("{")) {
            try {
              asObj[k + "_parsed"] = JSON.parse(v);
            } catch (_) {}
          }
        }
        if (goodKeys > 0 && Object.keys(asObj).length) return { ok: true, obj: asObj, sample, note: "urlencoded" };
      } catch (_) {}
      try {
        const dec = decodeURIComponent(s);
        if (dec.trim().startsWith("{")) {
          return { ok: true, obj: JSON.parse(dec), sample: dec.slice(0, 200), note: "uri-json" };
        }
      } catch (_) {}
    }
    const brace = s.indexOf("{");
    if (brace >= 0 && brace < 64) {
      try {
        return { ok: true, obj: JSON.parse(s.slice(brace)), sample, note: "embedded-json" };
      } catch (_) {}
    }
    return { ok: false, obj: null, sample, note: "unparsed" };
  }

  function sanitizeBodyForTemplate(bodyStr) {
    const parsed = tryParseRequestBody(bodyStr);
    if (!parsed.ok || !parsed.obj || typeof parsed.obj !== "object") return null;
    try {
      const clone = JSON.parse(JSON.stringify(parsed.obj));
      // Prefer nested parsed JSON if form wrapper
      const candidate = clone.json_parsed || clone.body_parsed || clone;
      if (!isUsableAskTemplateBody(candidate) && !isUsableAskTemplateBody(clone)) return null;
      const out = isUsableAskTemplateBody(candidate) ? candidate : clone;
      if (out.context) {
        delete out.context.user;
        delete out.context.request?.sessionInfo;
        delete out.context.clickTracking;
      }
      return out;
    } catch (_) {
      return null;
    }
  }

  async function bodyToString(body) {
    if (body == null) return null;
    if (typeof body === "string") {
      // Already-decoded string: only try gunzip if latin1-preserved gzip magic (1f 8b)
      if (body.length >= 2 && body.charCodeAt(0) === 0x1f && body.charCodeAt(1) === 0x8b) {
        const gunzipped = await gunzipToText(stringToU8(body));
        if (gunzipped) return gunzipped;
      }
      // UTF-8 corruption of gzip shows as 1f fd (FFFD) — unrecoverable; label binary
      return body;
    }
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString();

    let bytes = null;
    try {
      bytes = await bodyToBytes(body);
    } catch (_) {
      bytes = null;
    }

    if (bytes) {
      const head =
        bytes.length >= 4
          ? Array.from(bytes.slice(0, 4))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("")
          : "";
      const gunzipped = await gunzipToText(bytes);
      if (gunzipped) {
        // Stash note for logging via weak map? Return string; caller uses tryParse
        return gunzipped;
      }
      let bad = 0;
      const n = Math.min(bytes.length, 256);
      for (let i = 0; i < n; i++) if (bytes[i] === 0 || bytes[i] > 127) bad++;
      if (n && bad / n > 0.15) {
        // Preserve bytes as latin1 for gzip-or-binary detection (keep 0x8b intact)
        return bytesToLatin1(bytes);
      }
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }

    // Last resort — may corrupt binary; prefer arrayBuffer paths above
    try {
      const ab = await new Response(body).arrayBuffer();
      return bodyToString(ab);
    } catch (_) {
      try {
        return await new Response(body).text();
      } catch (_) {
        return null;
      }
    }
  }

  async function extractFetchBody(input, init) {
    // Prefer raw bytes — NEVER .text() first (UTF-8 turns gzip 0x8b into U+FFFD)
    if (init && init.body != null) return bodyToString(init.body);
    if (typeof input !== "string" && input && typeof input.clone === "function") {
      try {
        const ab = await input.clone().arrayBuffer();
        return bodyToString(ab);
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function summarizeResponseForLog(json) {
    const texts = collectAssistantTexts(json);
    const joined = texts.join("\n");
    const pipe = parsePipeMomentsOnly(joined, "ask-network");
    const all = pipe.length ? pipe : parseMomentsFromText(joined, 35, "net");
    return {
      textPreview: joined.slice(0, 400),
      momentCount: all.length,
      pipeCount: pipe.length,
      momentStarts: all.slice(0, 8).map((m) => m.start),
      moments: all,
    };
  }

  function notifyNetWait(moments, meta) {
    const wait = domSession.netWait;
    if (!wait || !moments?.length) return;
    wait.onUpdate(moments, meta);
  }

  /** Lightweight: pull pipe-format lines from JSON without deep structure walk when possible. */
  function extractPipeTextQuick(json, maxChars = 12000) {
    const parts = [];
    let size = 0;
    const walk = (o, d) => {
      if (!o || size >= maxChars || d > 18) return;
      if (typeof o === "string") {
        if (o.includes("|") && /\d{1,2}:\d{2}/.test(o)) {
          parts.push(o);
          size += o.length;
        } else if (/\d{1,2}:\d{2}/.test(o) && o.length > 40 && o.length < 4000) {
          parts.push(o);
          size += o.length;
        }
        return;
      }
      if (Array.isArray(o)) {
        for (const x of o) walk(x, d + 1);
        return;
      }
      if (typeof o === "object") {
        for (const k of Object.keys(o)) {
          if (k === "loggingContext" || k === "trackingParams" || k === "frameworkUpdates") continue;
          walk(o[k], d + 1);
          if (size >= maxChars) return;
        }
      }
    };
    walk(json, 0);
    return parts.join("\n").slice(0, maxChars);
  }

  function maybeCapture(url, method, headers, bodyStr, responseJson) {
    if (sessionResolved) return;
    const urlStr = String(url || "");
    const isGetPanel = /\/youtubei\/v1\/get_panel/i.test(urlStr);
    const isNext = /\/youtubei\/v1\/next/i.test(urlStr);
    if (!isGetPanel && !isNext) return;
    // After prompt we only care about get_panel for moments; skip next entirely for moment source
    if (!captureArmed && !isGetPanel) return;
    if (!captureArmed && isGetPanel && !domSession.prompted) {
      // still try to learn template shape lightly
    }

    const parsedBody = tryParseRequestBody(bodyStr);
    lastBodySample = parsedBody.sample || "";
    const sanitizedBody = parsedBody.ok ? sanitizeBodyForTemplate(bodyStr) : null;
    const keys = parsedBody.ok
      ? bodyKeySummary(sanitizedBody || parsedBody.obj || "{}")
      : ["(unparsed:" + (bodyStr ? bodyStr.length : 0) + ":" + (parsedBody.note || "?") + ")"];

    const endpoint = (urlStr.match(/\/youtubei\/v1\/([^?\/]+)/) || [])[1] || "unknown";

    // Cheap moment extract — get_panel only after prompt
    let summary = { textPreview: "", momentCount: 0, pipeCount: 0, momentStarts: [], moments: [] };
    if (isGetPanel && responseJson && (domSession.prompted || captureArmed)) {
      const quick = extractPipeTextQuick(responseJson);
      const pipe = parsePipeMomentsOnly(quick, "ask-network");
      summary = {
        textPreview: quick.slice(0, 400),
        momentCount: pipe.length,
        pipeCount: pipe.length,
        momentStarts: pipe.slice(0, 8).map((m) => m.start),
        moments: pipe,
      };
    }

    const entry = {
      url: urlStr.split("?")[0],
      endpoint,
      method: method || "POST",
      headers: sanitizeHeaders(headers),
      bodyKeys: keys,
      body: sanitizedBody,
      bodyLen: bodyStr ? bodyStr.length : 0,
      bodyNote: parsedBody.note,
      bodySample: parsedBody.ok ? undefined : lastBodySample,
      responseSummary: {
        textPreview: summary.textPreview,
        momentCount: summary.momentCount,
        pipeCount: summary.pipeCount,
        momentStarts: summary.momentStarts,
      },
      capturedAt: Date.now(),
    };
    capturedCalls.push(entry);
    if (capturedCalls.length > 8) capturedCalls.shift();

    // Throttled log: only when pipe count changes or first capture / template shape
    const prevPipe = domSession._lastPipeCount || 0;
    if (summary.pipeCount !== prevPipe || (!parsedBody.ok && isGetPanel) || (sanitizedBody && !askCache.hasTemplateShape)) {
      domSession._lastPipeCount = summary.pipeCount;
      emit("api-capture", {
        endpoint: entry.endpoint,
        bodyKeys: entry.bodyKeys,
        bodyLen: entry.bodyLen,
        bodyNote: entry.bodyNote,
        bodySample: entry.bodySample ? String(entry.bodySample).slice(0, 200) : undefined,
        responseMoments: summary.momentCount,
        pipeMoments: summary.pipeCount,
        responsePreview: summary.textPreview?.slice(0, 160),
        afterPrompt: !!domSession.prompted,
      });
    }

    if (isGetPanel && sanitizedBody?.continuation && typeof sanitizedBody.continuation === "string") {
      const vid = getVideoId();
      if (vid) {
        askCache.lastContinuation = { videoId: vid, continuation: sanitizedBody.continuation, at: Date.now() };
      }
    }

    if (
      isGetPanel &&
      sanitizedBody &&
      !isApiReplaying() &&
      isPersistableAskTemplate(sanitizedBody, summary.pipeCount, !!domSession.prompted)
    ) {
      const hasComposer = !!sanitizedBody.formData?.inputComposerFormData;
      const hasCont = !!sanitizedBody.continuation;
      const hasUser = !!sanitizedBody.formData?.inputComposerFormData?.userInputText;
      askCache.hasTemplateShape = true;
      // Prefer a template that already produced moments; never downgrade
      const score = (summary.pipeCount >= 1 ? 2 : 0) + (hasUser ? 1 : 0);
      const prevScore = lastTemplateCandidate?._score || 0;
      if (!lastTemplateCandidate || score >= prevScore) {
        lastTemplateCandidate = {
          endpoint: "get_panel",
          urlPath: entry.url,
          method: entry.method,
          headers: {
            ...(entry.headers || {}),
            "Content-Type": "application/json",
          },
          body: sanitizedBody,
          bodyKeys: bodyKeySummary(sanitizedBody),
          savedAt: Date.now(),
          _score: score,
        };
        emit("api-template-candidate", {
          endpoint: "get_panel",
          bodyKeys: lastTemplateCandidate.bodyKeys,
          hasContinuation: hasCont,
          hasUserInput: hasUser,
          pipeMoments: summary.pipeCount,
          usable: true,
          score,
        });
        window.postMessage(
          {
            source: CHANNEL,
            direction: "event",
            event: "persist-template",
            detail: { template: lastTemplateCandidate },
          },
          "*"
        );
      }
    } else if (isGetPanel && parsedBody.note === "gzip-or-binary") {
      emit("api-capture-body-skip", {
        note: parsedBody.note,
        sample: String(parsedBody.sample || "").slice(0, 120),
        bodyLen: entry.bodyLen,
        afterPrompt: !!domSession.prompted,
      });
    }

    if (isGetPanel && domSession.prompted && !sessionResolved && summary.pipeCount >= 1) {
      const finalMoments = summary.moments.map((m) => ({ ...m, source: "ask-network" }));
      notifyNetWait(finalMoments, {
        preview: summary.textPreview,
        endpoint: "get_panel",
        bodyKeys: entry.bodyKeys,
      });
    }
  }

  function installNetworkHooks() {
    if (window.__ytTldwNetHooked) return;
    window.__ytTldwNetHooked = true;

    const origFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === "string" ? input : input?.url || "";
      const method = (init.method || (typeof input !== "string" && input?.method) || "GET").toUpperCase();
      let bodyStr = null;
      try {
        bodyStr = await extractFetchBody(input, init);
      } catch (_) {
        bodyStr = null;
      }
      let headers = init.headers;
      if (!headers && typeof input !== "string") headers = input?.headers;

      const res = await origFetch(...args);
      try {
        if (!sessionResolved && /\/youtubei\/v1\//.test(url)) {
          // Only clone get_panel (moments) or next before prompt; skip after settle
          const isPanel = /get_panel/.test(url);
          const isNext = /\/next/.test(url);
          if (isPanel || (isNext && !domSession.prompted)) {
            const clone = res.clone();
            clone
              .json()
              .then((json) => {
                if (sessionResolved) return;
                if (!domSession.prompted) {
                  ingestJsonForAsk(json, isPanel ? "fetch-get_panel" : "fetch-next");
                } else if (isPanel) {
                  // After prompt: skip full ask-cache walk; moments only via maybeCapture
                }
                maybeCapture(url, method, headers, bodyStr, json);
              })
              .catch(() => {});
          }
        }
      } catch (_) {}
      return res;
    };

    const OrigXHR = window.XMLHttpRequest;
    function HookedXHR() {
      const xhr = new OrigXHR();
      let _url = "";
      let _method = "GET";
      let _body = null;
      const open = xhr.open;
      xhr.open = function (m, u, ...rest) {
        _method = m;
        _url = u;
        return open.call(xhr, m, u, ...rest);
      };
      const send = xhr.send;
      xhr.send = function (body) {
        // sync attempt; async stringification happens in load via stored promise
        const bodyPromise = bodyToString(body);
        bodyPromise.then((s) => {
          _body = s;
        });
        xhr.addEventListener("load", async () => {
          try {
            if (sessionResolved) return;
            if (/\/youtubei\/v1\//.test(_url)) {
              const isPanel = /get_panel/.test(_url);
              if (!isPanel && !( /\/next/.test(_url) && !domSession.prompted)) return;
              if (!_body) {
                try {
                  _body = await bodyPromise;
                } catch (_) {}
              }
              let json = null;
              try {
                json = JSON.parse(xhr.responseText);
              } catch (_) {}
              if (json) {
                if (!domSession.prompted) ingestJsonForAsk(json, "xhr");
                maybeCapture(_url, _method, {}, _body, json);
              }
            }
          } catch (_) {}
        });
        return send.call(xhr, body);
      };
      return xhr;
    }
    HookedXHR.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = HookedXHR;
    emit("net-hook", { ok: true });
  }

  function rendererData(el) {
    try {
      return el?.data || el?.__data?.data || null;
    } catch (_) {
      return null;
    }
  }

  function opensAskPanel(command) {
    return command?.showEngagementPanelEndpoint?.panelIdentifier === "PAyouchat";
  }

  function askCommandFromElement(el) {
    for (let cur = el, depth = 0; cur && depth < 8; cur = cur.parentElement, depth++) {
      const data = rendererData(cur);
      if (opensAskPanel(data?.onTap?.innertubeCommand)) return data.onTap.innertubeCommand;
      if (opensAskPanel(data?.serviceEndpoint)) return data.serviceEndpoint;
      if (opensAskPanel(data?.buttonViewModel?.onTap?.innertubeCommand)) {
        return data.buttonViewModel.onTap.innertubeCommand;
      }
    }
    return null;
  }

  function isRendered(el) {
    try {
      return !!el?.getClientRects?.().length && getComputedStyle(el).visibility !== "hidden";
    } catch (_) {
      return false;
    }
  }

  function findAskButton() {
    const candidates = [];
    const push = (el, via, rank) => {
      if (!el || candidates.some((c) => c.el === el)) return;
      const label = (el.getAttribute?.("aria-label") || el.textContent || "").trim().slice(0, 80);
      candidates.push({ el, via, label, rank, visible: isRendered(el) });
    };

    for (const b of deepQueryAll("button-view-model.you-chat-entrypoint-button button")) {
      push(b, "youchat-entrypoint", askCommandFromElement(b) ? 0 : 1);
    }
    for (const b of deepQueryAll("ytd-watch-metadata #flexible-item-buttons button, ytd-watch-metadata #top-level-buttons-computed button, ytm-slim-video-metadata-section-renderer button")) {
      if (askCommandFromElement(b)) push(b, "panel-command", 0);
    }

    push(deepQuery('button[aria-label="Ask"]'), 'aria-label="Ask"', 2);
    for (const b of deepQueryAll("button")) {
      const t = (b.getAttribute("aria-label") || "").trim();
      if (t === "Ask") push(b, "aria-exact", 2);
    }
    candidates.sort((a, b) => Number(b.visible) - Number(a.visible) || a.rank - b.rank);
    return candidates;
  }

  function askReadySnapshot(includeLabels = false) {
    const btns = findAskButton();
    const snap = {
      hasYtcfg: !!getYtcfgValue("INNERTUBE_CONTEXT"),
      askButtonCount: btns.length,
      askLabel: btns[0]?.label || null,
      commands: askCache.commands.length,
      chips: askCache.chips.length,
      panels: askCache.panelIds.size,
      conts: askCache.continuations.length,
      lastSource: askCache.lastSource,
      hasTemplateShape: askCache.hasTemplateShape,
    };
    if (includeLabels) {
      snap.askButtons = btns.slice(0, 3).map((b) => ({ via: b.via, label: b.label }));
    }
    return snap;
  }

  function isAskReady() {
    const currentVideoId = getVideoId();
    const renderedVideoId = document.querySelector("ytd-watch-flexy")?.getAttribute("video-id");
    if (currentVideoId && renderedVideoId && currentVideoId !== renderedVideoId) return false;
    return findAskButton().length > 0;
  }

  async function waitAskReady(timeoutMs = 15000) {
    const t0 = performance.now();
    installNetworkHooks();
    const data = getYtInitialData();
    if (data) ingestJsonForAsk(data, "ytInitialData");
    let loggedStart = false;

    return await new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearInterval(poll);
        const snap = askReadySnapshot(true);
        emit("ask-wait-done", { ok, waitedMs: Math.round(performance.now() - t0), ...snap });
        resolve({ ok, waitedMs: Math.round(performance.now() - t0), ...snap });
      };
      const check = () => {
        if (!loggedStart) {
          loggedStart = true;
          emit("ask-wait-start", { timeoutMs });
        }
        if (isAskReady()) finish(true);
        else if (performance.now() - t0 >= timeoutMs) finish(false);
      };
      let obsTimer = null;
      const obs = new MutationObserver(() => {
        if (done) return;
        if (obsTimer) return;
        obsTimer = setTimeout(() => {
          obsTimer = null;
          if (isAskReady()) finish(true);
        }, 250);
      });
      obs.observe(document.documentElement, { childList: true, subtree: false });
      const poll = setInterval(check, 400);
      check();
    });
  }

  async function decodeResponseToText(res) {
    try {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        const gunzipped = await gunzipToText(buf);
        if (gunzipped != null) return gunzipped;
      }
      try {
        return new TextDecoder("utf-8").decode(buf);
      } catch (_) {
        return bytesToLatin1(buf);
      }
    } catch (_) {
      try {
        return await res.text();
      } catch (_) {
        return "";
      }
    }
  }

  function readCookieValue(name) {
    try {
      const row = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`));
      return row ? decodeURIComponent(row.slice(name.length + 1)) : "";
    } catch (_) {
      return "";
    }
  }

  async function authenticatedInnertubeHeaders() {
    const sapisid = readCookieValue("SAPISID") || readCookieValue("__Secure-3PAPISID");
    if (!sapisid) return {};

    const origin = location.origin; // m.youtube.com must sign for its own origin, not www
    const timestamp = Math.floor(Date.now() / 1000);
    const input = `${timestamp} ${sapisid} ${origin}`;
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
    const hash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const headers = {
      Authorization: `SAPISIDHASH ${timestamp}_${hash}`,
      "X-Origin": origin,
      "X-Goog-AuthUser": String(getYtcfgValue("SESSION_INDEX") || 0),
      "X-Youtube-Bootstrap-Logged-In": "true",
    };
    const delegatedSessionId = getYtcfgValue("DELEGATED_SESSION_ID");
    if (delegatedSessionId) headers["X-Goog-PageId"] = delegatedSessionId;
    return headers;
  }

  async function innertubeFetch(endpoint, body, extraHeaders = {}) {
    const apiKey = getYtcfgValue("INNERTUBE_API_KEY");
    const url =
      `/youtubei/v1/${endpoint}?prettyPrint=false` + (apiKey ? `&key=${encodeURIComponent(apiKey)}` : "");
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-YouTube-Client-Name": String(getYtcfgValue("INNERTUBE_CONTEXT_CLIENT_NAME") || "1"),
      "X-YouTube-Client-Version": String(
        getYtcfgValue("INNERTUBE_CLIENT_VERSION") || getInnertubeContext().client?.clientVersion || ""
      ),
      ...(await authenticatedInnertubeHeaders()),
      ...extraHeaders,
    };
    try {
      const visitor =
        getYtcfgValue("VISITOR_DATA") || getYtcfgValue("INNERTUBE_CONTEXT")?.client?.visitorData;
      if (visitor && !headers["X-Goog-Visitor-Id"] && !headers["x-goog-visitor-id"]) {
        headers["X-Goog-Visitor-Id"] = visitor;
      }
    } catch (_) {}
    const res = await fetch(url, {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify(body),
    });
    const text = await decodeResponseToText(res);
    let json = null;
    let parseNote = "empty";
    let trimmed = (text || "").replace(/^\uFEFF/, "");
    if (trimmed.startsWith(")]}'")) {
      trimmed = trimmed.replace(/^\)\]\}'\n?/, "").trim();
    } else {
      trimmed = trimmed.trim();
    }
    if (trimmed) {
      try {
        json = JSON.parse(trimmed);
        parseNote = "json";
      } catch (_) {
        parseNote = looksMostlyBinary(trimmed) ? "binary" : "parse-fail";
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      json,
      text: (text || "").slice(0, 400),
      fullText: text || "",
      textLen: (text || "").length,
      parseNote,
    };
  }


  async function primeAskContinuation(timeoutMs = 2200) {
    const videoId = getVideoId();
    if (!videoId) return null;
    if (askCache.lastContinuation?.videoId === videoId && askCache.lastContinuation.continuation) {
      return askCache.lastContinuation.continuation;
    }
    try {
      ensureAskPanelHiddenStyle();
      const found = findAskButton()[0];
      const btn = found?.el;
      if (btn) {
        try {
          btn.click();
          emit("dom-click-ask", { label: found.label || "Ask", purpose: "prime-continuation" });
        } catch (_) {}
      }
    } catch (_) {}
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (askCache.lastContinuation?.videoId === videoId && askCache.lastContinuation.continuation) {
        return askCache.lastContinuation.continuation;
      }
      await sleep(80);
    }
    return askCache.lastContinuation?.videoId === videoId ? askCache.lastContinuation.continuation : null;
  }

  async function askViaTemplate(template) {
    const t0 = performance.now();
    const videoId = getVideoId();
    if (!videoId) throw new Error("no videoId");
    if (!template?.body) throw new Error("no template body");
    if (!isUsableAskTemplateBody(template.body)) {
      emit("api-replay-reject", { reason: "unusable-template", bodyKeys: bodyKeySummary(template.body) });
      throw new Error("unusable template body (clearing)");
    }
    if (!template.body.formData?.inputComposerFormData) {
      emit("api-replay-reject", { reason: "no-composer" });
      throw new Error("unusable template body (clearing)");
    }

    const body = JSON.parse(JSON.stringify(template.body));
    // Keep template clickTracking/request; only refresh client from ytcfg (full replace → empty youchat)
    const freshCtx = getInnertubeContext();
    if (body.context && typeof body.context === "object") {
      body.context.client = { ...(body.context.client || {}), ...(freshCtx.client || {}) };
      if (!body.context.user && freshCtx.user) body.context.user = freshCtx.user;
      if (!body.context.request && freshCtx.request) body.context.request = freshCtx.request;
    } else {
      body.context = freshCtx;
    }
    body.formData.inputComposerFormData.clientMessageId = `youchat-${Date.now()}`;
    body.formData.inputComposerFormData.userInputText = ACTIVE_PROMPT;
    body.formData.inputComposerFormData.playerOffsetMs = String(
      Math.floor((document.querySelector("video")?.currentTime || 0) * 1000)
    );
    const swapVid = (o, d = 0) => {
      if (!o || d > 12) return;
      if (Array.isArray(o)) return o.forEach((x) => swapVid(x, d + 1));
      if (typeof o !== "object") return;
      for (const k of Object.keys(o)) {
        if ((k === "videoId" || k === "externalVideoId") && typeof o[k] === "string" && o[k].length >= 6) {
          o[k] = videoId;
        } else swapVid(o[k], d + 1);
      }
    };
    swapVid(body);

    // get_panel requires a video-session continuation; stale ones fail, missing → HTTP 400
    let fresh = null;
    if (askCache.lastContinuation?.videoId === videoId && askCache.lastContinuation.continuation) {
      fresh = askCache.lastContinuation.continuation;
    }
    if (!fresh) {
      fresh = await primeAskContinuation(2200);
    }
    if (fresh) body.continuation = fresh;
    else delete body.continuation;

    const endpoint = template.endpoint || "get_panel";
    emit("api-replay", {
      endpoint,
      bodyKeys: bodyKeySummary(body),
      videoId,
      hasContinuation: !!body.continuation,
      primed: !!fresh,
    });
    if (!body.continuation) {
      emit("api-replay-reject", { reason: "no-fresh-continuation" });
      throw new Error("template replay needs fresh continuation");
    }
    function momentsFromRes(r) {
      const texts = collectAssistantTexts(r.json);
      const joined = texts.join("\n");
      let moments = parsePipeMomentsOnly(joined, "api-template");
      if (!moments.length) {
        moments = parseMomentsFromText(joined, 35, "api").map((m) => ({ ...m, source: "api-template" }));
      }
      return { moments, joined };
    }

    // 0.1.13: do NOT mark prompted — that made askViaDom reuse the API-primed
    // session and never type/send the real prompt. Sticky _apiReplayUntil covers
    // async fetch-hook clone.json() that races past the synchronous flag clear.
    domSession._apiReplaying = true;
    domSession._apiReplayUntil = Date.now() + 2500;
    let res;
    try {
      res = await innertubeFetch(endpoint, body, template.headers || {});
      let parsed = momentsFromRes(res);
      // Empty responseContext-only ack: try following a continuation once if present
      if (res.ok && !parsed.moments.length && res.json) {
        const tokens = findContinuationTokens(res.json).filter((c) => c !== body.continuation);
        emit("api-replay-empty", {
          textLen: res.textLen,
          keys: res.json && typeof res.json === "object" ? Object.keys(res.json).slice(0, 12) : [],
          contTokens: tokens.length,
          fullText: String(res.fullText || res.text || "").slice(0, 2000),
        });
        if (tokens.length) {
          const pollBody = {
            context: body.context,
            continuation: tokens[0],
          };
          const poll = await innertubeFetch(endpoint, pollBody, template.headers || {});
          const pollParsed = momentsFromRes(poll);
          emit("api-replay-poll", {
            status: poll.status,
            textLen: poll.textLen,
            momentCount: pollParsed.moments.length,
            preview: pollParsed.joined.slice(0, 200),
            fullText: pollParsed.moments.length
              ? undefined
              : String(poll.fullText || poll.text || "").slice(0, 1500),
          });
          if (pollParsed.moments.length) {
            parsed = pollParsed;
            res = poll;
          }
        }
      }
      if (!res.ok || !parsed.moments.length) {
        await sleep(400);
        if (askCache.lastContinuation?.videoId === videoId) askCache.lastContinuation = null;
        const again = await primeAskContinuation(1800);
        if (again) body.continuation = again;
        body.formData.inputComposerFormData.clientMessageId = `youchat-${Date.now()}`;
        body.formData.inputComposerFormData.playerOffsetMs = String(
          Math.floor((document.querySelector("video")?.currentTime || 0) * 1000)
        );
        res = await innertubeFetch(endpoint, body, template.headers || {});
        parsed = momentsFromRes(res);
        if (res.ok && !parsed.moments.length && res.json) {
          const tokens2 = findContinuationTokens(res.json).filter((c) => c !== body.continuation);
          if (tokens2.length) {
            const poll2 = await innertubeFetch(
              endpoint,
              { context: body.context, continuation: tokens2[0] },
              template.headers || {}
            );
            const pp2 = momentsFromRes(poll2);
            emit("api-replay-poll", {
              status: poll2.status,
              textLen: poll2.textLen,
              momentCount: pp2.moments.length,
              attempt: 2,
            });
            if (pp2.moments.length) {
              parsed = pp2;
              res = poll2;
            }
          }
        }
      }
      if (!res.ok) throw new Error(`template replay HTTP ${res.status}`);
      const emptyFull = parsed.moments.length
        ? undefined
        : String(res.fullText || res.text || "").slice(0, 2000);
      emit("api-replay-result", {
        momentCount: parsed.moments.length,
        preview: parsed.joined.slice(0, 240),
        status: res.status,
        textLen: res.textLen,
        parseNote: res.parseNote,
        bodyLen: JSON.stringify(body).length,
        fullText: emptyFull,
        responseKeys:
          res.json && typeof res.json === "object" ? Object.keys(res.json).slice(0, 12) : [],
      });
      return {
        ok: parsed.moments.length > 0,
        method: "api-template",
        moments: parsed.moments,
        rawTextPreview: parsed.joined.slice(0, 500) || emptyFull || res.text,
        latencyMs: Math.round(performance.now() - t0),
        error: parsed.moments.length
          ? undefined
          : `template replay returned no timestamps (HTTP ${res.status}, ${res.parseNote}, len=${res.textLen})`,
      };
    } finally {
      domSession._apiReplaying = false;
      // Keep sticky window so async maybeCapture from clone.json cannot persist our replay
      domSession._apiReplayUntil = Date.now() + 2500;
    }
  }

  async function askViaApi(_template, prompt = null) {
    setActivePrompt(prompt);
    const t0 = performance.now();
    const videoId = getVideoId();
    if (!videoId) throw new Error("Ask API: no videoId");

    sessionResolved = false;
    captureArmed = true;
    domSession._apiReplaying = true;
    domSession._apiReplayUntil = Date.now() + 2500;

    try {
      const command = await resolveFreeTextCommand();
      const context = getInnertubeContext();
      context.clickTracking = { clickTrackingParams: command.clickTrackingParams };
      const body = {
        context,
        continuation: command.continuation,
        formData: {
          inputComposerFormData: {
            clientMessageId: `youchat-${Date.now()}`,
            playerOffsetMs: String(Math.max(0, Math.floor((document.querySelector("video")?.currentTime || 0) * 1000))),
            userInputText: ACTIVE_PROMPT,
          },
        },
      };

      emit("api-command-submit", {
        videoId,
        source: askCache.lastSource,
        commandCount: askCache.commands.length,
        bodyKeys: bodyKeySummary(body),
      });

      const res = await innertubeFetch("get_panel", body);
      const texts = collectAssistantTexts(res.json);
      const joined = texts.join("\n");
      let moments = parsePipeMomentsOnly(joined, "api-command");
      if (!moments.length) {
        moments = parseMomentsFromText(joined, 35, "api-command");
      }
      if (!res.ok) throw new Error(`Ask API HTTP ${res.status}`);

      emit("api-command-result", {
        ok: moments.length > 0,
        status: res.status,
        textLen: res.textLen,
        momentCount: moments.length,
        responseKeys:
          res.json && typeof res.json === "object" ? Object.keys(res.json).slice(0, 12) : [],
      });
      sessionResolved = true;
      return {
        ok: moments.length > 0,
        method: "api-command",
        moments,
        rawTextPreview: joined.slice(0, 500),
        latencyMs: Math.round(performance.now() - t0),
        error: moments.length ? undefined : "Ask API returned no timestamp moments",
      };
    } finally {
      captureArmed = false;
      domSession._apiReplaying = false;
      domSession._apiReplayUntil = Date.now() + 2500;
      closeAskPanel();
    }
  }

  function ensureAskPanelHiddenStyle() {
    if (document.getElementById("yt-tldw-hide-ask")) return;
    const style = document.createElement("style");
    style.id = "yt-tldw-hide-ask";
    style.textContent = `
      ytd-engagement-panel-section-list-renderer[target-id="PAyouchat"],
      ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-youchat"] {
        opacity: 0.02 !important;
        position: fixed !important;
        left: -12000px !important;
        top: 0 !important;
        width: 520px !important;
        height: 70vh !important;
        overflow: hidden !important;
        z-index: 1 !important;
        pointer-events: auto !important;
      }
      /* m.youtube.com: the Ask sheet is <ytm-engagement-panel> > ytm-engagement-panel-section-list-renderer.PAyouchat
         (no target-id attribute). Keep it rendered (so innerText/IO work) but off-screen and inert. */
      ytm-engagement-panel:has(> ytm-engagement-panel-section-list-renderer.PAyouchat) {
        opacity: 0.02 !important;
        transform: translateX(-12000px) !important;
        pointer-events: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function removeAskPanelHiddenStyle() {
    document.getElementById("yt-tldw-hide-ask")?.remove();
  }

  function getAskPanel() {
    return (
      deepQuery('ytd-engagement-panel-section-list-renderer[target-id="PAyouchat"]') ||
      deepQuery('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-youchat"]') ||
      deepQuery('[target-id="PAyouchat"], [target-id="engagement-panel-youchat"]') ||
      // m.youtube.com: identified by class, not target-id
      deepQuery("ytm-engagement-panel-section-list-renderer.PAyouchat")
    );
  }

  function ingestAskDataFromDom(source = "dom-renderer-data") {
    const roots = [document.querySelector("ytd-watch-metadata, ytm-slim-video-metadata-section-renderer"), getAskPanel()].filter(Boolean);
    const found = { panels: [], commands: [], chips: [], texts: [] };
    let inspected = 0;
    for (const root of roots) {
      const elements = [root, ...(root.querySelectorAll?.("*") || [])];
      for (const el of elements) {
        if (inspected++ > 800) break;
        const data = rendererData(el);
        if (data) findYouChatStructures(data, found);
      }
    }
    mergeAskFindings(found, source);
  }

  function currentFreeTextCommand() {
    const commands = askCache.commands;
    if (!commands.length) return null;
    const first = commands[0];
    const agrees = commands.every(
      (command) =>
        command.continuation === first.continuation &&
        command.clickTrackingParams === first.clickTrackingParams
    );
    if (!agrees) throw new Error("Ask API: ambiguous free-text commands");
    return first;
  }

  async function resolveFreeTextCommand() {
    installNetworkHooks();
    const initial = getYtInitialData();
    if (initial) ingestJsonForAsk(initial, "ytInitialData-api");
    ingestAskDataFromDom();
    let command = currentFreeTextCommand();
    if (command) return command;

    ensureAskPanelHiddenStyle();
    const found = findAskButton()[0];
    if (found?.el) {
      found.el.click();
      emit("dom-click-ask", {
        label: found.label || "Ask",
        via: found.via,
        purpose: "resolve-free-text-command",
      });
    }

    await waitFor(() => getAskPanel(), 10000).catch(() => null);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      ingestAskDataFromDom("materialized-panel");
      command = currentFreeTextCommand();
      if (command) return command;
      await sleep(100);
    }
    throw new Error("Ask API: no validated sendUserQueryCommand");
  }

  function closeAskPanel() {
    try {
      const panel = getAskPanel();
      const close =
        (panel && deepQuery('button[aria-label*="Close" i]', panel)) ||
        deepQuery('button[aria-label*="Close" i]', getAskPanel() || document);
      close?.click();
    } catch (_) {}
    document.activeElement?.blur?.();
    removeAskPanelHiddenStyle();
  }

  function listMessageElements(panel) {
    if (!panel) return [];
    const sels = ["you-chat-item-view-model", "[class*='you-chat' i]", "#contents > *"];
    const found = [];
    for (const s of sels) {
      panel.querySelectorAll?.(s)?.forEach((el) => found.push(el));
    }
    return [...new Set(found)].filter((el) => (el.innerText || "").trim().length > 0);
  }

  function fingerprintEl(el) {
    const t = (el.innerText || "").trim().slice(0, 120);
    return `${el.tagName}:${t.length}:${t.slice(0, 40)}`;
  }

  function findSpinner(panel) {
    return (
      panel?.querySelector?.(
        "[aria-busy='true'], tp-yt-paper-spinner, .yt-spec-touch-feedback-shape--busy, [class*='spinner' i]"
      ) || null
    );
  }

  function preservePlayback() {
    const v = document.querySelector("video");
    if (!v) return () => {};
    const wasPaused = v.paused;
    return () => {
      try {
        if (!wasPaused && v.paused) v.play()?.catch?.(() => {});
      } catch (_) {}
    };
  }

  function createNetWait({ stableMs = 800, maxMs = 22000 } = {}) {
    let best = null;
    let bestMeta = null;
    let timer = null;
    let settled = false;
    let resolveFn;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      sessionResolved = true;
      captureArmed = false;
      if (timer) clearTimeout(timer);
      emit("net-wait-done", { reason, count: best?.length || 0 });
      resolveFn({ moments: best || [], meta: bestMeta, reason });
    };

    return {
      promise,
      onUpdate(moments, meta) {
        if (settled || sessionResolved || !moments?.length) return;
        const improved = !best || moments.length > best.length;
        if (!best) {
          best = moments;
          bestMeta = meta;
          emit("net-moments", {
            count: moments.length,
            stableMs,
            titles: moments.slice(0, 5).map((m) => m.title),
          });
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => finish("stable"), stableMs);
          return;
        }
        if (improved) {
          best = moments;
          bestMeta = meta;
          emit("net-moments", {
            count: moments.length,
            stableMs,
            titles: moments.slice(0, 5).map((m) => m.title),
          });
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => finish("stable"), stableMs);
        }
        // Equal count: do NOT reset timer / re-emit (prevents stream thrash freeze)
      },
      forceTimeout() {
        finish("timeout");
      },
      cancel() {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolveFn({ moments: best || [], meta: bestMeta, reason: "cancel" });
      },
    };
  }

  async function waitForNewAssistantMessage(panel, { stableMs = 1200, maxMs = 12000, abortSignal } = {}) {
    const t0 = performance.now();
    let lastText = "";
    let lastChange = performance.now();
    let target = null;

    while (performance.now() - t0 < maxMs) {
      if (abortSignal?.aborted || sessionResolved) return { el: null, text: "", aborted: true };
      const msgs = listMessageElements(panel);
      for (let i = msgs.length - 1; i >= 0; i--) {
        const el = msgs[i];
        const fp = fingerprintEl(el);
        const text = (el.innerText || "").trim();
        const hasTs = /\d{1,2}:\d{2}/.test(text) || /[?&]t=\d+/.test(el.innerHTML || "");
        const isPromptEcho =
          text.includes("DURATION_SECONDS") || text.includes("List the essential / most important");
        if (isPromptEcho && !hasTs) continue;
        if (hasTs || (text.length > 120 && !domSession.baselineFingerprints.has(fp))) {
          target = el;
          break;
        }
      }
      if (target) {
        const cur = (target.innerText || "").trim();
        if (cur !== lastText) {
          lastText = cur;
          lastChange = performance.now();
        }
        const spinner = findSpinner(panel);
        const hasTs = /\d{1,2}:\d{2}/.test(cur);
        if (!spinner && hasTs && performance.now() - lastChange >= stableMs) {
          return { el: target, text: cur };
        }
      }
      await sleep(200);
    }
    return target ? { el: target, text: (target.innerText || "").trim() } : { el: null, text: "" };
  }

  let lastResetAt = 0;
  function resetDomSession(hard = true) {
    const now = Date.now();
    // Dedupe burst resets (content + bridge)
    if (now - lastResetAt < 400) {
      if (hard) {
        domSession.prompted = false;
        domSession.promptSentAt = 0;
      }
      return;
    }
    lastResetAt = now;
    closeAskPanel();
    if (domSession.netWait) {
      try {
        domSession.netWait.cancel();
      } catch (_) {}
    }
    domSession.netWait = null;
    if (hard) {
      domSession.prompted = false;
      domSession.promptSentAt = 0;
      domSession.baselineFingerprints = new Set();
      sessionResolved = false;
      captureArmed = false;
    }
    emit("dom-session-reset", { videoId: getVideoId(), hard });
  }

  async function askViaDom({ forceFresh = false, prompt = null } = {}) {
    setActivePrompt(prompt);
    const t0 = performance.now();
    const videoId = getVideoId();
    const HARD_MS = 28000;
    ensureAskPanelHiddenStyle();
    captureArmed = true;
    const restorePlayback = preservePlayback();

    sessionResolved = false;
    domSession._lastPipeCount = 0;

    // Only reset when there is a real incomplete prompted session (promptSentAt > 0)
    const promptedAge = domSession.promptSentAt > 0 ? Date.now() - domSession.promptSentAt : null;
    const stalePrompt =
      domSession.videoId === videoId &&
      domSession.prompted &&
      promptedAge != null &&
      promptedAge > 5000 &&
      !domSession.netWait;
    if (domSession.videoId && domSession.videoId !== videoId) {
      resetDomSession(true);
    } else if (stalePrompt) {
      emit("dom-stale-reset", { ageMs: promptedAge, forceFresh: !!forceFresh });
      resetDomSession(true);
    } else if (forceFresh && (domSession.prompted || domSession.promptSentAt > 0)) {
      emit("dom-stale-reset", { ageMs: promptedAge, forceFresh: true });
      resetDomSession(true);
    }
    // forceFresh with no prior prompt: no-op
    domSession.videoId = videoId;

    const netWait = createNetWait({ stableMs: 800, maxMs: HARD_MS });
    domSession.netWait = netWait;

    const hardTimer = setTimeout(() => {
      try {
        netWait.forceTimeout();
      } catch (_) {}
    }, HARD_MS);

    try {
      const ready = await waitAskReady(15000);
      if (!ready.ok && !findAskButton().length) {
        throw new Error(`Ask button not found after ${ready.waitedMs}ms`);
      }

      let panel = getAskPanel();
      if (!domSession.prompted) {
        const candidates = findAskButton();
        const askBtn = candidates[0]?.el;
        if (!askBtn && !panel) throw new Error("Ask button missing");
        if (askBtn) {
          emit("dom-click-ask", { label: candidates[0].label });
          askBtn.click();
          await sleep(200);
          askBtn.blur?.();
          document.activeElement?.blur?.();
        }
        panel = await waitFor(() => getAskPanel(), 12000);
        listMessageElements(panel).forEach((el) => domSession.baselineFingerprints.add(fingerprintEl(el)));

        const textarea = await waitFor(
          () => deepQuery("textarea", panel) || panel.querySelector("textarea"),
          8000
        );
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(textarea, ACTIVE_PROMPT);
        textarea.value = ACTIVE_PROMPT;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(300);
        const send =
          deepQuery('button[aria-label="Send"]', panel) ||
          deepQuery('button[aria-label*="Send" i]', panel) ||
          Array.from(panel.querySelectorAll("button")).find((b) =>
            /send/i.test(b.getAttribute("aria-label") || "")
          );
        if (send && send.getAttribute("aria-disabled") !== "true" && !send.disabled) send.click();
        else {
          textarea.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
          );
        }
        document.activeElement?.blur?.();
        // Real DOM prompt — clear sticky API-replay window so capture can persist
        domSession._apiReplaying = false;
        domSession._apiReplayUntil = 0;
        domSession.prompted = true;
        domSession.promptSentAt = Date.now();
        emit("dom-prompt-sent", { used: "dom-freetext" });
      } else {
        // Reuse only if we still expect network answer soon; otherwise already reset above
        emit("dom-reuse-session", { ageMs: Date.now() - domSession.promptSentAt });
        panel = panel || getAskPanel();
      }

      // Race: network moments (preferred) vs DOM text vs hard timeout (via netWait)
      const domAbort = { aborted: false };
      const domPromise = (async () => {
        try {
          panel = panel || (await waitFor(() => getAskPanel(), 5000).catch(() => null));
          if (!panel) return { moments: [], text: "", via: "dom-miss" };
          const { el, text, aborted } = await waitForNewAssistantMessage(panel, {
            stableMs: 1200,
            maxMs: HARD_MS - 2000,
            abortSignal: domAbort,
          });
          if (aborted) return { moments: [], text: "", via: "dom-aborted" };
          const moments = parseMomentsFromMessageEl(el || panel);
          return { moments, text, via: "dom-text" };
        } catch (e) {
          return { moments: [], text: "", via: "dom-error", error: String(e.message || e) };
        }
      })();

      const netPromise = netWait.promise.then((r) => ({
        moments: r.moments || [],
        text: r.meta?.preview || "",
        via: "ask-network",
        reason: r.reason,
      }));

      const first = await Promise.race([
        netPromise.then((r) => ({ ...r, won: "net" })),
        domPromise.then((r) => ({ ...r, won: "dom" })),
      ]);

      let result = first;
      // If DOM won with nothing, keep waiting on net until hard timeout
      if (first.won === "dom" && (!first.moments || !first.moments.length)) {
        result = await netPromise;
        result.won = "net";
      } else if (first.won === "net" && first.moments?.length) {
        domAbort.aborted = true;
      } else if (first.won === "net" && (!first.moments || !first.moments.length)) {
        // net timed out empty — take DOM if it has something
        const domRes = await domPromise;
        if (domRes.moments?.length) result = { ...domRes, won: "dom" };
      }

      const moments = (result.moments || []).map((m) =>
        result.won === "net" || result.via === "ask-network" ? { ...m, source: "ask-network" } : m
      );

      emit("dom-answer", {
        len: (result.text || "").length,
        moments: moments.length,
        via: result.via || result.won,
        reason: result.reason,
        preview: (result.text || "").slice(0, 400),
        titles: moments.slice(0, 6).map((m) => m.title || "(untitled)"),
      });

      sessionResolved = true;
      captureArmed = false;
      closeAskPanel();
      restorePlayback();
      domSession.prompted = false;
      domSession.netWait = null;

      return {
        ok: moments.length > 0,
        method: moments.length && (result.via === "ask-network" || result.won === "net") ? "ask-network" : "dom-freetext",
        moments,
        rawTextPreview: (result.text || "").slice(0, 500),
        latencyMs: Math.round(performance.now() - t0),
        readyWaitMs: ready.waitedMs,
        capturedCalls: capturedCalls.length,
        hasTemplate: !!lastTemplateCandidate,
        error: moments.length ? undefined : "Ask: no pipe moments in get_panel or DOM before timeout",
      };
    } catch (e) {
      closeAskPanel();
      domSession.prompted = false;
      domSession.netWait = null;
      return {
        ok: false,
        method: "dom",
        moments: [],
        error: String(e.message || e),
        latencyMs: Math.round(performance.now() - t0),
      };
    } finally {
      clearTimeout(hardTimer);
      captureArmed = false;
      try {
        netWait.cancel();
      } catch (_) {}
      if (domSession.netWait === netWait) domSession.netWait = null;
      setTimeout(removeAskPanelHiddenStyle, 400);
      restorePlayback();
    }
  }

  /** Normalize heatMarkers / markersList rows into {start,duration,score}. */
  function normalizeHeatSeries(rawMarkers) {
    if (!Array.isArray(rawMarkers) || !rawMarkers.length) return [];
    const out = [];
    for (const h of rawMarkers) {
      const r = h?.heatMarkerRenderer || h?.marker || h;
      if (!r || typeof r !== "object") continue;
      const startMs =
        r.timeRangeStartMillis ??
        r.startMillis ??
        (Number.isFinite(r.start) ? r.start * 1000 : null);
      const durMs =
        r.markerDurationMillis ??
        r.durationMillis ??
        (Number.isFinite(r.duration) ? r.duration * 1000 : 8000);
      const score =
        r.heatMarkerIntensityScoreNormalized ??
        r.intensityScoreNormalized ??
        r.score ??
        0;
      if (startMs == null || !Number.isFinite(Number(score))) continue;
      out.push({
        start: Number(startMs) / 1000,
        duration: Math.max(0.5, Number(durMs) / 1000),
        score: Number(score),
      });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  function findHeatseekerMarkers(root) {
    let heatMarkers = null;
    let source = null;
    const walk = (o, d = 0) => {
      if (!o || heatMarkers || d > 32) return;
      if (Array.isArray(o)) {
        for (const item of o) {
          if (item?.key === "HEATSEEKER") {
            heatMarkers =
              item?.value?.heatmap?.heatmapRenderer?.heatMarkers ||
              item?.value?.heatMarkers ||
              null;
            if (heatMarkers?.length) source = "heatseeker";
            return;
          }
        }
        o.forEach((x) => walk(x, d + 1));
        return;
      }
      if (typeof o !== "object") return;
      if (Array.isArray(o.heatMarkers) && o.heatMarkers.length) {
        heatMarkers = o.heatMarkers;
        source = "heatseeker";
        return;
      }
      // yt-dlp / frameworkUpdates path
      if (o.macroMarkersListEntity?.markersList?.markers) {
        const list = o.macroMarkersListEntity.markersList;
        if (String(list?.markerType || "").includes("HEAT") || list?.markers?.[0]?.intensityScoreNormalized != null) {
          heatMarkers = list.markers;
          source = "framework";
          return;
        }
      }
      if (Array.isArray(o.markers) && o.markers[0]?.intensityScoreNormalized != null) {
        heatMarkers = o.markers;
        source = "framework";
        return;
      }
      for (const k of Object.keys(o)) walk(o[k], d + 1);
    };
    walk(root);
    return { heatMarkers, source };
  }

  /**
   * Parse player SVG most-replayed curve (`path.ytp-modern-heat-map`).
   * viewBox is typically 0 0 1000 100; intensity ≈ (100 - y) / 100.
   */
  function parseModernHeatMapPath(d, durationSec) {
    if (!d || !Number.isFinite(durationSec) || durationSec <= 0) return [];
    const pts = [];
    const parts = String(d).replace(/([MC])/g, "|$1").split("|").filter(Boolean);
    for (const part of parts) {
      const cmd = part[0];
      const nums = part
        .slice(1)
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter((n) => Number.isFinite(n));
      if (cmd === "M" && nums.length >= 2) pts.push({ x: nums[0], y: nums[1] });
      if (cmd === "C") {
        for (let i = 0; i + 5 < nums.length; i += 6) {
          pts.push({ x: nums[i + 4], y: nums[i + 5] });
        }
      }
    }
    if (pts.length < 3) return [];
    const series = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const next = pts[i + 1];
      const start = Math.max(0, Math.min(durationSec, (p.x / 1000) * durationSec));
      const end = next
        ? Math.max(start + 0.25, Math.min(durationSec, (next.x / 1000) * durationSec))
        : Math.min(durationSec, start + durationSec / Math.max(pts.length, 1));
      series.push({
        start,
        duration: Math.max(0.25, end - start),
        score: Math.max(0, Math.min(1, (100 - p.y) / 100)),
      });
    }
    return series;
  }

  function readSvgHeatSeries() {
    const path =
      document.querySelector("path.ytp-modern-heat-map[d]") ||
      deepQuery("path.ytp-modern-heat-map");
    const d = path?.getAttribute?.("d") || "";
    if (!d || d.length < 20) return null;
    const video = document.querySelector("video");
    const duration = video?.duration;
    if (!Number.isFinite(duration) || duration <= 0) return null;
    const series = parseModernHeatMapPath(d, duration);
    return series.length ? series : null;
  }

  async function waitSvgHeatSeries(waitMs = 4500) {
    const existing = readSvgHeatSeries();
    if (existing?.length) return existing;
    const t0 = performance.now();
    while (performance.now() - t0 < waitMs) {
      await sleep(200);
      const s = readSvgHeatSeries();
      if (s?.length) return s;
    }
    return null;
  }

  function isLocalHeatMinimum(sorted, j) {
    if (j < 0 || j >= sorted.length) return false;
    const s = sorted[j].score || 0;
    const left = j === 0 ? Infinity : sorted[j - 1].score || 0;
    const right = j === sorted.length - 1 ? Infinity : sorted[j + 1].score || 0;
    return s <= left && s <= right;
  }

  function isLocalHeatMaximum(sorted, j) {
    if (j < 0 || j >= sorted.length) return false;
    const s = sorted[j].score || 0;
    const left = j === 0 ? -Infinity : sorted[j - 1].score || 0;
    const right = j === sorted.length - 1 ? -Infinity : sorted[j + 1].score || 0;
    // Strict on the right so flat plateaus keep a single peak tip.
    return s >= left && s > right;
  }

  /** Discrete |κ| proxy from score second-difference (optionally time-normalized). */
  function heatCurvatureAt(sorted, j) {
    if (j <= 0 || j >= sorted.length - 1) return 0;
    const y0 = sorted[j - 1].score || 0;
    const y1 = sorted[j].score || 0;
    const y2 = sorted[j + 1].score || 0;
    const t0 = sorted[j - 1].start;
    const t1 = sorted[j].start;
    const t2 = sorted[j + 1].start + Math.max(sorted[j + 1].duration, 0.25);
    const dt01 = Math.max(0.25, t1 - t0);
    const dt12 = Math.max(0.25, t2 - t1);
    const s01 = (y1 - y0) / dt01;
    const s12 = (y2 - y1) / dt12;
    return Math.abs(s12 - s01);
  }

  /** Index of max curvature in (fromExcl, toExcl); null if empty. */
  function maxCurvatureIndex(sorted, fromExcl, toExcl) {
    let best = -1;
    let bestK = -1;
    const a = Math.min(fromExcl, toExcl);
    const b = Math.max(fromExcl, toExcl);
    for (let j = a + 1; j < b; j++) {
      const k = heatCurvatureAt(sorted, j);
      if (k > bestK) {
        bestK = k;
        best = j;
      }
    }
    return best >= 0 ? best : null;
  }

  /**
   * Local-maxima peaks. Each side has an inner max-curvature edge and an outer
   * local-minimum. valleyBlend (0–1) lerps from curvature toward the valley.
   * Intensity also controls which peaks qualify (threshold / maxPeaks).
   */
  function clusterHeatPeaks(
    series,
    {
      maxPeaks = 5,
      defaultDuration = 28,
      scoreThreshold = 0.35,
      durationSec = 0,
      valleyBlend = 0,
    } = {}
  ) {
    if (!series?.length) return [];
    const sorted = series.slice().sort((a, b) => a.start - b.start);
    const maxScore = Math.max(...sorted.map((s) => s.score || 0), 0);
    const floor = Math.max(scoreThreshold, maxScore * 0.45);
    const minLen = Math.max(2, Math.min(8, Number(defaultDuration) || 28) * 0.25);
    const blend = Math.max(0, Math.min(1, Number(valleyBlend) || 0));
    const candidates = [];
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      if ((cur.score || 0) < floor) continue;
      if (!isLocalHeatMaximum(sorted, i)) {
        if (sorted.length > 8) continue;
        if (cur.score < maxScore * 0.92) continue;
      }
      let lo = 0;
      for (let j = i - 1; j >= 0; j--) {
        if (isLocalHeatMinimum(sorted, j)) {
          lo = j;
          break;
        }
      }
      let hi = sorted.length - 1;
      for (let j = i + 1; j < sorted.length; j++) {
        if (isLocalHeatMinimum(sorted, j)) {
          hi = j;
          break;
        }
      }
      const leftEdge = maxCurvatureIndex(sorted, lo, i);
      const rightEdge = maxCurvatureIndex(sorted, i, hi);
      const tip = cur.start + Math.max(cur.duration, 0.25) / 2;
      const leftInner =
        leftEdge != null ? sorted[leftEdge].start : (sorted[lo].start + tip) / 2;
      const leftOuter = sorted[lo].start;
      const rightInner =
        rightEdge != null
          ? sorted[rightEdge].start + sorted[rightEdge].duration
          : (tip + sorted[hi].start + sorted[hi].duration) / 2;
      const rightOuter = sorted[hi].start + sorted[hi].duration;
      let start = leftInner + (leftOuter - leftInner) * blend;
      let end = rightInner + (rightOuter - rightInner) * blend;
      if (end - start < minLen) {
        start = tip - minLen / 2;
        end = tip + minLen / 2;
      }
      if (Number.isFinite(durationSec) && durationSec > 0) {
        const len = Math.min(end - start, durationSec);
        if (start < 0) {
          start = 0;
          end = Math.min(durationSec, start + len);
        }
        if (end > durationSec) {
          end = durationSec;
          start = Math.max(0, end - len);
        }
        start = Math.max(0, Math.min(start, Math.max(0, durationSec - 1)));
        end = Math.max(start + 1, Math.min(end, durationSec));
      } else {
        start = Math.max(0, start);
        end = Math.max(start + 1, end);
      }
      candidates.push({
        start,
        end,
        score: cur.score,
        title: `Most replayed (${cur.score.toFixed(2)})`,
        source: "heatmap",
      });
    }
    // Deduplicate overlapping peaks (keep higher score)
    candidates.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const c of candidates) {
      if (picked.length >= maxPeaks) break;
      if (picked.some((p) => !(c.end <= p.start + 1 || c.start >= p.end - 1))) continue;
      picked.push(c);
    }
    return picked.sort((a, b) => a.start - b.start);
  }

  async function extractHeatmapMoments({
    maxPeaks = 5,
    defaultDuration = 28,
    durationScale = 1.25,
    scoreThreshold = 0.35,
    valleyBlend = 0,
    waitMs = 4500,
  } = {}) {
    const t0 = performance.now();
    const opts = { maxPeaks, defaultDuration, durationScale, scoreThreshold, valleyBlend };
    const data = getYtInitialData();

    let series = [];
    let heatmapSource = null;

    if (data) {
      const found = findHeatseekerMarkers(data);
      series = normalizeHeatSeries(found.heatMarkers);
      if (series.length) {
        heatmapSource = found.source || "heatseeker";
        // m.youtube.com ships heatMarkers whose max is far below 1 (e.g. 0.09–0.21), unlike the
        // desktop/SVG graph which is drawn full-height. Rescale so the tallest bar is 1.0;
        // otherwise every peak is under the absolute scoreThreshold and Popular finds nothing.
        const top = Math.max(...series.map((s) => s.score));
        if (top > 0 && top < 0.999) for (const s of series) s.score /= top;
      }
    }

    if (!series.length) {
      const svgSeries = await waitSvgHeatSeries(waitMs);
      if (svgSeries?.length) {
        series = svgSeries;
        heatmapSource = "svg";
      }
    }

    if (!series.length) {
      return {
        ok: false,
        method: "heatmap",
        moments: [],
        error: "no most-replayed graph (HEATSEEKER/SVG)",
        heatmapSource: null,
        latencyMs: Math.round(performance.now() - t0),
      };
    }

    const video = document.querySelector("video");
    const durationSec =
      video?.duration && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const last = series[series.length - 1];
    const seriesEnd = last ? last.start + last.duration : 0;
    const moments = dedupeMoments(
      clusterHeatPeaks(series, {
        ...opts,
        durationSec: durationSec || seriesEnd || 0,
      })
    );
    return {
      ok: moments.length > 0,
      method: "heatmap",
      moments,
      heatmapSource,
      sampleCount: series.length,
      latencyMs: Math.round(performance.now() - t0),
      error: moments.length ? undefined : "no peaks above threshold",
    };
  }

  function extractChapterMoments(defaultDuration = 40) {
    const t0 = performance.now();
    const data = getYtInitialData();
    if (!data) return { ok: false, method: "chapters", moments: [], error: "no ytInitialData", latencyMs: 0 };
    const chapters = [];
    const walk = (o, d = 0) => {
      if (!o || d > 32) return;
      if (Array.isArray(o)) return o.forEach((x) => walk(x, d + 1));
      if (typeof o !== "object") return;
      if (o.chapterRenderer) {
        const c = o.chapterRenderer;
        chapters.push({
          start: (c.timeRangeStartMillis || 0) / 1000,
          title: c.title?.simpleText || c.title?.runs?.[0]?.text || "Chapter",
        });
      }
      if (o.macroMarkersListItemRenderer) {
        const c = o.macroMarkersListItemRenderer;
        const start =
          c.onTap?.watchEndpoint?.startTimeSeconds ?? parseTimestampToSeconds(c.timeDescription?.simpleText) ?? null;
        const title = c.title?.simpleText || c.title?.runs?.[0]?.text || "Chapter";
        if (start != null) chapters.push({ start: Number(start), title });
      }
      for (const k of Object.keys(o)) walk(o[k], d + 1);
    };
    walk(data);
    chapters.sort((a, b) => a.start - b.start);
    const uniq = [];
    for (const c of chapters) {
      if (uniq.length && Math.abs(uniq[uniq.length - 1].start - c.start) < 1) continue;
      uniq.push(c);
    }
    const moments = uniq.map((c, i) => {
      const next = uniq[i + 1];
      const end = next ? next.start : c.start + defaultDuration;
      return {
        start: c.start,
        end: Math.max(c.start + 8, Math.min(end, c.start + 90)),
        title: c.title,
        source: "chapter",
      };
    });
    return { ok: moments.length > 0, method: "chapters", moments, latencyMs: Math.round(performance.now() - t0) };
  }

  let askVideoId = getVideoId();

  function resetAskCacheForNavigation() {
    askVideoId = getVideoId();
    askCache.commands = [];
    askCache.chips = [];
    askCache.panelIds = new Set();
    askCache.continuations = [];
    askCache.lastContinuation = null;
    askCache.lastSource = "";
    resetDomSession(true);
    domSession.videoId = null;
    const data = getYtInitialData();
    if (data) ingestJsonForAsk(data, "ytInitialData");
    emit("nav-reset", { videoId: getVideoId() });
  }

  document.addEventListener("yt-navigate-finish", () => {
    resetAskCacheForNavigation();
    window.postMessage({ source: CHANNEL, direction: "event", event: "ready" }, "*");
  });

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL || data.direction !== "request") return;
    const { id, action } = data;
    try {
      if (getVideoId() !== askVideoId) resetAskCacheForNavigation();
      if (action === "ping") {
        reply(id, { ok: true, videoId: getVideoId(), snap: askReadySnapshot() });
        return;
      }
      if (action === "waitAskReady") {
        reply(id, await waitAskReady(data.timeoutMs || 15000));
        return;
      }
      if (action === "askApi") {
        try {
          reply(id, await askViaApi(data.template || null, data.prompt || null));
        } catch (e) {
          reply(id, { ok: false, method: "api", moments: [], error: String(e.message || e), latencyMs: 0 });
        }
        return;
      }
      if (action === "askDom") {
        try {
          reply(id, await askViaDom({ forceFresh: !!data.forceFresh, prompt: data.prompt || null }));
        } catch (e) {
          reply(id, { ok: false, method: "dom", moments: [], error: String(e.message || e), latencyMs: 0 });
          closeAskPanel();
        }
        return;
      }
      if (action === "resetDomSession") {
        resetDomSession(true);
        reply(id, { ok: true });
        return;
      }
      if (action === "heatmap") {
        reply(
          id,
          await extractHeatmapMoments({
            maxPeaks: data.maxPeaks,
            defaultDuration: data.defaultDuration,
            durationScale: data.durationScale,
            scoreThreshold: data.scoreThreshold,
            valleyBlend: data.valleyBlend,
            waitMs: data.waitMs,
          })
        );
        return;
      }
      if (action === "chapters") {
        reply(id, extractChapterMoments());
        return;
      }
      if (action === "getCapture") {
        reply(id, { ok: true, calls: capturedCalls.slice(-5), template: lastTemplateCandidate });
        return;
      }
      reply(id, { ok: false, error: "unknown action" });
    } catch (e) {
      reply(id, { ok: false, error: String(e.message || e) });
    }
  });

  installNetworkHooks();
  const boot = getYtInitialData();
  if (boot) ingestJsonForAsk(boot, "ytInitialData");
  window.postMessage({ source: CHANNEL, direction: "event", event: "ready" }, "*");
})();
