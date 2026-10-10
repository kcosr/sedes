// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ available: true, setDiagnosticsEnabled: vi.fn(), readDiagnostics: vi.fn(), clearDiagnostics: vi.fn() }));
vi.mock("./native-voice-plugin.js", () => ({ hasNativeVoice: () => bridge.available, nativeVoice: bridge }));
import { clearCopyDiagnostics, clearDiagnostics, copyDiagnostics, readDiagnostics, recordSeekDiagnostic } from "../app/diagnostics.js";
import { getDiagnosticCategoryEnabled, setDiagnosticCategoryEnabled } from "../app/settings.js";
import { installNativeVoiceDiagnostics, nativeVoiceDiagnosticsSchema, readNativeVoiceDiagnostics } from "./native-voice-diagnostics.js";

const entry = { sequence: 1, wallTimeMilliseconds: 123456, elapsedMilliseconds: 300, event: "playback_drained",
  sourceEventId: "a".repeat(64), eventKind: "turn.completed", connectionGeneration: 1, streamGeneration: 2,
  policyGeneration: 0, queueCount: 0, queueBytes: 0, chunkIndex: 1 };
const snapshot = () => ({ enabled: false, maximumEntries: 512, entries: [entry] });
let uninstall: (() => void) | undefined;
beforeEach(() => {
  bridge.available = true;
  bridge.setDiagnosticsEnabled.mockResolvedValue(undefined);
  bridge.readDiagnostics.mockResolvedValue(snapshot());
  bridge.clearDiagnostics.mockResolvedValue(undefined);
});
afterEach(() => { uninstall?.(); uninstall = undefined; localStorage.clear(); clearDiagnostics(); vi.resetAllMocks(); });

describe("native voice diagnostics", () => {
  it("starts disabled, synchronizes the saved device opt-in, and unsubscribes without a voice binding", () => {
    uninstall = installNativeVoiceDiagnostics();
    expect(bridge.setDiagnosticsEnabled).toHaveBeenLastCalledWith({ enabled: false });
    setDiagnosticCategoryEnabled("voice", true);
    expect(getDiagnosticCategoryEnabled("voice")).toBe(true);
    expect(bridge.setDiagnosticsEnabled).toHaveBeenLastCalledWith({ enabled: true });
    uninstall(); uninstall = installNativeVoiceDiagnostics();
    expect(bridge.setDiagnosticsEnabled).toHaveBeenLastCalledWith({ enabled: true });
    setDiagnosticCategoryEnabled("voice", false);
    expect(bridge.setDiagnosticsEnabled).toHaveBeenLastCalledWith({ enabled: false });
    uninstall(); uninstall = undefined;
    const calls = bridge.setDiagnosticsEnabled.mock.calls.length;
    setDiagnosticCategoryEnabled("voice", true);
    expect(bridge.setDiagnosticsEnabled).toHaveBeenCalledTimes(calls);
  });
  it("copies retained native entries while disabled alongside browser entries and clears both", async () => {
    setDiagnosticCategoryEnabled("seek", true);
    recordSeekDiagnostic("seek_pin_engaged", { spacerHeight: 20 });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await copyDiagnostics();
    const output = JSON.parse(writeText.mock.calls[0]![0]);
    expect(output.enabledCategories).toEqual(["seek"]);
    expect(output.entries).toHaveLength(1);
    expect(output.nativeVoice).toEqual(snapshot());
    await clearCopyDiagnostics();
    expect(readDiagnostics()).toEqual([]);
    expect(bridge.clearDiagnostics).toHaveBeenCalledOnce();
  });
  it("strips unknown fields and rejects arbitrary identifiers, reason text, and oversized native results", async () => {
    bridge.readDiagnostics.mockResolvedValue({ ...snapshot(), credential: "private credential", entries: [{ ...entry,
      threadId: "private thread", text: "private speech", title: "private title", error: "private error" }] });
    expect(JSON.stringify(await readNativeVoiceDiagnostics())).not.toContain("private");
    for (const patch of [{ sourceEventId: "private identifier" }, { eventKind: "private speech" }, { reason: "private error" },
      { event: "private title" }, { queueCount: 65 }, { queueBytes: 256 * 1024 + 1 }, { elapsedMilliseconds: Infinity }]) {
      expect(nativeVoiceDiagnosticsSchema.safeParse({ ...snapshot(), entries: [{ ...entry, ...patch }] }).success).toBe(false);
    }
    expect(nativeVoiceDiagnosticsSchema.safeParse({ ...snapshot(), entries: Array.from({ length: 513 }, () => entry) }).success).toBe(false);
  });
  it("keeps bridge failure content out of export and never breaks settings on diagnostic failures", async () => {
    bridge.setDiagnosticsEnabled.mockRejectedValue(new Error("private native failure"));
    uninstall = installNativeVoiceDiagnostics();
    expect(() => setDiagnosticCategoryEnabled("voice", true)).not.toThrow();
    bridge.readDiagnostics.mockRejectedValue(new Error("private native failure"));
    expect(await readNativeVoiceDiagnostics()).toEqual({ status: "unavailable" });
    bridge.setDiagnosticsEnabled.mockImplementation(() => { throw new Error("private native failure"); });
    expect(() => setDiagnosticCategoryEnabled("voice", false)).not.toThrow();
    await Promise.resolve();
  });
  it("does not invoke native methods without the Android plugin", async () => {
    bridge.available = false;
    uninstall = installNativeVoiceDiagnostics();
    setDiagnosticCategoryEnabled("voice", true);
    expect(await readNativeVoiceDiagnostics()).toBeUndefined();
    await clearCopyDiagnostics();
    expect(bridge.setDiagnosticsEnabled).not.toHaveBeenCalled();
    expect(bridge.readDiagnostics).not.toHaveBeenCalled();
    expect(bridge.clearDiagnostics).not.toHaveBeenCalled();
  });
});
