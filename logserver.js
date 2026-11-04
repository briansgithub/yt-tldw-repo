#!/usr/bin/env node
/* YT-TLDW local log sink — dependency-free. Listens on 127.0.0.1:47321 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1";
const PORT = 47321;
const ROOT = path.join("C:", "Users", "user1", "yt-tldw");
const LOG_DIR = path.join(ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "tldw.log");

fs.mkdirSync(LOG_DIR, { recursive: true });

function appendLine(line) {
  fs.appendFileSync(LOG_FILE, line.endsWith("\n") ? line : line + "\n", "utf8");
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, log: LOG_FILE }));
    return;
  }
  if (req.method === "POST" && (req.url === "/log" || req.url?.startsWith("/log"))) {
    const chunks = [];
    req.on("data", (c) => {
      chunks.push(c);
      // Cap single request ~1MB
      if (chunks.reduce((n, x) => n + x.length, 0) > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          appendLine(JSON.stringify({ t: new Date().toISOString(), raw: raw.slice(0, 2000) }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
          return;
        }
        const lines = Array.isArray(payload) ? payload : payload?.lines ? payload.lines : [payload];
        for (const row of lines) {
          const obj = typeof row === "string" ? { msg: row } : row || {};
          if (!obj.t) obj.t = new Date().toISOString();
          appendLine(JSON.stringify(obj));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, n: lines.length }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  appendLine(JSON.stringify({ t: new Date().toISOString(), event: "logserver-start", port: PORT, file: LOG_FILE }));
  console.log(`YT-TLDW logserver on http://${HOST}:${PORT}/log -> ${LOG_FILE}`);
});
