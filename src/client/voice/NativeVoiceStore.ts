import type { PluginListenerHandle } from "@capacitor/core";
import { nativeVoiceStateSchema, type NativeVoiceCommandContext, type NativeVoicePlugin, type NativeVoiceSettings, type NativeVoiceState } from "./native-voice-plugin.js";

export interface VoiceClientState {
  readonly native?: NativeVoiceState;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly error?: string;
}
/** Native snapshots are authoritative, including changes made while the WebView was suspended. */
export class NativeVoiceStore {
  #state: VoiceClientState = { loading: true, pending: false };
  #listeners = new Set<() => void>();
  #handles: PluginListenerHandle[] = [];
  #disposed = false;
  #connected = false;
  #pendingOpenThread: string | undefined;
  #generation = -1;
  #revision = -1;
  constructor(readonly plugin: NativeVoicePlugin, readonly connection: { profileId: string; serverOrigin: string; identity: string }, readonly openThread: (threadId: string) => void) {}
  getSnapshot = (): VoiceClientState => this.#state;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  commandContext(): NativeVoiceCommandContext {
    const current = this.#state.native;
    if (this.#disposed || !current) throw new Error("This voice connection is no longer active.");
    return { expectedConnectionGeneration: current.connectionGeneration };
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
      ]);
      const handles = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") {
        for (const handle of handles) void handle.remove();
        throw failed.reason;
      }
      if (this.#disposed) { for (const handle of handles) void handle.remove(); return; }
      this.#handles = handles;
      await this.#connect();
    } catch (error) { this.#error(error); }
    finally { this.#set({ ...this.#state, loading: false }); }
  }
  async reconnect(): Promise<void> {
    await this.run(() => this.#connect());
  }
  async #connect(): Promise<NativeVoiceState> {
    const state = nativeVoiceStateSchema.parse(await this.plugin.setConnection(this.connection));
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
  async update(patch: Partial<NativeVoiceSettings>): Promise<void> {
    await this.run(async () => {
      await this.refresh();
      const state = this.#state.native;
      if (!state) throw new Error("Voice settings are unavailable. Reconnect to this server.");
      return this.plugin.updateSettings({ ...this.commandContext(), expectedRevision: state.settingsRevision, patch });
    });
  }
  async run(action: () => Promise<NativeVoiceState>): Promise<void> {
    if (this.#disposed) throw new Error("This voice connection is no longer active.");
    if (this.#state.pending) throw new Error("A voice action is already in progress.");
    this.#set({ ...this.#state, pending: true, error: undefined });
    try { this.#accept(await action()); }
    catch (error) { this.#error(error); throw error; }
    finally { this.#set({ ...this.#state, pending: false }); }
  }
  dispose(): void {
    this.#disposed = true;
    for (const handle of this.#handles) void handle.remove();
    this.#handles = [];
    this.#listeners.clear();
    // Native owns the session beyond this WebView's lifetime.
  }
  #accept(raw: NativeVoiceState): void {
    if (this.#disposed) return;
    const state = nativeVoiceStateSchema.parse(raw);
    if (state.connectionGeneration < this.#generation ||
      (state.connectionGeneration === this.#generation && state.stateRevision < this.#revision)) return;
    this.#generation = state.connectionGeneration;
    this.#revision = state.stateRevision;
    if (state.profileId !== this.connection.profileId || state.serverOrigin !== this.connection.serverOrigin || state.identity !== this.connection.identity) {
      this.#connected = false;
      this.#set({ loading: this.#state.loading, pending: this.#state.pending, error: "Voice is disconnected. Retry the connection to use voice." });
      return;
    }
    this.#set({ ...this.#state, native: state, error: undefined });
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
