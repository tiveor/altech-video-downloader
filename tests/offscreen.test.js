const fs = require("fs");
const path = require("path");

// Extract pure functions from offscreen.js by eval'ing with mocked globals
let parseMasterPlaylist, parseMediaPlaylist, resolveUrl, sanitizeFilename;
let buildFtyp, buildFullBox, buildMdhd;

beforeEach(() => {
  // Mock globals that offscreen.js expects
  global.chrome = {
    runtime: {
      onMessage: { addListener: jest.fn() },
      sendMessage: jest.fn(() => Promise.resolve()),
    },
  };
  global.muxjs = { mp4: { Transmuxer: jest.fn() } };
  global.fetch = jest.fn();
  global.Blob = jest.fn();
  global.URL = { createObjectURL: jest.fn(() => "blob:mock") };

  const src = fs.readFileSync(path.join(__dirname, "..", "offscreen.js"), "utf-8");
  const fn = new Function("chrome", "muxjs", "fetch", "Blob", "URL", "console", src + `
    return {
      parseMasterPlaylist, parseMediaPlaylist, resolveUrl, sanitizeFilename,
      buildFtyp, buildFullBox, buildMdhd,
    };
  `);
  const exports = fn(global.chrome, global.muxjs, global.fetch, global.Blob, global.URL, console);
  parseMasterPlaylist = exports.parseMasterPlaylist;
  parseMediaPlaylist = exports.parseMediaPlaylist;
  resolveUrl = exports.resolveUrl;
  sanitizeFilename = exports.sanitizeFilename;
  buildFtyp = exports.buildFtyp;
  buildFullBox = exports.buildFullBox;
  buildMdhd = exports.buildMdhd;
});

// ─── parseMasterPlaylist ─────────────────────────────────────────────────────

describe("parseMasterPlaylist", () => {
  test("parses variants with bandwidth and resolution", () => {
    const lines = [
      "#EXTM3U",
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480',
      "low/stream.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720',
      "mid/stream.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=7680000,RESOLUTION=1920x1080',
      "high/stream.m3u8",
    ];
    const baseUrl = "https://cdn.example.com/master.m3u8";
    const variants = parseMasterPlaylist(lines, baseUrl);

    expect(variants).toHaveLength(3);
    expect(variants[0].bandwidth).toBe(1280000);
    expect(variants[0].resolution).toBe("720x480");
    expect(variants[0].url).toBe("https://cdn.example.com/low/stream.m3u8");
    expect(variants[2].bandwidth).toBe(7680000);
    expect(variants[2].url).toBe("https://cdn.example.com/high/stream.m3u8");
  });

  test("handles absolute variant URLs", () => {
    const lines = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=1000000",
      "https://other-cdn.com/stream.m3u8",
    ];
    const variants = parseMasterPlaylist(lines, "https://cdn.example.com/master.m3u8");

    expect(variants).toHaveLength(1);
    expect(variants[0].url).toBe("https://other-cdn.com/stream.m3u8");
  });

  test("returns empty for non-master playlist", () => {
    const lines = [
      "#EXTM3U",
      "#EXTINF:10.0,",
      "segment-0.ts",
    ];
    const variants = parseMasterPlaylist(lines, "https://cdn.example.com/stream.m3u8");
    expect(variants).toHaveLength(0);
  });

  test("skips lines that are comments after STREAM-INF", () => {
    const lines = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=500000",
      "#some-comment",
    ];
    const variants = parseMasterPlaylist(lines, "https://cdn.example.com/master.m3u8");
    expect(variants).toHaveLength(0);
  });

  test("handles missing BANDWIDTH attribute", () => {
    const lines = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:RESOLUTION=1280x720",
      "stream.m3u8",
    ];
    const variants = parseMasterPlaylist(lines, "https://cdn.example.com/master.m3u8");
    expect(variants).toHaveLength(1);
    expect(variants[0].bandwidth).toBe(0);
  });
});

// ─── parseMediaPlaylist ──────────────────────────────────────────────────────

describe("parseMediaPlaylist", () => {
  test("parses segments with durations", () => {
    const lines = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:10",
      "#EXTINF:10.0,",
      "segment-0.ts",
      "#EXTINF:10.0,",
      "segment-1.ts",
      "#EXTINF:8.5,",
      "segment-2.ts",
      "#EXT-X-ENDLIST",
    ];
    const baseUrl = "https://cdn.example.com/stream.m3u8";
    const result = parseMediaPlaylist(lines, baseUrl);

    expect(result.segmentUrls).toHaveLength(3);
    expect(result.segmentUrls[0]).toBe("https://cdn.example.com/segment-0.ts");
    expect(result.segmentUrls[2]).toBe("https://cdn.example.com/segment-2.ts");
    expect(result.segmentDurations).toEqual([10.0, 10.0, 8.5]);
    expect(result.totalDuration).toBeCloseTo(28.5);
  });

  test("handles absolute segment URLs", () => {
    const lines = [
      "#EXTM3U",
      "#EXTINF:10.0,",
      "https://other-cdn.com/segment-0.ts",
    ];
    const result = parseMediaPlaylist(lines, "https://cdn.example.com/stream.m3u8");
    expect(result.segmentUrls[0]).toBe("https://other-cdn.com/segment-0.ts");
  });

  test("returns empty for playlist with no segments", () => {
    const lines = ["#EXTM3U", "#EXT-X-ENDLIST"];
    const result = parseMediaPlaylist(lines, "https://cdn.example.com/stream.m3u8");
    expect(result.segmentUrls).toHaveLength(0);
    expect(result.totalDuration).toBe(0);
  });

  test("handles segments with query parameters", () => {
    const lines = [
      "#EXTM3U",
      "#EXTINF:6.0,",
      "seg.ts?token=abc&expires=123",
    ];
    const result = parseMediaPlaylist(lines, "https://cdn.example.com/stream.m3u8");
    expect(result.segmentUrls[0]).toBe("https://cdn.example.com/seg.ts?token=abc&expires=123");
    expect(result.segmentDurations).toEqual([6.0]);
  });

  test("handles EXTINF without trailing comma", () => {
    const lines = [
      "#EXTM3U",
      "#EXTINF:10.0",
      "segment-0.ts",
    ];
    const result = parseMediaPlaylist(lines, "https://cdn.example.com/stream.m3u8");
    // parseFloat("10.0") = 10.0 even though it starts with "#EXTINF:"
    // The code slices from index 8 which is after "#EXTINF:"
    expect(result.segmentDurations[0]).toBe(10.0);
  });
});

// ─── resolveUrl ──────────────────────────────────────────────────────────────

describe("resolveUrl", () => {
  // Restore real URL for these tests
  beforeEach(() => {
    global.URL = globalThis.URL || require("url").URL;
  });

  test("returns absolute URLs as-is", () => {
    expect(resolveUrl("https://cdn.example.com/video.ts", "https://other.com/m.m3u8"))
      .toBe("https://cdn.example.com/video.ts");
  });

  test("returns http URLs as-is", () => {
    expect(resolveUrl("http://cdn.example.com/video.ts", "https://other.com/m.m3u8"))
      .toBe("http://cdn.example.com/video.ts");
  });

  test("resolves relative URLs against base", () => {
    expect(resolveUrl("segment-0.ts", "https://cdn.example.com/live/stream.m3u8"))
      .toBe("https://cdn.example.com/live/segment-0.ts");
  });

  test("resolves path-relative URLs", () => {
    const result = resolveUrl("../other/seg.ts", "https://cdn.example.com/live/stream.m3u8");
    // Node URL may not normalize .., but it should contain the correct components
    expect(result).toContain("other/seg.ts");
    expect(result).toContain("cdn.example.com");
  });

  test("resolves root-relative URLs", () => {
    const result = resolveUrl("/videos/seg.ts", "https://cdn.example.com/live/stream.m3u8");
    expect(result).toContain("cdn.example.com");
    expect(result).toContain("/videos/seg.ts");
  });
});

// ─── sanitizeFilename ────────────────────────────────────────────────────────

describe("sanitizeFilename", () => {
  test("preserves safe characters", () => {
    expect(sanitizeFilename("video_file-2024.mp4")).toBe("video_file-2024.mp4");
  });

  test("replaces unsafe characters with underscores", () => {
    expect(sanitizeFilename("video<>:\"/\\|?*.mp4")).toBe("video_________.mp4");
  });

  test("replaces spaces with underscores", () => {
    expect(sanitizeFilename("my video file.mp4")).toBe("my_video_file.mp4");
  });

  test("truncates to 80 characters", () => {
    const long = "a".repeat(100);
    expect(sanitizeFilename(long)).toHaveLength(80);
  });

  test("handles empty-ish input", () => {
    expect(sanitizeFilename("")).toBe("");
  });
});

// ─── buildFtyp ───────────────────────────────────────────────────────────────

describe("buildFtyp", () => {
  test("produces 32-byte ftyp box", () => {
    const ftyp = buildFtyp();
    expect(ftyp.byteLength).toBe(32);
  });

  test("has correct box type", () => {
    const ftyp = buildFtyp();
    const type = String.fromCharCode(ftyp[4], ftyp[5], ftyp[6], ftyp[7]);
    expect(type).toBe("ftyp");
  });

  test("has correct size in header", () => {
    const ftyp = buildFtyp();
    const view = new DataView(ftyp.buffer);
    expect(view.getUint32(0)).toBe(32);
  });

  test("has isom as major brand", () => {
    const ftyp = buildFtyp();
    const major = String.fromCharCode(ftyp[8], ftyp[9], ftyp[10], ftyp[11]);
    expect(major).toBe("isom");
  });

  test("contains expected compatible brands", () => {
    const ftyp = buildFtyp();
    const brands = [];
    for (let i = 16; i < 32; i += 4) {
      brands.push(String.fromCharCode(ftyp[i], ftyp[i+1], ftyp[i+2], ftyp[i+3]));
    }
    expect(brands).toEqual(["isom", "iso2", "avc1", "mp41"]);
  });
});

// ─── buildMdhd ───────────────────────────────────────────────────────────────

describe("buildMdhd", () => {
  test("produces 32-byte mdhd box", () => {
    const mdhd = buildMdhd(90000, 900000);
    expect(mdhd.byteLength).toBe(32);
  });

  test("has correct box type", () => {
    const mdhd = buildMdhd(90000, 900000);
    const type = String.fromCharCode(mdhd[4], mdhd[5], mdhd[6], mdhd[7]);
    expect(type).toBe("mdhd");
  });

  test("stores timescale correctly", () => {
    const mdhd = buildMdhd(90000, 900000);
    const view = new DataView(mdhd.buffer);
    expect(view.getUint32(20)).toBe(90000);
  });

  test("stores duration correctly", () => {
    const mdhd = buildMdhd(90000, 900000);
    const view = new DataView(mdhd.buffer);
    expect(view.getUint32(24)).toBe(900000);
  });

  test("sets language to 'und'", () => {
    const mdhd = buildMdhd(90000, 900000);
    const view = new DataView(mdhd.buffer);
    expect(view.getUint16(28)).toBe(0x55C4);
  });

  test("handles audio timescale", () => {
    const mdhd = buildMdhd(44100, 441000);
    const view = new DataView(mdhd.buffer);
    expect(view.getUint32(20)).toBe(44100);
    expect(view.getUint32(24)).toBe(441000);
  });
});

// ─── buildFullBox ────────────────────────────────────────────────────────────

describe("buildFullBox", () => {
  test("builds box with correct size and type", () => {
    const box = buildFullBox("stts", 0, 0, [1, 100, 10], 4);
    const view = new DataView(box.buffer);
    expect(view.getUint32(0)).toBe(12 + 3 * 4); // 24
    const type = String.fromCharCode(box[4], box[5], box[6], box[7]);
    expect(type).toBe("stts");
  });

  test("sets version and flags", () => {
    const box = buildFullBox("ctts", 1, 0, [1, 0, 5], 4);
    const view = new DataView(box.buffer);
    const versionFlags = view.getUint32(8);
    expect(versionFlags >> 24).toBe(1); // version
  });

  test("writes values correctly", () => {
    const box = buildFullBox("stsz", 0, 0, [0, 3, 100, 200, 300], 4);
    const view = new DataView(box.buffer);
    expect(view.getUint32(12)).toBe(0);   // default sample size
    expect(view.getUint32(16)).toBe(3);   // sample count
    expect(view.getUint32(20)).toBe(100);
    expect(view.getUint32(24)).toBe(200);
    expect(view.getUint32(28)).toBe(300);
  });
});
