/* Shared YT-TLDW settings helpers (GPL-3.0). Usable in SW (importScripts), content, popup, options. */
(function (root) {
  const DEFAULTS = {
    enabled: false,
    method: "auto", // auto | api | dom
    debug: true,
    genre: "facts", // facts | funny | popular
    intensity: "mild", // aggressive | mild | weak
    autoJump: true, // in-player: auto seek between essential segments
    applyAt: 0, // bumped on every Apply to force refresh + jump to first
    askTemplate: null,
    momentsPanelCollapsed: false,
    momentsShowAskIo: false, // moments panel: show Ask prompt + response
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

  /**
   * Heatmap peak selection + section length mapped to intensity.
   * valleyBlend: 0 = max-curvature edges, 1 = local minima, 0.5 = halfway.
   * defaultDuration only pads tiny windows; durationScale kept for compatibility.
   */
  function heatmapParams(intensity) {
    switch (normalizeIntensity(intensity)) {
      case "aggressive":
        return { scoreThreshold: 0.58, maxPeaks: 4, defaultDuration: 12, durationScale: 1, valleyBlend: 0 };
      case "weak":
        return { scoreThreshold: 0.16, maxPeaks: 16, defaultDuration: 48, durationScale: 1, valleyBlend: 1 };
      case "mild":
      default:
        return { scoreThreshold: 0.32, maxPeaks: 8, defaultDuration: 28, durationScale: 1, valleyBlend: 0.5 };
    }
  }

  function factsSpanLine(intensity) {
    switch (normalizeIntensity(intensity)) {
      case "aggressive":
        return (
          "For Facts, cover only the claim or fact itself. " +
          "Keep each duration short: the statement, not the surrounding explanation."
        );
      case "weak":
        return (
          "For Facts, include each claim together with the fuller explanation around it " +
          "so the point is understandable in context."
        );
      case "mild":
      default:
        return (
          "For Facts, include each claim plus the immediate context needed to understand it, " +
          "without covering the whole surrounding discussion."
        );
    }
  }

  function intensityPreferenceLine(intensity) {
    switch (normalizeIntensity(intensity)) {
      case "aggressive":
        return "Intensity preference: fewer of the strongest sections. This is a preference, not a fixed percent of runtime.";
      case "weak":
        return "Intensity preference: keep most pertinent sections and drop only clear fluff. This is a preference, not a fixed percent of runtime.";
      case "mild":
      default:
        return "Intensity preference: a balanced set of the pertinent sections. This is a preference, not a fixed percent of runtime.";
    }
  }

  function buildPrompt(genre, intensity) {
    const g = normalizeGenre(genre);
    const focus =
      g === "funny"
        ? "Focus on the funniest, most humorous, witty, or comedic moments. Include the setup before each punchline so the joke lands; start early enough for the setup and end when the bit lands."
        : g === "popular"
          ? "Focus on the most popular, engaging, and widely-replayed moments viewers seek out."
          : "Focus on the most important factual and informational claims viewers need from the video.";
    const span = g === "facts" ? factsSpanLine(intensity) : "";
    return (
      "Infer what kind of video this is (lecture, interview, podcast, compilation, gameplay, news, music, or other) and choose section starts and durations that fit that nature. Do not print that analysis. " +
      `${focus} ${span} ${intensityPreferenceLine(intensity)} ` +
      "Adapt length to the video: a lecture or explanation may need longer sections than a compilation of short clips. " +
      "If this is a compilation and a section start or end is close to a clip transition, snap that edge to the transition. " +
      "If you are unsure whether a section belongs, include it. Prefer more sections rather than fewer. Do not lengthen a section just to add time. " +
      "Skip intros, outros, and sponsor reads unless they are the point. " +
      "Output only lines formatted as: TITLE | MM:SS | DURATION_SECONDS"
    ).replace(/\s+/g, " ").trim();
  }

  function formatMmSs(sec) {
    const n = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = n % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  }

  /** Title-only Ask prompt. Heatmap timestamps are the only times Ask may use. */
  function buildPopularTitlePrompt(windows) {
    const rows = (Array.isArray(windows) ? windows : []).map((w) => {
      const start = Number(w.start) || 0;
      const dur = Math.max(1, Math.round((Number(w.end) || start + 1) - start));
      return `LABEL | ${formatMmSs(start)} | ${dur}`;
    });
    return (
      "YouTube's most-replayed heatmap already chose these exact sections. " +
      "Use only these timestamps and durations. Do not add, drop, or retimestamp any line. " +
      "Replace LABEL with a short title of what happens at that heatmap time. " +
      "Output only the same number of lines, in the same order, formatted as: TITLE | MM:SS | DURATION_SECONDS\n" +
      (rows.join("\n") || "(none)")
    );
  }

  /**
   * Copy Ask titles onto heatmap windows.
   * Heatmap start/end always win. Prefer same-order zip so Ask timestamps are ignored.
   */
  function applyAskTitlesToHeatmap(heatMoments, askMoments) {
    const heat = Array.isArray(heatMoments) ? heatMoments.map((m) => ({ ...m })) : [];
    const ask = Array.isArray(askMoments) ? askMoments : [];
    if (!heat.length || !ask.length) return heat;
    const cleanTitle = (t) =>
      String(t || "")
        .replace(/^[*•\-\s]+/, "")
        .replace(/^LABEL\s*$/i, "")
        .trim();
    const applyTitle = (h, a) => {
      const title = cleanTitle(a?.title);
      if (title && !/^\d{1,2}:\d{2}/.test(title) && !/^most replayed/i.test(title)) {
        h.title = title;
      }
    };
    if (ask.length === heat.length) {
      heat.forEach((h, i) => applyTitle(h, ask[i]));
      return heat;
    }
    const used = new Set();
    for (const h of heat) {
      const hs = Number(h.start) || 0;
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < ask.length; i++) {
        if (used.has(i)) continue;
        const dist = Math.abs((Number(ask[i].start) || 0) - hs);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      if (best < 0) continue;
      applyTitle(h, ask[best]);
      used.add(best);
    }
    return heat;
  }

  /**
   * Legacy keep-fraction trim. Playback no longer applies this to Ask results;
   * the model’s durations are kept. Heatmap intensity is applied in heatmapParams.
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
    buildPopularTitlePrompt,
    applyAskTitlesToHeatmap,
    formatMmSs,
    filterMomentsByIntensity,
    labelGenre,
    labelIntensity,
  };

  root.YtTldwSettings = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
