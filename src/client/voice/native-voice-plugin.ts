import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { z } from "zod";
import { isAndroidClient } from "../app/client-platform.js";

export const nativeVoiceSettingsSchema = z.strictObject({
  audioMode: z.enum(["off", "manual", "response"]),
  autoListen: z.boolean(), ignoreOtherDevices: z.boolean(), readNotificationContext: z.boolean(), cleanSpeechText: z.boolean(),
  speechProvider: z.enum(["openai", "server"]), speechEndpoint: z.string(),
  sttModel: z.string().max(160), ttsModel: z.string().max(160), ttsVoice: z.string().max(160),
  ttsSpeed: z.number().min(0.25).max(4), speechTextLimit: z.number().int().min(2).max(4096),
  voiceThreadId: z.string().nullable(), voiceThreadTitle: z.string().nullable(),
  pinDefaultVoiceThread: z.boolean(), onlyVoiceThread: z.boolean(), followComposerMode: z.boolean(), inputDeviceId: z.string().nullable(),
  recognitionStartTimeoutMs: z.number().int().positive(), recognitionCompletionTimeoutMs: z.number().int().positive(),
  recognitionResultTimeoutMs: z.number().int().min(1000).max(300000),
  longDictationTimeoutMs: z.number().int().min(60_000).max(86_400_000).multipleOf(60_000),
  recognitionEndSilenceMs: z.number().int().positive(), recognizeStopCommand: z.boolean(),
  recognitionCues: z.boolean(), cueGain: z.number().nonnegative(), startupPreRollMs: z.number().int().nonnegative(),
  ttsGain: z.number().nonnegative(), headsetControls: z.boolean(),
});
export type NativeVoiceSettings = z.infer<typeof nativeVoiceSettingsSchema>;
export const nativeSpeechCatalogSchema = z.strictObject({
  source: z.enum(["openai", "server"]), sttModels: z.array(z.string()), ttsModels: z.array(z.string()),
  voices: z.array(z.string()), speed: z.strictObject({ min: z.number().positive(), max: z.number().positive() }).nullable(),
  formats: z.array(z.string()),
});
export type NativeSpeechCatalog = z.infer<typeof nativeSpeechCatalogSchema>;
export const nativeRecordingRecoverySchema = z.strictObject({
  recordingId: z.string().min(1), revision: z.number().int().nonnegative(), threadId: z.string().min(1).nullable(), threadTitle: z.string().nullable(),
  stage: z.enum(["interrupted", "recognizing", "ready", "admitting", "rejected", "overflow", "unavailable"]),
  reason: z.string().nullable(), hasUnrecognizedAudio: z.boolean(), captureIncomplete: z.boolean(),
  canRetryRecognition: z.boolean(), canSend: z.boolean(), canCopyRecognizedText: z.boolean(), canDiscard: z.boolean(),
  admission: z.strictObject({ mutationId: z.string().min(1),
    status: z.enum(["prepared", "possiblySubmitted", "reconciling", "uncertain", "rejected"]), cancelled: z.boolean() }).nullable(),
});
export type NativeRecordingRecovery = z.infer<typeof nativeRecordingRecoverySchema>;
export const nativeVoiceStateSchema = z.strictObject({
  version: z.literal(6), stateRevision: z.number().int().nonnegative(), connectionGeneration: z.number().int().nonnegative(),
  profileId: z.string().nullable(), serverOrigin: z.string().nullable(), identity: z.string().nullable(), originClientId: z.uuid().nullable(), clientConnectionToken: z.string().nullable(),
  settingsRevision: z.number().int().nonnegative(), settings: nativeVoiceSettingsSchema,
  speech: z.strictObject({ credentialConfigured: z.boolean(), catalogStatus: z.enum(["idle", "loading", "ready", "error"]),
    catalog: nativeSpeechCatalogSchema.nullable(), error: z.string().nullable() }),
  phase: z.enum(["off", "starting", "idle", "synthesizing", "speaking", "validating", "arming", "listening", "recognizing", "submitting", "cancelling", "recovering", "recordingRecovery", "error"]),
  ready: z.boolean(), readiness: z.string(),
  foreground: z.strictObject({ visible: z.boolean(), threadId: z.string().nullable(), threadTitle: z.string().nullable() }),
  active: z.strictObject({ id: z.string(), eventKind: z.string().nullable(), threadId: z.string().nullable(), threadTitle: z.string().nullable(),
    recognitionThreadId: z.string().nullable(), recognitionThreadTitle: z.string().nullable(), automatic: z.boolean(),
    recording: z.strictObject({ id: z.string().min(1), keepListening: z.boolean(), reconnecting: z.boolean() }).nullable() }).nullable(),
  queue: z.strictObject({ count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), droppedCount: z.number().int().nonnegative(),
    droppedReasons: z.record(z.string(), z.number().int().nonnegative()) }),
  actions: z.strictObject({ canStart: z.boolean(), canStop: z.boolean(), canSkip: z.boolean(), canRetarget: z.boolean(), canResume: z.boolean(),
    canSetKeepListening: z.boolean(), canSend: z.boolean(),
    keepListeningBlockedReason: z.enum(["not_capturing", "operation_pending", "saved_recording_pending", "configuration_unavailable", "storage_unavailable"]).nullable() }),
  recordingRecovery: nativeRecordingRecoverySchema.nullable(),
  recovery: z.array(z.strictObject({ mutationId: z.string(), threadId: z.string(),
    status: z.enum(["prepared", "possiblySubmitted", "reconciling", "uncertain"]), cancelled: z.boolean() })),
  errors: z.array(z.strictObject({ code: z.string(), message: z.string() })),
});
export type NativeVoiceState = z.infer<typeof nativeVoiceStateSchema>;
/** A live local Submit receipt; never retained or replayed with native state. */
export const nativeVoiceInputSubmittedSchema = z.strictObject({
  profileId: z.string().min(1), serverOrigin: z.url(), identity: z.string().regex(/^[a-f0-9]{64}$/u),
  connectionGeneration: z.number().int().nonnegative(), threadId: z.uuid(), operationId: z.uuid(),
});
export type NativeVoiceInputSubmitted = z.infer<typeof nativeVoiceInputSubmittedSchema>;
export type NativeVoiceCommandContext = { expectedConnectionGeneration: number };
export type NativeRecordingCommandContext = NativeVoiceCommandContext & { recordingId: string };
export type NativeRecordingRecoveryCommandContext = NativeRecordingCommandContext & { expectedRecoveryRevision: number };
export type NativeVoiceInteractionCommandContext = NativeVoiceCommandContext & { interactionId: string };
export interface NativeVoicePlugin {
  setConnection(input: { profileId: string; serverOrigin: string; identity: string; reconnect?: boolean }): Promise<NativeVoiceState>;
  disconnect(input: NativeVoiceCommandContext): Promise<NativeVoiceState>;
  getState(): Promise<NativeVoiceState>;
  updateSettings(input: NativeVoiceCommandContext & { expectedRevision: number; patch: Partial<NativeVoiceSettings> }): Promise<NativeVoiceState>;
  setForegroundContext(input: NativeVoiceCommandContext & { visible: boolean; threadId?: string | null; threadTitle?: string | null; composerMode?: "queue" | "steer" }): Promise<NativeVoiceState>;
  startManualListen(input: NativeVoiceCommandContext & { threadId?: string; threadTitle?: string }): Promise<NativeVoiceState>;
  retargetActiveRecognition(input: NativeRecordingCommandContext & { threadId: string; threadTitle?: string }): Promise<NativeVoiceState>;
  setKeepListening(input: NativeRecordingCommandContext & { enabled: boolean }): Promise<NativeVoiceState>;
  sendRecording(input: NativeRecordingCommandContext): Promise<NativeVoiceState>;
  skipCurrentPlayback(input: NativeVoiceCommandContext): Promise<NativeVoiceState>;
  stopCurrentInteraction(input: NativeVoiceInteractionCommandContext): Promise<NativeVoiceState>;
  retryRecordingRecognition(input: NativeRecordingRecoveryCommandContext): Promise<NativeVoiceState>;
  sendRecoveredRecording(input: NativeRecordingRecoveryCommandContext & { acknowledgeIncomplete: boolean }): Promise<NativeVoiceState>;
  copyRecognizedRecordingText(input: NativeRecordingRecoveryCommandContext): Promise<NativeVoiceState>;
  discardRecording(input: NativeRecordingRecoveryCommandContext): Promise<NativeVoiceState>;
  resumeInput(input: NativeVoiceCommandContext & { mutationId: string }): Promise<NativeVoiceState>;
  discardInput(input: NativeVoiceCommandContext & { mutationId: string }): Promise<NativeVoiceState>;
  refreshSpeechCatalog(input: NativeVoiceCommandContext & { force: boolean }): Promise<NativeVoiceState>;
  /** Opens native masked credential entry. Secrets are never bridge arguments or results. */
  openSpeechCredentialDialog(input: NativeVoiceCommandContext): Promise<NativeVoiceState>;
  listInputDevices(): Promise<{ devices: Array<{ id: string; label: string; type: number }>; selectedId: string | null }>;
  addListener(event: "stateChanged" | "settingsChanged", listener: (state: NativeVoiceState) => void): Promise<PluginListenerHandle>;
  addListener(event: "runtimeError", listener: (error: { code: string; message: string; connectionGeneration: number;
    profileId: string | null; serverOrigin: string | null; identity: string | null }) => void): Promise<PluginListenerHandle>;
  addListener(event: "openThread", listener: (event: { threadId: string; profileId: string; serverOrigin: string;
    identity: string; connectionGeneration: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "inputSubmitted", listener: (event: NativeVoiceInputSubmitted) => void): Promise<PluginListenerHandle>;
}
export const nativeVoice = registerPlugin<NativeVoicePlugin>("NativeVoice");
export function hasNativeVoice(): boolean {
  return isAndroidClient() && typeof Capacitor.isPluginAvailable === "function" && Capacitor.isPluginAvailable("NativeVoice");
}
/** Best effort: callers continue on failure. Credential writes and removals also disconnect the matching native binding. */
export async function disconnectNativeVoice(): Promise<void> {
  if (!hasNativeVoice()) return;
  try {
    const current = nativeVoiceStateSchema.parse(await nativeVoice.getState());
    await nativeVoice.disconnect({ expectedConnectionGeneration: current.connectionGeneration });
  } catch { /* A newer connection or an already disconnected runtime needs nothing from this caller. */ }
}
/** Native accepts 1–512 UTF-16 units; an untitled thread crosses the bridge as null. */
export function nativeThreadTitle(text: string): string | null {
  const title = text.trim();
  if (title.length <= 512) return title || null;
  const high = title.charCodeAt(511);
  return title.slice(0, high >= 0xd800 && high <= 0xdbff ? 511 : 512).trimEnd();
}
