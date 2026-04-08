// Offscreen document: fetches HLS segments and muxes them to MP4 using mux.js

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "OFFSCREEN_DOWNLOAD_HLS") {
    downloadHLS(message.m3u8Url, message.filename, message.tabId);
  }
});

function sendProgress(tabId, stage, pct, text) {
  chrome.runtime.sendMessage({ type: "HLS_PROGRESS", tabId, stage, pct, text }).catch(() => {});
}

async function downloadHLS(m3u8Url, filename, tabId) {
  try {
    sendProgress(tabId, "fetch-manifest", 0, "Fetching playlist…");

    // ── Step 1: Fetch the manifest ────────────────────────────────────────────
    const manifestText = await fetchText(m3u8Url);
    const lines = manifestText.split("\n").map((l) => l.trim()).filter(Boolean);

    // Detect master vs media playlist
    const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));

    let mediaM3u8Url = m3u8Url;
    let resolution = null;

    if (isMaster) {
      // Pick the highest-bandwidth variant
      const variants = parseMasterPlaylist(lines, m3u8Url);
      if (variants.length === 0) throw new Error("No variants found in master playlist");
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      const best = variants[0];
      resolution = best.resolution;
      mediaM3u8Url = best.url;
      sendProgress(tabId, "fetch-manifest", 10, `Selected quality: ${best.resolution || "best"}`);
      // Fetch the variant playlist
      const variantText = await fetchText(mediaM3u8Url);
      const variantLines = variantText.split("\n").map((l) => l.trim()).filter(Boolean);
      var segmentUrls = parseSegmentUrls(variantLines, mediaM3u8Url);
    } else {
      var segmentUrls = parseSegmentUrls(lines, m3u8Url);
    }

    if (segmentUrls.length === 0) throw new Error("No segments found in playlist");
    sendProgress(tabId, "fetch-segments", 10, `Downloading ${segmentUrls.length} segments…`);

    // ── Step 2: Fetch all TS segments ─────────────────────────────────────────
    const segmentBuffers = [];
    for (let i = 0; i < segmentUrls.length; i++) {
      const buf = await fetchBinary(segmentUrls[i]);
      segmentBuffers.push(buf);
      const pct = 10 + Math.round(((i + 1) / segmentUrls.length) * 70);
      if (i % 5 === 0 || i === segmentUrls.length - 1) {
        sendProgress(tabId, "fetch-segments", pct, `Segment ${i + 1}/${segmentUrls.length}`);
      }
    }

    sendProgress(tabId, "mux", 80, "Muxing to MP4…");

    // ── Step 3: Concatenate all TS data into one buffer ───────────────────────
    const totalBytes = segmentBuffers.reduce((s, b) => s + b.byteLength, 0);
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const buf of segmentBuffers) {
      combined.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }

    // ── Step 4: Remux TS → MP4 using mux.js ──────────────────────────────────
    const mp4Bytes = await remuxTsToMp4(combined);

    sendProgress(tabId, "done", 95, "Creating download…");

    // ── Step 5: Create blob URL and notify background ─────────────────────────
    const blob = new Blob([mp4Bytes], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);

    const safeFilename = sanitizeFilename(filename || "video") + ".mp4";

    chrome.runtime.sendMessage({
      type:     "HLS_BLOB_READY",
      blobUrl,
      filename: safeFilename,
    });

    sendProgress(tabId, "done", 100, "Done!");

  } catch (err) {
    console.error("[offscreen] HLS download error:", err);
    chrome.runtime.sendMessage({
      type:  "HLS_PROGRESS",
      tabId,
      stage: "error",
      pct:   0,
      text:  "Error: " + err.message,
    }).catch(() => {});
  }
}

// ─── mux.js remuxing ──────────────────────────────────────────────────────────

function remuxTsToMp4(tsData) {
  return new Promise((resolve, reject) => {
    const transmuxer = new muxjs.mp4.Transmuxer();
    const mp4Segments = [];

    transmuxer.on("data", (segment) => {
      // First segment includes the init segment (ftyp+moov)
      const data = segment.initSegment
        ? concat(segment.initSegment, segment.data)
        : segment.data;
      mp4Segments.push(data);
    });

    transmuxer.on("done", () => {
      if (mp4Segments.length === 0) {
        reject(new Error("mux.js produced no output"));
        return;
      }
      const total = mp4Segments.reduce((s, b) => s + b.byteLength, 0);
      const out = new Uint8Array(total);
      let pos = 0;
      for (const seg of mp4Segments) {
        out.set(new Uint8Array(seg.buffer || seg), pos);
        pos += seg.byteLength;
      }
      resolve(out);
    });

    transmuxer.on("error", (e) => reject(new Error(e.message || "mux error")));

    // Push data in chunks to avoid memory spikes
    const CHUNK = 256 * 1024; // 256 KB chunks
    for (let i = 0; i < tsData.length; i += CHUNK) {
      transmuxer.push(tsData.subarray(i, i + CHUNK));
    }
    transmuxer.flush();
  });
}

function concat(a, b) {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a.buffer || a), 0);
  out.set(new Uint8Array(b.buffer || b), a.byteLength);
  return out;
}

// ─── M3U8 parsing ─────────────────────────────────────────────────────────────

function parseMasterPlaylist(lines, baseUrl) {
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const info = lines[i];
      const bwMatch = info.match(/BANDWIDTH=(\d+)/i);
      const resMatch = info.match(/RESOLUTION=([\dx]+)/i);
      const variantUri = lines[i + 1];
      if (variantUri && !variantUri.startsWith("#")) {
        variants.push({
          bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
          resolution: resMatch ? resMatch[1] : null,
          url: resolveUrl(variantUri, baseUrl),
        });
      }
    }
  }
  return variants;
}

function parseSegmentUrls(lines, baseUrl) {
  const urls = [];
  for (const line of lines) {
    if (!line.startsWith("#") && line.length > 0) {
      urls.push(resolveUrl(line, baseUrl));
    }
  }
  return urls;
}

function resolveUrl(uri, baseUrl) {
  if (/^https?:\/\//i.test(uri)) return uri;
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    const base = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
    return base + uri;
  }
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function fetchBinary(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching segment`);
  return res.arrayBuffer();
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._\-() ]/g, "_").replace(/\s+/g, "_").slice(0, 80);
}
