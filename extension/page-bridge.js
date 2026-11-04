/* YT-TLDW page-bridge — MAIN world (GPL-3.0) v0.1.12 */

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
    return window.ytInitialData || null;
  }

  function findYouChatStructures(obj, acc = { panels: [], commands: [], chips: [], texts: [] }, depth = 0) {
    if (!obj || depth > 40) return acc;
    if (Array.isArray(obj)) {
      for (const item of obj) findYouChatStructures(item, acc, depth + 1);
      return acc;
    }
    if (typeof obj !== "object") return acc;
    if (obj.targetId === "PAyouchat" || obj.panelIdentifier === "PAyouchat") acc.panels.push(obj);
    if (obj.sendUserQueryCommand) acc.commands.push(obj.sendUserQueryCommand);
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
    if (!c?.continuation) return null;
    return {
      continuation: c.continuation,
      clickTrackingParams:
        command?.innertubeCommand?.clickTrackingParams || command?.clickTrackingParams || undefined,
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
    // Only keep requests that actually asked (or already returned moments)
    if (pipeCount >= 1 && hasUser) return true;
    if (afterPrompt && hasUser) return true;
    return false;
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
      !domSession._apiReplaying &&
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

  function findAskButton() {
    const candidates = [];
    const push = (el, via) => {
      if (!el || candidates.some((c) => c.el === el)) return;
      const label = (el.getAttribute?.("aria-label") || el.textContent || "").trim().slice(0, 80);
      candidates.push({ el, via, label });
    };
    push(deepQuery('button[aria-label="Ask"]'), 'aria-label="Ask"');
    for (const b of deepQueryAll("button")) {
      const t = (b.getAttribute("aria-label") || "").trim();
      if (t === "Ask") push(b, "aria-exact");
    }
    candidates.sort((a, b) => (a.label === "Ask" ? -1 : 0) - (b.label === "Ask" ? -1 : 0));
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

    domSession._apiReplaying = true;
    domSession.prompted = true;
    domSession.promptSentAt = Date.now();
    let res;
    try {
      res = await innertubeFetch(endpoint, body, template.headers || {});
      let parsed = momentsFromRes(res);
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
      }
      if (!res.ok) throw new Error(`template replay HTTP ${res.status}`);
      emit("api-replay-result", {
        momentCount: parsed.moments.length,
        preview: parsed.joined.slice(0, 240),
        status: res.status,
        textLen: res.textLen,
        parseNote: res.parseNote,
        bodyLen: JSON.stringify(body).length,
      });
      return {
        ok: parsed.moments.length > 0,
        method: "api-template",
        moments: parsed.moments,
        rawTextPreview: parsed.joined.slice(0, 500) || res.text,
        latencyMs: Math.round(performance.now() - t0),
        error: parsed.moments.length
          ? undefined
          : `template replay returned no timestamps (HTTP ${res.status}, ${res.parseNote}, len=${res.textLen})`,
      };
    } finally {
      domSession._apiReplaying = false;
    }
  }

  async function askViaApi(template, prompt = null) {
    setActivePrompt(prompt);
    if (template?.body) return askViaTemplate(template);
    throw new Error("Ask API: no captured template yet. Run method=dom once to capture.");
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
      deepQuery('[target-id="PAyouchat"]')
    );
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
    } else if (forceFresh && domSession.prompted && promptedAge != null) {
      emit("dom-stale-reset", { ageMs: promptedAge, forceFresh: true });
      resetDomSession(true);
    }
    // forceFresh with no prior prompt: no-op (avoid ageMs=Date.now() bug + duplicate resets)
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

  function extractHeatmapMoments({
    maxPeaks = 5,
    defaultDuration = 28,
    scoreThreshold = 0.35,
  } = {}) {
    const t0 = performance.now();
    const data = getYtInitialData();
    if (!data) return { ok: false, method: "heatmap", moments: [], error: "no ytInitialData", latencyMs: 0 };
    let heatMarkers = null;
    const walk = (o, d = 0) => {
      if (!o || heatMarkers || d > 30) return;
      if (Array.isArray(o)) {
        for (const item of o) {
          if (item?.key === "HEATSEEKER") {
            heatMarkers = item?.value?.heatmap?.heatmapRenderer?.heatMarkers || item?.value?.heatMarkers || null;
            return;
          }
        }
        o.forEach((x) => walk(x, d + 1));
        return;
      }
      if (typeof o === "object") {
        if (o.heatMarkers && Array.isArray(o.heatMarkers)) {
          heatMarkers = o.heatMarkers;
          return;
        }
        for (const k of Object.keys(o)) walk(o[k], d + 1);
      }
    };
    walk(data);
    if (!heatMarkers?.length) {
      return {
        ok: false,
        method: "heatmap",
        moments: [],
        error: "no HEATSEEKER markers",
        latencyMs: Math.round(performance.now() - t0),
      };
    }
    const scored = heatMarkers
      .map((h) => {
        const r = h.heatMarkerRenderer || h;
        return {
          start: (r.timeRangeStartMillis || 0) / 1000,
          duration: (r.markerDurationMillis || 8000) / 1000,
          score: r.heatMarkerIntensityScoreNormalized || 0,
        };
      })
      .filter((x) => x.score > scoreThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxPeaks);
    const moments = scored
      .map((p) => ({
        start: p.start,
        end: p.start + Math.max(p.duration, defaultDuration),
        title: `Most replayed (${p.score.toFixed(2)})`,
        source: "heatmap",
      }))
      .sort((a, b) => a.start - b.start);
    return {
      ok: moments.length > 0,
      method: "heatmap",
      moments: dedupeMoments(moments),
      latencyMs: Math.round(performance.now() - t0),
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

  function resetAskCacheForNavigation() {
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
          extractHeatmapMoments({
            maxPeaks: data.maxPeaks,
            defaultDuration: data.defaultDuration,
            scoreThreshold: data.scoreThreshold,
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
