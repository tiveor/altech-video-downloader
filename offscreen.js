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

    // ── Step 4: Normalize timestamps (mirrors hls.js mp4-remuxer.ts approach) ──
    // USP/JWPlayer segments carry large absolute PTS values. mux.js writes these
    // into both tfdt.baseMediaDecodeTime (breaks seeking) and mvhd duration
    // (shows ~27h). Two-step fix:
    //   a) Read the initial PTS offset from the first moof/traf/tfdt box, then
    //      subtract it from every tfdt → anchors timeline to 0 like hls.js's
    //      resetTimeStamp() + timeOffset anchor in remuxVideo().
    //   b) Overwrite mvhd/tkhd/mdhd with true duration from #EXTINF sum.
    if (totalDuration > 0) {
      fixMp4Timestamps(mp4Bytes, totalDuration);
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

// ─── MP4 timestamp normalizer ─────────────────────────────────────────────────
// Mirrors the hls.js mp4-remuxer.ts approach:
//   1. Read the PTS anchor from the first moof/traf/tfdt (the absolute offset
//      baked in by the USP broadcast timestamp).
//   2. Subtract that anchor from every tfdt.baseMediaDecodeTime so the timeline
//      starts at 0 — equivalent to hls.js resetTimeStamp() + timeOffset anchor.
//   3. Patch mvhd/tkhd/mdhd duration with the true value from #EXTINF sum.

function fixMp4Timestamps(bytes, totalSeconds) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // ── Box reader ───────────────────────────────────────────────────────────────
  function boxAt(offset) {
    if (offset + 8 > bytes.length) return null;
    let size = view.getUint32(offset);
    if (size === 1 && offset + 16 <= bytes.length) {
      size = view.getUint32(offset + 8) * 0x100000000 + view.getUint32(offset + 12);
    }
    if (size < 8 || offset + size > bytes.length) return null;
    const type = String.fromCharCode(
      bytes[offset+4], bytes[offset+5], bytes[offset+6], bytes[offset+7]
    );
    return { type, offset, size };
  }

  // ── Walk boxes recursively ────────────────────────────────────────────────────
  function walkBoxes(start, end, visitor) {
    let pos = start;
    while (pos < end) {
      const box = boxAt(pos);
      if (!box) break;
      visitor(box);
      pos += box.size;
    }
  }

  // ── Step 1: Find the initial PTS offset from the first tfdt ──────────────────
  // hls.js equivalent: the raw baseMediaDecodeTime before resetTimeStamp() anchor
  let initPtsOffset = null;

  function findFirstTfdt(start, end) {
    walkBoxes(start, end, (box) => {
      if (initPtsOffset !== null) return;
      if (box.type === "moof") findFirstTfdt(box.offset + 8, box.offset + box.size);
      if (box.type === "traf") findFirstTfdt(box.offset + 8, box.offset + box.size);
      if (box.type === "tfdt") {
        const version = bytes[box.offset + 8];
        if (version === 1) {
          initPtsOffset = view.getUint32(box.offset + 12) * 0x100000000
                        + view.getUint32(box.offset + 16);
        } else {
          initPtsOffset = view.getUint32(box.offset + 12);
        }
      }
    });
  }
  findFirstTfdt(0, bytes.length);

  if (initPtsOffset === null || initPtsOffset === 0) {
    // No offset to remove — just fix the duration fields
    patchDurationFields(bytes, view, totalSeconds);
    return;
  }

  // ── Step 2: Subtract initPtsOffset from every tfdt box ───────────────────────
  // hls.js equivalent: baseMediaDecodeTime = rawDts - initDTS + timeOffset*timescale
  // For a full VOD file starting at 0, timeOffset=0, so we just subtract initDTS.
  function patchAllTfdt(start, end) {
    walkBoxes(start, end, (box) => {
      if (box.type === "moof") patchAllTfdt(box.offset + 8, box.offset + box.size);
      if (box.type === "traf") patchAllTfdt(box.offset + 8, box.offset + box.size);
      if (box.type === "tfdt") {
        const version = bytes[box.offset + 8];
        if (version === 1) {
          const hi = view.getUint32(box.offset + 12);
          const lo = view.getUint32(box.offset + 16);
          const current = hi * 0x100000000 + lo;
          const corrected = Math.max(0, current - initPtsOffset);
          view.setUint32(box.offset + 12, Math.floor(corrected / 0x100000000));
          view.setUint32(box.offset + 16, corrected >>> 0);
        } else {
          const current = view.getUint32(box.offset + 12);
          view.setUint32(box.offset + 12, Math.max(0, current - initPtsOffset));
        }
      }
    });
  }
  patchAllTfdt(0, bytes.length);

  // ── Step 3: Patch moov duration fields with real #EXTINF total ───────────────
  patchDurationFields(bytes, view, totalSeconds);
}

function patchDurationFields(bytes, view, totalSeconds) {
  const CONTAINERS = new Set(["moov", "trak", "mdia"]);

  function walkPatch(start, end) {
    let pos = start;
    while (pos < end) {
      if (pos + 8 > bytes.length) break;
      let size = view.getUint32(pos);
      if (size === 1 && pos + 16 <= bytes.length)
        size = view.getUint32(pos + 8) * 0x100000000 + view.getUint32(pos + 12);
      if (size < 8 || pos + size > bytes.length) break;
      const type = String.fromCharCode(bytes[pos+4], bytes[pos+5], bytes[pos+6], bytes[pos+7]);

      if (CONTAINERS.has(type)) {
        walkPatch(pos + 8, pos + size);
      } else if (type === "mvhd" || type === "tkhd" || type === "mdhd") {
        const version  = bytes[pos + 8];
        const tsOffset = version === 0 ? pos + 12 : pos + 20;
        const durOffset= version === 0 ? pos + 16 : pos + 24;
        const timescale= view.getUint32(tsOffset);
        if (timescale > 0) {
          const correctDur = Math.round(totalSeconds * timescale);
          if (version === 0) {
            view.setUint32(durOffset, correctDur);
          } else {
            view.setUint32(durOffset,     0);          // high 32 bits
            view.setUint32(durOffset + 4, correctDur); // low 32 bits
          }
        }
      }
      pos += size;
    }
  }
  walkPatch(0, bytes.length);
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
