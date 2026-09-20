import { afterEach, describe, expect, it, vi } from "vitest";
import { isWindowsClient } from "./client-platform.js";
afterEach(() => vi.unstubAllGlobals());
describe("client platform and cursor preferences", () => {
  it.each([
    [{ userAgentData: { platform: "Windows" } }, true],
    [{ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140 Electron/38" }, true],
    [{ platform: "Win32", userAgent: "Firefox/140" }, true],
    [{ userAgent: "Mozilla/5.0 (Windows NT 10.0)" }, true],
    [{ platform: "MacIntel" }, false],
    [{ platform: "Linux x86_64" }, false],
    [{ platform: "Linux armv8l", userAgent: "Android" }, false],
    [{ platform: "Win32", userAgent: "Windows Phone" }, false],
    [{}, false],
  ])("detects the client OS from %j", (platform, expected) => {
    expect(isWindowsClient(platform)).toBe(expected);
  });
});
