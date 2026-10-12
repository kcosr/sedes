import { describe, expect, it } from "vitest";
import { allowsPageFrameNavigation } from "../../electron/page-frame-policy.js";

describe("Electron page frame navigation", () => {
  const url = `https://sedes.example/page-render/${"a".repeat(43)}#channel=1234567890123456`;
  it("admits exact initial page URLs from the packaged renderer", () => {
    expect(allowsPageFrameNavigation({ isMainFrame: false, url, initiatorUrl: "capacitor-electron://localhost/index.html" })).toBe(true);
  });
  it("admits a local srcdoc only from the trusted wrapper", () => {
    expect(allowsPageFrameNavigation({ isMainFrame: false, url: "about:srcdoc", initiatorUrl: url })).toBe(true);
    for (const initiatorUrl of ["about:srcdoc", "https://attacker.test/", "https://sedes.example/api/auth/status"]) {
      expect(allowsPageFrameNavigation({ isMainFrame: false, url: "about:srcdoc", initiatorUrl })).toBe(false);
    }
  });
  it("denies page-initiated navigation, redirects to APIs, and unknown initiators", () => {
    for (const initiatorUrl of [url, "https://attacker.test", "capacitor-electron://localhost.attacker/index.html", undefined]) {
      expect(allowsPageFrameNavigation({ isMainFrame: false, url, ...(initiatorUrl ? { initiatorUrl } : {}) })).toBe(false);
    }
    for (const destination of ["https://sedes.example/api/auth/status", `${url.split("#")[0]}?other=1`, "data:text/html,test", "file:///tmp/mockup.html"]) {
      expect(allowsPageFrameNavigation({ isMainFrame: false, url: destination, initiatorUrl: "capacitor-electron://localhost/" })).toBe(false);
    }
  });
});
