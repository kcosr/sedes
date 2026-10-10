import type { PluginListenerHandle } from "@capacitor/core";
import { nativeRecordingTextSchema, nativeVoiceInputSubmittedSchema, nativeVoiceStateSchema, type NativeRecordingRecoveryCommandContext, type NativeReplySpeech, type NativeVoiceCommandContext, type NativeVoiceInputSubmitted, type NativeVoiceInteractionCommandContext, type NativeVoicePlugin, type NativeVoiceSettings, type NativeVoiceState } from "./native-voice-plugin.js";

type NativeVoiceError = NativeVoiceState["errors"][number];
export interface VoiceClientState {
  readonly native?: NativeVoiceState;
  readonly loading: boolean;
  readonly pending: boolean;
  /** The latest action, connection, or runtime failure. It stays until the next user action, a reconnect, or progress. */
  readonly error?: string;
  /** Copying into a composer leaves the native recovery item intact. */
  readonly addedRecording?: NativeRecordingRecoveryCommandContext;
  /** Native errors the user cleared on this device; native keeps its own bounded list. */
  readonly dismissedErrors?: { readonly connectionGeneration: number; readonly errors: readonly NativeVoiceError[] };
}
export type VoiceSettingsPatch = Partial<NativeVoiceSettings> | ((current: NativeVoiceState) => Partial<NativeVoiceSettings> | null);
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
/** Entering one of these phases means a new interaction is under way, so an earlier failure no longer describes the bar. */
const PROGRESS_PHASES = new Set<NativeVoiceState["phase"]>(["starting", "synthesizing", "speaking", "validating", "arming", "listening", "recognizing", "submitting"]);

/** Native snapshots are authoritative, including changes made while the WebView was suspended. */
export class NativeVoiceStore {
  #state: VoiceClientState = { loading: true, pending: false };
  #listeners = new Set<() => void>();
  #inputSubmittedListeners = new Set<(event: NativeVoiceInputSubmitted) => void>();
  #seenSubmissions = new Set<string>();
  #handles: PluginListenerHandle[] = [];
  #disposed = false;
  #listening = false;
  #connected = false;
  #connecting: Promise<NativeVoiceState> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryAttempt = 0;
  #pendingOpenThread: string | undefined;
  #generation = -1;
  #revision = -1;
  #pendingActions = 0;
  #actionSequence = 0;
  #stopping = new Map<string, Promise<void>>();
  #composers = new Map<string, (text: string) => void>();
  #composerListeners = new Set<() => void>();
  constructor(readonly plugin: NativeVoicePlugin, readonly connection: { profileId: string; serverOrigin: string; identity: string }, readonly openThread: (threadId: string) => void) {}
  getSnapshot = (): VoiceClientState => this.#state;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  /** Live UI intent only: new subscribers do not receive earlier submissions. */
  subscribeInputSubmitted = (listener: (event: NativeVoiceInputSubmitted) => void): (() => void) => {
    this.#inputSubmittedListeners.add(listener);
    return () => { this.#inputSubmittedListeners.delete(listener); };
  };
  get disposed(): boolean { return this.#disposed; }
  commandContext(): NativeVoiceCommandContext {
    const current = this.#state.native;
    if (this.#disposed || !current) throw new Error("This voice connection is no longer active.");
    return { expectedConnectionGeneration: current.connectionGeneration };
  }

  /** Active views register their composer, or an error when no composer is available. Composers own drafts and autosave. */
  registerComposer(threadId: string, append: (text: string) => void): () => void {
    this.#composers.set(threadId, append);
    for (const listener of this.#composerListeners) listener();
    return () => { if (this.#composers.get(threadId) === append) this.#composers.delete(threadId); };
  }
  async addRecordingToComposer(context: NativeRecordingRecoveryCommandContext): Promise<void> {
    await this.run(async () => {
      const current = () => {
        const native = this.#state.native, saved = native?.recordingRecovery;
        if (this.#disposed || native?.connectionGeneration !== context.expectedConnectionGeneration ||
            saved?.recordingId !== context.recordingId || saved.revision !== context.expectedRecoveryRevision)
          throw new Error("Saved dictation changed. Open it again.");
        return native;
      };
      current();
      const result = nativeRecordingTextSchema.parse(await this.plugin.readRecognizedRecordingText(context));
      const native = current();
      if (result.recordingId !== context.recordingId || result.revision !== context.expectedRecoveryRevision ||
          result.threadId !== native.recordingRecovery?.threadId) throw new Error("Saved dictation changed. Open it again.");
      const added = this.#state.addedRecording;
      if (added?.recordingId === context.recordingId && added.expectedRecoveryRevision === context.expectedRecoveryRevision &&
          added.expectedConnectionGeneration === context.expectedConnectionGeneration) return native;
      this.openThread(result.threadId);
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); unsubscribe(); this.#composerListeners.delete(check); };
        const check = () => {
          try {
            current();
            if (!this.#composers.has(result.threadId)) return;
            cleanup(); resolve();
          } catch (error) { cleanup(); reject(error); }
        };
        const unsubscribe = this.subscribe(check);
        const timer = setTimeout(() => { cleanup(); reject(new Error("The composer is unavailable. You can still copy the text.")); }, 10_000);
        this.#composerListeners.add(check);
        check();
      });
      current();
      const append = this.#composers.get(result.threadId);
      if (!append) throw new Error("The composer is unavailable. You can still copy the text.");
      // Synchronous insertion reads the composer's current draft. No delayed callback can add to another connection.
      append(result.text);
      this.#set({ ...this.#state, addedRecording: context });
      return current();
    });
  }

  async initialize(): Promise<void> {
    try {
      const accept = (state: NativeVoiceState) => { try { this.#accept(state); } catch (error) { this.#error(error); } };
      const results = await Promise.allSettled([
        this.plugin.addListener("stateChanged", accept),
        this.plugin.addListener("settingsChanged", accept),
        this.plugin.addListener("runtimeError", error => {
          if (error.connectionGeneration < this.#generation || error.profileId !== this.connection.profileId ||
            error.serverOrigin !== this.connection.serverOrigin || (error.identity !== null && error.identity !== this.connection.identity)) return;
          this.#error(new Error(error.message));
        }),
        this.plugin.addListener("openThread", event => {
          if (this.#disposed || event.profileId !== this.connection.profileId || event.serverOrigin !== this.connection.serverOrigin ||
            event.identity !== this.connection.identity || event.connectionGeneration < this.#generation) return;
          if (this.#connected) this.openThread(event.threadId);
          else this.#pendingOpenThread = event.threadId;
        }),
        this.plugin.addListener("inputSubmitted", raw => {
          const parsed = nativeVoiceInputSubmittedSchema.safeParse(raw);
          if (!parsed.success || this.#disposed || !this.#connected || !this.#state.native ||
              (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
          const event = parsed.data;
          if (event.profileId !== this.connection.profileId || event.serverOrigin !== this.connection.serverOrigin ||
              event.identity !== this.connection.identity || event.connectionGeneration !== this.#generation ||
              this.#seenSubmissions.has(event.operationId)) return;
          this.#seenSubmissions.add(event.operationId);
          if (this.#seenSubmissions.size > 128) this.#seenSubmissions.delete(this.#seenSubmissions.values().next().value!);
          for (const listener of this.#inputSubmittedListeners) listener(event);
        }),
      ]);
      const handles = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") {
        for (const handle of handles) void handle.remove();
        throw failed.reason;
      }
      if (this.#disposed) { for (const handle of handles) void handle.remove(); return; }
      this.#handles = handles;
      this.#listening = true;
      await this.#attemptConnect();
    } catch (error) { this.#error(error); }
    finally { this.#set({ ...this.#state, loading: false }); }
  }
  async reconnect(): Promise<void> {
    await this.run(() => this.#attemptConnect(true));
  }
  /** The app became visible, came back online, or resumed: reconnect a missing connection now, otherwise rehydrate. */
  foreground(): void {
    if (this.#disposed || !this.#listening) return;
    if (this.#state.native) void this.refresh().catch(() => undefined);
    else void this.#attemptConnect().catch(error => this.#error(error));
  }
  /** One connection attempt at a time; a failure retries with capped exponential backoff until native state is restored. */
  #attemptConnect(reconnect = false): Promise<NativeVoiceState> {
    this.#clearRetry();
    if (!this.#connecting) {
      const attempt: Promise<NativeVoiceState> = this.#connect(reconnect)
        .then(state => { this.#retryAttempt = 0; return state; }, (error: unknown) => { this.#scheduleRetry(); throw error; })
        .finally(() => { if (this.#connecting === attempt) this.#connecting = undefined; });
      this.#connecting = attempt;
    }
    return this.#connecting;
  }
  #scheduleRetry(): void {
    if (this.#disposed || this.#retryTimer !== undefined) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.#retryAttempt);
    this.#retryAttempt = Math.min(this.#retryAttempt + 1, 8);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      // A hidden or offline app waits for the foreground and online signals instead of polling.
      if (this.#disposed || this.#state.native || (typeof document !== "undefined" && document.visibilityState === "hidden") ||
        (typeof navigator !== "undefined" && navigator.onLine === false)) return;
      void this.#attemptConnect().catch(error => this.#error(error));
    }, delay);
  }
  #clearRetry(): void {
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }
  async #connect(reconnect: boolean): Promise<NativeVoiceState> {
    const state = nativeVoiceStateSchema.parse(await this.plugin.setConnection({ ...this.connection, ...(reconnect ? { reconnect: true } : {}) }));
    if (this.#disposed || state.profileId !== this.connection.profileId || state.serverOrigin !== this.connection.serverOrigin || state.identity !== this.connection.identity)
      throw new Error("This voice connection is no longer active.");
    this.#accept(state);
    if (!this.#state.native) throw new Error("This voice connection is no longer active.");
    this.#connected = true;
    const threadId = this.#pendingOpenThread;
    this.#pendingOpenThread = undefined;
    if (threadId) this.openThread(threadId);
    return state;
  }
  async refresh(): Promise<void> {
    if (this.#disposed) throw new Error("This voice connection is no longer active.");
    const snapshot = await this.plugin.getState();
    this.#accept(snapshot);
    if (this.#disposed || snapshot.profileId !== this.connection.profileId || snapshot.serverOrigin !== this.connection.serverOrigin || snapshot.identity !== this.connection.identity)
      throw new Error("This voice connection is no longer active.");
  }
  /** Check native catalog freshness in the background without clearing a user-action error or locking controls. */
  async checkSpeechCatalog(): Promise<void> {
    this.#accept(await this.plugin.refreshSpeechCatalog({ ...this.commandContext(), force: false }));
  }
  /** A function patch is built from the refreshed native state, so it never writes back a stale rendered value; `null` skips the write. */
  async update(patch: VoiceSettingsPatch): Promise<void> {
    await this.run(async () => {
      await this.refresh();
      const state = this.#state.native;
      if (!state) throw new Error("Voice settings are unavailable. Reconnect to this server.");
      const next = typeof patch === "function" ? patch(state) : patch;
      return next ? this.plugin.updateSettings({ ...this.commandContext(), expectedRevision: state.settingsRevision, patch: next }) : state;
    });
  }
  async run(action: () => Promise<NativeVoiceState>): Promise<void> {
    return this.#perform(action, false);
  }
  /** Queues one ended turn's reply with current Auto-listen applying afterward; native rejects when voice is not ready, the text is empty, or the queue is full. */
  speakReply(reply: NativeReplySpeech): Promise<void> {
    return this.run(() => this.plugin.speakReply({ ...this.commandContext(), ...reply }));
  }
  /** Cancel may stop capture while a durable Keep listening write is pending. Native fences both commands by identity. */
  stopInteraction(context: NativeVoiceInteractionCommandContext): Promise<void> {
    const key = JSON.stringify([context.expectedConnectionGeneration, context.interactionId]);
    const pending = this.#stopping.get(key);
    if (pending) return pending;
    const stopping = this.#perform(() => this.plugin.stopCurrentInteraction(context), true)
      .finally(() => { if (this.#stopping.get(key) === stopping) this.#stopping.delete(key); });
    this.#stopping.set(key, stopping);
    return stopping;
  }
  async #perform(action: () => Promise<NativeVoiceState>, interrupt: boolean): Promise<void> {
    if (this.#disposed) throw new Error("This voice connection is no longer active.");
    if (this.#state.pending && !interrupt) throw new Error("A voice action is already in progress.");
    const sequence = ++this.#actionSequence;
    this.#pendingActions++;
    this.#set({ ...this.#state, pending: true, error: undefined });
    try { this.#accept(await action()); }
    catch (error) { if (sequence === this.#actionSequence) this.#error(error); throw error; }
    finally { this.#pendingActions--; this.#set({ ...this.#state, pending: this.#pendingActions > 0 }); }
  }
  /** Hides the current native errors on this device until native reports a newer one. Native state is unchanged. */
  dismissErrors(): void {
    const native = this.#state.native;
    this.#set({ ...this.#state, error: undefined, dismissedErrors: native ? { connectionGeneration: native.connectionGeneration, errors: native.errors } : undefined });
  }
  dispose(): void {
    this.#disposed = true;
    for (const listener of this.#composerListeners) listener();
    this.#composers.clear();
    this.#clearRetry();
    for (const handle of this.#handles) void handle.remove();
    this.#handles = [];
    this.#listeners.clear();
    this.#inputSubmittedListeners.clear();
    this.#seenSubmissions.clear();
    // Native owns the session beyond this WebView's lifetime.
  }
  #accept(raw: NativeVoiceState): void {
    if (this.#disposed) return;
    const state = nativeVoiceStateSchema.parse(raw);
    if (state.connectionGeneration < this.#generation ||
      (state.connectionGeneration === this.#generation && state.stateRevision < this.#revision)) return;
    if (state.connectionGeneration !== this.#generation) this.#seenSubmissions.clear();
    this.#generation = state.connectionGeneration;
    this.#revision = state.stateRevision;
    if (state.profileId !== this.connection.profileId || state.serverOrigin !== this.connection.serverOrigin || state.identity !== this.connection.identity) {
      this.#connected = false;
      this.#set({ loading: this.#state.loading, pending: this.#state.pending, error: "Voice is disconnected. Retry the connection to use voice." });
      if (!this.#connecting) this.#scheduleRetry();
      return;
    }
    const previous = this.#state.native;
    const progressed = !previous || previous.connectionGeneration !== state.connectionGeneration || (!previous.ready && state.ready) ||
      (previous.phase !== state.phase && PROGRESS_PHASES.has(state.phase));
    this.#set({ ...this.#state, native: state, error: progressed ? undefined : this.#state.error });
  }
  #error(error: unknown): void {
    this.#set({ ...this.#state, error: error instanceof Error ? error.message : "Voice is unavailable." });
  }
  #set(state: VoiceClientState): void {
    if (this.#disposed) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

/** Most recent distinct messages first: the store's latest failure, then native errors not cleared on this device. */
export function recentVoiceErrors(state: VoiceClientState, limit = 3): string[] {
  const native = state.native;
  const dismissed = native && state.dismissedErrors?.connectionGeneration === native.connectionGeneration ? state.dismissedErrors.errors : [];
  const fresh = native ? errorsAfter(native.errors, dismissed).map(error => error.message).reverse() : [];
  return [...new Set([...(state.error ? [state.error] : []), ...fresh])].slice(0, limit);
}
/** Native appends to a bounded list without identities; the cleared list's longest suffix that still prefixes the current list was already seen. */
function errorsAfter(current: readonly NativeVoiceError[], dismissed: readonly NativeVoiceError[]): readonly NativeVoiceError[] {
  for (let overlap = Math.min(current.length, dismissed.length); overlap > 0; overlap--) {
    const offset = dismissed.length - overlap;
    if (current.slice(0, overlap).every((error, index) => error.code === dismissed[offset + index]!.code && error.message === dismissed[offset + index]!.message))
      return current.slice(overlap);
  }
  return current;
}
