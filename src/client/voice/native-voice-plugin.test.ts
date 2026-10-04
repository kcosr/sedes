import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ getState: vi.fn(), disconnect: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isPluginAvailable: () => true }, registerPlugin: () => bridge }));
vi.mock("../app/client-platform.js", () => ({ isAndroidClient: () => true }));

import { disconnectNativeVoice, nativeThreadTitle } from "./native-voice-plugin.js";
import { voiceSnapshot } from "./native-voice-test-fixture.js";

afterEach(() => { vi.resetAllMocks(); });

describe("native voice bridge helpers", () => {
  it("sends trimmed thread titles within native's 512 UTF-16 unit limit and untitled threads as null", () => {
    expect(nativeThreadTitle("  Release review  ")).toBe("Release review");
    expect(nativeThreadTitle("")).toBeNull();
    expect(nativeThreadTitle(" \n\t ")).toBeNull();
    expect(nativeThreadTitle("a".repeat(512))).toBe("a".repeat(512));
    expect(nativeThreadTitle(`  ${"a".repeat(600)}`)).toBe("a".repeat(512));
    expect(nativeThreadTitle(`${"a".repeat(511)}😀tail`)).toBe("a".repeat(511));
    expect(nativeThreadTitle(`${"a".repeat(510)}😀tail`)).toBe(`${"a".repeat(510)}😀`);
    expect(nativeThreadTitle(`${"a".repeat(505)}       tail`)).toBe("a".repeat(505));
  });
  it("disconnects the current native generation and treats bridge failures as best effort", async () => {
    bridge.getState.mockResolvedValue(voiceSnapshot({ connectionGeneration: 7 }));
    bridge.disconnect.mockResolvedValue(voiceSnapshot());
    await disconnectNativeVoice();
    expect(bridge.disconnect).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 7 });
    bridge.disconnect.mockRejectedValue(Object.assign(new Error("The Sedes connection changed."), { code: "connection_changed" }));
    await expect(disconnectNativeVoice()).resolves.toBeUndefined();
    bridge.getState.mockRejectedValue(new Error("Voice returned an invalid state."));
    await expect(disconnectNativeVoice()).resolves.toBeUndefined();
  });
});
