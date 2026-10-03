import { describe, expect, it, vi } from "vitest";
import { NativeVoiceStore } from "./NativeVoiceStore.js";
import type { NativeVoicePlugin, NativeVoiceState } from "./native-voice-plugin.js";

function snapshot(patch: Partial<NativeVoiceState> = {}): NativeVoiceState {
  return {
    version: 1, stateRevision: 1, connectionGeneration: 1, profileId: "profile", serverOrigin: "https://sedes.test",
    identity: "identity", originClientId: "34612c41-0bbb-455f-a5af-725bfc7ae768", settingsRevision: 0,
    settings: { audioMode: "off", autoListen: true, ignoreOtherDevices: true, readNotificationContext: true,
      adapterUrl: "", adapterTextLimit: 5000, voiceThreadId: null, voiceThreadTitle: null, onlyVoiceThread: false, followComposerMode: false,
      inputDeviceId: null, recognitionStartTimeoutMs: 30000, recognitionCompletionTimeoutMs: 60000, recognitionEndSilenceMs: 1200,
      recognizeStopCommand: true, recognitionCues: true, cueGain: 100, startupPreRollMs: 512, ttsGain: 100, headsetControls: true },
    phase: "off", ready: false, readiness: "off", foreground: { visible: false, threadId: null, threadTitle: null }, active: null,
    queue: { count: 0, bytes: 0, droppedCount: 0, droppedReasons: {} },
    actions: { canStart: false, canStop: false, canSkip: false, canRetarget: false, canResume: false }, recovery: [], errors: [], ...patch,
  };
}
function fixture() {
  const listeners = new Map<string, (value: unknown) => void>();
  const remove = vi.fn(async () => {});
  const plugin = {
    setConnection: vi.fn(async () => snapshot()), getState: vi.fn(async () => snapshot()),
    updateSettings: vi.fn(async () => snapshot()), disconnect: vi.fn(),
    addListener: vi.fn(async (event: string, listener: (value: unknown) => void) => { listeners.set(event, listener); return { remove }; }),
  };
  const open = vi.fn();
  const store = new NativeVoiceStore(plugin as unknown as NativeVoicePlugin, { profileId: "profile", serverOrigin: "https://sedes.test", identity: "identity" }, open);
  return { store, plugin, listeners, open, remove };
}
const openEvent = (threadId: string, profileId = "profile") => ({ threadId, profileId,
  serverOrigin: "https://sedes.test", identity: "identity", connectionGeneration: 1 });
describe("native voice state authority", () => {
  it("retains a notification open until native hydration and supports retry after transient startup failure", async () => {
    const { store, plugin, listeners, open } = fixture();
    plugin.setConnection.mockImplementationOnce(async () => {
      listeners.get("openThread")!(openEvent("notification-target"));
      throw new Error("Server unavailable");
    });
    await store.initialize();
    expect(open).not.toHaveBeenCalled();
    expect(store.getSnapshot().error).toBe("Server unavailable");
    await store.reconnect();
    expect(open).toHaveBeenCalledExactlyOnceWith("notification-target");
    expect(store.getSnapshot().native?.originClientId).toBeDefined();
    expect(store.getSnapshot().error).toBeUndefined();
    store.dispose();
  });
  it("rejects a stale resume read after a newer native playback/settings event", async () => {
    const { store, plugin, listeners } = fixture();
    await store.initialize();
    let resolve!: (state: NativeVoiceState) => void;
    plugin.getState.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const refresh = store.refresh();
    const newer = snapshot({ stateRevision: 7, settingsRevision: 3, phase: "speaking" });
    listeners.get("stateChanged")!(newer);
    resolve(snapshot({ stateRevision: 2 }));
    await refresh;
    expect(store.getSnapshot().native).toEqual(newer);
    store.dispose();
  });
  it("refreshes the native settings revision and sends only the user's patch", async () => {
    const { store, plugin } = fixture();
    await store.initialize();
    const latest = snapshot({ stateRevision: 8, settingsRevision: 5 });
    plugin.getState.mockResolvedValue(latest);
    plugin.updateSettings.mockResolvedValue(snapshot({ ...latest, stateRevision: 9, settingsRevision: 6 }));
    await store.update({ autoListen: false });
    expect(plugin.updateSettings).toHaveBeenCalledWith({ expectedConnectionGeneration: 1, expectedRevision: 5, patch: { autoListen: false } });
    expect(store.getSnapshot().pending).toBe(false);
    store.dispose();
  });
  it("does not apply settings after the active native profile changes during hydration", async () => {
    const { store, plugin } = fixture();
    await store.initialize();
    plugin.getState.mockResolvedValue(snapshot({ profileId: "other", connectionGeneration: 2 }));
    await expect(store.update({ audioMode: "response" })).rejects.toThrow("no longer active");
    expect(plugin.updateSettings).not.toHaveBeenCalled();
    store.dispose();
  });
  it("fences old-profile callbacks and does not stop native work on WebView disposal", async () => {
    const { store, plugin, listeners, remove, open } = fixture();
    await store.initialize();
    listeners.get("stateChanged")!(snapshot({ profileId: "other", connectionGeneration: 0, stateRevision: 99 }));
    expect(store.getSnapshot().native?.stateRevision).toBe(1);
    listeners.get("openThread")!(openEvent("foreign", "other"));
    listeners.get("openThread")!(openEvent("own"));
    expect(open).toHaveBeenCalledExactlyOnceWith("own");
    store.dispose();
    expect(remove).toHaveBeenCalledTimes(4);
    expect(plugin.disconnect).not.toHaveBeenCalled();
    await expect(store.update({ autoListen: false })).rejects.toThrow("no longer active");
  });
  it("clears stale controls on native disconnect and fences older queued snapshots", async () => {
    const { store, listeners } = fixture();
    await store.initialize();
    listeners.get("stateChanged")!(snapshot({ connectionGeneration: 2, stateRevision: 1, profileId: null, serverOrigin: null, identity: null, originClientId: null }));
    expect(store.getSnapshot().native).toBeUndefined();
    expect(() => store.commandContext()).toThrow("no longer active");
    listeners.get("stateChanged")!(snapshot({ connectionGeneration: 1, stateRevision: 200, ready: true }));
    expect(store.getSnapshot().native).toBeUndefined();
    store.dispose();
  });
  it("keeps an admitted bridge command bound to its original native generation", async () => {
    const { store, listeners } = fixture();
    await store.initialize();
    const admitted = store.commandContext();
    listeners.get("stateChanged")!(snapshot({ connectionGeneration: 2, stateRevision: 1 }));
    expect(admitted).toEqual({ expectedConnectionGeneration: 1 });
    expect(store.commandContext()).toEqual({ expectedConnectionGeneration: 2 });
    store.dispose();
    expect(() => store.commandContext()).toThrow("no longer active");
  });
  it("never adopts settings from a different authenticated identity at the same endpoint", async () => {
    const { store, listeners, plugin } = fixture();
    await store.initialize();
    listeners.get("stateChanged")!(snapshot({ connectionGeneration: 2, identity: "different-principal" }));
    expect(store.getSnapshot().native).toBeUndefined();
    plugin.getState.mockResolvedValue(snapshot({ connectionGeneration: 2, identity: "different-principal" }));
    await expect(store.update({ audioMode: "response" })).rejects.toThrow("no longer active");
    expect(plugin.updateSettings).not.toHaveBeenCalled();
    store.dispose();
  });
});
