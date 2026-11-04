/* Shared YT-TLDW settings helpers (GPL-3.0). Usable in SW (importScripts), content, popup, options. */
(function (root) {
  const DEFAULTS = {
    enabled: false,
    method: "auto", // auto | api | dom
    debug: true,
    genre: "facts", // facts | funny | popular
    intensity: "mild", // aggressive | mild | weak
    askTemplate: null,
    momentsPanelCollapsed: false,
  };

  const GENRES = [
    { id: "facts", label: "Facts" },
    { id: "funny", label: "Funny" },
    { id: "popular", label: "Popular" },
  ];

  const INTENSITIES = [
    { id: "aggressive", label: "Aggressive" },
    { id: "mild", label: "Mild" },
    { id: "weak", label: "Weak" },
  ];

  function normalizeGenre(g) {
    const v = String(g || "").toLowerCase();
    return ["facts", "funny", "popular"].includes(v) ? v : "facts";
  }

  function normalizeIntensity(i) {
    const v = String(i || "").toLowerCase();
    return ["aggressive", "mild", "weak"].includes(v) ? v : "mild";
  }

  function normalizeMethod(m) {
    const v = String(m || "").toLowerCase();
    return ["auto", "api", "dom"].includes(v) ? v : "auto";
  }

  /** Target keep fraction of runtime + soft moment count caps. */
  function intensityTargets(intensity) {
    switch (normalizeIntensity(intensity)) {
      case "aggressive":
        return { minFrac: 0.1, maxFrac: 0.2, maxMoments: 5, preferCount: 4 };
      case "weak":
        return { minFrac: 0.7, maxFrac: 0.9, maxMoments: 40, preferCount: 24 };
      case "mild":
      default:
        return { minFrac: 0.3, maxFrac: 0.5, maxMoments: 14, preferCount: 8 };
    }
  }

  /** Heatmap score threshold + peak caps mapped to intensity. */
  function heatmapParams(intensity) {
    switch (normalizeIntensity(intensity)) {
      case "aggressive":
        return { scoreThreshold: 0.55, maxPeaks: 5, defaultDuration: 24 };
      case "weak":
        return { scoreThreshold: 0.18, maxPeaks: 18, defaultDuration: 32 };
      case "mild":
      default:
        return { scoreThreshold: 0.35, maxPeaks: 9, defaultDuration: 28 };
    }
  }

  function genreFocusLine(genre) {
    switch (normalizeGenre(genre)) {
      case "funny":
        return "Focus on the funniest, most humorous, witty, or comedic moments.";
      case "popular":
        return "Focus on the most popular, engaging, and widely-replayed moments viewers seek out.";
      case "facts":
      default:
        return "Focus on the most important factual and informational sections viewers need to understand the video.";
    }
  }

  function intensityInstruction(intensity) {
    switch (normalizeIntensity(intensity)) {
      case "aggressive":
        return (
          "Be highly selective: return only the few most pertinent sections " +
          "(roughly 3–5 moments, about 10–20% of the video runtime). Skip everything else."
        );
      case "weak":
        return (
          "Be inclusive: keep most of the content and exclude only moments that are " +
          "definitively not pertinent (intros/outros/sponsors fluff). Aim for about 70–90% of runtime."
        );
      case "mild":
      default:
        return (
          "Balance coverage and brevity: keep an optimal set of moments " +
          "(about 30–50% of the video runtime)."
        );
    }
  }

  function buildPrompt(genre, intensity) {
    return (
      `${genreFocusLine(genre)} ${intensityInstruction(intensity)} ` +
      "For each moment give: a short title, the start timestamp, and approximate duration in seconds. " +
      "Skip intros, outros, and sponsor reads unless they are the point. " +
      "Format each as: TITLE | MM:SS | DURATION_SECONDS"
    );
  }

  function momentsCacheKey(videoId, genre, intensity) {
    return `${videoId}|${normalizeGenre(genre)}|${normalizeIntensity(intensity)}`;
  }

  /**
   * Post-filter moments toward intensity keep-fraction of duration.
   * Prefers earlier-listed / higher-score moments when trimming.
   */
  function filterMomentsByIntensity(moments, durationSec, intensity) {
    const list = Array.isArray(moments) ? moments.slice() : [];
    if (!list.length) return list;
    const t = intensityTargets(intensity);
    const dur = Number(durationSec) > 0 ? Number(durationSec) : 0;

    const span = (m) => {
      const start = Math.max(0, Number(m.start) || 0);
      const end = Math.max(start, Number(m.end) || start + 35);
      return Math.max(0, end - start);
    };

    // Cap count first for aggressive/mild
    let kept = list.slice(0, t.maxMoments);

    if (!dur) {
      // No duration: aggressive/mild trim by count only
      if (normalizeIntensity(intensity) === "aggressive") return kept.slice(0, t.preferCount);
      if (normalizeIntensity(intensity) === "mild") return kept.slice(0, t.preferCount);
      return kept;
    }

    const totalSpan = (arr) => arr.reduce((a, m) => a + span(m), 0);
    // Grow/shrink toward maxFrac (prefer not exceeding)
    if (totalSpan(kept) > dur * t.maxFrac) {
      const out = [];
      let acc = 0;
      for (const m of kept) {
        const s = span(m);
        if (out.length && acc + s > dur * t.maxFrac) break;
        out.push(m);
        acc += s;
        if (out.length >= t.maxMoments) break;
      }
      kept = out.length ? out : kept.slice(0, 1);
    } else if (
      normalizeIntensity(intensity) === "aggressive" &&
      kept.length > t.preferCount &&
      totalSpan(kept) > dur * t.minFrac
    ) {
      kept = kept.slice(0, t.preferCount);
    }
    return kept;
  }

  function labelGenre(g) {
    return GENRES.find((x) => x.id === normalizeGenre(g))?.label || "Facts";
  }

  function labelIntensity(i) {
    return INTENSITIES.find((x) => x.id === normalizeIntensity(i))?.label || "Mild";
  }

  const api = {
    DEFAULTS,
    GENRES,
    INTENSITIES,
    normalizeGenre,
    normalizeIntensity,
    normalizeMethod,
    intensityTargets,
    heatmapParams,
    buildPrompt,
    momentsCacheKey,
    filterMomentsByIntensity,
    labelGenre,
    labelIntensity,
  };

  root.YtTldwSettings = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
