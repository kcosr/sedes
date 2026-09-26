import type { SteerTarget } from "../../shared/protocol/conversation.js";
import { z } from "zod";
import type {
  BackendConversationSnapshot,
  BackendConversationEvent,
  BackendCapabilityDocument,
  BackendEffectiveSettings,
  BackendTurn,
  InteractionResponseInput as BackendInteractionResponseInput,
  SequencedBackendEvent,
} from "../../shared/protocol/backend.js";
import type {
  BackendBrand,
  UsageSnapshot,
} from "../../shared/protocol/conversation.js";
import type { BoundedDisplayText } from "../../shared/protocol/payload.js";
import type { ContextExcerpt } from "../../shared/protocol/context-excerpts.js";
import type { MaterializedTaskContext } from "../../shared/protocol/tasks.js";
import { composerAttachmentDescriptorSchema } from "../../shared/protocol/composer-attachments.js";
import type {
  ExecutionScope,
  ValidatedWorkspace,
} from "../execution/contracts.js";

export type BackendKind =
  "pi" | "codex_app_server" | "claude_agent_sdk" | "grok_build";
export type ConnectionKind =
  "pi_sdk" | "codex_app_server" | "claude_agent_sdk" | "grok_acp";

/**
 * The single server-side mapping from a compiled backend's kind to its
 * normalized browser brand mark (`BackendBrand` in the shared protocol).
 * Backend kinds stay server-private; the brand is the only browser-facing
 * identity. The record is total over `BackendKind`, so adding a compiled
 * backend without declaring its mark is a compile error — the cross-backend
 * audit cannot silently inherit another backend's mark.
 */
export const BACKEND_BRANDS: Readonly<Record<BackendKind, BackendBrand>> = {
  pi: "pi",
  codex_app_server: "codex",
  claude_agent_sdk: "claude",
  grok_build: "grok",
};

export interface AgentBackendInstance {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: BackendKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly configurationRevision: number;
  readonly protocolRelease: string;
}

export interface AgentConnectionProfile {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly templateId: string;
  readonly kind: ConnectionKind;
  readonly backendInstanceId: string;
  readonly executionEnvironmentId: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly configurationRevision: number;
}

export interface ConversationTarget {
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
}

export interface ConversationBinding extends ConversationTarget {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly backendConversationId: string;
  readonly createdAt: string;
}

export interface BackendHealth {
  readonly available: boolean;
  readonly checkedAt: string;
  readonly diagnostic?: BoundedDisplayText;
}

export interface BackendModelDescriptor {
  readonly provider: string;
  readonly id: string;
  readonly label: string;
  /** Reviewed provider input modalities; text is always required. */
  readonly inputModalities: readonly ("text" | "image")[];
  /** Present only when the provider authoritatively marks this catalog default. */
  readonly isDefault?: true;
  /** Provider-advertised values, in provider order. */
  readonly supportedReasoningEfforts?: readonly string[];
  /** Present only when the provider advertises reasoning choices. */
  readonly defaultReasoningEffort?: string;
  /**
   * Server-only normalized Fast metadata. Native service-tier identifiers do
   * not cross this backend contract.
   */
  readonly fastMode?: {
    readonly supported: true;
    readonly defaultSelection: "standard" | "fast";
    readonly description?: string;
  };
}

/**
 * Exact immutable bytes materialized into the target execution environment.
 * `agentPath` is provider-private and must never enter shared/browser shapes.
 */
const stagedComposerAttachmentPrivateShape = {
  /** Stable lowercase SHA-256 of the exact immutable bytes. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  /** Server-derived path that never enters browser protocol. */
  agentPath: z
    .string()
    .min(1)
    .max(4_096)
    .refine((value) => !value.includes("\0"), {
      message: "A staged composer attachment path must not contain NUL.",
    }),
} as const;

export const stagedComposerAttachmentSchema = z.discriminatedUnion("kind", [
  composerAttachmentDescriptorSchema.options[0].extend(
    stagedComposerAttachmentPrivateShape,
  ),
  composerAttachmentDescriptorSchema.options[1].extend(
    stagedComposerAttachmentPrivateShape,
  ),
]);
export type StagedComposerAttachment = z.infer<
  typeof stagedComposerAttachmentSchema
>;

/**
 * Server-only access to canonical application-owned attachment bytes. The
 * implementation is bound to authenticated scope and thread authority; native
 * backends must not interpret `agentPath` as a Sedes-server path.
 */
export interface CanonicalComposerAttachmentByteReader {
  read(
    attachment: StagedComposerAttachment,
    signal?: AbortSignal,
  ): Promise<Buffer>;
}

export type CanonicalComposerAttachmentEvidence = Readonly<{
  id: string;
  kind: StagedComposerAttachment["kind"];
  fileName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
}>;

/** Ordered, path-free immutable evidence captured under scoped ownership. */
export interface CanonicalComposerAttachmentEvidenceResolver {
  resolve(): readonly CanonicalComposerAttachmentEvidence[];
}

export interface BackendComposerCommand {
  readonly invocation: string;
  readonly source: "extension" | "prompt";
  readonly description?: string;
  readonly argumentHint?: string;
}

/**
 * Provider-neutral skill catalog entry. `id` is an opaque, workspace-scoped
 * selection identity; `displayName` is optional provider-authored presentation
 * text; and `reference` is native composer syntax used for provider invocation.
 * Native paths and skill bodies never cross this boundary.
 */
export interface BackendSkillDescriptor {
  readonly id: string;
  readonly name: string;
  readonly displayName?: string;
  readonly reference: string;
  readonly description?: string;
}

export interface BackendCatalog {
  readonly models: readonly BackendModelDescriptor[];
  readonly commands: readonly BackendComposerCommand[];
  readonly skills: readonly BackendSkillDescriptor[];
  readonly notices: readonly BoundedDisplayText[];
}

export interface BackendCatalogContext {
  readonly scope: ExecutionScope;
  readonly workspace: ValidatedWorkspace;
}

export interface DiscoveredConversation {
  readonly backendConversationId: string;
  readonly canonicalWorkspacePath: string;
  readonly title?: string;
  readonly updatedAt: string;
  readonly opaqueBindingDetail: string;
  /**
   * Provider-owned ancestry proven by the backend adapter. This remains on the
   * server boundary; native identities and checkpoint locators are never
   * serialized into the browser protocol.
   */
  readonly nativeAncestry?: DiscoveredNativeAncestryEvidence;
}

export interface DiscoveredNativeAncestryEvidence {
  readonly method: "provider_native" | "provider_history_import";
  readonly parentBackendConversationId: string;
  /** Exact provider turn only when the adapter can prove the copied boundary. */
  readonly sourceBackendTurnId?: string;
  /** Exact application operation only when authenticated provider evidence carries it. */
  readonly applicationOperationId?: string;
  /** Backend-verified child identity policy for exact operation evidence. */
  readonly childIdentity?: "application_reserved" | "provider_assigned";
  /** Backend-verified recovery policy for exact operation evidence. */
  readonly creationRecovery?:
    "idempotent" | "exactly_reconcilable" | "potentially_unknown";
}

export interface DiscoverConversationsInput {
  readonly scope: ExecutionScope;
  readonly workspace: ValidatedWorkspace;
  /** Cancels provider enumeration; no page may be persisted after abort. */
  readonly signal: AbortSignal;
  readonly cursor?: string;
  readonly limit: number;
}

export interface DiscoveredConversationPage {
  readonly conversations: readonly DiscoveredConversation[];
  readonly nextCursor?: string;
}

/**
 * Closed creation-identity contract. Lifecycle queries this before any external
 * create call so Pi (application-assigned, replayable) and Codex
 * (provider-assigned, non-replayable) share one typed path.
 */
export type ConversationCreationIdentity =
  | {
      readonly assignment: "application";
      /** Application pre-assigns the backend conversation ID. */
      readonly requestedBackendConversationId: "required";
      /** Drivers may safely replay create for the same operation/id. */
      readonly createReplay: "idempotent";
      /** First submission still completes before durable thread binding. */
      readonly bindBeforeFirstSubmission: false;
    }
  | {
      readonly assignment: "provider";
      /** Provider assigns the native ID; no requested native ID is supplied. */
      readonly requestedBackendConversationId: "forbidden";
      /** Create must never be replayed after the external boundary is crossed. */
      readonly createReplay: "never";
      /** Durably bind the provider identity before the first submission. */
      readonly bindBeforeFirstSubmission: true;
      /** Uncertain create becomes creation_unknown with no auto-adoption. */
      readonly uncertainCreateOutcome: "creation_unknown";
    };

export const APPLICATION_ASSIGNED_CREATION_IDENTITY = Object.freeze({
  assignment: "application",
  requestedBackendConversationId: "required",
  createReplay: "idempotent",
  bindBeforeFirstSubmission: false,
} as const satisfies ConversationCreationIdentity);

export const PROVIDER_ASSIGNED_CREATION_IDENTITY = Object.freeze({
  assignment: "provider",
  requestedBackendConversationId: "forbidden",
  createReplay: "never",
  bindBeforeFirstSubmission: true,
  uncertainCreateOutcome: "creation_unknown",
} as const satisfies ConversationCreationIdentity);

export type ConversationSubmissionSource =
  | { readonly kind: "user" }
  | {
      readonly kind: "automation";
      readonly automationId: string;
      readonly automationRunId: string;
    };

export interface CreateConversationInput {
  readonly scope: ExecutionScope;
  /** Durable Sedes thread whose execution settings govern this creation. */
  readonly applicationThreadId: string;
  readonly applicationOperationId: string;
  /** Durable origin used by backend execution-policy enforcement. */
  readonly source: ConversationSubmissionSource;
  readonly workspace: ValidatedWorkspace;
  /**
   * Application-assigned reservation. Required when the driver's creation
   * identity uses application assignment; forbidden for provider assignment.
   * Drivers that support idempotent create must treat replay of the same
   * operation and requested ID as returning the same conversation.
   */
  readonly requestedBackendConversationId?: string;
  /**
   * Durable provider-create correlation (for example Codex `threadSource`).
   * Required when the driver's creation identity uses provider assignment.
   */
  readonly creationCorrelation?: string;
  readonly title?: string;
}

export interface CreateConversationResult {
  readonly backendConversationId: string;
  readonly reconciliationToken: string;
  readonly opaqueBindingDetail: string;
}

export interface AttachConversationInput {
  readonly scope: ExecutionScope;
  readonly binding: ConversationBinding;
  readonly workspace: ValidatedWorkspace;
  readonly opaqueBindingDetail: string;
}

export interface ReadConversationInput {
  readonly scope: ExecutionScope;
  readonly binding: ConversationBinding;
  readonly workspace: ValidatedWorkspace;
  readonly opaqueBindingDetail: string;
}

export interface ConversationReadResult {
  readonly snapshot: BackendConversationSnapshot;
  readonly usage: UsageSnapshot;
}

export interface BackendCheckpointRef {
  readonly backendInstanceId: string;
  readonly kind: "conversation_leaf";
  readonly opaqueReference: string;
}

export interface ResolveBranchCheckpointInput {
  readonly scope: ExecutionScope;
  readonly binding: ConversationBinding;
  readonly workspace: ValidatedWorkspace;
  readonly opaqueBindingDetail: string;
  readonly selection: BranchCheckpointSelection;
}

export type BranchCheckpointSelection =
  | {
      readonly kind: "latest_completed";
      /**
       * The newest completed turn the actor resolved and records as the fork
       * source. The backend resolves its own newest completed turn and fails
       * when that differs; it never forks another turn.
       */
      readonly backendTurnId: string;
    }
  | { readonly kind: "latest_provider_snapshot" }
  | {
      readonly kind: "selected_completed_turn";
      readonly backendTurnId: string;
      readonly boundary: "completed_turn_inclusive";
    };

interface BranchConversationInputBase {
  readonly scope: ExecutionScope;
  /** Reserved Sedes child whose backend-owned state is finalized on success. */
  readonly childApplicationThreadId: string;
  readonly applicationOperationId: string;
  readonly sourceBinding: ConversationBinding;
  readonly sourceOpaqueBindingDetail: string;
  readonly workspace: ValidatedWorkspace;
  readonly sourceCheckpoint: BackendCheckpointRef;
  /** Required for application-reserved branch identities; forbidden otherwise. */
  readonly requestedBackendConversationId?: string;
  /** Durable provider correlation when the provider assigns the child identity. */
  readonly creationCorrelation?: string;
  /** Effective source settings captured atomically with checkpoint resolution. */
  readonly inheritedSettings?: BackendEffectiveSettings;
  readonly title?: string;
}

export type BranchConversationInput = BranchConversationInputBase & {
  readonly source:
    | { readonly kind: "user" }
    | Extract<ConversationSubmissionSource, { readonly kind: "automation" }>;
};

export interface ReconcileSubmissionInput {
  readonly scope: ExecutionScope;
  readonly binding?: ConversationBinding;
  readonly opaqueBindingDetail?: string;
  readonly workspace: ValidatedWorkspace;
  readonly applicationOperationId: string;
  /**
   * Some drivers can reconcile from the durable application operation and
   * conversation binding alone. A token is included only when one was
   * durably obtained before the submission outcome became unknown.
   */
  readonly reconciliationToken?: string;
  readonly retryAnchor?: string;
  /** Ordered, path-free attachment identity re-resolved under durable ownership. */
  readonly attachmentEvidence?: readonly CanonicalComposerAttachmentEvidence[];
  /**
   * Present only when reconciling a Steer: the exact target durably recorded
   * when it crossed the provider boundary. A backend may use it to prove that
   * the targeted turn ended without using the input. It never authorizes a
   * resend.
   */
  readonly steerTarget?: SteerTarget;
}

export type SubmissionReconciliation =
  | {
      readonly status: "accepted";
      readonly backendTurn?: BackendTurn;
      readonly completionIdentity?: string;
    }
  /**
   * Proven never accepted. `retryable: false` forbids an automatic resend:
   * the application returns the input to the user, with `diagnostic` when
   * given (for example, a provider withdrew queued input on Stop).
   */
  | {
      readonly status: "not_accepted";
      readonly retryable: boolean;
      readonly diagnostic?: BoundedDisplayText;
    }
  /** Tracking is terminal, but prior consumption is unknown. Never auto-retry. */
  | { readonly status: "failed_unknown"; readonly diagnostic: BoundedDisplayText }
  | { readonly status: "unresolved"; readonly diagnostic: BoundedDisplayText };

export interface EstablishedBackendProjection {
  readonly handleSequence: number;
  readonly snapshot: BackendConversationSnapshot;
  /**
   * History boundary captured atomically with `snapshot`. The cursor remains
   * backend-private and names the page immediately older than this exact
   * projection window.
   */
  readonly history: {
    readonly operational: boolean;
    readonly previousCursor?: string;
  };
  subscribeFromNext(listener: BackendEventListener): Unsubscribe;
}

export interface EstablishProjectionInput {
  /**
   * Cancels the entire establishment operation. A backend that can invalidate
   * its handle while capture is pending must make every establishment wait
   * abort-responsive so this operation settles promptly after cancellation;
   * an aborted operation must not return an installable projection.
   */
  readonly signal: AbortSignal;
}

export interface HistoryPageInput {
  readonly cursor?: string;
  readonly limit: number;
  /**
   * Cancels this request-local page acquisition. A backend must observe the
   * signal before starting provider work and across every abortable wait.
   */
  readonly signal?: AbortSignal;
}

export interface BackendHistoryPage {
  readonly orderedBackendTurnIds: readonly string[];
  readonly turnsById: Readonly<Record<string, BackendTurn>>;
  readonly itemsById: BackendConversationSnapshot["itemsById"];
  readonly previousCursor?: string;
}

/**
 * Server-internal targeted history lookup. The application supplies only an
 * identity predicate, so provider-native turn identities never cross the
 * backend boundary. Candidate limits bound source enumeration independently
 * of the cost of hydrating one matched turn.
 */
export interface LocateTurnInput {
  /** Pure synchronous identity comparison; it must not retain the native ID. */
  readonly matchesBackendTurnId: (backendTurnId: string) => boolean;
  /** Positive safe integer; counts native turn candidates, newest first. */
  readonly maximumTurnCandidates: number;
  readonly signal?: AbortSignal;
}

export type LocateTurnResult =
  | {
      readonly status: "found";
      /** Exactly one whole matched turn, with no continuation cursor. */
      readonly page: BackendHistoryPage;
    }
  | { readonly status: "not_found" }
  | { readonly status: "search_limit_reached" };

export interface SubmitTurnInput {
  readonly applicationOperationId: string;
  readonly mutationId: string;
  /** Durable origin used by backend execution-policy enforcement. */
  readonly source: ConversationSubmissionSource;
  /** Caller-generated durable identity that the driver must echo on acceptance. */
  readonly reconciliationToken: string;
  /** May be empty when a selected skill, attachment, or Task context supplies input. */
  readonly text: string;
  readonly contextExcerpts: readonly ContextExcerpt[];
  readonly taskContexts: readonly MaterializedTaskContext[];
  readonly attachments: readonly StagedComposerAttachment[];
  /** Production delivery always supplies this; byte-native backends require it. */
  readonly attachmentBytes?: CanonicalComposerAttachmentByteReader;
  readonly attachmentEvidence?: CanonicalComposerAttachmentEvidenceResolver;
  /** Opaque selection re-resolved by the owning backend at submission time. */
  readonly selectedSkillId?: string;
}

export interface SubmitTurnResult {
  readonly accepted: true;
  readonly reconciliationToken: string;
  /** Stable application correlation carried by the eventual terminal turn. */
  readonly completionCorrelation: string;
  readonly backendTurnId?: string;
}

export interface SteerTurnInput {
  readonly applicationOperationId: string;
  readonly mutationId: string;
  /** Caller-generated durable identity that the driver must echo on acceptance. */
  readonly reconciliationToken: string;
  /** Explicit backend-normalized targeting; conversation targets have no turn fence. */
  readonly target: SteerTarget;
  /** May be empty when a selected skill, attachment, or Task context supplies input. */
  readonly text: string;
  readonly contextExcerpts: readonly ContextExcerpt[];
  readonly taskContexts: readonly MaterializedTaskContext[];
  readonly attachments: readonly StagedComposerAttachment[];
  /** Production delivery always supplies this; byte-native backends require it. */
  readonly attachmentBytes?: CanonicalComposerAttachmentByteReader;
  readonly attachmentEvidence?: CanonicalComposerAttachmentEvidenceResolver;
  /** Opaque selection re-resolved by the owning backend at submission time. */
  readonly selectedSkillId?: string;
}

type SteerTurnResultBase = {
  readonly reconciliationToken: string;
  /** Stable application correlation carried by the eventual terminal turn. */
  readonly completionCorrelation: string;
};

export type SteerTurnResult =
  | (SteerTurnResultBase & {
      /** The backend has authoritatively observed the steered user message. */
      readonly status: "accepted";
      readonly backendTurnId: string;
    })
  | (SteerTurnResultBase & {
      /**
       * The live backend generation acknowledged its volatile native enqueue,
       * but the user message is not durable/provider-authoritative yet.
       */
      readonly status: "pending_materialization";
      readonly backendTurnId?: string;
    });

export interface InterruptTurnInput {
  readonly applicationOperationId: string;
  /**
   * Exact normalized backend turn identity captured before the interrupt
   * receipt crossed the backend boundary. Drivers must refuse to interrupt a
   * different active turn.
   */
  readonly expectedBackendTurnId: string;
}

export type RegisteredBackendActionId =
  "rename" | "compact" | "set_model" | "set_thinking_level" | "set_tool_access";

export type RegisteredBackendActionInput = {
  readonly applicationOperationId: string;
} & (
  | {
      readonly action: "rename";
      readonly title: string;
    }
  | {
      readonly action: "compact";
      readonly instructions?: string;
    }
  | {
      readonly action: "set_model";
      readonly provider: string;
      readonly modelId: string;
    }
  | {
      readonly action: "set_thinking_level";
      readonly level: string;
    }
  | {
      readonly action: "set_tool_access";
      readonly mode: string;
    }
);

export interface BackendActionResult {
  readonly accepted: true;
  readonly capabilityRevision?: string;
}

export type InteractionResponseInput = BackendInteractionResponseInput;

export type BackendMutationReconciliation =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "not_applied" }
  | { readonly outcome: "unknown" };

export type Unsubscribe = () => void;
export type BackendEventListener = (event: SequencedBackendEvent) => void;

export interface ConversationHandle {
  readonly binding: ConversationBinding;

  /** Provider outcomes still settling after live work ends; blocks automatic eviction only. */
  readonly retirementBlocked?: boolean;

  /**
   * Captures a replacement baseline only after the caller has detached the
   * preceding projection subscription. The handle must buffer or journal the
   * gap through `subscribeFromNext`; lifetime-invalidating events remain
   * observable through the independent raw `subscribe` rail.
   */
  establishProjection(
    input: EstablishProjectionInput,
  ): Promise<EstablishedBackendProjection>;
  history(input: HistoryPageInput): Promise<BackendHistoryPage>;
  locateTurn(input: LocateTurnInput): Promise<LocateTurnResult>;
  backendCapabilities(): Promise<BackendCapabilityDocument>;
  usage(): Promise<UsageSnapshot>;

  /**
   * Captures an opaque, bounded description of the durable conversation
   * history immediately before a new submission. The handle must reject this
   * operation unless the conversation is authoritatively settled: either idle
   * after a successful or interrupted turn, or failed after a completed
   * attempt.
   */
  captureSubmissionRetryAnchor(): Promise<string>;
  submit(input: SubmitTurnInput): Promise<SubmitTurnResult>;
  steer(input: SteerTurnInput): Promise<SteerTurnResult>;
  interrupt(input: InterruptTurnInput): Promise<void>;
  reconcileInterrupt(
    input: InterruptTurnInput,
  ): Promise<BackendMutationReconciliation>;
  perform(input: RegisteredBackendActionInput): Promise<BackendActionResult>;
  reconcileAction(
    input: RegisteredBackendActionInput,
  ): Promise<BackendMutationReconciliation>;
  respond(input: InteractionResponseInput): Promise<void>;
  reconcileInteractionResponse(
    input: InteractionResponseInput,
  ): Promise<BackendMutationReconciliation>;

  /**
   * Optional durable external provider-feature mutation. Local features
   * (for example codex.execution) stay in action persistence; external
   * features that require provider RPC implement this path.
   */
  mutateProviderFeature?(input: {
    readonly featureId: string;
    readonly schemaVersion: number;
    readonly actionId: string;
    readonly arguments: unknown;
  }): Promise<{
    readonly outcome: "accepted" | "uncertain" | "rejected";
    readonly projectedState?: unknown;
    readonly safeMessage?: string;
  }>;

  /**
   * Observes raw normalized handle events independently of a projection
   * generation. In particular, an irreversible `provider_handle_closed`
   * invalidation must remain observable while projection replacement is in
   * flight.
   */
  subscribe(listener: (event: BackendConversationEvent) => void): Unsubscribe;
  close(options?: { readonly reason: "evicted" }): Promise<void>;
}

export interface ConversationBackendDriver {
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;

  health(): Promise<BackendHealth>;
  catalog(context: BackendCatalogContext): Promise<BackendCatalog>;
  discover(
    input: DiscoverConversationsInput,
  ): Promise<DiscoveredConversationPage>;
  create(input: CreateConversationInput): Promise<CreateConversationResult>;
  attach(input: AttachConversationInput): Promise<ConversationHandle>;
  read(input: ReadConversationInput): Promise<ConversationReadResult>;
  resolveBranchCheckpoint(
    input: ResolveBranchCheckpointInput,
  ): Promise<BackendCheckpointRef>;
  branchConversation(
    input: BranchConversationInput,
  ): Promise<CreateConversationResult>;
  reconcileSubmission(
    input: ReconcileSubmissionInput,
  ): Promise<SubmissionReconciliation>;
  /**
   * Release provider-owned residency (a service-owned remote query) for a
   * conversation Sedes has no runtime for, such as one being archived.
   * Backends whose provider state never outlives a handle omit this. It must
   * never stop outstanding provider work: it reports `busy` instead. It first
   * applies retained provider output no runtime has applied, and reports
   * `undelivered` if that output still holds the residency.
   */
  releaseConversationResidency?(
    input: ReleaseConversationResidencyInput,
  ): Promise<"released" | "busy" | "undelivered">;
}

export interface ReleaseConversationResidencyInput {
  readonly scope: ExecutionScope;
  readonly binding: ConversationBinding;
  readonly workspace: ValidatedWorkspace;
  readonly opaqueBindingDetail: string;
}

export interface BackendErrorShape {
  readonly category:
    | "unavailable"
    | "incompatible_protocol"
    | "invalid_state"
    | "permission_denied"
    | "not_found"
    | "overloaded"
    | "rejected"
    | "submission_unknown"
    | "internal";
  readonly retryable: boolean;
  readonly crossedSubmissionBoundary: boolean;
  readonly safeMessage: string;
  readonly backendCode?: string;
  /**
   * Normalized proof that an exact-target Steer was rejected before provider
   * acceptance because that target is no longer active. Application delivery
   * may preserve the same durable input as ordinary next-turn queue work.
   */
  readonly steerRejectionReason?: "target_no_longer_active";
  /**
   * A definite fork failure that a new fork of the same boundary would repeat
   * (for example an unsupported runtime or a deterministic history mismatch).
   * The application then does not offer to start another fork.
   */
  readonly forkRestart?: "futile";
}

export class BackendError extends Error implements BackendErrorShape {
  readonly category: BackendErrorShape["category"];
  readonly retryable: boolean;
  readonly crossedSubmissionBoundary: boolean;
  readonly backendCode?: string;
  readonly steerRejectionReason?: BackendErrorShape["steerRejectionReason"];
  readonly forkRestart?: BackendErrorShape["forkRestart"];
  /**
   * Bounded, server-only evidence that an external mutation whose immediate
   * result was uncertain may later become authoritative. The owning mutation
   * boundary must drain this continuation; it is never serialized or exposed
   * through browser protocol.
   */
  readonly lateMutationReconciliation?: Promise<BackendMutationReconciliation>;

  constructor(
    input: BackendErrorShape,
    options?: ErrorOptions & {
      readonly lateMutationReconciliation?: Promise<BackendMutationReconciliation>;
    },
  ) {
    super(input.safeMessage, options);
    this.name = "BackendError";
    this.category = input.category;
    this.retryable = input.retryable;
    this.crossedSubmissionBoundary = input.crossedSubmissionBoundary;
    this.backendCode = input.backendCode;
    this.steerRejectionReason = input.steerRejectionReason;
    this.forkRestart = input.forkRestart;
    this.lateMutationReconciliation = options?.lateMutationReconciliation;
  }

  get safeMessage(): string {
    return this.message;
  }
}
