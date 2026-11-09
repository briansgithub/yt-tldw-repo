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
check("buildPrompt facts/aggressive asks for fewer sections + pipe format", () => {
  const p = S.buildPrompt("facts", "aggressive");
  assert.ok(/factual|informational/i.test(p));
  assert.ok(/fewer of the strongest sections/i.test(p));
  assert.ok(/TITLE \| MM:SS \| DURATION/.test(p));
  assert.ok(p.length > 80);
});

check("buildPrompt funny/weak differs from facts/aggressive", () => {
  const a = S.buildPrompt("facts", "aggressive");
  const b = S.buildPrompt("funny", "weak");
  assert.notStrictEqual(a, b);
  assert.ok(/funniest|humorous/i.test(b));
  assert.ok(/keep most pertinent sections/i.test(b));
});

check("momentsCacheKey includes genre+intensity", () => {
  assert.strictEqual(S.momentsCacheKey("abc", "facts", "aggressive"), "abc|facts|aggressive|p26");
  assert.strictEqual(S.momentsCacheKey("abc", "FUNNY", "Mild"), "abc|funny|mild|p26");
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
  // Mirror content.js 0.1.13
  function methodOrder(preferred, hasTemplate) {
    if (preferred === "dom") return ["dom", "fallback"];
    if (preferred === "api") return hasTemplate ? ["api", "dom", "fallback"] : ["dom", "fallback"];
    return ["dom", "fallback"];
  }
  assert.deepStrictEqual(methodOrder("auto", true), ["dom", "fallback"]);
  assert.deepStrictEqual(methodOrder("auto", false), ["dom", "fallback"]);
  assert.deepStrictEqual(methodOrder("api", true), ["api", "dom", "fallback"]);
});

if (failed) {
  console.error("\n" + failed + " failed");
  process.exit(1);
}
console.log("\nAll tests passed.");
