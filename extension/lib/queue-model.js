/* YT-TLDW queue protocol (GPL-3.0). */
((root) => {
  "use strict";

  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const OP_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const MAX_TITLE = 300;

  function videoId(value) {
    return typeof value === "string" && VIDEO_ID.test(value) ? value : null;
  }

  function videoIdFromUrl(value, base) {
    try {
      const url = new URL(value, base);
      if (url.protocol === "https:" && ["www.youtube.com", "m.youtube.com"].includes(url.hostname) &&
          url.pathname === "/watch") return videoId(url.searchParams.get("v"));
    } catch {}
    return null;
  }

  function normalizeOperation(input) {
    if (!input || typeof input.opId !== "string" || !OP_ID.test(input.opId)) return null;
    const id = videoId(input.videoId);
    if (!id) return null;
    const op = { opId: input.opId, type: input.type, videoId: id };
    if (input.type === "add") {
      if (typeof input.title !== "string") return null;
      return { ...op, title: input.title.trim().slice(0, MAX_TITLE) || id };
    }
    if (input.type === "remove") return op;
    if (input.type === "move" && (input.beforeId === null || videoId(input.beforeId)) &&
        input.beforeId !== id) return { ...op, beforeId: input.beforeId };
    return null;
  }

  function apply(queue, op) {
    const index = queue.findIndex((entry) => entry.videoId === op.videoId);
    if (op.type === "add") {
      return index < 0 ? [...queue, { videoId: op.videoId, title: op.title }] : queue;
    }
    if (index < 0) return queue;
    if (op.type === "remove") return queue.filter((entry) => entry.videoId !== op.videoId);
    if (op.beforeId !== null && !queue.some((entry) => entry.videoId === op.beforeId)) return queue;
    const reordered = [...queue];
    const [entry] = reordered.splice(index, 1);
    const before = op.beforeId === null ? reordered.length
      : reordered.findIndex((item) => item.videoId === op.beforeId);
    reordered.splice(before, 0, entry);
    return reordered;
  }

  function snapshot(value) {
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !Array.isArray(value.entries)) return null;
    const seen = new Set();
    const entries = [];
    for (const entry of value.entries) {
      if (!videoId(entry?.videoId) || seen.has(entry.videoId) || typeof entry.title !== "string" ||
          !entry.title || entry.title.length > MAX_TITLE) return null;
      entries.push({ videoId: entry.videoId, title: entry.title });
      seen.add(entry.videoId);
    }
    return { revision: value.revision, entries };
  }

  const api = { videoId, videoIdFromUrl, normalizeOperation, apply, snapshot };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YtTldwQueueModel = api;
})(globalThis);
