"use strict";

const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { once } = require("node:events");
const test = require("node:test");
const model = require("../extension/lib/queue-model");
const { createQueueSync, syncOrigin } = require("../extension/lib/queue-sync");
const { createQueueServer } = require("../sync/server");

const ids = ["ircyBWpLL34", "M6nefnNpOZA", "abcdefghijk"];
const origin = "https://pc.example.ts.net";
const key = randomBytes(32).toString("base64url");

test("watch URLs and sync origins are restricted", () => {
  assert.equal(model.videoIdFromUrl("https://m.youtube.com/watch?v=" + ids[0]), ids[0]);
  assert.equal(model.videoIdFromUrl("https://www.youtube.com/shorts/" + ids[0]), null);
  assert.equal(model.videoIdFromUrl("https://www.youtube.com.example.org/watch?v=" + ids[0]), null);
  assert.equal(syncOrigin(origin + "/"), origin);
  for (const url of ["http://pc.example.ts.net", origin + "/v1", origin + ":8443",
    origin + "?foo", "https://user@pc.example.ts.net", origin + ".example.org"]) {
    assert.equal(syncOrigin(url), null);
  }
});

test("two clients converge after concurrent edits, a lost acknowledgement and restarts", async () => {
  const folder = await mkdtemp(join(tmpdir(), "yt-tldw-queue-"));
  const database = join(folder, "queue.sqlite");
  let server;
  let endpoint;
  async function start() {
    server = createQueueServer({ database, key }).listen(0, "127.0.0.1");
    await once(server, "listening");
    endpoint = `http://127.0.0.1:${server.address().port}/v1/queue`;
  }
  async function stop() {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server = null;
  }
  function device() {
    let state = { base: { revision: 0, entries: [] }, pending: [], config: null };
    const connection = { offline: false, loseAck: false };
    function open() {
      return createQueueSync({
        model,
        load: async () => structuredClone(state),
        save: async (value) => { state = structuredClone(value); },
        notify: async () => {},
        uuid: randomUUID,
        async fetchQueue(config, operation) {
          if (connection.offline) throw new Error("Offline");
          const response = await fetch(endpoint, {
            method: operation ? "POST" : "GET",
            headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
            body: operation ? JSON.stringify(operation) : undefined,
          });
          if (!response.ok) throw new Error(String(response.status));
          const snapshot = await response.json();
          if (operation && connection.loseAck) {
            connection.loseAck = false;
            throw new Error("Lost acknowledgement");
          }
          return snapshot;
        },
      });
    }
    return { open, connection, state: () => state };
  }
  const add = (videoId, title) => ({ type: "add", videoId, title });
  const videoIds = (view) => view.entries.map((entry) => entry.videoId);
  try {
    await start();
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "add", videoId: "../../", title: "invalid", opId: randomUUID() }),
    })).status, 400);
    const desktop = device();
    const pixel = device();
    let pc = desktop.open();
    const phone = pixel.open();
    await pc.mutate(add(ids[0], "Saved locally"));
    await pc.connect(origin, key);
    await pc.refresh();
    await phone.connect(origin, key);
    assert.deepEqual(videoIds(await phone.view()), [ids[0]]);
    await pc.mutate(add(ids[1], "From PC"));
    await phone.mutate(add(ids[0], "Duplicate title"));
    await phone.mutate(add(ids[2], "From Pixel"));
    await Promise.all([pc.refresh(), phone.refresh()]);
    const desktopView = await pc.refresh();
    assert.deepEqual(await phone.refresh().then(videoIds), videoIds(desktopView));
    assert.equal(desktopView.entries.length, 3);
    assert.equal(desktopView.entries[0].title, "Saved locally");

    desktop.connection.offline = true;
    await pc.mutate({ type: "move", videoId: ids[2], beforeId: ids[0] });
    assert.equal((await pc.refresh()).pending, 1);
    await phone.mutate({ type: "remove", videoId: ids[1] });
    await phone.refresh();
    pc = desktop.open();
    assert.equal((await pc.view()).pending, 1);
    desktop.connection.offline = false;
    desktop.connection.loseAck = true;
    assert.equal((await pc.refresh()).pending, 1);
    const before = pixel.state().base.revision;
    await stop();
    await start();
    assert.equal((await pc.refresh()).pending, 0);
    assert.equal(desktop.state().base.revision, before + 1);
    assert.deepEqual(videoIds(await phone.refresh()), [ids[2], ids[0]]);
    assert.equal((await pc.view()).error, null);
  } finally {
    if (server) await stop();
    await rm(folder, { recursive: true, force: true });
  }
});
