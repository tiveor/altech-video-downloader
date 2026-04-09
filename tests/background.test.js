const fs = require("fs");
const path = require("path");
const { createChromeMock } = require("./chrome-mock");

// Load background.js source and extract functions via eval
let chrome;
let tabVideos, knownVariants;
let classifyUrl, tsStreamKey, addEntry, updateBadge, ensureTab;
let webRequestHandler, activateWebRequestListener;
let scanPageForVideos;

beforeEach(() => {
  chrome = createChromeMock();
  global.chrome = chrome;
  global.fetch = jest.fn();

  // Eval the background script to get access to its functions
  const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf-8");
  const fn = new Function("chrome", "fetch", src + `
    return {
      classifyUrl, tsStreamKey, addEntry, updateBadge, ensureTab,
      webRequestHandler, activateWebRequestListener,
      scanPageForVideos, tabVideos, knownVariants,
    };
  `);
  const exports = fn(chrome, global.fetch);
  classifyUrl = exports.classifyUrl;
  tsStreamKey = exports.tsStreamKey;
  addEntry = exports.addEntry;
  updateBadge = exports.updateBadge;
  ensureTab = exports.ensureTab;
  webRequestHandler = exports.webRequestHandler;
  activateWebRequestListener = exports.activateWebRequestListener;
  scanPageForVideos = exports.scanPageForVideos;
  tabVideos = exports.tabVideos;
  knownVariants = exports.knownVariants;
});

// ─── classifyUrl ─────────────────────────────────────────────────────────────

describe("classifyUrl", () => {
  test("returns null for empty or blob/data URLs", () => {
    expect(classifyUrl("", "")).toBeNull();
    expect(classifyUrl(null, "")).toBeNull();
    expect(classifyUrl("blob:http://example.com/abc", "")).toBeNull();
    expect(classifyUrl("data:video/mp4;base64,AAA", "")).toBeNull();
  });

  test("detects HLS by .m3u8 extension", () => {
    expect(classifyUrl("https://cdn.example.com/stream.m3u8", "")).toBe("hls");
    expect(classifyUrl("https://cdn.example.com/stream.m3u8?token=abc", "")).toBe("hls");
  });

  test("detects HLS by MIME type", () => {
    expect(classifyUrl("https://cdn.example.com/stream", "application/x-mpegurl")).toBe("hls");
    expect(classifyUrl("https://cdn.example.com/stream", "application/vnd.apple.mpegurl")).toBe("hls");
  });

  test("detects TS segments by pattern", () => {
    expect(classifyUrl("https://cdn.example.com/seg-1.ts", "")).toBe("ts-segment");
    expect(classifyUrl("https://cdn.example.com/manifest-355246-3.ts?foo=bar", "")).toBe("ts-segment");
  });

  test("detects TS segments by MIME type", () => {
    expect(classifyUrl("https://cdn.example.com/segment", "video/mp2t")).toBe("ts-segment");
  });

  test("detects direct video by extension", () => {
    expect(classifyUrl("https://example.com/video.mp4", "")).toBe("direct");
    expect(classifyUrl("https://example.com/video.webm", "")).toBe("direct");
    expect(classifyUrl("https://example.com/video.ogg", "")).toBe("direct");
    expect(classifyUrl("https://example.com/video.avi", "")).toBe("direct");
    expect(classifyUrl("https://example.com/video.mov", "")).toBe("direct");
    expect(classifyUrl("https://example.com/video.mkv", "")).toBe("direct");
    expect(classifyUrl("https://example.com/video.flv", "")).toBe("direct");
    expect(classifyUrl("https://example.com/video.wmv", "")).toBe("direct");
    expect(classifyUrl("https://example.com/video.m4v", "")).toBe("direct");
  });

  test("detects direct video by extension with query string", () => {
    expect(classifyUrl("https://example.com/video.mp4?quality=hd", "")).toBe("direct");
  });

  test("detects direct video by MIME type", () => {
    expect(classifyUrl("https://example.com/stream", "video/mp4")).toBe("direct");
    expect(classifyUrl("https://example.com/stream", "video/webm")).toBe("direct");
    expect(classifyUrl("https://example.com/stream", "video/quicktime")).toBe("direct");
  });

  test("returns null for non-video URLs", () => {
    expect(classifyUrl("https://example.com/page.html", "")).toBeNull();
    expect(classifyUrl("https://example.com/style.css", "text/css")).toBeNull();
    expect(classifyUrl("https://example.com/script.js", "application/javascript")).toBeNull();
    expect(classifyUrl("https://example.com/image.png", "image/png")).toBeNull();
  });

  test("HLS takes priority over direct when MIME type is m3u8", () => {
    expect(classifyUrl("https://example.com/stream.m3u8", "application/x-mpegurl")).toBe("hls");
  });
});

// ─── tsStreamKey ─────────────────────────────────────────────────────────────

describe("tsStreamKey", () => {
  test("extracts stream base from TS segment URL", () => {
    expect(tsStreamKey("https://cdn.example.com/manifest-355246-3.ts"))
      .toBe("https://cdn.example.com/manifest-355246");
  });

  test("strips query parameters before extracting key", () => {
    expect(tsStreamKey("https://cdn.example.com/seg-1.ts?token=abc"))
      .toBe("https://cdn.example.com/seg");
  });

  test("handles single digit segment numbers", () => {
    expect(tsStreamKey("https://cdn.example.com/video-0.ts"))
      .toBe("https://cdn.example.com/video");
  });
});

// ─── Tab management ──────────────────────────────────────────────────────────

describe("ensureTab", () => {
  test("creates tab entry if not exists", () => {
    ensureTab(42);
    expect(tabVideos[42]).toEqual({});
  });

  test("does not overwrite existing tab entry", () => {
    tabVideos[42] = { "key1": { type: "direct" } };
    ensureTab(42);
    expect(tabVideos[42]).toEqual({ "key1": { type: "direct" } });
  });
});

describe("updateBadge", () => {
  test("sets badge text to count when videos exist", () => {
    tabVideos[1] = { a: {}, b: {}, c: {} };
    updateBadge(1);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "3", tabId: 1 });
  });

  test("clears badge when no videos", () => {
    tabVideos[1] = {};
    updateBadge(1);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "", tabId: 1 });
  });

  test("sets badge color to teal", () => {
    tabVideos[1] = { a: {} };
    updateBadge(1);
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#00BCD4", tabId: 1 });
  });
});

// ─── addEntry ────────────────────────────────────────────────────────────────

describe("addEntry", () => {
  test("adds a new entry to tab", () => {
    addEntry(1, { key: "url1", type: "direct", filename: "video.mp4" });
    expect(tabVideos[1]["url1"]).toBeDefined();
    expect(tabVideos[1]["url1"].type).toBe("direct");
  });

  test("does not overwrite existing entry", () => {
    addEntry(1, { key: "url1", type: "direct", filename: "video.mp4" });
    addEntry(1, { key: "url1", type: "direct", filename: "DIFFERENT.mp4" });
    expect(tabVideos[1]["url1"].filename).toBe("video.mp4");
  });

  test("increments segment count for ts-segment entries", () => {
    addEntry(1, { key: "stream1", type: "ts-segment", segmentCount: 1 });
    addEntry(1, { key: "stream1", type: "ts-segment", segmentCount: 1 });
    addEntry(1, { key: "stream1", type: "ts-segment", segmentCount: 1 });
    expect(tabVideos[1]["stream1"].segmentCount).toBe(3); // initial 1 + 2 merges
  });

  test("upgrades ts-segment to HLS when m3u8Url becomes available", () => {
    addEntry(1, { key: "stream1", type: "ts-segment" });
    addEntry(1, { key: "stream1", type: "ts-segment", m3u8Url: "https://cdn.example.com/stream.m3u8" });
    expect(tabVideos[1]["stream1"].type).toBe("hls");
    expect(tabVideos[1]["stream1"].m3u8Url).toBe("https://cdn.example.com/stream.m3u8");
  });

  test("updates badge after adding entry", () => {
    addEntry(1, { key: "url1", type: "direct" });
    expect(chrome.action.setBadgeText).toHaveBeenCalled();
  });
});

// ─── webRequestHandler ───────────────────────────────────────────────────────

describe("webRequestHandler", () => {
  test("ignores requests with tabId < 0", () => {
    webRequestHandler({
      tabId: -1,
      url: "https://example.com/video.mp4",
      responseHeaders: [],
    });
    expect(Object.keys(tabVideos)).toHaveLength(0);
  });

  test("detects direct video from network request", () => {
    webRequestHandler({
      tabId: 1,
      url: "https://example.com/video.mp4",
      responseHeaders: [{ name: "content-type", value: "video/mp4" }],
    });
    expect(Object.keys(tabVideos[1])).toHaveLength(1);
    const entry = Object.values(tabVideos[1])[0];
    expect(entry.type).toBe("direct");
    expect(entry.filename).toBe("video.mp4");
  });

  test("detects HLS stream from .m3u8 URL", () => {
    // Mock fetch for classifyM3u8
    global.fetch = jest.fn(() => Promise.resolve({
      text: () => Promise.resolve("#EXTM3U\n#EXTINF:10,\nseg-0.ts\n"),
    }));

    webRequestHandler({
      tabId: 2,
      url: "https://cdn.example.com/live/stream.m3u8",
      responseHeaders: [{ name: "content-type", value: "application/x-mpegurl" }],
    });
    expect(tabVideos[2]["https://cdn.example.com/live/stream.m3u8"]).toBeDefined();
    expect(tabVideos[2]["https://cdn.example.com/live/stream.m3u8"].type).toBe("hls");
  });

  test("detects TS segments and groups them", () => {
    webRequestHandler({
      tabId: 3,
      url: "https://cdn.example.com/video-0.ts",
      responseHeaders: [{ name: "content-type", value: "video/mp2t" }],
    });
    webRequestHandler({
      tabId: 3,
      url: "https://cdn.example.com/video-1.ts",
      responseHeaders: [{ name: "content-type", value: "video/mp2t" }],
    });
    // Both should map to the same stream key
    const keys = Object.keys(tabVideos[3]);
    expect(keys).toHaveLength(1);
  });

  test("ignores non-video content types", () => {
    webRequestHandler({
      tabId: 1,
      url: "https://example.com/page.html",
      responseHeaders: [{ name: "content-type", value: "text/html" }],
    });
    expect(tabVideos[1]).toBeUndefined();
  });

  test("extracts content-type header case-insensitively", () => {
    webRequestHandler({
      tabId: 1,
      url: "https://example.com/stream",
      responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
    });
    expect(Object.keys(tabVideos[1])).toHaveLength(1);
  });
});

// ─── Message handling ────────────────────────────────────────────────────────

describe("message handling", () => {
  let onMessageCallback;

  beforeEach(() => {
    onMessageCallback = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  });

  test("CHECK_PERMISSION responds with granted status", () => {
    const sendResponse = jest.fn();
    chrome.permissions.contains.mockImplementation((p, cb) => cb(true));

    const result = onMessageCallback({ type: "CHECK_PERMISSION" }, {}, sendResponse);
    expect(result).toBe(true); // async response
    expect(sendResponse).toHaveBeenCalledWith({ granted: true });
  });

  test("PERMISSION_GRANTED activates webRequest listener", () => {
    const sendResponse = jest.fn();
    onMessageCallback({ type: "PERMISSION_GRANTED" }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(chrome.webRequest.onResponseStarted.addListener).toHaveBeenCalled();
  });

  test("ADD_VIDEOS adds videos from content script", () => {
    const sendResponse = jest.fn();
    onMessageCallback(
      {
        type: "ADD_VIDEOS",
        videos: [
          { url: "https://example.com/video.mp4", filename: "video.mp4", contentType: "video/mp4" },
          { url: "https://example.com/stream.m3u8", filename: "stream", contentType: "application/x-mpegurl" },
        ],
      },
      { tab: { id: 5 } },
      sendResponse
    );
    expect(Object.keys(tabVideos[5])).toHaveLength(2);
  });

  test("ADD_VIDEOS ignores blob: URLs", () => {
    const sendResponse = jest.fn();
    onMessageCallback(
      {
        type: "ADD_VIDEOS",
        videos: [{ url: "blob:http://example.com/abc", filename: "blob", contentType: "" }],
      },
      { tab: { id: 5 } },
      sendResponse
    );
    expect(tabVideos[5]).toBeUndefined();
  });

  test("GET_VIDEOS returns video list for active tab", () => {
    tabVideos[1] = {
      "url1": { key: "url1", type: "direct", filename: "a.mp4" },
      "url2": { key: "url2", type: "hls", filename: "b" },
    };
    const sendResponse = jest.fn();
    chrome.tabs.query.mockImplementation((q, cb) => cb([{ id: 1 }]));

    onMessageCallback({ type: "GET_VIDEOS" }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({
      videos: expect.arrayContaining([
        expect.objectContaining({ filename: "a.mp4" }),
        expect.objectContaining({ filename: "b" }),
      ]),
    });
  });

  test("DOWNLOAD triggers chrome.downloads.download", () => {
    const sendResponse = jest.fn();
    onMessageCallback(
      { type: "DOWNLOAD", url: "https://example.com/video.mp4", filename: "video.mp4" },
      {},
      sendResponse
    );
    expect(chrome.downloads.download).toHaveBeenCalledWith(
      { url: "https://example.com/video.mp4", filename: "video.mp4" },
      expect.any(Function)
    );
  });

  test("DOWNLOAD_HLS creates offscreen document", async () => {
    const sendResponse = jest.fn();
    onMessageCallback(
      { type: "DOWNLOAD_HLS", m3u8Url: "https://cdn.example.com/stream.m3u8", filename: "stream", tabId: 1 },
      {},
      sendResponse
    );
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    // Wait for async offscreen creation
    await new Promise((r) => setTimeout(r, 10));
    expect(chrome.offscreen.hasDocument).toHaveBeenCalled();
  });
});

// ─── scanPageForVideos (DOM scanner) ─────────────────────────────────────────

describe("scanPageForVideos", () => {
  test("is a function that can be injected", () => {
    expect(typeof scanPageForVideos).toBe("function");
  });
});

// ─── activateWebRequestListener ──────────────────────────────────────────────

describe("activateWebRequestListener", () => {
  test("registers webRequest listener", () => {
    activateWebRequestListener();
    expect(chrome.webRequest.onResponseStarted.addListener).toHaveBeenCalledWith(
      expect.any(Function),
      { urls: ["<all_urls>"] },
      ["responseHeaders"]
    );
  });

  test("only registers once even if called multiple times", () => {
    activateWebRequestListener();
    activateWebRequestListener();
    activateWebRequestListener();
    // First call is from the permission check at module load, then our 3 calls
    // But the function guards with webRequestListenerActive flag
    const callCount = chrome.webRequest.onResponseStarted.addListener.mock.calls.length;
    expect(callCount).toBeLessThanOrEqual(2); // 1 at most from init + 1 from first call
  });
});
