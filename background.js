// Track detected video entries per tab
// Each entry is keyed by a stable stream key (m3u8 URL or direct video URL)
const tabVideos = {};

// ─── URL classification ───────────────────────────────────────────────────────

const VIDEO_MIME_TYPES = new Set([
  "video/mp4", "video/webm", "video/ogg", "video/x-msvideo",
  "video/quicktime", "video/x-matroska", "video/mpeg",
  "application/x-mpegURL", "application/vnd.apple.mpegurl", "video/MP2T",
]);

const DIRECT_VIDEO_EXT = /\.(mp4|webm|ogg|avi|mov|mkv|flv|wmv|m4v)(\?|$|#)/i;
const HLS_EXT          = /\.m3u8(\?|$|#)/i;
const TS_SEGMENT_EXT   = /\.ts(\?|$|#)/i;

// TS segment pattern: ends with -{digits}.ts (optional query)
const TS_SEGMENT_RE = /-(\d+)\.ts(\?.*)?$/i;

/** Extract the stream base key from a .ts segment URL.
 *  e.g. "…/manifest-…_355246-3.ts?foo" → "…/manifest-…_355246"
 */
function tsStreamKey(url) {
  const u = url.split("?")[0];
  return u.replace(TS_SEGMENT_RE, "");
}

function classifyUrl(url, contentType) {
  if (!url || url.startsWith("blob:") || url.startsWith("data:")) return null;
  const mime = contentType ? contentType.split(";")[0].trim().toLowerCase() : "";

  if (HLS_EXT.test(url) || mime === "application/x-mpegurl" || mime === "application/vnd.apple.mpegurl") {
    return "hls";
  }
  if (TS_SEGMENT_RE.test(url) || TS_SEGMENT_EXT.test(url) || mime === "video/mp2t") {
    return "ts-segment";
  }
  if (DIRECT_VIDEO_EXT.test(url) || VIDEO_MIME_TYPES.has(mime)) {
    return "direct";
  }
  return null;
}

// ─── Stream registry per tab ──────────────────────────────────────────────────

function ensureTab(tabId) {
  if (!tabVideos[tabId]) tabVideos[tabId] = {};
}

function updateBadge(tabId) {
  const count = Object.keys(tabVideos[tabId] || {}).length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#e94560", tabId });
}

/**
 * Upsert a video/stream entry.
 * For HLS streams the key is the m3u8 URL.
 * For TS segments the key is the derived stream base (so they all map to the same entry).
 * For direct videos the key is the URL itself.
 */
function addEntry(tabId, entry) {
  ensureTab(tabId);
  const key = entry.key;
  if (!tabVideos[tabId][key]) {
    tabVideos[tabId][key] = entry;
    updateBadge(tabId);
  } else {
    // Merge extra segment count info
    const existing = tabVideos[tabId][key];
    if (entry.type === "ts-segment") {
      existing.segmentCount = (existing.segmentCount || 0) + 1;
    }
    if (!existing.m3u8Url && entry.m3u8Url) {
      existing.m3u8Url = entry.m3u8Url;
      existing.type = "hls"; // upgrade from ts-segment to hls
    }
  }
}

// ─── Network request interception ────────────────────────────────────────────

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const contentType = details.responseHeaders
      ?.find((h) => h.name.toLowerCase() === "content-type")?.value || "";

    const kind = classifyUrl(details.url, contentType);
    if (!kind) return;

    const pathname = new URL(details.url).pathname;

    if (kind === "hls") {
      const filename = pathname.split("/").pop().replace(/\.m3u8.*/, "") || "stream";
      addEntry(details.tabId, {
        key:     details.url,
        type:    "hls",
        m3u8Url: details.url,
        filename,
        label:   filename,
        contentType,
        segmentCount: 0,
      });
    }

    if (kind === "ts-segment") {
      const baseKey = tsStreamKey(details.url);
      // Infer the likely m3u8 URL (same base + .m3u8, same origin)
      const m3u8Inferred = baseKey + ".m3u8";
      const filename = baseKey.split("/").pop() || "stream";

      addEntry(details.tabId, {
        key:          baseKey,
        type:         "ts-segment",
        m3u8Url:      m3u8Inferred, // may be confirmed later when actual m3u8 is seen
        filename,
        label:        filename,
        contentType:  "video/MP2T",
        segmentCount: 1,
        baseSegmentUrl: baseKey, // prefix for fetching segments
      });
    }

    if (kind === "direct") {
      const filename = pathname.split("/").pop().split("?")[0] || "video";
      addEntry(details.tabId, {
        key:         details.url,
        type:        "direct",
        url:         details.url,
        filename,
        label:       filename,
        contentType,
        segmentCount: null,
      });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ─── Tab lifecycle ────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => { delete tabVideos[tabId]; });

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    delete tabVideos[tabId];
    chrome.action.setBadgeText({ text: "", tabId });
  }
});

// ─── Offscreen document (for HLS download + muxing) ──────────────────────────

let offscreenCreating = false;

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  if (offscreenCreating) {
    await new Promise((r) => setTimeout(r, 200));
    return;
  }
  offscreenCreating = true;
  await chrome.offscreen.createDocument({
    url:    "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Fetch and mux HLS segments into MP4",
  });
  offscreenCreating = false;
}

// ─── Message handling ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Content script reports DOM-found videos
  if (message.type === "ADD_VIDEOS") {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    for (const v of message.videos) {
      const kind = classifyUrl(v.url, v.contentType);
      if (!kind) continue;
      addEntry(tabId, {
        key:  v.url,
        type: kind === "hls" ? "hls" : "direct",
        url:  v.url,
        m3u8Url: kind === "hls" ? v.url : undefined,
        filename: v.filename,
        label:    v.label || v.filename,
        contentType: v.contentType,
        segmentCount: null,
      });
    }
    sendResponse({ ok: true });
    return;
  }

  // Popup requests video list
  if (message.type === "GET_VIDEOS") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      const videos = tabId ? Object.values(tabVideos[tabId] || {}) : [];
      sendResponse({ videos });
    });
    return true;
  }

  // Direct download (non-HLS)
  if (message.type === "DOWNLOAD") {
    chrome.downloads.download(
      { url: message.url, filename: message.filename || undefined },
      (downloadId) => sendResponse({ downloadId })
    );
    return true;
  }

  // HLS download: delegate to offscreen document
  if (message.type === "DOWNLOAD_HLS") {
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage({
        type:     "OFFSCREEN_DOWNLOAD_HLS",
        m3u8Url:  message.m3u8Url,
        filename: message.filename,
        tabId:    message.tabId,
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  // Offscreen doc finished — trigger actual file download
  if (message.type === "HLS_BLOB_READY") {
    chrome.downloads.download(
      { url: message.blobUrl, filename: message.filename },
      () => {
        sendResponse({ ok: true });
        // Release offscreen after a short delay to let download start
        setTimeout(() => chrome.offscreen.closeDocument().catch(() => {}), 3000);
      }
    );
    return true;
  }

  // DOM scan
  if (message.type === "SCAN_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId == null) { sendResponse({ ok: false }); return; }
      chrome.scripting.executeScript(
        { target: { tabId }, func: scanPageForVideos },
        (results) => {
          const videos = results?.[0]?.result || [];
          for (const v of videos) {
            addEntry(tabId, {
              key:  v.url,
              type: v.url.match(/\.m3u8/i) ? "hls" : "direct",
              url:  v.url,
              m3u8Url: v.url.match(/\.m3u8/i) ? v.url : undefined,
              filename: v.filename,
              label: v.label || v.filename,
              contentType: null,
              segmentCount: null,
            });
          }
          sendResponse({ ok: true, count: videos.length });
        }
      );
    });
    return true;
  }
});

// ─── DOM scanner (injected into page) ────────────────────────────────────────

function scanPageForVideos() {
  const videos = [];
  const seen = new Set();

  function add(url, label, type) {
    if (!url || seen.has(url) || url.startsWith("blob:") || url.startsWith("data:")) return;
    seen.add(url);
    const filename = url.split("?")[0].split("/").pop() || "video";
    videos.push({ url, filename, source: type, label, contentType: null });
  }

  document.querySelectorAll("video").forEach((v) => {
    if (v.src)        add(v.src,        v.title || "Video",        "dom");
    if (v.currentSrc) add(v.currentSrc, "Active video",            "dom");
    v.querySelectorAll("source").forEach((s) => {
      if (s.src) add(s.src, s.type || "Source", "dom");
    });
  });

  document.querySelectorAll("a[href]").forEach((a) => {
    if (/\.(mp4|webm|ogg|avi|mov|mkv|flv|wmv|m4v|m3u8)(\?|$|#)/i.test(a.href)) {
      add(a.href, a.textContent.trim() || a.href, "link");
    }
  });

  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"]').forEach((m) => {
    const c = m.getAttribute("content");
    if (c) add(c, "OG Video", "meta");
  });

  return videos;
}
