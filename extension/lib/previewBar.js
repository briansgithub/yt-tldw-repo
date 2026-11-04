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
    return all[0] || null;
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
      if (parent && this.parent !== parent) {
        this.parent = parent;
        if (this.container.parentElement !== parent) parent.prepend(this.container);
        this._bindResize(parent);
      } else if (parent && this.container.parentElement !== parent) {
        parent.prepend(this.container);
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

    remountAndRender() {
      if (!this.segments.length) {
        this.clear();
        return;
      }
      const progress = findProgressBar();
      if (!progress) return;
      this.ensureContainer(progress);
      // Prefer aria-valuemax like SB when video duration drifts
      const aria = parseInt(progress.getAttribute("aria-valuemax") || "0", 10);
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
