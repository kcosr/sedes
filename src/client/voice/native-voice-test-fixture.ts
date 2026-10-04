import { vi } from "vitest";
import type { NativeVoicePlugin, NativeVoiceSettings, NativeVoiceState } from "./native-voice-plugin.js";

/** Native binds voice to the authenticated navigation namespace, which is always 64 lowercase hex digits. */
export const VOICE_IDENTITY = "0123456789abcdef".repeat(4);
export const VOICE_CONNECTION = { profileId: "profile", serverOrigin: "https://sedes.test", identity: VOICE_IDENTITY };
export const VOICE_ORIGIN_ID = "34612c41-0bbb-455f-a5af-725bfc7ae768";

export function voiceSettings(patch: Partial<NativeVoiceSettings> = {}): NativeVoiceSettings {
  return { audioMode: "off", autoListen: true, ignoreOtherDevices: true, readNotificationContext: true,
    speechProvider: "openai", speechEndpoint: "https://api.openai.com/v1", sttModel: "gpt-live-transcribe",
    ttsModel: "gpt-4o-mini-tts", ttsVoice: "coral", ttsSpeed: 1, speechTextLimit: 4096, voiceThreadId: null, voiceThreadTitle: null, onlyVoiceThread: false, followComposerMode: false,
    inputDeviceId: null, recognitionStartTimeoutMs: 30000, recognitionCompletionTimeoutMs: 60000, recognitionEndSilenceMs: 1200, recognitionResultTimeoutMs: 60000,
    recognizeStopCommand: true, recognitionCues: true, cueGain: 100, startupPreRollMs: 512, ttsGain: 100, headsetControls: true, ...patch };
}
export function voiceSnapshot(patch: Partial<NativeVoiceState> = {}): NativeVoiceState {
  return {
    version: 2, stateRevision: 1, connectionGeneration: 1, ...VOICE_CONNECTION, originClientId: VOICE_ORIGIN_ID, settingsRevision: 0,
    settings: voiceSettings(), phase: "off", ready: false, readiness: "off", foreground: { visible: false, threadId: null, threadTitle: null }, active: null,
    queue: { count: 0, bytes: 0, droppedCount: 0, droppedReasons: {} },
    speech: { credentialConfigured: false, catalogStatus: "idle", catalog: null, error: null },
    actions: { canStart: false, canStop: false, canSkip: false, canRetarget: false, canResume: false }, recovery: [], errors: [], ...patch,
  };
}
/** A snapshot native publishes after disconnecting, or while bound to another connection. */
export function disconnectedVoiceSnapshot(connectionGeneration: number): NativeVoiceState {
  return voiceSnapshot({ connectionGeneration, stateRevision: 0, profileId: null, serverOrigin: null, identity: null, originClientId: null });
}
export function fakeVoicePlugin() {
  const listeners = new Map<string, (value: unknown) => void>();
  const remove = vi.fn(async () => {});
  // Each method needs its own mock: Vitest returns the same instance when vi.fn wraps an existing mock.
  const state = () => vi.fn(async (): Promise<NativeVoiceState> => voiceSnapshot());
  const plugin = {
    setConnection: state(), getState: state(), updateSettings: state(), disconnect: state(), setForegroundContext: state(),
    startManualListen: state(), retargetActiveRecognition: state(), skipCurrentPlayback: state(), stopCurrentInteraction: state(),
    resumeInput: state(), discardInput: state(), refreshSpeechCatalog: state(), openSpeechCredentialDialog: state(),
    listInputDevices: vi.fn(async (): Promise<Awaited<ReturnType<NativeVoicePlugin["listInputDevices"]>>> => ({ devices: [], selectedId: null })),
    addListener: vi.fn(async (event: string, listener: (value: unknown) => void) => { listeners.set(event, listener); return { remove }; }),
  };
  const emit = (event: string, value: unknown) => listeners.get(event)!(value);
  return { plugin, listeners, remove, emit, asPlugin: plugin as unknown as NativeVoicePlugin };
}
