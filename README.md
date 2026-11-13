# YT-TLDW

Chrome and Firefox extension that plays only essential YouTube moments
(Ask/Gemini for Facts/Funny; most-replayed scrub-bar heatmap for Popular)
and always skips SponsorBlock `sponsor` / `selfpromo` / `interaction` segments.

**License: GPL-3.0** — see `LICENSE` and `ATTRIBUTION.md`.

## Layout

- `extension/` — unpacked Manifest V3 extension for Chrome (load this folder)
- `extension-firefox/` — Firefox (desktop and Android) port, including the playback queue
- `sync/server.js` — optional private queue sync service for Windows (Node.js + SQLite)
- `logserver.js` / `logserver.ps1` — local debug log ingest (`127.0.0.1:47321`)
- `icon-options/` — icon SVG candidates and PNG previews
- `RESEARCH.md` — design notes and prior art

## Load unpacked (Chrome)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Pin the toolbar icon. Badge shows `ON` / `OFF`; click the icon to open the popup.
5. After updates, click **Reload** on the extension card.

## Firefox (desktop and Android)

Load `extension-firefox/` as a temporary add-on in Firefox, or package it with `web-ext`:

```bash
npx --yes web-ext@10.8.0 lint --source-dir extension-firefox --warnings-as-errors
npx --yes web-ext@10.8.0 build --source-dir extension-firefox --artifacts-dir dist/artifacts --overwrite-dest
```

For a private installation on regular Firefox, submit the ZIP under
[Add-on Developer Hub](https://addons.mozilla.org/developers/addon/submit/self-distribution)
(self-distributed, not AMO-listed) and install the signed XPI. On Firefox for Android,
open **Settings → About Firefox**, tap the Firefox logo five times, then open
**Settings → Install Extension from File**.

For development on an attached Android device, use
`npx --yes web-ext@10.8.0 run --source-dir extension-firefox --target firefox-android --firefox-apk org.mozilla.firefox`
with Android Debug Bridge and Firefox remote debugging enabled.

## Playback controls

- **Toolbar left-click** opens a popup: On/Off, Genre (Facts / Funny / Popular), Intensity (Aggressive / Mild / Weak).
- **Toolbar right-click** context menu: On/Off checkbox plus Genre/Intensity radios (kept in sync).
- **In-player controls** (when ON): previous segment ◀, center auto-jump toggle, next segment ▶. Extension On/Off stays in the popup/toolbar badge.
- On/Off and Debug log apply instantly. Popup Genre/Intensity are staged until **Apply**; Options also stages Method. Context-menu choices apply immediately. **Apply** always refreshes sections (even with unchanged settings) and jumps to the first section when ready.
- Defaults: Genre=Facts, Intensity=Mild. Applying genre/intensity re-runs extraction and uses a cache key that includes both.
- Facts/Funny send one Ask prompt. It tells the model to infer the video type, treat intensity as a preference (Facts: claim-only when Aggressive, more context when Mild/Weak; Funny always includes setup), snap compilation edges to clip transitions, and include more sections when unsure. Playback uses those durations as returned.

## Queue (Firefox)

- Use **Add to queue** on a regular watch page or a video card in Home and Search. Open **Queue** on the watch page or **Queue and private sync** in the toolbar menu.
- Starting a video from the queue uses highlight playback. **Autoplay next** is available from the queue. After a video ends you can **Watch full video** or **Play next**. Watching an item leaves it in the queue.

## Private sync on Windows

The Firefox port can share the queue across devices through a private sync service.

1. Install Node.js 24 or later. From the repo run `node sync/server.js --init`
   once to create an access key under `%LOCALAPPDATA%\YT-TLDW\sync`. Then run
   `node sync/server.js`. The service listens on `127.0.0.1:47322`.
2. Expose that port over your tailnet or another private HTTPS path you control.
3. In **Queue and private sync → Private sync settings**, enter the HTTPS
   URL and the access key on each device. On Firefox, choose **Allow queue sync data**
   before the first sync. The queue still works locally while the PC is asleep or offline.
4. To start the service at login, add a Task Scheduler task for the
   Windows account that owns the sync data. Use an **At log on** trigger,
   `node` as the program, `sync/server.js` as the argument, and the repo as **Start in**.

For backup, stop the service and copy the sync data folder to a private
location. To rotate the access key, stop the service, run
`node sync/server.js --rotate-key`, restart it, and pair both devices again.

Portions adapted from SponsorBlock (GPL-3.0); Firefox discloses the SponsorBlock
transfer as browsing activity at installation. Private queue sync has its own opt-in.

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

## Tests

```bash
node --test tests/unit-0.1.13.js tests/queue-sync.js
```

A Chrome queue playback fixture is preserved on the `archive/pixel-queue-sync` branch, which records the earlier unified Chrome+queue tree.

## Notes

- Ask/Gemini needs a signed-in eligible account and an eligible video.
- Logged-out Ask fails closed and falls back to heatmap/chapters/SB (Facts/Funny).
- **Popular** times come only from YouTube’s most-replayed graph (`HEATSEEKER` JSON when present, else the player `ytp-modern-heat-map` SVG). Videos without a graph show an explicit empty state. Intensity picks which peaks qualify and blends each section’s length: Aggressive = max-curvature edges, Weak = nearest local minima, Mild = halfway. After those windows exist, one Ask/Gemini pass titles them; Ask cannot invent or re-time Popular sections. If Ask fails, titles stay `Most replayed (score)`.
- **Watch Party** (`#watch-party-panel`): while that panel is open, YT-TLDW does not auto-seek, auto-pause, or sponsor-skip, so party sync keeps the playhead. Prev/next and moment clicks still seek. The moments list sits under the party panel; the debug log and overlay move to the left so they do not cover the party drawer.
- Portions adapted from SponsorBlock (GPL-3.0); see `ATTRIBUTION.md`.
  The full SponsorBlock source tree is **not** vendored in this repo.
