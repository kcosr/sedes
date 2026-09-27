import { OpenCodeRuntimeError } from "./opencode-release.js";
import { OPENCODE_NATIVE_EVENT_BUFFER_BYTES, OPENCODE_NATIVE_EVENT_BUFFER_RECORDS } from "./opencode-native-codecs.js";
import type { OpenCodeNativePort, OpenCodeMutationControl, OpenCodePortObservation, OpenCodeObservationRecord, OpenCodeObservationBoundary, OpenCodeObservationEnd } from "./opencode-native-port.js";
import type { OpenCodeNativeSession, OpenCodeNativeSessionListOptions, OpenCodeNativeSessionPage,
  OpenCodeNativeMessage, OpenCodeNativeHistoryReadOptions, OpenCodeNativeHistoryPage, OpenCodeNativeInboxItem,
  OpenCodeNativeInteractions, OpenCodeNativeActivity, OpenCodeNativeEvent } from "./opencode-native-codecs.js";
export { OpenCodeNativeReadLimitError, OpenCodeNativeProtocolError, openCodeNativeParser, parseOpenCodeNativeMessage,
  parseOpenCodeNativeEvent, OPENCODE_NATIVE_EVENT_BUFFER_BYTES, OPENCODE_NATIVE_EVENT_BUFFER_RECORDS } from "./opencode-native-codecs.js";
export type { OpenCodeNativeSession, OpenCodeNativeSessionListOptions, OpenCodeNativeSessionPage, OpenCodeNativeMessage,
  OpenCodeNativeHistoryReadOptions, OpenCodeNativeHistoryPage, OpenCodeNativeInboxItem, OpenCodeNativeInteractions,
  OpenCodeNativeActivity, OpenCodeNativeEvent, OpenCodeNativeShell } from "./opencode-native-codecs.js";

/** Shared conversation-facing facade; native HTTP remains exclusively on its execution host. */
export class OpenCodeNativeApi {
  constructor(readonly client: OpenCodeNativePort) {}
  getSession(sessionID: string, signal?: AbortSignal): Promise<OpenCodeNativeSession> {
    return this.client.read("getSession", { sessionID }, { signal });
  }
  listSessions(input: OpenCodeNativeSessionListOptions = {}): Promise<OpenCodeNativeSessionPage> {
    const { signal, ...request } = input; return this.client.read("listSessions", request, { signal });
  }
  getMessage(sessionID: string, messageID: string, signal?: AbortSignal): Promise<OpenCodeNativeMessage> {
    return this.client.read("getMessage", { sessionID, messageID }, { signal });
  }
  getHistoryPage(sessionID: string, input: OpenCodeNativeHistoryReadOptions = {}): Promise<OpenCodeNativeHistoryPage> {
    const { signal, ...request } = input; return this.client.read("getHistoryPage", { sessionID, ...request }, { signal });
  }
  getActive(signal?: AbortSignal): Promise<Record<string, { type: "running" }>> {
    return this.client.read("getActive", {}, { signal });
  }
  getPending(sessionID: string, signal?: AbortSignal): Promise<OpenCodeNativeInboxItem[]> {
    return this.client.read("getPending", { sessionID }, { signal });
  }
  getInteractions(sessionID: string, signal?: AbortSignal): Promise<OpenCodeNativeInteractions> {
    return this.client.read("getInteractions", { sessionID }, { signal });
  }
  getActivity(sessionID: string, directory: string, signal?: AbortSignal): Promise<OpenCodeNativeActivity> {
    return this.client.read("getActivity", { sessionID, directory }, { signal });
  }
  interruptSession(sessionID: string, control: OpenCodeMutationControl, signal?: AbortSignal): Promise<{ interrupted: boolean }> {
    return this.client.mutate("interruptSession", { sessionID }, control, { signal });
  }
  observe(input: { readonly signal?: AbortSignal; readonly after?: { readonly continuity: string; readonly sequence: number };
    readonly include?: (event: OpenCodeNativeEvent, record: OpenCodeObservationRecord) => boolean } = {}): OpenCodeNativeObservation {
    return new OpenCodeNativeObservation(this.client, input);
  }
}

export type OpenCodeNativeObservedEvent = OpenCodeObservationRecord;
export type OpenCodeNativeObservationEnd = OpenCodeObservationEnd;

/** Eager presentation filter. Callbacks stay in this process, never in wire requests. */
export class OpenCodeNativeObservation {
  readonly ready: Promise<void>;
  readonly ended: Promise<OpenCodeNativeObservationEnd>;
  readonly #source: OpenCodePortObservation;
  readonly #queue: OpenCodeNativeObservedEvent[] = [];
  readonly #waiters = new Set<() => void>();
  readonly #pump: Promise<void>;
  #boundary?: OpenCodeObservationBoundary;
  #end?: OpenCodeNativeObservationEnd;
  #queuedBytes = 0;
  #endedResolve!: (end: OpenCodeNativeObservationEnd) => void;
  constructor(client: OpenCodeNativePort, input: { readonly signal?: AbortSignal; readonly after?: { readonly continuity: string; readonly sequence: number };
    readonly include?: (event: OpenCodeNativeEvent, record: OpenCodeObservationRecord) => boolean }) {
    this.#source = client.observe({ signal: input.signal, ...(input.after ? { after: input.after } : {}) });
    this.ready = this.#source.ready.then(boundary => { this.#boundary = boundary; });
    void this.ready.catch(() => undefined);
    this.ended = new Promise(resolve => { this.#endedResolve = resolve; });
    void this.#source.ended.then(end => this.#finish(end));
    const source = this.#source;
    const ready = this.ready;
    this.#pump = (async () => {
      try {
        await ready;
        while (!this.#end) {
          await source.wait(input.signal);
          for (const record of source.drain()) {
            if (this.#end) break;
            if (input.include && !input.include(record.event, record)) continue;
            if (this.#queue.length >= OPENCODE_NATIVE_EVENT_BUFFER_RECORDS ||
                this.#queuedBytes + record.decodedBytes > OPENCODE_NATIVE_EVENT_BUFFER_BYTES) {
              this.#finish({ reason: "overflow", error: new OpenCodeRuntimeError("opencode_event_overflow") });
              void source.close(); break;
            }
            this.#queue.push(record); this.#queuedBytes += record.decodedBytes; this.#wake();
          }
        }
      } catch (error) {
        this.#finish(input.signal?.aborted || client.lifetime.aborted
          ? { reason: "aborted", error: new OpenCodeRuntimeError("opencode_event_aborted") }
          : { reason: "failed", error: error instanceof OpenCodeRuntimeError ? error : new OpenCodeRuntimeError("opencode_event_stream_failed") });
        await source.close();
      }
    })();
  }
  get boundary(): OpenCodeObservationBoundary | undefined { return this.#boundary; }
  get failure(): OpenCodeRuntimeError | undefined { return this.#end?.error; }
  drain(): OpenCodeNativeObservedEvent[] {
    if (this.#end) throw this.#end.error ?? new OpenCodeRuntimeError("opencode_event_closed");
    const records = this.#queue.splice(0); this.#queuedBytes = 0; return records;
  }
  async wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new OpenCodeRuntimeError("opencode_event_aborted");
    if (!this.#queue.length && !this.#end) {
      if (this.#waiters.size >= 64) throw new OpenCodeRuntimeError("opencode_event_waiter_limit");
      await new Promise<void>(resolve => {
        const wake = () => { this.#waiters.delete(wake); signal?.removeEventListener("abort", wake); resolve(); };
        this.#waiters.add(wake); signal?.addEventListener("abort", wake, { once: true });
      });
    }
    if (signal?.aborted) throw new OpenCodeRuntimeError("opencode_event_aborted");
    if (this.#end) throw this.#end.error ?? new OpenCodeRuntimeError("opencode_event_closed");
  }
  acknowledge(sequence: number): Promise<void> { return this.#source.acknowledge(sequence); }
  async close(): Promise<void> { await this.#source.close(); await this.#pump; }
  #wake(): void { for (const wake of this.#waiters) wake(); }
  #finish(end: OpenCodeNativeObservationEnd): void {
    if (this.#end) return;
    this.#end = end; this.#queue.length = 0; this.#queuedBytes = 0; this.#wake(); this.#endedResolve(end);
  }
}
