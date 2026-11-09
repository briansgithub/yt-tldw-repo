/* Background-only queue and sync client (GPL-3.0). */
((root) => {
  "use strict";

  function syncOrigin(value) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.hostname.endsWith(".ts.net") &&
          url.pathname === "/" && !url.username && !url.password &&
          !url.port && !url.search && !url.hash) return url.origin;
    } catch {}
    return null;
  }

  function createQueueSync({ model, load, save, notify, fetchQueue, uuid }) {
    let writes = Promise.resolve();
    let syncing;
    const serial = (task) => {
      const next = writes.then(task);
      writes = next.catch(() => {});
      return next;
    };
    const entries = (state) => state.pending.reduce(model.apply, state.base.entries);

    function view(state) {
      return {
        entries: entries(state),
        pending: state.pending.length,
        origin: state.config?.origin || null,
        lastSync: state.lastSync || null,
        error: state.error || null,
      };
    }

    async function update(state) {
      await save(state);
      await notify().catch(() => {});
      return view(state);
    }

    async function request(config, op) {
      const snapshot = model.snapshot(await fetchQueue(config, op));
      if (!snapshot) throw new Error("Invalid response from sync server");
      return snapshot;
    }

    async function runSync() {
      let state = await serial(load);
      const config = state.config;
      if (!config) return view(state);
      try {
        do {
          const op = state.pending[0];
          const snapshot = await request(config, op);
          state = await serial(async () => {
            const current = await load();
            if (current.config?.id !== config.id) return current;
            if (snapshot.revision < current.base.revision) {
              throw new Error("Server queue is older than this device’s copy");
            }
            current.base = snapshot;
            if (op) current.pending = current.pending.filter((item) => item.opId !== op.opId);
            current.lastSync = Date.now();
            current.error = null;
            await update(current);
            return current;
          });
        } while (state.config?.id === config.id && state.pending.length);
      } catch (error) {
        state = await serial(async () => {
          const current = await load();
          if (current.config?.id === config.id) {
            const message = error.message || "Sync unavailable";
            if (current.error !== message) {
              current.error = message;
              await update(current);
            }
          }
          return current;
        });
      }
      return view(state);
    }

    function refresh() {
      if (!syncing) syncing = runSync().finally(() => { syncing = null; });
      return syncing;
    }

    return {
      view: () => serial(async () => view(await load())),
      refresh,
      async mutate(input) {
        const op = model.normalizeOperation({ ...input, opId: uuid() });
        if (!op) throw new Error("Invalid queue operation");
        return serial(async () => {
          const state = await load();
          if (state.config) state.pending.push(op);
          else state.base.entries = model.apply(state.base.entries, op);
          return update(state);
        });
      },
      async connect(origin, key) {
        const config = { origin: syncOrigin(origin), key, id: uuid() };
        if (!config.origin || typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
          throw new Error("Enter a Tailscale HTTPS address and a valid access key");
        }
        const base = await request(config);
        return serial(async () => {
          const state = await load();
          const sameHost = state.config?.origin === config.origin;
          if (!sameHost && state.config && state.pending.length) {
            throw new Error("Sync pending edits on the current server before changing servers");
          }
          if (sameHost && base.revision < state.base.revision) {
            throw new Error("Server queue is older than this device’s copy");
          }
          if (!sameHost) {
            state.pending = state.base.entries.map(({ videoId, title }) => ({
              opId: uuid(), type: "add", videoId, title,
            }));
          }
          state.config = config;
          state.base = base;
          state.error = null;
          state.lastSync = Date.now();
          return update(state);
        });
      },
    };
  }

  const api = { syncOrigin, createQueueSync };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YtTldwQueueSync = api;
})(globalThis);
