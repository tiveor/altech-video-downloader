const fs = require("fs");
const path = require("path");

// ─── Test popup utility functions ────────────────────────────────────────────
// We extract and test the pure functions from popup.js

let escapeHtml, sanitizeFilename;

beforeEach(() => {
  // Mock DOM elements
  const mockElement = {
    classList: { remove: jest.fn(), add: jest.fn() },
    textContent: "",
    className: "",
    innerHTML: "",
    querySelectorAll: jest.fn(() => []),
    addEventListener: jest.fn(),
    setAttribute: jest.fn(),
    getAttribute: jest.fn(),
    insertBefore: jest.fn(),
    appendChild: jest.fn(),
    disabled: false,
  };

  global.document = {
    getElementById: jest.fn(() => ({ ...mockElement })),
    createElement: jest.fn(() => ({ ...mockElement })),
    querySelector: jest.fn(() => null),
  };

  global.chrome = {
    runtime: {
      onMessage: { addListener: jest.fn() },
      sendMessage: jest.fn((msg, cb) => {
        if (cb) {
          if (msg.type === "GET_VIDEOS") cb({ videos: [] });
          else if (msg.type === "CHECK_PERMISSION") cb({ granted: true });
          else cb({});
        }
      }),
      lastError: null,
    },
    tabs: {
      query: jest.fn((q, cb) => cb([{ id: 1 }])),
    },
    permissions: {
      request: jest.fn((p, cb) => cb(true)),
    },
  };

  // Load popup.js and extract functions
  const src = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf-8");
  const fn = new Function(
    "document", "chrome", "setTimeout",
    src + "\nreturn { escapeHtml, sanitizeFilename };"
  );
  const exports = fn(global.document, global.chrome, jest.fn((cb) => cb()));
  escapeHtml = exports.escapeHtml;
  sanitizeFilename = exports.sanitizeFilename;
});

// ─── escapeHtml ──────────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  test("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  test("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert('xss')</script>"))
      .toBe("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
  });

  test("escapes double quotes", () => {
    expect(escapeHtml('file "name"')).toBe("file &quot;name&quot;");
  });

  test("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  test("handles strings with no special characters", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("handles numbers by converting to string", () => {
    expect(escapeHtml(42)).toBe("42");
  });

  test("escapes all special chars in combination", () => {
    expect(escapeHtml('<a href="test">foo & bar\'s</a>'))
      .toBe("&lt;a href=&quot;test&quot;&gt;foo &amp; bar&#39;s&lt;/a&gt;");
  });
});

// ─── sanitizeFilename ────────────────────────────────────────────────────────

describe("sanitizeFilename", () => {
  test("preserves alphanumeric and safe chars", () => {
    expect(sanitizeFilename("video-file_2024.mp4")).toBe("video-file_2024.mp4");
  });

  test("replaces special characters with underscores", () => {
    expect(sanitizeFilename("file@#$%^&.mp4")).toBe("file______.mp4");
  });

  test("preserves parentheses and spaces", () => {
    expect(sanitizeFilename("video (1).mp4")).toBe("video (1).mp4");
  });

  test("truncates to 80 characters", () => {
    const long = "a".repeat(100) + ".mp4";
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(80);
  });

  test("handles URL-encoded characters", () => {
    const result = sanitizeFilename("video%20file%2B1.mp4");
    // % gets replaced with _
    expect(result).toBe("video_20file_2B1.mp4");
  });
});
