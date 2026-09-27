import type { FormInfo, OpenCodeEvent, PermissionRequest, SessionInfo, SessionInboxInfo, SessionMessageInfo, SessionMessagesResponse, SessionsResponse, ShellInfo1 } from "@opencode/client";
import { OpenCodeEvent as EventSchema } from "@opencode/protocol/groups/event";
import { PublicSessionMessage } from "@opencode/protocol/groups/message";
import { Form } from "@opencode/schema/form";
import { Location } from "@opencode/schema/location";
import { Permission } from "@opencode/schema/permission";
import { Session } from "@opencode/schema/session";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { Shell } from "@opencode/schema/shell";
import { Schema } from "effect";
import path from "node:path";
import { snapshotBoundedJson } from "../../provider-protocol/json/bounded-json-snapshot.js";
import { OpenCodeHttpClient } from "./opencode-http-client.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";

// These encoded native DTOs never cross the provider-private boundary.
export type OpenCodeNativeMessage = SessionMessageInfo;
export type OpenCodeNativeSession = SessionInfo;
export type OpenCodeNativeEvent = OpenCodeEvent;
export type OpenCodeNativeInboxItem = SessionInboxInfo;
export type OpenCodeNativeShell = ShellInfo1;
export interface OpenCodeNativeHistoryReadOptions {
  readonly cursor?: string;
  readonly order?: "asc" | "desc";
  readonly limit?: number;
  readonly signal?: AbortSignal;
}
export interface OpenCodeNativeHistoryPage {
  readonly data: OpenCodeNativeMessage[];
  readonly cursor: { readonly previous?: string; readonly next?: string };
  readonly decodedBytes: number;
}
export interface OpenCodeNativeSessionListOptions extends OpenCodeNativeHistoryReadOptions {
  readonly directory?: string;
  readonly parentID?: string | null;
  readonly search?: string;
}
export interface OpenCodeNativeSessionPage {
  readonly data: OpenCodeNativeSession[];
  readonly cursor: { readonly previous?: string; readonly next?: string };
  readonly decodedBytes: number;
}
export interface OpenCodeNativeInteractions {
  readonly permissions: PermissionRequest[];
  readonly forms: FormInfo[];
}
export interface OpenCodeNativeActivity {
  readonly active: boolean;
  readonly children: OpenCodeNativeSession[];
  readonly activeChildren: string[];
  readonly shells: OpenCodeNativeShell[];
  readonly observedAt: number;
}
export class OpenCodeNativeReadLimitError extends OpenCodeRuntimeError {
  readonly retryable = false;
  constructor(readonly limit: "response_bytes" | "inventory_records") { super("opencode_native_read_limit"); }
}
export class OpenCodeNativeProtocolError extends OpenCodeRuntimeError {
  readonly retryable = false;
  constructor() { super("opencode_native_protocol_invalid"); }
}
export const OPENCODE_NATIVE_EVENT_BUFFER_RECORDS = 4_096;
export const OPENCODE_NATIVE_EVENT_BUFFER_BYTES = 16 * 1_024 * 1_024;
const MAX_INVENTORY_RECORDS = 10_000;
const NativeSession = Schema.Struct({ ...Session.Info.fields, location: Location.PublicRef });
const NativeInboxMove = Schema.Struct({ ...SessionInbox.Move.fields,
  payload: Schema.Struct({ ...SessionInbox.MovePayload.fields, location: Location.PublicRef }) });
const NativeInbox = Schema.Union([SessionInbox.User, SessionInbox.Synthetic, SessionInbox.Compaction, NativeInboxMove]);
const Cursor = Schema.Struct({ previous: Schema.optional(Schema.String), next: Schema.optional(Schema.String) });
const MessagePage = Schema.Struct({ data: Schema.Array(PublicSessionMessage), cursor: Cursor });
const SessionPage = Schema.Struct({ data: Schema.Array(NativeSession), cursor: Cursor });
const Active = Schema.Record(Session.ID, Schema.Struct({ type: Schema.Literal("running") }));
const ShellList = Schema.Struct({ location: Location.PublicRef, data: Schema.Array(Shell.Info) });
const Interrupt = Schema.Struct({ interrupted: Schema.Boolean });

export function openCodeNativeParser<T>(schema: Schema.Constraint, json = true): (value: unknown) => T {
  // Native HTTP endpoints use Effect's JSON codec, which emits null for some
  // optional values (notably page cursors). SSE directly JSON.stringifies events.
  const decode = Schema.decodeUnknownSync(Schema.toEncoded(json ? Schema.toCodecJson(schema) : schema), { onExcessProperty: "error" });
  return value => {
    const limits = { maximumDepth: 64, maximumObjectProperties: 100_000, maximumArrayItems: 1_000_000,
      maximumTotalNodes: 1_000_000, maximumStringBytes: 16 * 1_024 * 1_024, maximumEncodedBytes: 16 * 1_024 * 1_024 };
    try { return snapshotBoundedJson(decode(snapshotBoundedJson(value, limits)), limits) as T; }
    catch { throw new OpenCodeNativeProtocolError(); }
  };
}
const parser = openCodeNativeParser;
export const parseOpenCodeNativeMessage = parser<OpenCodeNativeMessage>(PublicSessionMessage);
export const parseOpenCodeNativeEvent = parser<OpenCodeNativeEvent>(EventSchema, false);
const parseSession = parser<OpenCodeNativeSession>(NativeSession);
const parseMessagePage = parser<SessionMessagesResponse>(MessagePage);
const parseSessionPage = parser<SessionsResponse>(SessionPage);
const parseActive = parser<Record<string, { type: "running" }>>(Active);
const parseInbox = parser<OpenCodeNativeInboxItem[]>(Schema.Array(NativeInbox));
const parsePermissions = parser<PermissionRequest[]>(Schema.Array(Permission.Request));
const parseForms = parser<FormInfo[]>(Schema.Array(Form.Info));
const parseShells = parser<{ location: { directory?: string }; data: OpenCodeNativeShell[] }>(ShellList);
const parseInterrupt = parser<{ interrupted: boolean }>(Interrupt);

function decodedBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value)); }
  catch { throw new OpenCodeNativeProtocolError(); }
}
function id(value: string, prefix: "ses_" | "msg_"): void {
  if (!value.startsWith(prefix) || value.length <= prefix.length || value.length > 256 || /[\x00-\x20/\\]/u.test(value)) {
    throw new OpenCodeRuntimeError("opencode_native_read_input_invalid");
  }
}
function pageOptions(input: OpenCodeNativeHistoryReadOptions): { limit: number; cursor?: string; order?: "asc" | "desc" } {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
      (input.order !== undefined && input.order !== "asc" && input.order !== "desc") ||
      (input.cursor !== undefined && (!input.cursor || input.cursor.length > 16_384 || input.order !== undefined))) {
    throw new OpenCodeRuntimeError("opencode_native_read_input_invalid");
  }
  return { limit, ...(input.cursor !== undefined ? { cursor: input.cursor } : input.order !== undefined ? { order: input.order } : {}) };
}
function boundedInventory<T>(values: T[]): T[] {
  if (values.length > MAX_INVENTORY_RECORDS) throw new OpenCodeNativeReadLimitError("inventory_records");
  return values;
}
function pageCursor(cursor: { readonly previous?: string | null; readonly next?: string | null }): OpenCodeNativeHistoryPage["cursor"] {
  if ([cursor.previous, cursor.next].some(value => value != null && (!value || value.length > 16_384))) throw new OpenCodeNativeProtocolError();
  return { ...(cursor.previous != null ? { previous: cursor.previous } : {}), ...(cursor.next != null ? { next: cursor.next } : {}) };
}
async function nativeRead<T>(effect: () => Promise<T>, sessionID?: string, messageID?: string): Promise<T> {
  try { return await effect(); }
  catch (error) {
    if (error && typeof error === "object" && "_tag" in error) {
      if (error._tag === "InvalidCursorError") throw new OpenCodeRuntimeError("opencode_native_cursor_invalid");
      if ("sessionID" in error && error.sessionID === sessionID &&
          (error._tag === "SessionNotFoundError" || (error._tag === "MessageNotFoundError" && "messageID" in error && error.messageID === messageID))) {
        throw new OpenCodeRuntimeError("opencode_native_not_found");
      }
    }
    throw error;
  }
}

/** Read-only native data and the independent conversation Stop control. */
export class OpenCodeNativeApi {
  constructor(readonly client: OpenCodeHttpClient) {}

  async #read<T>(operation: Parameters<OpenCodeHttpClient["call"]>[0], validate: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    try { return await this.client.call(operation, validate, signal); }
    catch (error) {
      if (error instanceof OpenCodeRuntimeError && error.code === "opencode_response_too_large") throw new OpenCodeNativeReadLimitError("response_bytes");
      throw error;
    }
  }
  async getSession(sessionID: string, signal?: AbortSignal): Promise<OpenCodeNativeSession> {
    id(sessionID, "ses_");
    return this.#read((client, budget) => nativeRead(() => client.session.get({ sessionID }, { signal: budget }), sessionID), value => {
      const result = parseSession(value);
      if (result.id !== sessionID) throw new OpenCodeNativeProtocolError();
      return result;
    }, signal);
  }
  async listSessions(input: OpenCodeNativeSessionListOptions = {}): Promise<OpenCodeNativeSessionPage> {
    const query = pageOptions(input);
    if ((input.directory !== undefined && !path.isAbsolute(input.directory)) ||
        (input.cursor !== undefined && (input.directory !== undefined || input.parentID !== undefined || input.search !== undefined)) ||
        (input.search !== undefined && input.search.length > 4_096)) throw new OpenCodeRuntimeError("opencode_native_read_input_invalid");
    if (input.parentID !== undefined && input.parentID !== null) id(input.parentID, "ses_");
    return this.#read((client, budget) => nativeRead(() => client.session.list({ ...query,
      ...(input.directory !== undefined ? { directory: input.directory } : {}),
      ...(input.parentID !== undefined ? { parentID: input.parentID } : {}),
      ...(input.search !== undefined ? { search: input.search } : {}) }, { signal: budget })), value => {
      const bytes = decodedBytes(value); const page = parseSessionPage(value);
      if (page.data.length > query.limit) throw new OpenCodeNativeProtocolError();
      return { ...page, cursor: pageCursor(page.cursor), decodedBytes: bytes };
    }, input.signal);
  }
  async getMessage(sessionID: string, messageID: string, signal?: AbortSignal): Promise<OpenCodeNativeMessage> {
    id(sessionID, "ses_"); id(messageID, "msg_");
    return this.#read((client, budget) => nativeRead(() => client.session.message.get({ sessionID, messageID }, { signal: budget }), sessionID, messageID), value => {
      const message = parseOpenCodeNativeMessage(value);
      if (message.id !== messageID) throw new OpenCodeNativeProtocolError();
      return message;
    }, signal);
  }
  async getHistoryPage(sessionID: string, input: OpenCodeNativeHistoryReadOptions = {}): Promise<OpenCodeNativeHistoryPage> {
    id(sessionID, "ses_"); const query = pageOptions(input);
    return this.#read((client, budget) => nativeRead(() => client.message.list({ sessionID, ...query }, { signal: budget }), sessionID), value => {
      const bytes = decodedBytes(value); const page = parseMessagePage(value);
      if (page.data.length > query.limit || new Set(page.data.map(message => message.id)).size !== page.data.length) throw new OpenCodeNativeProtocolError();
      return { ...page, cursor: pageCursor(page.cursor), decodedBytes: bytes };
    }, input.signal);
  }
  async getActive(signal?: AbortSignal): Promise<Record<string, { type: "running" }>> {
    return this.#read((client, budget) => client.session.active({ signal: budget }), value => {
      const active = parseActive(value); boundedInventory(Object.keys(active)); return active;
    }, signal);
  }
  async getPending(sessionID: string, signal?: AbortSignal): Promise<OpenCodeNativeInboxItem[]> {
    id(sessionID, "ses_");
    return this.#read((client, budget) => nativeRead(() => client.session.inbox.list({ sessionID }, { signal: budget }), sessionID), value => {
      const pending = boundedInventory(parseInbox(value));
      if (pending.some(item => item.sessionID !== sessionID) || new Set(pending.map(item => item.id)).size !== pending.length) throw new OpenCodeNativeProtocolError();
      return pending;
    }, signal);
  }
  async getInteractions(sessionID: string, signal?: AbortSignal): Promise<OpenCodeNativeInteractions> {
    id(sessionID, "ses_");
    const [permissions, forms] = await Promise.all([
      this.#read((client, budget) => nativeRead(() => client.permission.list({ sessionID }, { signal: budget }), sessionID), value => boundedInventory(parsePermissions(value)), signal),
      this.#read((client, budget) => nativeRead(() => client.session.form.list({ sessionID }, { signal: budget }), sessionID), value => boundedInventory(parseForms(value)), signal),
    ]);
    if ([...permissions, ...forms].some(item => item.sessionID !== sessionID)) throw new OpenCodeNativeProtocolError();
    return { permissions, forms };
  }
  async getActivity(sessionID: string, directory: string, signal?: AbortSignal): Promise<OpenCodeNativeActivity> {
    id(sessionID, "ses_");
    if (!path.isAbsolute(directory)) throw new OpenCodeRuntimeError("opencode_native_read_input_invalid");
    const budget = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    const shells = await this.#read((client, request) => client.shell.list({ location: { directory } }, { signal: request }), value => {
      const response = parseShells(value); boundedInventory(response.data);
      if (response.location.directory !== directory) throw new OpenCodeNativeProtocolError();
      return response.data.filter(shell => shell.metadata.sessionID === sessionID);
    }, budget);
    const children: OpenCodeNativeSession[] = [];
    const seen = new Set<string>(); let cursor: string | undefined;
    do {
      const page = await this.listSessions(cursor === undefined ? { parentID: sessionID, limit: 200, signal: budget } : { cursor, limit: 200, signal: budget });
      for (const child of page.data) {
        if (child.parentID !== sessionID || seen.has(child.id)) throw new OpenCodeNativeProtocolError();
        seen.add(child.id); children.push(child);
      }
      boundedInventory(children);
      if (!page.data.length) break;
      if (!page.cursor.next || page.cursor.next === cursor) throw new OpenCodeNativeProtocolError();
      cursor = page.cursor.next;
    } while (true);
    const active = await this.getActive(budget);
    return { active: active[sessionID] !== undefined, children,
      activeChildren: children.filter(child => active[child.id] !== undefined).map(child => child.id), shells, observedAt: Date.now() };
  }
  async interruptSession(sessionID: string, signal?: AbortSignal): Promise<{ interrupted: boolean }> {
    id(sessionID, "ses_");
    return this.#read((client, budget) => nativeRead(() => client.session.interrupt({ sessionID }, { signal: budget }), sessionID), parseInterrupt, signal);
  }
  observe(input: { readonly signal?: AbortSignal; readonly include?: (event: OpenCodeNativeEvent) => boolean } = {}): OpenCodeNativeObservation {
    return new OpenCodeNativeObservation(this.client, input);
  }
}

export interface OpenCodeNativeObservedEvent { readonly event: OpenCodeNativeEvent; readonly decodedBytes: number; }
export interface OpenCodeNativeObservationEnd {
  readonly reason: "closed" | "aborted" | "disconnected" | "malformed" | "overflow" | "failed";
  readonly error?: OpenCodeRuntimeError;
}

/** One bounded, immediately pumped subscription; EOF invalidates, never reconnects. */
export class OpenCodeNativeObservation {
  readonly ready: Promise<void>;
  readonly ended: Promise<OpenCodeNativeObservationEnd>;
  readonly #controller = new AbortController();
  readonly #waiters = new Set<() => void>();
  readonly #queue: OpenCodeNativeObservedEvent[] = [];
  readonly #pump: Promise<void>;
  #queuedBytes = 0;
  #end: OpenCodeNativeObservationEnd | undefined;
  #closeRequested = false;
  #readyResolve!: () => void;
  #readyReject!: (error: OpenCodeRuntimeError) => void;
  #endResolve!: (value: OpenCodeNativeObservationEnd) => void;
  constructor(client: OpenCodeHttpClient, input: { readonly signal?: AbortSignal; readonly include?: (event: OpenCodeNativeEvent) => boolean }) {
    this.ready = new Promise((resolve, reject) => { this.#readyResolve = resolve; this.#readyReject = reject; });
    void this.ready.catch(() => undefined);
    this.ended = new Promise(resolve => { this.#endResolve = resolve; });
    const signal = AbortSignal.any([client.lifetime, this.#controller.signal, ...(input.signal ? [input.signal] : [])]);
    const timer = setTimeout(() => {
      this.#finish({ reason: "failed", error: new OpenCodeRuntimeError("opencode_event_ready_timeout") });
      this.#controller.abort();
    }, 30_000);
    this.#pump = (async () => {
      let connected = false;
      try {
        for await (const raw of client.events(value => parseOpenCodeNativeEvent(value), signal)) {
          if (signal.aborted) break;
          if (!connected) {
            if (raw.type !== "server.connected") throw new OpenCodeNativeProtocolError();
            connected = true; clearTimeout(timer); this.#readyResolve(); continue;
          }
          if (raw.type === "server.connected") throw new OpenCodeNativeProtocolError();
          if (input.include && !input.include(raw)) continue;
          const bytes = decodedBytes(raw);
          if (this.#queue.length >= OPENCODE_NATIVE_EVENT_BUFFER_RECORDS || this.#queuedBytes + bytes > OPENCODE_NATIVE_EVENT_BUFFER_BYTES) {
            this.#finish({ reason: "overflow", error: new OpenCodeRuntimeError("opencode_event_overflow") });
            this.#controller.abort(); break;
          }
          this.#queue.push({ event: raw, decodedBytes: bytes }); this.#queuedBytes += bytes; this.#wake();
        }
        if (!this.#end) this.#finish(this.#closeRequested ? { reason: "closed" } : signal.aborted
          ? { reason: "aborted", error: new OpenCodeRuntimeError("opencode_event_aborted") }
          : { reason: "disconnected", error: new OpenCodeRuntimeError("opencode_event_disconnected") });
      } catch (error) {
        const safe = error instanceof OpenCodeRuntimeError ? error : new OpenCodeRuntimeError("opencode_event_stream_failed");
        const reason = safe.code === "opencode_native_protocol_invalid" || safe.code === "opencode_event_malformed" ? "malformed"
          : safe.code === "opencode_event_overflow" || safe.code === "opencode_response_too_large" ? "overflow" : "failed";
        this.#finish({ reason, error: safe });
      } finally { clearTimeout(timer); }
    })();
  }
  get failure(): OpenCodeRuntimeError | undefined { return this.#end?.error; }
  drain(): OpenCodeNativeObservedEvent[] {
    if (this.#end) throw this.#end.error ?? new OpenCodeRuntimeError("opencode_event_closed");
    const events = this.#queue.splice(0); this.#queuedBytes = 0; return events;
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
  async close(): Promise<void> { this.#closeRequested = true; this.#controller.abort(); await this.#pump; }
  #wake(): void { for (const wake of this.#waiters) wake(); }
  #finish(value: OpenCodeNativeObservationEnd): void {
    if (this.#end) return;
    this.#end = value; this.#queue.length = 0; this.#queuedBytes = 0;
    this.#readyReject(value.error ?? new OpenCodeRuntimeError("opencode_event_closed"));
    this.#endResolve(value); this.#wake();
  }
}
