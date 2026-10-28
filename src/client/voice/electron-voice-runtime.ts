import type { PluginListenerHandle } from "@capacitor/core";
import { z } from "zod";
import { clientVoiceSettingsSchema, type ClientActionResult, type ClientCommand, type ClientState } from "../../shared/protocol/client-controls.js";
import { notificationPolicySchema, selectedAssistantResultSchema, voiceNotificationSchema, type NotificationPolicy } from "../../shared/protocol/notification.js";
import { directInputReceiptSchema, directInputRequestBodySchema, threadInputContextSchema, type ThreadInputContext } from "../../shared/protocol/thread-input.js";
import { configuredSedesServer } from "../app/server-endpoint.js";
import { ElectronVoiceAudio, type ElectronVoiceCaptureOptions, type ElectronVoicePlayback, type ElectronVoicePlaybackOptions } from "./electron-voice-audio.js";
import { ElectronVoiceConnection, type ElectronVoiceConnectionCallbacks, type ElectronVoiceConnectionLike } from "./electron-voice-connection.js";
import { electronSpeech, type ElectronSpeechCatalog } from "./electron-speech-plugin.js";
import { automaticTargetCurrent, ElectronVoiceQueue, notificationEligible, notificationListens, stopCommand, voiceChunks, voiceItemText, type ElectronVoiceQueueItem } from "./electron-voice-policy.js";
import { base64Pcm, MemoryVoiceRecording } from "./electron-voice-recording.js";
import { desktopVoiceSettings, ElectronVoicePreferences, emptyElectronVoiceState, type ElectronVoiceBinding, type VoicePreferenceStorage } from "./electron-voice-state.js";
import { nativeThreadTitle, type NativeVoiceComposerHandoff, type NativeVoicePlugin, type NativeVoiceSettings, type NativeVoiceState } from "./native-voice-plugin.js";

interface DesktopAudio {
  listInputDevices(): Promise<Array<{ id: string; label: string }>>;
  startCapture(options: ElectronVoiceCaptureOptions): Promise<void>;
  stopCapture(): Promise<void>;
  createPlayback(options?: ElectronVoicePlaybackOptions): Promise<ElectronVoicePlayback>;
  playCue(kind: "start" | "success" | "failure", gain?: number, signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}
export interface ElectronVoiceRuntimeDependencies {
  speech?: typeof electronSpeech;
  audio?: DesktopAudio;
  storage?: VoicePreferenceStorage;
  connection?: (binding: ElectronVoiceBinding, callbacks: ElectronVoiceConnectionCallbacks, resumeToken?: string) => ElectronVoiceConnectionLike;
  uuid?: () => string;
  now?: () => number;
}
interface ActiveInteraction {
  id: string;
  generation: number;
  abort: AbortController;
  item?: ElectronVoiceQueueItem;
  target: string | null;
  title: string | null;
  automatic: boolean;
  recordingId?: string;
  recording?: MemoryVoiceRecording;
  recordingSettings?: NativeVoiceSettings;
  held: boolean;
  finishing: boolean;
  retargeting: boolean;
  finalized: boolean;
  captureStarted: boolean;
  captureEnding?: Promise<void>;
  limitTimer?: ReturnType<typeof setTimeout>;
  composer?: { threadId: string; mode: "queue" | "steer" };
  inputContext?: ThreadInputContext;
  pendingFinish?: boolean;
  clientTarget?: string;
  directInputPending?: boolean;
}
interface SpeechPlayback {
  active: ActiveInteraction;
  playback: ElectronVoicePlayback;
  pending: Promise<void>;
  nextSequence: number;
}
interface ComposerOffer {
  event: NativeVoiceComposerHandoff;
  active: ActiveInteraction;
  claimed: boolean;
  accepted: boolean;
  timer: ReturnType<typeof setTimeout>;
}
interface DeferredControl {
  command: ClientCommand;
  settled?: ClientCommand;
  navigationRevision: number;
  voiceOnly: boolean;
  timer: ReturnType<typeof setTimeout>;
}
const playbackPhases = new Set<NativeVoiceState["phase"]>(["synthesizing", "speaking"]);
const bindingSchema = z.strictObject({ profileId: z.string().min(1).max(160), serverOrigin: z.string(), identity: z.string().regex(/^[a-f0-9]{64}$/u), reconnect: z.boolean().optional() });
const replaySchema = z.strictObject({ expectedConnectionGeneration: z.number().int().nonnegative(), threadId: z.uuid(), turnId: z.string().min(1).max(160),
  threadTitle: z.string().max(512).nullable().optional(), assistantResult: selectedAssistantResultSchema });
const messageOf = (error: unknown): string => error instanceof Error ? error.message : "Voice could not complete this action.";
const uncertainInputMessage = "The send could not be confirmed. Check the thread before sending again. Nothing will be resent.";
const uncertainInputError = () => Object.assign(new Error(uncertainInputMessage), { code: "input_submission_uncertain" });

/** Owns voice only for this running desktop renderer. No audio, transcript or pending input is persisted. */
export class ElectronVoiceRuntime implements NativeVoicePlugin {
  readonly #speech: typeof electronSpeech;
  readonly #audio: DesktopAudio;
  readonly #preferences: ElectronVoicePreferences;
  readonly #connectionFactory: NonNullable<ElectronVoiceRuntimeDependencies["connection"]>;
  readonly #uuid: () => string;
  readonly #now: () => number;
  readonly #listeners = new Map<string, Set<(value: any) => void>>();
  readonly #queue = new ElectronVoiceQueue();
  readonly #playbacks = new Map<string, SpeechPlayback>();
  readonly #offers = new Map<string, ComposerOffer>();
  readonly #controls = new Map<string, DeferredControl>();
  readonly #drained = new Set<string>();
  #state: NativeVoiceState;
  #binding: ElectronVoiceBinding | undefined;
  #connection: ElectronVoiceConnectionLike | undefined;
  #resumeToken: string | undefined;
  #active: ActiveInteraction | undefined;
  #policy: NotificationPolicy | null = null;
  #notificationsConnected = false;
  #notificationsFailed = false;
  #connectionFailed = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #initialized: Promise<void> | undefined;
  #catalog: ElectronSpeechCatalog | undefined;
  #catalogRequest = 0;
  #speechGeneration = 0;
  #windowVisible = true;
  #reportedForeground: NativeVoiceState["foreground"] = { visible: false, threadId: null, threadTitle: null, composerAvailable: false };
  #composerMode: "queue" | "steer" = "queue";
  #lastViewedThread: string | null = null;
  #navigationRevision = 0;
  #drainScheduled = false;
  #captureStopped: Promise<void> = Promise.resolve();
  #retainedRevision = 0;
  #diagnosticsEnabled = false;
  #diagnostics: unknown[] = [];
  #diagnosticSequence = 0;
  readonly #startedAt: number;

  constructor(dependencies: ElectronVoiceRuntimeDependencies = {}) {
    this.#speech = dependencies.speech ?? electronSpeech;
    this.#audio = dependencies.audio ?? new ElectronVoiceAudio({ onDevicesChanged: () => {
      void this.listInputDevices().then(devices => this.#emit("inputDevicesChanged", devices)).catch(() => undefined);
    } });
    this.#preferences = new ElectronVoicePreferences(dependencies.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage));
    this.#connectionFactory = dependencies.connection ?? ((binding, callbacks, resumeToken) => new ElectronVoiceConnection(binding, callbacks, resumeToken));
    this.#uuid = dependencies.uuid ?? (() => crypto.randomUUID()); this.#now = dependencies.now ?? Date.now; this.#startedAt = this.#now();
    this.#state = emptyElectronVoiceState(this.#preferences.get());
    this.#state.settingsRevision = this.#preferences.revision;
  }

  async #initialize(): Promise<void> {
    if (this.#initialized) return this.#initialized;
    const handles: PluginListenerHandle[] = [];
    this.#initialized = (async () => {
      handles.push(await this.#speech.addAudioListener(event => {
        const output = this.#playbacks.get(event.requestId);
        if (!output || !this.#current(output.active)) return;
        if (event.sequence !== output.nextSequence++) { this.#fail(output.active, new Error("Speech audio arrived out of order.")); return; }
        output.pending = output.pending.then(async () => {
          if (!this.#current(output.active)) return;
          await output.playback.append(base64Pcm(event.pcm));
          if (!this.#current(output.active)) return;
          this.#state.phase = "speaking"; this.#publish();
          await this.#speech.acknowledgeAudio({ requestId: event.requestId, sequence: event.sequence });
        }).catch(error => this.#fail(output.active, error));
      }));
      handles.push(await this.#speech.addInterruptedListener(() => {
        this.#queue.items.length = 0; this.#clearControls();
        if (this.#active?.directInputPending) { this.#cancelActive(); this.#publish(); }
        else if (this.#active) this.#fail(this.#active, new Error("Desktop audio was interrupted. The recording was not saved or resent."));
      }));
      handles.push(await this.#speech.addRecognitionErrorListener(event => {
        const active = this.#active;
        if (active?.recording?.requestId === event.requestId) active.recording.fail(new Error(event.message));
      }));
      const windowState = await this.#speech.getWindowState();
      this.#windowVisible = windowState.visible;
      handles.push(await this.#speech.addWindowStateListener(({ visible }) => {
        this.#windowVisible = visible;
        this.#foregroundChanged();
      }));
    })().catch(async error => {
      await Promise.allSettled(handles.map(handle => handle.remove()));
      this.#initialized = undefined; throw error;
    });
    return this.#initialized;
  }

  #emit(event: string, value: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      try { listener(structuredClone(value)); } catch { /* A consumer cannot stop the audio owner. */ }
    }
  }
  async addListener(event: string, listener: (value: any) => void): Promise<PluginListenerHandle> {
    const listeners = this.#listeners.get(event) ?? new Set();
    this.#listeners.set(event, listeners); listeners.add(listener);
    return { remove: async () => { listeners.delete(listener); } };
  }
  #trace(event: string): void {
    if (!this.#diagnosticsEnabled) return;
    this.#diagnostics.push({ event, sequence: ++this.#diagnosticSequence,
      wallTimeMilliseconds: this.#now(), elapsedMilliseconds: Math.max(0, this.#now() - this.#startedAt),
      connectionGeneration: this.#state.connectionGeneration, streamGeneration: this.#state.connectionGeneration,
      policyGeneration: this.#policy?.generation ?? -1, queueCount: this.#queue.items.length, queueBytes: this.#queue.bytes(this.#state.settings) });
    if (this.#diagnostics.length > 512) this.#diagnostics.shift();
  }
  async setDiagnosticsEnabled(input: { enabled: boolean }): Promise<void> { this.#diagnosticsEnabled = z.boolean().parse(input.enabled); }
  async readDiagnostics(): Promise<unknown> { return { enabled: this.#diagnosticsEnabled, maximumEntries: 512, entries: structuredClone(this.#diagnostics) }; }
  async clearDiagnostics(): Promise<void> { this.#diagnostics = []; }
  #configured(): boolean {
    const settings = this.#state.settings;
    return this.#state.speech.credentialConfigured && !!settings.speechEndpoint && !!settings.sttModel && !!settings.ttsModel && !!settings.ttsVoice;
  }
  #sessionReady(): boolean { return this.#state.settings.audioMode !== "off" && !!this.#connection?.registration && this.#configured(); }
  #snapshot(): NativeVoiceState {
    const state = this.#state, active = this.#active;
    const session = this.#sessionReady(), playing = !!active && playbackPhases.has(state.phase);
    const capturing = !!active?.recording && state.phase === "listening" && !active.finishing;
    state.foreground = { ...this.#reportedForeground, visible: this.#reportedForeground.visible && this.#windowVisible };
    state.ready = session && this.#policy !== null && this.#notificationsConnected;
    state.readiness = !this.#binding ? "disconnected" : !this.#connection?.registration ? this.#connectionFailed ? "error" : "connecting" :
      state.settings.audioMode === "off" ? "off" : !this.#configured() ? "speechConfigurationRequired" :
      !this.#policy || !this.#notificationsConnected ? this.#notificationsFailed ? "notificationsUnavailable" : "notificationsConnecting" : "ready";
    state.active = active ? { id: active.id, eventKind: active.item?.event ?? "manual",
      threadId: active.item?.threadId ?? active.target, threadTitle: active.item?.threadTitle ?? active.title,
      recognitionThreadId: active.target, recognitionThreadTitle: active.title, automatic: active.automatic,
      recording: active.recordingId ? { id: active.recordingId, keepListening: active.held, reconnecting: false } : null } : null;
    state.queue = { count: this.#queue.items.length, bytes: this.#queue.bytes(state.settings),
      droppedReasons: { ...this.#queue.dropped }, droppedCount: Object.values(this.#queue.dropped).reduce((sum, count) => sum + count, 0) };
    state.actions = { canStart: session && !active, canStop: !!active, canSkip: playing,
      canRecordDuringPlayback: session && playing && !!active?.item?.threadId,
      canReleaseRetainedTarget: !active && state.retainedVoiceTarget !== null,
      canRetarget: capturing && !active!.retargeting, canResume: state.settings.audioMode !== "off" && (this.#connectionFailed || this.#notificationsFailed),
      canSetKeepListening: capturing && !active!.retargeting, canSend: capturing && !active!.retargeting,
      keepListeningBlockedReason: capturing ? active!.retargeting ? "operation_pending" : null : "not_capturing" };
    return structuredClone(state);
  }
  #publish(settingsChanged = false): NativeVoiceState {
    this.#state.stateRevision++;
    const state = this.#snapshot();
    this.#emit("stateChanged", state);
    if (settingsChanged) this.#emit("settingsChanged", state);
    return state;
  }
  #error(code: string, error: unknown): void {
    const message = messageOf(error).slice(0, 1024);
    this.#state.errors = [...this.#state.errors.slice(-15), { code, message }];
    this.#emit("runtimeError", { code, message, connectionGeneration: this.#state.connectionGeneration,
      profileId: this.#state.profileId, serverOrigin: this.#state.serverOrigin, identity: this.#state.identity });
  }
  #assertGeneration(input: { expectedConnectionGeneration: number }): void {
    if (!Number.isSafeInteger(input.expectedConnectionGeneration) || input.expectedConnectionGeneration !== this.#state.connectionGeneration)
      throw new Error("The Sedes connection changed before this voice action arrived.");
  }
  #current(active: ActiveInteraction): boolean { return this.#active === active && !active.abort.signal.aborted && active.generation === this.#state.connectionGeneration; }
  #assertActive(input: { expectedConnectionGeneration: number; interactionId: string }): ActiveInteraction {
    this.#assertGeneration(input);
    if (!this.#active || this.#active.id !== input.interactionId) throw new Error("This voice interaction has ended.");
    return this.#active;
  }
  #assertRecording(input: { expectedConnectionGeneration: number; recordingId: string }): ActiveInteraction {
    this.#assertGeneration(input);
    if (!this.#active || this.#active.recordingId !== input.recordingId) throw new Error("This recording has ended.");
    return this.#active;
  }
  #assertCurrent(active: ActiveInteraction): void { if (!this.#current(active)) throw new Error("Voice interaction cancelled."); }
  async getState(): Promise<NativeVoiceState> { return this.#snapshot(); }

  #clearReconnect(): void {
    clearTimeout(this.#reconnectTimer); this.#reconnectTimer = undefined;
  }
  /** Restore the application's control registration, never an interrupted voice interaction. */
  #scheduleReconnect(): void {
    if (!this.#binding || this.#reconnectTimer !== undefined) return;
    const binding = this.#binding, generation = this.#state.connectionGeneration;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#binding !== binding || this.#state.connectionGeneration !== generation) return;
      const foreground = { ...this.#reportedForeground };
      const uncertain = this.#state.errors.filter(error => error.code === "input_submission_uncertain");
      const connecting = this.setConnection({ ...binding, reconnect: true });
      // setConnection resets synchronously before its first await. Seed the new
      // registration with the current view without overwriting later navigation.
      if (this.#state.connectionGeneration === generation + 1) {
        this.#reportedForeground = foreground; this.#lastViewedThread = foreground.threadId;
        this.#state.errors = uncertain; this.#foregroundChanged();
      }
      void connecting.catch(() => undefined);
    }, 5_000);
  }

  async setConnection(input: Parameters<NativeVoicePlugin["setConnection"]>[0]): Promise<NativeVoiceState> {
    const parsed = bindingSchema.parse(input);
    const binding = { profileId: parsed.profileId, serverOrigin: configuredSedesServer(parsed.serverOrigin).baseUrl!, identity: parsed.identity };
    const sameBinding = this.#binding && Object.keys(binding).every(key => binding[key as keyof ElectronVoiceBinding] === this.#binding![key as keyof ElectronVoiceBinding]);
    if (!parsed.reconnect && sameBinding) return this.#snapshot();
    if (!sameBinding) this.#resumeToken = undefined;
    this.#clearReconnect();
    this.#connection?.close(); this.#connection = undefined;
    this.#cancelActive(); this.#clearControls(); this.#queue.reset(); this.#drained.clear();
    this.#binding = binding;
    this.#state = { ...emptyElectronVoiceState(this.#preferences.get(binding)), ...binding,
      connectionGeneration: this.#state.connectionGeneration + 1, stateRevision: this.#state.stateRevision,
      settingsRevision: this.#preferences.revision, phase: "starting" };
    this.#policy = null; this.#notificationsConnected = false; this.#notificationsFailed = false; this.#connectionFailed = false;
    this.#reportedForeground = { visible: false, threadId: null, threadTitle: null, composerAvailable: false };
    this.#lastViewedThread = null; this.#catalog = undefined;
    const generation = this.#state.connectionGeneration;
    this.#publish();
    try {
      await this.#initialize();
      if (generation !== this.#state.connectionGeneration) return this.#snapshot();
      const connection = this.#connectionFactory(binding, {
        state: () => this.#clientState(), command: command => this.#executeControl(command),
        registered: registration => {
          if (generation !== this.#state.connectionGeneration) return;
          this.#state.originClientId = registration?.clientId ?? null;
          this.#state.clientConnectionToken = registration?.connectionToken ?? null;
          if (registration) this.#resumeToken = registration.resumeToken;
          this.#publish();
        },
        frame: (event, value) => { if (generation === this.#state.connectionGeneration) this.#frame(event, value); },
        notificationsChanged: connected => {
          if (generation !== this.#state.connectionGeneration) return;
          this.#notificationsConnected = connected;
          if (!connected) { this.#policy = null; this.#cancelAutomatic(); }
          this.#publish();
        },
        failed: code => {
          if (generation !== this.#state.connectionGeneration) return;
          if (code.startsWith("notification_")) {
            this.#notificationsFailed = true; this.#policy = null; this.#cancelAutomatic();
            this.#error(code, new Error("Sedes notifications stopped. Resume voice to reconnect."));
          } else {
            const reconnects = code === "client_connection_unavailable" || code === "client_session_expired";
            if (code !== "client_connection_unavailable") this.#resumeToken = undefined;
            if (!reconnects) this.#clearReconnect();
            this.#connectionFailed = true;
            const uncertainInput = this.#cancelActive();
            this.#clearControls(); this.#queue.items.length = 0;
            this.#state.phase = "error";
            if (!uncertainInput) this.#error(code, new Error(code === "client_connection_replaced"
              ? "Client controls are active in another window. Reconnect to use this window."
              : reconnects ? "The Sedes connection stopped. Reconnecting client controls."
              : "The Sedes voice connection stopped. Reconnect to continue."));
            if (reconnects) this.#scheduleReconnect();
          }
          this.#publish();
        },
      }, this.#resumeToken);
      this.#connection = connection;
      await connection.connect();
      if (generation !== this.#state.connectionGeneration) { connection.close(); return this.#snapshot(); }
      if (this.#state.settings.audioMode !== "off") connection.notifications(true);
      await this.#configureSpeech();
      if (generation !== this.#state.connectionGeneration) return this.#snapshot();
      if (!this.#active) this.#state.phase = this.#state.settings.audioMode === "off" ? "off" : "idle";
      this.#scheduleDrain();
      if (this.#preferences.reset) this.#error("voice_settings_reset", new Error("Desktop voice settings were reset because their saved format was invalid."));
    } catch (error) {
      if (generation !== this.#state.connectionGeneration) return this.#snapshot();
      if (!this.#connectionFailed) {
        this.#connectionFailed = !this.#connection?.registration;
        this.#state.phase = "error"; this.#error("voice_connection_unavailable", error);
      }
    }
    return this.#publish();
  }
  async disconnect(input: Parameters<NativeVoicePlugin["disconnect"]>[0]): Promise<NativeVoiceState> {
    this.#assertGeneration(input);
    this.#clearReconnect();
    this.#resumeToken = undefined;
    this.#connection?.close(); this.#connection = undefined; this.#cancelActive(); this.#clearControls(); this.#queue.reset();
    this.#binding = undefined; this.#policy = null; this.#catalogRequest++; this.#speechGeneration++;
    const generation = this.#state.connectionGeneration + 1, revision = this.#state.stateRevision;
    this.#state = { ...emptyElectronVoiceState(this.#preferences.get()), connectionGeneration: generation, stateRevision: revision,
      settingsRevision: this.#preferences.revision };
    this.#trace("disconnected");
    await this.#speech.cancelAll().catch(() => undefined);
    return this.#publish();
  }

  async #configureSpeech(): Promise<void> {
    const generation = this.#state.connectionGeneration, request = ++this.#speechGeneration;
    const { speechProvider: provider, speechEndpoint: endpoint } = this.#state.settings;
    this.#catalog = undefined; this.#catalogRequest++;
    this.#state.speech = { credentialConfigured: false, catalogStatus: "idle", catalog: null, error: null };
    if (!endpoint) { await this.#speech.cancelAll(); return; }
    const configured = await this.#speech.configure({ provider, endpoint });
    if (generation !== this.#state.connectionGeneration || request !== this.#speechGeneration) return;
    this.#state.settings.speechEndpoint = configured.endpoint;
    this.#state.speech.credentialConfigured = configured.credentialConfigured;
    if (configured.credentialConfigured) await this.#refreshCatalog();
  }
  async #refreshCatalog(): Promise<void> {
    const { speechProvider: provider, speechEndpoint: endpoint } = this.#state.settings;
    if (!endpoint || !this.#state.speech.credentialConfigured) return;
    const request = ++this.#catalogRequest, generation = this.#state.connectionGeneration;
    this.#state.speech.catalogStatus = "loading"; this.#publish();
    try {
      const catalog = await this.#speech.getCapabilities({ provider, endpoint });
      if (request !== this.#catalogRequest || generation !== this.#state.connectionGeneration) return;
      this.#catalog = catalog;
      const selected = catalog.speechModels.find(model => model.id === this.#state.settings.ttsModel);
      this.#state.speech.catalog = { source: provider, sttModels: catalog.transcriptionModels.map(model => model.id),
        ttsModels: catalog.speechModels.map(model => model.id), voices: selected?.voices.map(voice => voice.id) ?? [],
        speed: selected ? { min: selected.speed.min, max: selected.speed.max } : null, formats: ["pcm"] };
      this.#state.speech.catalogStatus = "ready"; this.#state.speech.error = null;
    } catch (error) {
      if (request !== this.#catalogRequest || generation !== this.#state.connectionGeneration) return;
      this.#state.speech.catalogStatus = "error"; this.#state.speech.error = messageOf(error);
    }
    this.#publish();
  }
  async refreshSpeechCatalog(input: Parameters<NativeVoicePlugin["refreshSpeechCatalog"]>[0]): Promise<NativeVoiceState> {
    this.#assertGeneration(input);
    if (input.force || !this.#catalog) await this.#refreshCatalog();
    return this.#snapshot();
  }
  async openSpeechCredentialDialog(input: Parameters<NativeVoicePlugin["openSpeechCredentialDialog"]>[0]): Promise<NativeVoiceState> {
    this.#assertGeneration(input);
    const revision = this.#state.settingsRevision;
    const { speechProvider: provider, speechEndpoint: endpoint } = this.#state.settings;
    if (!endpoint) throw new Error("Set the speech server API URL first.");
    await this.#initialize();
    const result = await this.#speech.openCredentialDialog({ provider, endpoint });
    this.#assertGeneration(input);
    if (revision !== this.#state.settingsRevision || provider !== this.#state.settings.speechProvider || endpoint !== this.#state.settings.speechEndpoint)
      throw new Error("Speech settings changed while the credential dialog was open.");
    this.#cancelActive(); this.#discardQueuedReplies();
    this.#state.speech.credentialConfigured = result.credentialConfigured;
    await this.#configureSpeech();
    this.#assertGeneration(input);
    if (revision !== this.#state.settingsRevision || provider !== this.#state.settings.speechProvider || endpoint !== this.#state.settings.speechEndpoint) return this.#snapshot();
    if (!this.#active) this.#state.phase = this.#state.settings.audioMode === "off" ? "off" : "idle";
    this.#scheduleDrain();
    return this.#publish();
  }
  async updateSettings(input: Parameters<NativeVoicePlugin["updateSettings"]>[0]): Promise<NativeVoiceState> {
    this.#assertGeneration(input);
    if (!this.#binding) throw new Error("Connect to Sedes first.");
    if (input.expectedRevision !== this.#state.settingsRevision) throw new Error("Voice settings changed. Try the action again.");
    const old = this.#state.settings;
    const next = desktopVoiceSettings({ ...old, ...input.patch });
    this.#preferences.save(this.#binding, next);
    this.#state.settings = next; this.#state.settingsRevision = this.#preferences.revision;
    const savedRevision = this.#state.settingsRevision;
    for (const id of this.#queue.reconfigure(next)) this.#rememberDrained(id);
    if (old.pinDefaultVoiceThread !== next.pinDefaultVoiceThread || old.voiceThreadId !== next.voiceThreadId) {
      this.#state.retainedVoiceTarget = null; this.#state.idleTargetRevision++;
    }
    const speechChanged = (["speechProvider", "speechEndpoint", "sttModel", "ttsModel", "ttsVoice", "ttsSpeed"] as const).some(key => old[key] !== next[key]);
    if (next.audioMode === "off") {
      this.#cancelActive(); this.#clearControls(); this.#queue.items.length = 0;
      this.#state.nextRecordingTarget = null; this.#state.retainedVoiceTarget = null;
      this.#connection?.notifications(false); this.#state.phase = "off";
    } else if (old.audioMode !== next.audioMode) this.#cancelAutomatic();
    if (speechChanged) {
      // Finalized text already belongs to its one Sedes submission, independently of the speech provider.
      if (this.#active && !this.#active.finalized) this.#cancelActive();
      this.#discardQueuedReplies();
      await this.#configureSpeech();
      this.#assertGeneration(input);
      if (this.#state.settingsRevision !== savedRevision) return this.#snapshot();
    }
    if (next.audioMode !== "off") {
      if (!this.#connection?.registration) return this.setConnection({ ...this.#binding, reconnect: true });
      if (old.audioMode === "off" || this.#notificationsFailed) {
        this.#notificationsFailed = false;
        this.#connection.notifications(false); this.#connection.notifications(true);
      }
      if (!this.#active) this.#state.phase = "idle";
    }
    if (!next.autoListen && this.#active?.automatic && this.#active.recordingId && !this.#active.finalized) this.#cancelActive();
    if (this.#active?.automatic && this.#active.item && !this.#active.finalized && !this.#eligible(this.#active.item)) this.#cancelActive();
    this.#rememberIdleTarget(); this.#scheduleDrain();
    return this.#publish(true);
  }

  async listInputDevices(): Promise<Awaited<ReturnType<NativeVoicePlugin["listInputDevices"]>>> {
    return { devices: (await this.#audio.listInputDevices()).map(device => ({ ...device, platform: "electron" as const })) };
  }
  async setForegroundContext(input: Parameters<NativeVoicePlugin["setForegroundContext"]>[0]): Promise<NativeVoiceState> {
    this.#assertGeneration(input);
    const parsed = z.strictObject({ expectedConnectionGeneration: z.number(), visible: z.boolean(), threadId: z.string().min(1).nullable().optional(),
      threadTitle: z.string().max(512).nullable().optional(), composerMode: z.enum(["queue", "steer"]).optional(), composerAvailable: z.boolean() }).parse(input);
    const threadId = parsed.threadId ?? null;
    if (parsed.visible && threadId !== this.#lastViewedThread) {
      this.#navigationRevision++;
      if (this.#active?.clientTarget !== threadId) {
        this.#clearControls();
        if (this.#active?.clientTarget && !this.#active.captureStarted) { this.#cancelActive(); this.#scheduleDrain(); }
      }
      if (!this.#active && !this.#state.nextRecordingTarget && !this.#state.settings.pinDefaultVoiceThread) this.#retain(threadId, parsed.threadTitle ?? null);
      this.#lastViewedThread = threadId;
    }
    this.#reportedForeground = { visible: parsed.visible, threadId, threadTitle: parsed.threadTitle ?? null, composerAvailable: parsed.composerAvailable };
    this.#composerMode = parsed.composerMode ?? "queue";
    this.#foregroundChanged();
    return this.#snapshot();
  }
  #foregroundChanged(): void {
    if (!this.#reportedForeground.visible || !this.#windowVisible) for (const action of this.#controls.values()) action.voiceOnly = true;
    this.#rememberIdleTarget(); this.#publish();
  }
  #retain(threadId: string | null, threadTitle: string | null): void {
    this.#retainedRevision++;
    this.#state.retainedVoiceTarget = !this.#state.settings.pinDefaultVoiceThread && threadId
      ? { threadId, threadTitle: threadTitle ? nativeThreadTitle(threadTitle) : null, revision: this.#retainedRevision } : null;
    this.#state.idleTargetRevision++;
  }
  #rememberIdleTarget(): void {
    if (!this.#active && !this.#state.retainedVoiceTarget && !this.#state.nextRecordingTarget && !this.#state.settings.pinDefaultVoiceThread && this.#reportedForeground.threadId)
      this.#retain(this.#reportedForeground.threadId, this.#reportedForeground.threadTitle);
  }
  #target(explicit?: { threadId?: string; threadTitle?: string }): { threadId: string; threadTitle: string | null } {
    const settings = this.#state.settings;
    if (explicit?.threadId) return { threadId: z.uuid().parse(explicit.threadId), threadTitle: explicit.threadTitle ?? null };
    if (this.#state.nextRecordingTarget) return this.#state.nextRecordingTarget;
    if (settings.pinDefaultVoiceThread) {
      if (!settings.voiceThreadId) throw new Error("Choose a default voice thread for this connection.");
      return { threadId: settings.voiceThreadId, threadTitle: settings.voiceThreadTitle };
    }
    if (this.#state.retainedVoiceTarget) return this.#state.retainedVoiceTarget;
    if (this.#reportedForeground.threadId) return { threadId: this.#reportedForeground.threadId, threadTitle: this.#reportedForeground.threadTitle };
    if (settings.voiceThreadId) return { threadId: settings.voiceThreadId, threadTitle: settings.voiceThreadTitle };
    throw new Error("Choose a thread before recording.");
  }
  async setNextRecordingTarget(input: Parameters<NativeVoicePlugin["setNextRecordingTarget"]>[0]): Promise<NativeVoiceState> {
    this.#assertGeneration(input);
    if (this.#active || this.#state.settings.audioMode === "off") throw new Error("Choose the next thread while voice is idle.");
    this.#state.nextRecordingTarget = { threadId: z.uuid().parse(input.threadId), threadTitle: input.threadTitle ? nativeThreadTitle(input.threadTitle) : null };
    this.#state.idleTargetRevision++;
    return this.#publish();
  }
  async releaseRetainedVoiceTarget(input: Parameters<NativeVoicePlugin["releaseRetainedVoiceTarget"]>[0]): Promise<NativeVoiceState> {
    this.#assertGeneration(input);
    if (!this.#active && this.#state.retainedVoiceTarget?.revision === input.expectedRetainedRevision) {
      this.#state.retainedVoiceTarget = null; this.#state.idleTargetRevision++; this.#rememberIdleTarget();
    }
    return this.#publish();
  }
  #activate(target: string | null, title: string | null, item?: ElectronVoiceQueueItem): ActiveInteraction {
    const active: ActiveInteraction = { id: item?.id ?? this.#uuid(), generation: this.#state.connectionGeneration,
      abort: new AbortController(), item, target, title, automatic: !!item?.notification, held: false,
      finishing: false, retargeting: false, finalized: false, captureStarted: false };
    this.#active = active;
    void this.#speech.setAudioActive({ active: true }).catch(error => this.#fail(active, error));
    return active;
  }
  async startManualListen(input: Parameters<NativeVoicePlugin["startManualListen"]>[0]): Promise<NativeVoiceState> {
    this.#assertGeneration(input);
    if (!this.#sessionReady() || this.#active) throw new Error("Voice is not ready to record.");
    const target = this.#target(input);
    this.#clearControls(); this.#state.nextRecordingTarget = null;
    const active = this.#activate(target.threadId, target.threadTitle);
    this.#state.phase = "validating";
    void this.#listen(active).catch(error => this.#fail(active, error));
    return this.#publish();
  }
  async #context(threadId: string, signal?: AbortSignal): Promise<ThreadInputContext> {
    const connection = this.#connection, generation = this.#state.connectionGeneration;
    if (!connection?.registration) throw new Error("The Sedes connection is unavailable.");
    const response = await connection.request(`/api/threads/${encodeURIComponent(threadId)}/input-context`, { signal });
    if (generation !== this.#state.connectionGeneration || connection !== this.#connection) throw new Error("The Sedes connection changed.");
    if (!response.ok) throw new Error("The selected thread is unavailable for voice input.");
    const context = threadInputContextSchema.parse(await response.json());
    if (generation !== this.#state.connectionGeneration || connection !== this.#connection) throw new Error("The Sedes connection changed.");
    if (context.threadId !== threadId) throw new Error("Sedes returned a different voice thread.");
    return context;
  }
  #captureAllowed(active: ActiveInteraction, context: ThreadInputContext, previous?: ThreadInputContext): boolean {
    if (!this.#sessionReady()) return false;
    if (active.automatic && active.item?.notification) return this.#eligible(active.item) && this.#state.settings.autoListen && automaticTargetCurrent(active.item.notification, context);
    return context.manualListenEligible && (!previous || context.activityToken === previous.activityToken);
  }
  async #listen(active: ActiveInteraction): Promise<void> {
    if (!active.target) throw new Error("This reply has no recording destination.");
    this.#state.phase = "validating"; this.#publish();
    const initial = await this.#context(active.target, active.abort.signal); this.#assertCurrent(active);
    if (!this.#captureAllowed(active, initial)) { if (active.automatic || active.item?.replay) this.#finish(active); else throw new Error("The selected thread cannot accept voice input."); return; }
    active.title = nativeThreadTitle(initial.threadTitle); active.inputContext = initial;
    active.recordingId = this.#uuid(); active.recordingSettings = structuredClone(this.#state.settings);
    active.held = active.recordingSettings.keepListeningByDefault;
    this.#retain(active.target, active.title);
    this.#state.phase = "arming"; this.#publish();
    if (active.recordingSettings.recognitionCues) { await this.#audio.playCue("start", active.recordingSettings.cueGain / 100, active.abort.signal); this.#assertCurrent(active); }
    const afterCue = await this.#context(active.target, active.abort.signal); this.#assertCurrent(active);
    if (!this.#captureAllowed(active, afterCue, initial)) { this.#finish(active); return; }
    const recording = new MemoryVoiceRecording({ speech: this.#speech, settings: active.recordingSettings,
      uuid: this.#uuid, now: this.#now, failed: error => this.#fail(active, error) });
    active.recording = recording;
    await recording.start(); this.#assertCurrent(active);
    const ready = await this.#context(active.target, active.abort.signal); this.#assertCurrent(active);
    if (!this.#captureAllowed(active, ready, initial)) { this.#finish(active); return; }
    active.inputContext = ready;
    const device = active.recordingSettings.inputDevice;
    if (device && !("platform" in device)) throw new Error("Choose a desktop microphone.");
    await this.#captureStopped; this.#assertCurrent(active);
    await this.#audio.startCapture({ ...(device && "deviceId" in device ? { deviceId: device.deviceId } : {}),
      onPcm: pcm => {
        if (!this.#current(active)) return;
        try {
          const endpoint = recording.accept(pcm);
          if (active.finishing) return;
          if (endpoint === "no_speech") {
            void this.#finishNoSpeech(active);
          } else if (endpoint !== "continue") void this.#finishRecording(active, false);
        } catch (error) { this.#fail(active, error); }
      },
      onEnded: error => this.#fail(active, error),
    });
    if (!this.#current(active) || active.finishing) return;
    active.captureStarted = true;
    if (active.held) { active.automatic = false; this.#startHeldDeadline(active); }
    this.#state.phase = "listening"; this.#publish();
  }
  async #finishNoSpeech(active: ActiveInteraction): Promise<void> {
    if (!this.#current(active) || active.finishing) return;
    active.finishing = true; clearTimeout(active.limitTimer); active.recording?.cancel();
    this.#state.phase = "recognizing"; this.#publish();
    try {
      this.#captureStopped = this.#audio.stopCapture();
      await this.#captureStopped; this.#assertCurrent(active);
      if (active.recordingSettings?.recognitionCues) {
        try { await this.#audio.playCue("failure", active.recordingSettings.cueGain / 100, active.abort.signal); } catch { /* No speech is a normal completion even when its feedback cue cannot play. */ }
        this.#assertCurrent(active);
      }
      this.#finish(active);
    } catch (error) { this.#fail(active, error); }
  }
  #startHeldDeadline(active: ActiveInteraction): void {
    if (active.limitTimer) return;
    active.limitTimer = setTimeout(() => { if (this.#current(active)) void this.#finishRecording(active, true); }, active.recordingSettings!.longDictationTimeoutMs);
  }
  async setKeepListening(input: Parameters<NativeVoicePlugin["setKeepListening"]>[0]): Promise<NativeVoiceState> {
    const active = this.#assertRecording(input);
    if (!active.recording || this.#state.phase !== "listening" || active.finishing || active.retargeting) throw new Error("This recording cannot change Keep listening now.");
    active.held = z.boolean().parse(input.enabled); active.recording.setHeld(active.held);
    if (active.held) { active.automatic = false; this.#clearControls(); this.#startHeldDeadline(active); }
    return this.#publish();
  }
  async retargetActiveRecognition(input: Parameters<NativeVoicePlugin["retargetActiveRecognition"]>[0]): Promise<NativeVoiceState> {
    const active = this.#assertRecording(input);
    if (!active.recording || this.#state.phase !== "listening" || active.finishing || active.retargeting) throw new Error("This recording cannot change thread now.");
    const target = z.uuid().parse(input.threadId);
    active.retargeting = true; this.#publish();
    try {
      const context = await this.#context(target, active.abort.signal); this.#assertCurrent(active);
      if (!context.manualListenEligible || active.finishing) throw new Error("The selected thread cannot accept this recording.");
      active.target = target; active.title = nativeThreadTitle(context.threadTitle); active.automatic = false; active.inputContext = context;
      this.#retain(active.target, active.title); this.#clearControls();
    } finally {
      active.retargeting = false;
      if (this.#current(active)) {
        this.#publish();
        if (active.pendingFinish !== undefined) void this.#finishRecording(active, active.pendingFinish);
      }
    }
    return this.#publish();
  }
  async sendRecording(input: Parameters<NativeVoicePlugin["sendRecording"]>[0]): Promise<NativeVoiceState> {
    const active = this.#assertRecording(input);
    if (active.finishing) return this.#snapshot();
    if (!active.recording || this.#state.phase !== "listening" || active.retargeting) throw new Error("The recording is not ready to send.");
    void this.#finishRecording(active, true);
    return this.#snapshot();
  }
  async #finishRecording(active: ActiveInteraction, explicitSend: boolean): Promise<void> {
    if (!this.#current(active) || active.finishing || !active.recording) return;
    if (active.retargeting) { active.pendingFinish = active.pendingFinish || explicitSend; return; }
    active.finishing = true; clearTimeout(active.limitTimer);
    const foreground = this.#snapshot().foreground;
    const mode = active.recordingSettings!.followComposerMode && foreground.threadId === active.target ? this.#composerMode : "queue";
    if (foreground.visible && foreground.composerAvailable && foreground.threadId === active.target) active.composer = { threadId: active.target!, mode };
    this.#state.phase = "recognizing"; this.#publish();
    try {
      // Normal stop flushes the worklet's accepted tail before the segmenter is finalized.
      active.captureEnding = this.#audio.stopCapture(); this.#captureStopped = active.captureEnding.catch(() => undefined);
      await active.captureEnding; this.#assertCurrent(active); active.captureEnding = undefined;
      const text = await active.recording.finish(); this.#assertCurrent(active);
      active.finalized = true;
      if (!text.trim() || !explicitSend && active.recordingSettings!.recognizeStopCommand && stopCommand(text)) { this.#finish(active); return; }
      if (active.recordingSettings!.recognitionCues) {
        try { await this.#audio.playCue("success", active.recordingSettings!.cueGain / 100, active.abort.signal); } catch { /* Captured text still proceeds after feedback failure. */ }
        this.#assertCurrent(active);
      }
      if (active.composer) {
        if (!this.#snapshot().foreground.visible) throw new Error("The composer was hidden before it could accept the recording. Nothing was sent.");
        this.#offerComposer(active, text, active.composer.mode);
      } else await this.#submit(active, text, mode);
    } catch (error) { this.#fail(active, error); }
  }
  #offerComposer(active: ActiveInteraction, text: string, mode: "queue" | "steer"): void {
    if (!this.#binding || !active.recordingId || !active.target) throw new Error("Recording binding unavailable.");
    const event: NativeVoiceComposerHandoff = { ...this.#binding, connectionGeneration: active.generation,
      handoffId: this.#uuid(), recordingId: active.recordingId, threadId: active.target, text, mode };
    const offer: ComposerOffer = { event, active, claimed: false, accepted: false,
      timer: setTimeout(() => { if (this.#offers.has(event.handoffId)) this.#fail(active, new Error("The composer did not accept this recording. It was not sent.")); }, 15_000) };
    this.#offers.set(event.handoffId, offer); this.#state.phase = "submitting"; this.#publish();
    this.#emit("composerHandoff", event);
  }
  #offer(input: { expectedConnectionGeneration: number; handoffId: string }): ComposerOffer {
    this.#assertGeneration(input);
    const offer = this.#offers.get(input.handoffId);
    if (!offer || !this.#current(offer.active)) throw new Error("This composer handoff has ended.");
    return offer;
  }
  async claimComposerHandoff(input: Parameters<NativeVoicePlugin["claimComposerHandoff"]>[0]): Promise<NativeVoiceState> {
    const offer = this.#offer(input);
    if (!offer.claimed) {
      offer.claimed = true; clearTimeout(offer.timer);
      offer.timer = setTimeout(() => this.#fail(offer.active, new Error("The composer send did not settle. Check the thread before sending again.")), 90_000);
    }
    return this.#publish();
  }
  async completeComposerHandoff(input: Parameters<NativeVoicePlugin["completeComposerHandoff"]>[0]): Promise<NativeVoiceState> {
    const offer = this.#offer(input);
    if (!offer.claimed && input.outcome === "accepted") throw new Error("Claim the composer handoff before accepting it.");
    if (input.outcome === "declined") {
      this.#error("composer_handoff_declined", new Error(input.message || "The composer could not accept this recording. It was not sent."));
      this.#finish(offer.active);
    } else {
      offer.accepted = true;
      // The composer owns its text now. Only the playback hold remains until its one send attempt settles.
      offer.event = { ...offer.event, text: "" };
      if (!input.submissionPending) this.#finish(offer.active);
    }
    return this.#publish();
  }
  async settleComposerSubmission(input: Parameters<NativeVoicePlugin["settleComposerSubmission"]>[0]): Promise<NativeVoiceState> {
    this.#assertGeneration(input);
    const offer = this.#offers.get(input.handoffId);
    if (offer?.claimed && this.#current(offer.active)) this.#finish(offer.active);
    return this.#publish();
  }
  async #submit(active: ActiveInteraction, text: string, mode: "queue" | "steer"): Promise<void> {
    this.#assertCurrent(active);
    const context = await this.#context(active.target!, active.abort.signal); this.#assertCurrent(active);
    const mutationId = this.#uuid();
    const body = directInputRequestBodySchema.parse({ mutationId, text, runningPolicy: mode === "steer" && context.steer.availability === "available"
      ? { mode: "steer", target: context.steer.target, onUnavailable: "queue" } : { mode: "queue" } });
    this.#state.phase = "submitting"; this.#publish();
    this.#assertCurrent(active);
    let receipt: ReturnType<typeof directInputReceiptSchema.parse>;
    active.directInputPending = true;
    try {
      let response: Response;
      try {
        response = await this.#connection!.request(`/api/threads/${encodeURIComponent(active.target!)}/inputs`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: active.abort.signal });
      } catch { throw uncertainInputError(); }
      this.#assertCurrent(active);
      if (!response.ok) throw response.status >= 500 || response.status === 408
        ? uncertainInputError() : new Error("Sedes did not accept the voice input. Check the thread before recording again.");
      try { receipt = directInputReceiptSchema.parse(await response.json()); } catch { throw uncertainInputError(); }
      this.#assertCurrent(active);
      if (receipt.mutationId !== mutationId || receipt.threadId !== active.target) throw uncertainInputError();
    } finally { active.directInputPending = false; }
    if (["failed", "cancelled", "recovery_required"].includes(receipt.status)) this.#error("input_delivery_failed", new Error("Sedes received the input but delivery needs attention in the thread."));
    const foreground = this.#snapshot().foreground;
    if (receipt.admittedMode === "submit" && foreground.visible && foreground.threadId === active.target && this.#binding)
      this.#emit("inputSubmitted", { ...this.#binding, connectionGeneration: active.generation, threadId: active.target,
        operationId: receipt.operationId, text, queuedInputId: receipt.queuedInputId ?? null });
    this.#finish(active);
  }

  #eligible(item: ElectronVoiceQueueItem): boolean {
    return !item.notification || notificationEligible(item.notification, this.#policy, this.#state.settings, this.#state.originClientId);
  }
  #frame(event: "notification_policy" | "notification", raw: unknown): void {
    try {
      if (event === "notification_policy") {
        const policy = notificationPolicySchema.parse(raw);
        if (this.#policy && policy.generation < this.#policy.generation) return;
        if (!this.#policy || policy.generation !== this.#policy.generation) this.#cancelAutomatic();
        this.#policy = policy; this.#notificationsFailed = false; this.#trace("policy_received"); this.#publish(); this.#scheduleDrain(); return;
      }
      const notice = voiceNotificationSchema.parse(raw);
      const item: ElectronVoiceQueueItem = { id: notice.sourceEventId, notification: notice, event: notice.payload.event,
        threadId: notice.payload.thread?.id ?? null, threadTitle: notice.payload.thread ? nativeThreadTitle(notice.payload.thread.title) : null };
      this.#trace("received");
      if (!this.#eligible(item) || !voiceItemText(item, this.#state.settings) && !notificationListens(notice, this.#state.settings)) {
        this.#rememberDrained(item.id); this.#queue.drop("ineligible"); this.#scheduleDrain(); this.#publish(); return;
      }
      const previous = this.#queue.items.map(queued => queued.id);
      if (this.#active?.item?.id !== item.id && this.#queue.add(item, this.#state.settings)) this.#trace("queued");
      for (const id of previous) if (!this.#queue.items.some(queued => queued.id === id)) this.#rememberDrained(id);
      if (this.#active?.item?.id !== item.id && !this.#queue.items.some(queued => queued.id === item.id)) this.#rememberDrained(item.id);
      this.#publish(); this.#scheduleDrain();
    } catch (error) {
      this.#connection?.notifications(false); this.#notificationsFailed = true; this.#policy = null; this.#cancelAutomatic();
      this.#error("invalid_notification_frame", error); this.#publish();
    }
  }
  #cancelAutomatic(): void {
    for (const item of this.#queue.items) if (item.notification) this.#rememberDrained(item.id);
    this.#queue.clearAutomatic("notification_policy_changed");
    if (this.#active?.automatic && !this.#active.finalized) this.#cancelActive();
    this.#scheduleDrain();
  }
  #discardQueuedReplies(): void {
    for (const item of this.#queue.items) this.#rememberDrained(item.id);
    this.#queue.items.length = 0;
  }
  async speakReply(input: Parameters<NativeVoicePlugin["speakReply"]>[0]): Promise<NativeVoiceState> {
    const request = replaySchema.parse(input); this.#assertGeneration(request);
    if (!this.#sessionReady()) throw new Error("Voice is not ready to play this reply.");
    if (this.#active?.item?.replay?.threadId === request.threadId && this.#active.item.replay.turnId === request.turnId) return this.#snapshot();
    const item: ElectronVoiceQueueItem = { id: this.#uuid(), event: "replay", threadId: request.threadId,
      threadTitle: request.threadTitle ?? null, replay: { threadId: request.threadId, turnId: request.turnId,
        threadTitle: request.threadTitle, assistantResult: request.assistantResult } };
    if (!voiceItemText(item, this.#state.settings)) throw new Error("This reply has no text to speak.");
    this.#queue.add(item, this.#state.settings); this.#scheduleDrain();
    return this.#publish();
  }
  #scheduleDrain(): void {
    if (this.#drainScheduled) return;
    this.#drainScheduled = true;
    queueMicrotask(() => { this.#drainScheduled = false; this.#drain(); });
  }
  #drain(): void {
    if (this.#active || !this.#connection?.registration) return;
    if (this.#applyControls()) return;
    if (!this.#sessionReady()) return;
    for (let item = this.#queue.items.shift(); item; item = this.#queue.items.shift()) {
      if (!this.#eligible(item)) { this.#queue.drop("ineligible"); this.#rememberDrained(item.id); continue; }
      const target = item.notification?.recognitionTarget?.threadId ?? item.threadId;
      const active = this.#activate(target, target === item.threadId ? item.threadTitle : null, item);
      this.#trace("dequeued");
      void this.#playItem(active).catch(error => this.#fail(active, error));
      this.#publish(); return;
    }
    this.#state.phase = "idle"; this.#publish();
  }
  async #playItem(active: ActiveInteraction): Promise<void> {
    const item = active.item!;
    const settings = structuredClone(this.#state.settings);
    const text = voiceItemText(item, settings);
    if (item.notification?.userInputRevision !== undefined && item.threadId) {
      this.#state.phase = "synthesizing"; this.#publish();
      const context = await this.#context(item.threadId, active.abort.signal); this.#assertCurrent(active);
      if (context.userInputRevision > item.notification.userInputRevision) {
        this.#discardSourceControls(item.notification.payload.thread!.id, item.notification.payload.turn?.id);
        this.#finish(active); return;
      }
    }
    if (!this.#eligible(item)) { this.#finish(active); return; }
    if (text) this.#retain(item.threadId, item.threadTitle);
    const modelLimit = this.#catalog?.speechModels.find(model => model.id === settings.ttsModel)?.maxTextLength ?? 4096;
    for (const chunk of voiceChunks(text, Math.min(settings.speechTextLimit, modelLimit))) {
      this.#assertCurrent(active);
      const requestId = this.#uuid();
      this.#state.phase = "synthesizing"; this.#publish();
      const playback = await this.#audio.createPlayback({ gain: settings.ttsGain / 100, signal: active.abort.signal });
      this.#assertCurrent(active);
      const output: SpeechPlayback = { active, playback, pending: Promise.resolve(), nextSequence: 0 };
      this.#playbacks.set(requestId, output);
      try {
        await this.#speech.speak({ requestId, provider: settings.speechProvider, endpoint: settings.speechEndpoint, model: settings.ttsModel,
          voice: settings.ttsVoice, speed: settings.ttsSpeed, text: chunk });
        await output.pending; this.#assertCurrent(active);
        await playback.finish(); this.#assertCurrent(active);
        this.#trace("playback_drained");
      } finally { this.#playbacks.delete(requestId); playback.cancel(); }
    }
    this.#assertCurrent(active);
    const listenReserved = [...this.#controls.values()].some(action => action.command.listen && action.command.expiresAt > this.#now());
    const endingSource = [...this.#controls.values()].some(action => action.command.action === "end_interaction" &&
      action.command.sourceThreadId === item.threadId && action.command.sourceTurnId === item.notification?.payload.turn?.id && action.command.expiresAt > this.#now());
    const listens = !listenReserved && !endingSource && (item.replay ? this.#state.settings.autoListen : item.notification && this.#eligible(item) && notificationListens(item.notification, this.#state.settings));
    if (listens && active.target && this.#sessionReady()) await this.#listen(active);
    else this.#finish(active);
  }
  async recordDuringPlayback(input: Parameters<NativeVoicePlugin["recordDuringPlayback"]>[0]): Promise<NativeVoiceState> {
    const old = this.#assertActive(input);
    if (!playbackPhases.has(this.#state.phase) || !this.#sessionReady() || !old.item?.threadId) throw new Error("This playback cannot start a recording.");
    const target = old.item.threadId, title = old.item.threadTitle;
    this.#cancelActive(); this.#clearControls(); this.#state.nextRecordingTarget = null;
    const active = this.#activate(target, title); this.#state.phase = "validating";
    void this.#listen(active).catch(error => this.#fail(active, error));
    return this.#publish();
  }
  async skipCurrentPlayback(input: Parameters<NativeVoicePlugin["skipCurrentPlayback"]>[0]): Promise<NativeVoiceState> {
    const active = this.#assertActive(input);
    if (!active.item || active.finalized) return this.#snapshot();
    this.#cancelActive(); this.#scheduleDrain();
    return this.#publish();
  }
  async stopPlayback(input: Parameters<NativeVoicePlugin["stopPlayback"]>[0]): Promise<NativeVoiceState> {
    this.#assertActive(input);
    this.#cancelActive(); this.#clearControls(); this.#queue.items.length = 0;
    this.#state.retainedVoiceTarget = null; this.#state.idleTargetRevision++; this.#rememberIdleTarget();
    return this.#publish();
  }
  async stopCurrentInteraction(input: Parameters<NativeVoicePlugin["stopCurrentInteraction"]>[0]): Promise<NativeVoiceState> {
    this.#assertActive(input); this.#cancelActive(); this.#scheduleDrain(); return this.#publish();
  }
  #rememberDrained(id: string): void {
    this.#drained.add(id); if (this.#drained.size > 4096) this.#drained.delete(this.#drained.values().next().value!);
  }
  #finish(active: ActiveInteraction): void {
    if (!this.#current(active)) return;
    this.#trace("interaction_finished"); this.#cancelActive(); this.#scheduleDrain(); this.#publish();
  }
  #fail(active: ActiveInteraction, error: unknown): void {
    if (!this.#current(active)) return;
    if (!active.directInputPending) this.#error(error instanceof Error && "code" in error && error.code === "input_submission_uncertain"
      ? "input_submission_uncertain" : "voice_interaction_failed", error);
    this.#finish(active);
  }
  #cancelActive(): boolean {
    const active = this.#active;
    if (!active) return false;
    const uncertainInput = !!active.directInputPending;
    if (active.directInputPending) {
      active.directInputPending = false;
      this.#error("input_submission_uncertain", new Error(uncertainInputMessage));
    }
    this.#active = undefined; active.abort.abort(); clearTimeout(active.limitTimer); active.recording?.cancel();
    if (active.item) this.#rememberDrained(active.item.id);
    for (const [requestId, output] of this.#playbacks) if (output.active === active) {
      output.playback.cancel(); this.#playbacks.delete(requestId);
      void this.#speech.cancel({ requestId }).catch(() => undefined);
    }
    for (const [id, offer] of this.#offers) if (offer.active === active) { clearTimeout(offer.timer); this.#offers.delete(id); }
    this.#captureStopped = this.#audio.stopCapture().catch(() => undefined);
    void this.#speech.setAudioActive({ active: false }).catch(() => undefined);
    this.#state.phase = this.#state.settings.audioMode === "off" ? "off" : "idle";
    return uncertainInput;
  }

  #clientState(): ClientState {
    const state = this.#snapshot();
    return { runtime: { foreground: state.foreground.visible, voiceReady: this.#sessionReady(), interactionActive: !!this.#active },
      settings: { revision: state.settingsRevision, voice: clientVoiceSettingsSchema.parse({ audioMode: state.settings.audioMode,
        voiceThreadId: state.settings.voiceThreadId, pinDefaultVoiceThread: state.settings.pinDefaultVoiceThread,
        autoListen: state.settings.autoListen, onlyVoiceThread: state.settings.onlyVoiceThread,
        ignoreOtherDevices: state.settings.ignoreOtherDevices, followComposerMode: state.settings.followComposerMode }) } };
  }
  async #executeControl(command: ClientCommand): Promise<ClientActionResult> {
    const generation = this.#state.connectionGeneration;
    const result = (status: ClientActionResult["status"], reason?: string): ClientActionResult => ({ status, ...(reason ? { reason } : {}), state: this.#clientState() });
    if (command.expiresAt <= this.#now()) return result("noop", "expired");
    try {
      switch (command.action) {
        case "settings.get": return result("applied");
        case "settings.update": {
          if (!command.patch || command.expectedRevision === undefined) return result("failed", "invalid_settings_update");
          const patch: Partial<NativeVoiceSettings> = { ...command.patch };
          if (patch.voiceThreadId) patch.voiceThreadTitle = nativeThreadTitle((await this.#context(patch.voiceThreadId)).threadTitle);
          else if (patch.voiceThreadId === null) patch.voiceThreadTitle = null;
          await this.updateSettings({ expectedConnectionGeneration: generation, expectedRevision: command.expectedRevision, patch });
          return result("applied");
        }
        case "replay_turn":
          if (!command.threadId || !command.turnId || !command.assistantResult) return result("failed", "invalid_replay");
          await this.speakReply({ expectedConnectionGeneration: this.#state.connectionGeneration, threadId: command.threadId,
            turnId: command.turnId, threadTitle: command.threadTitle, assistantResult: command.assistantResult });
          return result("accepted");
        case "end_interaction":
        case "switch_thread": {
          if (command.action === "switch_thread" && !command.threadId) return result("failed", "invalid_thread");
          const foreground = this.#snapshot().foreground.visible;
          if (command.action === "switch_thread" && !foreground && !command.listen) return result("noop", "client_in_background");
          this.#discardSourceControls(command.sourceThreadId, command.sourceTurnId);
          if (this.#controls.size >= 32) return result("failed", "client_busy");
          const timer = setTimeout(() => { this.#controls.delete(command.id); this.#scheduleDrain(); }, Math.max(0, command.expiresAt - this.#now()));
          this.#controls.set(command.id, { command, navigationRevision: this.#navigationRevision, voiceOnly: !foreground, timer });
          return result("accepted", "after_turn_completion");
        }
        case "turn_cancelled": {
          const pending = this.#controls.get(command.id);
          if (!pending || pending.command.sourceThreadId !== command.sourceThreadId || pending.command.sourceTurnId !== command.sourceTurnId) return result("noop", "superseded");
          clearTimeout(pending.timer); this.#controls.delete(command.id); this.#scheduleDrain(); return result("applied");
        }
        case "turn_settled": {
          const pending = this.#controls.get(command.id);
          if (!pending || pending.command.sourceThreadId !== command.sourceThreadId || pending.command.sourceTurnId !== command.sourceTurnId) return result("noop", "superseded");
          pending.settled = command;
          pending.command = { ...pending.command, expiresAt: command.expiresAt };
          clearTimeout(pending.timer);
          pending.timer = setTimeout(() => { this.#controls.delete(command.id); this.#scheduleDrain(); }, Math.max(0, command.expiresAt - this.#now()));
          this.#scheduleDrain(); return result("accepted", "after_reply_playback");
        }
      }
    } catch { return result("failed", "voice_action_unavailable"); }
  }
  #discardSourceControls(threadId: string, turnId?: string): void {
    for (const [id, action] of this.#controls) if (action.command.sourceThreadId === threadId && (!turnId || action.command.sourceTurnId === turnId)) {
      clearTimeout(action.timer); this.#controls.delete(id);
    }
  }
  #clearControls(): void { for (const action of this.#controls.values()) clearTimeout(action.timer); this.#controls.clear(); }
  #applyControls(): boolean {
    for (const [id, action] of this.#controls) {
      if (!action.settled) continue;
      const reply = action.settled.replyEventId;
      if (reply && !this.#drained.has(reply) && (this.#queue.items.some(item => item.id === reply) ||
          this.#connection?.voiceStreamId && action.settled.replyStreamIds?.includes(this.#connection.voiceStreamId))) continue;
      clearTimeout(action.timer); this.#controls.delete(id);
      if (action.command.expiresAt <= this.#now()) continue;
      if (action.command.action === "end_interaction") continue;
      const navigate = !action.voiceOnly && action.navigationRevision === this.#navigationRevision && this.#snapshot().foreground.visible;
      if (navigate && this.#binding) this.#emit("openThread", { ...this.#binding, connectionGeneration: this.#state.connectionGeneration, threadId: action.command.threadId! });
      if (action.command.listen && this.#sessionReady()) {
        const active = this.#activate(action.command.threadId!, action.command.threadTitle ?? null);
        active.clientTarget = action.command.threadId!;
        this.#state.phase = "validating";
        void this.#listen(active).catch(error => this.#fail(active, error)); this.#publish(); return true;
      }
    }
    return false;
  }

  #unsupported(): never { throw new Error("Saved recording recovery is not supported by desktop voice. Recordings exist only during the current interaction."); }
  async retryRecordingRecognition(_input: Parameters<NativeVoicePlugin["retryRecordingRecognition"]>[0]): Promise<NativeVoiceState> { return this.#unsupported(); }
  async sendRecoveredRecording(_input: Parameters<NativeVoicePlugin["sendRecoveredRecording"]>[0]): Promise<NativeVoiceState> { return this.#unsupported(); }
  async readRecognizedRecordingText(_input: Parameters<NativeVoicePlugin["readRecognizedRecordingText"]>[0]): Promise<never> { return this.#unsupported(); }
  async copyRecognizedRecordingText(_input: Parameters<NativeVoicePlugin["copyRecognizedRecordingText"]>[0]): Promise<NativeVoiceState> { return this.#unsupported(); }
  async discardRecording(_input: Parameters<NativeVoicePlugin["discardRecording"]>[0]): Promise<NativeVoiceState> { return this.#unsupported(); }
  async resumeInput(_input: Parameters<NativeVoicePlugin["resumeInput"]>[0]): Promise<NativeVoiceState> { return this.#unsupported(); }
  async discardInput(_input: Parameters<NativeVoicePlugin["discardInput"]>[0]): Promise<NativeVoiceState> { return this.#unsupported(); }
}

export function createElectronVoice(): NativeVoicePlugin { return new ElectronVoiceRuntime(); }
