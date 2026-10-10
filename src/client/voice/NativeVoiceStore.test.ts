import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeVoiceStore, recentVoiceErrors } from "./NativeVoiceStore.js";
import type { NativeVoiceState } from "./native-voice-plugin.js";
import { disconnectedVoiceSnapshot, fakeVoicePlugin, recordingRecovery, VOICE_CONNECTION, VOICE_IDENTITY, voiceSettings, voiceSnapshot as snapshot } from "./native-voice-test-fixture.js";

function fixture() {
  const { plugin, listeners, remove, asPlugin } = fakeVoicePlugin();
  const open = vi.fn();
  const store = new NativeVoiceStore(asPlugin, VOICE_CONNECTION, open);
  return { store, plugin, listeners, open, remove };
}
const openEvent = (threadId: string, profileId = "profile") => ({ threadId, profileId,
  serverOrigin: "https://sedes.test", identity: VOICE_IDENTITY, connectionGeneration: 1 });
const runtimeError = (message: string, connectionGeneration = 1) => ({ code: "voice_error", message, connectionGeneration, ...VOICE_CONNECTION });
const submittedEvent = (patch = {}) => ({ ...VOICE_CONNECTION, connectionGeneration: 1,
  threadId: "c61b5d8b-4a77-43c6-bd72-12e23fe42e38", operationId: "618f73db-b94d-4538-8ed9-7566313eb807", text: "Finalized voice transcript", queuedInputId: "queue-1", ...patch });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("saved dictation to composer", () => {
  const context = { expectedConnectionGeneration: 1, recordingId: "saved-recording", expectedRecoveryRevision: 1 };
  async function recovery() {
    const f = fixture();
    const saved = recordingRecovery({ stage: "ready", hasUnrecognizedAudio: false, canCopyRecognizedText: true });
    const native = snapshot({ recordingRecovery: saved });
    f.plugin.setConnection.mockResolvedValue(native);
    await f.store.initialize();
    return { ...f, saved, native };
  }
  it("opens the original thread, waits for its composer, and adds once without discarding or sending", async () => {
    const f = await recovery();
    const wrong = vi.fn(), append = vi.fn();
    f.store.registerComposer("other-thread", wrong);
    const work = f.store.addRecordingToComposer(context);
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledExactlyOnceWith("named"));
    expect(wrong).not.toHaveBeenCalled();
    expect(f.store.getSnapshot().pending).toBe(true);
    const unregister = f.store.registerComposer("named", append);
    await work;
    expect(append).toHaveBeenCalledExactlyOnceWith("Recovered dictation text.");
    expect(f.store.getSnapshot().native?.recordingRecovery).toEqual(f.saved);
    expect(f.store.getSnapshot().addedRecording).toEqual(context);
    expect(f.plugin.discardRecording).not.toHaveBeenCalled();
    expect(f.plugin.sendRecoveredRecording).not.toHaveBeenCalled();
    await f.store.addRecordingToComposer(context);
    expect(append).toHaveBeenCalledTimes(1);
    unregister(); f.store.dispose();
  });
  it("rejects a text response from an earlier connection before navigation", async () => {
    const f = await recovery();
    let release!: (value: Awaited<ReturnType<typeof f.plugin.readRecognizedRecordingText>>) => void;
    f.plugin.readRecognizedRecordingText.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const work = f.store.addRecordingToComposer(context);
    const result = expect(work).rejects.toThrow("Saved dictation changed");
    f.listeners.get("stateChanged")!(disconnectedVoiceSnapshot(2));
    release({ recordingId: "saved-recording", revision: 1, threadId: "named", text: "Old connection text" });
    await result;
    expect(f.open).not.toHaveBeenCalled();
    expect(f.store.getSnapshot().addedRecording).toBeUndefined();
    f.store.dispose();
  });
  it.each(["connection", "revision", "dispose"])("cancels a pending composer handoff on %s change", async change => {
    const f = await recovery();
    const work = f.store.addRecordingToComposer(context);
    const result = expect(work).rejects.toThrow("Saved dictation changed");
    await vi.waitFor(() => expect(f.open).toHaveBeenCalled());
    if (change === "dispose") f.store.dispose();
    else f.listeners.get("stateChanged")!(change === "connection" ? disconnectedVoiceSnapshot(2)
      : { ...f.native, stateRevision: 2, recordingRecovery: { ...f.saved, revision: 2 } });
    const append = vi.fn();
    f.store.registerComposer("named", append);
    await result;
    expect(append).not.toHaveBeenCalled();
    expect(f.store.getSnapshot().addedRecording).toBeUndefined();
    f.store.dispose();
  });
  it("keeps the saved recording after a composer refuses the text", async () => {
    const f = await recovery();
    f.store.registerComposer("named", () => { throw new Error("Resolve the draft conflict first."); });
    await expect(f.store.addRecordingToComposer(context)).rejects.toThrow("Resolve the draft conflict first");
    expect(f.store.getSnapshot().error).toBe("Resolve the draft conflict first.");
    expect(f.store.getSnapshot().pending).toBe(false);
    expect(f.store.getSnapshot().native?.recordingRecovery).toEqual(f.saved);
    expect(f.store.getSnapshot().addedRecording).toBeUndefined();
    f.store.dispose();
  });
  it("times out an unavailable composer without changing the recording", async () => {
    vi.useFakeTimers();
    const f = await recovery();
    const work = f.store.addRecordingToComposer(context);
    const result = expect(work).rejects.toThrow("composer is unavailable");
    await vi.advanceTimersByTimeAsync(10_001);
    await result;
    expect(f.store.getSnapshot().native?.recordingRecovery).toEqual(f.saved);
    expect(f.store.getSnapshot().pending).toBe(false);
    f.store.dispose();
  });
});

describe("local voice submission events", () => {
  it("delivers each exact live operation once without retaining it in state or replaying to new listeners", async () => {
    const { store, listeners } = fixture();
    const receive = vi.fn();
    const unsubscribe = store.subscribeInputSubmitted(receive);
    await store.initialize();
    const before = store.getSnapshot();
    const event = submittedEvent();
    listeners.get("inputSubmitted")!(event);
    listeners.get("inputSubmitted")!(event);
    expect(receive).toHaveBeenCalledExactlyOnceWith(event);
    expect(store.getSnapshot()).toBe(before);
    unsubscribe();
    const later = vi.fn();
    store.subscribeInputSubmitted(later);
    expect(later).not.toHaveBeenCalled();
    store.dispose();
    listeners.get("inputSubmitted")!(submittedEvent({ operationId: crypto.randomUUID() }));
    expect(later).not.toHaveBeenCalled();
  });

  it("drops unhydrated, wrong-binding, stale, future and malformed events", async () => {
    const { store, listeners, plugin } = fixture();
    const receive = vi.fn();
    store.subscribeInputSubmitted(receive);
    plugin.setConnection.mockImplementationOnce(async () => {
      listeners.get("inputSubmitted")!(submittedEvent());
      return snapshot();
    });
    await store.initialize();
    for (const patch of [
      { profileId: "other" }, { serverOrigin: "https://other.test" }, { identity: "f".repeat(64) },
      { connectionGeneration: 0 }, { connectionGeneration: 2 }, { threadId: "not-a-uuid" },
      { operationId: "not-a-uuid" }, { unexpected: true }, { text: undefined }, { text: " " }, { text: "é".repeat(131073) },
      { queuedInputId: undefined }, { queuedInputId: "" }, { queuedInputId: "a".repeat(129) },
    ]) listeners.get("inputSubmitted")!(submittedEvent(patch));
    expect(receive).not.toHaveBeenCalled();
    listeners.get("inputSubmitted")!(submittedEvent());
    expect(receive).toHaveBeenCalledOnce();
    listeners.get("stateChanged")!(disconnectedVoiceSnapshot(2));
    listeners.get("inputSubmitted")!(submittedEvent({ connectionGeneration: 2, operationId: crypto.randomUUID() }));
    expect(receive).toHaveBeenCalledOnce();
    store.dispose();
  });

  it("does not defer hidden-window events until the app becomes visible", async () => {
    const { store, listeners } = fixture();
    const receive = vi.fn();
    store.subscribeInputSubmitted(receive);
    await store.initialize();
    vi.stubGlobal("document", { visibilityState: "hidden" });
    listeners.get("inputSubmitted")!(submittedEvent());
    expect(receive).not.toHaveBeenCalled();
    vi.stubGlobal("document", { visibilityState: "visible" });
    expect(receive).not.toHaveBeenCalled();
    listeners.get("inputSubmitted")!(submittedEvent({ operationId: crypto.randomUUID() }));
    expect(receive).toHaveBeenCalledOnce();
    store.dispose();
  });
});
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
    expect(remove).toHaveBeenCalledTimes(5);
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
    listeners.get("stateChanged")!(snapshot({ connectionGeneration: 2, identity: "f".repeat(64) }));
    expect(store.getSnapshot().native).toBeUndefined();
    plugin.getState.mockResolvedValue(snapshot({ connectionGeneration: 2, identity: "f".repeat(64) }));
    await expect(store.update({ audioMode: "response" })).rejects.toThrow("no longer active");
    expect(plugin.updateSettings).not.toHaveBeenCalled();
    store.dispose();
  });
  it("retries a failed startup connection with capped backoff and stops once native state returns", async () => {
    vi.useFakeTimers();
    const { store, plugin } = fixture();
    plugin.setConnection.mockRejectedValue(new Error("Server unavailable"));
    await store.initialize();
    expect(plugin.setConnection).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(plugin.setConnection).toHaveBeenCalledTimes(1);
    let calls = 1;
    for (const delay of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(delay - (calls === 1 ? 1_999 : 0));
      expect(plugin.setConnection).toHaveBeenCalledTimes(++calls);
    }
    expect(store.getSnapshot().native).toBeUndefined();
    expect(store.getSnapshot()).toMatchObject({ error: "Server unavailable", loading: false });
    plugin.setConnection.mockResolvedValue(snapshot());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(plugin.setConnection).toHaveBeenCalledTimes(++calls);
    expect(store.getSnapshot().native?.originClientId).toBeDefined();
    expect(store.getSnapshot().error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(plugin.setConnection).toHaveBeenCalledTimes(calls);
    store.dispose();
  });
  it("reconnects at once on foreground, rehydrates a live connection, and retries after native drops this binding", async () => {
    vi.useFakeTimers();
    const { store, plugin, listeners } = fixture();
    plugin.setConnection.mockRejectedValueOnce(new Error("offline"));
    await store.initialize();
    store.foreground();
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.setConnection).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().native).toBeDefined();
    store.foreground();
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.getState).toHaveBeenCalledTimes(1);
    expect(plugin.setConnection).toHaveBeenCalledTimes(2);
    plugin.setConnection.mockResolvedValue(snapshot({ connectionGeneration: 3 }));
    listeners.get("stateChanged")!(disconnectedVoiceSnapshot(2));
    expect(store.getSnapshot().native).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(plugin.setConnection).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().native?.connectionGeneration).toBe(3);
    store.dispose();
  });
  it("cancels a pending reconnect when the WebView store is disposed", async () => {
    vi.useFakeTimers();
    const { store, plugin, listeners } = fixture();
    await store.initialize();
    listeners.get("stateChanged")!(disconnectedVoiceSnapshot(2));
    store.dispose();
    store.foreground();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(plugin.setConnection).toHaveBeenCalledTimes(1);
  });
  it.each(["speaking", "announcing"] as const)("keeps a runtime error until %s begins or the user acts", async phase => {
    const { store, plugin, listeners } = fixture();
    const ready = (patch: Parameters<typeof snapshot>[0]) => snapshot({ ready: true, readiness: "ready", settings: voiceSettings({ audioMode: "response" }), ...patch });
    plugin.setConnection.mockResolvedValue(ready({ phase: "recognizing" }));
    await store.initialize();
    const failure = { code: "voice_error", message: "Recognition failed." };
    listeners.get("stateChanged")!(ready({ stateRevision: 2, phase: "recognizing", errors: [failure] }));
    listeners.get("runtimeError")!(runtimeError(failure.message));
    listeners.get("stateChanged")!(ready({ stateRevision: 3, phase: "idle", errors: [failure] }));
    expect(store.getSnapshot().error).toBe("Recognition failed.");
    listeners.get("stateChanged")!(ready({ stateRevision: 4, phase, errors: [failure] }));
    expect(store.getSnapshot().error).toBeUndefined();
    listeners.get("runtimeError")!(runtimeError("Playback failed."));
    listeners.get("stateChanged")!(ready({ stateRevision: 5, phase: "idle" }));
    expect(store.getSnapshot().error).toBe("Playback failed.");
    await store.run(async () => ready({ stateRevision: 6, phase: "idle" }));
    expect(store.getSnapshot().error).toBeUndefined();
    store.dispose();
  });
  it("lists recent distinct errors newest first and hides cleared ones until native reports another", async () => {
    const { store, listeners } = fixture();
    await store.initialize();
    const timeout = { code: "adapter_handshake_timeout", message: "The voice adapter did not respond." };
    const microphone = { code: "microphone_failed", message: "The microphone failed." };
    const a = { code: "a", message: "A" }, b = { code: "b", message: "B" };
    listeners.get("stateChanged")!(snapshot({ stateRevision: 2, errors: [timeout, microphone, timeout, timeout, a, b] }));
    expect(recentVoiceErrors(store.getSnapshot())).toEqual(["B", "A", timeout.message]);
    store.dismissErrors();
    expect(recentVoiceErrors(store.getSnapshot())).toEqual([]);
    listeners.get("stateChanged")!(snapshot({ stateRevision: 3, errors: [microphone, timeout, timeout, a, b, timeout] }));
    expect(recentVoiceErrors(store.getSnapshot())).toEqual([timeout.message]);
    listeners.get("runtimeError")!(runtimeError(microphone.message));
    expect(recentVoiceErrors(store.getSnapshot())).toEqual([microphone.message, timeout.message]);
    listeners.get("stateChanged")!(snapshot({ connectionGeneration: 2, stateRevision: 1, errors: [a, b] }));
    expect(recentVoiceErrors(store.getSnapshot())).toEqual(["B", "A"]);
    store.dispose();
  });
  it("builds a function patch from refreshed native state and skips the write when it no longer applies", async () => {
    const { store, plugin } = fixture();
    await store.initialize();
    const resume = (current: NativeVoiceState) => current.settings.audioMode !== "off" && current.actions.canResume ? { audioMode: current.settings.audioMode } : null;
    plugin.getState.mockResolvedValue(snapshot({ stateRevision: 4, settingsRevision: 3, settings: voiceSettings({ audioMode: "manual" }),
      actions: { ...snapshot().actions, canResume: true } }));
    await store.update(resume);
    expect(plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRevision: 3, patch: { audioMode: "manual" } });
    plugin.getState.mockResolvedValue(snapshot({ stateRevision: 5, settingsRevision: 4 }));
    await store.update(resume);
    expect(plugin.updateSettings).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ pending: false, native: { settingsRevision: 4 } });
    store.dispose();
  });
});

describe("turn reply replay", () => {
  const reply = { threadId: "thread-1", turnId: "turn-1", threadTitle: "Release review", assistantResult: { final: { text: "Stored final answer." } } };
  it("sends the reply with the current connection generation and accepts native's published snapshot", async () => {
    const { store, plugin } = fixture();
    await store.initialize();
    const queued = snapshot({ stateRevision: 4, phase: "speaking", active: { id: "replay", eventKind: "replay", threadId: "thread-1",
      threadTitle: null, recognitionThreadId: null, recognitionThreadTitle: null, automatic: false, recording: null } });
    plugin.speakReply.mockResolvedValue(queued);
    await store.speakReply(reply);
    expect(plugin.speakReply).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, ...reply });
    expect(store.getSnapshot()).toMatchObject({ native: queued, pending: false });
    store.dispose();
  });
  it("rejects with native's error and reports it like any voice action", async () => {
    const { store, plugin } = fixture();
    await store.initialize();
    const failure = Object.assign(new Error("Voice is not ready to record yet."), { code: "voice_not_ready" });
    plugin.speakReply.mockRejectedValue(failure);
    await expect(store.speakReply(reply)).rejects.toBe(failure);
    expect(store.getSnapshot()).toMatchObject({ error: "Voice is not ready to record yet.", pending: false });
    store.dispose();
    await expect(store.speakReply(reply)).rejects.toThrow("no longer active");
    expect(plugin.speakReply).toHaveBeenCalledOnce();
  });
});
