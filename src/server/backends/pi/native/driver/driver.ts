import type { PiSessionReservation } from "../../pi-session-claims.js";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BackendError, type AgentBackendInstance, type AgentConnectionProfile, type AttachConversationInput,
  type BackendActionResult, type BackendCatalog, type BackendCatalogContext,
  type BackendCheckpointRef, type BackendHealth, type BackendHistoryPage, type BackendMutationReconciliation,
  type BranchConversationInput, type ConversationBackendDriver, type ConversationBinding, type ConversationHandle,
  type ConversationHistoryReader, type CreateConversationInput, type CreateConversationResult, type DiscoverConversationsInput,
  type DiscoveredConversationPage, type EstablishedBackendProjection, type EstablishProjectionInput, type HistoryPageInput,
  type InteractionResponseInput, type InterruptConversationInput, type LocateTurnInput, type LocateTurnResult,
  type ReadConversationInput, type ReconcileSubmissionInput, type RegisteredBackendActionInput, type ReleaseConversationResidencyInput, type ResolveBranchCheckpointInput,
  type SteerTurnInput, type SteerTurnResult, type SubmissionReconciliation, type SubmitTurnInput, type SubmitTurnResult,
  type Unsubscribe } from "../../../contracts.js";
import { BackendAgentToolRequestError, type BackendAgentToolAccessDecisionAuthority } from "../../../../agent-tools/adapters/backend-facade.js";
import type { ExecutionScope } from "../../../../execution/contracts.js";
import type { CompiledBackendModelPolicy } from "../../../model-policy.js";
import type { ThreadEnvironmentResolver } from "../../../../environment-variables/runtime-environment.js";
import { backendConversationEventSchema, type BackendConversationEvent, type BackendEffectiveSettings, type BackendCapabilityDocument,
  type BackendItem, type DriverInteraction } from "../../../../../shared/protocol/backend.js";
import type { RuntimeNotice, UsageSnapshot } from "../../../../../shared/protocol/conversation.js";
import type { PiNativeAttachment, PiNativeForkInput, PiNativeHistory, PiNativePort, PiNativeSessionIdentity } from "../port.js";
import { piNativeThinkingLevelSchema } from "../../../../../shared/protocol/pi-configuration.js";
import { PiProjectionEstablisher } from "../../pi-projection-establisher.js";
import { PiCatalogService } from "../../pi-catalog-service.js";
import { ConversationInterruptLedger } from "../../../conversation-interrupt.js";
import { boundDisplayText, boundText, preserveMessageText } from "../../../../conversations/payload-policy.js";
import { companion, forgetNativeObservations, nativeFailure, nativeUnknownFailure, rpc } from "./port-session.js";
import { historyPage, locateHistory, object, projectNativeHistory, projectionWindow, string,
  nativeBranch, publishNativeHistoryArtifacts, type NativeHistoryProjection, type NativeInputEvidence } from "./history.js";
import { normalizedAbsolutePath } from "../../../../../shared/absolute-path.js";
import { piManagedOperationSchema, piManagedStateSchema, type PiManagedOperation, type PiManagedState } from "../rpc/pi-managed-protocol.js";
import { formatPiContextExcerptPrompt } from "../../pi-context-excerpt-message.js";
import { formatPiTaskContextPrompt } from "../../pi-task-context-message.js";
import type { UsageSink } from "../../../../usage/contracts.js";
import type { OutputArtifactPublisher } from "../../../../output-artifacts/contracts.js";
import { PiNativeUsageAccounting } from "./usage.js";
import { piNativeContextUsage } from "./context-usage.js";
import { PiNativeEventCheckpoint } from "./event-checkpoint.js";
import { TurnThroughputRecorder } from "../../../turn-throughput.js";
import type { PiNativeAgentToolBridge, PiNativeAgentToolService } from "../agent-tools.js";
import { PiNativeError } from "../port.js";
import { piManagedEventSchema } from "../rpc/pi-managed-protocol.js";
import { piNativeOutcomeSchema } from "../sidecar/wire.js";
import { parsePiRpcState } from "../rpc/pi-rpc-wire.js";

export interface PiNativeSettings {
  readonly modelProvider: string | null;
  readonly modelId: string | null;
  readonly thinkingLevel: string | null;
  readonly toolMode: "read_only" | "ask" | "full";
  readonly revision: number;
}
export interface PiNativeDriverSettings {
  getSettings(scope: ExecutionScope, threadId: string): PiNativeSettings;
  syncObserved?(scope: ExecutionScope, threadId: string, settings: BackendEffectiveSettings): void;
}
export interface PiNativeDriverOptions {
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly port: PiNativePort;
  readonly settings: PiNativeDriverSettings;
  readonly modelPolicy: CompiledBackendModelPolicy;
  readonly operations: PiNativeOperations;
  readonly claimNativeSession?: (scope: ExecutionScope, input: PiSessionReservation) => void;
  readonly usage: UsageSink;
  readonly outputArtifacts?: OutputArtifactPublisher;
  readonly agentTools?: PiNativeAgentToolService;
  readonly resolveThreadEnvironment?: ThreadEnvironmentResolver;
  readonly now?: () => string;
}
interface PiNativeOperationRecord { readonly requestHash: string; readonly state: "prepared" | "sent" | "completed" | "unknown"; readonly prepareAttempt: number; readonly dispatchStarted: boolean; readonly receiptJson: string | null }
type NativeMutationPhase = "preflight" | "dispatched" | "not_applied";
interface NativeMutationBoundary { phase: NativeMutationPhase }
export interface PiNativeOperations {
  prepareOperation(scope: ExecutionScope, threadId: string, input: { operationId: string; kind: "submission" | "action" | "interrupt"; requestHash: string }): PiNativeOperationRecord;
  getOperation(scope: ExecutionScope, threadId: string, operationId: string): PiNativeOperationRecord | undefined;
  completeOperation(scope: ExecutionScope, threadId: string, operationId: string, input: { state: PiNativeOperationRecord["state"]; receiptJson?: string }): PiNativeOperationRecord;
  markSubmissionDispatched(scope: ExecutionScope, threadId: string, operationId: string, requestHash: string, prepareAttempt: number): PiNativeOperationRecord;
  resetUnsentOperation(scope: ExecutionScope, threadId: string, operationId: string, requestHash: string, prepareAttempt: number): PiNativeOperationRecord;
}
function reject(code: string, text = "The Pi operation is not available.", crossed = false): BackendError {
  return new BackendError({ category: crossed ? "submission_unknown" : "rejected", retryable: false,
    crossedSubmissionBoundary: crossed, safeMessage: text, backendCode: code });
}
function submissionRecoveryBusy(): BackendError {
  return new BackendError({ category: "unavailable", retryable: true, crossedSubmissionBoundary: false,
    safeMessage: "Pi is attaching or recovering this conversation. Retry when it finishes.", backendCode: "pi_native_submission_recovery_busy" });
}
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function nativeOperationBase(operationId: string): string {
  return operationId.replace(/:(?:prepare:\d+|dispatch|complete|begin|clear|abort|end|policy|tools)$/, "");
}
function preparationAttempt(operationId: string, submissionId: string): number | undefined {
  const prefix = `${submissionId}:prepare:`;
  if (!operationId.startsWith(prefix)) return undefined;
  const suffix = operationId.slice(prefix.length);
  return /^(0|[1-9]\d*)$/.test(suffix) && Number.isSafeInteger(Number(suffix)) ? Number(suffix) : undefined;
}
// These companion errors occur before a new input intent can be persisted.
// operation_exists and unexpected errors cannot disprove earlier consumption.
const preparationRejectionCodes = new Set([
  "pi_managed_not_ready", "pi_managed_policy_missing", "pi_managed_model_denied", "pi_managed_admission_closed",
]);
async function nativeCall<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (cause) { if (cause instanceof PiNativeError) throw nativeFailure(cause); throw cause; }
}
export function serializePiNativeBindingDetail(value: PiNativeSessionIdentity): string {
  return JSON.stringify({ version: 1, sessionId: value.sessionId, sessionFile: value.sessionFile, cwd: value.cwd });
}
export function parsePiNativeBindingDetail(detail: string): PiNativeSessionIdentity {
  let parsed: Record<string, unknown>;
  try { parsed = object(JSON.parse(detail)); } catch { throw reject("pi_native_binding_invalid"); }
  if (Object.keys(parsed).sort().join() !== "cwd,sessionFile,sessionId,version" || parsed.version !== 1 ||
      typeof parsed.sessionId !== "string" || !parsed.sessionId || parsed.sessionId.length > 512 ||
      typeof parsed.cwd !== "string" || !normalizedAbsolutePath(parsed.cwd) ||
      typeof parsed.sessionFile !== "string" || !normalizedAbsolutePath(parsed.sessionFile))
    throw reject("pi_native_binding_invalid");
  return { sessionId: parsed.sessionId, cwd: parsed.cwd, sessionFile: parsed.sessionFile };
}
function creationResult(native: PiNativeSessionIdentity, operationId: string): CreateConversationResult {
  return { backendConversationId: native.sessionId, opaqueBindingDetail: serializePiNativeBindingDetail(native), reconciliationToken: operationId };
}
function unavailableControl(cause: unknown): boolean {
  const code = cause instanceof PiNativeError ? cause.code : cause instanceof BackendError ? cause.backendCode : undefined;
  return code !== undefined && ["pi_native_observation_control_unavailable", "pi_native_observation_control_changed", "pi_native_session_ended",
    "pi_native_session_unknown", "pi_native_cleanup_unproven"].includes(code);
}

export class PiNativeConversationDriver implements ConversationBackendDriver {
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly #handles = new Map<string, PiNativeConversationHandle>();
  readonly #attaching = new Set<string>();
  readonly #submissionRecovery = new Set<string>();
  readonly #releasePending = new Map<string, PiNativeAttachment>();
  readonly #recoveryNotices = new Map<string, RuntimeNotice>();
  readonly #controlRecovery = new Map<string, { evidence: string; requested: boolean; retryAt: number }>();
  readonly #catalogs: PiCatalogService;
  readonly #catalogContexts = new Map<string, { readonly identity: string; readonly workspaceId: string;
    readonly workspaceRevision: number; readonly authorityRevision: number }>();
  #closing?: Promise<void>;
  #closed = false;
  constructor(readonly options: PiNativeDriverOptions) {
    this.instance = options.instance; this.connection = options.connection;
    if (this.instance.kind !== "pi_native" || this.connection.kind !== "pi_rpc" ||
        this.instance.id !== this.connection.backendInstanceId || this.instance.tenantId !== this.connection.tenantId)
      throw reject("pi_native_configuration_mismatch");
    this.#catalogs = new PiCatalogService({ owner: { tenantId: this.instance.tenantId,
      ownerPrincipalId: this.connection.ownerPrincipalId, backendInstanceId: this.instance.id,
      backendConfigurationRevision: this.instance.configurationRevision, connectionProfileId: this.connection.id,
      connectionConfigurationRevision: this.connection.configurationRevision } });
  }
  assertScope(scope: ExecutionScope, environmentId?: string): void {
    if (this.#closed || scope.tenantId !== this.instance.tenantId || scope.principalId !== this.connection.ownerPrincipalId ||
        (environmentId !== undefined && environmentId !== this.connection.executionEnvironmentId))
      throw new BackendError({ category: "permission_denied", retryable: false, crossedSubmissionBoundary: false,
        safeMessage: "The Pi execution target does not belong to this request.", backendCode: "pi_native_scope_mismatch" });
  }
  assertBinding(input: ReadConversationInput): PiNativeSessionIdentity {
    this.assertScope(input.scope, input.workspace.summary.environmentId);
    const binding = input.binding;
    if (binding.tenantId !== this.instance.tenantId || binding.ownerPrincipalId !== this.connection.ownerPrincipalId ||
        binding.backendInstanceId !== this.instance.id || binding.connectionProfileId !== this.connection.id ||
        binding.executionEnvironmentId !== this.connection.executionEnvironmentId) throw reject("pi_native_binding_scope_mismatch");
    const native = parsePiNativeBindingDetail(input.opaqueBindingDetail);
    if (native.sessionId !== binding.backendConversationId || native.cwd !== input.workspace.canonicalPath) throw reject("pi_native_binding_identity_mismatch");
    return native;
  }
  async health(): Promise<BackendHealth> {
    if (this.#closed || !this.instance.enabled || !this.connection.enabled) return { available: false, checkedAt: new Date().toISOString() };
    try { await this.options.port.inspect(); return { available: true, checkedAt: new Date().toISOString() }; }
    catch { return { available: false, checkedAt: new Date().toISOString(), diagnostic: { text: "The native Pi execution host is unavailable." } }; }
  }
  async catalog(context: BackendCatalogContext): Promise<BackendCatalog> {
    this.assertScope(context.scope, context.workspace.summary.environmentId);
    const workspace = context.workspace;
    const identity = fingerprint([workspace.summary.id, workspace.summary.environmentId, workspace.summary.revision,
      workspace.summary.trustState, workspace.authorityRevision]);
    const previous = this.#catalogContexts.get(workspace.canonicalPath);
    const stale = () => new BackendError({ category: "unavailable", retryable: true, crossedSubmissionBoundary: false,
      safeMessage: "The Pi workspace catalog changed while loading. Retry the read.", backendCode: "pi_native_catalog_context_changed" });
    if (previous?.workspaceId === workspace.summary.id &&
      (previous.workspaceRevision > workspace.summary.revision || previous.authorityRevision > workspace.authorityRevision)) throw stale();
    const owner = previous?.identity === identity ? previous : { identity, workspaceId: workspace.summary.id,
      workspaceRevision: workspace.summary.revision, authorityRevision: workspace.authorityRevision };
    if (previous && previous !== owner) this.#catalogs.invalidate(workspace);
    this.#catalogContexts.set(workspace.canonicalPath, owner);
    const assertCurrent = () => {
      this.assertScope(context.scope, workspace.summary.environmentId);
      if (this.#catalogContexts.get(workspace.canonicalPath) !== owner) throw stale();
    };
    const catalog = await this.#catalogs.read(workspace, async () => {
      const loaded = await nativeCall(() => this.options.port.catalog({ cwd: workspace.canonicalPath }));
      assertCurrent();
      return nativeCatalog(loaded, this.options.modelPolicy);
    }, { refresh: context.purpose === "skill_picker" });
    assertCurrent();
    return catalog;
  }
  async discover(input: DiscoverConversationsInput): Promise<DiscoveredConversationPage> {
    this.assertScope(input.scope, input.workspace.summary.environmentId); input.signal.throwIfAborted();
    const page = await nativeCall(() => this.options.port.listSessions({ cwd: input.workspace.canonicalPath, limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}) }, input.signal));
    input.signal.throwIfAborted();
    return { conversations: page.sessions.map(session => ({ backendConversationId: session.sessionId,
      canonicalWorkspacePath: session.cwd, updatedAt: session.updatedAt, opaqueBindingDetail: serializePiNativeBindingDetail(session),
      ...(session.title ? { title: session.title } : {}) })), ...(page.cursor ? { nextCursor: page.cursor } : {}) };
  }
  async create(input: CreateConversationInput): Promise<CreateConversationResult> {
    this.assertScope(input.scope, input.workspace.summary.environmentId);
    if (!input.requestedBackendConversationId) throw reject("pi_native_reserved_identity_required");
    if (this.options.claimNativeSession) this.options.claimNativeSession(input.scope, {
      applicationThreadId: input.applicationThreadId, applicationOperationId: input.applicationOperationId,
      sessionId: input.requestedBackendConversationId,
      sessionDirectory: await nativeCall(() => this.options.port.resolveSessionDirectory({ cwd: input.workspace.canonicalPath })),
    });
    const native = await nativeCall(() => this.options.port.create({ cwd: input.workspace.canonicalPath, sessionId: input.requestedBackendConversationId!,
      operationId: input.applicationOperationId, ...(input.title ? { title: input.title } : {}) }));
    return creationResult(native, input.applicationOperationId);
  }
  async attach(input: AttachConversationInput): Promise<ConversationHandle> {
    const native = this.assertBinding(input);
    if (this.#submissionRecovery.has(native.sessionId)) throw submissionRecoveryBusy();
    return this.#attachSession(input);
  }
  async #attachSession(input: AttachConversationInput): Promise<PiNativeConversationHandle> {
    try { return await this.#attach(input); }
    catch (cause) {
      if (cause instanceof PiNativeError && ["pi_native_session_ended", "pi_native_session_configuration_conflict", "pi_native_observation_continuity_lost"].includes(cause.code)) {
        const observationGap = cause.code === "pi_native_observation_continuity_lost";
        let retired: Awaited<ReturnType<PiNativeConversationDriver["releaseConversationResidency"]>>;
        try { retired = await this.releaseConversationResidency(input); }
        catch (recovery) {
          if (observationGap && recovery instanceof BackendError && recovery.backendCode === "pi_native_observation_recovery_busy")
            return this.#attachControl(input);
          throw recovery;
        }
        if (observationGap && retired === "busy") return this.#attachControl(input);
        if (retired !== "released") throw new BackendError({ category: "unavailable", retryable: true, crossedSubmissionBoundary: false,
          safeMessage: "Pi still has active work or retained output from its previous session configuration.", backendCode: cause.code });
        return nativeCall(() => this.#attach(input));
      }
      if (cause instanceof PiNativeError) throw nativeFailure(cause);
      throw cause;
    }
  }
  async #attachControl(input: AttachConversationInput): Promise<PiNativeConversationHandle> {
    try { return await nativeCall(() => this.#attach(input, true)); }
    catch (cause) {
      if (!unavailableControl(cause)) throw cause;
      // The process can exit between the busy drain and control attachment.
      // Retry recovery once; a cleanup failure must surface, never spin.
      if (await this.releaseConversationResidency(input) !== "released") throw cause;
      return nativeCall(() => this.#attach(input));
    }
  }
  requestControlRecovery(attachment: PiNativeAttachment, evidence: unknown, ready: boolean): boolean {
    const key = fingerprint([attachment.generation, evidence]);
    const previous = this.#controlRecovery.get(attachment.sessionId);
    const current = previous?.evidence === key ? previous : { evidence: key, requested: false, retryAt: 0 };
    this.#controlRecovery.set(attachment.sessionId, current);
    if (!ready || (current.requested && Date.now() < current.retryAt)) return false;
    current.requested = true;
    // Host-held obligations can settle without changing the native transcript.
    // Recheck those eventually, but never churn attachments on every poll.
    current.retryAt = Date.now() + 30_000;
    return true;
  }
  async #attach(input: AttachConversationInput, controlOnly = false): Promise<PiNativeConversationHandle> {
    const native = this.assertBinding(input);
    if (this.#handles.has(native.sessionId) || this.#attaching.has(native.sessionId) || this.#releasePending.has(native.sessionId)) throw reject("pi_native_already_attached");
    this.#attaching.add(native.sessionId);
    let attachment: PiNativeAttachment | undefined;
    let handle: PiNativeConversationHandle | undefined;
    try {
      if (controlOnly) {
        attachment = await this.options.port.attachForControl(native) ?? undefined;
        if (!attachment) throw new PiNativeError("pi_native_observation_control_unavailable");
      } else {
        const environment = await this.options.resolveThreadEnvironment?.(input.binding.applicationThreadId);
        const launch = await this.options.agentTools?.prepareLaunch(input);
        const executionEnvironment = Object.fromEntries(Object.entries(environment ?? {})
          .map(([name, value]) => [name, value === null ? { kind: "unset" as const } : { kind: "literal" as const, value }]));
        attachment = await this.options.port.attach({ ...native, executionEnvironment,
          ...(launch ? { agentToolEnvironment: launch.environment } : {}) });
        this.#controlRecovery.delete(native.sessionId);
      }
      handle = new PiNativeConversationHandle(this, input, attachment, released => { if (released) this.#handles.delete(native.sessionId); }, controlOnly);
      input.onControlReady?.(handle.control);
      await handle.initialize();
      const recoveryNotice = this.#recoveryNotices.get(native.sessionId);
      if (recoveryNotice && !controlOnly) handle.setRecoveryNotice(recoveryNotice, () => {
        if (this.#recoveryNotices.get(native.sessionId) === recoveryNotice) this.#recoveryNotices.delete(native.sessionId);
      });
      this.#handles.set(native.sessionId, handle);
      return handle;
    } catch (cause) {
      try {
        if (handle) await handle.close();
        else if (attachment) await this.options.port.release({ handleId: attachment.handleId });
      } catch (cleanup) {
        if (handle) this.#handles.set(native.sessionId, handle);
        else if (attachment) this.#releasePending.set(native.sessionId, attachment);
        throw new AggregateError([cause, cleanup], "Pi attach failed and native release is unconfirmed.");
      }
      throw cause;
    } finally { this.#attaching.delete(native.sessionId); }
  }
  async openHistory(input: ReadConversationInput): Promise<ConversationHistoryReader> {
    const native = this.assertBinding(input);
    input.signal?.throwIfAborted();
    const history = await nativeCall(() => this.options.port.readHistory(native, input.signal));
    const images = await publishNativeHistoryArtifacts(history, input.binding, this.options.outputArtifacts);
    input.signal?.throwIfAborted();
    const accounting = this.options.usage.enabled ? new PiNativeUsageAccounting(this.options.usage, input.binding,
      `pi-native:${input.binding.backendInstanceId}:${input.binding.executionEnvironmentId}`, history) : undefined;
    return new PiNativeHistoryReader(history, this.options.settings.getSettings(input.scope, input.binding.applicationThreadId), accounting, images, Boolean(this.options.outputArtifacts));
  }
  async resolveBranchCheckpoint(input: ResolveBranchCheckpointInput): Promise<BackendCheckpointRef> {
    const native = this.assertBinding(input);
    if (input.selection.kind === "latest_provider_snapshot") throw reject("pi_native_active_snapshot_fork_unsupported");
    const history = await nativeCall(() => this.options.port.readHistory(native));
    const projected = projectNativeHistory(history);
    const selected = input.selection.backendTurnId;
    if (projected.snapshot.turnsById[selected]?.status !== "completed") throw reject("pi_native_fork_turn_incomplete");
    if (input.selection.kind === "latest_completed" && projected.snapshot.orderedBackendTurnIds.findLast(id => projected.snapshot.turnsById[id]?.status === "completed") !== selected)
      throw reject("pi_native_fork_turn_changed");
    const leaf = projected.leafByTurn.get(selected);
    if (!leaf) throw reject("pi_native_fork_checkpoint_missing");
    return { backendInstanceId: this.instance.id, kind: "conversation_leaf", opaqueReference: JSON.stringify({ version: 1,
      sessionId: native.sessionId, sessionFile: native.sessionFile, cwd: native.cwd, turnId: selected, entryId: leaf }) };
  }
  async branchConversation(input: BranchConversationInput): Promise<CreateConversationResult> {
    const native = this.assertBinding({ ...input, binding: input.sourceBinding, opaqueBindingDetail: input.sourceOpaqueBindingDetail });
    if (input.sourceCheckpoint.backendInstanceId !== this.instance.id || input.sourceCheckpoint.kind !== "conversation_leaf" || !input.requestedBackendConversationId)
      throw reject("pi_native_fork_checkpoint_invalid");
    let checkpoint: Record<string, unknown>;
    try { checkpoint = object(JSON.parse(input.sourceCheckpoint.opaqueReference)); } catch { throw reject("pi_native_fork_checkpoint_invalid"); }
    if (checkpoint.version !== 1 || checkpoint.sessionId !== native.sessionId || checkpoint.cwd !== native.cwd ||
      checkpoint.sessionFile !== native.sessionFile || typeof checkpoint.entryId !== "string" || typeof checkpoint.turnId !== "string") throw reject("pi_native_fork_checkpoint_invalid");
    const settings = input.inheritedSettings;
    const thinking = piNativeThinkingLevelSchema.optional().safeParse(settings?.thinkingLevel);
    if (!settings || !["read_only", "ask", "full"].includes(settings.toolAccess ?? "") || !thinking.success ||
      (settings.model && (!settings.model.provider || !settings.model.id))) throw reject("pi_native_fork_settings_invalid");
    const request: PiNativeForkInput = { cwd: native.cwd, sourceSessionId: native.sessionId, sourceSessionFile: native.sessionFile,
      sourceEntryId: checkpoint.entryId, childSessionId: input.requestedBackendConversationId, operationId: input.applicationOperationId,
      inheritedSettings: { ...(settings.model ? { model: settings.model } : {}),
        ...(thinking.data ? { thinkingLevel: thinking.data } : {}), toolAccess: settings.toolAccess! },
      ...(input.title ? { title: input.title } : {}) };
    // Exact historical success survives later source removal or policy tightening.
    const existing = await nativeCall(() => this.options.port.reconcileFork(request));
    if (existing) return creationResult(existing, input.applicationOperationId);
    if (settings.model ? !this.options.modelPolicy.isSelectionAllowed({ providerId: settings.model.provider,
      modelId: settings.model.id, reasoningEffort: settings.thinkingLevel }) : this.options.modelPolicy.policy.type !== "catalog")
      throw reject("pi_native_model_policy_denied");
    const projection = projectNativeHistory(await nativeCall(() => this.options.port.readHistory(native)));
    if (projection.snapshot.turnsById[checkpoint.turnId]?.status !== "completed" || projection.leafByTurn.get(checkpoint.turnId) !== checkpoint.entryId)
      throw reject("pi_native_fork_checkpoint_changed");
    if (this.options.claimNativeSession) this.options.claimNativeSession(input.scope, {
      applicationThreadId: input.childApplicationThreadId, applicationOperationId: input.applicationOperationId,
      sessionId: input.requestedBackendConversationId,
      sessionDirectory: await nativeCall(() => this.options.port.resolveSessionDirectory({ cwd: native.cwd })),
    });
    const child = await nativeCall(() => this.options.port.fork(request));
    return creationResult(child, input.applicationOperationId);
  }
  async releaseConversationResidency(input: ReleaseConversationResidencyInput): Promise<"released" | "busy" | "undelivered"> {
    const native = this.assertBinding(input);
    if (this.#handles.has(native.sessionId) || this.#attaching.has(native.sessionId) || this.#releasePending.has(native.sessionId)) return "busy";
    let outcome = await nativeCall(() => this.options.port.retireSession(native));
    if (outcome === "undelivered") {
      // Apply and acknowledge retained native output before retrying retirement.
      // Failed drain or cleanup leaves admission closed and must remain observable.
      await this.#drain(input);
      outcome = await nativeCall(() => this.options.port.retireSession(native));
    }
    return outcome === "retired" || outcome === "absent" ? "released" : outcome;
  }
  async #drain(input: ReleaseConversationResidencyInput): Promise<void> {
    const native = this.assertBinding(input);
    if (this.#handles.has(native.sessionId) || this.#attaching.has(native.sessionId) || this.#releasePending.has(native.sessionId)) throw reject("pi_native_already_attached");
    this.#attaching.add(native.sessionId);
    try {
      const attachment = await nativeCall(() => this.options.port.attachForDrain(native));
      if (!attachment) return;
      let handle: PiNativeConversationHandle;
      try {
        handle = new PiNativeConversationHandle(this, input, attachment, released => { if (released) this.#handles.delete(native.sessionId); });
      } catch (cause) {
        try { await nativeCall(() => this.options.port.release({ handleId: attachment.handleId })); }
        catch (cleanup) { this.#releasePending.set(native.sessionId, attachment); throw new AggregateError([cause, cleanup], "Pi drain attachment release is unconfirmed."); }
        throw cause;
      }
      this.#handles.set(native.sessionId, handle);
      try {
        await handle.initialize(true, attachment.closed);
        if (attachment.observationGap) {
          // Keep the warning until a public subscriber receives it, including
          // when the gap acknowledgement succeeds but its reply is lost.
          this.#recoveryNotices.set(native.sessionId, { id: `pi-native-gap:${fingerprint(attachment.generation)}`, tone: "warning",
            message: { text: "Pi's live output exceeded its retention limit. The session was recovered from saved history; some transient output may be missing." },
            createdAt: this.options.now?.() ?? new Date().toISOString() });
          await nativeCall(() => this.options.port.acknowledgeObservationGap({ handleId: attachment.handleId,
            generation: attachment.generation, throughSequence: attachment.throughSequence }));
        }
      }
      catch (cause) {
        try { await nativeCall(() => handle.close()); }
        catch (cleanup) { throw new AggregateError([cause, cleanup], "Pi drain failed and native release is unconfirmed."); }
        throw cause;
      }
      await nativeCall(() => handle.close());
    } finally { this.#attaching.delete(native.sessionId); }
  }
  async reconcileSubmission(input: ReconcileSubmissionInput): Promise<SubmissionReconciliation> {
    this.assertScope(input.scope, input.workspace.summary.environmentId);
    if (!input.binding || !input.opaqueBindingDetail) return { status: "unresolved", diagnostic: { text: "Pi has no established native session for this operation." } };
    const native = this.assertBinding({ ...input, binding: input.binding, opaqueBindingDetail: input.opaqueBindingDetail });
    const record = this.options.operations.getOperation(input.scope, input.binding.applicationThreadId, input.applicationOperationId);
    if (!record || record.state === "prepared") return { status: "not_accepted", retryable: true };
    if (record.state === "completed" && record.receiptJson && object(JSON.parse(record.receiptJson)).outcome === "not_applied")
      return { status: "not_accepted", retryable: false };
    if (record.state === "completed" && record.receiptJson) {
      const saved = matchingSubmission(JSON.parse(record.receiptJson), input.applicationOperationId, input.reconciliationToken);
      if (saved) return submissionReconciliation(saved, input.applicationOperationId);
    }
    if (this.#submissionRecovery.has(native.sessionId)) throw submissionRecoveryBusy();
    const existing = this.#handles.get(native.sessionId);
    if (existing) return existing.reconcileSubmission(input.applicationOperationId, input.reconciliationToken);
    const evidence = (await nativeCall(() => this.options.port.readHistory(native))).operations.find(operation => operation.input.operationId === input.applicationOperationId);
    const matched = matchingSubmission(evidence, input.applicationOperationId, input.reconciliationToken);
    if (!record.dispatchStarted && matched?.phase === "intent") {
      // A client may have attached while history was loading. Reuse that
      // handle without taking ownership of its lifetime.
      if (this.#submissionRecovery.has(native.sessionId)) throw submissionRecoveryBusy();
      const attached = this.#handles.get(native.sessionId);
      if (attached) return attached.reconcileSubmission(input.applicationOperationId, input.reconciliationToken);
      if (this.#attaching.has(native.sessionId)) throw submissionRecoveryBusy();
      this.#submissionRecovery.add(native.sessionId);
      try {
        const recovery = await this.#attachSession({ ...input, binding: input.binding, opaqueBindingDetail: input.opaqueBindingDetail });
        try { return await recovery.reconcileSubmission(input.applicationOperationId, input.reconciliationToken); }
        finally { await recovery.close(); }
      } finally { this.#submissionRecovery.delete(native.sessionId); }
    }
    if (matched && ["accepted", "lost", "rejected"].includes(matched.phase))
      this.options.operations.completeOperation(input.scope, input.binding.applicationThreadId, input.applicationOperationId,
        { state: "completed", receiptJson: JSON.stringify(matched) });
    return submissionReconciliation(matched ?? {}, input.applicationOperationId);
  }
  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const operation = (async () => {
      const results = await Promise.allSettled([
        ...[...this.#handles.values()].map(handle => handle.close()),
        ...[...this.#releasePending].map(async ([id, attachment]) => {
          await this.options.port.release({ handleId: attachment.handleId }); this.#releasePending.delete(id);
        }),
      ]);
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Pi native attachments could not all be released.");
    })();
    this.#closing = operation;
    try { await operation; } finally { if (this.#closing === operation) this.#closing = undefined; }
  }
}

function nativeCatalog(value: unknown, policy: CompiledBackendModelPolicy): BackendCatalog {
  const catalog = object(value);
  const models = (Array.isArray(catalog.models) ? catalog.models : []).flatMap(candidate => {
    const model = object(candidate);
    if (typeof model.provider !== "string" || typeof model.id !== "string") return [];
    const mapping = object(model.thinkingLevelMap);
    const allEfforts = model.reasoning === true
      ? ["off", "minimal", "low", "medium", "high", ...(mapping.xhigh !== undefined && mapping.xhigh !== null ? ["xhigh"] : []), ...(mapping.max !== undefined && mapping.max !== null ? ["max"] : [])]
        .filter(level => mapping[level] !== null) : ["off"];
    const efforts = policy.filterReasoningEfforts({ providerId: model.provider, modelId: model.id }, allEfforts);
    if (!efforts.length) return [];
    return [{ provider: model.provider, id: model.id, label: typeof model.name === "string" ? model.name : model.id,
      inputModalities: (Array.isArray(model.input) && model.input.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      supportedReasoningEfforts: efforts }];
  });
  const commands: BackendCatalog["commands"][number][] = [];
  const skills: BackendCatalog["skills"][number][] = [];
  for (const candidate of Array.isArray(catalog.commands) ? catalog.commands : []) {
    const command = object(candidate);
    if (typeof command.name !== "string") continue;
    const description = typeof command.description === "string" ? { description: command.description } : {};
    if (command.source === "skill" && command.name.startsWith("skill:") && command.name.length > 6) skills.push({ id: fingerprint([command.name, command.sourceInfo]), name: command.name.slice(6), reference: `/${command.name}`, ...description });
    else if (command.source === "prompt") commands.push({ invocation: `/${command.name}`, source: command.source, ...description });
  }
  const selected = object(catalog.defaultSelection);
  const defaults = models.filter(model => model.provider === selected.provider && model.id === selected.modelId &&
    (typeof selected.thinkingLevel !== "string" || model.supportedReasoningEfforts.includes(selected.thinkingLevel)));
  return { models: models.map(model => defaults.length === 1 && defaults[0] === model ? { ...model, isDefault: true as const,
    ...(typeof selected.thinkingLevel === "string" ? { defaultReasoningEffort: selected.thinkingLevel } : {}) } : model), commands, skills, notices: [] };
}

function capabilities(settings: PiNativeSettings, state: Record<string, unknown> = {}, outputImages = false, live = false): BackendCapabilityDocument {
  const model = object(state.model);
  const effective: BackendEffectiveSettings = { toolAccess: settings.toolMode,
    ...(typeof model.provider === "string" && typeof model.id === "string" ? { model: { provider: model.provider, id: model.id } } : {}),
    ...(typeof state.thinkingLevel === "string" ? { thinkingLevel: state.thinkingLevel } : {}) };
  return { revision: fingerprint([settings.revision, effective]), actions: ["rename", "compact", "set_model", "set_thinking_level", "set_tool_access"],
    deliveryModes: ["submit", "steer"], steerTarget: "turn", composerAttachments: { fileStaging: true, nativeImage: Array.isArray(model.input) && model.input.includes("image") },
    nonblockingQuestions: false, providerOutputArtifacts: { nativeImage: outputImages }, supportsHistory: true,
    branching: { availability: "available", boundaries: ["latest_completed", "selected_completed_turn"], method: "provider_native", sourceMustBeIdle: false,
      settingsInheritance: "application_applied", fidelity: { instructions: false, messages: true, toolCalls: true, toolResults: true, compaction: true, attachments: true, settings: true,
        limitations: [{ text: "The child reloads the execution host's current instructions." }] }, childIdentity: "application_reserved", creationRecovery: "idempotent" },
    interactionKinds: ["choice", "confirmation", "text_input", "editor", "decision"], usageAccounting: "supported", turnThroughput: "supported", usageSections: live ? ["context", "counters"] : ["counters"], effectiveSettings: effective };
}

export class PiNativeHistoryReader implements ConversationHistoryReader {
  readonly #projection: NativeHistoryProjection;
  #closed = false;
  constructor(readonly historySnapshot: PiNativeHistory, readonly settings: PiNativeSettings, readonly accounting?: PiNativeUsageAccounting,
    images?: Awaited<ReturnType<typeof publishNativeHistoryArtifacts>>, readonly outputImages = false) {
    this.#projection = projectNativeHistory(historySnapshot, { images }); accounting?.update(historySnapshot, this.#projection, "history");
  }
  #assert(): void { if (this.#closed) throw reject("pi_native_history_closed"); }
  async readSnapshot(input: EstablishProjectionInput) { this.#assert(); input.signal.throwIfAborted(); return projectionWindow(this.#projection, this.historySnapshot.sessionId); }
  async history(input: HistoryPageInput) { this.#assert(); return historyPage(this.#projection, this.historySnapshot.sessionId, input); }
  async locateTurn(input: LocateTurnInput) { this.#assert(); return locateHistory(this.#projection, input); }
  async backendCapabilities() { this.#assert(); return capabilities(this.settings, {}, this.outputImages); }
  async usage() { this.#assert(); return this.#projection.usage; }
  async close() { if (this.#closed) return; this.#closed = true; this.accounting?.close(); }
}

function submissionReconciliation(evidence: Record<string, unknown>, operationId: string): SubmissionReconciliation {
  if (evidence.phase === "accepted" && typeof evidence.userEntryId === "string") return { status: "accepted", completionIdentity: operationId };
  if (evidence.phase === "lost") return { status: "not_accepted", retryable: false, diagnostic: { text: "Pi stopped before using this input." } };
  if (evidence.phase === "rejected") return { status: "not_accepted", retryable: false,
    diagnostic: { text: "This input was not sent. Restore it to send it again." } };
  return { status: "unresolved", diagnostic: { text: "Pi has not yet established the exact input outcome." } };
}
function matchingSubmission(value: unknown, operationId: string, reconciliationToken?: string): PiManagedOperation | undefined {
  const parsed = piManagedOperationSchema.safeParse(value);
  return parsed.success && parsed.data.input.operationId === operationId &&
    (reconciliationToken === undefined || parsed.data.input.reconciliationToken === reconciliationToken) ? parsed.data : undefined;
}

class PiNativeConversationHandle implements ConversationHandle {
  readonly automaticEviction = "client_detach" as const;
  readonly binding: ConversationBinding;
  readonly #lifetime = new AbortController();
  readonly #interrupts = new ConversationInterruptLedger();
  readonly #listeners = new Set<(event: BackendConversationEvent) => void>();
  readonly #interactions = new Map<string, DriverInteraction>();
  readonly #choiceValues = new Map<string, readonly string[]>();
  readonly #throughput = new TurnThroughputRecorder();
  readonly #measuredRequests = new Set<string>();
  readonly #observedSubmissions = new Set<string>();
  readonly #clientAuthorities = new Map<AbortController, { userEntryId: string; turnId: string }>();
  #state: Record<string, unknown> = {};
  #checkpointState: Pick<PiManagedState, "entries" | "toolCalls" | "toolResults"> = { entries: [], toolCalls: [], toolResults: [] };
  #projection!: NativeHistoryProjection;
  #projector!: PiProjectionEstablisher;
  #settings: PiNativeSettings;
  #afterSequence: number;
  #watch?: Promise<void>;
  #controlWatch?: Promise<void>;
  #closed = false;
  #cleanupComplete = false;
  #closing?: Promise<void>;
  #live = new Map<string, BackendItem>();
  #refreshing?: Promise<void>;
  #sending: Promise<void> = Promise.resolve();
  #activeSubmissionId?: string;
  #historyMetadata?: PiNativeHistory;
  #usageAccounting?: PiNativeUsageAccounting;
  #agentTools?: PiNativeAgentToolBridge;
  #agentToolNames: readonly string[] = [];
  #configuringMode?: PiNativeSettings["toolMode"];
  #toolCatalogSignature?: string;
  #draining = false;
  #providerClosed = false;
  #recoveryNotice?: { readonly notice: RuntimeNotice; readonly observed: () => void };
  #controlOnly: boolean;
  #controlAttached: boolean;
  #controlStopsInFlight = 0;
  #controlStopConfirmed = false;
  #controlNoticeBlocked?: boolean;
  #controlStateKey?: string;
  #controlNativeIdle?: boolean;
  #recoveryReplacementRequested = false;
  readonly #retainedOperationIds: Set<string>;
  readonly #eventCheckpoint: PiNativeEventCheckpoint;
  readonly control;
  constructor(readonly driver: PiNativeConversationDriver, readonly input: AttachConversationInput,
    readonly attachment: PiNativeAttachment, readonly release: (released: boolean) => void, controlOnly = false) {
    this.binding = input.binding; this.#afterSequence = attachment.retainedAfterSequence;
    this.#controlOnly = controlOnly;
    this.#controlAttached = controlOnly;
    this.#retainedOperationIds = new Set(attachment.retainedOperationIds);
    this.#eventCheckpoint = new PiNativeEventCheckpoint(attachment.retainedAfterSequence);
    this.#settings = driver.options.settings.getSettings(input.scope, input.binding.applicationThreadId);
    this.control = { generation: attachment.generation, lifetime: this.#lifetime.signal,
      interrupt: (request: InterruptConversationInput) => this.interrupt(request),
      reconcileInterrupt: (request: InterruptConversationInput) => this.reconcileInterrupt(request) };
  }
  get port() { return this.driver.options.port; }
  setRecoveryNotice(notice: RuntimeNotice, observed: () => void): void {
    this.#recoveryNotice = { notice, observed };
  }
  #publishRecoveryNotice(): void {
    const recovery = this.#recoveryNotice;
    if (!recovery) return;
    this.#emit({ type: "notice", notice: recovery.notice });
    recovery.observed(); this.#recoveryNotice = undefined;
  }
  #warnControlOnly(blocked = false): boolean {
    if (this.#controlNoticeBlocked === blocked) return false;
    this.#controlNoticeBlocked = blocked;
    this.setRecoveryNotice({ id: `pi-native-gap:${fingerprint(this.attachment.generation)}`, tone: "warning",
      message: { text: blocked
        ? "Pi's saved-history recovery is still blocked by retained work for this session. Review its pending operations and stop this session's Pi process on the execution host if its waits cannot be resolved. Operations with unknown outcomes must not be repeated. New input, settings, and question responses remain unavailable."
        : "Pi's live output reached its retention limit. Recovery will resume after active work and pending obligations settle. You can Stop an active run. New input, settings, and question responses are unavailable until recovery completes." },
      createdAt: this.driver.options.now?.() ?? new Date().toISOString() }, () => {});
    return true;
  }
  #assert(): void { if (this.#closed) throw reject("pi_native_handle_closed"); }
  #assertMutation(): void {
    this.#assert();
    if (this.#controlOnly) throw reject("pi_native_observation_control_only", "Pi must recover its saved conversation before accepting new work.");
  }
  async initialize(drainRetained = false, providerClosed = false): Promise<void> {
    this.#draining = drainRetained; this.#providerClosed = providerClosed;
    try {
      for (const id of this.#retainedOperationIds) {
        const base = nativeOperationBase(id);
        const operation = this.driver.options.operations.getOperation(this.input.scope, this.binding.applicationThreadId, id)
          ?? this.driver.options.operations.getOperation(this.input.scope, this.binding.applicationThreadId, base);
        if (operation?.state === "completed") await this.#acknowledge([id]);
      }
      this.#historyMetadata = await nativeCall(() => this.port.readHistory(this.attachment));
      if (this.driver.options.usage.enabled) this.#usageAccounting = new PiNativeUsageAccounting(this.driver.options.usage,
        this.binding, `pi-native:${this.binding.backendInstanceId}:${this.binding.executionEnvironmentId}`, this.#historyMetadata);
      if (!drainRetained && !this.#controlOnly) this.#agentTools = this.driver.options.agentTools?.createBridge({ attachment: this.attachment, conversation: this.input, port: this.port, getToolMode: () => this.#configuringMode ?? this.#settings.toolMode, clientControlAuthority: userEntryId => this.#clientControlAuthority(userEntryId) });
      await this.#refresh(false);
      if (!drainRetained && !this.#controlOnly) {
        this.driver.options.settings.syncObserved?.(this.input.scope, this.binding.applicationThreadId, capabilities(this.#settings, this.#state, Boolean(this.driver.options.outputArtifacts)).effectiveSettings);
        if (this.#state.isIdle === true) await this.#applySettings();
      }
      const initial = projectionWindow(this.#projection, this.attachment.sessionId);
      this.#projector = new PiProjectionEstablisher({ initialSnapshot: initial.snapshot, initialHistory: initial.history,
        refreshProjection: () => projectionWindow(this.#projection, this.attachment.sessionId) });
      if (drainRetained) {
        while (this.#afterSequence < this.attachment.throughSequence) {
          const before = this.#afterSequence;
          await this.#observePage();
          if (this.#afterSequence < this.attachment.throughSequence && this.#afterSequence <= before)
            throw reject("pi_native_retained_output_unresolved", "Pi could not apply all retained output before retirement.");
        }
        if (providerClosed) await this.#preserveClosedOutcomes();
      } else if (!this.#controlOnly) this.#watch = this.#observe();
      if (this.#controlOnly) {
        this.#replaceRecoveredControl();
        if (!this.#recoveryReplacementRequested) {
          this.#warnControlOnly(this.#state.isIdle === true);
          this.#controlWatch = this.#watchControl();
        }
      }
      if (!drainRetained && !this.#controlOnly) this.driver.options.settings.syncObserved?.(this.input.scope, this.binding.applicationThreadId, capabilities(this.#settings, this.#state, Boolean(this.driver.options.outputArtifacts)).effectiveSettings);
    } catch (cause) { this.#lifetime.abort(); throw cause; }
  }
  async #applyToolPolicy(mode: PiNativeSettings["toolMode"], operationId?: string, boundary?: NativeMutationBoundary): Promise<void> {
    this.#assertMutation();
    this.#configuringMode = mode;
    try { if (this.#agentTools) this.#agentToolNames = await this.#agentTools.configure(); }
    finally { this.#configuringMode = undefined; }
    const models = object(await rpc(this.port, this.attachment, { type: "get_available_models" }));
    const catalog = nativeCatalog(models, this.driver.options.modelPolicy);
    if (operationId) this.#record(operationId, "sent");
    if (boundary) boundary.phase = "dispatched";
    try {
      await companion(this.port, this.attachment, { type: "set_policy", policy: { mode,
        allowedModels: catalog.models.map(model => ({ provider: model.provider, modelId: model.id, thinkingLevels: model.supportedReasoningEfforts })) } }, operationId ? `${operationId}:policy` : undefined);
    } catch (cause) {
      if (boundary && cause instanceof BackendError && !cause.crossedSubmissionBoundary) boundary.phase = "not_applied";
      throw cause;
    }
    const snapshot = object(await companion(this.port, this.attachment, { type: "snapshot" }));
    const reviewed = new Set(["read", "grep", "find", "ls", "bash", "write", "edit", "powershell"]);
    const readonly = new Set(["read", "grep", "find", "ls"]);
    const names: string[] = [...this.#agentToolNames];
    let reviewedRead = false;
    for (const entry of Array.isArray(snapshot.tools) ? snapshot.tools : []) {
      const tool = object(entry); const source = object(tool.sourceInfo);
      if (tool.exposure === "hidden" || tool.exposure === "codemode" || tool.exposure === "deferred") continue;
      if (tool.managed === "codemode" || tool.managed === "tool_search" || (tool.managed === "mcp" && mode !== "read_only")) { names.push(String(tool.name)); continue; }
      if (source.source !== "builtin") continue;
      if (typeof tool.name !== "string" || !reviewed.has(tool.name) || source.path !== `builtin:${tool.name}`) throw reject("pi_native_tool_catalog_unreviewed");
      if (tool.name === "read") reviewedRead = true;
      if (mode !== "read_only" || readonly.has(tool.name)) names.push(tool.name);
    }
    if (!reviewedRead && !names.some(name => snapshot.tools && Array.isArray(snapshot.tools) && snapshot.tools.some(entry => object(entry).name === name && object(entry).managed === "codemode"))) throw reject("pi_native_read_tool_unavailable");
    this.#toolCatalogSignature = fingerprint(snapshot.tools);
    await companion(this.port, this.attachment, { type: "set_active_tools", names }, operationId ? `${operationId}:tools` : undefined);
  }
  async #applySettings(settings = this.driver.options.settings.getSettings(this.input.scope, this.binding.applicationThreadId)): Promise<void> {
    await this.#applyToolPolicy(settings.toolMode);
    if (settings.modelProvider && settings.modelId) {
      if (!this.driver.options.modelPolicy.isSelectionAllowed({ providerId: settings.modelProvider, modelId: settings.modelId, reasoningEffort: settings.thinkingLevel ?? "off" })) throw reject("pi_native_model_policy_denied");
      await rpc(this.port, this.attachment, { type: "set_model", provider: settings.modelProvider, modelId: settings.modelId });
    }
    if (settings.thinkingLevel) await rpc(this.port, this.attachment, { type: "set_thinking_level", level: settings.thinkingLevel });
    await this.#refresh(false);
    const model = object(this.#state.model);
    if ((settings.modelProvider && model.provider !== settings.modelProvider) || (settings.modelId && model.id !== settings.modelId) ||
        (settings.thinkingLevel && this.#state.thinkingLevel !== settings.thinkingLevel))
      throw reject("pi_native_settings_not_applied", "Pi did not apply the requested model and thinking settings.");
    this.#settings = settings;
  }
  async #refresh(publish: boolean, signal = this.#lifetime.signal): Promise<void> {
    signal.throwIfAborted();
    if (this.#refreshing) {
      await this.#refreshing;
      // The pending snapshot may predate this caller's completed mutations.
      // Publication is optional; a fresh observation is required either way.
      return this.#refresh(publish, signal);
    }
    const operation = (async () => {
      const closedHistory = this.#providerClosed ? await nativeCall(() => this.port.readHistory(this.attachment)) : undefined;
      const state = piManagedStateSchema.parse(closedHistory ? { sessionId: closedHistory.sessionId, sessionFile: closedHistory.sessionFile,
        entries: closedHistory.entries, leafId: closedHistory.leafId, operations: closedHistory.operations, toolCalls: closedHistory.toolCalls,
        toolResults: closedHistory.toolResults, tools: [], activeTools: [], isIdle: true } : await companion(this.port, this.attachment, { type: "snapshot" }, undefined, signal));
      if (state.sessionId !== this.attachment.sessionId || !Array.isArray(state.entries) || !(state.leafId === null || typeof state.leafId === "string")) throw reject("pi_native_snapshot_identity_mismatch");
      const history: PiNativeHistory = { ...this.attachment, entries: state.entries.map(object), leafId: state.leafId as string | null, operations: state.operations, toolCalls: state.toolCalls, toolResults: state.toolResults,
        inheritedEntryIds: this.#historyMetadata?.inheritedEntryIds ?? [], inheritance: this.#historyMetadata?.inheritance ?? "unknown",
        ...(this.#historyMetadata?.parentSessionId ? { parentSessionId: this.#historyMetadata.parentSessionId } : {}) };
      this.#agentTools?.reconcileHistory(history);
      const operations = Array.isArray(state.operations) ? state.operations.map(object) : [];
      const recovered: string[] = [];
      const evidence: NativeInputEvidence[] = operations.flatMap(candidate => {
        const parsed = piManagedOperationSchema.safeParse(candidate);
        if (!parsed.success) throw reject("pi_native_operation_evidence_invalid");
        const operation = parsed.data;
        if (["accepted", "lost", "rejected"].includes(operation.phase)) {
          const record = this.driver.options.operations.getOperation(this.input.scope, this.binding.applicationThreadId, operation.input.operationId);
          const settledNow = record?.state === "sent" || record?.state === "unknown";
          if (settledNow) this.#record(operation.input.operationId, "completed", operation);
          if (record) {
            const ids = this.#submissionOperationIds(operation.input.operationId);
            if (settledNow) for (const id of ids) this.#retainedOperationIds.add(id);
            if (this.#activeSubmissionId !== operation.input.operationId) recovered.push(...ids.filter(id => this.#retainedOperationIds.has(id)));
          }
        }
        if (operation.phase === "accepted" && operation.userEntryId && !this.#observedSubmissions.has(operation.input.operationId)) {
          this.#observedSubmissions.add(operation.input.operationId);
          this.input.onSubmissionObserved?.({ backendCorrelation: operation.input.operationId });
        }
        return [{ operationId: operation.input.operationId, mode: operation.input.mode, phase: operation.phase,
          ...(typeof operation.userEntryId === "string" ? { userEntryId: operation.userEntryId } : {}),
          ...(typeof operation.targetTurnId === "string" ? { targetTurnId: operation.targetTurnId } : {}), presentation: operation.input.presentation }];
      });
      if (recovered.length) await this.#acknowledge(recovered);
      const images = await publishNativeHistoryArtifacts(history, this.binding, this.driver.options.outputArtifacts);
      const projected = projectNativeHistory(history, { running: state.isIdle === false, operations: evidence, images });
      const context = piNativeContextUsage(state.contextUsage);
      const next = { ...projected, usage: { ...projected.usage, ...(context ? { context } : {}) } };
      // A gap still needs recovery even when native work has settled. Do not
      // advertise an authoritative idle cut while retained obligations fence it.
      if (this.#controlOnly && state.isIdle) next.snapshot.runState = "reconciling";
      const prior = this.#projection;
      this.#captureThroughput(history, prior, next);
      if (!state.isIdle) for (const item of this.#live.values()) {
        const turn = next.snapshot.turnsById[item.backendTurnId];
        if (!turn) continue;
        next.snapshot.itemsById[item.backendItemId] = item;
        if (!turn.orderedBackendItemIds.includes(item.backendItemId)) turn.orderedBackendItemIds.push(item.backendItemId);
      }
      this.#state = state; this.#projection = next; this.#checkpointState = state;
      for (const [controller, source] of this.#clientAuthorities) if (this.#activeOriginatingTurn(source.userEntryId) !== source.turnId) {
        controller.abort(); this.#clientAuthorities.delete(controller);
      }
      this.#usageAccounting?.update(history, next, publish ? "live" : "history");
      if (!publish || !this.#projector) return;
      for (const id of next.snapshot.orderedBackendTurnIds) {
        const turn = next.snapshot.turnsById[id]!;
        const previous = prior?.snapshot.turnsById[id];
        if (!previous) this.#emit({ type: "turn_started", turn: { ...turn, status: "in_progress", orderedBackendItemIds: [], endedBy: undefined, completedAt: undefined, failure: undefined } });
        for (const itemId of turn.orderedBackendItemIds) {
          const item = next.snapshot.itemsById[itemId]!;
          if (JSON.stringify(prior?.snapshot.itemsById[itemId]) !== JSON.stringify(item)) this.#emit({ type: item.status === "streaming" ? (prior?.snapshot.itemsById[itemId] ? "item_updated" : "item_started") : "item_completed", item });
        }
        if (!previous || JSON.stringify(previous) !== JSON.stringify(turn)) this.#emit({ type: turn.status === "in_progress" ? "turn_updated" : "turn_completed", turn });
      }
      this.#emit({ type: "run_state_changed", state: next.snapshot.runState,
        ...(next.snapshot.activeBackendTurnId ? { activeBackendTurnId: next.snapshot.activeBackendTurnId } : {}) });
      this.#emit({ type: "usage_changed", usage: next.usage });
      if (prior && Object.keys(prior.snapshot.itemsById).some(id => !next.snapshot.itemsById[id]))
        this.#emit({ type: "resnapshot_required", reason: "history_changed" });
    })();
    this.#refreshing = operation;
    try { await operation; } finally { if (this.#refreshing === operation) this.#refreshing = undefined; }
  }
  #activeOriginatingTurn(userEntryId: string): string | undefined {
    if (this.#closed || this.#lifetime.signal.aborted || this.#state.isIdle !== false) return;
    const operation = (this.#state.operations as readonly PiManagedOperation[] | undefined)?.find(value => value.phase === "accepted" && value.userEntryId === userEntryId);
    const turnId = operation?.input.mode === "steer" ? operation.targetTurnId : userEntryId;
    if (turnId && this.#projection.snapshot.activeBackendTurnId === turnId && this.#projection.snapshot.turnsById[turnId]?.status === "in_progress") return turnId;
  }
  #clientControlAuthority(userEntryId: string): BackendAgentToolAccessDecisionAuthority {
    return { acquire: async (signal) => {
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, this.#lifetime.signal, controller.signal]);
      combined.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(combined.reason);
        combined.addEventListener("abort", abort, { once: true });
        void this.#refresh(true).then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
        if (combined.aborted) abort();
      });
      combined.throwIfAborted();
      const turnId = this.#activeOriginatingTurn(userEntryId);
      if (!turnId) throw new BackendAgentToolRequestError({ code: "permission_denied", message: "The originating Pi turn is no longer active.", retryable: false });
      this.#clientAuthorities.set(controller, { userEntryId, turnId });
      return { signal: combined, isCurrent: () => !combined.aborted && this.#activeOriginatingTurn(userEntryId) === turnId,
        release: () => { this.#clientAuthorities.delete(controller); controller.abort(); } };
    } };
  }
  #captureThroughput(history: PiNativeHistory, prior: NativeHistoryProjection | undefined, next: NativeHistoryProjection): void {
    if (!prior || !this.#projector) return;
    const requests = new Map<string, Record<string, unknown>[]>();
    const steerTargets = new Map(history.operations.flatMap(operation => operation.phase === "accepted" && operation.userEntryId && operation.targetTurnId
      ? [[operation.userEntryId, operation.targetTurnId] as const] : []));
    let turnId: string | undefined;
    for (const entry of nativeBranch(history)) {
      const message = object(entry.message);
      if (entry.type === "message" && message.role === "user") turnId = steerTargets.get(String(entry.id)) ?? String(entry.id);
      if (entry.type !== "message" || message.role !== "assistant" || !turnId || message.stopReason === "pending") continue;
      const entries = requests.get(turnId) ?? []; entries.push(entry); requests.set(turnId, entries);
    }
    for (const id of next.snapshot.orderedBackendTurnIds) {
      const previous = prior.snapshot.turnsById[id]; const turn = next.snapshot.turnsById[id]!;
      if (!previous) this.#throughput.start(id);
      if (!previous || previous.status === "in_progress") {
        for (const entry of requests.get(id) ?? []) {
          if (this.#measuredRequests.has(String(entry.id))) continue;
          this.#measuredRequests.add(String(entry.id));
          const message = object(entry.message); const outputTokens = object(message.usage).output; const duration = message.durationMs;
          const empty = !Array.isArray(message.content) || message.content.length === 0;
          this.#throughput.record(id, typeof outputTokens === "number" && typeof duration === "number" && (outputTokens > 0 || empty)
            ? { outputTokens, requestDurationMs: duration } : undefined);
        }
        if (turn.status !== "in_progress") this.#throughput.finish(id, turn.status === "completed");
      }
      const throughput = this.#throughput.get(id);
      if (throughput && turn.status === "completed") next.snapshot.turnsById[id] = { ...turn, throughput };
    }
  }
  #emit(event: BackendConversationEvent): void {
    if (this.#closed) return;
    const parsed = backendConversationEventSchema.parse(event);
    this.#projector?.publish(parsed);
    for (const listener of this.#listeners) listener(parsed);
  }
  async #observePage() {
    const page = await this.port.observe({ handleId: this.attachment.handleId, afterSequence: this.#afterSequence }, this.#lifetime.signal);
    if (page.retainedAfterSequence > this.#afterSequence) {
      await this.#refresh(true); this.#emit({ type: "resnapshot_required", reason: "sequence_gap" });
      this.#eventCheckpoint.acknowledge(page.retainedAfterSequence);
    }
    for (const event of page.events) {
      if (event.sequence <= this.#afterSequence) continue;
      this.#eventCheckpoint.observe(event);
      if (await this.#consume(event.kind, event.payload)) this.#eventCheckpoint.applied(event.sequence, this.#checkpointState);
      if (!this.#providerClosed && event.kind === "rpc" && event.payload.type === "extension_error") this.#eventCheckpoint.noticeApplied(event.sequence);
      this.#afterSequence = event.sequence;
    }
    this.#afterSequence = Math.max(this.#afterSequence, page.throughSequence);
    const throughSequence = this.#state.isIdle === true && this.#interactions.size === 0 && !this.#agentTools?.hasPendingCalls()
      ? this.#afterSequence : this.#eventCheckpoint.through(id => this.#interactions.has(id), this.#agentTools?.hasPendingCalls());
    if (throughSequence > this.#eventCheckpoint.acknowledged) {
      await this.port.acknowledge({ handleId: this.attachment.handleId, throughSequence }, this.#lifetime.signal);
      this.#eventCheckpoint.acknowledge(throughSequence);
    }
    if (page.closed && !this.#draining) { this.#emit({ type: "resnapshot_required", reason: "provider_handle_closed" }); this.#lifetime.abort(); }
    return page;
  }
  async #observe(): Promise<void> {
    while (!this.#closed) {
      try {
        const page = await this.#observePage();
        if (page.closed) return;
        if (!page.events.length) await delay(50, undefined, { signal: this.#lifetime.signal });
      } catch (cause) {
        if (this.#closed || this.#lifetime.signal.aborted) return;
        if (cause instanceof PiNativeError && cause.code === "pi_native_observation_continuity_lost") {
          this.#throughput.invalidate();
          this.#controlOnly = true;
          await this.#readControl();
          this.#emit({ type: "capabilities_changed", capabilities: this.#capabilities() });
          if (!this.#recoveryReplacementRequested) {
            this.#warnControlOnly(this.#state.isIdle === true);
            this.#emit({ type: "resnapshot_required", reason: "sequence_gap" });
            this.#controlWatch = this.#watchControl();
          }
          return;
        }
        this.#throughput.invalidate();
        this.#emit({ type: "run_state_changed", state: "disconnected" });
        await delay(250, undefined, { signal: this.#lifetime.signal }).catch(() => undefined);
      }
    }
  }
  #controlReadSignal(): AbortSignal {
    return AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(5_000)]);
  }
  async #readControl(): Promise<void> {
    const signal = this.#controlReadSignal();
    try {
      if (!this.#controlAttached) {
        const control = await nativeCall(() => this.port.attachForControl(this.attachment, signal));
        if (!control) throw reject("pi_native_observation_control_unavailable");
        if (control.handleId !== this.attachment.handleId || control.generation !== this.attachment.generation)
          throw reject("pi_native_observation_control_changed");
        this.#controlAttached = true;
      }
      const state = parsePiRpcState(await rpc(this.port, this.attachment, { type: "get_state" }, undefined, signal));
      if (state.sessionId !== this.attachment.sessionId || state.sessionFile !== this.attachment.sessionFile)
        throw reject("pi_native_snapshot_identity_mismatch");
      const contextIdle = !state.isStreaming && !state.isCompacting;
      const nativeIdle = contextIdle && state.pendingMessageCount === 0;
      this.#controlNativeIdle = nativeIdle;
      const key = fingerprint([state.isStreaming, state.isCompacting, state.pendingMessageCount,
        nativeIdle ? state.messageCount : undefined, state.model?.provider, state.model?.id, state.thinkingLevel]);
      // Busy text/token progress needs no full-history projection. Hydrate only
      // after a state change or the first authoritative idle observation.
      if ((this.#controlStateKey !== undefined && key !== this.#controlStateKey) ||
        (nativeIdle && this.#state.isIdle !== true) || (!contextIdle && this.#state.isIdle !== false))
        await this.#refresh(true);
      this.#controlStateKey = key;
      if (nativeIdle) this.#replaceRecoveredControl();
      if (!this.#recoveryReplacementRequested && this.#warnControlOnly(this.#state.isIdle === true))
        this.#emit({ type: "resnapshot_required", reason: "sequence_gap" });
    } catch (cause) {
      if (this.#closed || this.#lifetime.signal.aborted) return;
      this.#emit({ type: "run_state_changed", state: "disconnected" });
      this.#replaceUnavailableControl(cause);
    }
  }
  async #watchControl(): Promise<void> {
    while (!this.#closed && !this.#lifetime.signal.aborted && !this.#recoveryReplacementRequested) {
      try { await delay(1_000, undefined, { signal: this.#lifetime.signal }); }
      catch { return; }
      if (this.#closed || this.#recoveryReplacementRequested) return;
      await this.#readControl();
    }
  }
  async #consume(kind: string, event: Record<string, unknown>): Promise<boolean> {
    if (kind === "failure") { this.#throughput.invalidate(); this.#emit({ type: "run_state_changed", state: "disconnected" }); return false; }
    if (kind === "stream") { this.#stream(event); return false; }
    if (this.#providerClosed) {
      // The disk snapshot is authoritative for completed output. Retain only a
      // trailing partial streamed message as interrupted, and discard dead UI.
      if (event.type === "message_start" || event.type === "message_end") {
        for (const item of this.#live.values()) {
          delete this.#projection.snapshot.itemsById[item.backendItemId];
          const turn = this.#projection.snapshot.turnsById[item.backendTurnId];
          if (turn) turn.orderedBackendItemIds = turn.orderedBackendItemIds.filter(id => id !== item.backendItemId);
        }
        this.#live.clear();
      }
      return false;
    }
    if (kind === "companion") {
      this.#agentTools?.onEvent(piManagedEventSchema.parse(event));
      if (event.type === "agent_tool_call" || event.type === "agent_tool_cancelled" || event.type === "request_usage") return false;
      if (event.type === "tool_approval_requested") this.#approval(event);
      else if (event.type === "tool_approval_closed" && typeof event.id === "string") {
        this.#interactions.delete(event.id); this.#emit({ type: "interaction_resolved", backendInteractionId: event.id });
      }
      else {
        await this.#refresh(true);
        if (!this.#draining && this.#state.isIdle === true && this.#toolCatalogSignature !== fingerprint(this.#state.tools)) await this.#applyToolPolicy(this.#settings.toolMode);
        return true;
      }
      return false;
    }
    if (event.type === "extension_ui_request") { this.#uiRequest(event); return false; }
    if (event.type === "message_start" && object(event.message).role === "assistant") this.#live.clear();
    if (event.type === "message_end" && object(event.message).role === "assistant") this.#live.clear();
    if (["agent_start", "message_end", "tool_execution_end", "compaction_end", "agent_settled", "entry_appended"].includes(String(event.type))) { await this.#refresh(true); return true; }
    if (event.type === "extension_error") this.#emit({ type: "notice", notice: { id: randomUUID(), tone: "error", message: boundText(event.error, 500), createdAt: new Date().toISOString() } });
    return false;
  }
  #stream(event: Record<string, unknown>): void {
    const turnId = this.#projection.snapshot.activeBackendTurnId ?? (this.#providerClosed ? this.#projection.snapshot.orderedBackendTurnIds.at(-1) : undefined);
    if (!turnId) return;
    if (event.type !== "message_snapshot" || typeof event.streamId !== "string" || !event.streamId ||
      (event.semanticKind !== "assistant_message" && event.semanticKind !== "reasoning") ||
      !Number.isSafeInteger(event.contentIndex) || Number(event.contentIndex) < 0 || typeof event.text !== "string") return;
    const index = event.contentIndex as number;
    const key = `${event.streamId}:${index}`;
    const prior = this.#live.get(key);
    const item: BackendItem = { backendItemId: `live:${key}`, backendTurnId: turnId, status: this.#providerClosed ? "interrupted" : "streaming",
      sourceOrder: 1_000_000_000_000 + index, semanticKind: event.semanticKind,
      markdown: event.semanticKind === "assistant_message" ? preserveMessageText(event.text) : boundText(event.text) };
    this.#live.set(key, item);
    this.#projection.snapshot.itemsById[item.backendItemId] = item;
    const turn = this.#projection.snapshot.turnsById[turnId]!;
    if (!turn.orderedBackendItemIds.includes(item.backendItemId)) turn.orderedBackendItemIds.push(item.backendItemId);
    this.#emit({ type: this.#providerClosed ? "item_completed" : prior ? "item_updated" : "item_started", item });
  }
  #approval(event: Record<string, unknown>): void {
    if (typeof event.id !== "string") return;
    const interaction: DriverInteraction = { backendInteractionId: event.id, sourceLabel: { text: "Pi" }, title: boundDisplayText(`Allow ${String(event.toolName)}?`), openedAt: new Date().toISOString(),
      secret: false, destructive: true, cancellable: true, kind: "decision", message: boundText(JSON.stringify(event.parameters, null, 2), 4_096),
      actions: [{ backendActionId: "approve", label: { text: "Allow once" }, role: "primary" }, { backendActionId: "deny", label: { text: "Deny" }, role: "reject" }] };
    this.#interactions.set(event.id, interaction); this.#emit({ type: "interaction_opened", interaction });
  }
  #uiRequest(event: Record<string, unknown>): void {
    if (typeof event.id !== "string") return;
    const base = { backendInteractionId: event.id, sourceLabel: { text: "Pi" }, title: boundDisplayText(event.title ?? "Pi"), openedAt: new Date().toISOString(), secret: false, destructive: false, cancellable: true };
    let interaction: DriverInteraction | undefined;
    if (event.method === "select" && Array.isArray(event.options) && event.options.length && event.options.every(option => typeof option === "string")) {
      this.#choiceValues.set(event.id, [...event.options]);
      interaction = { ...base, kind: "choice", multiple: false,
        options: event.options.map((option, index) => ({ backendOptionId: String(index), label: boundDisplayText(option) })) };
    }
    else if (event.method === "confirm") interaction = { ...base, kind: "confirmation", message: boundText(event.message) };
    else if (event.method === "input") interaction = { ...base, kind: "text_input", multiline: false, ...(typeof event.placeholder === "string" ? { placeholder: boundDisplayText(event.placeholder) } : {}) };
    else if (event.method === "editor") interaction = { ...base, kind: "editor", initialValue: boundText(event.prefill) };
    if (interaction) { this.#interactions.set(event.id, interaction); this.#emit({ type: "interaction_opened", interaction }); }
  }
  async establishProjection(input: EstablishProjectionInput): Promise<EstablishedBackendProjection> {
    this.#assert(); input.signal.throwIfAborted();
    const projection = await this.#projector.establishProjection(input);
    return { ...projection, subscribeFromNext: listener => {
      const unsubscribe = projection.subscribeFromNext(listener);
      this.#publishRecoveryNotice();
      if (this.#recoveryReplacementRequested) this.#emit({ type: "resnapshot_required", reason: "provider_handle_closed" });
      return unsubscribe;
    } };
  }
  async history(input: HistoryPageInput): Promise<BackendHistoryPage> { this.#assert(); return historyPage(this.#projection, this.attachment.sessionId, input); }
  async locateTurn(input: LocateTurnInput): Promise<LocateTurnResult> { this.#assert(); return locateHistory(this.#projection, input); }
  #capabilities(): BackendCapabilityDocument {
    const document = capabilities(this.#settings, this.#state, Boolean(this.driver.options.outputArtifacts), true);
    return this.#controlOnly ? { ...document, revision: fingerprint([document.revision, "control_only"]), actions: [], deliveryModes: [],
      steerTarget: null, composerAttachments: { fileStaging: false, nativeImage: false }, interactionKinds: [], turnThroughput: "unsupported",
      branching: { availability: "unavailable", reason: { text: "Recover the conversation's live output before branching." } } } : document;
  }
  async backendCapabilities() { this.#assert(); return this.#capabilities(); }
  async usage(): Promise<UsageSnapshot> { this.#assert(); return this.#projection.usage; }
  async captureSubmissionRetryAnchor(): Promise<string> {
    this.#assertMutation(); await this.#refresh(false);
    if (this.#state.isIdle !== true) throw reject("pi_native_retry_anchor_busy");
    return JSON.stringify({ version: 1, sessionId: this.attachment.sessionId, leafId: this.#state.leafId, revision: this.#projection.revision });
  }
  async #send(input: SubmitTurnInput | SteerTurnInput, mode: "submit" | "steer"): Promise<Record<string, unknown>> {
    return this.#guardMutation(input.applicationOperationId, async boundary => {
      this.#assertMutation();
      const operation = this.#sending.then(async () => {
        boundary.phase = this.#operationPhase(input.applicationOperationId);
        this.#activeSubmissionId = input.applicationOperationId;
        try { return await this.#sendOnce(input, mode, boundary); }
        finally {
          this.#activeSubmissionId = undefined;
          if (this.driver.options.operations.getOperation(this.input.scope, this.binding.applicationThreadId, input.applicationOperationId)?.state === "completed")
            await this.#acknowledge(this.#submissionOperationIds(input.applicationOperationId)
              .filter(id => this.#retainedOperationIds.has(id)));
        }
      });
      this.#sending = operation.then(() => undefined, () => undefined);
      return operation;
    });
  }
  async #sendOnce(input: SubmitTurnInput | SteerTurnInput, mode: "submit" | "steer", boundary: NativeMutationBoundary): Promise<Record<string, unknown>> {
    this.#assertMutation();
    const prior = this.driver.options.operations.getOperation(this.input.scope, this.binding.applicationThreadId, input.applicationOperationId);
    const saved = prior?.receiptJson ? object(JSON.parse(prior.receiptJson)) : {};
    const rejected = prior?.state === "completed" && (saved.outcome === "not_applied" || saved.phase === "rejected" || saved.phase === "lost");
    if (!rejected) await this.#refresh(false);
    const target = "target" in input ? input.target : undefined;
    const durable = this.driver.options.operations.prepareOperation(this.input.scope, this.binding.applicationThreadId, {
      operationId: input.applicationOperationId, kind: "submission", requestHash: fingerprint({ mode, mutationId: input.mutationId,
        reconciliationToken: input.reconciliationToken, text: input.text, target, selectedSkillId: input.selectedSkillId,
        contextExcerpts: input.contextExcerpts, taskContexts: input.taskContexts, attachments: input.attachments }) });
    if (durable.state === "completed" && durable.receiptJson) {
      await this.#acknowledge(this.#submissionOperationIds(input.applicationOperationId));
      this.#throwNegativeReceipt(durable);
      return object(JSON.parse(durable.receiptJson));
    }
    if (durable.state !== "prepared") {
      const prior = object(await companion(this.port, this.attachment, { type: "get_submission", operationId: input.applicationOperationId }));
      const parsed = piManagedOperationSchema.safeParse(prior);
      if (parsed.success && parsed.data.input.operationId === input.applicationOperationId &&
          parsed.data.input.mutationId === input.mutationId && parsed.data.input.reconciliationToken === input.reconciliationToken &&
          parsed.data.input.mode === mode) {
        if (!durable.dispatchStarted && parsed.data.phase === "intent") {
          const retired = await this.#retireUndispatchedIntent(durable, parsed.data);
          if (retired.phase !== "accepted") boundary.phase = "not_applied";
          return retired;
        }
        if (!["accepted", "lost", "rejected", "enqueued"].includes(parsed.data.phase))
          throw reject("pi_native_submission_unresolved", "Pi has not resolved this previously dispatched operation.", true);
        if (["accepted", "lost", "rejected"].includes(parsed.data.phase)) {
          this.#record(input.applicationOperationId, "completed", prior);
          await this.#acknowledge(this.#submissionOperationIds(input.applicationOperationId));
        }
        return prior;
      }
      throw reject("pi_native_submission_unresolved", "Pi has not resolved this previously dispatched operation.", true);
    }
    if (mode === "submit" && this.#state.isIdle !== true) throw reject("pi_native_busy");
    if (mode === "steer" && (target?.kind !== "turn" || target.turnId !== this.#projection.snapshot.activeBackendTurnId || this.#state.isIdle !== false))
      throw new BackendError({ category: "rejected", retryable: true, crossedSubmissionBoundary: false, safeMessage: "The selected Pi turn is no longer active.", backendCode: "pi_native_steer_target_stale", steerRejectionReason: "target_no_longer_active" });
    if (mode === "submit") await this.#applySettings();
    const model = object(this.#state.model);
    if (typeof model.provider !== "string" || typeof model.id !== "string" || !this.driver.options.modelPolicy.isSelectionAllowed({ providerId: model.provider, modelId: model.id, reasoningEffort: string(this.#state.thinkingLevel) ?? "off" })) throw reject("pi_native_model_policy_denied");
    let text = formatPiTaskContextPrompt(input.taskContexts, formatPiContextExcerptPrompt(input.contextExcerpts, input.text));
    const images: { type: "image"; data: string; mimeType: string }[] = [];
    for (const attachment of input.attachments) {
      text += `\n\nAttached file: ${attachment.fileName}\nPath on execution host: ${attachment.agentPath}`;
      if (attachment.kind === "image") {
        if (!input.attachmentBytes || !Array.isArray(model.input) || !model.input.includes("image")) throw reject("pi_native_image_input_unavailable");
        const bytes = await input.attachmentBytes.read(attachment);
        if (createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) throw reject("pi_native_attachment_digest_mismatch");
        images.push({ type: "image", data: bytes.toString("base64"), mimeType: attachment.mediaType });
      }
    }
    const invocation = input.text.trimStart().match(/^\/(\S+)/)?.[1];
    if (invocation) {
      const commands = object(await rpc(this.port, this.attachment, { type: "get_commands" })).commands;
      if (Array.isArray(commands) && commands.some(candidate => object(candidate).source === "extension" && object(candidate).name === invocation))
        throw reject("pi_native_extension_command_unsupported", "Run this Pi extension command in the native CLI.");
    }
    if (input.selectedSkillId) {
      const catalog = nativeCatalog({ ...(object(await rpc(this.port, this.attachment, { type: "get_commands" }))) }, this.driver.options.modelPolicy);
      const skill = catalog.skills.find(candidate => candidate.id === input.selectedSkillId);
      if (!skill) throw reject("pi_native_skill_unavailable"); text = `${skill.reference} ${text}`;
    }
    const requestFingerprint = fingerprint({ text, mode, target, attachments: input.attachments, operationId: input.applicationOperationId });
    const prepareId = `${input.applicationOperationId}:prepare:${durable.prepareAttempt}`;
    this.driver.options.operations.completeOperation(this.input.scope, this.binding.applicationThreadId, input.applicationOperationId, { state: "sent" });
    boundary.phase = "dispatched";
    let prepared: Record<string, unknown>;
    try {
      prepared = object(await companion(this.port, this.attachment, { type: "prepare_submission", input: {
        operationId: input.applicationOperationId, mutationId: input.mutationId, reconciliationToken: input.reconciliationToken,
        fingerprint: requestFingerprint, mode, ...(target?.kind === "turn" ? { targetTurnId: target.turnId } : {}), text,
        presentation: { text: input.text, contextExcerpts: input.contextExcerpts, taskContexts: input.taskContexts, attachments: input.attachments.map(({ agentPath: _path, sha256: _sha, ...attachment }) => attachment) } } }, prepareId));
    } catch (cause) {
      // The native adapter reserves this classification for positive not-sent evidence.
      // A missing reply or receipt must keep the durable submission non-replayable.
      if (cause instanceof BackendError && cause.category === "unavailable" && cause.retryable && !cause.crossedSubmissionBoundary) {
        boundary.phase = "not_applied";
        this.driver.options.operations.resetUnsentOperation(this.input.scope, this.binding.applicationThreadId,
          input.applicationOperationId, durable.requestHash, durable.prepareAttempt);
        await this.#acknowledge([prepareId]);
      }
      if (cause instanceof BackendError && cause.category === "rejected" && !cause.crossedSubmissionBoundary && preparationRejectionCodes.has(cause.backendCode ?? "")) {
        boundary.phase = "not_applied";
        return this.#finishRejection(input.applicationOperationId, [prepareId], cause);
      }
      if (cause instanceof BackendError && cause.category === "rejected" && !cause.crossedSubmissionBoundary)
        this.#record(input.applicationOperationId, "unknown", { nativeOutcomes: { [prepareId]: {
          status: "failed", failure: { code: cause.backendCode ?? "pi_native_preparation_rejected", delivery: "rejected" },
        } } });
      throw cause;
    }
    if (typeof prepared.wireText !== "string") throw reject("pi_native_submission_preparation_invalid");
    this.#assertMutation();
    this.driver.options.operations.markSubmissionDispatched(this.input.scope, this.binding.applicationThreadId,
      input.applicationOperationId, durable.requestHash, durable.prepareAttempt);
    let result: Record<string, unknown>;
    try {
      result = object(await rpc(this.port, this.attachment, { type: mode === "submit" ? "prompt" : "steer", message: prepared.wireText,
        ...(images.length ? { images } : {}) }, `${input.applicationOperationId}:dispatch`));
    } catch (cause) {
      if (cause instanceof BackendError && !cause.crossedSubmissionBoundary) {
        const settled = object(await companion(this.port, this.attachment, { type: "complete_submission", operationId: input.applicationOperationId, disposition: "rejected" }));
        const settledInput = object(settled.input);
        if ((settled.phase === "rejected" || settled.phase === "lost") && settledInput.operationId === input.applicationOperationId &&
          settledInput.mutationId === input.mutationId && settledInput.reconciliationToken === input.reconciliationToken && settledInput.fingerprint === requestFingerprint)
          boundary.phase = "not_applied";
      }
      throw cause;
    }
    const disposition = string(result.disposition);
    if (disposition !== "started" && disposition !== "queued" && disposition !== "handled") throw reject("pi_native_submission_disposition_missing", undefined, true);
    await companion(this.port, this.attachment, { type: "complete_submission", operationId: input.applicationOperationId, disposition }, `${input.applicationOperationId}:complete`);
    const evidence = object(await companion(this.port, this.attachment, { type: "get_submission", operationId: input.applicationOperationId }));
    const verified = piManagedOperationSchema.parse(evidence);
    if (verified.input.operationId !== input.applicationOperationId || verified.input.mutationId !== input.mutationId || verified.input.reconciliationToken !== input.reconciliationToken || verified.input.fingerprint !== requestFingerprint)
      throw reject("pi_native_submission_evidence_mismatch", undefined, true);
    if (["accepted", "lost", "rejected"].includes(verified.phase)) {
      if (verified.phase !== "accepted") boundary.phase = "not_applied";
      this.driver.options.operations.completeOperation(this.input.scope, this.binding.applicationThreadId, input.applicationOperationId, { state: "completed", receiptJson: JSON.stringify(verified) });
      await this.#acknowledge(this.#submissionOperationIds(input.applicationOperationId));
    }
    await this.#refresh(true);
    return evidence;
  }
  async submit(input: SubmitTurnInput): Promise<SubmitTurnResult> {
    const evidence = await this.#send(input, "submit");
    if (evidence.phase === "lost" || evidence.phase === "rejected") throw this.#submissionRejection(evidence.phase, "pi_native_submission_not_materialized");
    if (evidence.phase !== "accepted" || typeof evidence.userEntryId !== "string") throw reject("pi_native_submission_pending", "Pi has not yet persisted the submitted input.", true);
    return { accepted: true, reconciliationToken: input.reconciliationToken, completionCorrelation: input.applicationOperationId, backendTurnId: evidence.userEntryId };
  }
  async steer(input: SteerTurnInput): Promise<SteerTurnResult> {
    const evidence = await this.#send(input, "steer");
    if (evidence.phase === "lost" || evidence.phase === "rejected") throw this.#submissionRejection(evidence.phase, "pi_native_steer_not_materialized");
    const common = { reconciliationToken: input.reconciliationToken, completionCorrelation: input.applicationOperationId };
    if (evidence.phase === "accepted" && typeof evidence.userEntryId === "string" && input.target.kind === "turn") return { ...common, status: "accepted", backendTurnId: input.target.turnId };
    return { ...common, status: "pending_materialization", ...(input.target.kind === "turn" ? { backendTurnId: input.target.turnId } : {}) };
  }
  #submissionRejection(phase: "lost" | "rejected", backendCode: string): BackendError {
    return new BackendError({ category: "rejected", retryable: false, crossedSubmissionBoundary: false,
      backendCode, safeMessage: phase === "rejected" ? "This input was not sent. Restore it to send it again." : "Pi did not use the submitted input." });
  }
  async #retireUndispatchedIntent(record: PiNativeOperationRecord, intent: PiManagedOperation): Promise<PiManagedOperation> {
    this.#assert();
    const operationId = intent.input.operationId;
    const current = this.driver.options.operations.getOperation(this.input.scope, this.binding.applicationThreadId, operationId);
    if (!current || current.dispatchStarted || !["sent", "unknown"].includes(current.state) ||
      current.requestHash !== record.requestHash || current.prepareAttempt !== record.prepareAttempt || intent.phase !== "intent")
      throw reject("pi_native_submission_unresolved", undefined, true);
    const preparation = await this.#outcome(`${operationId}:prepare:${current.prepareAttempt}`);
    if (preparation?.status === "failed" && preparation.failure.delivery !== "sent_outcome_unknown")
      throw reject("pi_native_submission_unresolved", "Pi did not establish ownership of this native input intent.", true);
    const result = await companion(this.port, this.attachment, { type: "complete_submission", operationId, disposition: "rejected" },
      `${operationId}:complete`, this.#lifetime.signal).catch(cause => { throw nativeUnknownFailure(cause); });
    const settled = matchingSubmission(result, operationId, intent.input.reconciliationToken);
    if (!settled || fingerprint(settled.input) !== fingerprint(intent.input) || !["accepted", "lost", "rejected"].includes(settled.phase))
      throw reject("pi_native_submission_evidence_mismatch", undefined, true);
    this.#record(operationId, "completed", settled);
    await this.#acknowledge(this.#submissionOperationIds(operationId));
    return settled;
  }
  async reconcileSubmission(operationId: string, reconciliationToken?: string): Promise<SubmissionReconciliation> {
    // A still-running prepare may legitimately proceed to dispatch. Decide
    // whether it can be withdrawn only after that send has settled.
    const operation = this.#sending.then(async () => {
      this.#assert();
      const record = this.driver.options.operations.getOperation(this.input.scope, this.binding.applicationThreadId, operationId);
      if (!record || record.state === "prepared") return { status: "not_accepted", retryable: true } as const;
      if (record.state === "completed" && record.receiptJson) {
        const receipt = object(JSON.parse(record.receiptJson));
        if (receipt.outcome === "not_applied") return { status: "not_accepted", retryable: false } as const;
        const saved = matchingSubmission(receipt, operationId, reconciliationToken);
        if (saved) return submissionReconciliation(saved, operationId);
      }
      const evidence = matchingSubmission(await companion(this.port, this.attachment, { type: "get_submission", operationId }), operationId, reconciliationToken);
      if (!record.dispatchStarted && evidence?.phase === "intent")
        return submissionReconciliation(await this.#retireUndispatchedIntent(record, evidence), operationId);
      if (evidence && ["accepted", "lost", "rejected"].includes(evidence.phase)) {
        this.#record(operationId, "completed", evidence);
        await this.#acknowledge(this.#submissionOperationIds(operationId));
      }
      return submissionReconciliation(evidence ?? {}, operationId);
    });
    this.#sending = operation.then(() => undefined, () => undefined);
    return operation;
  }
  #prepare(operationId: string, kind: "action" | "interrupt", request: unknown): PiNativeOperationRecord {
    return this.driver.options.operations.prepareOperation(this.input.scope, this.binding.applicationThreadId,
      { operationId, kind, requestHash: fingerprint(request) });
  }
  #operationPhase(operationId: string): NativeMutationPhase {
    const record = this.driver.options.operations.getOperation(this.input.scope, this.binding.applicationThreadId, operationId);
    if (!record || record.state === "prepared") return "preflight";
    const receipt = record.receiptJson ? object(JSON.parse(record.receiptJson)) : {};
    return record.state === "completed" && (receipt.outcome === "not_applied" || receipt.phase === "rejected" || receipt.phase === "lost") ? "not_applied" : "dispatched";
  }
  async #guardMutation<T>(operationId: string, operation: (boundary: NativeMutationBoundary) => Promise<T>): Promise<T> {
    // Auxiliary requests own their uncertainty independently. Only dispatch of
    // this operation (including an earlier attempt) crosses its boundary.
    const boundary = { phase: this.#operationPhase(operationId) };
    try { return await operation(boundary); }
    catch (cause) {
      const failure = cause instanceof PiNativeError ? nativeFailure(cause) : cause;
      if (!(failure instanceof BackendError)) throw cause;
      if (boundary.phase === "dispatched" && !failure.crossedSubmissionBoundary) throw nativeUnknownFailure(cause);
      if (boundary.phase !== "dispatched" && failure.crossedSubmissionBoundary)
        throw new BackendError({ category: "unavailable", retryable: true, crossedSubmissionBoundary: false,
          backendCode: failure.backendCode, safeMessage: boundary.phase === "preflight"
            ? "Pi could not finish preparing this operation. The operation was not sent."
            : "Pi confirmed this operation was not applied." }, { cause });
      throw failure;
    }
  }
  #record(operationId: string, state: PiNativeOperationRecord["state"], receipt?: unknown): void {
    this.driver.options.operations.completeOperation(this.input.scope, this.binding.applicationThreadId, operationId,
      { state, ...(receipt === undefined ? {} : { receiptJson: JSON.stringify(receipt) }) });
  }
  async #outcome(operationId: string) {
    const record = this.driver.options.operations.getOperation(this.input.scope, this.binding.applicationThreadId, operationId)
      ?? this.driver.options.operations.getOperation(this.input.scope, this.binding.applicationThreadId,
        nativeOperationBase(operationId));
    const outcomes = record?.receiptJson ? object(object(JSON.parse(record.receiptJson)).nativeOutcomes) : {};
    const retained = Object.hasOwn(outcomes, operationId) ? outcomes[operationId] : undefined;
    if (retained) return piNativeOutcomeSchema.parse(retained);
    return this.port.outcome({ handleId: this.attachment.handleId, operationId }).catch(() => undefined);
  }
  async #preserveClosedOutcomes(): Promise<void> {
    for (const id of [...this.#retainedOperationIds]) {
      const exact = this.driver.options.operations.getOperation(this.input.scope, this.binding.applicationThreadId, id);
      const operationId = exact ? id : nativeOperationBase(id);
      const record = exact ?? this.driver.options.operations.getOperation(this.input.scope, this.binding.applicationThreadId, operationId);
      // An unknown caller's receipt must remain with the host; only exact
      // scoped application operations can be transferred to durable storage.
      if (!record) continue;
      if (record.state !== "completed") {
        const outcome = piNativeOutcomeSchema.parse(await nativeCall(() => this.port.outcome({ handleId: this.attachment.handleId, operationId: id })));
        if (outcome.status === "pending") continue;
        const attempt = preparationAttempt(id, operationId);
        if (attempt === record.prepareAttempt && !record.dispatchStarted && (record.state === "sent" || record.state === "unknown") &&
          outcome.status === "failed" && outcome.failure.delivery === "rejected" && preparationRejectionCodes.has(outcome.failure.code)) {
          this.#record(operationId, "completed", { outcome: "not_applied" });
          await this.#acknowledge([id]); continue;
        }
        if (attempt !== undefined && outcome.status === "failed" && outcome.failure.delivery === "not_sent" &&
          (attempt < record.prepareAttempt || (attempt === record.prepareAttempt && record.state === "sent"))) {
          if (attempt === record.prepareAttempt) this.driver.options.operations.resetUnsentOperation(this.input.scope, this.binding.applicationThreadId, operationId, record.requestHash, attempt);
          await this.#acknowledge([id]); continue;
        }
        const receipt = record.receiptJson ? object(JSON.parse(record.receiptJson)) : {};
        const retained = object(receipt.nativeOutcomes);
        if (Object.hasOwn(retained, id) && JSON.stringify(retained[id]) !== JSON.stringify(outcome)) throw reject("pi_native_retained_outcome_conflict", undefined, true);
        this.#record(operationId, "unknown", { ...receipt, nativeOutcomes: { ...retained, [id]: outcome } });
      }
      await this.#acknowledge([id]);
    }
  }
  #submissionOperationIds(operationId: string): string[] {
    const record = this.driver.options.operations.getOperation(this.input.scope, this.binding.applicationThreadId, operationId);
    return [...new Set([
      ...(record ? [`${operationId}:prepare:${record.prepareAttempt}`] : []),
      `${operationId}:dispatch`, `${operationId}:complete`,
      ...[...this.#retainedOperationIds].filter(id => preparationAttempt(id, operationId) !== undefined),
    ])];
  }
  async #acknowledge(ids: readonly string[]): Promise<void> {
    // Durable receipts already prove the result. A lost cleanup reply cannot undo it.
    for (const operationId of ids) {
      try { await this.port.acknowledgeOperation({ handleId: this.attachment.handleId, operationId }); this.#retainedOperationIds.delete(operationId); }
      catch (cause) {
        if (cause instanceof PiNativeError && ["pi_native_operation_unknown", "pi_native_operation_acknowledged"].includes(cause.code)) this.#retainedOperationIds.delete(operationId);
        else this.#retainedOperationIds.add(operationId);
      }
    }
  }
  #completedOutcome(record: PiNativeOperationRecord): "accepted" | "not_applied" {
    return record.receiptJson && object(JSON.parse(record.receiptJson)).outcome === "not_applied" ? "not_applied" : "accepted";
  }
  #throwNegativeReceipt(record: PiNativeOperationRecord): void {
    if (this.#completedOutcome(record) === "not_applied") throw reject("pi_native_operation_not_applied", "Pi rejected this operation.");
  }
  async #finishRejection(operationId: string, ids: readonly string[], cause: unknown): Promise<never> {
    if (cause instanceof BackendError && !cause.crossedSubmissionBoundary) {
      this.#record(operationId, "completed", { outcome: "not_applied" });
      await this.#acknowledge(ids);
    }
    throw cause;
  }
  async interrupt(input: InterruptConversationInput): Promise<void> {
    this.#controlStopsInFlight++;
    try { await this.#interrupt(input); }
    catch (cause) { this.#replaceUnavailableControl(cause); throw cause; }
    finally { this.#controlStopsInFlight--; }
    this.#replaceRecoveredControl(true);
  }
  async #interrupt(input: InterruptConversationInput): Promise<void> {
    this.#assert();
    const prior = this.#prepare(input.applicationOperationId, "interrupt", { deadlineAt: input.deadlineAt });
    if (prior.state === "completed") {
      void this.#acknowledge(["begin", "clear", "abort", "end"].map(suffix => `${input.applicationOperationId}:${suffix}`));
      this.#throwNegativeReceipt(prior); return;
    }
    if (prior.state !== "prepared") throw reject("pi_native_stop_unresolved", undefined, true);
    await this.#interrupts.execute(input, this.#lifetime.signal, async (budget) => {
      budget.dispatch(); this.#record(input.applicationOperationId, "sent");
      await budget.wait(companion(this.port, this.attachment, { type: "begin_stop" }, `${input.applicationOperationId}:begin`, budget.signal))
        .catch(cause => this.#finishRejection(input.applicationOperationId, [`${input.applicationOperationId}:begin`], cause));
      if (this.#controlOnly) {
        this.#agentTools?.close();
        for (const controller of this.#clientAuthorities.keys()) controller.abort();
        this.#clientAuthorities.clear();
      }
      try {
      await budget.wait(rpc(this.port, this.attachment, { type: "clear_queue" }, `${input.applicationOperationId}:clear`, budget.signal));
      await budget.wait(rpc(this.port, this.attachment, { type: "abort" }, `${input.applicationOperationId}:abort`, budget.signal));
      await budget.wait(companion(this.port, this.attachment, { type: "end_stop" }, `${input.applicationOperationId}:end`, budget.signal));
      if (this.#controlOnly) this.#controlStopConfirmed = true;
      this.#record(input.applicationOperationId, "completed", { outcome: "accepted" });
      // Acceptance is durable. Cleanup catches failures and remains retryable;
      // native events refresh projection independently of the Stop deadline.
      void this.#acknowledge(["begin", "clear", "abort", "end"].map(suffix => `${input.applicationOperationId}:${suffix}`));
      } catch (cause) {
        if (cause instanceof BackendError && !cause.crossedSubmissionBoundary) throw reject(cause.backendCode ?? "pi_native_stop_unresolved", cause.safeMessage, true);
        throw cause;
      }
    });
  }
  #replaceRecoveredControl(confirmedStop = false): void {
    if (!this.#controlOnly || this.#recoveryReplacementRequested || this.#controlStopsInFlight) return;
    if (!confirmedStop && this.#controlNativeIdle === false) return;
    // Closing a handle closes its local tool bridge. Native idle alone must
    // not cancel an unresolved Sedes call; only explicit Stop may do that.
    if (!confirmedStop && this.#agentTools?.hasPendingCalls()) return;
    const idle = this.#state.isIdle === true || (confirmedStop && this.#controlStopConfirmed);
    const changed = this.driver.requestControlRecovery(this.attachment, {
      isIdle: this.#state.isIdle, leafId: this.#state.leafId, operations: this.#state.operations,
    }, idle);
    if (!idle || (!changed && !confirmedStop)) return;
    if (confirmedStop) for (const id of this.#interactions.keys()) this.#settleInteraction(id);
    this.#requestControlReplacement();
  }
  #replaceUnavailableControl(cause: unknown): void {
    if (!this.#controlOnly || !unavailableControl(cause) || this.#recoveryReplacementRequested) return;
    this.#requestControlReplacement();
  }
  #requestControlReplacement(): void {
    this.#recoveryReplacementRequested = true;
    this.#emit({ type: "resnapshot_required", reason: "provider_handle_closed" });
  }
  async reconcileInterrupt(input: InterruptConversationInput): Promise<BackendMutationReconciliation> {
    this.#controlStopsInFlight++;
    let result: BackendMutationReconciliation;
    try { result = await this.#reconcileInterrupt(input); }
    catch (cause) { this.#replaceUnavailableControl(cause); throw cause; }
    finally { this.#controlStopsInFlight--; }
    if (result.outcome === "accepted") this.#replaceRecoveredControl(true);
    return result;
  }
  async #reconcileInterrupt(input: InterruptConversationInput): Promise<BackendMutationReconciliation> {
    this.#assert();
    const prior = this.#prepare(input.applicationOperationId, "interrupt", { deadlineAt: input.deadlineAt });
    if (prior.state === "completed") {
      const outcome = this.#completedOutcome(prior);
      return { outcome };
    }
    const result = await this.#outcome(`${input.applicationOperationId}:end`);
    if (result?.status === "completed") {
      if (this.#controlOnly) this.#controlStopConfirmed = true;
      this.#record(input.applicationOperationId, "completed", { outcome: "accepted" });
      void this.#acknowledge(["begin", "clear", "abort", "end"].map(suffix => `${input.applicationOperationId}:${suffix}`));
      return { outcome: "accepted" };
    }
    return this.#interrupts.reconcile(input);
  }
  async perform(input: RegisteredBackendActionInput): Promise<BackendActionResult> {
    return this.#guardMutation(input.applicationOperationId, boundary => this.#perform(input, boundary));
  }
  async #perform(input: RegisteredBackendActionInput, boundary: NativeMutationBoundary): Promise<BackendActionResult> {
    this.#assertMutation();
    const prior = this.#prepare(input.applicationOperationId, "action", input);
    if (prior.state === "completed" && prior.receiptJson) {
      await this.#acknowledge(input.action === "set_tool_access" ? [`${input.applicationOperationId}:policy`, `${input.applicationOperationId}:tools`] : [input.applicationOperationId]);
      this.#throwNegativeReceipt(prior); return JSON.parse(prior.receiptJson) as BackendActionResult;
    }
    if (prior.state !== "prepared") throw reject("pi_native_action_unresolved", undefined, true);
    await this.#refresh(false);
    if (this.#state.isIdle !== true) throw reject("pi_native_settings_busy");
    if (input.action === "set_tool_access") {
      if (!["read_only", "ask", "full"].includes(input.mode)) throw reject("pi_native_tool_mode_invalid");
      try { await this.#applyToolPolicy(input.mode as PiNativeSettings["toolMode"], input.applicationOperationId, boundary); }
      catch (cause) {
        if (boundary.phase === "not_applied")
          return this.#finishRejection(input.applicationOperationId, [`${input.applicationOperationId}:policy`, `${input.applicationOperationId}:tools`], cause);
        if (boundary.phase === "dispatched") {
          const policy = await this.#outcome(`${input.applicationOperationId}:policy`);
          if (policy?.status === "failed" && policy.failure.delivery !== "sent_outcome_unknown") {
            boundary.phase = "not_applied";
            return this.#finishRejection(input.applicationOperationId, [`${input.applicationOperationId}:policy`, `${input.applicationOperationId}:tools`], nativeFailure(policy.failure));
          }
        }
        throw cause;
      }
      this.#settings = { ...this.#settings, toolMode: input.mode as PiNativeSettings["toolMode"], revision: this.#settings.revision + 1 };
    } else {
      let command: Record<string, unknown>;
      if (input.action === "rename") command = { type: "set_session_name", name: input.title };
      else if (input.action === "compact") command = { type: "compact", ...(input.instructions ? { customInstructions: input.instructions } : {}) };
      else if (input.action === "set_model") {
        if (!this.driver.options.modelPolicy.isSelectionAllowed({ providerId: input.provider, modelId: input.modelId, reasoningEffort: string(this.#state.thinkingLevel) ?? "off" })) throw reject("pi_native_model_policy_denied");
        command = { type: "set_model", provider: input.provider, modelId: input.modelId };
      } else {
        const model = object(this.#state.model);
        if (!this.driver.options.modelPolicy.isSelectionAllowed({ providerId: string(model.provider), modelId: string(model.id) ?? "", reasoningEffort: input.level })) throw reject("pi_native_model_policy_denied");
        command = { type: "set_thinking_level", level: input.level };
      }
      this.#record(input.applicationOperationId, "sent");
      boundary.phase = "dispatched";
      await rpc(this.port, this.attachment, command, input.applicationOperationId, this.#lifetime.signal, input.action === "compact" ? null : undefined)
        .catch(cause => {
          if (cause instanceof BackendError && !cause.crossedSubmissionBoundary) boundary.phase = "not_applied";
          return this.#finishRejection(input.applicationOperationId, [input.applicationOperationId], cause);
        });
    }
    await this.#refresh(true);
    if ((input.action === "set_model" && (object(this.#state.model).provider !== input.provider || object(this.#state.model).id !== input.modelId)) ||
        (input.action === "set_thinking_level" && this.#state.thinkingLevel !== input.level))
      throw reject("pi_native_settings_not_applied", "Pi did not apply the requested setting.", true);
    const document = capabilities(this.#settings, this.#state, Boolean(this.driver.options.outputArtifacts));
    const result = { accepted: true as const, capabilityRevision: document.revision };
    this.#record(input.applicationOperationId, "completed", result);
    await this.#acknowledge(input.action === "set_tool_access" ? [`${input.applicationOperationId}:policy`, `${input.applicationOperationId}:tools`] : [input.applicationOperationId]);
    this.#emit({ type: "capabilities_changed", capabilities: document });
    this.driver.options.settings.syncObserved?.(this.input.scope, this.binding.applicationThreadId, document.effectiveSettings);
    return result;
  }
  async reconcileAction(input: RegisteredBackendActionInput): Promise<BackendMutationReconciliation> {
    return this.#guardMutation(input.applicationOperationId, boundary => this.#reconcileAction(input, boundary));
  }
  async #reconcileAction(input: RegisteredBackendActionInput, boundary: NativeMutationBoundary): Promise<BackendMutationReconciliation> {
    this.#assert();
    const prior = this.#prepare(input.applicationOperationId, "action", input);
    if (prior.state === "completed") return { outcome: this.#completedOutcome(prior) };
    if (prior.state === "prepared") return { outcome: "not_applied" };
    const ids = input.action === "set_tool_access" ? [`${input.applicationOperationId}:policy`, `${input.applicationOperationId}:tools`] : [input.applicationOperationId];
    const outcomes = await Promise.all(ids.map(operationId => this.#outcome(operationId)));
    if (outcomes.every(result => result?.status === "completed")) {
      boundary.phase = "dispatched";
      if (input.action === "set_tool_access") this.#settings = { ...this.#settings, toolMode: input.mode as PiNativeSettings["toolMode"] };
      await this.#refresh(true);
      this.#record(input.applicationOperationId, "completed", { accepted: true, capabilityRevision: capabilities(this.#settings, this.#state, Boolean(this.driver.options.outputArtifacts)).revision });
      await this.#acknowledge(ids);
      return { outcome: "accepted" };
    }
    if (outcomes.every(result => result?.status === "failed" && result.failure.delivery !== "sent_outcome_unknown")) {
      this.#record(input.applicationOperationId, "completed", { outcome: "not_applied" });
      await this.#acknowledge(ids); return { outcome: "not_applied" };
    }
    return { outcome: "unknown" };
  }
  async respond(input: InteractionResponseInput): Promise<void> {
    this.#assertMutation();
    const prior = this.#prepare(input.applicationOperationId, "action", input);
    if (prior.state === "completed") {
      await this.#acknowledge([input.applicationOperationId]); this.#throwNegativeReceipt(prior);
      this.#settleInteraction(input.interactionId); return;
    }
    if (prior.state !== "prepared") throw reject("pi_native_interaction_unresolved", undefined, true);
    const interaction = this.#interactions.get(input.interactionId);
    if (!interaction) throw reject("pi_native_interaction_stale");
    if (interaction.kind === "decision") {
      if (input.kind !== "decision" && input.kind !== "cancel") throw reject("pi_native_interaction_kind_mismatch");
      this.#record(input.applicationOperationId, "sent");
      await companion(this.port, this.attachment, { type: "resolve_tool_approval", id: input.interactionId,
        approved: input.kind === "decision" && input.selectedActionId === "approve" }, input.applicationOperationId)
        .catch(cause => this.#finishRejection(input.applicationOperationId, [input.applicationOperationId], cause));
    } else {
      let response: Record<string, unknown> = { type: "extension_ui_response", id: input.interactionId };
      if (input.kind === "cancel") response.cancelled = true;
      else if (input.kind === "confirmation" && interaction.kind === "confirmation") response.confirmed = input.confirmed;
      else if (input.kind === "choice" && interaction.kind === "choice") {
        const selected = interaction.options.find(option => option.backendOptionId === input.selectedOptionIds[0]);
        const value = selected && this.#choiceValues.get(input.interactionId)?.[Number(selected.backendOptionId)];
        if (value === undefined || input.selectedOptionIds.length !== 1) throw reject("pi_native_interaction_choice_invalid"); response.value = value;
      } else if ((input.kind === "text_input" && interaction.kind === "text_input") || (input.kind === "editor" && interaction.kind === "editor")) response.value = input.value;
      else throw reject("pi_native_interaction_kind_mismatch");
      this.#record(input.applicationOperationId, "sent");
      await rpc(this.port, this.attachment, response, input.applicationOperationId)
        .catch(cause => this.#finishRejection(input.applicationOperationId, [input.applicationOperationId], cause));
    }
    this.#record(input.applicationOperationId, "completed", { outcome: "accepted" });
    await this.#acknowledge([input.applicationOperationId]);
    this.#settleInteraction(input.interactionId);
  }
  #settleInteraction(interactionId: string): void {
    this.#choiceValues.delete(interactionId);
    if (this.#interactions.delete(interactionId)) this.#emit({ type: "interaction_resolved", backendInteractionId: interactionId });
  }
  async reconcileInteractionResponse(input: InteractionResponseInput): Promise<BackendMutationReconciliation> {
    this.#assert();
    const prior = this.#prepare(input.applicationOperationId, "action", input);
    if (prior.state === "completed") {
      const outcome = this.#completedOutcome(prior);
      if (outcome === "accepted") this.#settleInteraction(input.interactionId);
      return { outcome };
    }
    const result = await this.#outcome(input.applicationOperationId);
    if (result?.status === "completed") {
      this.#record(input.applicationOperationId, "completed", { outcome: "accepted" });
      await this.#acknowledge([input.applicationOperationId]);
      this.#settleInteraction(input.interactionId);
      return { outcome: "accepted" };
    }
    if (result?.status === "failed" && result.failure.delivery !== "sent_outcome_unknown") {
      this.#record(input.applicationOperationId, "completed", { outcome: "not_applied" });
      await this.#acknowledge([input.applicationOperationId]); return { outcome: "not_applied" };
    }
    return { outcome: "unknown" };
  }
  subscribe(listener: (event: BackendConversationEvent) => void): Unsubscribe {
    this.#assert(); this.#listeners.add(listener);
    if (this.#recoveryReplacementRequested) listener({ type: "resnapshot_required", reason: "provider_handle_closed" });
    for (const interaction of this.#interactions.values()) listener({ type: "interaction_opened", interaction });
    return () => this.#listeners.delete(listener);
  }
  retryCloseAfterStop(): Promise<void> { return this.close(); }
  async close(): Promise<void> {
    if (this.#cleanupComplete) return;
    if (this.#closing) return this.#closing;
    this.#closed = true; this.#lifetime.abort();
    const operation = (async () => {
      let cleanupSucceeded = false;
      let released = false;
      try {
        this.#agentTools?.close();
        for (const controller of this.#clientAuthorities.keys()) controller.abort(); this.#clientAuthorities.clear();
        this.#throughput.clear(); this.#measuredRequests.clear();
        await Promise.all([this.#watch, this.#controlWatch]); this.#projector?.close(); this.#listeners.clear(); this.#usageAccounting?.close();
        cleanupSucceeded = true;
      } finally {
        try { await this.port.release({ handleId: this.attachment.handleId }); forgetNativeObservations(this.port, this.attachment.handleId); released = true; }
        finally { this.release(cleanupSucceeded && released); }
      }
      this.#cleanupComplete = true;
    })();
    this.#closing = operation;
    try { await operation; } finally { if (this.#closing === operation) this.#closing = undefined; }
  }
}
