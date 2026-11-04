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
4. Pin the toolbar icon. Badge shows `ON` / `OFF`. Click to toggle.
5. After updates, click **Reload** on the extension card.

## Options / debug

- Right-click extension icon → **Options**
- Key-moment method: `auto` | `api` | `dom`
- Optional on-page debug panel; console filter: `YT-TLDW`

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
