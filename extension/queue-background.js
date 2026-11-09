/* YT-TLDW queue extension messages and storage (GPL-3.0). */
(() => {
  "use strict";

  const api = globalThis.browser || chrome;
  const model = globalThis.YtTldwQueueModel;
  const { createQueueSync } = globalThis.YtTldwQueueSync;
  const extensionOrigin = api.runtime.getURL("");
  const openTabs = new Map();
  let database;

  function db() {
    if (!database) {
      database = new Promise((resolve, reject) => {
        const request = indexedDB.open("yt-tldw-private", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("queue");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch((error) => {
        database = null;
        throw error;
      });
    }
    return database;
  }

  async function load() {
    const store = (await db()).transaction("queue").objectStore("queue");
    return new Promise((resolve, reject) => {
      const request = store.get("state");
      request.onsuccess = () => resolve(request.result || {
        base: { entries: [], revision: 0 }, pending: [], config: null,
      });
      request.onerror = () => reject(request.error);
    });
  }

  async function save(state) {
    const tx = (await db()).transaction("queue", "readwrite");
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
      tx.objectStore("queue").put(state, "state");
    });
  }

  async function fetchQueue(config, op) {
    const origin = `${config.origin}/*`;
    if (!await api.permissions.contains({ origins: [origin] })) {
      throw new Error("Allow access to the sync server in Queue settings");
    }
    if (navigator.userAgent.includes("Firefox/") &&
        !await api.permissions.contains({ data_collection: ["websiteContent", "authenticationInfo"] })) {
      throw new Error("Allow queue sync data in Queue settings");
    }
    let response;
    try {
      response = await fetch(`${config.origin}/v1/queue`, {
        method: op ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${config.key}`,
          ...(op ? { "Content-Type": "application/json" } : {}),
        },
        body: op ? JSON.stringify(op) : undefined,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new Error("Sync server unreachable");
    }
    if (response.status === 401) throw new Error("Sync key rejected. Pair this device again.");
    if (!response.ok) throw new Error(`Sync server returned ${response.status}`);
    return response.json().catch(() => { throw new Error("Invalid response from sync server"); });
  }

  const queue = createQueueSync({
    model, load, save, fetchQueue,
    uuid: () => crypto.randomUUID(),
    notify: () => api.storage.local.set({ queueChanged: crypto.randomUUID() }),
  });

  function tabKey(id) {
    return `queuePlayback:${id}`;
  }

  async function tabSession(id) {
    if (openTabs.has(id)) return openTabs.get(id);
    const key = tabKey(id);
    return (await api.storage.session?.get(key))?.[key] || null;
  }

  async function setTabSession(id, value) {
    if (value) {
      openTabs.set(id, value);
      await api.storage.session?.set({ [tabKey(id)]: value });
    } else {
      openTabs.delete(id);
      await api.storage.session?.remove(tabKey(id));
    }
  }

  function watchId(sender) {
    return sender.frameId === 0 && model.videoIdFromUrl(sender.url);
  }

  async function startVideo(videoId, sender) {
    const youtube = sender.frameId === 0 && /^https:\/\/(www|m)\.youtube\.com\//.test(sender.url || "");
    const tab = youtube ? sender.tab : await api.tabs.create({ url: "about:blank" });
    if (tab?.id == null) throw new Error("Could not open a YouTube tab");
    const mobile = sender.url?.startsWith("https://m.youtube.com/") || navigator.userAgent.includes("Android");
    const url = `https://${mobile ? "m" : "www"}.youtube.com/watch?v=${videoId}`;
    await setTabSession(tab.id, { videoId, token: crypto.randomUUID(), claimed: false });
    try {
      if (tab.url === url) await api.tabs.reload(tab.id);
      else await api.tabs.update(tab.id, { url });
    } catch (error) {
      await setTabSession(tab.id, null);
      throw error;
    }
  }

  api.tabs.onRemoved.addListener((id) => { setTabSession(id, null).catch(() => {}); });
  api.tabs.onUpdated?.addListener((id, change) => {
    if (!change.url) return;
    tabSession(id).then((session) => {
      if (session?.claimed && session.videoId !== model.videoIdFromUrl(change.url)) {
        return setTabSession(id, null);
      }
    }).catch(() => {});
  });

  async function handle(msg, sender) {
    const extensionPage = sender.url?.startsWith(extensionOrigin);
    const fromYoutube = sender.frameId === 0 && /^https:\/\/(www|m)\.youtube\.com\//.test(sender.url || "");
    if (!extensionPage && !fromYoutube) throw new Error("Queue request denied");
    if (msg.type === "QUEUE_VIEW") return queue.view();
    if (msg.type === "QUEUE_SETTINGS" && fromYoutube) {
      await api.tabs.create({ url: api.runtime.getURL("queue.html#settings") });
      return null;
    }
    if (msg.type === "QUEUE_SYNC") return queue.refresh();
    if (msg.type === "QUEUE_EDIT") {
      const view = await queue.mutate(msg.operation);
      queue.refresh().catch(() => {});
      return view;
    }
    if (msg.type === "QUEUE_CONNECT" && extensionPage) {
      const view = await queue.connect(msg.origin, msg.key);
      queue.refresh().catch(() => {});
      return view;
    }
    if (msg.type === "QUEUE_SESSION" && fromYoutube) {
      const id = sender.tab.id;
      const session = await tabSession(id);
      if (session?.videoId !== watchId(sender)) return null;
      await setTabSession(id, { ...session, claimed: true });
      return { token: session.token };
    }
    if (msg.type === "QUEUE_OPEN" && model.videoId(msg.videoId)) {
      const view = await queue.view();
      if (!view.entries.some((entry) => entry.videoId === msg.videoId)) {
        throw new Error("This video is no longer in the queue");
      }
      await startVideo(msg.videoId, sender);
      return null;
    }
    if (msg.type === "QUEUE_NEXT" && fromYoutube) {
      const session = await tabSession(sender.tab.id);
      if (session?.token !== msg.token || session.videoId !== watchId(sender)) return null;
      const { entries } = await queue.view();
      const index = entries.findIndex((entry) => entry.videoId === session.videoId);
      const next = index < 0 ? null : entries[index + 1];
      if (next) await startVideo(next.videoId, sender);
      return next || null;
    }
    throw new Error("Unknown queue action");
  }

  api.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg?.type?.startsWith("QUEUE_")) return false;
    handle(msg, sender).then(
      (value) => respond({ ok: true, value }),
      (error) => respond({ ok: false, error: error.message || "Queue unavailable" }),
    );
    return true;
  });
})();
