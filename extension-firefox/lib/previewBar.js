/* YT-TLDW preview bar — adapted from SponsorBlock previewBar (GPL-3.0)
 * https://github.com/ajayyy/SponsorBlock — src/js-components/previewBar.ts
 * Simplified: key windows (green) + sponsor skips (red #e53935 for contrast).
 */
(function (global) {
  const BAR_ID = "yt-tldw-previewbar";
  const GOOD_COLOR = "#3ddc97";
  const SPONSOR_COLOR = "#e53935"; // red — contrast vs green goods

  function findProgressBar() {
    const all = document.querySelectorAll(
      ".ytp-progress-bar, .ytp-progress-bar-container > .html5-progress-bar > .ytp-progress-list"
    );
    for (const el of all) {
      if (el && el.clientWidth > 0) return el;
    }
    // m.youtube.com: no .ytp-progress-bar. The seek bar is <yt-progress-bar> and its 0-height
    // .ytPlayerProgressBarProgressBar track is the positioned box the chapter line is drawn in.
    for (const el of document.querySelectorAll(".ytPlayerProgressBarProgressBar")) {
      if (el.clientWidth > 0) return el;
    }
    return all[0] || null;
  }

  function isMobileTrack(el) {
    return !!el?.classList?.contains("ytPlayerProgressBarProgressBar");
  }

  class TldwPreviewBar {
    constructor() {
      this.container = null;
      this.parent = null;
      this.segments = [];
      this.videoDuration = 0;
      this._ro = null;
      this._mo = null;
      this._moTimer = null;
      this._onResize = () => this.remountAndRender();
    }

    ensureContainer(parent) {
      if (!this.container) {
        this.container = document.createElement("ul");
        this.container.id = BAR_ID;
        this.container.dataset.ytTldwUi = "1";
        this.container.className = "yt-tldw-previewbar sbNotInvidious";
      }
      const mobile = isMobileTrack(parent);
      this.container?.classList.toggle("yt-tldw-previewbar-m", mobile);
      // Mobile: append so the colors paint above YouTube's chapter/progress fills.
      const put = (p) => (mobile ? p.append(this.container) : p.prepend(this.container));
      if (parent && this.parent !== parent) {
        this.parent = parent;
        if (this.container.parentElement !== parent) put(parent);
        this._bindResize(parent);
      } else if (parent && this.container.parentElement !== parent) {
        put(parent);
        this.parent = parent;
      }
      return this.container;
    }

    _bindResize(parent) {
      if (this._ro) {
        try {
          this._ro.disconnect();
        } catch (_) {}
      }
      if (typeof ResizeObserver !== "undefined") {
        this._ro = new ResizeObserver(() => {
          if (this._moTimer) return;
          this._moTimer = setTimeout(() => {
            this._moTimer = null;
            this.render();
          }, 80);
        });
        this._ro.observe(parent);
        const player = document.querySelector("#movie_player");
        if (player) this._ro.observe(player);
      }
      window.removeEventListener("resize", this._onResize);
      window.addEventListener("resize", this._onResize);
      // Theater / fullscreen class changes
      if (this._mo) {
        try {
          this._mo.disconnect();
        } catch (_) {}
      }
      const movie = document.querySelector("#movie_player");
      if (movie) {
        this._mo = new MutationObserver(() => {
          if (this._moTimer) return;
          this._moTimer = setTimeout(() => {
            this._moTimer = null;
            this.remountAndRender();
          }, 120);
        });
        this._mo.observe(movie, { attributes: true, attributeFilter: ["class"] });
      }
    }

    set(segments, videoDuration) {
      this.segments = segments || [];
      this.videoDuration = videoDuration || 0;
      this.remountAndRender();
    }

    // m.youtube.com builds/rebuilds its progress track lazily (on first play, controls toggle),
    // so keep a debounced watcher that re-mounts whenever our bar is missing or detached.
    _watch() {
      if (this._wo || typeof MutationObserver === "undefined") return;
      this._wo = new MutationObserver(() => {
        if (this._woTimer) return;
        this._woTimer = setTimeout(() => {
          this._woTimer = null;
          if (!this.segments.length) return;
          if (this.container?.isConnected && this.parent?.isConnected && this.parent.clientWidth > 0) return;
          this.remountAndRender();
        }, 400);
      });
      this._wo.observe(document.documentElement, { childList: true, subtree: true });
    }

    _unwatch() {
      if (this._wo) this._wo.disconnect();
      this._wo = null;
      if (this._woTimer) clearTimeout(this._woTimer);
      this._woTimer = null;
    }

    remountAndRender() {
      if (!this.segments.length) {
        this.clear();
        return;
      }
      this._watch();
      const progress = findProgressBar();
      if (!progress) return;
      this.ensureContainer(progress);
      // Prefer aria-valuemax like SB when video duration drifts
      // (Mobile's slider reports aria-valuemax=100 as a percent, so never use it there.)
      const aria = isMobileTrack(progress) ? 0 : parseInt(progress.getAttribute("aria-valuemax") || "0", 10);
      if (aria && Math.abs(aria - this.videoDuration) > 3) this.videoDuration = aria;
      this.render();
    }

    timeToPercentage(time) {
      const d = this.videoDuration || 1;
      return `${Math.max(0, Math.min(100, (time / d) * 100))}%`;
    }

    timeToRightPercentage(time) {
      const d = this.videoDuration || 1;
      return `${Math.max(0, Math.min(100, 100 - (time / d) * 100))}%`;
    }

    render() {
      if (!this.container || !this.videoDuration) return;
      // Longer segments first so shorter ones paint on top (SB pattern)
      const sorted = this.segments.slice().sort((a, b) => b.end - b.start - (a.end - a.start));
      const frag = document.createDocumentFragment();
      for (const seg of sorted) {
        const li = document.createElement("li");
        li.className = "yt-tldw-barseg previewbar";
        li.setAttribute("data-kind", seg.kind || "good");
        li.innerHTML = "&nbsp;";
        const start = Math.min(this.videoDuration, Math.max(0, seg.start));
        const end = Math.min(this.videoDuration, Math.max(start, seg.end));
        li.style.position = "absolute";
        li.style.left = this.timeToPercentage(start);
        if (end > start) li.style.right = this.timeToRightPercentage(end);
        li.style.backgroundColor = seg.kind === "sponsor" ? SPONSOR_COLOR : GOOD_COLOR;
        li.style.opacity = seg.kind === "sponsor" ? "0.7" : "0.85";
        li.title = seg.title || (seg.kind === "sponsor" ? "sponsor" : "moment");
        frag.appendChild(li);
      }
      this.container.replaceChildren(frag);
    }

    clear() {
      this._unwatch();
      if (this.container) {
        this.container.replaceChildren();
        this.container.remove();
      }
      this.container = null;
      this.parent = null;
      this.segments = [];
      if (this._ro) {
        try {
          this._ro.disconnect();
        } catch (_) {}
        this._ro = null;
      }
      if (this._mo) {
        try {
          this._mo.disconnect();
        } catch (_) {}
        this._mo = null;
      }
      window.removeEventListener("resize", this._onResize);
    }
  }

  global.TldwPreviewBar = TldwPreviewBar;
  global.TLDW_PREVIEW_COLORS = { GOOD_COLOR, SPONSOR_COLOR };
})(typeof window !== "undefined" ? window : self);
