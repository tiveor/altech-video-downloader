const videoList = document.getElementById("video-list");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");
const statusEl = document.getElementById("status");
const scanBtn = document.getElementById("scan-btn");
const clearBtn = document.getElementById("clear-btn");

let videos = [];

function showStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (isError ? " error" : "");
  statusEl.classList.remove("hidden");
  setTimeout(() => statusEl.classList.add("hidden"), 3000);
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._\-() ]/g, "_").slice(0, 100);
}

function formatSource(source) {
  return source || "unknown";
}

function renderVideos() {
  videoList.innerHTML = "";

  if (videos.length === 0) {
    emptyEl.classList.remove("hidden");
    countEl.textContent = "No videos found";
    return;
  }

  emptyEl.classList.add("hidden");
  countEl.textContent = `${videos.length} video${videos.length !== 1 ? "s" : ""} found`;

  videos.forEach((video, idx) => {
    const item = document.createElement("div");
    item.className = "video-item";

    const filename = sanitizeFilename(video.filename || "video");
    const source = formatSource(video.source);

    item.innerHTML = `
      <div class="video-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </div>
      <div class="video-info">
        <div class="video-filename" title="${escapeHtml(video.url)}">${escapeHtml(filename)}</div>
        <div class="video-meta">
          <span class="badge ${escapeHtml(source)}">${escapeHtml(source)}</span>
          ${video.contentType ? `<span class="badge">${escapeHtml(video.contentType.split(";")[0])}</span>` : ""}
        </div>
      </div>
      <button class="download-btn" data-idx="${idx}" title="Download">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
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

      const filename = sanitizeFilename(video.filename || "video");

      chrome.runtime.sendMessage(
        { type: "DOWNLOAD", url: video.url, filename },
        (response) => {
          if (chrome.runtime.lastError) {
            showStatus("Download failed: " + chrome.runtime.lastError.message, true);
            return;
          }
          btn.classList.add("done");
          btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
          showStatus(`Downloading ${filename}…`);
        }
      );
    });
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
      Scan
    `;
    if (chrome.runtime.lastError) {
      showStatus("Scan failed: " + chrome.runtime.lastError.message, true);
      return;
    }
    const count = response?.count ?? 0;
    showStatus(count > 0 ? `Found ${count} new video${count !== 1 ? "s" : ""}` : "No new videos found on page");
    loadVideos();
  });
});

clearBtn.addEventListener("click", () => {
  videos = [];
  renderVideos();
  // Clear storage in background by triggering a fake tab update
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (tabId == null) return;
    // Re-fetch to stay in sync (background cleared via tab reload only; just clear local view)
  });
});

// Load on open
loadVideos();
