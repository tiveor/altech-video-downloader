const videoList  = document.getElementById("video-list");
const emptyEl    = document.getElementById("empty");
const countEl    = document.getElementById("count");
const statusEl   = document.getElementById("status");
const scanBtn    = document.getElementById("scan-btn");
const clearBtn   = document.getElementById("clear-btn");

let videos = [];
// Track in-progress HLS downloads: key → { pct, text, stage }
const hlsProgress = {};

// ─── Status bar ───────────────────────────────────────────────────────────────

function showStatus(msg, isError = false, persist = false) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (isError ? " error" : "");
  statusEl.classList.remove("hidden");
  if (!persist) setTimeout(() => statusEl.classList.add("hidden"), 3500);
}

// ─── Listen for progress from background ─────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "HLS_PROGRESS") {
    const key = message.tabId; // we use tabId as the progress key per-tab
    hlsProgress[key] = { pct: message.pct, text: message.text, stage: message.stage };

    // Update progress in the rendered list
    const bar = document.querySelector(`.progress-fill[data-tabid="${key}"]`);
    const label = document.querySelector(`.progress-label[data-tabid="${key}"]`);
    if (bar)   bar.style.width = message.pct + "%";
    if (label) label.textContent = message.text;

    if (message.stage === "error") {
      showStatus(message.text, true);
      const btn = document.querySelector(`.download-btn[data-active="${key}"]`);
      if (btn) resetDownloadBtn(btn);
      delete hlsProgress[key];
    }
    if (message.stage === "done") {
      showStatus("Download started!");
      const btn = document.querySelector(`.download-btn[data-active="${key}"]`);
      if (btn) markDone(btn);
      delete hlsProgress[key];
    }
  }
});

// ─── Rendering ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._\-() ]/g, "_").slice(0, 80);
}

function renderVideos() {
  videoList.innerHTML = "";

  if (videos.length === 0) {
    emptyEl.classList.remove("hidden");
    countEl.textContent = "No videos found";
    return;
  }

  emptyEl.classList.add("hidden");
  countEl.textContent = `${videos.length} stream${videos.length !== 1 ? "s" : ""} found`;

  videos.forEach((video, idx) => {
    const isHLS = video.type === "hls" || video.type === "ts-segment";
    const item = document.createElement("div");
    item.className = "video-item";

    const label = video.label || video.filename || "Video";
    const segInfo = (video.segmentCount && video.segmentCount > 0)
      ? `<span class="badge ts">${video.segmentCount} segments</span>`
      : "";

    const typeLabel = isHLS ? "HLS" : (video.contentType ? video.contentType.split(";")[0].split("/")[1]?.toUpperCase() : "VIDEO");
    const typeBadge = `<span class="badge ${isHLS ? "hls" : "direct"}">${escapeHtml(typeLabel || "video")}</span>`;

    item.innerHTML = `
      <div class="video-icon ${isHLS ? "hls" : ""}">
        ${isHLS
          ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`
          : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
        }
      </div>
      <div class="video-info">
        <div class="video-filename" title="${escapeHtml(video.m3u8Url || video.url || '')}">${escapeHtml(label)}</div>
        <div class="video-meta">${typeBadge}${segInfo}</div>
        ${isHLS ? `
        <div class="progress-wrap hidden" id="prog-${idx}">
          <div class="progress-bar"><div class="progress-fill" data-tabid="" style="width:0%"></div></div>
          <div class="progress-label" data-tabid=""></div>
        </div>` : ""}
      </div>
      <button class="download-btn" data-idx="${idx}" title="${isHLS ? 'Download as MP4' : 'Download'}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </button>
    `;

    videoList.appendChild(item);
  });

  // Attach download listeners
  videoList.querySelectorAll(".download-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const video = videos[idx];
      if (!video) return;

      const isHLS = video.type === "hls" || video.type === "ts-segment";

      if (isHLS) {
        triggerHLSDownload(btn, video, idx);
      } else {
        triggerDirectDownload(btn, video);
      }
    });
  });
}

function triggerDirectDownload(btn, video) {
  const filename = sanitizeFilename(video.filename || "video");
  chrome.runtime.sendMessage({ type: "DOWNLOAD", url: video.url, filename }, (res) => {
    if (chrome.runtime.lastError) {
      showStatus("Download failed: " + chrome.runtime.lastError.message, true);
      return;
    }
    markDone(btn);
    showStatus(`Downloading ${filename}…`);
  });
}

function triggerHLSDownload(btn, video, idx) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (!tabId) { showStatus("Cannot determine active tab", true); return; }

    const filename = sanitizeFilename(video.filename || "stream");
    const m3u8Url  = video.m3u8Url;

    if (!m3u8Url) {
      showStatus("No playlist URL found for this stream", true);
      return;
    }

    // Show progress UI
    const progWrap = document.getElementById(`prog-${idx}`);
    if (progWrap) {
      progWrap.classList.remove("hidden");
      const fill  = progWrap.querySelector(".progress-fill");
      const label = progWrap.querySelector(".progress-label");
      if (fill)  fill.setAttribute("data-tabid", tabId);
      if (label) label.setAttribute("data-tabid", tabId);
      if (label) label.textContent = "Starting…";
    }

    // Mark button as active
    btn.setAttribute("data-active", tabId);
    btn.disabled = true;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

    chrome.runtime.sendMessage({
      type: "DOWNLOAD_HLS",
      m3u8Url,
      filename,
      tabId,
    }, () => {
      showStatus("Fetching segments…", false, true);
    });
  });
}

function markDone(btn) {
  btn.classList.add("done");
  btn.disabled = false;
  btn.removeAttribute("data-active");
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
}

function resetDownloadBtn(btn) {
  btn.disabled = false;
  btn.removeAttribute("data-active");
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>`;
}

// ─── Load ─────────────────────────────────────────────────────────────────────

function loadVideos() {
  chrome.runtime.sendMessage({ type: "GET_VIDEOS" }, (response) => {
    if (chrome.runtime.lastError) return;
    videos = response?.videos || [];
    renderVideos();
  });
}

scanBtn.addEventListener("click", () => {
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning…";
  chrome.runtime.sendMessage({ type: "SCAN_TAB" }, (response) => {
    scanBtn.disabled = false;
    scanBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      Scan`;
    if (chrome.runtime.lastError) { showStatus("Scan failed", true); return; }
    const count = response?.count ?? 0;
    showStatus(count > 0 ? `Found ${count} new item${count !== 1 ? "s" : ""}` : "No new videos found");
    loadVideos();
  });
});

clearBtn.addEventListener("click", () => {
  videos = [];
  renderVideos();
});

loadVideos();
