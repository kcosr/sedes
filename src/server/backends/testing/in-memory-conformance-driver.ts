import {
  backendConversationEventSchema,
  backendConversationSnapshotSchema,
  type BackendCapabilityDocument,
  type BackendConversationEvent,
  type BackendConversationSnapshot,
  type BackendItem,
  type BackendTurn,
  type SequencedBackendEvent,
} from "../../../shared/protocol/backend.js";
import type { UsageSnapshot } from "../../../shared/protocol/conversation.js";
import type { ContextExcerpt } from "../../../shared/protocol/context-excerpts.js";
import { boundText } from "../../conversations/payload-policy.js";
import type { ValidatedWorkspace } from "../../execution/contracts.js";
import {
  BackendError,
  type AgentBackendInstance,
  type AgentConnectionProfile,
  type AttachConversationInput,
  type BackendActionResult,
  type BackendMutationReconciliation,
  type BackendCatalog,
  type BackendCatalogContext,
  type BackendCheckpointRef,
  type BackendEventListener,
  type BackendHealth,
  type BackendHistoryPage,
  type BranchConversationInput,
  type ConversationBackendDriver,
  type ConversationBinding,
  type ConversationHandle,
  type ConversationReadResult,
  type CreateConversationInput,
  type CreateConversationResult,
  type DiscoverConversationsInput,
  type DiscoveredConversationPage,
  type EstablishProjectionInput,
  type EstablishedBackendProjection,
  type HistoryPageInput,
  type InteractionResponseInput,
  type InterruptTurnInput,
  type LocateTurnInput,
  type LocateTurnResult,
  type ReadConversationInput,
  type ReconcileSubmissionInput,
  type RegisteredBackendActionInput,
  type ResolveBranchCheckpointInput,
  type SteerTurnInput,
  type SteerTurnResult,
  type SubmissionReconciliation,
  type SubmitTurnInput,
  type SubmitTurnResult,
  type Unsubscribe,
} from "../contracts.js";
import {
  isValidSubmissionRetryAnchor,
  requireSubmissionRetryAnchor,
} from "../submission-retry-anchor.js";

interface InMemoryRetryAnchor {
  readonly version: 1;
  readonly historyRevision: number;
  readonly turnCount: number;
}

function parseRetryAnchor(
  value: string | undefined,
): InMemoryRetryAnchor | undefined {
  if (value === undefined) return undefined;
  if (!isValidSubmissionRetryAnchor(value)) {
    throw error(
      "rejected",
      "The submission retry anchor is invalid.",
      "memory_retry_anchor_invalid",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Object.keys(parsed).some(
      (key) =>
        key !== "version" && key !== "historyRevision" && key !== "turnCount",
    ) ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("historyRevision" in parsed) ||
    !Number.isSafeInteger(parsed.historyRevision) ||
    (parsed.historyRevision as number) < 0 ||
    !("turnCount" in parsed) ||
    !Number.isSafeInteger(parsed.turnCount) ||
    (parsed.turnCount as number) < 0
  ) {
    throw error(
      "rejected",
      "The submission retry anchor is invalid.",
      "memory_retry_anchor_invalid",
    );
  }
  return parsed as InMemoryRetryAnchor;
}

interface InMemoryConversation {
  readonly backendConversationId: string;
  readonly canonicalWorkspacePath: string;
  readonly opaqueBindingDetail: string;
  title?: string;
  updatedAt: string;
  snapshot: BackendConversationSnapshot;
  usage: UsageSnapshot;
  capabilityRevision: number;
  historyRevision: number;
  turnCounter: number;
  itemCounter: number;
  readonly completedInterruptOperations: Map<string, string>;
  readonly completedActionOperations: Map<
    string,
    { readonly fingerprint: string; readonly result: BackendActionResult }
  >;
  readonly handles: Set<InMemoryConversationHandle>;
}

interface StoredCheckpoint {
  readonly sourceConversationId: string;
  readonly snapshot: BackendConversationSnapshot;
  readonly usage: UsageSnapshot;
}

interface StoredCreation {
  readonly kind: "create" | "branch";
  readonly canonicalWorkspacePath: string;
  readonly result: CreateConversationResult;
}

interface StoredSubmission {
  readonly backendConversationId: string;
  readonly applicationOperationId: string;
  readonly kind: "submit" | "steer";
  readonly mutationId: string;
  readonly inputFingerprint: string;
  readonly result: SubmitTurnResult | SteerTurnResult;
  readonly backendTurnId: string;
}

function submissionInputFingerprint(
  kind: "submit" | "steer",
  input: SubmitTurnInput | SteerTurnInput,
): string {
  return JSON.stringify([
    kind,
    input.mutationId,
    input.reconciliationToken,
    input.text,
    input.selectedSkillId ?? null,
    input.contextExcerpts,
    input.attachments,
    input.taskContexts,
    kind === "steer" ? (input as SteerTurnInput).target : null,
  ]);
}

interface StoredReconciliation {
  readonly applicationOperationId: string;
  readonly canonicalWorkspacePath: string;
  readonly backendConversationId?: string;
  readonly backendTurnId?: string;
  result: SubmissionReconciliation;
}

export interface InMemoryConformanceDriverOptions {
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly now?: () => string;
  readonly maximumProjectionBufferEvents?: number;
  readonly uncertainSubmissionOperationIds?: readonly string[];
  /**
   * Test-only capability projection for import/read browser journeys. Direct
   * fixture setup may still seed history before the application attaches.
   */
  readonly interactionMode?: "interactive" | "read_only";
  /**
   * Test-only deterministic output used by browser journeys. Conformance
   * tests leave this disabled and retain explicit control over terminal state.
   */
  readonly scriptedResponses?: {
    readonly stepDelayMilliseconds?: number;
  };
}

const maximumSnapshotTurns = 100;
const defaultMaximumProjectionBufferEvents = 512;

const supportedActions = [
  "rename",
  "compact",
  "set_model",
  "set_thinking_level",
  "set_tool_access",
] as const;

const defaultUsage: UsageSnapshot = {
  context: { usedTokens: 0, windowTokens: 128_000, percent: 0 },
  tokens: { input: 0, output: 0, total: 0 },
  cost: { amount: 0, currency: "USD" },
  counters: { requests: 0, toolCalls: 0, compactions: 0 },
};

function emptySnapshot(): BackendConversationSnapshot {
  return {
    orderedBackendTurnIds: [],
    turnsById: {},
    itemsById: {},
    runState: "idle",
  };
}

function cloneRecentSnapshot(
  snapshot: BackendConversationSnapshot,
): BackendConversationSnapshot {
  const orderedBackendTurnIds =
    snapshot.orderedBackendTurnIds.slice(-maximumSnapshotTurns);
  const included = new Set(orderedBackendTurnIds);
  return backendConversationSnapshotSchema.parse({
    orderedBackendTurnIds,
    turnsById: Object.fromEntries(
      orderedBackendTurnIds.map((id) => [
        id,
        structuredClone(snapshot.turnsById[id]!),
      ]),
    ),
    itemsById: Object.fromEntries(
      Object.entries(snapshot.itemsById)
        .filter(([, item]) => included.has(item.backendTurnId))
        .map(([id, item]) => [id, structuredClone(item)]),
    ),
    runState: snapshot.runState,
    ...(snapshot.activeBackendTurnId
      ? { activeBackendTurnId: snapshot.activeBackendTurnId }
      : {}),
  });
}

function snapshotThroughCompletedTurn(
  snapshot: BackendConversationSnapshot,
  backendTurnId: string,
): BackendConversationSnapshot {
  const index = snapshot.orderedBackendTurnIds.indexOf(backendTurnId);
  const selected = snapshot.turnsById[backendTurnId];
  if (
    index < 0 ||
    selected?.status !== "completed" ||
    selected.endedBy !== "agent_settled"
  ) {
    throw error(
      "invalid_state",
      "The selected turn is not a completed branch boundary.",
      "memory_checkpoint_turn_unavailable",
    );
  }
  const orderedBackendTurnIds = snapshot.orderedBackendTurnIds.slice(
    0,
    index + 1,
  );
  const included = new Set(orderedBackendTurnIds);
  return backendConversationSnapshotSchema.parse({
    orderedBackendTurnIds,
    turnsById: Object.fromEntries(
      orderedBackendTurnIds.map((id) => [id, snapshot.turnsById[id]!]),
    ),
    itemsById: Object.fromEntries(
      Object.entries(snapshot.itemsById).filter(([, item]) =>
        included.has(item.backendTurnId),
      ),
    ),
    runState: "idle",
  });
}

function cloneUsage(usage: UsageSnapshot): UsageSnapshot {
  return structuredClone(usage);
}

function error(
  category:
    | "internal"
    | "invalid_state"
    | "not_found"
    | "permission_denied"
    | "rejected"
    | "submission_unknown"
    | "unavailable",
  safeMessage: string,
  backendCode: string,
  retryable = false,
  crossedSubmissionBoundary = false,
): BackendError {
  return new BackendError({
    category,
    safeMessage,
    backendCode,
    retryable,
    crossedSubmissionBoundary,
  });
}

function parseOffset(cursor: string | undefined, maximum: number): number {
  if (cursor === undefined) {
    return 0;
  }
  const match = /^offset:(\d+)$/.exec(cursor);
  const offset = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximum) {
    throw error(
      "rejected",
      "The backend cursor is invalid.",
      "memory_cursor_invalid",
    );
  }
  return offset;
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw error(
      "rejected",
      "The requested page size is invalid.",
      "memory_page_limit_invalid",
    );
  }
}

function parseHistoryCursor(
  cursor: string | undefined,
  record: InMemoryConversation,
): number {
  if (cursor === undefined) {
    return record.snapshot.orderedBackendTurnIds.length;
  }
  const match = /^history:([^:]+):(\d+):(\d+)$/.exec(cursor);
  const revision = match ? Number(match[2]) : Number.NaN;
  const before = match ? Number(match[3]) : Number.NaN;
  let backendConversationId: string | undefined;
  try {
    backendConversationId = match ? decodeURIComponent(match[1]!) : undefined;
  } catch {
    backendConversationId = undefined;
  }
  if (
    !match ||
    backendConversationId !== record.backendConversationId ||
    revision !== record.historyRevision ||
    !Number.isSafeInteger(before) ||
    before < 0 ||
    before > record.snapshot.orderedBackendTurnIds.length
  ) {
    throw error(
      "rejected",
      "The backend history cursor is invalid or stale.",
      "memory_history_cursor_invalid",
    );
  }
  return before;
}

function capabilities(
  revision: number,
  interactionMode: "interactive" | "read_only",
): BackendCapabilityDocument {
  if (interactionMode === "read_only") {
    return {
      revision: `memory-capabilities:${revision}:read-only`,
      actions: [],
      deliveryModes: [],
      steerTarget: null,
      composerAttachments: { fileStaging: false, nativeImage: false },
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      supportsHistory: true,
      branching: {
        availability: "unavailable",
        reason: { text: "This connection is read-only." },
      },
      interactionKinds: [],
      usageSections: ["context", "tokens", "cost", "counters"],
      effectiveSettings: {},
    };
  }
  return {
    revision: `memory-capabilities:${revision}`,
    actions: [...supportedActions],
    deliveryModes: ["submit", "steer"],
    steerTarget: "turn",
    composerAttachments: { fileStaging: true, nativeImage: true },
    nonblockingQuestions: false,
    providerOutputArtifacts: { nativeImage: false },
    supportsHistory: true,
    branching: {
      availability: "available",
      boundaries: ["latest_completed", "selected_completed_turn"],
      method: "provider_native",
      sourceMustBeIdle: false,
      settingsInheritance: "application_applied",
      fidelity: {
        instructions: true,
        messages: true,
        toolCalls: true,
        toolResults: true,
        compaction: true,
        attachments: true,
        settings: true,
        limitations: [],
      },
      childIdentity: "application_reserved",
      creationRecovery: "idempotent",
    },
    interactionKinds: [],
    usageSections: ["context", "tokens", "cost", "counters"],
    effectiveSettings: {},
  };
}

function operationResult(turn?: BackendTurn): SubmissionReconciliation {
  return {
    status: "accepted",
    ...(turn ? { backendTurn: structuredClone(turn) } : {}),
    ...(turn?.status === "completed" ||
    turn?.status === "interrupted" ||
    turn?.status === "failed"
      ? { completionIdentity: `${turn.backendTurnId}:${turn.status}` }
      : {}),
  };
}

function projectionCancellationCheckpoint(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      error(
        "unavailable",
        "Backend projection establishment was cancelled.",
        "memory_projection_aborted",
        true,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      reject(
        error(
          "unavailable",
          "Backend projection establishment was cancelled.",
          "memory_projection_aborted",
          true,
        ),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    queueMicrotask(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}

export class InMemoryConformanceDriver implements ConversationBackendDriver {
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly #now: () => string;
  readonly #maximumProjectionBufferEvents: number;
  readonly #uncertainSubmissionOperationIds: ReadonlySet<string>;
  readonly #interactionMode: "interactive" | "read_only";
  readonly #scriptedResponseStepDelayMilliseconds?: number;
  readonly #conversations = new Map<string, InMemoryConversation>();
  readonly #creationOperations = new Map<string, StoredCreation>();
  readonly #submissionOperations = new Map<string, StoredSubmission>();
  readonly #reconciliations = new Map<string, StoredReconciliation>();
  readonly #checkpoints = new Map<string, StoredCheckpoint>();
  #conversationCounter = 0;
  #tokenCounter = 0;
  #checkpointCounter = 0;

  constructor(options: InMemoryConformanceDriverOptions) {
    this.instance = options.instance;
    this.connection = options.connection;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#maximumProjectionBufferEvents =
      options.maximumProjectionBufferEvents ??
      defaultMaximumProjectionBufferEvents;
    this.#uncertainSubmissionOperationIds = new Set(
      options.uncertainSubmissionOperationIds ?? [],
    );
    this.#interactionMode = options.interactionMode ?? "interactive";
    if (options.scriptedResponses) {
      const delay = options.scriptedResponses.stepDelayMilliseconds ?? 250;
      if (!Number.isSafeInteger(delay) || delay < 10 || delay > 10_000) {
        throw new Error("memory_driver_script_delay_invalid");
      }
      this.#scriptedResponseStepDelayMilliseconds = delay;
    }
    if (
      !Number.isSafeInteger(this.#maximumProjectionBufferEvents) ||
      this.#maximumProjectionBufferEvents <= 0
    ) {
      throw new Error("memory_driver_projection_buffer_limit_invalid");
    }
    if (
      this.instance.id !== this.connection.backendInstanceId ||
      this.instance.tenantId !== this.connection.tenantId
    ) {
      throw new Error("memory_driver_configuration_mismatch");
    }
  }

  async health(): Promise<BackendHealth> {
    return { available: true, checkedAt: this.#now() };
  }

  async catalog(context: BackendCatalogContext): Promise<BackendCatalog> {
    this.#assertScope(context.scope);
    this.#assertWorkspace(context.workspace);
    return {
      models: [
        {
          provider: "memory",
          id: "conformance-model",
          label: "Conformance model",
          inputModalities: ["text", "image"],
        },
      ],
      commands: [
        {
          invocation: "/compact",
          source: "prompt",
          description: "Compact the in-memory conversation",
        },
      ],
      skills: [],
      notices: [],
    };
  }

  async discover(
    input: DiscoverConversationsInput,
  ): Promise<DiscoveredConversationPage> {
    if (input.signal.aborted) throw input.signal.reason;
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    validateLimit(input.limit);
    const matches = [...this.#conversations.values()]
      .filter(
        ({ canonicalWorkspacePath }) =>
          canonicalWorkspacePath === input.workspace.canonicalPath,
      )
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.backendConversationId.localeCompare(right.backendConversationId),
      );
    const offset = parseOffset(input.cursor, matches.length);
    const page = matches.slice(offset, offset + input.limit);
    const nextOffset = offset + page.length;
    return {
      conversations: page.map((record) => ({
        backendConversationId: record.backendConversationId,
        canonicalWorkspacePath: record.canonicalWorkspacePath,
        ...(record.title ? { title: record.title } : {}),
        updatedAt: record.updatedAt,
        opaqueBindingDetail: record.opaqueBindingDetail,
      })),
      ...(nextOffset < matches.length
        ? { nextCursor: `offset:${nextOffset}` }
        : {}),
    };
  }

  async create(
    input: CreateConversationInput,
  ): Promise<CreateConversationResult> {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    const existing = this.#creationOperations.get(input.applicationOperationId);
    if (existing) {
      if (
        existing.kind !== "create" ||
        existing.canonicalWorkspacePath !== input.workspace.canonicalPath
      ) {
        throw error(
          "invalid_state",
          "The creation operation is already associated with another origin.",
          "memory_creation_operation_conflict",
        );
      }
      return structuredClone(existing.result);
    }
    const id =
      input.requestedBackendConversationId ??
      `memory-conversation-${++this.#conversationCounter}`;
    if (!id || id.length > 512 || this.#conversations.has(id)) {
      throw error(
        "invalid_state",
        "The requested backend conversation already exists or is invalid.",
        "memory_conversation_identity_conflict",
      );
    }
    const result = this.#createRecord({
      id,
      workspace: input.workspace,
      title: input.title,
      snapshot: emptySnapshot(),
      usage: defaultUsage,
      applicationOperationId: input.applicationOperationId,
    });
    return structuredClone(result);
  }

  async attach(input: AttachConversationInput): Promise<ConversationHandle> {
    const record = this.#resolveBoundConversation(
      input.scope,
      input.binding,
      input.workspace,
      input.opaqueBindingDetail,
    );
    const handle = new InMemoryConversationHandle(
      this,
      record,
      input.binding,
      this.#maximumProjectionBufferEvents,
    );
    record.handles.add(handle);
    return handle;
  }

  async read(input: ReadConversationInput): Promise<ConversationReadResult> {
    const record = this.#resolveBoundConversation(
      input.scope,
      input.binding,
      input.workspace,
      input.opaqueBindingDetail,
    );
    return {
      snapshot: cloneRecentSnapshot(record.snapshot),
      usage: cloneUsage(record.usage),
    };
  }

  async resolveBranchCheckpoint(
    input: ResolveBranchCheckpointInput,
  ): Promise<BackendCheckpointRef> {
    if (input.selection.kind === "latest_provider_snapshot") {
      throw error(
        "invalid_state",
        "This backend does not support provider-snapshot forks.",
        "memory_provider_snapshot_fork_unsupported",
      );
    }
    const record = this.#resolveBoundConversation(
      input.scope,
      input.binding,
      input.workspace,
      input.opaqueBindingDetail,
    );
    const opaqueReference = `memory-checkpoint-${++this.#checkpointCounter}`;
    const selectedBackendTurnId =
      input.selection.kind === "selected_completed_turn"
        ? input.selection.backendTurnId
        : record.snapshot.orderedBackendTurnIds.findLast((backendTurnId) => {
            const turn = record.snapshot.turnsById[backendTurnId];
            return (
              turn?.status === "completed" && turn.endedBy === "agent_settled"
            );
          });
    if (!selectedBackendTurnId) {
      throw error(
        "invalid_state",
        "No completed branch boundary is available.",
        "memory_checkpoint_turn_unavailable",
      );
    }
    const checkpointSnapshot = snapshotThroughCompletedTurn(
      record.snapshot,
      selectedBackendTurnId,
    );
    this.#checkpoints.set(opaqueReference, {
      sourceConversationId: record.backendConversationId,
      snapshot: checkpointSnapshot,
      usage: cloneUsage(record.usage),
    });
    return {
      backendInstanceId: this.instance.id,
      kind: "conversation_leaf",
      opaqueReference,
    };
  }

  async branchConversation(
    input: BranchConversationInput,
  ): Promise<CreateConversationResult> {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    this.#resolveBinding(input.sourceBinding);
    if (
      input.sourceCheckpoint.backendInstanceId !== this.instance.id ||
      input.sourceCheckpoint.kind !== "conversation_leaf"
    ) {
      throw error(
        "permission_denied",
        "The checkpoint belongs to a different backend.",
        "memory_checkpoint_scope_mismatch",
      );
    }
    const checkpoint = this.#checkpoints.get(
      input.sourceCheckpoint.opaqueReference,
    );
    if (
      !checkpoint ||
      checkpoint.sourceConversationId !==
        input.sourceBinding.backendConversationId
    ) {
      throw error(
        "not_found",
        "The requested backend checkpoint was not found.",
        "memory_checkpoint_not_found",
      );
    }
    const existing = this.#creationOperations.get(input.applicationOperationId);
    if (existing) {
      if (
        existing.kind !== "branch" ||
        existing.canonicalWorkspacePath !== input.workspace.canonicalPath
      ) {
        throw error(
          "invalid_state",
          "The branch operation is already associated with another origin.",
          "memory_creation_operation_conflict",
        );
      }
      return structuredClone(existing.result);
    }
    const id =
      input.requestedBackendConversationId ??
      `memory-conversation-${++this.#conversationCounter}`;
    if (!id || id.length > 512 || this.#conversations.has(id)) {
      throw error(
        "invalid_state",
        "The requested branch conversation already exists or is invalid.",
        "memory_branch_identity_conflict",
      );
    }
    return this.#createRecord({
      id,
      workspace: input.workspace,
      title: input.title,
      snapshot: checkpoint.snapshot,
      usage: checkpoint.usage,
      applicationOperationId: input.applicationOperationId,
      operationKind: "branch",
    });
  }

  async reconcileSubmission(
    input: ReconcileSubmissionInput,
  ): Promise<SubmissionReconciliation> {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    const retryAnchor = parseRetryAnchor(input.retryAnchor);
    const stored =
      input.reconciliationToken === undefined
        ? undefined
        : this.#reconciliations.get(input.reconciliationToken);
    if (
      !stored ||
      stored.applicationOperationId !== input.applicationOperationId ||
      stored.canonicalWorkspacePath !== input.workspace.canonicalPath
    ) {
      if (retryAnchor && input.binding) {
        const record = this.#resolveBinding(input.binding);
        const unchanged =
          retryAnchor.historyRevision === record.historyRevision &&
          retryAnchor.turnCount ===
            record.snapshot.orderedBackendTurnIds.length;
        return unchanged
          ? { status: "not_accepted", retryable: true }
          : {
              status: "unresolved",
              diagnostic: {
                text: "Backend history changed after the retry anchor without a correlated submission.",
              },
            };
      }
      return { status: "not_accepted", retryable: false };
    }
    if (stored.backendConversationId) {
      if (
        !input.binding ||
        this.#resolveBinding(input.binding).backendConversationId !==
          stored.backendConversationId
      ) {
        return { status: "not_accepted", retryable: false };
      }
    } else if (input.binding) {
      return { status: "not_accepted", retryable: false };
    }
    return structuredClone(stored.result);
  }

  #createRecord(input: {
    readonly id: string;
    readonly workspace: ValidatedWorkspace;
    readonly title?: string;
    readonly snapshot: BackendConversationSnapshot;
    readonly usage: UsageSnapshot;
    readonly applicationOperationId: string;
    readonly operationKind?: "create" | "branch";
  }): CreateConversationResult {
    const now = this.#now();
    const reconciliationToken = this.#token("create");
    const opaqueBindingDetail = `memory-binding:${input.id}:${this.#tokenCounter}`;
    const record: InMemoryConversation = {
      backendConversationId: input.id,
      canonicalWorkspacePath: input.workspace.canonicalPath,
      opaqueBindingDetail,
      ...(input.title ? { title: input.title } : {}),
      updatedAt: now,
      snapshot: structuredClone(input.snapshot),
      usage: cloneUsage(input.usage),
      capabilityRevision: 1,
      historyRevision: 1,
      turnCounter: input.snapshot.orderedBackendTurnIds.length,
      itemCounter: Object.keys(input.snapshot.itemsById).length,
      completedInterruptOperations: new Map(),
      completedActionOperations: new Map(),
      handles: new Set(),
    };
    this.#conversations.set(record.backendConversationId, record);
    const result: CreateConversationResult = {
      backendConversationId: record.backendConversationId,
      reconciliationToken,
      opaqueBindingDetail,
    };
    this.#creationOperations.set(input.applicationOperationId, {
      kind: input.operationKind ?? "create",
      canonicalWorkspacePath: input.workspace.canonicalPath,
      result: structuredClone(result),
    });
    this.#reconciliations.set(reconciliationToken, {
      applicationOperationId: input.applicationOperationId,
      canonicalWorkspacePath: input.workspace.canonicalPath,
      result: { status: "accepted" },
    });
    return result;
  }

  #resolveBoundConversation(
    scope: { readonly tenantId: string; readonly principalId: string },
    binding: ConversationBinding,
    workspace: ValidatedWorkspace,
    opaqueBindingDetail: string,
  ): InMemoryConversation {
    this.#assertScope(scope);
    this.#assertWorkspace(workspace);
    const record = this.#resolveBinding(binding);
    if (
      record.canonicalWorkspacePath !== workspace.canonicalPath ||
      record.opaqueBindingDetail !== opaqueBindingDetail
    ) {
      throw error(
        "not_found",
        "The backend conversation binding was not found.",
        "memory_binding_not_found",
      );
    }
    return record;
  }

  #resolveBinding(binding: ConversationBinding): InMemoryConversation {
    if (
      binding.tenantId !== this.connection.tenantId ||
      binding.ownerPrincipalId !== this.connection.ownerPrincipalId ||
      binding.backendInstanceId !== this.instance.id ||
      binding.connectionProfileId !== this.connection.id ||
      binding.executionEnvironmentId !== this.connection.executionEnvironmentId
    ) {
      throw error(
        "permission_denied",
        "The conversation binding is outside this backend connection.",
        "memory_binding_scope_mismatch",
      );
    }
    const record = this.#conversations.get(binding.backendConversationId);
    if (!record) {
      throw error(
        "not_found",
        "The backend conversation was not found.",
        "memory_conversation_not_found",
      );
    }
    return record;
  }

  #assertScope(scope: {
    readonly tenantId: string;
    readonly principalId: string;
  }): void {
    if (
      scope.tenantId !== this.connection.tenantId ||
      scope.principalId !== this.connection.ownerPrincipalId
    ) {
      throw error(
        "permission_denied",
        "The request scope cannot use this backend connection.",
        "memory_scope_mismatch",
      );
    }
  }

  #assertWorkspace(workspace: ValidatedWorkspace): void {
    if (
      workspace.summary.environmentId !== this.connection.executionEnvironmentId
    ) {
      throw error(
        "permission_denied",
        "The workspace belongs to a different execution environment.",
        "memory_workspace_scope_mismatch",
      );
    }
  }

  #token(kind: string): string {
    this.#tokenCounter += 1;
    return `memory-${kind}-${this.#tokenCounter}`;
  }

  handleClosed(
    record: InMemoryConversation,
    handle: InMemoryConversationHandle,
  ): void {
    record.handles.delete(handle);
  }

  emit(record: InMemoryConversation, event: BackendConversationEvent): void {
    const canonical = backendConversationEventSchema.parse(event);
    for (const handle of record.handles) {
      handle.receive(structuredClone(canonical));
    }
  }

  scheduleScriptedResponse(
    record: InMemoryConversation,
    turn: BackendTurn,
    inputText: string,
  ): void {
    const delay = this.#scriptedResponseStepDelayMilliseconds;
    if (delay === undefined) return;

    if (inputText === "Stream a TypeScript code fence progressively") {
      const assistantBase = {
        backendItemId: `memory-item-${++record.itemCounter}`,
        backendTurnId: turn.backendTurnId,
        semanticKind: "assistant_message" as const,
        sourceOrder: 1,
        startedAt: this.now(),
      };
      const source = 'function render(): string {\n  const html = "<tag>&amp;</tag>";\n\treturn html + "\\n";\n}\n';
      const partialText = `\`\`\`ts\n${source}`;
      const completeText = `${partialText}\`\`\``;
      this.#schedule(delay, () => {
        if (!this.#isActive(record, turn.backendTurnId)) return;
        const item = {
          ...assistantBase,
          status: "streaming" as const,
          markdown: boundText("```ts\n"),
        } satisfies BackendItem;
        this.#appendItem(record, turn.backendTurnId, item);
        this.emit(record, { type: "item_started", item });
      });
      this.#schedule(delay * 2, () => {
        if (!this.#isActive(record, turn.backendTurnId)) return;
        const item = {
          ...assistantBase,
          status: "streaming" as const,
          markdown: boundText(partialText),
        } satisfies BackendItem;
        record.snapshot.itemsById[item.backendItemId] = item;
        this.emit(record, { type: "item_updated", item });
      });
      this.#schedule(delay * 3, () => this.deliverScriptedAssistantStage(inputText, "closed", () => {
        if (!this.#isActive(record, turn.backendTurnId)) return;
        const item = {
          ...assistantBase,
          status: "streaming" as const,
          markdown: boundText(completeText),
        } satisfies BackendItem;
        record.snapshot.itemsById[item.backendItemId] = item;
        this.emit(record, { type: "item_updated", item });
      }));
      this.#schedule(delay * 5, () => this.deliverScriptedAssistantStage(inputText, "settled", () => {
        if (!this.#isActive(record, turn.backendTurnId)) return;
        const completedAt = this.now();
        const item = {
          ...assistantBase,
          status: "completed" as const,
          completedAt,
          markdown: boundText(completeText),
        } satisfies BackendItem;
        record.snapshot.itemsById[item.backendItemId] = item;
        this.emit(record, { type: "item_completed", item });
        const completedTurn: BackendTurn = {
          ...record.snapshot.turnsById[turn.backendTurnId]!,
          status: "completed",
          endedBy: "agent_settled",
          completedAt,
        };
        record.snapshot.turnsById[turn.backendTurnId] = completedTurn;
        record.snapshot.runState = "idle";
        delete record.snapshot.activeBackendTurnId;
        record.updatedAt = completedAt;
        record.historyRevision += 1;
        this.updateTerminalReconciliation(record, completedTurn);
        this.emit(record, { type: "turn_completed", turn: completedTurn });
        this.emit(record, { type: "run_state_changed", state: "idle" });
      }));
      return;
    }

    const streamsReasoningSummary =
      inputText === "Stream explicit reasoning summaries";
    const reasoningId = streamsReasoningSummary
      ? `memory-item-${++record.itemCounter}`
      : undefined;
    const toolId = `memory-item-${++record.itemCounter}`;
    const writeId = `memory-item-${++record.itemCounter}`;
    const commandId = `memory-item-${++record.itemCounter}`;
    const assistantId = `memory-item-${++record.itemCounter}`;
    const toolBase = {
      backendItemId: toolId,
      backendTurnId: turn.backendTurnId,
      semanticKind: "tool" as const,
      sourceOrder: streamsReasoningSummary ? 2 : 1,
      startedAt: this.now(),
      toolName: boundText("inspect_workspace"),
      title: boundText("Inspect workspace"),
      category: "filesystem" as const,
      arguments: {
        kind: "object" as const,
        entries: [
          {
            key: boundText("query"),
            value: boundText(
              streamsReasoningSummary
                ? "TOOL_DETAIL_MUST_NOT_REACH_SUMMARY_CLIENT"
                : inputText,
            ),
          },
        ],
      },
    };
    const assistantBase = {
      backendItemId: assistantId,
      backendTurnId: turn.backendTurnId,
      semanticKind: "assistant_message" as const,
      sourceOrder: streamsReasoningSummary ? 5 : 4,
      startedAt: this.now(),
    };
    const writeBase = {
      backendItemId: writeId,
      backendTurnId: turn.backendTurnId,
      semanticKind: "file_change" as const,
      sourceOrder: streamsReasoningSummary ? 3 : 2,
      startedAt: this.now(),
      operation: "write" as const,
      path: boundText("streaming-notes.md"),
    };
    const commandBase = {
      backendItemId: commandId,
      backendTurnId: turn.backendTurnId,
      semanticKind: "command" as const,
      sourceOrder: streamsReasoningSummary ? 4 : 3,
      startedAt: this.now(),
      command: boundText("printf 'first output\\nsecond output\\n'"),
    };
    const streamsMermaid =
      inputText === "Stream a Mermaid diagram progressively";
    const partialText = streamsMermaid
      ? "# Live diagram\n\n```mermaid\nflowchart TD\nA--"
      : inputText === "Summarize normalized streaming"
        ? "# Live summary\n\n- **Workspace inspected**\nI found "
        : "# Live summary\n\n**Workspace inspected**\nI found ";
    const completeText = streamsMermaid
      ? "# Live diagram\n\n```mermaid\nflowchart TD\nA-->B-->C-->D-->E-->F-->G-->H-->I-->J\n```\n\nDiagram ready while the response is still streaming."
      : `${partialText}a deterministic normalized result for **${inputText}**.`;

    const firstReasoningSummary = "Preparing";
    const updatedFirstReasoningSummary = "Preparing to inspect the workspace";
    const laterReasoningSummary =
      "Running focused checks across the workspace before executing the normalized streaming verification sequence";
    const rawReasoningMarker =
      "RAW_REASONING_DETAIL_MUST_NOT_REACH_SUMMARY_CLIENT";

    if (reasoningId) {
      const reasoningBase = {
        backendItemId: reasoningId,
        backendTurnId: turn.backendTurnId,
        semanticKind: "reasoning" as const,
        sourceOrder: 1,
        startedAt: this.now(),
        markdown: boundText(rawReasoningMarker),
      };
      this.#schedule(delay, () => {
        if (!this.#isActive(record, turn.backendTurnId)) return;
        const item = {
          ...reasoningBase,
          status: "streaming" as const,
          summaryParts: [boundText(firstReasoningSummary)],
        } satisfies BackendItem;
        this.#appendItem(record, turn.backendTurnId, item);
        this.emit(record, { type: "item_started", item });
      });
      this.#schedule(delay * 2, () => {
        if (!this.#isActive(record, turn.backendTurnId)) return;
        const item = {
          ...reasoningBase,
          status: "streaming" as const,
          summaryParts: [boundText(updatedFirstReasoningSummary)],
        } satisfies BackendItem;
        record.snapshot.itemsById[item.backendItemId] = item;
        this.emit(record, { type: "item_updated", item });
      });
      this.#schedule(delay * 4, () => {
        if (!this.#isActive(record, turn.backendTurnId)) return;
        const item = {
          ...reasoningBase,
          status: "streaming" as const,
          summaryParts: [
            boundText(updatedFirstReasoningSummary),
            boundText(laterReasoningSummary),
          ],
        } satisfies BackendItem;
        record.snapshot.itemsById[item.backendItemId] = item;
        this.emit(record, { type: "item_updated", item });
      });
      this.#schedule(delay * 5, () => {
        if (!this.#isActive(record, turn.backendTurnId)) return;
        const item = {
          ...reasoningBase,
          status: "completed" as const,
          completedAt: this.now(),
          summaryParts: [
            boundText(updatedFirstReasoningSummary),
            boundText(laterReasoningSummary),
          ],
        } satisfies BackendItem;
        record.snapshot.itemsById[item.backendItemId] = item;
        this.emit(record, { type: "item_completed", item });
      });
    }

    this.#schedule(delay, () => {
      if (!this.#isActive(record, turn.backendTurnId)) return;
      const item = {
        ...toolBase,
        status: "streaming" as const,
        phase: "preflight_or_executing" as const,
      } satisfies BackendItem;
      this.#appendItem(record, turn.backendTurnId, item);
      this.emit(record, { type: "item_started", item });
    });
    this.#schedule(delay * 2, () => {
      if (!this.#isActive(record, turn.backendTurnId)) return;
      const item = {
        ...toolBase,
        status: "completed" as const,
        phase: "completed" as const,
        completedAt: this.now(),
        result: {
          content: [
            {
              kind: "text" as const,
              value: boundText(
                streamsReasoningSummary
                  ? "TOOL_RESULT_MUST_NOT_REACH_SUMMARY_CLIENT"
                  : "workspace inspection complete",
              ),
            },
          ],
          details: {
            kind: "object" as const,
            entries: [
              {
                key: boundText("files"),
                value: 3,
              },
            ],
          },
          isError: false,
        },
      } satisfies BackendItem;
      record.snapshot.itemsById[item.backendItemId] = item;
      this.emit(record, { type: "item_completed", item });
    });
    this.#schedule(delay * 3, () => {
      if (!this.#isActive(record, turn.backendTurnId)) return;
      const item = {
        ...writeBase,
        status: "streaming" as const,
        phase: "arguments_streaming" as const,
        effect: "proposed" as const,
        contentPreview: boundText("# Streaming notes\nfirst line"),
      } satisfies BackendItem;
      this.#appendItem(record, turn.backendTurnId, item);
      this.emit(record, { type: "item_started", item });
    });
    this.#schedule(delay * 4, () => {
      if (!this.#isActive(record, turn.backendTurnId)) return;
      const item = {
        ...writeBase,
        status: "streaming" as const,
        phase: "arguments_streaming" as const,
        effect: "proposed" as const,
        contentPreview: boundText("# Streaming notes\nfirst line\nsecond line"),
      } satisfies BackendItem;
      record.snapshot.itemsById[item.backendItemId] = item;
      this.emit(record, { type: "item_updated", item });
    });
    this.#schedule(delay * 5, () => {
      if (!this.#isActive(record, turn.backendTurnId)) return;
      const item = {
        ...writeBase,
        status: "completed" as const,
        phase: "completed" as const,
        completedAt: this.now(),
        effect: "applied" as const,
        contentPreview: boundText("# Streaming notes\nfirst line\nsecond line"),
      } satisfies BackendItem;
      record.snapshot.itemsById[item.backendItemId] = item;
      this.emit(record, { type: "item_completed", item });
    });
    this.#schedule(delay * 6, () => {
      if (!this.#isActive(record, turn.backendTurnId)) return;
      const item = {
        ...commandBase,
        status: "streaming" as const,
        phase: "preflight_or_executing" as const,
      } satisfies BackendItem;
      this.#appendItem(record, turn.backendTurnId, item);
      this.emit(record, { type: "item_started", item });
    });
    this.#schedule(delay * 7, () => {
      if (!this.#isActive(record, turn.backendTurnId)) return;
      const item = {
        ...commandBase,
        status: "streaming" as const,
        phase: "result_streaming" as const,
        output: boundText("first output"),
      } satisfies BackendItem;
      record.snapshot.itemsById[item.backendItemId] = item;
      this.emit(record, { type: "item_updated", item });
    });
    this.#schedule(delay * 8, () => {
      if (!this.#isActive(record, turn.backendTurnId)) return;
      const item = {
        ...commandBase,
        status: "streaming" as const,
        phase: "result_streaming" as const,
        output: boundText("first output\nsecond output"),
      } satisfies BackendItem;
      record.snapshot.itemsById[item.backendItemId] = item;
      this.emit(record, { type: "item_updated", item });
    });
    this.#schedule(delay * 9, () => {
      if (!this.#isActive(record, turn.backendTurnId)) return;
      const item = {
        ...commandBase,
        status: "completed" as const,
        phase: "completed" as const,
        completedAt: this.now(),
        output: boundText("first output\nsecond output"),
        exitCode: 0,
      } satisfies BackendItem;
      record.snapshot.itemsById[item.backendItemId] = item;
      this.emit(record, { type: "item_completed", item });
    });
    this.#schedule(delay * 10, () => {
      if (!this.#isActive(record, turn.backendTurnId)) return;
      const item = {
        ...assistantBase,
        status: "streaming" as const,
        markdown: boundText(partialText),
      } satisfies BackendItem;
      this.#appendItem(record, turn.backendTurnId, item);
      this.emit(record, { type: "item_started", item });
    });
    this.#schedule(delay * 11, () => this.deliverScriptedAssistantStage(inputText, "closed", () => {
      if (!this.#isActive(record, turn.backendTurnId)) return;
      const item = {
        ...assistantBase,
        status: "streaming" as const,
        markdown: boundText(completeText),
      } satisfies BackendItem;
      record.snapshot.itemsById[item.backendItemId] = item;
      this.emit(record, { type: "item_updated", item });
    }));
    // Leave one full scripted step with no source update after the final
    // assistant delta. The deterministic browser journey uses this pause to
    // prove visual fades settle while the authoritative item is still
    // streaming, without relying on a narrow final animation frame.
    const settleTurn = (completedAt: string) => {
      const active = record.snapshot.turnsById[turn.backendTurnId]!;
      const completedTurn: BackendTurn = {
        ...active,
        status: "completed",
        endedBy: "agent_settled",
        completedAt,
      };
      record.snapshot.turnsById[turn.backendTurnId] = completedTurn;
      record.snapshot.runState = "idle";
      delete record.snapshot.activeBackendTurnId;
      record.updatedAt = completedAt;
      record.historyRevision += 1;
      const outputTokens = Math.max(1, Math.ceil(completeText.length / 4));
      const tokens = record.usage.tokens ?? {};
      const counters = record.usage.counters ?? {};
      record.usage = {
        ...record.usage,
        context: {
          usedTokens: (record.usage.context?.usedTokens ?? 0) + outputTokens,
          windowTokens: record.usage.context?.windowTokens ?? 128_000,
        },
        tokens: {
          ...tokens,
          output: (tokens.output ?? 0) + outputTokens,
          total: (tokens.total ?? 0) + outputTokens,
        },
        counters: {
          ...counters,
          assistantMessages: (counters.assistantMessages ?? 0) + 1,
          toolCalls: (counters.toolCalls ?? 0) + 3,
          toolResults: (counters.toolResults ?? 0) + 3,
        },
      };
      this.updateTerminalReconciliation(record, completedTurn);
      this.emit(record, { type: "turn_completed", turn: completedTurn });
      this.emit(record, { type: "usage_changed", usage: record.usage });
      this.emit(record, { type: "run_state_changed", state: "idle" });
    };
    this.#schedule(delay * 13, () => this.deliverScriptedAssistantStage(inputText, "settled", () => {
      if (!this.#isActive(record, turn.backendTurnId)) return;
      const completedAt = this.now();
      const item = {
        ...assistantBase,
        status: "completed" as const,
        completedAt,
        markdown: boundText(completeText),
      } satisfies BackendItem;
      record.snapshot.itemsById[item.backendItemId] = item;
      this.emit(record, { type: "item_completed", item });
      if (!streamsReasoningSummary) settleTurn(completedAt);
    }));
    if (streamsReasoningSummary) {
      this.#schedule(delay * 20, () => {
        if (!this.#isActive(record, turn.backendTurnId)) return;
        settleTurn(this.now());
      });
    }
  }

  /** Test fixtures may hold a scripted stage until a browser observes the prior
   * state. The released callback still performs the real snapshot/event update.
   */
  deliverScriptedAssistantStage(
    _inputText: string,
    _stage: "closed" | "settled",
    deliver: () => void,
  ): void {
    deliver();
  }

  #appendItem(
    record: InMemoryConversation,
    backendTurnId: string,
    item: BackendItem,
  ): void {
    const active = record.snapshot.turnsById[backendTurnId];
    if (!active) throw new Error("memory_script_turn_missing");
    record.snapshot.itemsById[item.backendItemId] = item;
    record.snapshot.turnsById[backendTurnId] = {
      ...active,
      orderedBackendItemIds: [
        ...active.orderedBackendItemIds,
        item.backendItemId,
      ],
    };
  }

  #isActive(record: InMemoryConversation, backendTurnId: string): boolean {
    return (
      record.snapshot.runState === "running" &&
      record.snapshot.activeBackendTurnId === backendTurnId
    );
  }

  #schedule(delayMilliseconds: number, action: () => void): void {
    const timer = setTimeout(action, delayMilliseconds);
    timer.unref();
  }

  token(kind: string): string {
    return this.#token(kind);
  }

  rememberSubmission(
    record: InMemoryConversation,
    operationId: string,
    mutationId: string,
    kind: "submit" | "steer",
    result: SubmitTurnResult | SteerTurnResult,
    turn: BackendTurn,
    inputFingerprint: string,
  ): void {
    this.#submissionOperations.set(
      this.#submissionKey(record.backendConversationId, operationId),
      {
        backendConversationId: record.backendConversationId,
        applicationOperationId: operationId,
        kind,
        mutationId,
        inputFingerprint,
        result: structuredClone(result),
        backendTurnId: turn.backendTurnId,
      },
    );
    this.#reconciliations.set(result.reconciliationToken, {
      applicationOperationId: operationId,
      canonicalWorkspacePath: record.canonicalWorkspacePath,
      backendConversationId: record.backendConversationId,
      backendTurnId: turn.backendTurnId,
      result: operationResult(turn),
    });
  }

  submission(
    record: InMemoryConversation,
    operationId: string,
    kind: "submit",
    inputFingerprint: string,
  ): SubmitTurnResult | undefined;
  submission(
    record: InMemoryConversation,
    operationId: string,
    kind: "steer",
    inputFingerprint: string,
  ): SteerTurnResult | undefined;
  submission(
    record: InMemoryConversation,
    operationId: string,
    kind: "submit" | "steer",
    inputFingerprint: string,
  ): SubmitTurnResult | SteerTurnResult | undefined {
    const stored = this.#submissionOperations.get(
      this.#submissionKey(record.backendConversationId, operationId),
    );
    if (stored && stored.kind !== kind) {
      throw error(
        "invalid_state",
        "The submission operation is already associated with another origin.",
        "memory_submission_operation_conflict",
      );
    }
    if (stored && stored.inputFingerprint !== inputFingerprint) {
      throw error(
        "rejected",
        "The submission operation was replayed with different input.",
        "memory_submission_replay_mismatch",
      );
    }
    return stored ? structuredClone(stored.result) : undefined;
  }

  updateTerminalReconciliation(
    record: InMemoryConversation,
    turn: BackendTurn,
  ): void {
    for (const stored of this.#reconciliations.values()) {
      if (
        stored.backendConversationId === record.backendConversationId &&
        stored.backendTurnId === turn.backendTurnId
      ) {
        stored.result = operationResult(turn);
      }
    }
  }

  shouldReportUncertain(operationId: string): boolean {
    return this.#uncertainSubmissionOperationIds.has(operationId);
  }

  #submissionKey(backendConversationId: string, operationId: string): string {
    return `${backendConversationId}\u0000${operationId}`;
  }

  now(): string {
    return this.#now();
  }

  capabilities(revision: number): BackendCapabilityDocument {
    return capabilities(revision, this.#interactionMode);
  }
}

class InMemoryConversationHandle implements ConversationHandle {
  readonly binding: ConversationBinding;
  readonly #driver: InMemoryConformanceDriver;
  readonly #record: InMemoryConversation;
  readonly #maximumProjectionBufferEvents: number;
  readonly #rawListeners = new Set<(event: BackendConversationEvent) => void>();
  readonly #sequencedBuffer: SequencedBackendEvent[] = [];
  readonly #pendingEvents: BackendConversationEvent[] = [];
  #projectionListener?: BackendEventListener;
  #nextHandleSequence = 0;
  #establishedThrough = -1;
  #projectionEpoch = 0;
  #projectionEstablished = false;
  #projectionSubscriptionClaimed = false;
  #projectionInvalidated = false;
  #drainingEvents = false;
  #closed = false;

  constructor(
    driver: InMemoryConformanceDriver,
    record: InMemoryConversation,
    binding: ConversationBinding,
    maximumProjectionBufferEvents: number,
  ) {
    this.#driver = driver;
    this.#record = record;
    this.binding = structuredClone(binding);
    this.#maximumProjectionBufferEvents = maximumProjectionBufferEvents;
  }

  async establishProjection(
    input: EstablishProjectionInput,
  ): Promise<EstablishedBackendProjection> {
    this.#assertOpen();
    if (input.signal.aborted) {
      throw error(
        "unavailable",
        "Backend projection establishment was cancelled.",
        "memory_projection_aborted",
        true,
      );
    }
    await projectionCancellationCheckpoint(input.signal);
    this.#assertOpen();
    if (this.#projectionListener) {
      throw error(
        "invalid_state",
        "The active backend projection must be detached before replacement.",
        "memory_projection_subscriber_active",
      );
    }
    this.#projectionEpoch += 1;
    const epoch = this.#projectionEpoch;
    this.#projectionEstablished = true;
    this.#projectionSubscriptionClaimed = false;
    this.#projectionInvalidated = false;
    this.#sequencedBuffer.length = 0;
    this.#establishedThrough = this.#nextHandleSequence - 1;
    const snapshot = cloneRecentSnapshot(this.#record.snapshot);
    const windowStart =
      this.#record.snapshot.orderedBackendTurnIds.length -
      snapshot.orderedBackendTurnIds.length;
    return {
      handleSequence: this.#establishedThrough,
      snapshot,
      history: {
        operational: true,
        ...(windowStart > 0
          ? {
              previousCursor:
                `history:${encodeURIComponent(this.#record.backendConversationId)}` +
                `:${this.#record.historyRevision}:${windowStart}`,
            }
          : {}),
      },
      subscribeFromNext: (listener) => {
        this.#assertOpen();
        if (
          epoch !== this.#projectionEpoch ||
          this.#projectionSubscriptionClaimed
        ) {
          throw error(
            "invalid_state",
            "The projection subscription is stale or was already claimed.",
            "memory_projection_subscription_claimed",
          );
        }
        this.#projectionSubscriptionClaimed = true;
        this.#projectionListener = listener;
        if (this.#projectionInvalidated) {
          this.#notifyProjectionListener({
            handleSequence: this.#establishedThrough + 1,
            event: {
              type: "resnapshot_required",
              reason: "buffer_overflow",
            },
          });
        } else {
          for (const event of this.#sequencedBuffer.splice(
            0,
            this.#sequencedBuffer.length,
          )) {
            this.#notifyProjectionListener(event);
          }
        }
        return () => {
          if (this.#projectionListener === listener) {
            this.#projectionListener = undefined;
          }
        };
      },
    };
  }

  async history(input: HistoryPageInput): Promise<BackendHistoryPage> {
    this.#assertOpen();
    input.signal?.throwIfAborted();
    validateLimit(input.limit);
    const ids = this.#record.snapshot.orderedBackendTurnIds;
    const before = parseHistoryCursor(input.cursor, this.#record);
    const start = Math.max(0, before - input.limit);
    const selectedIds = ids.slice(start, before);
    const selectedIdSet = new Set(selectedIds);
    return {
      orderedBackendTurnIds: selectedIds,
      turnsById: Object.fromEntries(
        selectedIds.map((id) => [
          id,
          structuredClone(this.#record.snapshot.turnsById[id]!),
        ]),
      ),
      itemsById: Object.fromEntries(
        Object.entries(this.#record.snapshot.itemsById)
          .filter(([, item]) => selectedIdSet.has(item.backendTurnId))
          .map(([id, item]) => [id, structuredClone(item)]),
      ),
      ...(start > 0
        ? {
            previousCursor:
              `history:${encodeURIComponent(this.#record.backendConversationId)}` +
              `:${this.#record.historyRevision}:${start}`,
          }
        : {}),
    };
  }

  async locateTurn(input: LocateTurnInput): Promise<LocateTurnResult> {
    this.#assertOpen();
    input.signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(input.maximumTurnCandidates) ||
      input.maximumTurnCandidates <= 0
    ) {
      throw error(
        "rejected",
        "The requested turn-location candidate limit is invalid.",
        "memory_turn_location_limit_invalid",
      );
    }
    const ids = this.#record.snapshot.orderedBackendTurnIds;
    const candidateCount = Math.min(ids.length, input.maximumTurnCandidates);
    for (let offset = 0; offset < candidateCount; offset += 1) {
      input.signal?.throwIfAborted();
      const backendTurnId = ids[ids.length - 1 - offset]!;
      if (!input.matchesBackendTurnId(backendTurnId)) continue;
      const turn = this.#record.snapshot.turnsById[backendTurnId];
      if (!turn) throw new Error("memory_turn_location_reference_missing");
      const itemsById = Object.fromEntries(
        turn.orderedBackendItemIds.map((backendItemId) => {
          const item = this.#record.snapshot.itemsById[backendItemId];
          if (!item) throw new Error("memory_turn_location_item_missing");
          return [backendItemId, structuredClone(item)];
        }),
      );
      return {
        status: "found",
        page: {
          orderedBackendTurnIds: [backendTurnId],
          turnsById: { [backendTurnId]: structuredClone(turn) },
          itemsById,
        },
      };
    }
    return ids.length > candidateCount
      ? { status: "search_limit_reached" }
      : { status: "not_found" };
  }

  async backendCapabilities(): Promise<BackendCapabilityDocument> {
    this.#assertOpen();
    return this.#driver.capabilities(this.#record.capabilityRevision);
  }

  async usage(): Promise<UsageSnapshot> {
    this.#assertOpen();
    return cloneUsage(this.#record.usage);
  }

  async captureSubmissionRetryAnchor(): Promise<string> {
    this.#assertOpen();
    if (
      this.#record.snapshot.runState !== "idle" &&
      this.#record.snapshot.runState !== "failed"
    ) {
      throw error(
        "invalid_state",
        "A submission retry anchor can only be captured while settled.",
        "memory_retry_anchor_requires_settled",
      );
    }
    return requireSubmissionRetryAnchor(
      JSON.stringify({
        version: 1,
        historyRevision: this.#record.historyRevision,
        turnCount: this.#record.snapshot.orderedBackendTurnIds.length,
      } satisfies InMemoryRetryAnchor),
    );
  }

  async submit(input: SubmitTurnInput): Promise<SubmitTurnResult> {
    this.#assertOpen();
    const repeated = this.#driver.submission(
      this.#record,
      input.applicationOperationId,
      "submit",
      submissionInputFingerprint("submit", input),
    );
    if (repeated) {
      return repeated;
    }
    if (
      this.#record.snapshot.runState !== "idle" &&
      this.#record.snapshot.runState !== "failed"
    ) {
      throw error(
        "invalid_state",
        "A new turn cannot be submitted while the conversation is running.",
        "memory_submit_while_running",
      );
    }
    const turn = this.#startTurn(input, input.applicationOperationId);
    const result: SubmitTurnResult = {
      accepted: true,
      reconciliationToken: input.reconciliationToken,
      completionCorrelation: input.applicationOperationId,
      backendTurnId: turn.backendTurnId,
    };
    this.#driver.rememberSubmission(
      this.#record,
      input.applicationOperationId,
      input.mutationId,
      "submit",
      result,
      turn,
      submissionInputFingerprint("submit", input),
    );
    this.#emitStartedTurn(turn);
    this.#driver.scheduleScriptedResponse(this.#record, turn, input.text);
    if (this.#driver.shouldReportUncertain(input.applicationOperationId)) {
      throw error(
        "submission_unknown",
        "The backend accepted the turn but its response was interrupted.",
        "memory_submission_unknown",
        true,
        true,
      );
    }
    return result;
  }

  async steer(input: SteerTurnInput): Promise<SteerTurnResult> {
    if (input.target.kind !== "turn") {
      throw new BackendError({
        category: "invalid_state",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "This backend requires an exact turn steering target.",
      });
    }
    const expectedBackendTurnId = input.target.turnId;
    this.#assertOpen();
    const repeated = this.#driver.submission(
      this.#record,
      input.applicationOperationId,
      "steer",
      submissionInputFingerprint("steer", input),
    );
    if (repeated) {
      if (repeated.reconciliationToken !== input.reconciliationToken) {
        throw error(
          "rejected",
          "The steering operation was replayed with another identity.",
          "memory_steer_replay_mismatch",
        );
      }
      return {
        status: "accepted",
        reconciliationToken: repeated.reconciliationToken,
        completionCorrelation: repeated.completionCorrelation,
        backendTurnId: repeated.backendTurnId ?? expectedBackendTurnId,
      };
    }
    if (this.#record.snapshot.runState !== "running") {
      throw error(
        "invalid_state",
        "Steering requires an active backend turn.",
        "memory_steer_without_active_turn",
      );
    }
    if (
      this.#record.snapshot.activeBackendTurnId !== expectedBackendTurnId
    ) {
      throw error(
        "invalid_state",
        "The active backend turn changed before steering.",
        "memory_steer_target_changed",
      );
    }
    const prior = this.#activeTurn();
    const completedPrior: BackendTurn = {
      ...prior,
      status: "completed",
      endedBy: "steer",
      completedAt: this.#driver.now(),
    };
    this.#record.snapshot.turnsById[prior.backendTurnId] = completedPrior;
    this.#record.historyRevision += 1;
    this.#driver.updateTerminalReconciliation(this.#record, completedPrior);
    const turn = this.#startTurn(input, input.applicationOperationId);
    const result: SteerTurnResult = {
      status: "accepted",
      reconciliationToken: input.reconciliationToken,
      completionCorrelation: input.applicationOperationId,
      backendTurnId: expectedBackendTurnId,
    };
    this.#driver.rememberSubmission(
      this.#record,
      input.applicationOperationId,
      input.mutationId,
      "steer",
      result,
      turn,
      submissionInputFingerprint("steer", input),
    );
    this.#driver.emit(this.#record, {
      type: "turn_completed",
      turn: completedPrior,
    });
    this.#emitStartedTurn(turn);
    if (this.#driver.shouldReportUncertain(input.applicationOperationId)) {
      throw error(
        "submission_unknown",
        "The backend accepted the steering turn but its response was interrupted.",
        "memory_submission_unknown",
        true,
        true,
      );
    }
    return result;
  }

  async interrupt(input: InterruptTurnInput): Promise<void> {
    this.#assertOpen();
    const priorTarget = this.#record.completedInterruptOperations.get(
      input.applicationOperationId,
    );
    if (priorTarget) {
      if (priorTarget !== input.expectedBackendTurnId) {
        throw error(
          "rejected",
          "The interrupt operation was replayed for another turn.",
          "memory_interrupt_replay_mismatch",
        );
      }
      return;
    }
    if (this.#record.snapshot.runState !== "running") {
      throw error(
        "invalid_state",
        "Interrupt requires an active backend turn.",
        "memory_interrupt_without_active_turn",
      );
    }
    if (
      this.#record.snapshot.activeBackendTurnId !== input.expectedBackendTurnId
    ) {
      throw error(
        "invalid_state",
        "The active backend turn changed before interrupt.",
        "memory_interrupt_target_changed",
      );
    }
    this.#record.snapshot.runState = "stopping";
    this.#driver.emit(this.#record, {
      type: "run_state_changed",
      state: "stopping",
      activeBackendTurnId: this.#record.snapshot.activeBackendTurnId,
    });
    const prior = this.#activeTurn();
    const interrupted: BackendTurn = {
      ...prior,
      status: "interrupted",
      endedBy: "interrupted",
      completedAt: this.#driver.now(),
    };
    this.#record.snapshot.turnsById[prior.backendTurnId] = interrupted;
    this.#record.snapshot.runState = "idle";
    delete this.#record.snapshot.activeBackendTurnId;
    this.#record.updatedAt = this.#driver.now();
    this.#record.historyRevision += 1;
    this.#record.completedInterruptOperations.set(
      input.applicationOperationId,
      input.expectedBackendTurnId,
    );
    this.#driver.updateTerminalReconciliation(this.#record, interrupted);
    this.#driver.emit(this.#record, {
      type: "turn_completed",
      turn: interrupted,
    });
    this.#driver.emit(this.#record, {
      type: "run_state_changed",
      state: "idle",
    });
  }

  async reconcileInterrupt(
    input: InterruptTurnInput,
  ): Promise<BackendMutationReconciliation> {
    this.#assertOpen();
    if (
      this.#record.completedInterruptOperations.get(
        input.applicationOperationId,
      ) === input.expectedBackendTurnId ||
      this.#record.snapshot.activeBackendTurnId !== input.expectedBackendTurnId
    ) {
      return { outcome: "accepted" };
    }
    return { outcome: "not_applied" };
  }

  async perform(
    input: RegisteredBackendActionInput,
  ): Promise<BackendActionResult> {
    this.#assertOpen();
    const {
      applicationOperationId: _applicationOperationId,
      ...actionPayload
    } = input;
    const fingerprint = JSON.stringify(actionPayload);
    const repeated = this.#record.completedActionOperations.get(
      input.applicationOperationId,
    );
    if (repeated) {
      if (repeated.fingerprint !== fingerprint) {
        throw error(
          "rejected",
          "The backend action operation was replayed with different input.",
          "memory_action_replay_mismatch",
        );
      }
      return repeated.result;
    }
    if (input.action === "rename") {
      if (!input.title.trim() || input.title.length > 240) {
        throw error(
          "rejected",
          "The backend title is invalid.",
          "memory_title_invalid",
        );
      }
      this.#record.title = input.title;
    } else if (input.action === "compact") {
      if (this.#record.snapshot.runState !== "idle") {
        throw error(
          "invalid_state",
          "Compaction requires an idle conversation.",
          "memory_compact_while_running",
        );
      }
      const turnId = this.#record.snapshot.orderedBackendTurnIds.at(-1);
      if (turnId) {
        const turn = this.#record.snapshot.turnsById[turnId]!;
        const item = {
          backendItemId: `memory-item-${++this.#record.itemCounter}`,
          backendTurnId: turnId,
          semanticKind: "compaction",
          status: "completed",
          sourceOrder: turn.orderedBackendItemIds.length,
          startedAt: this.#driver.now(),
          completedAt: this.#driver.now(),
        } satisfies Extract<BackendItem, { semanticKind: "compaction" }>;
        this.#record.snapshot.itemsById[item.backendItemId] = item;
        this.#record.snapshot.turnsById[turnId] = {
          ...turn,
          orderedBackendItemIds: [
            ...turn.orderedBackendItemIds,
            item.backendItemId,
          ],
        };
        this.#record.historyRevision += 1;
        this.#driver.emit(this.#record, {
          type: "item_completed",
          item,
        });
      }
      const counters = this.#record.usage.counters ?? {};
      this.#record.usage = {
        ...this.#record.usage,
        counters: {
          ...counters,
          compactions: (counters.compactions ?? 0) + 1,
        },
      };
      this.#driver.emit(this.#record, {
        type: "usage_changed",
        usage: this.#record.usage,
      });
    } else if (input.action === "set_model") {
      if (
        input.provider !== "memory" ||
        input.modelId !== "conformance-model"
      ) {
        throw error(
          "rejected",
          "The requested backend model is unavailable.",
          "memory_model_unavailable",
        );
      }
    } else if (input.action === "set_thinking_level") {
      if (!input.level || input.level.length > 120) {
        throw error(
          "rejected",
          "The requested thinking level is invalid.",
          "memory_thinking_level_invalid",
        );
      }
    } else if (
      input.action === "set_tool_access" &&
      input.mode !== "read_only" &&
      input.mode !== "full"
    ) {
      throw error(
        "rejected",
        "The requested tool-access mode is invalid.",
        "memory_tool_access_invalid",
      );
    }
    this.#record.capabilityRevision += 1;
    this.#record.updatedAt = this.#driver.now();
    const next = this.#driver.capabilities(this.#record.capabilityRevision);
    this.#driver.emit(this.#record, {
      type: "capabilities_changed",
      capabilities: next,
    });
    const result = {
      accepted: true as const,
      capabilityRevision: next.revision,
    };
    this.#record.completedActionOperations.set(input.applicationOperationId, {
      fingerprint,
      result,
    });
    return result;
  }

  async reconcileAction(
    input: RegisteredBackendActionInput,
  ): Promise<BackendMutationReconciliation> {
    this.#assertOpen();
    const {
      applicationOperationId: _applicationOperationId,
      ...actionPayload
    } = input;
    const completed = this.#record.completedActionOperations.get(
      input.applicationOperationId,
    );
    if (!completed) return { outcome: "not_applied" };
    if (completed.fingerprint !== JSON.stringify(actionPayload)) {
      throw error(
        "rejected",
        "The backend action operation was replayed with different input.",
        "memory_action_replay_mismatch",
      );
    }
    return { outcome: "accepted" };
  }

  async respond(_input: InteractionResponseInput): Promise<void> {
    this.#assertOpen();
    throw error(
      "rejected",
      "This backend does not support interactive requests.",
      "memory_interactions_unsupported",
    );
  }

  async reconcileInteractionResponse(
    _input: InteractionResponseInput,
  ): Promise<BackendMutationReconciliation> {
    this.#assertOpen();
    return { outcome: "not_applied" };
  }

  subscribe(listener: (event: BackendConversationEvent) => void): Unsubscribe {
    this.#assertOpen();
    this.#rawListeners.add(listener);
    return () => this.#rawListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#rawListeners.clear();
    this.#projectionListener = undefined;
    this.#sequencedBuffer.length = 0;
    this.#pendingEvents.length = 0;
    this.#driver.handleClosed(this.#record, this);
  }

  receive(event: BackendConversationEvent): void {
    if (this.#closed) {
      return;
    }
    this.#pendingEvents.push(
      backendConversationEventSchema.parse(structuredClone(event)),
    );
    if (this.#drainingEvents) {
      return;
    }
    this.#drainingEvents = true;
    try {
      while (this.#pendingEvents.length > 0) {
        this.#deliver(this.#pendingEvents.shift()!);
      }
    } finally {
      this.#drainingEvents = false;
    }
  }

  #deliver(event: BackendConversationEvent): void {
    const sequenced: SequencedBackendEvent = {
      handleSequence: this.#nextHandleSequence,
      event: structuredClone(event),
    };
    this.#nextHandleSequence += 1;
    if (this.#projectionInvalidated) {
      // A single resnapshot request replaces all later deltas until a new
      // authoritative projection is established.
    } else if (this.#projectionListener) {
      this.#notifyProjectionListener(sequenced);
    } else if (this.#projectionEstablished && !this.#projectionInvalidated) {
      if (this.#sequencedBuffer.length >= this.#maximumProjectionBufferEvents) {
        this.#sequencedBuffer.length = 0;
        this.#projectionInvalidated = true;
      } else {
        this.#sequencedBuffer.push(sequenced);
      }
    }
    for (const listener of [...this.#rawListeners]) {
      try {
        listener(structuredClone(event));
      } catch {
        // Consumers cannot affect backend acceptance or another subscriber.
      }
    }
  }

  #notifyProjectionListener(event: SequencedBackendEvent): void {
    const listener = this.#projectionListener;
    if (!listener) {
      return;
    }
    try {
      listener(structuredClone(event));
    } catch {
      // Projection delivery is observational and never rolls back acceptance.
    }
  }

  #startTurn(
    input: {
      readonly text: string;
      readonly contextExcerpts: readonly ContextExcerpt[];
      readonly attachments: SubmitTurnInput["attachments"];
      readonly taskContexts: SubmitTurnInput["taskContexts"];
    },
    completionCorrelation: string,
  ): BackendTurn {
    if (
      !input.text.trim() &&
      !input.contextExcerpts.some((excerpt) => excerpt.note?.trim()) &&
      input.attachments.length === 0 &&
      input.taskContexts.length === 0
    ) {
      throw error(
        "rejected",
        "The submitted backend message is empty.",
        "memory_message_empty",
      );
    }
    const now = this.#driver.now();
    const turnId = `memory-turn-${++this.#record.turnCounter}`;
    const item = {
      backendItemId: `memory-item-${++this.#record.itemCounter}`,
      backendTurnId: turnId,
      semanticKind: "user_message",
      deliveryOperationId: completionCorrelation,
      status: "completed",
      sourceOrder: 0,
      startedAt: now,
      completedAt: now,
      content: [
        ...input.attachments.map(
          ({ agentPath: _agentPath, sha256: _sha256, ...attachment }) => ({
            kind: "attachment" as const,
            attachment,
          }),
        ),
        ...input.taskContexts.map((task) => ({
          kind: "task_context" as const,
          task: structuredClone(task),
        })),
        ...input.contextExcerpts.map((excerpt) => ({
          kind: "context_excerpt" as const,
          excerpt: structuredClone(excerpt),
        })),
        ...(input.text.length > 0
          ? [{ kind: "text" as const, text: boundText(input.text) }]
          : []),
      ],
    } satisfies Extract<BackendItem, { semanticKind: "user_message" }>;
    const turn: BackendTurn = {
      backendTurnId: turnId,
      completionCorrelations: [completionCorrelation],
      status: "in_progress",
      startedAt: now,
      orderedBackendItemIds: [item.backendItemId],
    };
    this.#record.snapshot.orderedBackendTurnIds.push(turnId);
    this.#record.snapshot.turnsById[turnId] = turn;
    this.#record.snapshot.itemsById[item.backendItemId] = item;
    this.#record.snapshot.runState = "running";
    this.#record.snapshot.activeBackendTurnId = turnId;
    this.#record.updatedAt = now;
    this.#record.historyRevision += 1;
    const visibleInput = [
      ...input.contextExcerpts.flatMap((excerpt) => [
        excerpt.excerpt,
        excerpt.note ?? "",
      ]),
      input.text,
      ...input.attachments.map(({ fileName }) => fileName),
    ].join("\n");
    const inputTokens = Math.max(1, Math.ceil(visibleInput.length / 4));
    const previousTokens = this.#record.usage.tokens ?? {};
    const total = (previousTokens.total ?? 0) + inputTokens;
    const previousCounters = this.#record.usage.counters ?? {};
    this.#record.usage = {
      ...this.#record.usage,
      context: {
        usedTokens: total,
        windowTokens: 128_000,
        percent: (total / 128_000) * 100,
      },
      tokens: {
        ...previousTokens,
        input: (previousTokens.input ?? 0) + inputTokens,
        total,
      },
      counters: {
        ...previousCounters,
        requests: (previousCounters.requests ?? 0) + 1,
      },
    };
    return turn;
  }

  #emitStartedTurn(turn: BackendTurn): void {
    const itemId = turn.orderedBackendItemIds[0];
    const item = itemId ? this.#record.snapshot.itemsById[itemId] : undefined;
    if (!item) {
      throw error(
        "internal",
        "The in-memory backend lost the submitted user item.",
        "memory_user_item_missing",
      );
    }
    this.#driver.emit(this.#record, { type: "turn_started", turn });
    this.#driver.emit(this.#record, {
      type: "item_completed",
      item,
    });
    this.#driver.emit(this.#record, {
      type: "run_state_changed",
      state: "running",
      activeBackendTurnId: turn.backendTurnId,
    });
    this.#driver.emit(this.#record, {
      type: "usage_changed",
      usage: this.#record.usage,
    });
  }

  #activeTurn(): BackendTurn {
    const id = this.#record.snapshot.activeBackendTurnId;
    const turn = id ? this.#record.snapshot.turnsById[id] : undefined;
    if (!turn) {
      throw error(
        "internal",
        "The in-memory backend lost its active turn.",
        "memory_active_turn_missing",
      );
    }
    return turn;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw error(
        "unavailable",
        "The backend conversation handle is closed.",
        "memory_handle_closed",
      );
    }
  }
}
