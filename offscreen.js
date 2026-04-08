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

    // ── Step 1: Fetch and resolve the playlist ────────────────────────────────
    const manifestText = await fetchText(m3u8Url);
    const lines = manifestText.split("\n").map((l) => l.trim()).filter(Boolean);
    const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));

    let mediaLines;
    let mediaBaseUrl;

    if (isMaster) {
      const variants = parseMasterPlaylist(lines, m3u8Url);
      if (variants.length === 0) throw new Error("No variants found in master playlist");
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      const best = variants[0];
      sendProgress(tabId, "fetch-manifest", 10, `Selected: ${best.resolution || "best quality"}`);
      const variantText = await fetchText(best.url);
      mediaLines   = variantText.split("\n").map((l) => l.trim()).filter(Boolean);
      mediaBaseUrl = best.url;
    } else {
      mediaLines   = lines;
      mediaBaseUrl = m3u8Url;
    }

    // Parse segments + their declared durations (#EXTINF)
    const { segmentUrls, totalDuration } = parseMediaPlaylist(mediaLines, mediaBaseUrl);
    if (segmentUrls.length === 0) throw new Error("No segments found in playlist");

    sendProgress(tabId, "fetch-segments", 10, `Downloading ${segmentUrls.length} segments…`);

    // ── Step 2: Fetch all TS segments ─────────────────────────────────────────
    const segmentBuffers = [];
    for (let i = 0; i < segmentUrls.length; i++) {
      const buf = await fetchBinary(segmentUrls[i]);
      segmentBuffers.push(buf);
      const pct = 10 + Math.round(((i + 1) / segmentUrls.length) * 68);
      if (i % 3 === 0 || i === segmentUrls.length - 1) {
        sendProgress(tabId, "fetch-segments", pct, `Segment ${i + 1} / ${segmentUrls.length}`);
      }
    }

    sendProgress(tabId, "mux", 80, "Muxing to MP4…");

    // ── Step 3: Remux TS → MP4, passing segments individually ─────────────────
    const mp4Bytes = await remuxTsToMp4(segmentBuffers);

    // ── Step 4: Fix the duration in the moov/mvhd box ─────────────────────────
    // USP/JWPlayer segments use large absolute PTS values; mux.js writes those
    // into the MP4 timescale which players misinterpret as a huge duration.
    // We overwrite it with the true duration parsed from #EXTINF tags.
    if (totalDuration > 0) {
      fixMp4Duration(mp4Bytes, totalDuration);
    }

    sendProgress(tabId, "done", 95, "Creating download…");

    // ── Step 5: Blob → background → chrome.downloads ──────────────────────────
    const blob    = new Blob([mp4Bytes], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);
    const safeFilename = sanitizeFilename(filename || "video") + ".mp4";

    chrome.runtime.sendMessage({ type: "HLS_BLOB_READY", blobUrl, filename: safeFilename });
    sendProgress(tabId, "done", 100, "Done!");

  } catch (err) {
    console.error("[offscreen] HLS download error:", err);
    chrome.runtime.sendMessage({
      type: "HLS_PROGRESS", tabId, stage: "error", pct: 0,
      text: "Error: " + err.message,
    }).catch(() => {});
  }
}

// ─── mux.js remuxing ──────────────────────────────────────────────────────────
// Push each TS segment individually — not as one concatenated blob.
// This ensures mux.js sees clean segment boundaries and can handle
// per-segment timestamp discontinuities correctly.

function remuxTsToMp4(segmentBuffers) {
  return new Promise((resolve, reject) => {
    const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false });
    const mp4Parts   = [];
    let initBytes    = null;

    transmuxer.on("data", (segment) => {
      // Capture init segment (ftyp + moov) once — it comes with the first data event
      if (segment.initSegment && segment.initSegment.byteLength > 0 && !initBytes) {
        initBytes = new Uint8Array(segment.initSegment);
      }
      if (segment.data && segment.data.byteLength > 0) {
        mp4Parts.push(new Uint8Array(segment.data));
      }
    });

    transmuxer.on("done", () => {
      if (!initBytes && mp4Parts.length === 0) {
        reject(new Error("mux.js produced no output"));
        return;
      }
      const init   = initBytes || new Uint8Array(0);
      const dataLen = mp4Parts.reduce((s, b) => s + b.byteLength, 0);
      const out    = new Uint8Array(init.byteLength + dataLen);
      out.set(init, 0);
      let pos = init.byteLength;
      for (const part of mp4Parts) { out.set(part, pos); pos += part.byteLength; }
      resolve(out);
    });

    transmuxer.on("error", (e) => reject(new Error(e.message || "mux error")));

    // Push each complete TS segment buffer, then flush once at the end
    for (const buf of segmentBuffers) {
      transmuxer.push(new Uint8Array(buf));
    }
    transmuxer.flush();
  });
}

// ─── MP4 duration patcher ─────────────────────────────────────────────────────
// Walks the top-level MP4 boxes to find moov, then patches mvhd + tkhd + mdhd
// with the correct duration derived from the m3u8 #EXTINF sum.

function fixMp4Duration(bytes, totalSeconds) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  function readBox(offset) {
    if (offset + 8 > bytes.length) return null;
    let size = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset+4], bytes[offset+5], bytes[offset+6], bytes[offset+7]);
    if (size === 1) {
      // 64-bit size
      size = view.getUint32(offset + 8) * 0x100000000 + view.getUint32(offset + 12);
    }
    if (size < 8 || offset + size > bytes.length) return null;
    return { type, offset, size };
  }

  function patchDurationBox(boxOffset, boxType, timescale) {
    const correctDuration = Math.round(totalSeconds * timescale);
    const version = bytes[boxOffset + 8];
    // version 0: timescale at +12 (4B), duration at +16 (4B)
    // version 1: timescale at +20 (4B), duration at +24 (8B)
    if (version === 0) {
      view.setUint32(boxOffset + 16, correctDuration);
    } else {
      view.setUint32(boxOffset + 24, 0); // high 32 bits
      view.setUint32(boxOffset + 28, correctDuration); // low 32 bits
    }
  }

  function scanBoxes(start, end, depth) {
    let offset = start;
    while (offset < end) {
      const box = readBox(offset);
      if (!box) break;

      if (box.type === "moov" || box.type === "trak" || box.type === "mdia") {
        // Container — recurse into children
        const childStart = box.type === "moov" ? offset + 8 : offset + 8;
        scanBoxes(childStart, offset + box.size, depth + 1);
      }

      if (box.type === "mvhd" || box.type === "tkhd") {
        // timescale position: v0 → offset+12, v1 → offset+20
        const version = bytes[box.offset + 8];
        const tsOff = version === 0 ? box.offset + 12 : box.offset + 20;
        const timescale = view.getUint32(tsOff);
        if (timescale > 0) patchDurationBox(box.offset, box.type, timescale);
      }

      if (box.type === "mdhd") {
        // timescale position: v0 → offset+12, v1 → offset+20
        const version = bytes[box.offset + 8];
        const tsOff = version === 0 ? box.offset + 12 : box.offset + 20;
        const timescale = view.getUint32(tsOff);
        if (timescale > 0) patchDurationBox(box.offset, "mdhd", timescale);
      }

      offset += box.size;
    }
  }

  scanBoxes(0, bytes.length, 0);
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
        bandwidth:  bwMatch  ? parseInt(bwMatch[1])  : 0,
        resolution: resMatch ? resMatch[1]           : null,
        url:        resolveUrl(uri, baseUrl),
      });
    }
  }
  return variants;
}

function parseMediaPlaylist(lines, baseUrl) {
  const segmentUrls = [];
  let totalDuration = 0;
  let nextDuration  = 0;

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      const d = parseFloat(line.slice(8));
      if (!isNaN(d)) nextDuration = d;
    } else if (!line.startsWith("#") && line.length > 0) {
      segmentUrls.push(resolveUrl(line, baseUrl));
      totalDuration += nextDuration;
      nextDuration = 0;
    }
  }
  return { segmentUrls, totalDuration };
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
