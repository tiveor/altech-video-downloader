// Offscreen document: fetches HLS segments and muxes them to MP4 using mux.js
console.log("[Altech Video Downloader] v1.1.6 — offscreen loaded | mux.js:", typeof muxjs);

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

    // ── Step 4: Defragment fMP4 → flat MP4 ───────────────────────────────────
    // mux.js outputs fMP4 (ftyp + moov + moof+mdat pairs). We rebuild it as a
    // standard flat MP4: collect all mdat payloads, reconstruct stbl from trun
    // entries, remove mvex from moov, write moov + single mdat.
    sendProgress(tabId, "mux", 88, "Finalizing MP4…");
    let finalBytes;
    try {
      finalBytes = defragmentFmp4(mp4Bytes, totalDuration);
    } catch (e) {
      console.warn("[offscreen] defrag failed, using fMP4:", e.message);
      finalBytes = mp4Bytes;
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


// ─── fMP4 → flat MP4 defragmenter ────────────────────────────────────────────
// Converts mux.js fMP4 output into a standard progressive MP4.
// mux.js always produces: ftyp, moov (with mvex/trex), then N×(moof+mdat).
// We parse the box tree, extract samples from trun entries, collect all mdat
// payload bytes, rebuild stbl boxes in each trak, strip mvex, and write a
// single flat file: ftyp + moov + mdat.

function defragmentFmp4(src, totalDurationSeconds) {
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);

  // ── Box reader ──────────────────────────────────────────────────────────────
  function readBox(offset) {
    if (offset + 8 > src.length) return null;
    let size = view.getUint32(offset);
    if (size === 1) {
      if (offset + 16 > src.length) return null;
      size = view.getUint32(offset + 8) * 0x100000000 + view.getUint32(offset + 12);
    }
    if (size < 8 || offset + size > src.length) return null;
    const type = String.fromCharCode(src[offset+4], src[offset+5], src[offset+6], src[offset+7]);
    return { type, offset, size, dataOffset: offset + 8 };
  }

  function childBoxes(offset, end) {
    const boxes = [];
    let pos = offset;
    while (pos < end) {
      const b = readBox(pos);
      if (!b) break;
      boxes.push(b);
      pos += b.size;
    }
    return boxes;
  }

  function findBox(offset, end, type) {
    return childBoxes(offset, end).find(b => b.type === type) || null;
  }

  function readU8(o)  { return src[o]; }
  function readU16(o) { return view.getUint16(o); }
  function readU32(o) { return view.getUint32(o); }
  function readU64(o) { return view.getUint32(o) * 0x100000000 + view.getUint32(o + 4); }

  // ── Parse top-level boxes ────────────────────────────────────────────────────
  const top = childBoxes(0, src.length);
  const ftypBox = top.find(b => b.type === "ftyp");
  const moovBox = top.find(b => b.type === "moov");
  const moofMdatPairs = [];

  for (let i = 0; i < top.length; i++) {
    if (top[i].type === "moof" && top[i+1]?.type === "mdat") {
      moofMdatPairs.push({ moof: top[i], mdat: top[i+1] });
    }
  }

  if (!moovBox || moofMdatPairs.length === 0) throw new Error("Not a valid fMP4");

  // ── Parse moov: find trak boxes and their track IDs ─────────────────────────
  const moovEnd  = moovBox.offset + moovBox.size;
  const trakBoxes = childBoxes(moovBox.dataOffset, moovEnd).filter(b => b.type === "trak");

  // For each track: collect samples = { duration, size, flags, cts }
  // and the corresponding raw mdat slice offsets.
  const tracks = trakBoxes.map(trak => {
    const tkhdBox = findBox(trak.dataOffset, trak.offset + trak.size, "tkhd");
    const version = tkhdBox ? readU8(tkhdBox.dataOffset) : 0;
    const trackId = tkhdBox
      ? (version === 1 ? readU32(tkhdBox.dataOffset + 20) : readU32(tkhdBox.dataOffset + 12))
      : 0;
    return { trak, trackId, samples: [], totalSize: 0 };
  });

  const trackById = new Map(tracks.map(t => [t.trackId, t]));

  // ── Parse trex defaults from mvex ───────────────────────────────────────────
  const mvexBox = findBox(moovBox.dataOffset, moovEnd, "mvex");
  const trexDefaults = new Map();
  if (mvexBox) {
    childBoxes(mvexBox.dataOffset, mvexBox.offset + mvexBox.size)
      .filter(b => b.type === "trex")
      .forEach(trex => {
        const o = trex.dataOffset;
        trexDefaults.set(readU32(o + 4), { // track_ID
          defaultSampleDuration: readU32(o + 8),
          defaultSampleSize:     readU32(o + 12),
          defaultSampleFlags:    readU32(o + 16),
        });
      });
  }

  // ── Collect all mdat payloads in order ──────────────────────────────────────
  const mdatChunks = [];
  let mdatTotalSize = 0;

  for (const { moof, mdat } of moofMdatPairs) {
    const moofEnd = moof.offset + moof.size;

    // mdat payload starts after 8-byte header
    const mdatPayload = src.slice(mdat.offset + 8, mdat.offset + mdat.size);
    const mdatPayloadOffset = mdatTotalSize; // offset in the final combined mdat

    // Parse traf boxes inside this moof
    const trafBoxes = childBoxes(moof.dataOffset, moofEnd).filter(b => b.type === "traf");

    for (const traf of trafBoxes) {
      const trafEnd = traf.offset + traf.size;
      const tfhdBox = findBox(traf.dataOffset, trafEnd, "tfhd");
      if (!tfhdBox) continue;

      const tfhdOff = tfhdBox.dataOffset;
      const tfhdFlags = readU32(tfhdOff) & 0xFFFFFF;
      const tfhdVersion = readU8(tfhdOff);
      let tfhdPos = tfhdOff + 4;
      const trackId = readU32(tfhdPos); tfhdPos += 4;

      const trex = trexDefaults.get(trackId) || {};
      let baseDataOffset = mdat.offset + 8; // default: start of mdat payload

      if (tfhdFlags & 0x000001) { tfhdPos += 8; } // base_data_offset present
      if (tfhdFlags & 0x000002) { tfhdPos += 4; } // sample_description_index
      const defaultDuration = (tfhdFlags & 0x000008) ? readU32(tfhdPos) : (trex.defaultSampleDuration || 0);
      if (tfhdFlags & 0x000008) tfhdPos += 4;
      const defaultSize     = (tfhdFlags & 0x000010) ? readU32(tfhdPos) : (trex.defaultSampleSize || 0);
      if (tfhdFlags & 0x000010) tfhdPos += 4;
      const defaultFlags    = (tfhdFlags & 0x000020) ? readU32(tfhdPos) : (trex.defaultSampleFlags || 0);

      const track = trackById.get(trackId);
      if (!track) continue;

      // Parse trun boxes.
      // Per ISO 14496-12: trun data_offset is relative to the "base data offset".
      // When tfhd flag 0x1 (base-data-offset-present) is NOT set, the base is
      // the start of the enclosing moof box. mux.js uses this form.
      // So: absolute file position = moof.offset + trun.data_offset + per-sample-accumulator
      // We store offset relative to the combined mdat payload:
      //   offset_in_combined_mdat = (moof.offset + trun.data_offset) - mdat.offset - 8 + mdatPayloadOffset
      const trunBoxes = childBoxes(traf.dataOffset, trafEnd).filter(b => b.type === "trun");

      for (const trun of trunBoxes) {
        const trunOff = trun.dataOffset;
        const trunFlags = readU32(trunOff) & 0xFFFFFF;
        let trunPos = trunOff + 4;
        const sampleCount = readU32(trunPos); trunPos += 4;

        // data_offset is relative to moof start (base-data-offset = moof.offset)
        let trunDataOffset = 0;
        if (trunFlags & 0x001) { trunDataOffset = view.getInt32(trunPos); trunPos += 4; }
        if (trunFlags & 0x004) { trunPos += 4; } // first_sample_flags

        // Convert: absolute position in fMP4 = moof.offset + trunDataOffset
        // Position in combined mdat payload = that absolute pos - mdat.offset - 8 + mdatPayloadOffset
        let samplePos = mdatPayloadOffset + (moof.offset + trunDataOffset) - mdat.offset - 8;

        for (let s = 0; s < sampleCount; s++) {
          const duration = (trunFlags & 0x100) ? readU32(trunPos) : defaultDuration; if (trunFlags & 0x100) trunPos += 4;
          const size     = (trunFlags & 0x200) ? readU32(trunPos) : defaultSize;     if (trunFlags & 0x200) trunPos += 4;
          const flags    = (trunFlags & 0x400) ? readU32(trunPos) : defaultFlags;    if (trunFlags & 0x400) trunPos += 4;
          const cts      = (trunFlags & 0x800) ? view.getInt32(trunPos) : 0;         if (trunFlags & 0x800) trunPos += 4;

          track.samples.push({ duration, size, flags, cts, offset: samplePos });
          track.totalSize += size;
          samplePos += size;
        }
      }
    }

    mdatChunks.push(mdatPayload);
    mdatTotalSize += mdatPayload.byteLength;
  }

  // ── Rebuild moov without mvex, with stbl rebuilt for each trak ──────────────
  const newMoov = rebuildMoov(src, moovBox, tracks, mdatTotalSize, totalDurationSeconds);

  // ── Assemble: ftyp + moov + mdat ────────────────────────────────────────────
  const ftypBytes = ftypBox ? src.slice(ftypBox.offset, ftypBox.offset + ftypBox.size) : new Uint8Array(0);

  // Rewrite ftyp compatible_brands to include isom+iso2+avc1+mp41
  const newFtyp = buildFtyp();

  const mdatHeader = new Uint8Array(8);
  new DataView(mdatHeader.buffer).setUint32(0, mdatTotalSize + 8);
  mdatHeader[4] = 109; mdatHeader[5] = 100; mdatHeader[6] = 97; mdatHeader[7] = 116; // "mdat"

  const totalLen = newFtyp.byteLength + newMoov.byteLength + 8 + mdatTotalSize;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  out.set(newFtyp, pos); pos += newFtyp.byteLength;
  out.set(newMoov, pos); pos += newMoov.byteLength;
  out.set(mdatHeader, pos); pos += 8;
  for (const chunk of mdatChunks) { out.set(chunk, pos); pos += chunk.byteLength; }

  return out;
}

// ── Box builders ────────────────────────────────────────────────────────────

function buildFtyp() {
  // ftyp: major=isom, minor=0x200, compatible: isom iso2 avc1 mp41
  const brands = ["isom", "iso2", "avc1", "mp41"];
  const size = 8 + 4 + 4 + brands.length * 4;
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  v.setUint32(0, size);
  buf.set([102,116,121,112], 4); // "ftyp"
  buf.set([105,115,111,109], 8); // major "isom"
  v.setUint32(12, 0x200);        // minor version 512
  brands.forEach((b, i) => { for (let j=0;j<4;j++) buf[16 + i*4 + j] = b.charCodeAt(j); });
  return buf;
}

function rebuildMoov(src, moovBox, tracks, mdatSize, totalDurationSeconds) {
  // We'll reconstruct moov by copying everything except mvex,
  // and replacing each trak's minf/stbl with rebuilt sample tables.
  // The chunk offset (stco) for each track points into the single mdat.

  // Compute moov offset in final file: ftyp(24) + moov_size + 8(mdat header)
  // We'll use a two-pass approach: first compute sizes, then write.

  const parts = [];

  // moov children: copy everything except mvex; rebuild trak boxes
  const moovEnd = moovBox.offset + moovBox.size;
  const moovChildren = childBoxesFrom(src, moovBox.dataOffset, moovEnd);

  const rebuiltTraks = tracks.map(t => rebuildTrak(src, t, 0)); // stco placeholder

  // Compute total moov size
  let moovBodySize = 0;
  for (const child of moovChildren) {
    if (child.type === "mvex") continue;
    if (child.type === "trak") continue;
    moovBodySize += child.size;
  }
  for (const rt of rebuiltTraks) moovBodySize += rt.byteLength;

  const moovSize = 8 + moovBodySize;

  // moov starts right after ftyp (24 bytes)
  const ftypSize = 32; // buildFtyp() outputs 8 header + 4 major + 4 minor + 4×4 brands = 32
  const moovStartInFile = ftypSize;
  const mdatStartInFile = moovStartInFile + moovSize + 8; // +8 for mdat header... wait no
  // Actually: file = ftyp + moov + mdat
  // mdatPayloadStart = ftypSize + moovSize + 8

  // mdatPayloadStart = position of first byte of mdat payload in the final file
  // ftyp(24) + moov(moovSize) + mdat_header(8)
  const mdatPayloadStart = ftypSize + moovSize + 8;
  const rebuiltTraksFinal = tracks.map(t => rebuildTrak(src, t, mdatPayloadStart));

  // Assemble moov
  let bodySize = 0;
  for (const child of moovChildren) {
    if (child.type === "mvex" || child.type === "trak") continue;
    bodySize += child.size;
  }
  for (const rt of rebuiltTraksFinal) bodySize += rt.byteLength;

  const moov = new Uint8Array(8 + bodySize);
  const mv = new DataView(moov.buffer);
  mv.setUint32(0, 8 + bodySize);
  moov.set([109,111,111,118], 4); // "moov"
  let mpos = 8;

  for (const child of moovChildren) {
    if (child.type === "mvex" || child.type === "trak") continue;
    moov.set(src.slice(child.offset, child.offset + child.size), mpos);
    mpos += child.size;
  }
  for (const rt of rebuiltTraksFinal) {
    moov.set(rt, mpos);
    mpos += rt.byteLength;
  }

  // Patch mvhd duration: use track[0] total duration in movie timescale
  // Find mvhd in moov and patch duration
  patchDurations(moov, totalDurationSeconds);

  return moov;
}

function childBoxesFrom(src, start, end) {
  const boxes = [];
  let pos = start;
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  while (pos < end) {
    if (pos + 8 > src.length) break;
    let size = view.getUint32(pos);
    if (size === 1 && pos + 16 <= src.length) size = view.getUint32(pos + 8) * 0x100000000 + view.getUint32(pos + 12);
    if (size < 8 || pos + size > src.length) break;
    const type = String.fromCharCode(src[pos+4], src[pos+5], src[pos+6], src[pos+7]);
    boxes.push({ type, offset: pos, size, dataOffset: pos + 8 });
    pos += size;
  }
  return boxes;
}

function rebuildTrak(src, track, chunkOffset) {
  // Copy trak as-is but rebuild the stbl inside minf/mdia
  const trakBox = track.trak;
  const trakEnd = trakBox.offset + trakBox.size;
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);

  const mdiaBox = childBoxesFrom(src, trakBox.dataOffset, trakEnd).find(b => b.type === "mdia");
  if (!mdiaBox) return src.slice(trakBox.offset, trakBox.offset + trakBox.size);

  const mdiaEnd = mdiaBox.offset + mdiaBox.size;
  const minfBox = childBoxesFrom(src, mdiaBox.dataOffset, mdiaEnd).find(b => b.type === "minf");
  if (!minfBox) return src.slice(trakBox.offset, trakBox.offset + trakBox.size);

  const minfEnd = minfBox.offset + minfBox.size;
  const stblBox = childBoxesFrom(src, minfBox.dataOffset, minfEnd).find(b => b.type === "stbl");
  if (!stblBox) return src.slice(trakBox.offset, trakBox.offset + trakBox.size);

  // Get timescale from mdhd
  const mdhdBox = childBoxesFrom(src, mdiaBox.dataOffset, mdiaEnd).find(b => b.type === "mdhd");
  const mdhdVersion = mdhdBox ? src[mdhdBox.dataOffset] : 0;
  const timescale = mdhdBox
    ? (mdhdVersion === 1 ? view.getUint32(mdhdBox.dataOffset + 20) : view.getUint32(mdhdBox.dataOffset + 12))
    : 90000;

  // Extract stsd from original stbl to carry over codec info
  const stsdBox = childBoxesFrom(src, stblBox.dataOffset, stblBox.offset + stblBox.size)
    .find(b => b.type === "stsd");
  const stsdBytes = stsdBox ? src.slice(stsdBox.offset, stsdBox.offset + stsdBox.size) : null;

  const newStbl = buildStbl(track.samples, chunkOffset, timescale, stsdBytes);

  // Rebuild minf: copy everything except old stbl, add new stbl
  const newMinf = rebuildContainer(src, minfBox, [{ type: "stbl", replace: newStbl }]);
  // Rebuild mdia: copy everything except old minf, add new minf
  const newMdia = rebuildContainer(src, mdiaBox, [{ type: "minf", replace: newMinf }]);
  // Rebuild trak: copy everything except old mdia, add new mdia
  const newTrak = rebuildContainer(src, trakBox, [{ type: "mdia", replace: newMdia }]);

  return newTrak;
}

function rebuildContainer(src, box, replacements) {
  const end = box.offset + box.size;
  const children = childBoxesFrom(src, box.dataOffset, end);
  const replaceMap = new Map(replacements.map(r => [r.type, r.replace]));

  let bodySize = 0;
  for (const child of children) {
    const rep = replaceMap.get(child.type);
    bodySize += rep ? rep.byteLength : child.size;
  }

  const out = new Uint8Array(8 + bodySize);
  const v = new DataView(out.buffer);
  v.setUint32(0, 8 + bodySize);
  for (let i = 0; i < 4; i++) out[4 + i] = src[box.offset + 4 + i]; // copy type
  let pos = 8;
  for (const child of children) {
    const rep = replaceMap.get(child.type);
    if (rep) {
      out.set(rep, pos); pos += rep.byteLength;
    } else {
      out.set(src.slice(child.offset, child.offset + child.size), pos); pos += child.size;
    }
  }
  return out;
}

function buildStbl(samples, chunkOffset, timescale, stsdBytes) {
  // Build: stsd(copied), stts, ctts, stss, stsz, stsc, stco
  // We use one sample per chunk (simplest valid layout)
  const n = samples.length;

  // stts: run-length of durations
  const sttsEntries = [];
  if (n > 0) {
    let count = 1, dur = samples[0].duration;
    for (let i = 1; i < n; i++) {
      if (samples[i].duration === dur) { count++; }
      else { sttsEntries.push(count, dur); count = 1; dur = samples[i].duration; }
    }
    sttsEntries.push(count, dur);
  }
  const stts = buildFullBox("stts", 0, 0, [sttsEntries.length / 2, ...sttsEntries], 4);

  // ctts: composition time offsets (only if any non-zero)
  let ctts = null;
  if (samples.some(s => s.cts !== 0)) {
    const cttsEntries = [];
    let count = 1, cts = samples[0].cts;
    for (let i = 1; i < n; i++) {
      if (samples[i].cts === cts) { count++; }
      else { cttsEntries.push(count, cts); count = 1; cts = samples[i].cts; }
    }
    cttsEntries.push(count, cts);
    ctts = buildFullBox("ctts", 1, 0, [cttsEntries.length / 2, ...cttsEntries], 4);
  }

  // stss: sync sample table (keyframes — flag bit 0x02000000 NOT set = sync)
  const syncSamples = [];
  for (let i = 0; i < n; i++) {
    if ((samples[i].flags & 0x10000) === 0) syncSamples.push(i + 1); // 1-indexed
  }
  const stss = syncSamples.length > 0 && syncSamples.length < n
    ? buildFullBox("stss", 0, 0, [syncSamples.length, ...syncSamples], 4)
    : null;

  // stsz: sample sizes
  const stsz = buildFullBox("stsz", 0, 0, [0, n, ...samples.map(s => s.size)], 4);

  // stsc: sample-to-chunk (1 sample per chunk)
  const stsc = buildFullBox("stsc", 0, 0, [n, ...samples.flatMap((_, i) => [i + 1, 1, 1])], 4);

  // stco: absolute file offsets for each chunk (1 sample per chunk)
  // sample.offset is relative to start of combined mdat payload
  // chunkOffset is the absolute file position of the mdat payload start
  const offsets = samples.map(s => chunkOffset + s.offset);
  const stco = buildFullBox("stco", 0, 0, [n, ...offsets], 4);

  const parts = [...(stsdBytes ? [stsdBytes] : []), stts, ...(ctts ? [ctts] : []), ...(stss ? [stss] : []), stsz, stsc, stco];
  const bodySize = parts.reduce((s, p) => s + p.byteLength, 0);
  const stbl = new Uint8Array(8 + bodySize);
  new DataView(stbl.buffer).setUint32(0, 8 + bodySize);
  stbl.set([115,116,98,108], 4); // "stbl"
  let pos = 8;
  for (const p of parts) { stbl.set(p, pos); pos += p.byteLength; }
  return stbl;
}

function buildFullBox(type, version, flags, values, bytesPerValue) {
  const size = 12 + values.length * bytesPerValue;
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  v.setUint32(0, size);
  for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
  buf[8] = version;
  v.setUint32(8, (version << 24) | (flags & 0xFFFFFF));
  let pos = 12;
  for (const val of values) {
    if (bytesPerValue === 4) v.setUint32(pos, val >>> 0);
    else if (bytesPerValue === 8) { v.setUint32(pos, 0); v.setUint32(pos + 4, val >>> 0); }
    pos += bytesPerValue;
  }
  return buf;
}

function patchDurations(moov, totalDurationSeconds) {
  if (!totalDurationSeconds) return;
  const view = new DataView(moov.buffer);

  // First pass: find mvhd timescale (needed for tkhd)
  const mvhdTs = getMvhdTimescale(moov, view);

  function setDur(durOff, version, timescale) {
    const dur = Math.round(totalDurationSeconds * timescale);
    if (version === 0) view.setUint32(durOff, dur);
    else { view.setUint32(durOff, 0); view.setUint32(durOff + 4, dur); }
  }

  function walk(start, end) {
    let pos = start;
    while (pos + 8 <= end) {
      const size = view.getUint32(pos);
      if (size < 8 || pos + size > moov.length) break;
      const type = String.fromCharCode(moov[pos+4], moov[pos+5], moov[pos+6], moov[pos+7]);

      // Recurse into containers
      if (type === "trak" || type === "mdia" || type === "minf") {
        walk(pos + 8, pos + size);
      }

      if (type === "mvhd" || type === "mdhd") {
        const version = moov[pos + 8];
        const tsOff  = version === 1 ? pos + 20 : pos + 12;
        const durOff = version === 1 ? pos + 28 : pos + 16;
        const ts = view.getUint32(tsOff);
        if (ts > 0) setDur(durOff, version, ts);
      }

      if (type === "tkhd") {
        // tkhd v0: size(4)+type(4)+v(1)+flags(3)+ctime(4)+mtime(4)+trackid(4)+reserved(4)+duration(4)
        // tkhd v1: size(4)+type(4)+v(1)+flags(3)+ctime(8)+mtime(8)+trackid(4)+reserved(4)+duration(8)
        const version = moov[pos + 8];
        const durOff = version === 1 ? pos + 36 : pos + 28;
        if (mvhdTs > 0) setDur(durOff, version, mvhdTs);
      }

      pos += size;
    }
  }

  walk(8, moov.length);
}

function getMvhdTimescale(moov, view) {
  // Scan only top-level moov children (mvhd is always a direct child)
  let pos = 8;
  while (pos + 8 <= moov.length) {
    const size = view.getUint32(pos);
    if (size < 8 || pos + size > moov.length) break;
    const type = String.fromCharCode(moov[pos+4], moov[pos+5], moov[pos+6], moov[pos+7]);
    if (type === "mvhd") {
      const version = moov[pos + 8];
      return view.getUint32(version === 1 ? pos + 20 : pos + 12);
    }
    pos += size;
  }
  return 1;
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
