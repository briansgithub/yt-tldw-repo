# YT-TLDW

Chrome Manifest V3 extension that plays only essential YouTube moments
(Ask/Gemini + heatmap/chapters fallbacks) and always skips SponsorBlock
`sponsor` / `selfpromo` / `interaction` segments.

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
- **In-player button** still toggles On/Off. Badge shows ON/OFF.
- On/Off and Debug log apply instantly. Popup Genre/Intensity are staged until **Apply**; Options also stages Method. Context-menu choices apply immediately.
- Defaults: Genre=Facts, Intensity=Mild. Applying genre/intensity re-runs extraction and uses a cache key that includes both.

## Options / debug

- Right-click extension icon → **Options**
- Key-moment method: `auto` (DOM-first) | `api` (experimental captured-template replay) | `dom`
- API replay is retained for experiments but often receives an empty YouTube acknowledgement; `auto` does not use it.
- Debug log (default on): on-page panel, DevTools filter `YT-TLDW`, and local log server output.

## Local log server

```bash
node logserver.js
# or on Windows: .\logserver.ps1
```

Writes under a `logs/` directory next to the script. Do not commit logs.

## Notes

- Ask/Gemini needs a signed-in eligible account and an eligible video.
- Logged-out Ask fails closed and falls back to heatmap/chapters/SB.
- Portions adapted from SponsorBlock (GPL-3.0); see `ATTRIBUTION.md`.
  The full SponsorBlock source tree is **not** vendored in this repo.
