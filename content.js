// Content script: watches for dynamically added video elements
// and reports them to the background service worker

const seen = new Set();

function reportVideos(videos) {
  if (videos.length === 0) return;
  chrome.runtime.sendMessage({ type: "ADD_VIDEOS", videos });
}

function extractFromElement(el) {
  const results = [];

  function add(url, label, source) {
    if (!url || seen.has(url)) return;
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    seen.add(url);
    const filename = url.split("?")[0].split("/").pop() || "video";
    results.push({ url, filename, source, label, contentType: null, size: null });
  }

  if (el.tagName === "VIDEO") {
    if (el.src) add(el.src, el.title || "Video", "dom");
    if (el.currentSrc) add(el.currentSrc, el.title || "Active video", "dom");
    el.querySelectorAll("source").forEach((s) => {
      if (s.src) add(s.src, s.type || "Video source", "dom");
    });
  }

  // Recursively check children
  el.querySelectorAll("video").forEach((v) => {
    if (v.src) add(v.src, v.title || "Video", "dom");
    if (v.currentSrc) add(v.currentSrc, "Active video", "dom");
    v.querySelectorAll("source").forEach((s) => {
      if (s.src) add(s.src, s.type || "Source", "dom");
    });
  });

  return results;
}

// Initial scan
function initialScan() {
  const results = [];
  const seen2 = new Set();
  document.querySelectorAll("video").forEach((v) => {
    [v.src, v.currentSrc, ...Array.from(v.querySelectorAll("source")).map((s) => s.src)]
      .filter(Boolean)
      .forEach((url) => {
        if (!seen2.has(url) && !url.startsWith("blob:") && !url.startsWith("data:")) {
          seen2.add(url);
          seen.add(url);
          const filename = url.split("?")[0].split("/").pop() || "video";
          results.push({ url, filename, source: "dom", label: "Video", contentType: null, size: null });
        }
      });
  });
  reportVideos(results);
}

// Watch for dynamically added video elements
const observer = new MutationObserver((mutations) => {
  const found = [];
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;
      found.push(...extractFromElement(node));
    }
  }
  reportVideos(found);
});

observer.observe(document.documentElement, { childList: true, subtree: true });

// Also watch for src attribute changes on existing video elements
const attrObserver = new MutationObserver((mutations) => {
  const found = [];
  for (const mutation of mutations) {
    if (mutation.type === "attributes" && mutation.target.tagName === "VIDEO") {
      found.push(...extractFromElement(mutation.target));
    }
  }
  reportVideos(found);
});

document.querySelectorAll("video").forEach((v) => {
  attrObserver.observe(v, { attributes: true, attributeFilter: ["src", "currentSrc"] });
});

// Run initial scan after DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialScan);
} else {
  initialScan();
}
