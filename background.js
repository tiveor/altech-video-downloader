// Track detected video URLs per tab
const tabVideos = {};

// Video MIME types and URL patterns to intercept
const VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/x-msvideo",
  "video/quicktime",
  "video/x-matroska",
  "video/mpeg",
  "application/x-mpegURL",
  "application/vnd.apple.mpegurl",
  "video/MP2T",
]);

const VIDEO_EXTENSIONS = /\.(mp4|webm|ogg|avi|mov|mkv|flv|wmv|m3u8|ts|m4v)(\?|$|#)/i;

function isVideoUrl(url, contentType) {
  if (!url || url.startsWith("blob:") || url.startsWith("data:")) return false;
  if (contentType) {
    const mime = contentType.split(";")[0].trim().toLowerCase();
    if (VIDEO_MIME_TYPES.has(mime)) return true;
  }
  return VIDEO_EXTENSIONS.test(url);
}

function addVideoToTab(tabId, videoInfo) {
  if (!tabVideos[tabId]) tabVideos[tabId] = {};
  const key = videoInfo.url;
  if (!tabVideos[tabId][key]) {
    tabVideos[tabId][key] = videoInfo;
    // Update badge
    const count = Object.keys(tabVideos[tabId]).length;
    chrome.action.setBadgeText({ text: String(count), tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#e53935", tabId });
  }
}

// Intercept network requests to detect video URLs
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const contentType =
      details.responseHeaders
        ?.find((h) => h.name.toLowerCase() === "content-type")
        ?.value || "";
    if (isVideoUrl(details.url, contentType)) {
      const filename = new URL(details.url).pathname.split("/").pop() || "video";
      addVideoToTab(details.tabId, {
        url: details.url,
        filename,
        source: "network",
        contentType,
        size: null,
      });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Clean up when tab is removed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabVideos[tabId];
});

// Clean up when tab navigates to a new page
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    delete tabVideos[tabId];
    chrome.action.setBadgeText({ text: "", tabId });
  }
});

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ADD_VIDEOS") {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    for (const video of message.videos) {
      addVideoToTab(tabId, video);
    }
    sendResponse({ ok: true });
  }

  if (message.type === "GET_VIDEOS") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      const videos = tabId ? Object.values(tabVideos[tabId] || {}) : [];
      sendResponse({ videos });
    });
    return true; // async
  }

  if (message.type === "DOWNLOAD") {
    chrome.downloads.download(
      { url: message.url, filename: message.filename || undefined },
      (downloadId) => {
        sendResponse({ downloadId });
      }
    );
    return true; // async
  }

  if (message.type === "SCAN_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId == null) { sendResponse({ ok: false }); return; }
      chrome.scripting.executeScript(
        { target: { tabId }, func: scanPageForVideos },
        (results) => {
          const videos = results?.[0]?.result || [];
          for (const video of videos) {
            addVideoToTab(tabId, video);
          }
          sendResponse({ ok: true, count: videos.length });
        }
      );
    });
    return true; // async
  }
});

// Injected function — scans DOM for video elements and sources
function scanPageForVideos() {
  const videos = [];
  const seen = new Set();

  function addVideo(url, label, type) {
    if (!url || seen.has(url)) return;
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    seen.add(url);
    const filename = url.split("?")[0].split("/").pop() || "video";
    videos.push({ url, filename, source: type, label, contentType: null, size: null });
  }

  // <video> and <source> tags
  document.querySelectorAll("video").forEach((v) => {
    if (v.src) addVideo(v.src, v.title || v.alt || "Video", "dom");
    v.querySelectorAll("source").forEach((s) => {
      if (s.src) addVideo(s.src, s.type || "Video source", "dom");
    });
    // currentSrc (after browser picks best source)
    if (v.currentSrc) addVideo(v.currentSrc, "Active video", "dom");
  });

  // <a> links pointing to video files
  const VIDEO_EXT = /\.(mp4|webm|ogg|avi|mov|mkv|flv|wmv|m4v)(\?|$|#)/i;
  document.querySelectorAll("a[href]").forEach((a) => {
    if (VIDEO_EXT.test(a.href)) {
      addVideo(a.href, a.textContent.trim() || a.href, "link");
    }
  });

  // og:video meta tags
  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"]').forEach((m) => {
    const content = m.getAttribute("content");
    if (content) addVideo(content, "OG Video", "meta");
  });

  return videos;
}
