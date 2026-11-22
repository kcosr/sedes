import { randomUUID } from "node:crypto";
import { backendConversationSnapshotSchema, type BackendCapabilityDocument } from "../../../shared/protocol/backend.js";
import type { EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { UsageSink } from "../../usage/contracts.js";
import { BackendError, type AgentBackendInstance, type AgentConnectionProfile, type AttachConversationInput,
  type BackendCatalogContext, type ConversationBackendDriver, type ConversationHistoryReader,
  type CreateConversationInput, type DiscoverConversationsInput, type ReadConversationInput,
  type ReconcileSubmissionInput, type ReleaseConversationResidencyInput, type SubmissionReconciliation } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import { parseAntigravityBinding, serializeAntigravityBinding, type AntigravityBinding } from "./binding.js";
import { antigravityCapabilities, antigravityCatalog } from "./catalog.js";
import { AntigravityHandle } from "./handle.js";
import { antigravityHistoryPage, antigravityWindowSnapshot, antigravitySteerConsumed, locateAntigravityTurn, projectAntigravityHistory } from "./history.js";
import { AntigravityError, type AntigravityHistory, type AntigravityPort, type AntigravitySetup } from "./port.js";
import { antigravityReconciliationTag, inspectAntigravityInput } from "./submission.js";
import type { AntigravityThreadRepository } from "./thread-repository.js";
import type { AntigravityAgentToolService, AntigravityToolSource } from "./agent-tools.js";
import { antigravityReadError, antigravityTransportError } from "./errors.js";

export interface AntigravityDriverInput {
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly scope: RequestScope;
  readonly port: AntigravityPort;
  readonly settings: Pick<AntigravityThreadRepository, "get" | "assertConnection">;
  readonly modelPolicy: CompiledBackendModelPolicy;
  readonly nativeNamespaceKey: string;
  readonly correlationKey: Uint8Array;
  readonly usage?: UsageSink;
  readonly agentTools?: AntigravityAgentToolService;
  readonly modeCatalog?: { observe(setup: AntigravitySetup): void };
  readonly executionEnvironmentVariables?: (applicationThreadId: string) => EnvironmentVariableOverrides;
  readonly isOperationAbandoned?: (applicationThreadId: string, operationId: string) => boolean;
}
export class AntigravityDriver implements ConversationBackendDriver {
  readonly instance; readonly connection;
  readonly handles = new Set<AntigravityHandle>();
  #catalog?: { setup: AntigravitySetup; expires: number };
  readonly #discoveryPages = new Map<string, { cwd: string; page: Awaited<ReturnType<AntigravityPort["listSessions"]>>; expires: number; bytes: number }>();
  #closed = false;
  constructor(readonly input: AntigravityDriverInput) {
    this.instance = input.instance; this.connection = input.connection;
    this.assertScope(input.scope);
    if (this.instance.kind !== "antigravity" || this.connection.kind !== "antigravity_acp" || this.connection.backendInstanceId !== this.instance.id)
      throw unavailable("The Antigravity connection is invalid.");
  }
  assertScope(scope: RequestScope): void {
    if (this.#closed || scope.tenantId !== this.input.scope.tenantId || scope.principalId !== this.input.scope.principalId ||
      this.instance.tenantId !== scope.tenantId || this.connection.tenantId !== scope.tenantId || this.connection.ownerPrincipalId !== scope.principalId)
      throw unavailable("The Antigravity target is unavailable in this scope.");
  }
  async environment(threadId: string): Promise<EnvironmentVariableOverrides> {
    return this.input.executionEnvironmentVariables?.(threadId) ?? {};
  }
  toolSource(threadId: string, workspaceId: string): AntigravityToolSource {
    return { scope: this.input.scope, applicationThreadId: threadId, workspaceId, executionEnvironmentId: this.connection.executionEnvironmentId };
  }
  nativeBinding(sessionId: string, cwd: string): AntigravityBinding {
    return parseAntigravityBinding(serializeAntigravityBinding({ version: 1, sessionId, canonicalWorkspacePath: cwd,
      tenantId: this.input.scope.tenantId, principalId: this.input.scope.principalId, backendInstanceId: this.instance.id,
      connectionProfileId: this.connection.id, executionEnvironmentId: this.connection.executionEnvironmentId, nativeNamespaceKey: this.input.nativeNamespaceKey }));
  }
  validate(input: ReadConversationInput | AttachConversationInput | ReleaseConversationResidencyInput): AntigravityBinding {
    this.assertScope(input.scope);
    let detail: AntigravityBinding;
    try { detail = parseAntigravityBinding(input.opaqueBindingDetail); }
    catch { throw unavailable("The Antigravity session binding is invalid."); }
    const expected = this.nativeBinding(input.binding.backendConversationId, input.workspace.canonicalPath);
    if (serializeAntigravityBinding(detail) !== serializeAntigravityBinding(expected) || input.binding.tenantId !== input.scope.tenantId ||
      input.binding.ownerPrincipalId !== input.scope.principalId || input.binding.backendInstanceId !== this.instance.id ||
      input.binding.connectionProfileId !== this.connection.id || input.binding.executionEnvironmentId !== this.connection.executionEnvironmentId)
      throw unavailable("The Antigravity binding does not match this target.");
    return detail;
  }
  async health() {
    try { await this.input.port.connect(); return { available: true, checkedAt: new Date().toISOString() }; }
    catch { return { available: false, checkedAt: new Date().toISOString(), diagnostic: boundDisplayText("Antigravity is unavailable on its execution host.") }; }
  }
  async catalog(context: BackendCatalogContext) {
    this.assertScope(context.scope);
    if (!this.#catalog || this.#catalog.expires <= Date.now()) this.#catalog = {
      setup: await this.input.port.catalog({ cwd: context.workspace.canonicalPath }).catch(error => { throw antigravityReadError(error); }), expires: Date.now() + 60_000 };
    this.input.modeCatalog?.observe(this.#catalog.setup);
    return antigravityCatalog(this.#catalog.setup, this.connection.id, this.input.modelPolicy);
  }
  async discover(input: DiscoverConversationsInput) {
    this.assertScope(input.scope); input.signal.throwIfAborted();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw unavailable("The Antigravity discovery page size is invalid.");
    const cwd = input.workspace.canonicalPath;
    let key: string | undefined, offset = 0, providerCursor: string | undefined;
    if (input.cursor) {
      const match = /^([a-f0-9-]{36}):(\d{1,6})$/u.exec(input.cursor);
      const cached = match && this.#discoveryPages.get(match[1]!);
      if (!cached || cached.cwd !== cwd || cached.expires <= Date.now()) throw unavailable("The Antigravity discovery page expired. Start a fresh scan.");
      key = match![1]!; offset = Number(match![2]);
      if (offset > cached.page.sessions.length) throw unavailable("The Antigravity discovery cursor is invalid.");
      cached.expires = Date.now() + 120_000;
      if (offset === cached.page.sessions.length) {
        if (!cached.page.cursor) throw unavailable("The Antigravity discovery cursor is invalid.");
        providerCursor = cached.page.cursor; key = undefined; offset = 0;
      }
    }
    if (!key) {
      const page = await this.input.port.listSessions({ cwd, ...(providerCursor ? { cursor: providerCursor } : {}) }, input.signal)
        .catch(error => { throw antigravityReadError(error, input.signal); });
      input.signal.throwIfAborted();
      const bytes = Buffer.byteLength(JSON.stringify(page));
      if (bytes > 8 * 1024 * 1024 || page.sessions.length > 500) throw unavailable("The Antigravity discovery page exceeds its supported bound.");
      for (const [id, entry] of this.#discoveryPages) if (entry.expires <= Date.now()) this.#discoveryPages.delete(id);
      let retainedBytes = [...this.#discoveryPages.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      while (this.#discoveryPages.size >= 32 || retainedBytes + bytes > 8 * 1024 * 1024) {
        const oldest = this.#discoveryPages.entries().next().value!;
        this.#discoveryPages.delete(oldest[0]); retainedBytes -= oldest[1].bytes;
      }
      key = randomUUID(); this.#discoveryPages.set(key, { cwd, page, bytes, expires: Date.now() + 120_000 });
    }
    const page = this.#discoveryPages.get(key)!.page;
    const conversations = [];
    let fallbackReads = 0;
    for (; offset < page.sessions.length; offset++) {
      if (conversations.length >= Math.min(100, input.limit)) break;
      const session = page.sessions[offset]!;
      input.signal.throwIfAborted();
      if (session.cwd !== cwd) continue;
      let date = session.updatedAt;
      if (!date) {
        if (fallbackReads >= 4) break;
        fallbackReads++;
        const history = await this.input.port.readHistory({ sessionId: session.sessionId, cwd: session.cwd }, input.signal).then(requireHistory).catch(error => { throw antigravityReadError(error, input.signal); });
        date = history.native.steps.at(-1)?.completedAt ?? history.native.steps.at(-1)?.createdAt;
      }
      if (!date) continue;
      conversations.push({ backendConversationId: session.sessionId, canonicalWorkspacePath: session.cwd, updatedAt: date,
        ...(session.title ? { title: session.title } : {}), opaqueBindingDetail: serializeAntigravityBinding(this.nativeBinding(session.sessionId, session.cwd)) });
    }
    return { conversations, ...(offset < page.sessions.length || page.cursor ? { nextCursor: `${key}:${offset}` } : {}) };
  }
  async create(input: CreateConversationInput) {
    this.assertScope(input.scope);
    this.input.settings.assertConnection(input.scope, input.applicationThreadId, this.connection);
    if (input.requestedBackendConversationId !== undefined || !input.creationCorrelation) throw unsupported("Antigravity assigns its own session identity.");
    const launch = await this.#launch(input.applicationThreadId, input.workspace.summary.id);
    const identity = await this.input.port.create({ cwd: input.workspace.canonicalPath, operationId: input.applicationOperationId,
      ...launch, ...(input.title ? { title: input.title } : {}) })
      .catch(error => { throw antigravityTransportError(error); });
    return { backendConversationId: identity.sessionId, reconciliationToken: input.creationCorrelation,
      opaqueBindingDetail: serializeAntigravityBinding(this.nativeBinding(identity.sessionId, identity.cwd)) };
  }
  async attach(input: AttachConversationInput) {
    const detail = this.validate(input);
    this.input.settings.assertConnection(input.scope, input.binding.applicationThreadId, this.connection);
    const attachment = await this.input.port.attach({ sessionId: detail.sessionId, cwd: detail.canonicalWorkspacePath,
      ...await this.#launch(input.binding.applicationThreadId, input.workspace.summary.id) }).catch(error => { throw antigravityReadError(error); });
    const handle = new AntigravityHandle(this, input, detail, attachment);
    this.handles.add(handle);
    try {
      if (attachment.createdByOperationId) await this.input.port.acknowledgeCreation({ sessionId: detail.sessionId,
        cwd: detail.canonicalWorkspacePath, operationId: attachment.createdByOperationId });
      await handle.initialize(); return handle;
    }
    catch (error) { await handle.close().catch(() => undefined); throw antigravityReadError(error); }
  }
  async #launch(threadId: string, workspaceId: string) {
    try { return { agentTools: await this.input.agentTools?.prepareLaunch(this.toolSource(threadId, workspaceId)),
      executionEnvironment: await this.environment(threadId) }; }
    catch { throw unavailable("Antigravity could not prepare the thread's scoped tools or execution environment. No session was started."); }
  }
  async openHistory(input: ReadConversationInput): Promise<ConversationHistoryReader> {
    const detail = this.validate(input);
    const projection = await this.input.port.readHistory({ sessionId: detail.sessionId, cwd: detail.canonicalWorkspacePath }, input.signal)
      .then(requireHistory).then(native => projectAntigravityHistory(native.native, { binding: detail, key: this.input.correlationKey }))
      .catch(error => { throw antigravityReadError(error, input.signal); });
    const capabilities: BackendCapabilityDocument = antigravityCapabilities(undefined, this.connection.id);
    let closed = false;
    const check = (signal?: AbortSignal) => { signal?.throwIfAborted(); if (closed) throw unavailable("History reader is closed."); };
    return {
      readSnapshot: async ({ signal }) => { check(signal); const page = antigravityHistoryPage(projection.snapshot, { limit: 50, signal });
        const { previousCursor } = page;
        return { snapshot: backendConversationSnapshotSchema.parse(antigravityWindowSnapshot(projection.snapshot, page)),
          history: { operational: true, ...(previousCursor ? { previousCursor } : {}) } }; },
      history: async request => { check(request.signal); return antigravityHistoryPage(projection.snapshot, request); },
      locateTurn: async request => { check(request.signal); return locateAntigravityTurn(projection.snapshot, request); },
      backendCapabilities: async () => { check(); return capabilities; }, usage: async () => { check(); return projection.usage; },
      close: async () => { closed = true; },
    };
  }
  async resolveBranchCheckpoint(): Promise<never> { throw unsupported("Antigravity conversation branching is unsupported."); }
  async branchConversation(): Promise<never> { throw unsupported("Antigravity conversation branching is unsupported."); }
  async reconcileSubmission(input: ReconcileSubmissionInput): Promise<SubmissionReconciliation> {
    this.assertScope(input.scope);
    if (!input.binding || !input.opaqueBindingDetail) return { status: "unresolved", diagnostic: boundDisplayText("The native session identity is not yet known.") };
    const detail = this.validate({ ...input, binding: input.binding, opaqueBindingDetail: input.opaqueBindingDetail });
    let history = await this.input.port.readHistory({ sessionId: detail.sessionId, cwd: detail.canonicalWorkspacePath }).then(requireHistory)
      .catch(error => { throw antigravityReadError(error); });
    const scope = { binding: detail, key: this.input.correlationKey };
    const findInput = () => history.native.steps.find(value => {
      if (!value.user) return false;
      const marker = inspectAntigravityInput(scope, value.user.text);
      return marker.operationId === input.applicationOperationId && (!input.reconciliationToken ||
        marker.reconciliation === antigravityReconciliationTag(scope, input.applicationOperationId, input.reconciliationToken));
    });
    const accepted = (): SubmissionReconciliation | undefined => {
      const step = findInput();
      if (!step || inspectAntigravityInput(scope, step.user!.text).delivery === "steer" && !antigravitySteerConsumed(history.native, step.index)) return undefined;
      const projection = projectAntigravityHistory(history.native, scope);
      return { status: "accepted", backendTurn: Object.values(projection.snapshot.turnsById).find(turn =>
        turn.completionCorrelations?.includes(input.applicationOperationId)), completionIdentity: input.applicationOperationId };
    };
    const observed = accepted(); if (observed) return observed;
    try {
      const retained = await this.input.port.attachExisting({ sessionId: detail.sessionId, cwd: detail.canonicalWorkspacePath });
      if (retained) {
        const receipt = await this.input.port.outcome({ handleId: retained.handleId, operationId: input.applicationOperationId });
        if (receipt.status === "completed" && receipt.cancelledAtNativeRevision && (receipt.result as { stopReason?: string })?.stopReason === "cancelled") {
          // A prompt callback alone can precede the native write or describe a
          // different queued request. Require host drain proof, then reread the
          // durable transcript; consumption always wins over cancellation.
          history = await this.input.port.readHistory({ sessionId: detail.sessionId, cwd: detail.canonicalWorkspacePath }).then(requireHistory);
          const consumed = accepted(); if (consumed) return consumed;
          await this.input.port.acknowledgeOperation({ handleId: retained.handleId, operationId: input.applicationOperationId });
          return { status: "not_accepted", retryable: false, diagnostic: boundDisplayText("Antigravity withdrew this input when the execution was cancelled.") };
        }
        if (receipt.status === "failed" && receipt.failure.delivery !== "sent_outcome_unknown") {
          await this.input.port.acknowledgeOperation({ handleId: retained.handleId, operationId: input.applicationOperationId });
          return { status: "not_accepted", retryable: receipt.failure.delivery === "not_sent" };
        }
      }
    } catch { /* Lost authority is uncertainty, never permission to resend. */ }
    return { status: "unresolved", diagnostic: boundDisplayText("Antigravity has not yet provided exact durable acceptance evidence. The message has not been resent.") };
  }
  async releaseConversationResidency(input: ReleaseConversationResidencyInput) {
    const detail = this.validate(input);
    const retained = await this.input.port.attachExisting({ sessionId: detail.sessionId, cwd: detail.canonicalWorkspacePath });
    if (retained) await this.acknowledgeAbandonedOperations(input.binding.applicationThreadId, retained.handleId, retained.retainedOperationIds);
    const result = await this.input.port.retireSession({ sessionId: detail.sessionId, cwd: detail.canonicalWorkspacePath });
    return result === "absent" || result === "retired" ? "released" as const : result;
  }
  async acknowledgeAbandonedOperations(threadId: string, handleId: string, operationIds: Iterable<string>, signal?: AbortSignal): Promise<{ acknowledged: string[]; pending: string[] }> {
    const acknowledged: string[] = [], pending: string[] = [];
    for (const operationId of operationIds) {
      if (!this.input.isOperationAbandoned?.(threadId, operationId)) continue;
      let outcome;
      try { outcome = await this.input.port.outcome({ handleId, operationId }, signal); }
      catch (error) {
        if (error instanceof AntigravityError && error.code === "antigravity_operation_unknown") {
          acknowledged.push(operationId); continue;
        }
        throw error;
      }
      // Force Reset abandons application recovery, never ongoing native work.
      // A pending callback still owns its provider receipt until it settles.
      if (outcome.status === "pending") { pending.push(operationId); continue; }
      await this.input.port.acknowledgeOperation({ handleId, operationId }, signal);
      acknowledged.push(operationId);
    }
    return { acknowledged, pending };
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#discoveryPages.clear();
    const results = await Promise.allSettled([...this.handles].map(handle => handle.close()));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Antigravity handles could not all be released.");
  }
}
function requireHistory(history: AntigravityHistory | null): AntigravityHistory {
  if (history === null) throw new Error("antigravity_unconditional_history_missing");
  return history;
}
export function unsupported(message: string): BackendError {
  return new BackendError({ category: "invalid_state", retryable: false, crossedSubmissionBoundary: false, safeMessage: message });
}
export function unavailable(message: string): BackendError {
  return new BackendError({ category: "unavailable", retryable: true, crossedSubmissionBoundary: false, safeMessage: message });
}
