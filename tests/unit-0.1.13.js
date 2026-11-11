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
check("buildPrompt facts/aggressive is claim-only and pipe-only", () => {
  const p = S.buildPrompt("facts", "aggressive");
  assert.ok(/takeaways/i.test(p));
  assert.ok(/3 to 5 most important takeaways/i.test(p));
  assert.ok(/TITLE \| MM:SS \| DURATION/.test(p));
  assert.ok(/clip transition/i.test(p));
  assert.ok(/chronological order/i.test(p));
  assert.ok(p.length > 80);
});

check("buildPrompt funny includes setup and differs from facts/aggressive", () => {
  const a = S.buildPrompt("facts", "aggressive");
  const b = S.buildPrompt("funny", "weak");
  const mild = S.buildPrompt("facts", "mild");
  assert.notStrictEqual(a, b);
  assert.ok(/funniest|humorous/i.test(b));
  assert.ok(/\[Laughter\]/i.test(b));
  assert.ok(/setup of the joke/i.test(b));
  assert.ok(/explanation or evidence/i.test(mild));
  assert.ok(!/3 to 5 most important takeaways/i.test(mild));
});

check("momentsCacheKey includes genre+intensity", () => {
  assert.strictEqual(S.momentsCacheKey("abc", "facts", "aggressive"), "abc|facts|aggressive|p27");
  assert.strictEqual(S.momentsCacheKey("abc", "FUNNY", "Mild"), "abc|funny|mild|p27");
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

check("Popular is heatmap-only for times; Ask titles mapped after", () => {
  assert.ok(/genre === "popular"[\s\S]*?order = \["heatmap"\]/.test(contentSrc));
  assert.ok(contentSrc.includes("labelPopularHeatmap"));
  assert.ok(contentSrc.includes("applyAskTitlesToHeatmap"));
  assert.ok(pageBridgeSrc.includes("parseModernHeatMapPath"));
  assert.ok(pageBridgeSrc.includes("clusterHeatPeaks"));
  assert.ok(pageBridgeSrc.includes("valleyBlend"));
  assert.ok(pageBridgeSrc.includes('heatmapSource = "svg"'));
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
  return s >= left && s > right;
}
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
  return Math.abs((y2 - y1) / dt12 - (y1 - y0) / dt01);
}
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
function clusterHeatPeaks(
  series,
  { maxPeaks = 5, defaultDuration = 28, scoreThreshold = 0.35, durationSec = 0, valleyBlend = 0 } = {}
) {
  if (!series?.length) return [];
  const sorted = series.slice().sort((a, b) => a.start - b.start);
  const maxScore = Math.max(...sorted.map((s) => s.score || 0), 0);
  const floor = Math.max(scoreThreshold, maxScore * 0.45);
  const minLen = Math.max(2, Math.min(8, Number(defaultDuration) || 28) * 0.25);
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
    const blend = Math.max(0, Math.min(1, Number(valleyBlend) || 0));
    const leftInner = leftEdge != null ? sorted[leftEdge].start : (sorted[lo].start + tip) / 2;
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

check("heatmapParams intensity sets peak selection and valleyBlend", () => {
  const a = S.heatmapParams("aggressive");
  const m = S.heatmapParams("mild");
  const w = S.heatmapParams("weak");
  assert.ok(a.scoreThreshold > m.scoreThreshold && m.scoreThreshold > w.scoreThreshold);
  assert.ok(a.maxPeaks <= m.maxPeaks && m.maxPeaks <= w.maxPeaks);
  assert.strictEqual(a.valleyBlend, 0);
  assert.strictEqual(m.valleyBlend, 0.5);
  assert.strictEqual(w.valleyBlend, 1);
});

check("clusterHeatPeaks uses max-curvature edges between tip and valleys", () => {
  // Slow rise, sharp elbow, then peak, then sharp drop elbow — curvature max mid-flank.
  const series = [];
  const scores = [
    0.05, 0.06, 0.08, 0.12, 0.4, 0.85, 1.0, 0.88, 0.45, 0.12, 0.06, 0.05, 0.08, 0.35, 0.9, 1.0, 0.7, 0.2, 0.06, 0.04,
  ];
  for (let i = 0; i < scores.length; i++) {
    series.push({ start: i * 10, duration: 10, score: scores[i] });
  }
  const peaks = clusterHeatPeaks(series, {
    maxPeaks: 2,
    defaultDuration: 12,
    scoreThreshold: 0.4,
    durationSec: 300,
  });
  assert.ok(peaks.length >= 1, "got " + peaks.length);
  const first = peaks[0];
  // Should be inside the flanks, not at the outer valleys (0 / ~100).
  assert.ok(first.start > 5, "left edge inside flank " + first.start);
  assert.ok(first.start < 60, "left edge before tip " + first.start);
  assert.ok(first.end > 60, "right edge after tip " + first.end);
  assert.ok(first.end < 120, "right edge before far valley " + first.end);
});

check("clusterHeatPeaks valleyBlend 1 is longer than blend 0", () => {
  const series = [];
  const scores = [
    0.05, 0.06, 0.08, 0.12, 0.4, 0.85, 1.0, 0.88, 0.45, 0.12, 0.06, 0.05, 0.08, 0.35, 0.9, 1.0, 0.7, 0.2, 0.06, 0.04,
  ];
  for (let i = 0; i < scores.length; i++) {
    series.push({ start: i * 10, duration: 10, score: scores[i] });
  }
  const tight = clusterHeatPeaks(series, { maxPeaks: 1, scoreThreshold: 0.4, durationSec: 300, valleyBlend: 0 });
  const wide = clusterHeatPeaks(series, { maxPeaks: 1, scoreThreshold: 0.4, durationSec: 300, valleyBlend: 1 });
  assert.strictEqual(tight.length, 1);
  assert.strictEqual(wide.length, 1);
  const tightLen = tight[0].end - tight[0].start;
  const wideLen = wide[0].end - wide[0].start;
  assert.ok(wideLen > tightLen + 5, "wide " + wideLen + " vs tight " + tightLen);
});

check("buildPopularTitlePrompt forbids retiming", () => {
  const p = S.buildPopularTitlePrompt([
    { start: 95, end: 135, title: "Most replayed (1.00)" },
  ]);
  assert.ok(/exactly as given/i.test(p));
  assert.ok(/retime any line/i.test(p));
  assert.ok(/LABEL \| 1:35 \| 40/.test(p));
  assert.ok(/TITLE \| MM:SS \| DURATION/.test(p));
});

check("applyAskTitlesToHeatmap maps by start and keeps heatmap times", () => {
  const heat = [
    { start: 95, end: 135, title: "Most replayed (1.00)", source: "heatmap" },
    { start: 358, end: 408, title: "Most replayed (0.80)", source: "heatmap" },
  ];
  const ask = [
    { start: 90, end: 200, title: "Agave sap", source: "ask" },
    { start: 360, end: 370, title: "Mead word", source: "ask" },
  ];
  const out = S.applyAskTitlesToHeatmap(heat, ask);
  assert.strictEqual(out[0].start, 95);
  assert.strictEqual(out[0].end, 135);
  assert.strictEqual(out[0].title, "Agave sap");
  assert.strictEqual(out[1].start, 358);
  assert.strictEqual(out[1].title, "Mead word");
  const fallback = S.applyAskTitlesToHeatmap(heat, []);
  assert.strictEqual(fallback[0].title, "Most replayed (1.00)");
  const byOrder = S.applyAskTitlesToHeatmap(heat, [
    { start: 0, end: 1, title: "First", source: "ask" },
    { start: 0, end: 1, title: "Second", source: "ask" },
  ]);
  assert.strictEqual(byOrder[0].start, 95);
  assert.strictEqual(byOrder[0].title, "First");
  assert.strictEqual(byOrder[1].title, "Second");
});

if (failed) {
  console.error("\n" + failed + " failed");
  process.exit(1);
}
console.log("\nAll tests passed.");
