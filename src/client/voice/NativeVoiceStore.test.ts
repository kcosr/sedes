import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeVoiceStore, recentVoiceErrors } from "./NativeVoiceStore.js";
import type { NativeVoiceState } from "./native-voice-plugin.js";
import { disconnectedVoiceSnapshot, fakeVoicePlugin, recordingRecovery, VOICE_CONNECTION, VOICE_IDENTITY, voiceComposerHandoffSnapshot, voiceSettings, voiceSnapshot as snapshot } from "./native-voice-test-fixture.js";

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
const handoffEvent = (patch = {}) => ({ ...VOICE_CONNECTION, connectionGeneration: 1,
  handoffId: "handoff-1", recordingId: "recording-1", threadId: "named", text: "Finalized voice transcript", mode: "queue" as const, ...patch });
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

describe("foreground submission to composer", () => {
  const context = { expectedConnectionGeneration: 1, handoffId: "handoff-1" };
  it("publishes live composer availability and does not remove a replacement registration", () => {
    const { store } = fixture();
    const changed = vi.fn();
    const unsubscribe = store.subscribeSubmissionComposers(changed);
    expect(store.hasSubmissionComposer(null)).toBe(false);
    expect(store.hasSubmissionComposer("named")).toBe(false);
    const unregisterOld = store.registerSubmissionComposer("named", vi.fn());
    expect(store.hasSubmissionComposer("named")).toBe(true);
    expect(store.hasSubmissionComposer("other")).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    const unregisterLatest = store.registerSubmissionComposer("named", vi.fn());
    unregisterOld();
    expect(store.hasSubmissionComposer("named")).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    unregisterLatest();
    expect(store.hasSubmissionComposer("named")).toBe(false);
    expect(changed).toHaveBeenCalledTimes(3);
    unsubscribe();
    store.registerSubmissionComposer("named", vi.fn());
    expect(changed).toHaveBeenCalledTimes(3);
    store.dispose();
    expect(store.hasSubmissionComposer("named")).toBe(false);
  });

  it("claims before capturing the complete live offer and accepts it only once", async () => {
    const { store, plugin, listeners, open } = fixture();
    await store.initialize();
    let release!: (value: NativeVoiceState) => void;
    plugin.claimComposerHandoff.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const accept = vi.fn(() => {
      expect(plugin.claimComposerHandoff).toHaveBeenCalledExactlyOnceWith(context);
      expect(plugin.completeComposerHandoff).not.toHaveBeenCalled();
    });
    store.registerSubmissionComposer("named", accept);
    const offer = handoffEvent({ mode: "steer" });
    listeners.get("composerHandoff")!(offer);
    listeners.get("composerHandoff")!(offer);
    expect(plugin.claimComposerHandoff).toHaveBeenCalledExactlyOnceWith(context);
    expect(accept).not.toHaveBeenCalled();
    release(voiceComposerHandoffSnapshot(offer, { stateRevision: 2 }));
    await vi.waitFor(() => expect(plugin.completeComposerHandoff).toHaveBeenCalledExactlyOnceWith({ ...context, outcome: "accepted" }));
    expect(accept).toHaveBeenCalledExactlyOnceWith(offer);
    listeners.get("composerHandoff")!(offer);
    expect(plugin.claimComposerHandoff).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(plugin.sendRecording).not.toHaveBeenCalled();
    expect(plugin.sendRecoveredRecording).not.toHaveBeenCalled();
    store.dispose();
  });

  it("drops unhydrated, wrong-binding, stale, future and malformed offers before claim", async () => {
    const { store, plugin, listeners } = fixture();
    const accept = vi.fn();
    store.registerSubmissionComposer("named", accept);
    plugin.setConnection.mockImplementationOnce(async () => {
      listeners.get("composerHandoff")!(handoffEvent());
      return snapshot();
    });
    await store.initialize();
    for (const patch of [
      { profileId: "other" }, { serverOrigin: "https://other.test" }, { identity: "f".repeat(64) },
      { connectionGeneration: 0 }, { connectionGeneration: 2 }, { connectionGeneration: -1 },
      { recordingId: "" }, { handoffId: "" }, { threadId: "" }, { mode: "send" },
      { text: undefined }, { text: " " }, { text: "é".repeat(131073) }, { unexpected: true },
    ]) listeners.get("composerHandoff")!(handoffEvent(patch));
    expect(plugin.claimComposerHandoff).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    listeners.get("composerHandoff")!(handoffEvent());
    await vi.waitFor(() => expect(accept).toHaveBeenCalledOnce());
    expect(plugin.claimComposerHandoff).toHaveBeenCalledOnce();
    listeners.get("stateChanged")!(disconnectedVoiceSnapshot(2));
    listeners.get("composerHandoff")!(handoffEvent({ connectionGeneration: 2, handoffId: "disconnected" }));
    expect(plugin.claimComposerHandoff).toHaveBeenCalledOnce();
    store.dispose();
    listeners.get("composerHandoff")!(handoffEvent({ handoffId: "disposed" }));
    expect(plugin.claimComposerHandoff).toHaveBeenCalledOnce();
  });

  it("declines a hidden view without deferring speech until visibility returns", async () => {
    const { store, plugin, listeners } = fixture();
    await store.initialize();
    const accept = vi.fn();
    store.registerSubmissionComposer("named", accept);
    vi.stubGlobal("document", { visibilityState: "hidden" });
    listeners.get("composerHandoff")!(handoffEvent());
    await vi.waitFor(() => expect(plugin.completeComposerHandoff).toHaveBeenCalledExactlyOnceWith({ ...context,
      outcome: "declined", message: "Open the recording's live Chat to send it with the composer." }));
    expect(accept).not.toHaveBeenCalled();
    vi.stubGlobal("document", { visibilityState: "visible" });
    listeners.get("composerHandoff")!(handoffEvent());
    expect(accept).not.toHaveBeenCalled();
    expect(plugin.claimComposerHandoff).toHaveBeenCalledOnce();
    store.dispose();
  });

  it("uses the latest composer callback when the view changes during claim", async () => {
    const { store, plugin, listeners } = fixture();
    await store.initialize();
    let release!: (value: NativeVoiceState) => void;
    plugin.claimComposerHandoff.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const old = vi.fn(), latest = vi.fn();
    const unregisterOld = store.registerSubmissionComposer("named", old);
    listeners.get("composerHandoff")!(handoffEvent());
    store.registerSubmissionComposer("named", latest);
    unregisterOld();
    release(voiceComposerHandoffSnapshot(handoffEvent()));
    await vi.waitFor(() => expect(latest).toHaveBeenCalledExactlyOnceWith(handoffEvent()));
    expect(old).not.toHaveBeenCalled();
    expect(plugin.completeComposerHandoff).toHaveBeenCalledExactlyOnceWith({ ...context, outcome: "accepted" });
    store.dispose();
  });

  it("declines navigation away during claim rather than opening or modifying another thread", async () => {
    const { store, plugin, listeners, open } = fixture();
    await store.initialize();
    let release!: (value: NativeVoiceState) => void;
    plugin.claimComposerHandoff.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const original = vi.fn(), other = vi.fn();
    const unregister = store.registerSubmissionComposer("named", original);
    listeners.get("composerHandoff")!(handoffEvent());
    unregister();
    store.registerSubmissionComposer("other", other);
    release(voiceComposerHandoffSnapshot(handoffEvent()));
    await vi.waitFor(() => expect(plugin.completeComposerHandoff).toHaveBeenCalledExactlyOnceWith({ ...context,
      outcome: "declined", message: "Open the recording's live Chat to send it with the composer." }));
    expect(original).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    store.dispose();
  });

  it.each(["connection", "dispose"])("does not invoke a stale composer after %s changes during claim", async change => {
    const { store, plugin, listeners } = fixture();
    await store.initialize();
    let release!: (value: NativeVoiceState) => void;
    plugin.claimComposerHandoff.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const accept = vi.fn();
    store.registerSubmissionComposer("named", accept);
    listeners.get("composerHandoff")!(handoffEvent());
    if (change === "dispose") store.dispose();
    else listeners.get("stateChanged")!(snapshot({ connectionGeneration: 2 }));
    release(voiceComposerHandoffSnapshot(handoffEvent()));
    await vi.waitFor(() => expect(plugin.completeComposerHandoff).toHaveBeenCalledExactlyOnceWith({ ...context,
      outcome: "declined", message: "Open the recording's live Chat to send it with the composer." }));
    expect(accept).not.toHaveBeenCalled();
    if (change === "connection") expect(store.getSnapshot().native?.connectionGeneration).toBe(2);
    store.dispose();
  });

  it.each(["stopped", "replacement recording", "new interaction for the same recording", "retargeted", "no longer submitting"])(
    "does not stage speech when native is %s before the claim reply arrives", async change => {
      const { store, plugin, listeners } = fixture();
      await store.initialize();
      let release!: (value: NativeVoiceState) => void;
      plugin.claimComposerHandoff.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const accept = vi.fn();
      store.registerSubmissionComposer("named", accept);
      const offer = handoffEvent();
      const claimed = voiceComposerHandoffSnapshot(offer, { stateRevision: 2 });
      listeners.get("composerHandoff")!(offer);
      const newer = voiceComposerHandoffSnapshot(offer, { stateRevision: 3,
        ...(change === "stopped" ? { active: null } : {}),
        ...(change === "replacement recording" ? { active: { ...claimed.active!,
          recording: { ...claimed.active!.recording!, id: "replacement-recording" } } } : {}),
        ...(change === "new interaction for the same recording" ? { active: { ...claimed.active!, id: "new-interaction" } } : {}),
        ...(change === "retargeted" ? { active: { ...claimed.active!, recognitionThreadId: "other-thread" } } : {}),
        ...(change === "no longer submitting" ? { phase: "cancelling" } : {}),
      });
      listeners.get("stateChanged")!(newer);
      release(claimed);
      await vi.waitFor(() => expect(plugin.completeComposerHandoff).toHaveBeenCalledWith(expect.objectContaining({
        ...context, outcome: "declined",
      })));
      expect(accept).not.toHaveBeenCalled();
      expect(store.getSnapshot().native).toEqual(newer);
      expect(plugin.sendRecording).not.toHaveBeenCalled();
      store.dispose();
    },
  );

  it("leaves a refused recording with native and reports the composer refusal", async () => {
    const { store, plugin, listeners } = fixture();
    const saved = recordingRecovery({ stage: "ready", hasUnrecognizedAudio: false, canSend: true, canCopyRecognizedText: true });
    const native = snapshot({ recordingRecovery: saved });
    plugin.setConnection.mockResolvedValue(native);
    plugin.claimComposerHandoff.mockResolvedValue(voiceComposerHandoffSnapshot(handoffEvent(), { recordingRecovery: saved }));
    plugin.completeComposerHandoff.mockResolvedValue(snapshot({ stateRevision: 2, recordingRecovery: saved }));
    await store.initialize();
    store.registerSubmissionComposer("named", () => { throw new Error("Resolve the draft conflict first."); });
    listeners.get("composerHandoff")!(handoffEvent());
    await vi.waitFor(() => expect(plugin.completeComposerHandoff).toHaveBeenCalledExactlyOnceWith({ ...context,
      outcome: "declined", message: "Resolve the draft conflict first." }));
    expect(store.getSnapshot().native?.recordingRecovery).toEqual(saved);
    expect(plugin.discardRecording).not.toHaveBeenCalled();
    expect(plugin.sendRecording).not.toHaveBeenCalled();
    expect(plugin.sendRecoveredRecording).not.toHaveBeenCalled();
    store.dispose();
  });

  it.each(["not visible", "composer unavailable", "different thread"])(
    "declines a delayed claim when the latest native foreground is %s", async change => {
      const { store, plugin, listeners } = fixture();
      await store.initialize();
      let release!: (value: NativeVoiceState) => void;
      plugin.claimComposerHandoff.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const accept = vi.fn();
      store.registerSubmissionComposer("named", accept);
      const offer = handoffEvent();
      const claimed = voiceComposerHandoffSnapshot(offer, { stateRevision: 2 });
      listeners.get("composerHandoff")!(offer);
      const newer = { ...claimed, stateRevision: 3, foreground: { ...claimed.foreground,
        ...(change === "not visible" ? { visible: false } : {}),
        ...(change === "composer unavailable" ? { composerAvailable: false } : {}),
        ...(change === "different thread" ? { threadId: "other-thread" } : {}),
      } };
      listeners.get("stateChanged")!(newer);
      release(claimed);
      await vi.waitFor(() => expect(plugin.completeComposerHandoff).toHaveBeenCalledWith({ ...context,
        outcome: "declined", message: "Open the recording's live Chat to send it with the composer." }));
      expect(accept).not.toHaveBeenCalled();
      expect(store.getSnapshot().native).toEqual(newer);
      store.dispose();
    },
  );

  it("does not capture speech after native rejects the claim", async () => {
    const { store, plugin, listeners } = fixture();
    await store.initialize();
    plugin.claimComposerHandoff.mockRejectedValue(new Error("The recording is no longer current."));
    const accept = vi.fn();
    store.registerSubmissionComposer("named", accept);
    listeners.get("composerHandoff")!(handoffEvent());
    await vi.waitFor(() => expect(store.getSnapshot().error).toBe("The recording is no longer current."));
    expect(accept).not.toHaveBeenCalled();
    expect(plugin.completeComposerHandoff).toHaveBeenCalledExactlyOnceWith({ ...context,
      outcome: "declined", message: "The recording is no longer current." });
    store.dispose();
  });

  it("releases a possibly claimed offer when the claim response is malformed without adopting speech", async () => {
    const { store, plugin, listeners } = fixture();
    await store.initialize();
    plugin.claimComposerHandoff.mockResolvedValueOnce({ version: 15 } as NativeVoiceState);
    const accept = vi.fn();
    store.registerSubmissionComposer("named", accept);
    listeners.get("composerHandoff")!(handoffEvent());
    await vi.waitFor(() => expect(plugin.completeComposerHandoff).toHaveBeenCalledOnce());
    expect(plugin.completeComposerHandoff).toHaveBeenCalledWith({ ...context, outcome: "declined",
      message: store.getSnapshot().error!.slice(0, 1024) });
    expect(accept).not.toHaveBeenCalled();
    expect(plugin.sendRecording).not.toHaveBeenCalled();
    expect(plugin.sendRecoveredRecording).not.toHaveBeenCalled();
    expect(store.getSnapshot().error!.length).toBeGreaterThan(1024);
    store.dispose();
  });

  it("keeps a failed claim recoverable even when releasing the cancelled offer also rejects", async () => {
    const { store, plugin, listeners } = fixture();
    await store.initialize();
    plugin.claimComposerHandoff.mockRejectedValueOnce(new Error("Claim response lost."));
    plugin.completeComposerHandoff.mockRejectedValueOnce(new Error("The offer was already cancelled."));
    const accept = vi.fn();
    store.registerSubmissionComposer("named", accept);
    listeners.get("composerHandoff")!(handoffEvent());
    await vi.waitFor(() => expect(plugin.completeComposerHandoff).toHaveBeenCalledWith({ ...context,
      outcome: "declined", message: "Claim response lost." }));
    expect(store.getSnapshot().error).toBe("Claim response lost.");
    expect(accept).not.toHaveBeenCalled();
    store.dispose();
  });

  it.each([
    ["disposal", "rejected"], ["disposal", "malformed"],
    ["connection change", "rejected"], ["connection change", "malformed"],
  ] as const)("releases the original unadopted reservation after %s and a %s claim response", async (change, failure) => {
    const { store, plugin, listeners } = fixture();
    await store.initialize();
    let resolve!: (value: NativeVoiceState) => void;
    let reject!: (error: Error) => void;
    plugin.claimComposerHandoff.mockImplementationOnce(() => new Promise((success, rejected) => { resolve = success; reject = rejected; }));
    plugin.completeComposerHandoff.mockResolvedValueOnce(snapshot({ profileId: "other-profile", connectionGeneration: 2 }));
    const accept = vi.fn();
    store.registerSubmissionComposer("named", accept);
    listeners.get("composerHandoff")!(handoffEvent());
    if (change === "disposal") store.dispose();
    else listeners.get("stateChanged")!(snapshot({ connectionGeneration: 2, stateRevision: 3 }));
    const before = store.getSnapshot();
    if (failure === "rejected") reject(new Error("Claim response lost."));
    else resolve({ version: 15 } as NativeVoiceState);
    await vi.waitFor(() => expect(plugin.completeComposerHandoff).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      ...context, outcome: "declined", message: expect.any(String),
    })));
    expect(accept).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before);
    expect(store.getSnapshot().error).toBeUndefined();
    if (change === "connection change") expect(store.getSnapshot().native?.connectionGeneration).toBe(2);
    expect(plugin.sendRecording).not.toHaveBeenCalled();
    store.dispose();
  });

  it("does not insert or send twice when native completion fails and the offer repeats", async () => {
    const { store, plugin, listeners } = fixture();
    await store.initialize();
    plugin.completeComposerHandoff.mockRejectedValue(new Error("Native acknowledgement failed."));
    const accept = vi.fn();
    store.registerSubmissionComposer("named", accept);
    listeners.get("composerHandoff")!(handoffEvent());
    await vi.waitFor(() => expect(store.getSnapshot().error).toBe("Native acknowledgement failed."));
    expect(plugin.completeComposerHandoff).toHaveBeenCalledExactlyOnceWith({ ...context, outcome: "accepted" });
    listeners.get("composerHandoff")!(handoffEvent());
    expect(accept).toHaveBeenCalledExactlyOnceWith(handoffEvent());
    expect(plugin.claimComposerHandoff).toHaveBeenCalledOnce();
    expect(plugin.completeComposerHandoff).toHaveBeenCalledOnce();
    store.dispose();
  });

  it.each([
    { profileId: "other-profile", connectionGeneration: 2 },
    { serverOrigin: "https://other.test", connectionGeneration: 2 },
    { identity: "f".repeat(64), connectionGeneration: 2 },
    { connectionGeneration: 2 },
  ])("settles an adopted handoff without accepting a foreign completion response %j or reconnecting the old profile", async patch => {
    vi.useFakeTimers();
    const { store, plugin, listeners } = fixture();
    await store.initialize();
    const claimed = voiceComposerHandoffSnapshot(handoffEvent(), { stateRevision: 2 });
    plugin.claimComposerHandoff.mockResolvedValueOnce(claimed);
    plugin.completeComposerHandoff.mockResolvedValueOnce(snapshot(patch));
    const accept = vi.fn();
    store.registerSubmissionComposer("named", accept);
    listeners.get("composerHandoff")!(handoffEvent());
    await vi.advanceTimersByTimeAsync(0);
    expect(accept).toHaveBeenCalledExactlyOnceWith(handoffEvent());
    expect(plugin.completeComposerHandoff).toHaveBeenCalledExactlyOnceWith({ ...context, outcome: "accepted" });
    expect(store.getSnapshot().native).toEqual(claimed);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(plugin.setConnection).toHaveBeenCalledOnce();
    store.dispose();
  });

  it("releases an unadopted claim without accepting another binding's completion response", async () => {
    vi.useFakeTimers();
    const { store, plugin, listeners } = fixture();
    await store.initialize();
    plugin.claimComposerHandoff.mockRejectedValueOnce(new Error("Claim response lost."));
    plugin.completeComposerHandoff.mockResolvedValueOnce(snapshot({ profileId: "other-profile", connectionGeneration: 2 }));
    listeners.get("composerHandoff")!(handoffEvent());
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.completeComposerHandoff).toHaveBeenCalledExactlyOnceWith({ ...context, outcome: "declined", message: "Claim response lost." });
    expect(store.getSnapshot().native?.profileId).toBe("profile");
    expect(store.getSnapshot().error).toBe("Claim response lost.");
    await vi.advanceTimersByTimeAsync(2_001);
    expect(plugin.setConnection).toHaveBeenCalledOnce();
    store.dispose();
  });
});
describe("native voice state authority", () => {
  it.each(["stopPlayback", "stopInteraction"] as const)("%s interrupts a pending action, deduplicates taps, and rejects its late state", async action => {
    const { store, plugin } = fixture();
    await store.initialize();
    let releaseRecord!: (state: NativeVoiceState) => void;
    let releaseStop!: (state: NativeVoiceState) => void;
    plugin.recordDuringPlayback.mockImplementationOnce(() => new Promise(resolve => { releaseRecord = resolve; }));
    const stop = action === "stopPlayback" ? plugin.stopPlayback : plugin.stopCurrentInteraction;
    stop.mockImplementationOnce(() => new Promise(resolve => { releaseStop = resolve; }));
    const recording = store.run(() => plugin.recordDuringPlayback());
    const context = { expectedConnectionGeneration: 1, interactionId: "playing" };
    const stopping = store[action](context);
    expect(store[action](context)).toBe(stopping);
    expect(stop).toHaveBeenCalledExactlyOnceWith(context);
    const idle = snapshot({ stateRevision: 3, phase: "idle" });
    releaseStop(idle);
    await stopping;
    expect(store.getSnapshot().pending).toBe(true);
    releaseRecord(snapshot({ stateRevision: 2, phase: "listening" }));
    await recording;
    expect(store.getSnapshot()).toMatchObject({ native: idle, pending: false });
    store.dispose();
  });
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
    await expect(store.update({ audioMode: "speak" })).rejects.toThrow("no longer active");
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
    expect(remove).toHaveBeenCalledTimes(6);
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
    await expect(store.update({ audioMode: "speak" })).rejects.toThrow("no longer active");
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
    const ready = (patch: Parameters<typeof snapshot>[0]) => snapshot({ ready: true, readiness: "ready", settings: voiceSettings({ audioMode: "speak" }), ...patch });
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
    plugin.getState.mockResolvedValue(snapshot({ stateRevision: 4, settingsRevision: 3, settings: voiceSettings({ audioMode: "input" }),
      actions: { ...snapshot().actions, canResume: true } }));
    await store.update(resume);
    expect(plugin.updateSettings).toHaveBeenCalledExactlyOnceWith({ expectedConnectionGeneration: 1, expectedRevision: 3, patch: { audioMode: "input" } });
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
