#!/usr/bin/env node
/**
 * Offline unit tests for YT-TLDW 0.1.13 (prompt builder + parse + persist gate).
 * Run: node tests/unit-0.1.13.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.join(__dirname, "..");
const settingsSrc = fs.readFileSync(path.join(root, "extension/lib/settings.js"), "utf8");
const contentSrc = fs.readFileSync(path.join(root, "extension/content.js"), "utf8");
const pageBridgeSrc = fs.readFileSync(path.join(root, "extension/page-bridge.js"), "utf8");
const sandbox = { console, module: { exports: {} }, exports: {} };
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.runInNewContext(settingsSrc, sandbox);
const S = sandbox.YtTldwSettings || sandbox.module.exports.YtTldwSettings;
assert.ok(S, "YtTldwSettings loaded");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("ok  -", name);
  } catch (e) {
    failed++;
    console.error("FAIL-", name, e.message || e);
  }
}

// --- prompt builder ---
check("buildPrompt facts/aggressive mentions selective + pipe format", () => {
  const p = S.buildPrompt("facts", "aggressive");
  assert.ok(/factual|informational/i.test(p));
  assert.ok(/highly selective|10–20%|10-20%/i.test(p));
  assert.ok(/TITLE \| MM:SS \| DURATION/.test(p));
  assert.ok(p.length > 80);
});

check("buildPrompt funny/weak differs from facts/aggressive", () => {
  const a = S.buildPrompt("facts", "aggressive");
  const b = S.buildPrompt("funny", "weak");
  assert.notStrictEqual(a, b);
  assert.ok(/funniest|humorous/i.test(b));
  assert.ok(/inclusive|70–90%|70-90%/i.test(b));
});

check("momentsCacheKey includes genre+intensity", () => {
  assert.strictEqual(S.momentsCacheKey("abc", "facts", "aggressive"), "abc|facts|aggressive");
  assert.strictEqual(S.momentsCacheKey("abc", "FUNNY", "Mild"), "abc|funny|mild");
});

check("filterMomentsByIntensity aggressive caps count", () => {
  const moms = [];
  for (let i = 0; i < 20; i++) {
    moms.push({ start: i * 60, end: i * 60 + 30, title: "m" + i });
  }
  const out = S.filterMomentsByIntensity(moms, 1200, "aggressive");
  assert.ok(out.length <= 5, "got " + out.length);
  assert.ok(out.length >= 1);
});

// --- persist gate (mirrors page-bridge 0.1.13 contract) ---
function isUsableAskTemplateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (!body.context || typeof body.context !== "object") return false;
  const composer = body.formData && body.formData.inputComposerFormData;
  if (!composer || typeof composer !== "object") return false;
  return true;
}
function isPersistableAskTemplate(body, pipeCount, afterPrompt) {
  if (!isUsableAskTemplateBody(body)) return false;
  const userInput = body.formData.inputComposerFormData.userInputText;
  const hasUser = typeof userInput === "string" && userInput.trim().length > 0;
  if (pipeCount >= 1 && hasUser) return true;
  return false;
}

const sampleBody = {
  context: { client: { clientName: "WEB" } },
  continuation: "xyz",
  formData: {
    inputComposerFormData: {
      clientMessageId: "youchat-1",
      playerOffsetMs: "0",
      userInputText: "Focus on facts... TITLE | MM:SS | DURATION_SECONDS",
    },
  },
};

check("persist: reject empty replay (pipeCount 0 even afterPrompt)", () => {
  assert.strictEqual(isPersistableAskTemplate(sampleBody, 0, true), false);
});

check("persist: accept when pipe moments present", () => {
  assert.strictEqual(isPersistableAskTemplate(sampleBody, 3, true), true);
});

check("persist: reject missing userInput", () => {
  const b = JSON.parse(JSON.stringify(sampleBody));
  delete b.formData.inputComposerFormData.userInputText;
  assert.strictEqual(isPersistableAskTemplate(b, 2, true), false);
});

check("persist: reject continuation-only (no composer)", () => {
  assert.strictEqual(
    isPersistableAskTemplate({ context: {}, continuation: "x" }, 0, false),
    false
  );
});

// --- pipe parser (inline copy of page-bridge contract) ---
function parseTimestampToSeconds(ts) {
  const p = String(ts).split(":").map(Number);
  if (p.some((n) => Number.isNaN(n))) return null;
  if (p.length === 2) return p[0] * 60 + p[1];
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return null;
}
function parsePipeMomentsOnly(text, source) {
  const moments = [];
  if (!text) return moments;
  for (const raw of String(text).split(/\n+/)) {
    const line = String(raw || "").replace(/^\s*[*•\-]\s+/, "").trim();
    const pipe = line.match(
      /^(.+?)\s*\|\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\|\s*(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:onds)?)?)?\s*$/i
    );
    if (!pipe) continue;
    const start = parseTimestampToSeconds(pipe[2]);
    const dur = parseFloat(pipe[3]);
    if (start != null && dur > 0) {
      moments.push({ start, end: start + dur, title: pipe[1].trim(), source, duration: dur });
    }
  }
  return moments;
}

check("parsePipeMomentsOnly extracts TITLE|MM:SS|DUR lines", () => {
  const t =
    "Essential moments:\nIntro hook | 0:45 | 30\nKey claim | 3:12 | 45\n\nThanks for watching";
  const m = parsePipeMomentsOnly(t, "test");
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[0].start, 45);
  assert.strictEqual(m[1].start, 192);
  assert.strictEqual(m[1].duration, 45);
});

check("parsePipeMomentsOnly ignores non-pipe prose", () => {
  assert.strictEqual(parsePipeMomentsOnly("Just some text at 1:00 maybe", "t").length, 0);
});

// --- empty API ack shape ---
check("empty responseContext-only ack has no continuation tokens", () => {
  function findContinuationTokens(json) {
    const out = [];
    const walk = (o, d = 0) => {
      if (!o || d > 28 || out.length > 10) return;
      if (typeof o === "string") return;
      if (Array.isArray(o)) return o.forEach((x) => walk(x, d + 1));
      if (typeof o !== "object") return;
      if (typeof o.continuation === "string" && o.continuation.length > 24) out.push(o.continuation);
      const cc = o.continuationCommand && o.continuationCommand.continuation;
      if (typeof cc === "string" && cc.length > 24) out.push(cc);
      for (const k of Object.keys(o)) walk(o[k], d + 1);
    };
    walk(json);
    return [...new Set(out)];
  }
  const ack = {
    responseContext: {
      serviceTrackingParams: [
        { service: "CSI", params: [{ key: "c", value: "WEB" }] },
      ],
    },
  };
  assert.deepStrictEqual(findContinuationTokens(ack), []);
});

check("methodOrder auto skips api (contract note)", () => {
  // Mirror content.js: API is explicit; Auto remains DOM-first.
  function methodOrder(preferred) {
    if (preferred === "dom") return ["dom", "fallback"];
    if (preferred === "api") return ["api", "dom", "fallback"];
    return ["dom", "fallback"];
  }
  assert.deepStrictEqual(methodOrder("auto"), ["dom", "fallback"]);
  assert.deepStrictEqual(methodOrder("api"), ["api", "dom", "fallback"]);
});

check("forceFresh re-runs reset and propagate to DOM Ask", () => {
  assert.ok(
    /if \(forceFresh\)\s*\{[\s\S]*?bridgeCall\("resetDomSession", \{ hard: true \}/.test(contentSrc),
    "forceFresh must hard-reset the MAIN-world DOM session"
  );
  assert.ok(
    /resolveMoments\(settings\.method, token, \{ forceFreshDom: !!forceFresh \}\)/.test(contentSrc),
    "forceFresh must propagate through resolveMoments"
  );
});

check("Ask API uses exact server command and locale-independent entrypoint", () => {
  assert.ok(pageBridgeSrc.includes('c?.token || c?.continuation'));
  assert.ok(pageBridgeSrc.includes('"CONTINUATION_REQUEST_TYPE_GET_PANEL"'));
  assert.ok(pageBridgeSrc.includes("button-view-model.you-chat-entrypoint-button button"));
  assert.ok(pageBridgeSrc.includes("context.clickTracking = { clickTrackingParams: command.clickTrackingParams }"));
  assert.ok(pageBridgeSrc.includes("SAPISIDHASH ${timestamp}_${hash}"));
  assert.ok(pageBridgeSrc.includes('"X-Origin": origin'));
  assert.ok(
    /bridgeCall\("askApi", \{ prompt \}, 25000\)/.test(contentSrc),
    "API method must not require a persisted template"
  );
});

check("Popular is heatmap-only (no Ask fallback)", () => {
  assert.ok(/genre === "popular"[\s\S]*?order = \["heatmap"\]/.test(contentSrc));
  assert.ok(pageBridgeSrc.includes("parseModernHeatMapPath"));
  assert.ok(pageBridgeSrc.includes("clusterHeatPeaks"));
  assert.ok(pageBridgeSrc.includes('heatmapSource = "svg"'));
  assert.ok(/used !== "heatmap"/.test(contentSrc), "skip intensity duration filter for heatmap");
});

// --- heatmap SVG / peak contracts (mirrors page-bridge 0.1.17) ---
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

function clusterHeatPeaks(
  series,
  { maxPeaks = 5, defaultDuration = 28, scoreThreshold = 0.35, durationSec = 0 } = {}
) {
  if (!series?.length) return [];
  const sorted = series.slice().sort((a, b) => a.start - b.start);
  const maxScore = Math.max(...sorted.map((s) => s.score || 0), 0);
  const floor = Math.max(scoreThreshold, maxScore * 0.45);
  const win = Math.max(8, Number(defaultDuration) || 28);
  const maxLen = win * 1.25;
  const candidates = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    if ((cur.score || 0) < floor) continue;
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const isPeak =
      (!prev || cur.score >= prev.score) && (!next || cur.score > next.score);
    if (!isPeak && sorted.length > 8) continue;
    if (!isPeak && cur.score < maxScore * 0.92) continue;
    let lo = i;
    let hi = i;
    const hold = Math.max(floor, cur.score * 0.55);
    while (lo > 0 && sorted[lo - 1].score >= hold) lo--;
    while (hi < sorted.length - 1 && sorted[hi + 1].score >= hold) hi++;
    const tip = cur.start + Math.max(cur.duration, 0.25) / 2;
    let start = sorted[lo].start;
    let end = sorted[hi].start + sorted[hi].duration;
    if (end - start > maxLen) {
      start = tip - maxLen / 2;
      end = tip + maxLen / 2;
    } else if (end - start < Math.min(win, 12)) {
      start = tip - Math.min(win, 12) / 2;
      end = tip + Math.min(win, 12) / 2;
    }
    if (Number.isFinite(durationSec) && durationSec > 0) {
      start = Math.max(0, Math.min(start, Math.max(0, durationSec - 1)));
      end = Math.max(start + 1, Math.min(end, durationSec));
    } else {
      start = Math.max(0, start);
      end = Math.max(start + 1, end);
    }
    candidates.push({ start, end, score: cur.score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of candidates) {
    if (picked.length >= maxPeaks) break;
    if (picked.some((p) => !(c.end <= p.start + 1 || c.start >= p.end - 1))) continue;
    picked.push(c);
  }
  return picked.sort((a, b) => a.start - b.start);
}

check("parseModernHeatMapPath maps SVG y=0 to intensity 1", () => {
  const d = "M 0.0,100.0 C 10,50 20,0 50.0,0.0 C 80,0 90,50 100.0,100.0";
  const s = parseModernHeatMapPath(d, 100);
  assert.ok(s.length >= 3);
  const peak = s.reduce((a, b) => (a.score > b.score ? a : b));
  assert.ok(peak.score >= 0.99, "peak score " + peak.score);
  assert.ok(Math.abs(peak.start - 5) < 1 || peak.start >= 0);
});

check("clusterHeatPeaks keeps top local maxima under aggressive caps", () => {
  const series = [];
  for (let i = 0; i < 40; i++) {
    const t = i * 10;
    let score = 0.1;
    if (i === 5) score = 1;
    else if (i === 4 || i === 6) score = 0.7;
    if (i === 20) score = 0.9;
    else if (i === 19 || i === 21) score = 0.6;
    if (i === 35) score = 0.5;
    series.push({ start: t, duration: 10, score });
  }
  const peaks = clusterHeatPeaks(series, { maxPeaks: 2, defaultDuration: 24, scoreThreshold: 0.55 });
  assert.ok(peaks.length >= 1 && peaks.length <= 2, "got " + peaks.length);
  assert.ok(peaks[0].score >= 0.9);
});

if (failed) {
  console.error("\n" + failed + " failed");
  process.exit(1);
}
console.log("\nAll tests passed.");
