# YT-TLDW

YT-TLDW plays essential YouTube moments and skips SponsorBlock segments on
Windows Chrome and Firefox for Android. It regenerates highlights when you
open a video with highlight playback enabled. The optional private sync
service shares the queue between devices.

**License: GPL-3.0** — see `LICENSE` and `ATTRIBUTION.md`.

## Layout

- `extension/` — shared extension source (load this folder in Chrome)
- `sync/server.js` — private queue service for Windows, using Node.js and SQLite
- `scripts/package-firefox.js` — prepare the Firefox build in `dist/firefox/`
- `logserver.js` / `logserver.ps1` — local debug log ingest (`127.0.0.1:47321`)
- `icon-options/` — icon SVG candidates and PNG previews
- `RESEARCH.md` — design notes and prior art

## Load unpacked

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Pin the toolbar icon and use its popup to turn highlight playback on or off.
5. For an existing unpacked installation, update the files at the same path and
   click **Reload** on its extension card. Keeping the path preserves the
   extension ID and the browser’s existing extension storage.

## Playback controls

- **Toolbar left-click** opens a popup: On/Off, Genre (Facts / Funny / Popular), Intensity (Aggressive / Mild / Weak).
- **Toolbar right-click** context menu: On/Off checkbox plus Genre/Intensity radios (kept in sync).
- **In-player controls** jump to the previous or next range and toggle auto-jump
  during ordinary browsing. Click any timestamp in the moments panel to seek.
- Genre defaults to Facts and Intensity defaults to Mild. Use **Apply** to
  regenerate the current video’s highlights.
- Use **Add to queue** on a regular watch page or a video card in Home and
  Search. Open **Queue** on the watch page or **Queue and private sync** in the
  extension popup to play, reorder or remove videos.
- Starting a video from the queue uses highlight playback. **Autoplay next** is
  off by default and applies only to the current device. Turn it on to advance
  after the last highlight. If a video has no playable highlights, choose
  **Watch full video** or **Play next**. Watching an item leaves it in the queue.

## Firefox on the Pixel

```powershell
node scripts/package-firefox.js
npx --yes web-ext@10.8.0 lint --source-dir dist/firefox --warnings-as-errors
npx --yes web-ext@10.8.0 build --source-dir dist/firefox --artifacts-dir dist/artifacts --overwrite-dest
```

For a private installation on regular Firefox, submit the ZIP under
`dist/artifacts/` to Mozilla Add-ons for unlisted signing, then transfer the
signed XPI to the Pixel. On the Pixel, open **Settings → About Firefox**, tap
the Firefox logo five times, then open **Settings → Install Extension from
File** and choose the signed XPI. Use the same add-on ID for future signed
versions. The unsigned ZIP is a build input for Mozilla. [Mozilla’s installation guide](https://extensionworkshop.com/documentation/publish/install-self-distributed/)

For development on an attached Android device, use
`npx --yes web-ext@10.8.0 run --source-dir dist/firefox --target firefox-android --firefox-apk org.mozilla.firefox`
with Android Debug Bridge and Firefox remote debugging enabled.

## Private sync on Windows

1. Install Node.js 24 or later. From the repo run `node sync/server.js --init`
   once to create an access key under `%LOCALAPPDATA%\YT-TLDW\sync`. Then run
   `node sync/server.js`. The service listens on `127.0.0.1:47322`.
2. Sign in to Tailscale on both devices using the same tailnet. In an
   Administrator terminal on Windows, run `tailscale serve --bg 47322` and
   use the HTTPS address it prints. Follow the Tailscale prompt to enable
   HTTPS if needed. Use Serve so the endpoint stays within your tailnet.
   [Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
3. In **Queue and private sync → Private sync settings**, enter the HTTPS
   address and copy the contents of `access.key` into the **Access key**
   field on each device. On Firefox, choose **Allow queue sync data** before
   **Connect**. Approve access to your server when the browser prompts.
   The queue still works locally while the PC is asleep or offline.
4. For automatic startup, create a Windows Task Scheduler task under the
   Windows account that owns the sync data. Use an **At log on** trigger,
   the absolute path to `node.exe` as the program, the quoted absolute path to
   `sync/server.js` as the argument, and the repo as **Start in**. For service
   after sign-out, use an **At startup** trigger with that same account, enable
   **Run whether user is logged on or not**, and enable Tailscale’s
   **Run unattended** option. [Tailscale’s unattended setup](https://tailscale.com/docs/how-to/run-unattended)

For backup, stop the service and copy the sync data folder to a private
location, including any SQLite sidecar files. To rotate the key, stop the
service, run `node sync/server.js --rotate-key`, restart it, and pair both
devices again using the new key. Keep `access.key` out of source control and
logs. No YouTube sign-in, highlight timestamps, or watch progress is sent to
the sync server.

Sponsor skipping sends a four-character hash prefix of the current video ID
to SponsorBlock. Firefox discloses this transfer as browsing activity at
installation. Private queue sync has its own opt-in.

## Checks

```powershell
node tests/unit-0.1.13.js
node --test tests/queue-sync.js
node scripts/package-firefox.js
npx --yes web-ext@10.8.0 lint --source-dir dist/firefox --warnings-as-errors
```

`node tests/chrome-queue.js` runs the playback and queue fixture in a
separate Google Chrome profile. It requires `puppeteer-core` available to
Node and uses `YT_TLDW_CHROME` if Chrome is installed outside its usual path.

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
