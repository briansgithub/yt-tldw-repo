/* Private YT-TLDW sync service (GPL-3.0). Requires Node.js 24 or later. */
"use strict";

const { createServer } = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const Queue = require("../extension/lib/queue-model");

const ROUTE = "/v1/queue";
const MAX_BODY = 8192;

function digest(text) {
  return createHash("sha256").update(text).digest();
}

function createQueueServer({ database, key }) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("Invalid sync key");
  const expected = digest(`Bearer ${key}`);
  const db = new DatabaseSync(database);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS queue_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      entries TEXT NOT NULL
    );
    INSERT OR IGNORE INTO queue_state VALUES (1, 0, '[]');
    CREATE TABLE IF NOT EXISTS applied_operations (id TEXT PRIMARY KEY);
  `);
  const read = db.prepare("SELECT revision, entries FROM queue_state WHERE id = 1");
  const write = db.prepare("UPDATE queue_state SET revision = ?, entries = ? WHERE id = 1");
  const record = db.prepare("INSERT OR IGNORE INTO applied_operations (id) VALUES (?)");

  function snapshot() {
    const row = read.get();
    return { revision: row.revision, entries: JSON.parse(row.entries) };
  }

  function mutate(op) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const state = snapshot();
      if (record.run(op.opId).changes) {
        state.entries = Queue.apply(state.entries, op);
        state.revision += 1;
        write.run(state.revision, JSON.stringify(state.entries));
      }
      db.exec("COMMIT");
      return state;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function reply(res, status, value) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  }

  const server = createServer(async (req, res) => {
    if (req.url !== ROUTE) return reply(res, 404, { error: "Not found" });
    if (!timingSafeEqual(digest(req.headers.authorization || ""), expected)) {
      req.resume();
      return reply(res, 401, { error: "Invalid sync key" });
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return reply(res, 405, { error: "Method not allowed" });
    }
    try {
      if (req.method === "GET") return reply(res, 200, snapshot());
      if (req.headers["content-type"] !== "application/json") {
        return reply(res, 415, { error: "Expected JSON" });
      }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY) {
          res.setHeader("Connection", "close");
          return reply(res, 413, { error: "Request too large" });
        }
        chunks.push(chunk);
      }
      let op;
      try {
        op = Queue.normalizeOperation(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {}
      if (!op) return reply(res, 400, { error: "Invalid queue operation" });
      reply(res, 200, mutate(op));
    } catch {
      if (!res.headersSent) reply(res, 500, { error: "Sync service unavailable" });
    }
  });
  server.requestTimeout = 15000;
  server.once("close", () => db.close());
  return server;
}

if (require.main === module) {
  const root = process.env.YT_TLDW_SYNC_DIR || join(process.env.LOCALAPPDATA || require("node:os").homedir(), "YT-TLDW", "sync");
  const keyPath = join(root, "access.key");
  if (process.argv[2] === "--init" || process.argv[2] === "--rotate-key") {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const flag = process.argv[2] === "--init" ? "wx" : "w";
    writeFileSync(keyPath, randomBytes(32).toString("base64url") + "\n", { flag, mode: 0o600 });
    console.log("Access key written to access.key in the sync data folder.");
  } else {
    const key = readFileSync(keyPath, "utf8").trim();
    const server = createQueueServer({ database: join(root, "queue.sqlite"), key });
    server.listen(47322, "127.0.0.1", () => console.log("YT-TLDW sync listening on 127.0.0.1:47322"));
  }
}

module.exports = { createQueueServer };
