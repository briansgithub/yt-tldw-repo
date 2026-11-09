/* Queue controls and per-tab playback on YouTube (GPL-3.0). */
(() => {
  "use strict";

  const api = globalThis.browser || chrome;
  const { button, mount, request } = globalThis.YtTldwQueueView;
  const { videoIdFromUrl } = globalThis.YtTldwQueueModel;
  const here = () => videoIdFromUrl(location.href);
  const cardSelector = [
    "ytd-rich-item-renderer", "ytd-video-renderer", "yt-lockup-view-model",
    "ytm-rich-item-renderer", "ytm-video-with-context-renderer", "ytm-media-item",
  ].join(",");
  let id;
  let session;
  let checking;
  let status = "idle";
  let next;
  let media;
  let hasNext = false;
  let held = new WeakSet();
  let autoplay = false;
  let fullPlayback = false;

  api.storage.local.get({ queueAutoplay: false }).then((data) => { autoplay = data.queueAutoplay; }).catch(() => {});
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.queueAutoplay) autoplay = changes.queueAutoplay.newValue === true;
  });

  function add(videoId, title, el) {
    el.disabled = true;
    request("QUEUE_EDIT", { operation: { type: "add", videoId, title } }).then(() => {
      el.textContent = "Added";
      el.removeAttribute("title");
    }, (error) => {
      el.textContent = "Retry add";
      el.title = error.message;
    }).finally(() => {
      el.disabled = false;
    });
  }

  const bar = document.createElement("section");
  bar.className = "yt-tldw-queue-watch";
  bar.dataset.ytTldwUi = "1";
  bar.setAttribute("aria-label", "YT-TLDW queue");
  const feedback = document.createElement("p");
  feedback.setAttribute("role", "status");
  feedback.hidden = true;
  const play = button("Tap to play", () => tryPlay(media));
  const full = button("Watch full video", () => {
    fullPlayback = true;
    status = "full";
    paint();
    tryPlay(media);
  });
  const advance = button("Play next", () => advanceQueue());
  const addCurrent = button("Add to queue", () => {
    const current = here();
    if (!current) return;
    const title = document.querySelector("ytd-watch-metadata h1, ytm-slim-video-metadata-section h2")?.textContent.trim();
    const metadata = document.querySelector("meta[property='og:title']")?.content;
    add(current, title || metadata || document.title.replace(/\s+-\s+YouTube$/, ""), addCurrent);
  });
  const panel = document.createElement("div");
  panel.hidden = true;
  const toggle = button("Queue", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) view.refresh(true);
  });
  toggle.setAttribute("aria-expanded", "false");
  bar.append(addCurrent, toggle, feedback, play, full, advance, panel);
  const view = mount(panel);

  function paint() {
    const text = {
      loading: "Finding highlights…",
      empty: hasNext ? "No playable highlights found." : "No playable highlights found. End of queue.",
      blocked: "Tap to start playback.",
      done: hasNext ? "Highlights finished." : "End of queue.",
      advancing: "Opening the next video…",
      error: "Could not open the next video.",
    }[status];
    feedback.hidden = !text;
    feedback.textContent = text || "";
    play.hidden = status !== "blocked";
    full.hidden = status !== "empty";
    advance.hidden = !hasNext || !["done", "empty", "error"].includes(status);
  }

  function place() {
    if (!here()) {
      bar.remove();
      return;
    }
    const host = document.querySelector(location.hostname === "m.youtube.com"
      ? "ytm-watch .watch-below-the-player, #watch-below-the-player, ytm-watch #below, ytm-slim-video-metadata-section"
      : "ytd-watch-flexy #below, ytd-watch-metadata");
    if (host) {
      delete bar.dataset.floating;
      if (bar.parentElement !== host) host.prepend(bar);
    } else if (document.body && !bar.isConnected) {
      bar.dataset.floating = "";
      document.body.append(bar);
    }
  }

  function scanCards() {
    if (!["/", "/results"].includes(location.pathname)) return;
    for (const card of document.querySelectorAll(cardSelector)) {
      if (card.parentElement?.closest(cardSelector)) continue;
      const anchors = [...card.querySelectorAll("a[href*='/watch?']")];
      const anchor = anchors.find((el) => videoIdFromUrl(el.href));
      const videoId = anchor && videoIdFromUrl(anchor.href);
      const existing = card.querySelector(":scope > .yt-tldw-queue-card");
      if (existing?.dataset.videoId === videoId) continue;
      existing?.remove();
      if (!videoId) continue;
      const title = anchors.find((el) => videoIdFromUrl(el.href) === videoId &&
        (el.getAttribute("title") || el.textContent.trim()));
      const control = button("Add to queue", (event) => {
        event.stopPropagation();
        add(videoId, title?.getAttribute("title") || title?.textContent.trim() ||
          anchor.getAttribute("aria-label") || videoId, control);
      });
      control.className = "yt-tldw-queue-card";
      control.dataset.videoId = videoId;
      card.append(control);
    }
  }

  async function checkNext() {
    const token = session?.token;
    const { entries } = await request("QUEUE_VIEW");
    if (!token || token !== session?.token) return;
    const index = entries.findIndex((entry) => entry.videoId === id);
    hasNext = index >= 0 && index < entries.length - 1;
    paint();
  }

  function isActive() {
    return !!session && id === here();
  }

  function hold(video) {
    if (!video || !isActive() || !["loading", "empty"].includes(status)) return false;
    const pause = () => {
      if (isActive() && ["loading", "empty"].includes(status) &&
          !document.querySelector("#watch-party-panel, #movie_player.ad-showing, #movie_player.ad-interrupting")) video.pause();
    };
    if (!held.has(video)) {
      held.add(video);
      video.addEventListener("play", pause);
      video.addEventListener("playing", pause);
    }
    media = video;
    if (!video.paused) pause();
    return true;
  }

  function prepare(videoId, video) {
    if (id === videoId && checking) return checking;
    id = videoId;
    session = null;
    status = "idle";
    fullPlayback = false;
    media = null;
    next = null;
    hasNext = false;
    addCurrent.textContent = "Add to queue";
    paint();
    place();
    checking = videoId ? request("QUEUE_SESSION").then((value) => {
      if (id !== videoId || id !== here() || checking !== lookup) return false;
      session = value;
      if (session) {
        status = "loading";
        hold(video);
        paint();
      }
      return !!session;
    }).catch(() => false) : Promise.resolve(false);
    const lookup = checking;
    return lookup;
  }

  async function tryPlay(video) {
    if (!video || !isActive()) return;
    const token = session.token;
    try {
      await video.play();
      if (session?.token === token && isActive() && status === "blocked") {
        status = fullPlayback ? "full" : "playing";
        paint();
      }
    } catch {
      if (session?.token === token && isActive() && (status === "playing" || status === "full")) {
        status = "blocked";
        paint();
      }
    }
  }

  function ready(video, hasWindows) {
    if (!isActive()) return;
    media = video;
    if (fullPlayback || status === "done" || status === "advancing") return;
    if (hasWindows && video) {
      status = "playing";
      paint();
      tryPlay(video);
    } else {
      status = "empty";
      hold(video);
      paint();
      checkNext().catch(() => {});
    }
  }

  function advanceQueue() {
    if (!isActive() || next || !["done", "empty", "error"].includes(status)) return;
    const token = session.token;
    const previousStatus = status;
    status = "advancing";
    paint();
    next = request("QUEUE_NEXT", { token }).then((entry) => {
      if (session?.token !== token || !isActive()) return;
      if (!entry) {
        status = previousStatus;
        hasNext = false;
        paint();
      }
    }).catch(() => {
      if (session?.token === token && isActive()) {
        status = "error";
        paint();
      }
    }).finally(() => {
      if (session?.token === token) next = null;
    });
  }

  function done() {
    if (!isActive() || status !== "playing") return;
    status = "done";
    paint();
    if (autoplay) advanceQueue();
    else checkNext().catch(() => {});
  }

  paint();
  const holdOnPlay = (event) => {
    if (event.target instanceof HTMLVideoElement) hold(event.target);
  };
  document.addEventListener("play", holdOnPlay, true);
  document.addEventListener("playing", holdOnPlay, true);
  let timer;
  const refreshUi = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      place();
      scanCards();
      if (status === "loading" || status === "empty") {
        hold(document.querySelector("#movie_player video, video"));
      }
    }, 200);
  };
  new MutationObserver(refreshUi).observe(document, { childList: true, subtree: true });
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.queueChanged && ["done", "empty", "error"].includes(status)) {
      checkNext().catch(() => {});
    }
  });
  refreshUi();
  globalThis.YtTldwQueuePlayback = {
    prepare, hold, ready, done, isActive,
    full: () => isActive() && fullPlayback,
  };
  prepare(here(), null);
})();
