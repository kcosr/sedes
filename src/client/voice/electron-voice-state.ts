import { z } from "zod";
import { connectionScope, connectionScopeKey } from "../app/connection-scope.js";
import { nativeVoiceSettingsSchema, type NativeVoiceSettings, type NativeVoiceState } from "./native-voice-plugin.js";

export interface ElectronVoiceBinding { profileId: string; serverOrigin: string; identity: string }
export interface VoicePreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const SETTINGS_KEY = "sedes.electron.voice.preferences.v1";
const selectionSchema = z.strictObject({ scope: z.string(), threadId: z.string().nullable(), threadTitle: z.string().nullable() });
const preferencesSchema = z.strictObject({ version: z.literal(1), revision: z.number().int().nonnegative(),
  settings: nativeVoiceSettingsSchema, selections: z.array(selectionSchema).max(256) });

export function electronVoiceDefaults(): NativeVoiceSettings {
  return {
    audioMode: "off", speechContent: "both", autoListen: true, keepListeningByDefault: false,
    announceRecordingThread: false, ignoreOtherDevices: true, cleanSpeechText: true,
    speechProvider: "openai", speechEndpoint: "https://api.openai.com/v1", sttModel: "gpt-live-transcribe", ttsModel: "gpt-4o-mini-tts", ttsVoice: "coral",
    ttsSpeed: 1, speechTextLimit: 4096, voiceThreadId: null, voiceThreadTitle: null,
    pinDefaultVoiceThread: false, onlyVoiceThread: false, followComposerMode: false, inputDevice: null,
    recognitionStartTimeoutMs: 30_000, recognitionCompletionTimeoutMs: 60_000,
    recognitionResultTimeoutMs: 60_000, longDictationTimeoutMs: 3_600_000,
    recognitionEndSilenceMs: 1200, recognizeStopCommand: true, recognitionCues: true,
    cueGain: 100, startupPreRollMs: 0, ttsGain: 100, headsetControls: false,
  };
}

/** Validate desktop preferences without accepting Android-only hardware or lifecycle options. */
export function desktopVoiceSettings(value: unknown): NativeVoiceSettings {
  const settings = nativeVoiceSettingsSchema.parse(value);
  if (settings.headsetControls || settings.announceRecordingThread || settings.startupPreRollMs !== 0)
    throw new Error("This voice option is not supported by the desktop client.");
  if (settings.inputDevice && (!("platform" in settings.inputDevice) || settings.inputDevice.platform !== "electron"))
    throw new Error("Choose a desktop microphone.");
  if (settings.speechEndpoint) {
    const raw = settings.speechEndpoint, endpoint = new URL(raw);
    const path = endpoint.pathname.replace(/\/+$/u, "");
    const rawPath = /^https?:\/\/[^/]+(\/.*)?$/iu.exec(raw)?.[1] ?? "/";
    if (raw.length > 2048 || /[\u0000-\u001f\u007f]/u.test(raw) ||
        !["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || !endpoint.hostname ||
        raw !== raw.trim() || /[\\?#]/u.test(raw) || !path.endsWith("/v1") ||
        rawPath.replace(/\/+$/u, "") !== path || /%(?:2f|5c)/iu.test(path))
      throw new Error("Enter an HTTP or HTTPS speech API URL ending in /v1 without credentials, query or fragment.");
    settings.speechEndpoint = `${endpoint.origin}${path}`;
    if (settings.speechProvider === "server" && endpoint.hostname === "api.openai.com")
      throw new Error("Choose OpenAI to use api.openai.com.");
  }
  if (settings.speechProvider === "openai" && settings.speechEndpoint !== "https://api.openai.com/v1")
    throw new Error("OpenAI voice uses https://api.openai.com/v1. Choose Own speech server for another endpoint.");
  for (const key of ["sttModel", "ttsModel", "ttsVoice"] as const) {
    if (settings[key] !== settings[key].trim() || /[\u0000-\u001f\u007f]/u.test(settings[key])) throw new Error("Invalid speech model or voice.");
  }
  if (settings.recognitionStartTimeoutMs > 300_000 || settings.recognitionCompletionTimeoutMs > 300_000 ||
      settings.recognitionEndSilenceMs > 30_000 || settings.cueGain > 200 || settings.ttsGain > 200)
    throw new Error("Voice timing or gain is out of range.");
  return settings;
}

/** Only preferences are persisted. Audio, transcripts, pending sends and connection tokens never enter this record. */
export class ElectronVoicePreferences {
  #record: z.infer<typeof preferencesSchema> = { version: 1, revision: 0, settings: electronVoiceDefaults(), selections: [] };
  readonly reset: boolean;
  constructor(readonly storage?: VoicePreferenceStorage) {
    let reset = false;
    const raw = storage?.getItem(SETTINGS_KEY);
    if (raw) {
      try {
        const record = preferencesSchema.parse(JSON.parse(raw));
        record.settings = desktopVoiceSettings(record.settings);
        this.#record = record;
      } catch { reset = true; }
    }
    this.reset = reset;
  }
  get revision(): number { return this.#record.revision; }
  get(binding?: ElectronVoiceBinding): NativeVoiceSettings {
    const scope = binding ? connectionScopeKey(connectionScope(binding.profileId, binding.serverOrigin, binding.identity)) : undefined;
    const selection = this.#record.selections.find(item => item.scope === scope);
    return { ...structuredClone(this.#record.settings), voiceThreadId: selection?.threadId ?? null, voiceThreadTitle: selection?.threadTitle ?? null };
  }
  save(binding: ElectronVoiceBinding, settings: NativeVoiceSettings): void {
    const validated = desktopVoiceSettings(settings);
    const scope = connectionScopeKey(connectionScope(binding.profileId, binding.serverOrigin, binding.identity));
    const selections = this.#record.selections.filter(item => item.scope !== scope);
    selections.push({ scope, threadId: validated.voiceThreadId, threadTitle: validated.voiceThreadTitle });
    if (selections.length > 256) throw new Error("Too many saved voice connections.");
    const record = { version: 1 as const, revision: this.#record.revision + 1,
      settings: { ...validated, voiceThreadId: null, voiceThreadTitle: null }, selections };
    this.storage?.setItem(SETTINGS_KEY, JSON.stringify(record));
    this.#record = record;
  }
}

export function emptyElectronVoiceState(settings = electronVoiceDefaults()): NativeVoiceState {
  return {
    version: 16, stateRevision: 0, connectionGeneration: 0, profileId: null, serverOrigin: null, identity: null,
    originClientId: null, clientConnectionToken: null, settingsRevision: 0, settings,
    speech: { audioQuality: "original", audioQualityRevision: 0, credentialConfigured: false, catalogStatus: "idle", catalog: null, error: null },
    phase: "off", ready: false, readiness: "disconnected",
    foreground: { visible: false, threadId: null, threadTitle: null, composerAvailable: false },
    nextRecordingTarget: null, retainedVoiceTarget: null, idleTargetRevision: 0, active: null,
    queue: { count: 0, bytes: 0, droppedCount: 0, droppedReasons: {} },
    actions: { canStart: false, canStop: false, canSkip: false, canRecordDuringPlayback: false,
      canReleaseRetainedTarget: false, canRetarget: false, canResume: false, canSetKeepListening: false, canSend: false,
      keepListeningBlockedReason: "not_capturing" },
    recordingRecovery: null, recovery: [], errors: [],
  };
}
