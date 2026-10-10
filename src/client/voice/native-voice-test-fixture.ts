import { vi } from "vitest";
import type { NativeRecordingRecovery, NativeVoicePlugin, NativeVoiceSettings, NativeVoiceState } from "./native-voice-plugin.js";

/** Native binds voice to the authenticated navigation namespace, which is always 64 lowercase hex digits. */
export const VOICE_IDENTITY = "0123456789abcdef".repeat(4);
export const VOICE_CONNECTION = { profileId: "profile", serverOrigin: "https://sedes.test", identity: VOICE_IDENTITY };
export const VOICE_ORIGIN_ID = "34612c41-0bbb-455f-a5af-725bfc7ae768";

export function voiceSettings(patch: Partial<NativeVoiceSettings> = {}): NativeVoiceSettings {
  return { audioMode: "off", autoListen: true, keepListeningByDefault: false, announceRecordingThread: false, ignoreOtherDevices: true, readNotificationContext: true, cleanSpeechText: true,
    speechProvider: "openai", speechEndpoint: "https://api.openai.com/v1", sttModel: "gpt-live-transcribe",
    ttsModel: "gpt-4o-mini-tts", ttsVoice: "coral", ttsSpeed: 1, speechTextLimit: 4096, voiceThreadId: null, voiceThreadTitle: null, pinDefaultVoiceThread: false, onlyVoiceThread: false, followComposerMode: false,
    inputDevice: null, recognitionStartTimeoutMs: 30000, recognitionCompletionTimeoutMs: 60000, recognitionEndSilenceMs: 1200, recognitionResultTimeoutMs: 60000, longDictationTimeoutMs: 3_600_000,
    recognizeStopCommand: true, recognitionCues: true, cueGain: 100, startupPreRollMs: 512, ttsGain: 100, headsetControls: true, ...patch };
}
export function voiceSnapshot(patch: Partial<NativeVoiceState> = {}): NativeVoiceState {
  return {
    version: 12, stateRevision: 1, connectionGeneration: 1, ...VOICE_CONNECTION, originClientId: VOICE_ORIGIN_ID, clientConnectionToken: "a".repeat(43), settingsRevision: 0,
    settings: voiceSettings(), phase: "off", ready: false, readiness: "off", foreground: { visible: false, threadId: null, threadTitle: null }, active: null,
    nextRecordingTarget: null, retainedVoiceTarget: null, idleTargetRevision: 0, queue: { count: 0, bytes: 0, droppedCount: 0, droppedReasons: {} },
    speech: { credentialConfigured: false, catalogStatus: "idle", catalog: null, error: null },
    actions: voiceActions(), recordingRecovery: null, recovery: [], errors: [], ...patch,
  };
}
export function voiceActions(patch: Partial<NativeVoiceState["actions"]> = {}): NativeVoiceState["actions"] {
  return { canStart: false, canStop: false, canSkip: false, canRecordDuringPlayback: false, canReleaseRetainedTarget: false, canRetarget: false, canResume: false,
    canSetKeepListening: false, canSend: false, keepListeningBlockedReason: "not_capturing", ...patch };
}
export function recordingRecovery(patch: Partial<NativeRecordingRecovery> = {}): NativeRecordingRecovery {
  return { recordingId: "saved-recording", revision: 1, threadId: "named", threadTitle: "Release review", stage: "interrupted",
    reason: null, hasUnrecognizedAudio: true, captureIncomplete: false, canRetryRecognition: true, canSend: false,
    canCopyRecognizedText: false, canDiscard: true, admission: null, ...patch };
}
/** A snapshot native publishes after disconnecting, or while bound to another connection. */
export function disconnectedVoiceSnapshot(connectionGeneration: number): NativeVoiceState {
  return voiceSnapshot({ connectionGeneration, stateRevision: 0, profileId: null, serverOrigin: null, identity: null, originClientId: null, clientConnectionToken: null });
}
export function fakeVoicePlugin() {
  const listeners = new Map<string, (value: unknown) => void>();
  const remove = vi.fn(async () => {});
  // Each method needs its own mock: Vitest returns the same instance when vi.fn wraps an existing mock.
  const state = () => vi.fn(async (): Promise<NativeVoiceState> => voiceSnapshot());
  const plugin = {
    setConnection: state(), getState: state(), updateSettings: state(), disconnect: state(), setForegroundContext: state(),
    startManualListen: state(), setNextRecordingTarget: state(), releaseRetainedVoiceTarget: state(), retargetActiveRecognition: state(), recordDuringPlayback: state(), skipCurrentPlayback: state(), stopCurrentInteraction: state(),
    speakReply: vi.fn(async (_input: Parameters<NativeVoicePlugin["speakReply"]>[0]): Promise<NativeVoiceState> => voiceSnapshot()),
    setKeepListening: state(), sendRecording: state(), retryRecordingRecognition: state(), sendRecoveredRecording: state(),
    copyRecognizedRecordingText: state(), discardRecording: state(),
    readRecognizedRecordingText: vi.fn(async (): Promise<Awaited<ReturnType<NativeVoicePlugin["readRecognizedRecordingText"]>>> => ({
      recordingId: "saved-recording", revision: 1, threadId: "named", text: "Recovered dictation text.",
    })),
    resumeInput: state(), discardInput: state(), refreshSpeechCatalog: state(), openSpeechCredentialDialog: state(),
    listInputDevices: vi.fn(async (): Promise<Awaited<ReturnType<NativeVoicePlugin["listInputDevices"]>>> => ({ devices: [] })),
    addListener: vi.fn(async (event: string, listener: (value: unknown) => void) => { listeners.set(event, listener); return { remove }; }),
  };
  const emit = (event: string, value: unknown) => listeners.get(event)!(value);
  return { plugin, listeners, remove, emit, asPlugin: plugin as unknown as NativeVoicePlugin };
}
