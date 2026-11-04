# YT-TLDW

Chrome Manifest V3 extension that plays only essential YouTube moments
(Ask/Gemini for Facts/Funny; most-replayed scrub-bar heatmap for Popular)
and always skips SponsorBlock `sponsor` / `selfpromo` / `interaction` segments.

**License: GPL-3.0** — see `LICENSE` and `ATTRIBUTION.md`.

## Layout

- `extension/` — unpacked MV3 extension (load this folder in Chrome)
- `logserver.js` / `logserver.ps1` — local debug log ingest (`127.0.0.1:47321`)
- `icon-options/` — icon SVG candidates and PNG previews
- `RESEARCH.md` — design notes and prior art

## Load unpacked

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Pin the toolbar icon. Badge shows `ON` / `OFF`; click the icon to open the popup.
5. After updates, click **Reload** on the extension card.

## Playback controls

- **Toolbar left-click** opens a popup: On/Off, Genre (Facts / Funny / Popular), Intensity (Aggressive / Mild / Weak).
- **Toolbar right-click** context menu: On/Off checkbox plus Genre/Intensity radios (kept in sync).
- **In-player controls** (when ON): previous segment ◀, center auto-jump toggle, next segment ▶. Extension On/Off stays in the popup/toolbar badge.
- On/Off and Debug log apply instantly. Popup Genre/Intensity are staged until **Apply**; Options also stages Method. Context-menu choices apply immediately. **Apply** always refreshes sections (even with unchanged settings) and jumps to the first section when ready.
- Defaults: Genre=Facts, Intensity=Mild. Applying genre/intensity re-runs extraction and uses a cache key that includes both.
- Facts/Funny send one Ask prompt. It tells the model to infer the video type, treat intensity as a preference (Facts: claim-only when Aggressive, more context when Mild/Weak; Funny always includes setup), snap compilation edges to clip transitions, and include more sections when unsure. Playback uses those durations as returned.

## Options / debug

- Right-click extension icon → **Options**
- Key-moment method: `auto` (DOM-first) | `api` (experimental current server-command submission) | `dom`
- API mode resolves the current panel’s exact `sendUserQueryCommand`, authenticates in-page with the current YouTube session, uses the command once with fresh message/offset fields, and falls back to DOM on failure. Credentials are never stored or logged; stored continuation replay and automatic API retries are not used.
- Debug log (default on): on-page panel, DevTools filter `YT-TLDW`, and local log server output.

## Local log server

```bash
node logserver.js
# or on Windows: .\logserver.ps1
```

Writes under a `logs/` directory next to the script. Do not commit logs.

## Notes

- Ask/Gemini needs a signed-in eligible account and an eligible video.
- Logged-out Ask fails closed and falls back to heatmap/chapters/SB (Facts/Funny).
- **Popular** times come only from YouTube’s most-replayed graph (`HEATSEEKER` JSON when present, else the player `ytp-modern-heat-map` SVG). Videos without a graph show an explicit empty state. Intensity picks which peaks qualify and blends each section’s length: Aggressive = max-curvature edges, Weak = nearest local minima, Mild = halfway. After those windows exist, one Ask/Gemini pass titles them; Ask cannot invent or re-time Popular sections. If Ask fails, titles stay `Most replayed (score)`.
- **Watch Party** (`#watch-party-panel`): while that panel is open, YT-TLDW does not auto-seek, auto-pause, or sponsor-skip, so party sync keeps the playhead. Prev/next and moment clicks still seek. The moments list sits under the party panel; the debug log and overlay move to the left so they do not cover the party drawer.
- Portions adapted from SponsorBlock (GPL-3.0); see `ATTRIBUTION.md`.
  The full SponsorBlock source tree is **not** vendored in this repo.
