import { parseOpenCodeReadInput, parseOpenCodeReadOutput, parseOpenCodeMutationInput,
  parseOpenCodeMutationOutput } from "./opencode-native-codecs.js";
import type { OpenCodeReadMethod, OpenCodeReadInput, OpenCodeReadOutput, OpenCodeMutationMethod,
  OpenCodeMutationInput, OpenCodeMutationOutput } from "./opencode-native-port.js";
import type { PermissionGetInput, SessionFormGetInput, SessionFormReplyInput, SessionFormCancelInput,
  SessionInboxCancelInput, SessionSwitchModelInput, SessionCompactOutput } from "@opencode/client";
import type { Permission } from "@opencode/schema/permission";
import path from "node:path";
import { OpenCodeHttpClient } from "./opencode-http-client.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";
import { z } from "zod";
import { OPENCODE_MCP_STARTUP_MS } from "../../../internal/opencode-mcp/contracts.js";
import { OpenCodeNativeReadLimitError, OpenCodeNativeProtocolError, OPENCODE_NATIVE_EVENT_BUFFER_RECORDS,
  OPENCODE_NATIVE_EVENT_BUFFER_BYTES, parseOpenCodeNativeMessage, parseOpenCodeNativeEvent, parseSession,
  parseMessagePage, parseSessionPage, parseActive, parseInbox, parsePermissions, parseForms, parseShells,
  parseInterrupt, decodedBytes, id, pageOptions, boundedInventory, pageCursor, nativeRead,
  OpenCodeNativeMutationInputError, nativeId, directory, parseCreateInput, parsePromptInput, parseInputRef,
  parseCompactInput, parseCompaction, parseModelInput, parsePermissionRef, parsePermissionReply, parseFormRef,
  parseFormReply, parseMutationSession, parseAdmission, parsePermission, parseForm, parseModels, parseDefault,
  parseSkills, parseEnvironment, parsePermissionsInput, noContent, scopedRef, OPENCODE_NATIVE_LOG_LIMITS,
  OpenCodeNativeLogError, parseLog } from "./opencode-native-codecs.js";
import type { OpenCodeNativeMessage, OpenCodeNativeSession, OpenCodeNativeEvent, OpenCodeNativeInboxItem,
  OpenCodeNativeHistoryReadOptions, OpenCodeNativeHistoryPage, OpenCodeNativeSessionListOptions,
  OpenCodeNativeSessionPage, OpenCodeNativeInteractions, OpenCodeNativeActivity, OpenCodeNativeModel,
  OpenCodeNativePromptAdmission, OpenCodeNativeCompactInput, OpenCodeNativePermission,
  OpenCodeNativeFormDetail, OpenCodeNativeSkill, OpenCodeNativeCreateInput, OpenCodeNativePromptInput,
  OpenCodeNativePermissionReplyInput, OpenCodeNativeDurableEvent, OpenCodeNativeLogGap, OpenCodeNativeLogCut,
  OpenCodeNativeLogReadInput } from "./opencode-native-codecs.js";

/** Read-only native data and the independent conversation Stop control. */
class HttpNativeApi {
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
    if ((input.directory !== undefined && !path.posix.isAbsolute(input.directory)) ||
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
    if (!path.posix.isAbsolute(directory)) throw new OpenCodeRuntimeError("opencode_native_read_input_invalid");
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
  observe(input: { readonly signal?: AbortSignal; readonly include?: (event: OpenCodeNativeEvent) => boolean } = {}): OpenCodeHttpObservation {
    return new OpenCodeHttpObservation(this.client, input);
  }
}

export interface OpenCodeNativeObservedEvent { readonly event: OpenCodeNativeEvent; readonly decodedBytes: number; }
export interface OpenCodeHttpObservationEnd {
  readonly reason: "closed" | "aborted" | "disconnected" | "malformed" | "overflow" | "failed";
  readonly error?: OpenCodeRuntimeError;
}

/** One bounded, immediately pumped subscription; EOF invalidates, never reconnects. */
export class OpenCodeHttpObservation {
  readonly ready: Promise<void>;
  readonly ended: Promise<OpenCodeHttpObservationEnd>;
  readonly #controller = new AbortController();
  readonly #waiters = new Set<() => void>();
  readonly #queue: OpenCodeNativeObservedEvent[] = [];
  readonly #pump: Promise<void>;
  #queuedBytes = 0;
  #end: OpenCodeHttpObservationEnd | undefined;
  #closeRequested = false;
  #readyResolve!: () => void;
  #readyReject!: (error: OpenCodeRuntimeError) => void;
  #endResolve!: (value: OpenCodeHttpObservationEnd) => void;
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
  #finish(value: OpenCodeHttpObservationEnd): void {
    if (this.#end) return;
    this.#end = value; this.#queue.length = 0; this.#queuedBytes = 0;
    this.#readyReject(value.error ?? new OpenCodeRuntimeError("opencode_event_closed"));
    this.#endResolve(value); this.#wake();
  }
}

/** Typed native effects only. Receipts, retry authority and operation recovery belong to the caller. */
class HttpNativeMutations {
  constructor(readonly client: OpenCodeHttpClient) {}

  async createSession(input: OpenCodeNativeCreateInput, signal?: AbortSignal): Promise<OpenCodeNativeSession> {
    const request = parseCreateInput(input); nativeId(request.id, "ses_"); directory(request.location.directory);
    return this.client.call((client, budget) => client.session.create(request, { signal: budget }), value => {
      const session = parseMutationSession(value);
      if (session.id !== request.id || session.location.directory !== request.location.directory) throw new OpenCodeNativeProtocolError();
      return session;
    }, signal);
  }
  async prompt(input: OpenCodeNativePromptInput, signal?: AbortSignal): Promise<OpenCodeNativePromptAdmission> {
    const request = parsePromptInput(input); scopedRef(request, request.id, "msg_");
    return this.client.call((client, budget) => client.session.prompt(request, { signal: budget }), value => {
      const admission = parseAdmission(value);
      if (admission.id !== request.id || admission.sessionID !== request.sessionID) throw new OpenCodeNativeProtocolError();
      // Native hooks prepare text/files/metadata before admission. Byte equality
      // with the original request is deliberately not acceptance authority.
      return admission;
    }, signal);
  }
  async cancelInput(input: SessionInboxCancelInput, signal?: AbortSignal): Promise<void> {
    const request = parseInputRef(input); scopedRef(request, request.inboxID, "msg_");
    return this.client.call((client, budget) => client.session.inbox.cancel(request, { signal: budget }), noContent, signal);
  }
  async compact(input: OpenCodeNativeCompactInput, signal?: AbortSignal): Promise<SessionCompactOutput> {
    const request = parseCompactInput(input); scopedRef(request, request.id, "msg_");
    return this.client.call((client, budget) => client.session.compact(request, { signal: budget }), value => {
      const admission = parseCompaction(value);
      // Native coalesces another pending compaction. That never proves admission
      // of our reserved control, nor gives us authority over the other control.
      if (admission.id !== request.id || admission.sessionID !== request.sessionID || admission.delivery !== request.delivery) {
        throw new OpenCodeNativeProtocolError();
      }
      return admission;
    }, signal);
  }
  async setEnvironment(input: { sessionID: string; variables: Readonly<Record<string, string>> }, signal?: AbortSignal): Promise<void> {
    const request = parseEnvironment(input); nativeId(request.sessionID, "ses_");
    if (Object.keys(request.variables).length > 512 || Buffer.byteLength(JSON.stringify(request.variables)) > 1_048_576 ||
        Object.entries(request.variables).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || key.length > 256 || value.includes("\0") || Buffer.byteLength(value) > 65_536)) {
      throw new OpenCodeNativeMutationInputError();
    }
    return this.client.call((client, budget) => client.session.environment(request, { signal: budget }), noContent, signal);
  }
  async setPermissions(input: { sessionID: string; permissions: Permission.Ruleset }, signal?: AbortSignal): Promise<void> {
    const request = parsePermissionsInput(input); nativeId(request.sessionID, "ses_");
    if (request.permissions.length > 1_024) throw new OpenCodeNativeMutationInputError();
    return this.client.call((client, budget) => client.session.update(request, { signal: budget }), noContent, signal);
  }
  async listSkills(workspace: string, signal?: AbortSignal): Promise<readonly OpenCodeNativeSkill[]> {
    directory(workspace);
    return this.client.call((client, budget) => client.skill.list({ location: { directory: workspace } }, { signal: budget }), value => {
      const result = parseSkills(value);
      if (result.location.directory !== workspace || result.data.length > 4_096 ||
          new Set(result.data.map(skill => skill.id)).size !== result.data.length) throw new OpenCodeNativeProtocolError();
      return result.data;
    }, signal);
  }
  async listModels(workspace: string, signal?: AbortSignal): Promise<readonly OpenCodeNativeModel[]> {
    directory(workspace);
    return this.client.call((client, budget) => client.model.list({ location: { directory: workspace } }, { signal: budget }), value => {
      const result = parseModels(value);
      if (result.location.directory !== workspace || result.data.length > 10_000 ||
          new Set(result.data.map(model => JSON.stringify([model.providerID, model.id]))).size !== result.data.length) throw new OpenCodeNativeProtocolError();
      return result.data;
    }, signal);
  }
  async getDefaultModel(workspace: string, signal?: AbortSignal): Promise<OpenCodeNativeModel | undefined> {
    directory(workspace);
    return this.client.call((client, budget) => client.model.default({ location: { directory: workspace } }, { signal: budget }), value => {
      const result = parseDefault(value);
      if (result.location.directory !== workspace) throw new OpenCodeNativeProtocolError();
      return result.data ?? undefined;
    }, signal);
  }
  async setModel(input: SessionSwitchModelInput, signal?: AbortSignal): Promise<void> {
    const request = parseModelInput(input); nativeId(request.sessionID, "ses_");
    return this.client.call((client, budget) => client.session.switchModel(request, { signal: budget }), noContent, signal);
  }
  async renameSession(sessionID: string, title: string, signal?: AbortSignal): Promise<void> {
    nativeId(sessionID, "ses_");
    // Empty title asks OpenCode to generate a title using a model.
    if (typeof title !== "string" || !title.trim() || Buffer.byteLength(title) > 16_384) throw new OpenCodeNativeMutationInputError();
    return this.client.call((client, budget) => client.session.update({ sessionID, title }, { signal: budget }), noContent, signal);
  }
  async getPermission(input: PermissionGetInput, signal?: AbortSignal): Promise<OpenCodeNativePermission> {
    const request = parsePermissionRef(input); scopedRef(request, request.requestID, "per_");
    return this.client.call((client, budget) => client.permission.get(request, { signal: budget }), value => {
      const permission = parsePermission(value);
      if (permission.sessionID !== request.sessionID || permission.id !== request.requestID) throw new OpenCodeNativeProtocolError();
      return permission;
    }, signal);
  }
  async replyPermission(input: OpenCodeNativePermissionReplyInput, signal?: AbortSignal): Promise<void> {
    const request = parsePermissionReply(input); scopedRef(request, request.requestID, "per_");
    return this.client.call((client, budget) => client.permission.reply(request, { signal: budget }), noContent, signal);
  }
  async getForm(input: SessionFormGetInput, signal?: AbortSignal): Promise<OpenCodeNativeFormDetail> {
    const request = parseFormRef(input); scopedRef(request, request.formID, "frm_");
    return this.client.call((client, budget) => client.session.form.get(request, { signal: budget }), value => {
      const form = parseForm(value);
      if (form.sessionID !== request.sessionID || form.id !== request.formID) throw new OpenCodeNativeProtocolError();
      return form;
    }, signal);
  }
  async replyForm(input: SessionFormReplyInput, signal?: AbortSignal): Promise<void> {
    const request = parseFormReply(input); scopedRef(request, request.formID, "frm_");
    return this.client.call((client, budget) => client.session.form.reply(request, { signal: budget }), noContent, signal);
  }
  async cancelForm(input: SessionFormCancelInput, signal?: AbortSignal): Promise<void> {
    const request = parseFormRef(input); scopedRef(request, request.formID, "frm_");
    return this.client.call((client, budget) => client.session.form.cancel(request, { signal: budget }), noContent, signal);
  }
}

/**
 * Finite experimental native log acquisition, never a replay guarantee. Stock
 * 2.0.18 CLI does not persist event payloads and normally returns only a synced
 * watermark. Missing coordinates are explicit gaps, never negative evidence.
 */
async function readHttpNativeLog(client: OpenCodeHttpClient, input: OpenCodeNativeLogReadInput): Promise<OpenCodeNativeLogCut> {
  const limits = { ...OPENCODE_NATIVE_LOG_LIMITS, ...input.limits };
  for (const key of ["decodedBytes", "records", "milliseconds"] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > OPENCODE_NATIVE_LOG_LIMITS[key]) {
      throw new OpenCodeNativeLogError("input");
    }
  }
  if (!/^ses_[^\x00-\x20/\\]{1,252}$/u.test(input.sessionID) ||
      (input.after !== undefined && (!Number.isSafeInteger(input.after) || input.after < 0)) ||
      (input.deadlineAt !== undefined && (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < 0))) {
    throw new OpenCodeNativeLogError("input");
  }
  const deadline = Math.min(Date.now() + limits.milliseconds, input.deadlineAt ?? Infinity);
  const timerController = new AbortController();
  const signal = AbortSignal.any([client.lifetime, timerController.signal, ...(input.signal ? [input.signal] : [])]);
  const check = () => {
    if (input.signal?.aborted || client.lifetime.aborted) throw new OpenCodeNativeLogError("cancelled");
    if (Date.now() >= deadline || timerController.signal.aborted) throw new OpenCodeNativeLogError("time");
  };
  check();
  const timer = setTimeout(() => timerController.abort(), Math.max(1, deadline - Date.now()));
  timer.unref?.();
  const events: OpenCodeNativeDurableEvent[] = [];
  const sequenceGaps: OpenCodeNativeLogGap[] = [];
  const eventIds = new Set<string>();
  let frontier = input.after ?? -1;
  let watermark: number | undefined;
  let synced = false;
  let decodedBytes = 0;
  let records = 0;
  try {
    for await (const item of client.stream({ kind: "log", sessionID: input.sessionID,
      ...(input.after === undefined ? {} : { after: input.after }) }, parseLog, signal)) {
      check();
      decodedBytes += Buffer.byteLength(JSON.stringify(item));
      records++;
      if (decodedBytes > limits.decodedBytes) throw new OpenCodeNativeLogError("bytes");
      if (records > limits.records) throw new OpenCodeNativeLogError("records");
      if (synced) throw new OpenCodeNativeLogError("invalid");
      if (item.type === "log.synced") {
        if (item.aggregateID !== input.sessionID ||
            (item.seq === undefined ? frontier !== -1 : !Number.isSafeInteger(item.seq) || item.seq < frontier)) {
          throw new OpenCodeNativeLogError("invalid");
        }
        watermark = item.seq;
        if (watermark !== undefined && watermark > frontier) sequenceGaps.push({ after: frontier, through: watermark });
        synced = true;
      } else {
        const seq = item.durable.seq;
        if (item.durable.aggregateID !== input.sessionID || item.data.sessionID !== input.sessionID ||
            !Number.isSafeInteger(seq) || seq <= frontier || eventIds.has(item.id)) throw new OpenCodeNativeLogError("invalid");
        if (seq > frontier + 1) sequenceGaps.push({ after: frontier, through: seq - 1 });
        eventIds.add(item.id); frontier = seq; events.push(item);
      }
    }
    check();
    if (!synced) throw new OpenCodeNativeLogError("incomplete");
    return { sessionID: input.sessionID, ...(input.after === undefined ? {} : { after: input.after }),
      watermark, events, sequenceGaps, decodedBytes, records };
  } catch (error) {
    check();
    throw error;
  } finally { clearTimeout(timer); timerController.abort(); }
}

export type OpenCodeHttpMutationMethod = Exclude<OpenCodeMutationMethod, "installSessionEnvironment" | "ensureMcpRegistration">;

/** One host-side implementation for local and remotely hosted OpenCode connections. */
export class OpenCodeHttpNativeAdapter {
  readonly #reads: HttpNativeApi;
  readonly #writes: HttpNativeMutations;
  constructor(readonly client: OpenCodeHttpClient) {
    this.#reads = new HttpNativeApi(client); this.#writes = new HttpNativeMutations(client);
  }
  async read<K extends OpenCodeReadMethod>(method: K, raw: OpenCodeReadInput<K>, signal?: AbortSignal): Promise<OpenCodeReadOutput<K>> {
    const input = parseOpenCodeReadInput(method, raw);
    let value: unknown;
    // The switch is the closed native method catalog, never arbitrary HTTP routing.
    switch (method) {
      case "getSession": value = await this.#reads.getSession((input as OpenCodeReadInput<"getSession">).sessionID, signal); break;
      case "listSessions": value = await this.#reads.listSessions({ ...input as OpenCodeReadInput<"listSessions">, signal }); break;
      case "getMessage": { const request = input as OpenCodeReadInput<"getMessage">; value = await this.#reads.getMessage(request.sessionID, request.messageID, signal); break; }
      case "getHistoryPage": { const { sessionID, ...request } = input as OpenCodeReadInput<"getHistoryPage">; value = await this.#reads.getHistoryPage(sessionID, { ...request, signal }); break; }
      case "getActive": value = await this.#reads.getActive(signal); break;
      case "getPending": value = await this.#reads.getPending((input as OpenCodeReadInput<"getPending">).sessionID, signal); break;
      case "getInteractions": value = await this.#reads.getInteractions((input as OpenCodeReadInput<"getInteractions">).sessionID, signal); break;
      case "getActivity": { const request = input as OpenCodeReadInput<"getActivity">; value = await this.#reads.getActivity(request.sessionID, request.directory, signal); break; }
      case "listSkills": value = await this.#writes.listSkills((input as OpenCodeReadInput<"listSkills">).directory, signal); break;
      case "listModels": value = await this.#writes.listModels((input as OpenCodeReadInput<"listModels">).directory, signal); break;
      case "getDefaultModel": value = await this.#writes.getDefaultModel((input as OpenCodeReadInput<"getDefaultModel">).directory, signal) ?? null; break;
      case "getPermission": value = await this.#writes.getPermission(input as OpenCodeReadInput<"getPermission">, signal); break;
      case "getForm": value = await this.#writes.getForm(input as OpenCodeReadInput<"getForm">, signal); break;
      case "readLog": { const cut = await readHttpNativeLog(this.client, { ...input as OpenCodeReadInput<"readLog">, signal });
        value = { ...cut, watermark: cut.watermark ?? null }; break; }
      default: throw new OpenCodeRuntimeError("opencode_native_read_input_invalid");
    }
    return parseOpenCodeReadOutput(method, input, value);
  }
  async mutate<K extends OpenCodeHttpMutationMethod>(method: K, raw: OpenCodeMutationInput<K>, signal?: AbortSignal): Promise<OpenCodeMutationOutput<K>> {
    const input = parseOpenCodeMutationInput(method, raw);
    let value: unknown;
    switch (method) {
      case "createSession": value = await this.#writes.createSession(input as OpenCodeMutationInput<"createSession">, signal); break;
      case "prompt": value = await this.#writes.prompt(input as OpenCodeMutationInput<"prompt">, signal); break;
      case "compact": value = await this.#writes.compact(input as OpenCodeMutationInput<"compact">, signal); break;
      case "cancelInput": await this.#writes.cancelInput(input as OpenCodeMutationInput<"cancelInput">, signal); value = { ok: true }; break;
      case "setModel": await this.#writes.setModel(input as OpenCodeMutationInput<"setModel">, signal); value = { ok: true }; break;
      case "renameSession": { const request = input as OpenCodeMutationInput<"renameSession">; await this.#writes.renameSession(request.sessionID, request.title, signal); value = { ok: true }; break; }
      case "setPermissions": await this.#writes.setPermissions(input as OpenCodeMutationInput<"setPermissions">, signal); value = { ok: true }; break;
      case "replyPermission": await this.#writes.replyPermission(input as OpenCodeMutationInput<"replyPermission">, signal); value = { ok: true }; break;
      case "replyForm": await this.#writes.replyForm(input as OpenCodeMutationInput<"replyForm">, signal); value = { ok: true }; break;
      case "cancelForm": await this.#writes.cancelForm(input as OpenCodeMutationInput<"cancelForm">, signal); value = { ok: true }; break;
      case "interruptSession": value = await this.#reads.interruptSession((input as OpenCodeMutationInput<"interruptSession">).sessionID, signal); break;
      default: throw new OpenCodeNativeMutationInputError();
    }
    return parseOpenCodeMutationOutput(method, input, value);
  }
  observe(input: { readonly signal?: AbortSignal } = {}): OpenCodeHttpObservation { return this.#reads.observe(input); }
  /** Host-only hook. Callers have already merged the admitted immutable launch baseline. */
  setEnvironmentVariables(input: { sessionID: string; variables: Readonly<Record<string, string>> }, signal?: AbortSignal): Promise<void> {
    return this.#writes.setEnvironment(input, signal);
  }
  async listMcp(workspace: string, signal?: AbortSignal): Promise<{ location: { directory?: string }; data: { name: string }[] }> {
    directory(workspace);
    const inventory = await this.client.call((client, budget) => client.mcp.list({ location: { directory: workspace } }, { signal: budget }),
      value => z.strictObject({ location: z.strictObject({ directory: z.string().optional() }), data: z.array(z.object({
        name: z.string().max(256), status: z.strictObject({ status: z.enum(["connected", "pending", "disabled", "failed", "needs_auth"]),
          error: z.string().max(65_536).optional() }), integrationID: z.string().max(256).optional(),
      }).passthrough()).max(256) }).parse(value), signal);
    if (inventory.location.directory !== workspace) throw new OpenCodeNativeProtocolError();
    return { location: inventory.location, data: inventory.data.map(({ name }) => ({ name })) };
  }
  async addMcp(input: { readonly directory: string; readonly name: string;
    readonly command: readonly [string, "opencode-mcp"]; readonly environment: Readonly<Record<string, string>> }, signal?: AbortSignal): Promise<void> {
    directory(input.directory);
    if (!/^sedes_[a-f0-9]{48}$/u.test(input.name) || input.command.length !== 2 || input.command[1] !== "opencode-mcp" ||
        !path.posix.isAbsolute(input.command[0]) || path.posix.basename(input.command[0]) !== "sedes" || input.command[0].includes("\0") ||
        Object.keys(input.environment).length > 16 || Buffer.byteLength(JSON.stringify(input.environment)) > 65_536 ||
        Object.entries(input.environment).some(([key, value]) => !/^[A-Z_][A-Z0-9_]*$/u.test(key) || typeof value !== "string" || value.includes("\0"))) {
      throw new OpenCodeNativeMutationInputError();
    }
    await this.client.call((client, budget) => client.mcp.add({ server: input.name, location: { directory: input.directory }, config: {
      type: "local", command: [...input.command], environment: { ...input.environment }, codemode: false, protocol: "legacy",
      timeout: { startup: OPENCODE_MCP_STARTUP_MS, catalog: OPENCODE_MCP_STARTUP_MS, execution: 86_400_000 },
    } }, { signal: budget }), noContent, signal);
  }
}
