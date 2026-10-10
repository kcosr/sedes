import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ getState: vi.fn(), disconnect: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isPluginAvailable: () => true }, registerPlugin: () => bridge }));
vi.mock("../app/client-platform.js", () => ({ isAndroidClient: () => true }));

import { disconnectNativeVoice, nativeThreadTitle, nativeVoiceStateSchema } from "./native-voice-plugin.js";
import { recordingRecovery, voiceActions, voiceSnapshot } from "./native-voice-test-fixture.js";

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
  it("rejects secret-bearing state and obsolete adapter settings at the bridge boundary", () => {
    const state = voiceSnapshot();
    expect(nativeVoiceStateSchema.safeParse(state).success).toBe(true);
    expect(nativeVoiceStateSchema.safeParse({ ...state, version: 1 }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, version: 2 }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, version: 4 }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, version: 5 }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, version: 6 }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, version: 7 }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, version: 8 }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, version: 9 }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, version: 10 }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, version: 11 }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, version: 12 }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, version: 13 }).success).toBe(false);
    for (const audioMode of ["manual", "response"]) {
      expect(nativeVoiceStateSchema.safeParse({ ...state, settings: { ...state.settings, audioMode } }).success).toBe(false);
    }
    const { speechContent: _content, ...missingContent } = state.settings;
    expect(nativeVoiceStateSchema.safeParse({ ...state, settings: missingContent }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, settings: { ...state.settings, readNotificationContext: true } }).success).toBe(false);
    const { canRecordDuringPlayback: _record, ...missingRecord } = state.actions;
    expect(nativeVoiceStateSchema.safeParse({ ...state, actions: missingRecord }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, actions: { ...state.actions, canRecordDuringPlayback: "true" } }).success).toBe(false);
    const { nextRecordingTarget: _target, ...missingTarget } = state;
    expect(nativeVoiceStateSchema.safeParse(missingTarget).success).toBe(false);
    expect(nativeVoiceStateSchema.parse({ ...state, nextRecordingTarget: { threadId: "thread", threadTitle: null } }).nextRecordingTarget?.threadId).toBe("thread");
    const { cleanSpeechText: _cleanup, ...missingCleanup } = state.settings;
    expect(nativeVoiceStateSchema.safeParse({ ...state, settings: missingCleanup }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, settings: { ...state.settings, cleanSpeechText: "true" } }).success).toBe(false);
    const { pinDefaultVoiceThread: _pin, ...missingPin } = state.settings;
    expect(nativeVoiceStateSchema.safeParse({ ...state, settings: missingPin }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, speech: { ...state.speech, credential: "must-never-cross" } }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, settings: { ...state.settings, adapterUrl: "https://old.test" } }).success).toBe(false);
  });
  it("requires persistent microphone identity and rejects transient device IDs", () => {
    const state = voiceSnapshot();
    expect(nativeVoiceStateSchema.safeParse({ ...state, settings: { ...state.settings,
      inputDevice: { type: 7, address: null, name: "Headset" } } }).success).toBe(true);
    for (const inputDevice of ["42", { type: 7, name: "Headset" }, { type: 7, address: null, name: "Headset", id: "42" }])
      expect(nativeVoiceStateSchema.safeParse({ ...state, settings: { ...state.settings, inputDevice } }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, settings: { ...state.settings, inputDeviceId: null } }).success).toBe(false);
  });
  it("requires the strict v12 recording and recovery identities without exposing audio or transcript text", () => {
    const state = voiceSnapshot({ phase: "listening", active: { id: "interaction", eventKind: "manual", threadId: "thread", threadTitle: "Thread",
      recognitionThreadId: "thread", recognitionThreadTitle: "Thread", automatic: false,
      recording: { id: "recording", keepListening: true, reconnecting: true } },
      actions: voiceActions({ canSetKeepListening: true, canSend: true, keepListeningBlockedReason: null }),
      recordingRecovery: recordingRecovery({ admission: { mutationId: "mutation", status: "uncertain", cancelled: false } }) });
    expect(nativeVoiceStateSchema.parse(state)).toEqual(state);
    const { recordingRecovery: _saved, ...withoutSaved } = state;
    expect(nativeVoiceStateSchema.safeParse(withoutSaved).success).toBe(false);
    const { canSetKeepListening: _canKeep, ...withoutCanKeep } = state.actions;
    expect(nativeVoiceStateSchema.safeParse({ ...state, actions: withoutCanKeep }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, actions: { ...state.actions, keepListeningBlockedReason: "other" } }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, active: { ...state.active, recording: { id: "recording", keepListening: true } } }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, active: { ...state.active, recording: { ...state.active!.recording, transcript: "private" } } }).success).toBe(false);
    for (const patch of [{ revision: -1 }, { stage: "listening" }, { pcm: "private" }, { text: "private" },
      { admission: { mutationId: "mutation", status: "accepted", cancelled: false } }]) {
      expect(nativeVoiceStateSchema.safeParse({ ...state, recordingRecovery: { ...state.recordingRecovery, ...patch } }).success).toBe(false);
    }
    const { canDiscard: _discard, ...withoutDiscard } = state.recordingRecovery!;
    expect(nativeVoiceStateSchema.safeParse({ ...state, recordingRecovery: withoutDiscard }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse(voiceSnapshot({ phase: "recordingRecovery", recordingRecovery: recordingRecovery() })).success).toBe(true);
    expect(nativeVoiceStateSchema.safeParse(voiceSnapshot({ recordingRecovery: recordingRecovery({ stage: "unavailable", threadId: null, threadTitle: null }) })).success).toBe(true);
  });
  it("requires the default listening preference without changing the current recording override", () => {
    const state = voiceSnapshot();
    expect(state.settings.keepListeningByDefault).toBe(false);
    expect(nativeVoiceStateSchema.parse({ ...state, settings: { ...state.settings, keepListeningByDefault: true } }).settings.keepListeningByDefault).toBe(true);
    const { keepListeningByDefault: _default, ...missing } = state.settings;
    expect(nativeVoiceStateSchema.safeParse({ ...state, settings: missing }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, settings: { ...state.settings, keepListeningByDefault: "true" } }).success).toBe(false);
  });
  it("requires the opt-in recording announcement preference and accepts its preparation phase", () => {
    const state = voiceSnapshot();
    expect(state.settings.announceRecordingThread).toBe(false);
    expect(nativeVoiceStateSchema.parse({ ...state, phase: "announcing", settings: { ...state.settings, announceRecordingThread: true } }).phase).toBe("announcing");
    const { announceRecordingThread: _announce, ...missing } = state.settings;
    expect(nativeVoiceStateSchema.safeParse({ ...state, settings: missing }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, settings: { ...state.settings, announceRecordingThread: "true" } }).success).toBe(false);
  });
  it("requires retained target and idle revisions so stale releases cannot target a newer interaction", () => {
    const state = voiceSnapshot({ retainedVoiceTarget: { threadId: "thread", threadTitle: null, revision: 3 }, idleTargetRevision: 4,
      actions: voiceActions({ canReleaseRetainedTarget: true }) });
    expect(nativeVoiceStateSchema.parse(state)).toEqual(state);
    const { retainedVoiceTarget: _retained, ...missingRetained } = state;
    const { idleTargetRevision: _idleRevision, ...missingIdleRevision } = state;
    const { canReleaseRetainedTarget: _release, ...missingRelease } = state.actions;
    expect(nativeVoiceStateSchema.safeParse(missingRetained).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse(missingIdleRevision).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, actions: missingRelease }).success).toBe(false);
    for (const retainedVoiceTarget of [{ threadId: "thread", threadTitle: null }, { threadId: "", threadTitle: null, revision: 1 },
      { threadId: "thread", threadTitle: null, revision: -1 }, { threadId: "thread", threadTitle: null, revision: 1.5 }])
      expect(nativeVoiceStateSchema.safeParse({ ...state, retainedVoiceTarget }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, idleTargetRevision: -1 }).success).toBe(false);
    expect(nativeVoiceStateSchema.safeParse({ ...state, idleTargetRevision: 1.5 }).success).toBe(false);
  });
  it("accepts a long dictation limit only in whole minutes from one minute through one day", () => {
    const state = voiceSnapshot();
    expect(state.settings.longDictationTimeoutMs).toBe(3_600_000);
    for (const longDictationTimeoutMs of [60_000, 3_600_000, 86_400_000])
      expect(nativeVoiceStateSchema.safeParse({ ...state, settings: { ...state.settings, longDictationTimeoutMs } }).success).toBe(true);
    for (const longDictationTimeoutMs of [0, 59_999, 60_001, 90_000, 86_460_000, "3600000"])
      expect(nativeVoiceStateSchema.safeParse({ ...state, settings: { ...state.settings, longDictationTimeoutMs } }).success).toBe(false);
    const { longDictationTimeoutMs: _limit, ...missing } = state.settings;
    expect(nativeVoiceStateSchema.safeParse({ ...state, settings: missing }).success).toBe(false);
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
