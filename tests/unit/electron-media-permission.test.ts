import { describe, expect, it } from "vitest";
import { allowsPackagedPermission } from "../../electron/media-permission-policy.js";

const audio = { permission: "media", requestingUrl: "capacitor-electron://localhost/index.html", isMainFrame: true, mediaTypes: ["audio"] };

describe("Electron microphone permissions", () => {
  it("allows audio and clipboard writes only in the packaged main frame", () => {
    expect(allowsPackagedPermission(audio)).toBe(true);
    expect(allowsPackagedPermission({ ...audio, permission: "clipboard-sanitized-write", mediaTypes: undefined })).toBe(true);
    expect(allowsPackagedPermission({ ...audio, isMainFrame: false })).toBe(false);
  });
  it.each([[], ["video"], ["audio", "video"], ["unknown"], undefined])("denies ambiguous or non-audio media requests %j", mediaTypes => {
    expect(allowsPackagedPermission({ ...audio, mediaTypes })).toBe(false);
  });
  it.each(["display-capture", "notifications", "clipboard-read", "geolocation"])("denies %s", permission => {
    expect(allowsPackagedPermission({ ...audio, permission })).toBe(false);
  });
  it.each(["https://localhost/", "capacitor-electron://elsewhere/", "capacitor-electron://localhost:123/", "capacitor-electron://user@localhost/", "file:///tmp/dialog.html", "about:blank", "invalid"])("denies an untrusted request from %s", requestingUrl => {
    expect(allowsPackagedPermission({ ...audio, requestingUrl })).toBe(false);
  });
});
