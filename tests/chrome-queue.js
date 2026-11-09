/* Run with puppeteer-core available and YT_TLDW_CHROME pointing to Chrome if needed. */
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const first = "ircyBWpLL34";
const second = "M6nefnNpOZA";
const third = "abcdefghijk";
const youtube = "https://www.youtube.com";
const mobile = "https://m.youtube.com";
const watch = (id, origin = youtube) => `${origin}/watch?v=${id}`;

function fixture(url, visits) {
  if (url.pathname !== "/watch") {
    return `<ytd-rich-item-renderer><a href="/watch?v=${first}">First video</a></ytd-rich-item-renderer>
      <ytd-video-renderer><a href="/watch?v=${second}">Second video</a></ytd-video-renderer>
      <ytd-video-renderer><a href="/watch?v=${third}">No highlights</a></ytd-video-renderer>`;
  }
  const id = url.searchParams.get("v");
  const chapters = id === third ? [] : [{ chapterRenderer: {
    timeRangeStartMillis: visits === 1 ? 10000 : 12000, title: { simpleText: 'One "chapter" <b>title</b>' },
  } }];
  const layout = url.origin === mobile
    ? "<ytm-watch><div id='watch-below-the-player'></div></ytm-watch>"
    : "<ytd-watch-flexy><div id='below'><div id='secondary'></div></div></ytd-watch-flexy>";
  return `<!doctype html><title>Watch ${id}</title>${layout}
    <div id="movie_player"><video class="html5-main-video"></video>
    <div class="ytp-right-controls"></div></div>
    <script>
      window.ytInitialData = ${JSON.stringify(chapters)};
    </script>`;
}

function mockMedia(video, blocked) {
  video.dataset.blockPlay = String(blocked);
  video.dataset.paused = "true";
  video.dataset.playhead = "0";
  Object.defineProperties(video, {
    duration: { get: () => 100 },
    currentTime: {
      get: () => Number(video.dataset.playhead),
      set: (value) => { video.dataset.playhead = value; },
    },
    paused: { get: () => video.dataset.paused === "true" },
  });
  video.play = () => {
    if (video.dataset.blockPlay === "true") return Promise.reject(new DOMException("Blocked", "NotAllowedError"));
    video.dataset.paused = "false";
    video.dispatchEvent(new Event("play"));
    return Promise.resolve();
  };
  video.pause = () => { video.dataset.paused = "true"; };
}

async function run() {
  const browser = await puppeteer.launch({
    executablePath: process.env.YT_TLDW_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    pipe: true, enableExtensions: true, headless: true,
  });
  try {
    const id = await browser.installExtension(path.join(__dirname, "..", "extension"));
    const target = await browser.waitForTarget((item) => item.url() === `chrome-extension://${id}/background.js`);
    const worker = await target.worker();
    await worker.evaluate(async (videoId) => {
      const fetchOriginal = globalThis.fetch;
      globalThis.fetch = (url, opts) => {
        if (String(url).startsWith("http://127.0.0.1:47321/")) return Promise.resolve(new Response());
        if (!String(url).startsWith("https://sponsor.ajay.app/")) return fetchOriginal(url, opts);
        return Promise.resolve(new Response(JSON.stringify([{ videoID: videoId, segments: [
          { segment: [15, 20], category: "sponsor", actionType: "skip" },
        ] }]), { status: 200 }));
      };
      await chrome.storage.local.set({ enabled: true, debug: true });
    }, first);
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    let isolatedContext;
    cdp.on("Runtime.executionContextCreated", ({ context }) => {
      if (context.origin === `chrome-extension://${id}`) isolatedContext = context.id;
    });
    cdp.on("Runtime.executionContextsCleared", () => { isolatedContext = null; });
    await cdp.send("Runtime.enable");
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      errors.push(exceptionDetails.exception?.description || exceptionDetails.text);
    });
    await page.setRequestInterception(true);
    const visits = new Map();
    page.on("request", (req) => {
      const url = new URL(req.url());
      if ([youtube, mobile].includes(url.origin) && req.isNavigationRequest()) {
        const count = (visits.get(req.url()) || 0) + 1;
        visits.set(req.url(), count);
        return req.respond({ contentType: "text/html", body: fixture(url, count) });
      }
      return req.abort();
    });
    page.setDefaultTimeout(25000);
    async function prepareMedia() {
      await page.waitForSelector(".yt-tldw-queue-watch");
      assert.ok(isolatedContext, "Chrome extension isolated world exists");
      const { exceptionDetails } = await cdp.send("Runtime.evaluate", {
        contextId: isolatedContext,
        expression: `(${mockMedia})(document.querySelector("video"), ${page.url() === watch(second)})`,
      });
      assert.equal(exceptionDetails, undefined);
    }
    await page.goto(youtube);
    await page.waitForFunction(() => document.querySelectorAll(".yt-tldw-queue-card").length === 3);
    for (const control of await page.$$(".yt-tldw-queue-card")) {
      await control.click();
      await page.waitForFunction((button) => button.textContent === "Added", {}, control);
    }
    await page.goto(watch(first));
    await prepareMedia();
    async function waitForMoment(start) {
      try {
        await page.waitForFunction((value) =>
          document.querySelector("button.yt-tldw-row")?.dataset.start === value, {}, start);
      } catch (error) {
        const detail = await page.evaluate(() => ({
          debug: document.querySelector("#yt-tldw-debug pre")?.textContent,
          moments: document.querySelector("#yt-tldw-moments")?.textContent,
          player: Boolean(document.getElementById("yt-tldw-player-controls")),
          chapterData: window.ytInitialData,
        }));
        const settings = await worker.evaluate(() => chrome.storage.local.get(["debug", "enabled"]));
        throw new Error(`Missing expected highlight ${start}. ${JSON.stringify({ detail, settings, errors })}`, { cause: error });
      }
    }
    await waitForMoment("10");
    assert.equal(await page.$eval("button.yt-tldw-row", (el) => el.querySelector("b")), null);
    await page.click('button.yt-tldw-row[data-start="20"]');
    assert.ok(await page.$eval("video", (el) => Number(el.dataset.playhead) >= 20));
    await page.evaluate(() => {
      const video = document.querySelector("video");
      video.dataset.playhead = 16;
      video.dispatchEvent(new Event("seeked"));
    });
    await page.waitForFunction(() => Number(document.querySelector("video").dataset.playhead) > 20);
    await page.reload();
    await prepareMedia();
    await waitForMoment("12");

    await page.evaluate((id) => {
      history.pushState(null, "", "/results");
      document.body.append(document.createElement("div"));
      setTimeout(() => {
        window.ytInitialData = [{ chapterRenderer: { timeRangeStartMillis: 11000 } }];
        history.pushState(null, "", "/watch?v=" + id);
        document.body.append(document.createElement("div"));
      }, 150);
    }, first);
    await waitForMoment("11");
    await page.click('.yt-tldw-queue-watch button:nth-child(2)');
    await page.waitForSelector('.yt-tldw-queue ol li button', { visible: true });
    const openFirst = () => page.click('.yt-tldw-queue ol li:first-child button');
    await Promise.all([page.waitForNavigation(), openFirst()]);
    await prepareMedia();
    await waitForMoment("12");
    const finish = () => page.evaluate(() => {
      const video = document.querySelector("video");
      video.dataset.playhead = 80;
      video.dispatchEvent(new Event("seeked"));
    });
    await finish();
    await page.waitForFunction(() => document.querySelector(".yt-tldw-queue-watch [role=status]").textContent === "Highlights finished.");
    assert.equal(new URL(page.url()).searchParams.get("v"), first);

    await worker.evaluate(() => chrome.storage.local.set({ queueAutoplay: true }));
    await page.click('.yt-tldw-queue-watch button:nth-child(2)');
    await page.waitForSelector('.yt-tldw-queue ol li button', { visible: true });
    await Promise.all([page.waitForNavigation(), openFirst()]);
    await prepareMedia();
    await waitForMoment("12");
    await Promise.all([page.waitForNavigation(), finish()]);
    await prepareMedia();
    assert.equal(new URL(page.url()).searchParams.get("v"), second);
    await page.waitForFunction(() => document.querySelector(".yt-tldw-queue-watch [role=status]").textContent === "Tap to start playback.");
    await page.$eval("video", (el) => { el.dataset.blockPlay = "false"; });
    await page.click(".yt-tldw-queue-watch > button:nth-of-type(3)");
    await page.waitForFunction(() => document.querySelector("video").dataset.paused === "false");
    await Promise.all([page.waitForNavigation(), finish()]);
    await prepareMedia();
    assert.equal(new URL(page.url()).searchParams.get("v"), third);
    await page.waitForFunction(() => document.querySelector(".yt-tldw-queue-watch [role=status]").textContent.includes("No playable highlights"));
    assert.equal(await page.$eval("video", (el) => el.dataset.paused), "true");
    await page.click(".yt-tldw-queue-watch > button:nth-of-type(4)");
    await page.waitForFunction(() => document.querySelector("video").dataset.paused === "false");

    await page.goto(watch(first, mobile));
    await prepareMedia();
    await waitForMoment("10");
    await page.waitForSelector("#watch-below-the-player .yt-tldw-queue-watch");
    assert.deepEqual(errors, []);
    console.log(await browser.version(), "passed queue and highlights playback with desktop and mobile page fixtures.");
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
