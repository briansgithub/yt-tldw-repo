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

  const FACTS_FOCUS =
    "Find the sections that carry this video's essential information: the takeaways a viewer should walk away with. " +
    "That means the main conclusions, key facts and numbers, recommendations, steps or instructions, " +
    "and the answer to the question the title asks or promises. " +
    "A recap or summary segment counts when it states the takeaways. " +
    "Skip intros, channel housekeeping, sponsor reads, tangents, repetition, and anecdotes that do not support a takeaway. " +
    "Title each section with the takeaway itself as a short statement, not a topic label.";

  const FUNNY_FOCUS =
    "Find the funniest moments in this video. " +
    "Strongest evidence first: places where the transcript shows [Laughter], [Laughs], or [Applause], or where people audibly crack up; " +
    "then punchlines, comedic bits, absurd or surprising moments, witty comebacks, and funny reactions or fails. " +
    "Judge by what an audience would actually laugh at, not by topic. " +
    "Start each section at the setup of the joke or bit, not at the punchline, and end it once the laughter or reaction dies down. " +
    "Merge back-to-back jokes on the same bit into one section. " +
    "If the video has no clear jokes, return its most amusing or lighthearted moments. " +
    "Title each section with what makes it funny.";

  function factsAmountLine(intensity) {
    switch (normalizeIntensity(intensity)) {
      case "aggressive":
        return (
          "Return only the 3 to 5 most important takeaways, the ones someone would list if asked what the video taught them. " +
          "Each section covers just the statement of the takeaway, usually 10 to 30 seconds."
        );
      case "weak":
        return (
          "Return all takeaways, including secondary ones, and drop only filler. " +
          "Each section covers the takeaway with its full explanation, examples, and evidence. " +
          "If unsure whether a part matters, include it."
        );
      case "mild":
      default:
        return (
          "Return every major takeaway, typically 5 to 10. " +
          "Each section covers the takeaway plus the explanation or evidence needed to understand it, usually 30 to 90 seconds."
        );
    }
  }

  function funnyAmountLine(intensity) {
    switch (normalizeIntensity(intensity)) {
      case "aggressive":
        return "Return only the 3 to 5 biggest laughs. Keep each to the setup and punchline, usually 10 to 30 seconds.";
      case "weak":
        return (
          "Return every funny moment, including small chuckles and running gags. " +
          "Give each enough lead-up to make sense on its own. If unsure whether a moment is funny, include it."
        );
      case "mild":
      default:
        return "Return the clear laughs, typically 5 to 12. Include the setup, the punchline, and the reaction, usually 20 to 60 seconds.";
    }
  }

  const OUTPUT_RULES =
    "Use the video's transcript and its timestamps. " +
    "Fit section lengths to the kind of video: a lecture needs longer sections than a clip compilation, " +
    "and in a compilation snap section edges to clip transitions. " +
    "Start each section at the beginning of the sentence that opens it. Sections must not overlap. " +
    "Do not lengthen a section just to add time. " +
    "Output only lines in this format, one per section, in chronological order, " +
    "with no heading, numbering, bullets, or other text: TITLE | MM:SS | DURATION_SECONDS. " +
    "Use H:MM:SS for times past one hour. DURATION_SECONDS is a whole number. " +
    "Keep titles under 8 words and never use the | character inside a title.";

  function buildPrompt(genre, intensity) {
    const g = normalizeGenre(genre);
    const focus = g === "funny" ? FUNNY_FOCUS : FACTS_FOCUS;
    const amount = g === "funny" ? funnyAmountLine(intensity) : factsAmountLine(intensity);
    return `${focus} ${amount} ${OUTPUT_RULES}`.replace(/\s+/g, " ").trim();
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
      "These are the most-rewatched sections of this video, taken from YouTube's most-replayed graph. " +
      "For each line, check what is said and shown in that time range and replace LABEL with a short, specific title " +
      "(under 8 words) naming the moment viewers keep rewatching, such as the reveal, result, joke, demo, or key line, " +
      "rather than a generic topic. " +
      "Keep every timestamp and duration exactly as given. Do not add, remove, merge, reorder, or retime any line. " +
      "Never use the | character inside a title. " +
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
