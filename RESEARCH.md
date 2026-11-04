# YT-TLDW Research: Ask/Gemini key moments + SponsorBlock skip

Workspace: `/workspace/yt-tldw`  
SponsorBlock clone: `/workspace/yt-tldw/SponsorBlock` (GPL-3, maze-utils submodule checked out)  
Date: 2026-11-03 (America/New_York)

---

## 1) YouTube Ask (Gemini / YouChat) — how it works

### Product surface
- Watch-page **Ask** / sparkle button (`button[aria-label="Ask"]`).
- Opens engagement panel `ytd-engagement-panel-section-list-renderer[target-id="PAyouchat"]`.
- Suggested chips include e.g. “Summarize the video” (`.ytwYouChatChipsDataChip`).
- Messages render as `you-chat-item-view-model` / `youChatItemViewModel`.
- Official help: signed-in, age-gated (13+), **select regions/languages**, **select videos**; **not Premium-required** for watch-page Ask. Kid/supervised accounts excluded.
  - https://support.google.com/youtube/answer/14110396

### Wire protocol (from Kaset reverse-engineering, Jul–Aug 2026)
Best open writeup:
- https://github.com/sozercan/kaset/blob/main/docs/youtube.md
- https://github.com/sozercan/kaset/blob/main/docs/adr/0032-youtube-ask-gemini.md
- https://github.com/sozercan/kaset/blob/main/docs/api-discovery.md#youtube-ask-gemini--youchat-investigation-2026-07-27

| Step | Endpoint | Notes |
|------|----------|-------|
| Eligibility + bootstrap | `POST /youtubei/v1/next` (watch) | Parse confirmed YouChat structures / `PAyouchat` panel; may include chips + `sendUserQueryCommand` |
| Materialize empty panel | `POST /youtubei/v1/get_panel` | Prompt-free; exact **server-issued** panel continuation only |
| Submit chip or free text | `POST /youtubei/v1/get_panel` | **Not** `streaming_panel` (HTTP 400 in Aug 2026 capture) |

**Auth / client**
- Origin `https://www.youtube.com`, clientName `WEB`.
- Cookies (`SAPISID` / `__Secure-3PAPISID`, SID family) + **SAPISIDHASH** Authorization for signed-in.
- Page already has `ytcfg` / INNERTUBE context (`INNERTUBE_CONTEXT`, visitor data, client version). Same-origin `fetch` from the page (MAIN world) can reuse session cookies; external clients must mint SAPISIDHASH.
- API `key=` often unnecessary for current WEB InnerTube (per Kaset, Jun 2026).

**Free-text body shape (browser capture Aug 2, 2026)**
```
POST /youtubei/v1/get_panel?prettyPrint=false
{
  context: <WEB context + clickTracking>,
  continuation: <opaque from sendUserQueryCommand>,
  formData: {
    inputComposerFormData: {
      clientMessageId: "youchat-<unix ms>",
      playerOffsetMs: "<decimal ms string>",
      userInputText: "<prompt>"
    }
  }
}
```
`sendUserQueryCommand` path observed:
`engagementPanelSectionListRenderer.footer.chatInputViewModel.sendUserQueryCommand`
→ `innertubeCommand.continuationCommand` with `CONTINUATION_REQUEST_TYPE_GET_PANEL`.

**Chip body**
- Replay exact `chipData.continuation` (do **not** invent from chip label).
- `formData.inputComposerFormData.clientMessageId: youchat-<ms>`.

**Response**
- Singular `onResponseReceivedCommand.listMutationCommand`.
- Inserts under `operations…insertItemSectionContent.contents[].youChatItemViewModel`.
- Visible answer: `youChatItemViewModel.text.content` (+ optional chips / link-ish payloads). Timestamp seek links typically appear as markdown/runs with `watchEndpoint.startTimeSeconds` or `#t=` style destinations when Ask cites moments.

**Gating / driveability**
- Account + video + rollout scoped. Signed-out / guest / brand / mismatched identity → no panel.
- Programmatic drive is possible via InnerTube (Kaset does API, not DOM). Continuations are opaque and must be replayed exactly; synthesizing them fails.
- DOM-only path also works (userscripts below) but is slower/visible.

**Existing scrapers / automation**
- Kaset: full `get_panel` Ask client (Swift) — API path.
- GreasyFork DOM: https://greasyfork.org/en/scripts/559990-youtube-auto-click-gemini-ask-summarize (auto Ask + Summarize chip).
- GreasyFork DOM: https://greasyfork.org/en/scripts/589416-youtube-gemini-popup (opens `PAyouchat`, mirrors messages).
- GreasyFork DOM (Oct 2026): https://greasyfork.org/en/scripts/602107-youtube-auto-summarize-multi-language/code
  - Locale-independent entry point: `button-view-model.you-chat-entrypoint-button`.
  - Confirms the renderer command opens `showEngagementPanelEndpoint.panelIdentifier === "PAyouchat"`.
  - Waits until `ytd-watch-flexy[video-id]` matches the URL after SPA navigation, avoiding stale prior-video controls.
- Separate “Ask YouTube” RAG apps (e.g. zeesshhh0/ask_youtube) use **transcripts + external Gemini**, not YouTube’s watch Ask API.

### 0.1.16 implementation update
- DOM discovery prefers renderer data / `PAyouchat` over the localized English `aria-label="Ask"`; English remains a fallback.
- Experimental API mode no longer replays a persisted successful request body. It accepts only an unambiguous current-video `sendUserQueryCommand`, including its exact opaque token and click tracking, and submits it once.
- Signed-in direct requests generate the standard short-lived `SAPISIDHASH` authorization in MAIN world from the current YouTube session, plus `X-Origin` / account-index headers. Cookie and authorization values are never logged, posted to the local logger, or stored.
- API mode does not follow guessed response continuations or automatically retry. Any missing/ambiguous command or empty response fails closed to a hard-reset DOM Ask attempt.
- `auto` remains DOM-first until the server-commanded path has broader live coverage.
- Live browser validation (Nov 3, 2026): one exact server-command request returned HTTP 200 with pipe-formatted moments on each test video (`ircyBWpLL34`, `M6nefnNpOZA`). The same request without `SAPISIDHASH` returned YouTube’s “Something went wrong” message, confirming authenticated transport—not continuation polling—was the missing piece.

### 0.1.26 implementation update
- Popular title Ask is given the heatmap `LABEL | MM:SS | DURATION` lines and must copy those times. Titles zip onto heatmap windows in listed order; Ask start/end are ignored.

### 0.1.25 implementation update
- Popular intensity blends each heatmap window from max-curvature edges (`valleyBlend` 0 / Aggressive) toward nearest local minima (`valleyBlend` 1 / Weak); Mild is halfway.
- After heatmap windows exist, one Ask/Gemini pass titles those windows only. Ask timestamps are used only to match titles onto existing starts; heatmap start/end always win. Ask failure keeps `Most replayed (score)`.

### 0.1.20 implementation update
- Facts/Funny use one Ask prompt (no second characterization turn). The model infers video type, treats intensity as a preference, includes joke setup, limits Facts to the claim at Aggressive and adds context at Mild/Weak, snaps compilation edges near clip transitions, and includes more sections when unsure.
- Ask results are no longer passed through `filterMomentsByIntensity`, so returned durations are what play.

### 0.1.17 implementation update
- Popular no longer falls through to Ask/Gemini when heatmap JSON is missing.
- Heatmap extraction tries `HEATSEEKER` / framework marker lists, then polls `path.ytp-modern-heat-map` and clusters local maxima using intensity params.
- Stale Popular caches from Ask-as-popular builds are skipped; intensity duration filtering is not applied to heatmap peaks.

---

## 2) SponsorBlock — API + skip mechanism

### Clone
`/workspace/yt-tldw/SponsorBlock` — license **GPL-3.0** (`LICENSE`).  
Implication: copying/deriving from SB source into a distributed extension typically requires the whole work under GPL-3. Prefer **reimplementing** the skip idea from docs/behavior (API is public; skip pattern is mechanical) rather than vendoring SB code. Interoperating via SB’s public API is fine without adopting GPL.

### Segment fetch (privacy hash)
Docs: https://wiki.sponsor.ajay.app/w/API_Docs · K-anonymity: https://github.com/ajayyy/SponsorBlock/wiki/K-Anonymity

```
SHA-256(videoID) → take first 4–5 hex chars (SB extension uses 5 in segmentData.ts; wiki recommends 4)
GET https://sponsor.ajay.app/api/skipSegments/{hashPrefix}
  ?categories=["sponsor",...]
  &actionTypes=["skip","mute","chapter","full","poi"]
```
Client filters returned array for matching `videoID`. Response segments: `{ segment:[start,end], UUID, category, actionType, votes, locked, … }`.

Implementation: `src/utils/segmentData.ts` → `getHash(videoID,1).slice(0,5)` then `/api/skipSegments/` + filter.

### Categories useful for “essential parts”
From `config.json.example`:
- **`poi_highlight`** — Point of Interest; `actionType: "poi"` (start≈end). Crowdsourced “the highlight”. Default in SB is manual jump, not auto-skip. Strong candidate for a single “jump to best moment.”
- **`filler`** — Tangents/jokes; skippable. Useful as **negative** signal (cut filler to keep essentials).
- Also: `sponsor`, `selfpromo`, `intro`, `outro`, `preview`, `hook`, `chapter`, …

### Clean skip mechanism (src/content.ts + maze-utils)
1. Fetch segments on video ID change; keep sorted `sponsorTimes`.
2. **`startSponsorSchedule`**: cancel prior timers; **bail if `getIsAdPlaying()`** (no skip during YT ads); compute next skip window via `getNextSkipIndex`.
3. If far away: `setTimeout` (with ~150ms Chromium / ~600ms Firefox early offset). Near skip: tight `setInterval` for precision; Chromium mute-unmute micro-hack for accuracy.
4. **`skipToTime`**: for `Skip`/`Poi`/`Chapter`, call **`setCurrentTime(skipTime[1])`** → `video.currentTime = time + adDuration` (`maze-utils/src/video.ts`).
5. Re-schedule after seek/play/playing/ratechange/seeking; detect manual seeks via time jumps >0.3s.
6. Mute action type mutes instead of seeking; notices/UI optional.

Listeners wired on: `play`, `playing`, `seeking`, `pause`, `waiting`, `ratechange`, `loadstart`, etc.

---

## 3) Fallback signals (no Ask)

### Most replayed heatmap
Historically in watch HTML / `ytInitialData` (also sometimes `frameworkUpdates…macroMarkersListEntity`):
`playerOverlays…multiMarkersPlayerBarRenderer.markersMap[]` where `key === "HEATSEEKER"` →
`heatmap.heatmapRenderer.heatMarkers[].heatMarkerRenderer`:
`{ timeRangeStartMillis, markerDurationMillis, heatMarkerIntensityScoreNormalized }`.

**2025–2026 note:** many watch pages no longer embed `HEATSEEKER` / `heatMarkerRenderer` in `ytInitialData` even when the scrub-bar graph is visible. The player still draws `path.ytp-modern-heat-map` inside `svg.ytp-heat-map-svg` (`viewBox="0 0 1000 100"`). Intensity ≈ `(100 - y) / 100`, time ≈ `(x / 1000) * duration`. Extension 0.1.17 reads JSON first, then waits briefly for that SVG path and clusters local maxima. Genre Popular times are heatmap-only. After windows exist, one Ask/Gemini pass titles them without changing start/end. Coverage is all-or-nothing per video when YouTube has not generated a graph.

Refs: https://gist.github.com/Benjins/17115a077c9cb33092387602866f232b · yt-dlp#3888 · npm `youtube-heatmap`

### Chapters
From same `next` / `ytInitialData` markersMap `chapters[].chapterRenderer` (`timeRangeStartMillis`, title) or engagement-panel `macroMarkersListItemRenderer`. Guest-OK. Good coarse structure.

### Transcript
- Legacy: `POST /youtubei/v1/get_transcript` with server-issued `params` from `getTranscriptEndpoint` in `next` (often fragile / 400).
- Modern UI panel: `get_panel` with `panelId: "PAmodern_transcript_view"` + short protobuf params (YaleDevUni/yt-sub-mcp). Timed lines → heuristic “key sentence” clustering.
- Timedtext / player captions tracks as alternate.

---

## 4) Ranked options for Ask-derived key-moment timestamps

Goal: reliable, fast, unobtrusive timestamps on watch load. Ranked **most → least viable** for an MV3 extension.

### Option A — Direct InnerTube `get_panel` from MAIN-world script (best Ask path)
**How:** Content script injects MAIN-world helper. On watch load: read `ytcfg` / existing `ytInitialData` or fire `next` with page context; parse `PAyouchat` bootstrap; prefer server chip matching summarize / “key moments” / timestamps; else use validated `sendUserQueryCommand` with a fixed prompt (“List the essential moments with timestamps”). `fetch('/youtubei/v1/get_panel', {credentials:'include', …})`. Parse `youChatItemViewModel` for `startTimeSeconds` / `#t=` / `MM:SS` links.

**Pros:** No visible Ask UI; same auth as page; matches proven Kaset model; one–two round trips after bootstrap.  
**Cons:** Opaque continuations mandatory; schema churn; Ask absent on many videos/accounts/regions; ToS/undocumented API risk; free-text prompt may not always return clean timestamps.  
**Speed:** ~0.5–3s after `next` ready (LLM latency dominates).  
**Robustness:** Medium–high when eligible; hard-fail when not → need fallbacks.

### Option B — MAIN-world `next` chip replay only (no free text)
**How:** Same as A but only click-equivalent of server-issued chips (e.g. Summarize). Never invent free-text fields.

**Pros:** Narrower, safer request surface; chips always valid when present.  
**Cons:** Chip set uncontrolled (may not ask for timestamps); summarize text may lack seeks; still gated.  
**Speed:** Similar to A, often faster (no composer path).  
**Robustness:** Higher than free-text when chips exist; lower coverage of “essential timestamps” semantics.

### Option C — Hidden DOM automation of Ask panel
**How:** CSS-hide `#panels`/`PAyouchat` or offscreen; programmatically `click()` Ask → Summarize chip or fill textarea + Send (as GreasyFork scripts); MutationObserver on `yt-item-section-renderer[data-target-id="youchat_messages_section"]`; scrape timestamp anchors.

**Pros:** Uses official frontend path; less need to reverse continuations; already demonstrated.  
**Cons:** UI flash / layout jank if hide imperfect; slower (render + animations); brittle selectors/shadow DOM; may steal focus; SPA navigation races; still gated by Ask availability.  
**Speed:** ~2–8s typical.  
**Robustness:** Medium; breaks on UI redesigns.

### Option D — Intercept `fetch`/`XHR` for `get_panel` (+ optional light trigger)
**How:** Hook MAIN-world `fetch` early; when URL contains `get_panel` and body/panel relates to YouChat, parse JSON responses into timestamp list. Optionally combine with A/C to trigger.

**Pros:** Exact live response shapes; good for discovery/telemetry; works if user opens Ask themselves.  
**Cons:** Alone does nothing until a request fires; hooking is fragile with YouTube’s own wrappers; MV3 isolated worlds need careful injection.  
**Speed:** Passive = 0 until trigger; then same as A/C.  
**Robustness:** Good as a complement, weak as sole strategy.

### Option E — Hybrid Ask-first + instant local fallbacks (recommended product architecture)
**How:** Parallel on load: (1) parse heatmap + chapters from `ytInitialData`; (2) SB `skipSegments` for `sponsor` (always skip) + `poi_highlight` + optional `filler`; (3) kick Option A/B Ask. Play using heatmap/poi immediately; refine playlist when Ask returns.

**Pros:** Unobtrusive start; works when Ask missing; sponsor skip always available; best UX reliability.  
**Cons:** More logic; Ask vs heatmap semantics can disagree; still GPL caution if copying SB code.  
**Speed:** Heatmap/SB ~50–300ms; Ask adds seconds later.  
**Robustness:** Highest overall.

### Option F — No Ask: heatmap + chapters + SB poi/filler only
**How:** Skip Ask entirely for v1 timestamps.

**Pros:** Fastest, no account/region gate, no undocumented AI API.  
**Cons:** Does not satisfy “extract from Ask/Gemini” requirement; heatmap needs popularity; poi_highlight sparse.  
**Speed:** Sub-second.  
**Robustness:** High where data exists; different “essential” definition.

---

## Suggested next test order (when implementing)
1. MAIN-world probe: presence of Ask button / `PAyouchat` in `ytInitialData`/`next` on real account.  
2. Capture one Summarize `get_panel` request/response in DevTools; confirm timestamp link shape.  
3. Implement Option A + sponsor SB fetch; hide panel if any DOM needed.  
4. Wire Option E fallbacks.  
5. Treat Option C as backup if continuation parsing fails closed.

## Sources (key)
- Kaset Ask docs/ADR/api-discovery (links above)
- YouTube Help Ask: https://support.google.com/youtube/answer/14110396
- GreasyFork Ask automations (links above)
- SponsorBlock repo + wiki API / K-Anonymity / categories
- Heatmap gists / yt-dlp#3888 / Trickster Dev heatmap post
- yt-sub-mcp `get_panel` transcript panel notes
