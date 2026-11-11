# YT-TLDW (prototype)

Chrome Manifest V3 extension: when toggled **ON**, tries to play only essential
parts of a YouTube video (Ask/Gemini key moments, with heatmap/chapters/SB
`poi_highlight` fallbacks) and **always skips** SponsorBlock `sponsor`,
`selfpromo`, and `interaction` segments.

**License: GPL-3.0** (see `LICENSE`, `ATTRIBUTION.md`).

## Load unpacked

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this `extension` folder
4. Pin the toolbar icon. Badge shows `ON` / `OFF`. Click icon to toggle.

Note: recent Chrome builds ignore `--load-extension` CLI flags; use Load unpacked in the UI (or Edge, which still accepts the flag for automation).

## Options / debug

- Right-click extension icon → **Options**, or open the Options link on `chrome://extensions`
- **Key-moment method**: `auto` | `api` | `dom`
- Enable **on-page debug panel** (bottom-right on watch pages when ON)
- DevTools console filter: `YT-TLDW`

Debug events include `method-result` (latencyMs, count, error), `ready` (usedMethod, segments), and skip jumps.

## Notes

- Ask/Gemini requires a signed-in eligible account and an eligible video.
- Logged-out, API/DOM Ask will fail closed and fall back to heatmap/chapters/SB.
