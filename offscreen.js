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

    // ── Step 1: Resolve manifest ──────────────────────────────────────────────
    const manifestText = await fetchText(m3u8Url);
    const lines = manifestText.split("\n").map((l) => l.trim()).filter(Boolean);
    const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));

    let mediaLines, mediaBaseUrl;

    if (isMaster) {
      const variants = parseMasterPlaylist(lines, m3u8Url);
      if (!variants.length) throw new Error("No variants in master playlist");
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      const best = variants[0];
      sendProgress(tabId, "fetch-manifest", 10, `Quality: ${best.resolution || "best"}`);
      const variantText = await fetchText(best.url);
      mediaLines   = variantText.split("\n").map((l) => l.trim()).filter(Boolean);
      mediaBaseUrl = best.url;
    } else {
      mediaLines   = lines;
      mediaBaseUrl = m3u8Url;
    }

    const { segmentUrls, segmentDurations, totalDuration } = parseMediaPlaylist(mediaLines, mediaBaseUrl);
    if (!segmentUrls.length) throw new Error("No segments found");

    sendProgress(tabId, "fetch-segments", 10, `Downloading ${segmentUrls.length} segments…`);

    // ── Step 2: Fetch all TS segments ─────────────────────────────────────────
    const segmentBuffers = [];
    for (let i = 0; i < segmentUrls.length; i++) {
      segmentBuffers.push(await fetchBinary(segmentUrls[i]));
      const pct = 10 + Math.round(((i + 1) / segmentUrls.length) * 65);
      if (i % 5 === 0 || i === segmentUrls.length - 1) {
        sendProgress(tabId, "fetch-segments", pct, `Segment ${i + 1} / ${segmentUrls.length}`);
      }
    }

    sendProgress(tabId, "mux", 78, "Muxing to MP4…");

    // ── Step 3: Remux with per-segment transmuxers and explicit baseMediaDecodeTime
    // One new Transmuxer per segment, each receiving the cumulative playlist time
    // as its baseMediaDecodeTime. This is the hls.js/Shaka approach: anchor each
    // segment to its playlist position instead of trusting raw TS timestamps.
    const mp4Bytes = await remuxTsToMp4(segmentBuffers, segmentDurations);

    // ── Step 4: Defragment fMP4 → flat MP4 using toMp4.js ───────────────────
    // mux.js outputs fragmented MP4 (moof+mdat per segment). toMp4.fromFmp4()
    // reconstructs a standard flat MP4 with a full stbl sample table in moov,
    // equivalent to: ffmpeg -i input.mp4 -c copy -movflags +faststart output.mp4
    sendProgress(tabId, "mux", 88, "Finalizing MP4…");
    let finalBytes;
    try {
      finalBytes = toMp4.fromFmp4(mp4Bytes);
    } catch (e) {
      console.warn("[offscreen] toMp4 defrag failed, using fMP4:", e.message);
      finalBytes = mp4Bytes; // fallback: still a valid (fragmented) MP4
    }

    sendProgress(tabId, "done", 95, "Creating download…");

    // ── Step 5: Download ──────────────────────────────────────────────────────
    const blob    = new Blob([finalBytes], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({
      type: "HLS_BLOB_READY",
      blobUrl,
      filename: sanitizeFilename(filename || "video") + ".mp4",
    });
    sendProgress(tabId, "done", 100, "Done!");

  } catch (err) {
    console.error("[offscreen] HLS error:", err);
    chrome.runtime.sendMessage({
      type: "HLS_PROGRESS", tabId, stage: "error", pct: 0,
      text: "Error: " + err.message,
    }).catch(() => {});
  }
}

// ─── Per-segment transmuxing ──────────────────────────────────────────────────
// Key insight (hls.js mp4-remuxer.ts pattern):
//   One Transmuxer per segment, with baseMediaDecodeTime set to the segment's
//   cumulative playlist position in 90kHz ticks. mux.js uses that as the anchor
//   for both audio and video tracks, so raw TS timestamps are discarded and
//   replaced with the correct playlist-relative time.
//
// This fixes:
//   - Wrong duration (was 27h due to absolute broadcast timestamps)
//   - Audio-only output (single large transmuxer lost video track on large inputs)
//   - Seek positions being incorrect

async function remuxTsToMp4(segmentBuffers, segmentDurations) {
  const TIMESCALE = 90000;
  let initBytes = null;
  const dataParts = [];
  let cumulativeTime = 0; // in 90kHz ticks

  for (let i = 0; i < segmentBuffers.length; i++) {
    const result = await transmuxOneSegment(
      new Uint8Array(segmentBuffers[i]),
      cumulativeTime
    );

    // Capture init segment from the first segment only
    if (i === 0 && result.initBytes && result.initBytes.byteLength > 0) {
      initBytes = result.initBytes;
    }
    if (result.data && result.data.byteLength > 0) {
      dataParts.push(result.data);
    }

    cumulativeTime += Math.round(segmentDurations[i] * TIMESCALE);
  }

  if (!initBytes && dataParts.length === 0) throw new Error("mux.js produced no output");

  const init     = initBytes || new Uint8Array(0);
  const dataSize = dataParts.reduce((s, b) => s + b.byteLength, 0);
  const out      = new Uint8Array(init.byteLength + dataSize);
  out.set(init, 0);
  let pos = init.byteLength;
  for (const part of dataParts) { out.set(part, pos); pos += part.byteLength; }
  return out;
}

function transmuxOneSegment(tsData, baseMediaDecodeTime) {
  return new Promise((resolve, reject) => {
    // Fresh transmuxer per segment with the correct time anchor
    const transmuxer = new muxjs.mp4.Transmuxer({
      keepOriginalTimestamps: false,
      baseMediaDecodeTime,
    });

    let initBytes = null;
    const parts   = [];

    transmuxer.on("data", (segment) => {
      if (segment.initSegment?.byteLength > 0) {
        initBytes = new Uint8Array(segment.initSegment);
      }
      if (segment.data?.byteLength > 0) {
        parts.push(new Uint8Array(segment.data));
      }
    });

    transmuxer.on("done", () => {
      let data;
      if (parts.length === 0) {
        data = new Uint8Array(0);
      } else if (parts.length === 1) {
        data = parts[0];
      } else {
        const total = parts.reduce((s, b) => s + b.byteLength, 0);
        data = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { data.set(p, off); off += p.byteLength; }
      }
      resolve({ initBytes, data });
    });

    transmuxer.on("error", (e) => reject(new Error(e.message || "mux error")));

    transmuxer.push(tsData);
    transmuxer.flush();
  });
}


// ─── M3U8 parsing ─────────────────────────────────────────────────────────────

function parseMasterPlaylist(lines, baseUrl) {
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const bwMatch  = lines[i].match(/BANDWIDTH=(\d+)/i);
    const resMatch = lines[i].match(/RESOLUTION=([\dx]+)/i);
    const uri      = lines[i + 1];
    if (uri && !uri.startsWith("#")) {
      variants.push({
        bandwidth:  bwMatch  ? parseInt(bwMatch[1]) : 0,
        resolution: resMatch ? resMatch[1]          : null,
        url:        resolveUrl(uri, baseUrl),
      });
    }
  }
  return variants;
}

function parseMediaPlaylist(lines, baseUrl) {
  const segmentUrls     = [];
  const segmentDurations = [];
  let totalDuration = 0;
  let nextDuration  = 0;

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      const d = parseFloat(line.slice(8));
      if (!isNaN(d)) nextDuration = d;
    } else if (!line.startsWith("#") && line.length > 0) {
      segmentUrls.push(resolveUrl(line, baseUrl));
      segmentDurations.push(nextDuration);
      totalDuration += nextDuration;
      nextDuration = 0;
    }
  }
  return { segmentUrls, segmentDurations, totalDuration };
}

function resolveUrl(uri, baseUrl) {
  if (/^https?:\/\//i.test(uri)) return uri;
  try { return new URL(uri, baseUrl).href; }
  catch { return baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1) + uri; }
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
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
