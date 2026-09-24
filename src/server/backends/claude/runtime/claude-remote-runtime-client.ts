import type { EnvironmentVariableOverrides } from "../../../../shared/protocol/environment-variables.js";
import { readClaudeSessionHistory, type ClaudeHistoryPage, type ClaudeHistoryPageOptions } from "../claude-session-history.js";
import { BackendError } from "../../contracts.js";
import type { BackgroundActivity } from "../../../../shared/protocol/background-activity.js";
import { z } from "zod";
import type { CanUseTool, SDKMessage, SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { EnvironmentChannelScope } from "../../../execution/environment-channel.js";
import { isSidecarRevisionChanged, type SidecarRuntimeLease, type SidecarRuntimeProvider } from "../../../sidecar/runtime-channel.js";
import type { ClaudeRuntimeClient, ClaudeRuntimeProbeInput, ClaudeRuntimeProbeResult, ClaudeRuntimeSession, ClaudeRuntimeSessionOptions } from "../claude-runtime-client.js";
import type { ClaudeSdkSessionInitialization } from "../claude-sdk-session.js";
import { verifyClaudeRuntimeVersion } from "../claude-release-guard.js";
import { resolveClaudeSafeSkills, type ClaudeSafeSkill } from "../claude-skills.js";
import * as worker from "../worker/claude-runtime-v1.js";
import { claudePersistentConfigurationSchema, claudePersistentAttachmentSchema, claudePersistentSendResponseSchema, type ClaudePersistentCommand, type ClaudePersistentEvent } from "./claude-persistent-runtime-wire.js";
import { ClaudeSidecarRuntimeConnection, claudePersistentRuntimeOperations } from "./claude-sidecar-runtime.js";

type Command = ClaudePersistentCommand extends infer C ? C extends ClaudePersistentCommand ? Omit<C, "runtimeId" | "controllerEpoch"> : never : never;
interface Attachment { readonly lease: SidecarRuntimeLease; readonly connection: ClaudeSidecarRuntimeConnection; readonly runtimeId: string; readonly unsubscribe: () => void }

/** Main owns subscriptions; the authenticated sidecar owns persistent SDK queries. */
export class ClaudePersistentRuntimeClient implements ClaudeRuntimeClient {
  readonly #sessions = new Map<string, PersistentSession>();
  readonly #controller = new AbortController();
  #attachment: Attachment | undefined;
  #connecting: Promise<Attachment> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #retainedIdentity: { readonly runtimeId: string; readonly serviceIncarnation: string } | undefined;
  constructor(readonly input: {
    readonly scope: EnvironmentChannelScope;
    readonly sidecarRuntime: SidecarRuntimeProvider;
    readonly executablePath: string;
    readonly configDirectory?: string;
  readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
    readonly initializationTimeoutMs: number;
    readonly onBackgroundError?: (error: unknown) => void;
  }) {
    claudePersistentConfigurationSchema.parse({ ...input.scope, executablePath: input.executablePath, configDirectory: input.configDirectory, startupEnvironmentVariables: input.startupEnvironmentVariables, initializationTimeoutMs: input.initializationTimeoutMs });
  }

  async startupEnvironmentState(): Promise<"not_started" | "started" | "unknown"> {
    return this.#retainedIdentity ? "started" : "unknown";
  }

  async probe(input: ClaudeRuntimeProbeInput): Promise<ClaudeRuntimeProbeResult> {
    this.#assertIdentity(input);
    assertEmptyEnvironment(input.environment);
    const result = worker.claudeRuntimeProbeResponseSchema.parse(await this.execute({ action: "probe", request: { cwd: input.cwd } }));
    verifyClaudeRuntimeVersion(result.cliRelease, input);
    return result as ClaudeRuntimeProbeResult;
  }
  async submissionDisposition(input: { sessionId: string; operationId: string; cwd: string }): Promise<"submitted" | "session_ended" | "not_sent" | "unknown"> {
    return z.strictObject({ disposition: z.enum(["submitted", "session_ended", "not_sent", "unknown"]) }).parse(await this.execute({ action: "submission_disposition", request: input })).disposition;
  }
  createSession(options: ClaudeRuntimeSessionOptions): ClaudeRuntimeSession {
    this.#assertOpen();
    this.#assertIdentity(options);
    worker.claudeRuntimeQueryEnvironmentSchema.parse(Object.fromEntries(Object.entries(options.environment).filter(([, value]) => value !== undefined)));
    if (this.#sessions.has(options.sessionId)) throw new Error("claude_persistent_session_already_attached");
    const session = new PersistentSession(this, options);
    this.#sessions.set(options.sessionId, session);
    return session;
  }
  async listSessions(options: Parameters<ClaudeRuntimeClient["listSessions"]>[0], environment: Readonly<Record<string, string | undefined>>) {
    assertEmptyEnvironment(environment);
    return worker.claudeRuntimeSessionListResponseSchema.parse(await this.execute({ action: "list", request: options })).sessions as SDKSessionInfo[];
  }
  async getSessionInfo(sessionId: string, options: Parameters<ClaudeRuntimeClient["getSessionInfo"]>[1], environment: Readonly<Record<string, string | undefined>>) {
    assertEmptyEnvironment(environment);
    return (worker.claudeRuntimeSessionInfoResponseSchema.parse(await this.execute({ action: "info", request: { sessionId, ...options } })).session ?? undefined) as SDKSessionInfo | undefined;
  }
  async getSessionMessages(sessionId: string, options: Parameters<ClaudeRuntimeClient["getSessionMessages"]>[1], environment: Readonly<Record<string, string | undefined>>) {
    assertEmptyEnvironment(environment);
    return readClaudeSessionHistory(page => this.getSessionMessagesPage(sessionId, page, environment), options);
  }
  async getSessionMessagesPage(sessionId: string, options: ClaudeHistoryPageOptions, environment: Readonly<Record<string, string | undefined>>): Promise<ClaudeHistoryPage> {
    assertEmptyEnvironment(environment);
    return worker.claudeRuntimeSessionMessagesResponseSchema.parse(await this.execute({ action: "messages", request: { sessionId, ...options } })) as ClaudeHistoryPage;
  }
  async renameSession(sessionId: string, title: string, options: { readonly dir: string }, environment: Readonly<Record<string, string | undefined>>) {
    assertEmptyEnvironment(environment);
    worker.claudeRuntimeSessionRenameResponseSchema.parse(await this.execute({ action: "rename", request: { sessionId, title, dir: options.dir } }));
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort();
    if (this.#retry) clearTimeout(this.#retry);
    try {
      await Promise.all([...this.#sessions.values()].map(session => session.close()));
    } finally {
      this.#discard();
      await this.#connecting?.catch(() => undefined);
    }
  }
  forget(session: PersistentSession): void {
    if (this.#sessions.get(session.options.sessionId) === session) this.#sessions.delete(session.options.sessionId);
  }
  current(): Attachment | undefined { return this.#attachment; }
  report(error: unknown): void { try { this.input.onBackgroundError?.(error); } catch { /* Diagnostics do not own runtime lifecycle. */ } }
  async execute(command: Command, attachment?: Attachment): Promise<unknown> {
    const attached = attachment ?? await this.attachment();
    return attached.connection.execute({ ...command, runtimeId: attached.runtimeId, controllerEpoch: attached.lease.controllerEpoch } as ClaudePersistentCommand);
  }
  async attachment(): Promise<Attachment> {
    this.#assertOpen();
    if (this.#attachment) return this.#attachment;
    return this.#connecting ??= this.#connect().finally(() => { this.#connecting = undefined; });
  }
  async #connect(): Promise<Attachment> {
    let existingOnly = false;
    const lease = await this.input.sidecarRuntime.acquire(this.#controller.signal).catch(async error => {
      if (!this.#retainedIdentity || !isSidecarRevisionChanged(error)) throw error;
      existingOnly = true;
      return await this.input.sidecarRuntime.acquire(this.#controller.signal, { existingOnly: true });
    });
    let connection: ClaudeSidecarRuntimeConnection | undefined;
    try {
      this.#assertOpen();
      lease.channel.assertReady();
      if (!claudePersistentRuntimeOperations.every(operation => lease.channel.supportsOperation(operation))) {
        throw new Error("claude_remote_runtime_unsupported");
      }
      connection = new ClaudeSidecarRuntimeConnection(lease.channel);
      const configuration = { ...this.input.scope, executablePath: this.input.executablePath, configDirectory: this.input.configDirectory, startupEnvironmentVariables: this.input.startupEnvironmentVariables, initializationTimeoutMs: this.input.initializationTimeoutMs };
      const runtimeId = existingOnly
        ? await connection.lookup(configuration, lease.controllerEpoch)
        : await connection.ensure(configuration);
      if (!runtimeId || (existingOnly && (runtimeId !== this.#retainedIdentity!.runtimeId || lease.serviceIncarnation !== this.#retainedIdentity!.serviceIncarnation))) {
        throw new Error("claude_persistent_retained_runtime_unavailable");
      }
      this.#retainedIdentity = { runtimeId, serviceIncarnation: lease.serviceIncarnation };
      this.#assertOpen();
      const unsubscribe = connection.onEvent(runtimeId, event => {
        if (this.#attachment?.lease === lease) this.#sessions.get(event.sessionId)?.event(event);
      });
      const attachment = { lease, connection, runtimeId, unsubscribe };
      this.#attachment = attachment;
      void lease.closed.then(() => this.#lost(attachment), () => this.#lost(attachment));
      return attachment;
    } catch (error) { connection?.close(); lease.release(); throw error; }
  }
  #lost(attachment: Attachment): void {
    if (this.#attachment !== attachment) return;
    this.#discard();
    this.#scheduleRetry();
  }
  #discard(): void {
    this.#attachment?.unsubscribe();
    this.#attachment?.connection.close();
    this.#attachment?.lease.release();
    this.#attachment = undefined;
  }
  #scheduleRetry(): void {
    if (this.#closed || this.#retry || this.#sessions.size === 0) return;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.attachment().then(async attachment => {
        await Promise.all([...this.#sessions.values()].filter(session => session.started).map(session => session.attach(attachment)));
      }).catch(async error => {
        if (attachmentDisabled(error)) {
          // Stop/Disconnect deliberately forbids automatic attachment. End
          // local handles and permission waiters; remote ownership is unchanged.
          await Promise.all([...this.#sessions.values()].map(session => session.attachmentDisabled(error)));
          return;
        }
        this.report(error); this.#scheduleRetry();
      });
    }, 1000);
    this.#retry.unref();
  }
  #assertIdentity(input: { executablePath: string; initializationTimeoutMs?: number; timeoutMs?: number }): void {
    if (input.executablePath !== this.input.executablePath || (input.initializationTimeoutMs ?? input.timeoutMs) !== this.input.initializationTimeoutMs) throw new Error("claude_persistent_runtime_identity_mismatch");
  }
  #assertOpen(): void { if (this.#closed) throw new Error("claude_persistent_runtime_client_closed"); }
}

class PersistentSession implements ClaudeRuntimeSession {
  #closed = false;
  #started = false;
  #reattached = false;
  #backgroundActivity: BackgroundActivity | undefined;
  #pendingBackgroundTaskIds: readonly string[] = [];
  #confirmedEffort: Parameters<ClaudeRuntimeSession["setEffort"]>[0] | null;
  #reopenEffort: Parameters<ClaudeRuntimeSession["setEffort"]>[0] | null;
  #modelSelection: string | null | undefined;
  #permissionSelection: ClaudeRuntimeSessionOptions["permissionMode"];
  #initialization: ClaudeSdkSessionInitialization | undefined;
  #startupProbeUuid: string | undefined;
  #safeSkills: readonly ClaudeSafeSkill[] = [];
  #attached: Attachment | undefined;
  #runtimeIdentity: string | undefined;
  #serviceIncarnation: string | undefined;
  readonly #earlyEvents = new Map<number, ClaudePersistentEvent>();
  #evicted = false;
  #opening: { attachment: Attachment; promise: Promise<ClaudeSdkSessionInitialization> } | undefined;
  #delivery: Promise<void> = Promise.resolve();
  #deliveryFailure: unknown;
  readonly #delivered = new Set<number>();
  readonly #acknowledged = new Set<number>();
  readonly #pending = new Set<number>();
  readonly #permissionControllers = new Map<string, AbortController>();
  readonly #permissionResponses = new Map<string, worker.ClaudeRuntimeCanUseToolResponse>();
  readonly #settledPermissions = new Set<string>();
  constructor(readonly client: ClaudePersistentRuntimeClient, readonly options: ClaudeRuntimeSessionOptions) {}
  get lifetime() { return "persistent_service" as const; }
  get closed() { return this.#closed; }
  get started() { return this.#started; }
  get reattached() { return this.#reattached; }
  get backgroundActivity() { return this.#backgroundActivity; }
  get pendingBackgroundTaskIds() { return this.#pendingBackgroundTaskIds; }
  get confirmedEffort() { return this.#confirmedEffort; }
  get initialization() { return this.#initialization; }
  get startupProbeUuid() { return this.#startupProbeUuid; }
  get safeSkills() { return this.#safeSkills; }
  async flushMessages(): Promise<void> { await this.#delivery; if (this.#deliveryFailure !== undefined) throw this.#deliveryFailure; }
  async start() {
    this.#assertOpen();
    this.#started = true;
    return this.attach(await this.client.attachment());
  }
  attach(attachment: Attachment): Promise<ClaudeSdkSessionInitialization> {
    this.#assertOpen();
    if (this.#attached === attachment && this.#initialization) return Promise.resolve(this.#initialization);
    if (this.#opening?.attachment === attachment) return this.#opening.promise;
    const promise = this.#open(attachment);
    this.#opening = { attachment, promise };
    void promise.finally(() => { if (this.#opening?.promise === promise) this.#opening = undefined; }).catch(() => undefined);
    return promise;
  }
  async #open(attachment: Attachment) {
    const options = this.options;
    if (this.#runtimeIdentity !== undefined && (this.#runtimeIdentity !== attachment.runtimeId || this.#serviceIncarnation !== attachment.lease.serviceIncarnation)) {
      const error = new Error("claude_persistent_runtime_replaced");
      this.#failure(error);
      await this.close();
      throw error;
    }
    this.#runtimeIdentity = attachment.runtimeId;
    this.#serviceIncarnation = attachment.lease.serviceIncarnation;
    this.#earlyEvents.clear();
    // A previous successful open established this native identity. If the
    // detached idle worker was retired, resume it without repeating creation
    // or the source fork operation.
    const launch = this.#initialization ? "resume" : options.launch;
    const model = this.#initialization ? this.#modelSelection : options.model;
    const effort = this.#reopenEffort !== undefined ? this.#reopenEffort : options.effort;
    const permissionMode = this.#initialization ? this.#permissionSelection : options.permissionMode;
    const request = worker.claudeRuntimeQueryOpenRequestSchema.parse({
      queryId: options.sessionId, sessionId: options.sessionId, cwd: options.cwd, launch,
      ...(launch === "fork" ? { sourceSessionId: options.sourceSessionId, resumeSessionAt: options.resumeSessionAt } : {}),
      ...(!this.#initialization && options.title ? { title: options.title } : {}), ...(model ? { model } : {}),
      ...(effort ? { effort } : {}), ...(permissionMode ? { permissionMode } : {}),
      ...(options.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
      enableCanUseTool: options.canUseTool !== undefined,
      environment: Object.fromEntries(Object.entries(options.environment).filter(([, value]) => value !== undefined)),
          ...(options.executionEnvironment ? { executionEnvironment: options.executionEnvironment } : {}),
    });
    const response = claudePersistentAttachmentSchema.parse(await this.client.execute({ action: "open", request, replay: this.#initialization ? "unacknowledged" : "full" }, attachment));
    if (this.#closed) {
      await this.client.execute({ action: this.#evicted ? "evict" : "detach", request: { sessionId: options.sessionId } }, attachment).catch(() => undefined);
      throw new Error("claude_persistent_session_closed");
    }
    if (response.queryId !== options.sessionId) throw new Error("claude_runtime_query_identity_mismatch");
    if (this.client.current() !== attachment) throw new Error("claude_persistent_attachment_lost");
    verifyClaudeRuntimeVersion(response.initialization.cliRelease, options);
    if (this.#initialization && !response.reattached) {
      // Idle retirement ends the old worker's event sequence. Only the host's
      // explicit fresh-query response permits resetting client deduplication.
      this.#delivered.clear();
      this.#acknowledged.clear();
      this.#pending.clear();
      this.#settledPermissions.clear();
      this.#permissionResponses.clear();
    }
    this.#reattached = response.reattached;
    this.#backgroundActivity = response.backgroundActivity;
    this.#pendingBackgroundTaskIds = response.pendingBackgroundTaskIds;
    this.#modelSelection = response.initialization.actualModel ?? model;
    this.#permissionSelection = response.initialization.actualPermissionMode ?? permissionMode;
    // Existing queries ignore requested launch settings. Only retained evidence
    // can confirm their effort; preserve the next fresh worker's selection
    // separately so a later idle retirement does not revert it.
    this.#reopenEffort = response.confirmedEffort !== undefined ? response.confirmedEffort : effort;
    this.#confirmedEffort = response.confirmedEffort !== undefined ? response.confirmedEffort : response.reattached ? undefined : effort;
    this.#initialization = response.initialization as ClaudeSdkSessionInitialization;
    this.#startupProbeUuid = response.startupProbeUuid;
    this.#safeSkills = resolveClaudeSafeSkills(this.#initialization);
    this.#attached = attachment;
    const snapshotSequence = Math.max(0, ...response.events.map(event => event.sequence));
    const pendingEvents = [...response.events, ...[...this.#earlyEvents.values()].filter(event => event.sequence > snapshotSequence)].sort((a, b) => a.sequence - b.sequence);
    this.#earlyEvents.clear();
    for (const event of pendingEvents) this.event(event);
    // Failure is retained owner state, not merely an event that disappears on ACK.
    // Drain retained output before failing hydration; never advertise a dead query.
    if (response.failureCode !== null) {
      const error = retainedQueryFailure(response.failureCode);
      this.#delivery = this.#delivery.then(() => {
        if (this.#deliveryFailure !== undefined) return;
        this.#deliveryFailure = error;
        if (!this.#closed) this.#failure(error);
      });
    }
    return this.#initialization;
  }
  async send(input: Parameters<ClaudeRuntimeSession["send"]>[0]): Promise<void> {
    this.#assertReady();
    const request = worker.claudeRuntimeQuerySendRequestSchema.parse({ queryId: this.options.sessionId, ...input });
    let response: z.infer<typeof claudePersistentSendResponseSchema>;
    try {
      response = claudePersistentSendResponseSchema.parse(await this.#execute({ action: "send", request }));
    } catch (error) {
      // A missing/invalid response still has an unknown delivery outcome.
      this.#failure(error);
      throw error;
    }
    if (!response.accepted) {
      const busy = response.code === "claude_persistent_query_busy";
      if (response.code === "claude_persistent_query_closed") this.#failure(retainedQueryFailure(response.code));
      throw new BackendError({
        category: busy ? "invalid_state" : "unavailable", retryable: busy,
        crossedSubmissionBoundary: false, backendCode: response.code,
        safeMessage: busy ? "Claude is still working. The input was not sent."
          : response.code === "claude_persistent_query_closed"
            ? "The retained Claude session has ended. Restart the Claude backend in Settings to recover. The input was not sent."
            : "The Claude runtime cannot retain another input. The input was not sent.",
      });
    }
  }
  async interrupt() {
    this.#assertReady();
    return worker.claudeRuntimeQueryInterruptOperation.responseSchema.parse(await this.#execute({ action: "interrupt", request: { queryId: this.options.sessionId } })).receipt ?? undefined;
  }
  async setModel(model?: string) {
    this.#assertReady();
    worker.claudeRuntimeQuerySetModelOperation.responseSchema.parse(await this.#execute({ action: "set_model", request: { queryId: this.options.sessionId, model: model ?? null } }));
    this.#modelSelection = model ?? null;
  }
  async setEffort(effort?: Parameters<ClaudeRuntimeSession["setEffort"]>[0]) {
    this.#assertReady();
    worker.claudeRuntimeQuerySetEffortOperation.responseSchema.parse(await this.#execute({ action: "set_effort", request: { queryId: this.options.sessionId, effort: effort ?? null } }));
    this.#confirmedEffort = effort ?? null;
    this.#reopenEffort = effort ?? null;
  }
  async setPermissionMode(permissionMode: Parameters<ClaudeRuntimeSession["setPermissionMode"]>[0]) {
    this.#assertReady();
    worker.claudeRuntimeQuerySetPermissionModeOperation.responseSchema.parse(await this.#execute({ action: "set_permission_mode", request: { queryId: this.options.sessionId, permissionMode } }));
    this.#permissionSelection = permissionMode;
  }
  async #execute(command: Command) {
    this.#assertOpen();
    const attachment = await this.client.attachment();
    await this.attach(attachment);
    this.#assertOpen();
    return this.client.execute(command, attachment);
  }
  async close(options?: { readonly reason: "evicted" }) {
    if (this.#closed) return;
    this.#closed = true;
    this.#evicted = options?.reason === "evicted";
    if (this.#evicted) await this.#opening?.promise.catch(() => undefined);
    for (const controller of this.#permissionControllers.values()) controller.abort();
    const attachment = this.client.current();
    try {
      if (attachment && this.#started && attachment.runtimeId === this.#runtimeIdentity) {
        await this.client.execute({ action: options?.reason === "evicted" ? "evict" : "detach", request: { sessionId: this.options.sessionId } }, attachment);
      }
    } catch (error) {
      if (!this.#evicted) throw error;
      // A missing acknowledgement never proves host retirement. Leave its
      // retained query recoverable; main's idle presentation is already gone.
      this.client.report(error);
      console.warn("claude_idle_release_deferred", { sessionId: this.options.sessionId,
        reason: error instanceof Error ? error.message.slice(0, 240) : "unknown" });
    } finally { this.client.forget(this); }
  }
  async attachmentDisabled(error: unknown): Promise<void> {
    if (this.#closed) return;
    this.#failure(error);
    await this.close().catch(closeError => this.client.report(closeError));
  }
  event(event: ClaudePersistentEvent): void {
    if (this.#closed || event.sessionId !== this.options.sessionId) return;
    if (!this.#initialization || this.#attached !== this.client.current()) {
      if (this.#earlyEvents.size >= 8192) { this.#failure(new Error("claude_persistent_initial_event_capacity_exceeded")); void this.close().catch(error => this.client.report(error)); return; }
      this.#earlyEvents.set(event.sequence, event);
      return;
    }
    if (this.#delivered.has(event.sequence) || this.#acknowledged.has(event.sequence)) { void this.#ack(event.sequence).catch(error => this.client.report(error)); return; }
    if (this.#pending.has(event.sequence)) return;
    this.#pending.add(event.sequence);
    if (event.payload.kind === "permission") {
      void this.#permission(event).catch(error => this.client.report(error)).finally(() => this.#pending.delete(event.sequence));
      return;
    }
    this.#delivery = this.#delivery.then(async () => {
      if (this.#closed) return;
      const payload = event.payload;
      if (payload.kind === "message") {
        const message = payload.message as SDKMessage;
        if (message.type === "system" && message.subtype === "commands_changed") this.#safeSkills = [];
        const committed = payload.consumedTurnRootUuid
          ? await this.options.onMessage(message, { consumedTurnRootUuid: payload.consumedTurnRootUuid })
          : await this.options.onMessage(message);
        // ACKs identify exact events, not a cumulative cursor. A failed main
        // accounting write retains only this original in the existing host
        // journal; later events and provider work continue normally. Existing
        // reattachment replays the unacknowledged evidence.
        if (committed === false) return;
      } else if (payload.kind === "failed") {
        this.#deliveryFailure = retainedQueryFailure(payload.code);
        this.#failure(this.#deliveryFailure);
      } else if (payload.kind === "permission_delivered" || payload.kind === "permission_failed") {
        const identity = { requestId: payload.requestId, toolUseID: payload.toolUseID };
        this.#settledPermissions.add(payload.requestId);
        if (this.#settledPermissions.size > 8192) this.#settledPermissions.delete(this.#settledPermissions.values().next().value!);
        this.#permissionResponses.delete(payload.requestId);
        if (payload.kind === "permission_delivered") await this.options.onPermissionResponseDelivered?.(identity);
        else await this.options.onPermissionResponseDeliveryFailed?.({ ...identity, error: new Error("claude_permission_response_not_adopted") });
        // The provider can cancel a request before main has a user decision.
        // Abort its local waiter even when there was no submitted response for
        // the delivery observer to settle.
        this.#permissionControllers.get(payload.requestId)?.abort();
      }
      this.#rememberDelivered(event.sequence);
      await this.#ack(event.sequence).catch(error => this.client.report(error));
    }).catch(error => {
      this.#deliveryFailure = error;
      this.#failure(error);
      void this.close().catch(error => this.client.report(error));
    }).finally(() => this.#pending.delete(event.sequence));
  }
  async #permission(event: ClaudePersistentEvent) {
    if (event.payload.kind !== "permission") return;
    const request = event.payload.request;
    const requestId = request.options.requestId;
    if (this.#settledPermissions.has(requestId)) {
      this.#rememberDelivered(event.sequence);
      await this.#ack(event.sequence);
      return;
    }
    let response = this.#permissionResponses.get(requestId);
    if (!response) {
      const controller = new AbortController();
      this.#permissionControllers.set(requestId, controller);
      try {
        response = worker.claudeRuntimeCanUseToolResponseSchema.parse(this.options.canUseTool
          ? await this.options.canUseTool(request.toolName, request.input as Record<string, unknown>, { ...request.options, signal: controller.signal } as Parameters<CanUseTool>[2])
          : { behavior: "deny", message: "Permission request unavailable.", toolUseID: request.options.toolUseID, decisionClassification: "user_reject" });
        controller.signal.throwIfAborted();
        this.#permissionResponses.set(requestId, response);
      } catch (error) {
        if (controller.signal.aborted) {
          if (!this.#closed) {
            this.#rememberDelivered(event.sequence);
            await this.#ack(event.sequence);
          }
          return;
        }
        if (!this.#closed) {
          await this.options.onPermissionResponseDeliveryFailed?.({ requestId, toolUseID: request.options.toolUseID, error });
          this.#failure(error);
          void this.close().catch(error => this.client.report(error));
        }
        throw error;
      } finally { this.#permissionControllers.delete(requestId); }
    }
    if (this.#closed) return;
    await this.#execute({ action: "respond_permission", request: { sessionId: this.options.sessionId, requestId, toolUseID: request.options.toolUseID, response } });
    this.#rememberDelivered(event.sequence);
    await this.#ack(event.sequence);
  }
  #rememberDelivered(sequence: number): void {
    // Pin applied events until exact ACK succeeds, even across arbitrarily many
    // later successful deliveries. The service bounds outstanding journal entries.
    this.#delivered.add(sequence);
  }
  async #ack(sequence: number) {
    const attachment = this.client.current();
    if (!attachment) return;
    await this.client.execute({ action: "acknowledge", request: { sessionId: this.options.sessionId, sequence } }, attachment);
    this.#delivered.delete(sequence);
    this.#acknowledged.add(sequence);
    // Same-session attachments request only unacknowledged originals. Keep a
    // full journal window for duplicates already queued before an ACK succeeded.
    if (this.#acknowledged.size > 8192) this.#acknowledged.delete(this.#acknowledged.values().next().value!);
  }
  #assertOpen(): void { if (this.#closed) throw new Error("claude_persistent_session_closed"); }
  #assertReady(): void { this.#assertOpen(); if (!this.#initialization) throw new Error("claude_runtime_session_not_ready"); }
  #failure(error: unknown): void { try { this.options.onFailure?.(error); } catch (observerError) { this.client.report(observerError); } this.client.report(error); }
}

function attachmentDisabled(error: unknown): boolean {
  for (let depth = 0; error instanceof Error && depth < 8; depth++, error = error.cause) {
    if (["sidecar_intentionally_disconnected", "sidecar_automatic_connection_disabled", "sidecar_runtime_closed", "claude_remote_runtime_unsupported", "claude_persistent_retained_runtime_unavailable", "sidecar_service_absent"].includes(error.message)) return true;
  }
  return false;
}

function assertEmptyEnvironment(environment: Readonly<Record<string, string | undefined>>): void {
  if (Object.values(environment).some(value => value !== undefined)) throw new Error("claude_persistent_runtime_environment_invalid");
}

function retainedQueryFailure(code: string): BackendError {
  return new BackendError({
    category: "unavailable", retryable: false, crossedSubmissionBoundary: true,
    backendCode: code,
    safeMessage: "The retained Claude session has ended. Restart the Claude backend in Settings to recover; review any unresolved inputs before sending again.",
  });
}
