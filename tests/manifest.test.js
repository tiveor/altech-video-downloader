const fs = require("fs");
const path = require("path");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf-8")
);

describe("manifest.json", () => {
  test("uses Manifest V3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  test("has required fields", () => {
    expect(manifest.name).toBeDefined();
    expect(manifest.version).toBeDefined();
    expect(manifest.description).toBeDefined();
  });

  test("version follows semver format", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("has a background service worker", () => {
    expect(manifest.background).toBeDefined();
    expect(manifest.background.service_worker).toBe("background.js");
  });

  test("has action with popup", () => {
    expect(manifest.action).toBeDefined();
    expect(manifest.action.default_popup).toBe("popup.html");
  });

  test("has required icons", () => {
    expect(manifest.icons["16"]).toBe("icons/icon16.png");
    expect(manifest.icons["48"]).toBe("icons/icon48.png");
    expect(manifest.icons["128"]).toBe("icons/icon128.png");
  });

  test("action has matching icons", () => {
    expect(manifest.action.default_icon["16"]).toBe("icons/icon16.png");
    expect(manifest.action.default_icon["48"]).toBe("icons/icon48.png");
    expect(manifest.action.default_icon["128"]).toBe("icons/icon128.png");
  });

  test("all icon files exist", () => {
    const sizes = ["16", "48", "128"];
    for (const size of sizes) {
      const iconPath = path.join(__dirname, "..", manifest.icons[size]);
      expect(fs.existsSync(iconPath)).toBe(true);
    }
  });

  test("has required permissions", () => {
    expect(manifest.permissions).toContain("activeTab");
    expect(manifest.permissions).toContain("scripting");
    expect(manifest.permissions).toContain("downloads");
    expect(manifest.permissions).toContain("webRequest");
    expect(manifest.permissions).toContain("storage");
    expect(manifest.permissions).toContain("offscreen");
  });

  test("uses optional_host_permissions instead of host_permissions", () => {
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toContain("<all_urls>");
  });

  test("has content scripts", () => {
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0].js).toContain("content.js");
    expect(manifest.content_scripts[0].run_at).toBe("document_idle");
  });

  test("all referenced files exist", () => {
    const files = [
      manifest.background.service_worker,
      manifest.action.default_popup,
      ...manifest.content_scripts[0].js,
    ];
    for (const file of files) {
      expect(fs.existsSync(path.join(__dirname, "..", file))).toBe(true);
    }
  });

  test("description is under 132 characters", () => {
    expect(manifest.description.length).toBeLessThanOrEqual(132);
  });

  test("name is not empty", () => {
    expect(manifest.name.length).toBeGreaterThan(0);
  });
});
