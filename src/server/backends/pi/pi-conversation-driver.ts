import { turnFailure } from "../turn-failure.js";
import { cancelledPiRetryEntries, createPiCancelledRetryMarker, piCancelledRetryMarkerType } from "./pi-cancelled-retry-marker.js";
import type { ThreadEnvironmentResolver } from "../../environment-variables/runtime-environment.js";
import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { completedAssistantEntryIdForTurn } from "./pi-branch-checkpoints.js";
import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  backendConversationEventSchema,
  backendConversationSnapshotSchema,
  backendHistoryPageSchema,
  type BackendCapabilityDocument,
  type BackendConversationEvent,
  type BackendConversationSnapshot,
  type BackendEffectiveSettings,
  type BackendItem,
  type BackendTurn,
} from "../../../shared/protocol/backend.js";
import { serializedUtf8Bytes } from "../../../shared/protocol/payload.js";
import {
  hasDeliverableComposerInput,
  type UsageSnapshot,
} from "../../../shared/protocol/conversation.js";
import { boundText } from "../../conversations/payload-policy.js";
import type {
  ExecutionScope,
  ValidatedWorkspace,
} from "../../execution/contracts.js";
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
  type BackendHealth,
  type BackendHistoryPage,
  type BranchConversationInput,
  type ConversationBackendDriver,
  type ConversationBinding,
  type ConversationHandle,
  type ConversationReadResult,
  type CreateConversationInput,
  type CreateConversationResult,
  type DiscoveredConversation,
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
import { PI_PROTOCOL_RELEASE } from "./pi-release.js";
import {
  classifyPiBuiltinTool,
  PI_READ_ONLY_BUILTIN_TOOL_NAMES,
} from "./pi-builtin-tool-policy.js";
import {
  isValidSubmissionRetryAnchor,
  requireSubmissionRetryAnchor,
} from "../submission-retry-anchor.js";
import { stagedAttachmentManifest } from "../staged-attachment-manifest.js";
import { PiHistoryProjector } from "./pi-history-projector.js";
import { piAssistantResponseEvidence } from "./pi-assistant-response-phase.js";
import { PiLiveToolProjector } from "./pi-live-tool-projector.js";
import { PiProjectionEstablisher } from "./pi-projection-establisher.js";
import { projectPiUserMessageContent } from "./pi-skill-message.js";
import { formatPiContextExcerptPrompt } from "./pi-context-excerpt-message.js";
import {
  createPiContextExcerptMarker,
  findPiContextExcerptsForSubmission,
  piContextExcerptMarkerType,
} from "./pi-context-excerpt-marker.js";
import { findPiTaskContextsForSubmission } from "./pi-task-context-marker.js";
import {
  DefaultPiSdkSessionFactory,
  PiInteractionBridge,
  piModels,
  piSupportedThinkingLevels,
  piUsage,
  type PiSdkSession,
  type PiSdkSessionFactory,
} from "./pi-sdk-session.js";
import { type RemotePiWorkspaceServices } from "./pi-remote-workspace.js";
import { WorkspaceSkillReaderError } from "../../workspace-skills/contracts.js";
import {
  PiSessionStore,
  type PiSessionStoreOptions,
} from "./pi-session-store.js";
import { PiDiscoverySnapshotStore } from "./pi-discovery-snapshot-store.js";
import { PiToolIdentityCatalog } from "./pi-tool-identities.js";
import {
  correlatePiSubmissions,
  createPiSubmissionMarker,
  piSubmissionFingerprint,
  piSubmissionMarkerType,
  type PiSubmissionMarker,
} from "./pi-submission-marker.js";
import {
  createPiSubmissionAttestation,
  findAuthenticatedPiSubmissionAttestation,
  piSubmissionAttestationType,
  recoverPiTaskSubmissionAttestations,
} from "./pi-submission-attestation.js";
import {
  assertPiToolIdentityAuthentication,
  createPiToolIdentityMarker,
  findPiToolCallAssistantEntryId,
  piToolIdentityMarker,
  piToolIdentityMarkerType,
  samePiToolIdentity,
  type PiToolIdentityAuthentication,
} from "./pi-tool-identity-marker.js";
import {
  createPiActionMarker,
  findPiActionState,
  piActionMarkerType,
} from "./pi-action-marker.js";
import {
  createPiInteractionResponseMarker,
  findPiInteractionResponseState,
  piInteractionResponseMarkerType,
} from "./pi-interaction-response-marker.js";
import { PiCatalogService } from "./pi-catalog-service.js";
import type { BackendAgentToolFacade } from "../../agent-tools/adapters/backend-facade.js";
import type { AgentToolSourceCapabilityIssuer } from "../../agent-tools/application/database-agent-tool-source-authority.js";
import type { TrustedAgentToolSource } from "../../agent-tools/adapters/backend-facade.js";
import {
  createPiAgentToolSet,
  type PiAgentToolSet,
} from "./pi-agent-tool-adapter.js";
import type { TrustedPiAgentToolRegistration } from "./pi-tool-identities.js";
import {
  isPiToolAccessMode,
  PiToolAccessController,
  type PiToolAccessMode,
} from "./pi-tool-access.js";
import { encodePiModelSetting } from "./pi-thread-presentation-provider.js";
import {
  createPiAgentToolCliEnvironment,
  resolvePiAgentToolTurnPresentation,
  type PiAgentToolCliEnvironment,
  type PiAgentToolCliResolution,
  type PiAgentToolTurnPresentation,
  type PiResolvedAgentToolPolicy,
} from "./pi-agent-tool-presentation.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import {
  passivePiIsolatedWorkspaceServices,
  type PiIsolatedWorkspaceResolution,
  type PiIsolatedWorkspaceResolver,
} from "./pi-isolated-workspace.js";

const checkpointVersion = 1;
const maximumPageSize = 1_000;
const submissionPersistenceWaitMilliseconds = 5_000;
// Leave bounded room for application-level history prepends. Older history is
// requested through ConversationHandle.history rather than embedded in every
// authoritative projection.
const readSnapshotTurns = 10;
const targetPiTimelinePayloadBytes = 256 * 1_024;
const maximumPiItemsPerTurn = 1_000;
const maximumPiSnapshotOrPageBytes = 4 * 1_024 * 1_024;
const readOnlyBuiltinToolNames = new Set<string>(
  PI_READ_ONLY_BUILTIN_TOOL_NAMES,
);

interface RetryAnchor {
  readonly version: 1;
  readonly entryId: string | null;
  readonly entryCount: number;
}

export interface PiDriverOptions extends PiSessionStoreOptions {
  readonly resolveThreadEnvironment?: ThreadEnvironmentResolver;
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly nativeDiscoveryNamespaceKey: string;
  readonly discoverySnapshots?: PiDiscoverySnapshotStore;
  readonly agentDir?: string;
  readonly store?: PiSessionStore;
  readonly sessionFactory?: PiSdkSessionFactory;
  readonly resolveRemoteWorkspace?: (
    workspace: ValidatedWorkspace,
    mode: "passive" | "active",
  ) => RemotePiWorkspaceServices | undefined;
  readonly isolatedWorkspaces?: PiIsolatedWorkspaceResolver;
  readonly toolProvenanceKey: Uint8Array;
  readonly toolAccessPolicy: (
    scope: ExecutionScope,
    applicationThreadId: string,
  ) => PiToolAccessMode;
  /**
   * Reports the attached session's observed effective settings so the
   * backend-owned module can keep its durable settings row converged with
   * the live session. The backend is authoritative for the values it
   * provides; Sedes-owned policy (tool access) is excluded there.
   */
  readonly onEffectiveSettings?: (
    scope: ExecutionScope,
    applicationThreadId: string,
    settings: BackendEffectiveSettings,
  ) => void;
  readonly agentTools: BackendAgentToolFacade;
  readonly agentToolSourceCapabilities: AgentToolSourceCapabilityIssuer;
  readonly agentToolCli?: PiAgentToolCliResolution;
  readonly now?: () => string;
  readonly modelPolicy: CompiledBackendModelPolicy;
}

interface ResolvedPiWorkspace {
  readonly workspace: ValidatedWorkspace;
  readonly remoteWorkspace?: RemotePiWorkspaceServices;
  readonly isolatedWorkspace?: RemotePiWorkspaceServices;
  readonly isolatedResolution?: PiIsolatedWorkspaceResolution;
  release(): Promise<void>;
}

function modelPolicyError(): BackendError {
  return error(
    "rejected",
    "This model or reasoning effort is not allowed by the backend policy.",
    "model_policy_rejected",
  );
}

function assertPiModelPolicy(
  policy: CompiledBackendModelPolicy,
  model: { readonly provider: string; readonly id: string } | undefined,
  reasoningEffort: string | undefined,
): asserts model is { readonly provider: string; readonly id: string } {
  if (
    !model ||
    !policy.isSelectionAllowed({
      providerId: model.provider,
      modelId: model.id,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    })
  ) {
    throw modelPolicyError();
  }
}

function piModelHasAllowedEffort(
  policy: CompiledBackendModelPolicy,
  model: {
    readonly provider: string;
    readonly id: string;
    readonly reasoning?: unknown;
    readonly thinkingLevelMap?: unknown;
  },
): boolean {
  return piSupportedThinkingLevels(model).some((reasoningEffort) =>
    policy.isSelectionAllowed({
      providerId: model.provider,
      modelId: model.id,
      reasoningEffort,
    }),
  );
}

function filterPiModels(
  policy: CompiledBackendModelPolicy,
  models: readonly import("../contracts.js").BackendModelDescriptor[],
): readonly import("../contracts.js").BackendModelDescriptor[] {
  return models.flatMap((model) => {
    try {
      encodePiModelSetting(model.provider, model.id);
    } catch {
      return [];
    }
    const base = { providerId: model.provider, modelId: model.id };
    if (model.supportedReasoningEfforts === undefined) {
      return policy.isModelWithoutReasoningEffortAllowed(base) ? [model] : [];
    }
    const supportedReasoningEfforts = policy.filterReasoningEfforts(
      base,
      model.supportedReasoningEfforts,
    );
    return supportedReasoningEfforts.length > 0
      ? [{ ...model, supportedReasoningEfforts }]
      : [];
  });
}

function error(
  category:
    | "internal"
    | "incompatible_protocol"
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
  cause?: unknown,
): BackendError {
  return new BackendError(
    {
      category,
      retryable,
      crossedSubmissionBoundary,
      safeMessage,
      backendCode,
    },
    cause === undefined ? undefined : { cause },
  );
}

function piSteerTargetUnavailable(
  safeMessage: string,
  backendCode: string,
): BackendError {
  return new BackendError({
    category: "invalid_state",
    retryable: false,
    crossedSubmissionBoundary: false,
    safeMessage,
    backendCode,
    steerRejectionReason: "target_no_longer_active",
  });
}

function mappedError(cause: unknown, boundaryCrossed = false): BackendError {
  if (cause instanceof BackendError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message === "normalized_payload_exceeds_serialized_byte_limit") {
    return error(
      "incompatible_protocol",
      "Pi returned conversation text that exceeds the supported message size.",
      "pi_message_payload_too_large",
      false,
      boundaryCrossed,
      cause,
    );
  }
  if (message.includes("no model") || message.includes("API key")) {
    return error(
      "unavailable",
      "Pi does not have an available authenticated model.",
      "pi_model_unavailable",
      true,
      boundaryCrossed,
      cause,
    );
  }
  if (message.includes("busy") || message.includes("streaming")) {
    return error(
      "invalid_state",
      "The Pi conversation is already running.",
      "pi_conversation_busy",
      false,
      boundaryCrossed,
      cause,
    );
  }
  if (
    message === "pi_title_required" ||
    message === "pi_model_not_available" ||
    message === "pi_thinking_level_unsupported" ||
    message === "pi_tool_access_invalid"
  ) {
    return error(
      "rejected",
      "Pi rejected the requested conversation setting.",
      message,
      false,
      boundaryCrossed,
      cause,
    );
  }
  if (message === "pi_skill_unavailable") {
    return error(
      "rejected",
      "The selected Pi skill is no longer available in this workspace.",
      "pi_skill_unavailable",
      false,
      boundaryCrossed,
      cause,
    );
  }
  if (cause instanceof WorkspaceSkillReaderError) {
    if (cause.code === "workspace_skills_catalog_changed") {
      return error(
        "rejected",
        "The selected Pi skill changed. Reselect it before submitting.",
        "pi_skill_catalog_changed",
        false,
        boundaryCrossed,
        cause,
      );
    }
    if (cause.code === "workspace_skills_skill_not_found") {
      return error(
        "rejected",
        "The selected Pi skill is no longer available in this workspace.",
        "pi_skill_unavailable",
        false,
        boundaryCrossed,
        cause,
      );
    }
    return error(
      "unavailable",
      "The selected Pi skill could not be read from the remote environment.",
      "pi_remote_skill_unavailable",
      cause.retryable,
      boundaryCrossed,
      cause,
    );
  }
  return error(
    boundaryCrossed ? "submission_unknown" : "internal",
    boundaryCrossed
      ? "Pi may have accepted the input, but its outcome is unknown."
      : "Pi could not complete the requested operation.",
    boundaryCrossed ? "pi_submission_outcome_unknown" : "pi_operation_failed",
    boundaryCrossed,
    boundaryCrossed,
    cause,
  );
}

async function backendCall<T>(
  operation: () => Promise<T> | T,
  boundaryCrossed = false,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw mappedError(cause, boundaryCrossed);
  }
}

/**
 * Classifies a failed thinking-level change. Pi clamps an unsupported level
 * to the nearest model-supported value instead of rejecting it, so a
 * post-action level identical to the pre-action level proves the action was
 * never applied and must fail before the submission boundary. Only a level
 * that changed to an unexpected value is genuinely uncertain and fails
 * closed across the boundary.
 */
function thinkingLevelApplicationError(
  cause: unknown,
  priorLevel: string,
  observedLevel: string,
): BackendError {
  if (observedLevel === priorLevel) {
    return error(
      "rejected",
      "Pi did not apply the requested thinking level.",
      "pi_thinking_level_unsupported",
      false,
      false,
      cause,
    );
  }
  return error(
    "submission_unknown",
    "Pi changed the thinking level, but not to the requested value.",
    "pi_thinking_level_outcome_unknown",
    true,
    true,
    cause,
  );
}

/**
 * Durable native evidence that a started backend action actually applied its
 * requested value. Only actions whose application writes a recognized native
 * entry are decidable; anything else stays genuinely unknown.
 */
function piActionApplicationEvidence(
  suffix: readonly SessionEntry[],
  input: RegisteredBackendActionInput,
): boolean {
  if (input.action === "set_thinking_level") {
    return suffix.some(
      (entry) =>
        entry.type === "thinking_level_change" &&
        entry.thinkingLevel === input.level,
    );
  }
  if (input.action === "set_model") {
    return suffix.some(
      (entry) =>
        entry.type === "model_change" &&
        entry.provider === input.provider &&
        entry.modelId === input.modelId,
    );
  }
  if (input.action === "rename") {
    const title = input.title.replace(/[\r\n]+/g, " ").trim();
    return suffix.some(
      (entry) => entry.type === "session_info" && entry.name === title,
    );
  }
  return false;
}

function token(kind: string, ...parts: readonly string[]): string {
  return `pi:${kind}:${createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")}`;
}

function validatePage(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximumPageSize) {
    throw error(
      "rejected",
      "The requested Pi page size is invalid.",
      "pi_page_limit_invalid",
    );
  }
}

function validateTurnCandidateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw error(
      "rejected",
      "The requested Pi turn candidate limit is invalid.",
      "pi_turn_candidate_limit_invalid",
    );
  }
}

function throwIfDiscoveryAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function waitForDiscoveryOperation<Result>(
  operation: Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  return operation.then(
    (value) => {
      throwIfDiscoveryAborted(signal);
      return value;
    },
    (error: unknown) => {
      throwIfDiscoveryAborted(signal);
      throw error;
    },
  );
}

function parseHistoryCursor(
  cursor: string | undefined,
  conversationId: string,
  maximum: number,
): number {
  if (cursor === undefined) return maximum;
  const match = /^pi-history:([^:]*):(\d+)$/.exec(cursor);
  const before = match ? Number(match[2]) : Number.NaN;
  if (
    !match ||
    match[1] !== encodeURIComponent(conversationId) ||
    !Number.isSafeInteger(before) ||
    before < 0 ||
    before > maximum
  ) {
    throw error(
      "rejected",
      "The Pi history cursor is invalid or stale.",
      "pi_history_cursor_invalid",
    );
  }
  return before;
}

function capabilities(
  session: PiSdkSession,
  toolAccessMode: PiToolAccessMode,
  sedesAgentToolNames: ReadonlySet<string> = new Set(),
): BackendCapabilityDocument {
  const activeTools = session.getActiveToolNames().sort();
  const allTools = session
    .getAllTools()
    .map(({ name }) => name)
    .sort();
  return {
    revision: token(
      "capabilities",
      [
        allTools.join(","),
        activeTools.join(","),
        toolAccessMode,
        session.model?.provider ?? "",
        session.model?.id ?? "",
        session.thinkingLevel,
        "provider-output-image:false",
        session.isolatedWorkspace ? "isolated:true" : "isolated:false",
      ].join("\0"),
    ),
    actions: [
      "rename",
      "compact",
      "set_model",
      "set_thinking_level",
      "set_tool_access",
    ],
    deliveryModes: ["submit", "steer"],
    steerTarget: "turn",
    composerAttachments: {
      fileStaging: true,
      nativeImage: session.model?.input.includes("image") === true,
    },
    nonblockingQuestions: false,
    providerOutputArtifacts: { nativeImage: false },
    supportsHistory: true,
    branching: session.isolatedWorkspace
      ? {
          availability: "unavailable",
          reason: {
            text: "Forking is unavailable for isolated Pi workspaces until Sedes can copy the exact working tree into an independent child allocation.",
          },
        }
      : {
          availability: "available",
          boundaries: ["latest_completed", "selected_completed_turn"],
          method: "provider_native",
          sourceMustBeIdle: false,
          settingsInheritance: "application_applied",
          fidelity: {
            instructions: false,
            messages: true,
            toolCalls: true,
            toolResults: true,
            compaction: true,
            attachments: true,
            settings: true,
            limitations: [
              {
                text: "Pi reloads environment instructions for the child instead of snapshotting the source instruction set.",
              },
            ],
          },
          childIdentity: "application_reserved",
          creationRecovery: "idempotent",
        },
    interactionKinds: [
      "choice",
      "confirmation",
      "text_input",
      "editor",
      "decision",
    ],
    usageSections: ["context", "tokens", "cost", "counters"],
    effectiveSettings: {
      ...(session.model
        ? {
            model: {
              provider: session.model.provider,
              id: session.model.id,
            },
          }
        : {}),
      thinkingLevel: session.thinkingLevel,
      toolAccess: toolAccessMode,
    },
  };
}

function sameToolNames(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((name, index) => name === right[index])
  );
}

function applyToolAccess(
  session: PiSdkSession,
  mode: PiToolAccessMode,
  toolAccess: PiToolAccessController,
  allSedesAgentToolNames: ReadonlySet<string> = new Set(),
  enabledSedesAgentToolNames: ReadonlySet<string> = new Set(),
  enabledReadOnlySedesAgentToolNames: ReadonlySet<string> = new Set(),
): void {
  const all = session.getAllTools();
  const trustedBuiltinOverrides = session.trustedBuiltinOverrides ?? new Set();
  // `ask` activates the same tool catalog as `full`; the managed approval
  // extension intercepts built-in mutators and non-read-only Sedes tools
  // before execution.
  const selected = all.flatMap((tool) => {
    const builtin = classifyPiBuiltinTool(tool, trustedBuiltinOverrides);
    if (builtin) {
      return mode === "read_only" && !readOnlyBuiltinToolNames.has(builtin)
        ? []
        : [tool.name];
    }
    if (allSedesAgentToolNames.has(tool.name)) {
      const enabled =
        mode === "read_only"
          ? enabledReadOnlySedesAgentToolNames.has(tool.name)
          : enabledSedesAgentToolNames.has(tool.name);
      return enabled ? [tool.name] : [];
    }
    return mode === "read_only" ? [] : [tool.name];
  });
  if (
    mode === "read_only" &&
    (!selected.includes("read") ||
      !selected.some(
        (name) => name === "grep" || name === "find" || name === "ls",
      ))
  ) {
    throw error(
      "rejected",
      "Pi does not provide the required read-only tool set.",
      "pi_read_only_tools_unavailable",
    );
  }
  // Expand: arm policy mode before enabling mutators. Restrict: drop mutators
  // before clearing ask/full so a concurrent tool_call cannot see a full catalog
  // under a still-ask controller window.
  if (mode !== "read_only") {
    toolAccess.setMode(mode);
  }
  session.setActiveToolsByName(selected);
  const actual = session.getActiveToolNames().sort();
  const expected = [...selected].sort();
  if (!sameToolNames(actual, expected)) {
    throw error(
      "invalid_state",
      "Pi did not apply the requested tool access.",
      "pi_tool_access_not_applied",
    );
  }
  for (const tool of session.getAllTools()) {
    classifyPiBuiltinTool(tool, trustedBuiltinOverrides);
  }
  toolAccess.setMode(mode);
}

function checkpoint(
  entryId: string,
  backendInstanceId: string,
): BackendCheckpointRef {
  return {
    backendInstanceId,
    kind: "conversation_leaf",
    opaqueReference: JSON.stringify({
      version: checkpointVersion,
      entryId,
    }),
  };
}

function checkpointEntryId(reference: BackendCheckpointRef): string {
  if (reference.kind !== "conversation_leaf") {
    throw error(
      "rejected",
      "The Pi branch checkpoint is invalid.",
      "pi_checkpoint_invalid",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(reference.opaqueReference);
  } catch {
    parsed = undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Object.keys(parsed).some((key) => key !== "version" && key !== "entryId") ||
    !("version" in parsed) ||
    parsed.version !== checkpointVersion ||
    !("entryId" in parsed) ||
    typeof parsed.entryId !== "string" ||
    !parsed.entryId
  ) {
    throw error(
      "rejected",
      "The Pi branch checkpoint is invalid.",
      "pi_checkpoint_invalid",
    );
  }
  return parsed.entryId;
}

function findSubmission(
  entries: readonly SessionEntry[],
  applicationOperationId: string,
):
  | {
      readonly marker: PiSubmissionMarker;
      readonly userEntryId?: string;
      readonly providerTurnId?: string;
      readonly rejected: boolean;
      readonly invalid?: "orphan_steer" | "displaced_steer" | "lost_steer";
    }
  | undefined {
  return correlatePiSubmissions(entries).get(applicationOperationId);
}

function assertSubmissionReplay(
  found: {
    readonly marker: PiSubmissionMarker;
    readonly userEntryId?: string;
  },
  input: SubmitTurnInput | SteerTurnInput,
  mode: PiSubmissionMarker["mode"],
): void {
  if (
    found.marker.reconciliationToken !== input.reconciliationToken ||
    found.marker.mutationId !== input.mutationId ||
    found.marker.mode !== mode ||
    found.marker.requestFingerprint !==
      piSubmissionFingerprint({ ...input, mode })
  ) {
    throw error(
      "rejected",
      "The Pi submission operation was replayed with another request.",
      "pi_submission_replay_mismatch",
    );
  }
}

function piAttachmentPrompt(
  input: SubmitTurnInput | SteerTurnInput,
  text: string,
  key: Uint8Array,
): string {
  return input.attachments.length === 0
    ? text
    : `${stagedAttachmentManifest({
        key,
        correlation: input.applicationOperationId,
        attachments: input.attachments,
      })}\n${text}`;
}

async function piNativeImages(
  session: PiSdkSession,
  input: SubmitTurnInput | SteerTurnInput,
): Promise<
  readonly {
    readonly type: "image";
    readonly data: string;
    readonly mimeType: string;
  }[]
> {
  if (!session.model?.input.includes("image")) return [];
  const imageAttachments = input.attachments.filter(
    (attachment) => attachment.kind === "image",
  );
  if (imageAttachments.length === 0) return [];
  if (!input.attachmentBytes) {
    throw error(
      "internal",
      "The canonical attachment byte source is unavailable.",
      "pi_attachment_byte_source_unavailable",
    );
  }
  const attachmentBytes = input.attachmentBytes;
  return await Promise.all(
    imageAttachments.map(async (attachment) => {
      const bytes = await attachmentBytes.read(attachment);
      return {
        type: "image" as const,
        data: bytes.toString("base64"),
        mimeType: attachment.mediaType,
      };
    }),
  );
}

function parseRetryAnchor(value: string | undefined): RetryAnchor | undefined {
  if (value === undefined) return undefined;
  if (!isValidSubmissionRetryAnchor(value)) {
    throw error(
      "rejected",
      "The Pi retry anchor is invalid.",
      "pi_retry_anchor_invalid",
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
      (key) => key !== "version" && key !== "entryId" && key !== "entryCount",
    ) ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("entryId" in parsed) ||
    (parsed.entryId !== null && typeof parsed.entryId !== "string") ||
    (typeof parsed.entryId === "string" &&
      (parsed.entryId.length === 0 || parsed.entryId.length > 128)) ||
    !("entryCount" in parsed) ||
    !Number.isSafeInteger(parsed.entryCount) ||
    (parsed.entryCount as number) < 0 ||
    ((parsed.entryCount as number) === 0) !== (parsed.entryId === null)
  ) {
    throw error(
      "rejected",
      "The Pi retry anchor is invalid.",
      "pi_retry_anchor_invalid",
    );
  }
  return parsed as RetryAnchor;
}

/**
 * Selects the newest contiguous whole-turn window that satisfies both Pi's
 * count policy and the backend aggregate wire contract.
 */
export function selectPiSnapshotWindow(
  snapshot: BackendConversationSnapshot,
  maximumTurns: number,
  conversationId: string,
): BackendConversationSnapshot {
  const end = snapshot.orderedBackendTurnIds.length;
  if (end === 0) {
    return backendConversationSnapshotSchema.parse(
      snapshotPayload(snapshot, []),
    );
  }
  const earliestByCount = Math.max(0, end - maximumTurns);
  const bytesAt = (start: number) => {
    const candidateIds = snapshot.orderedBackendTurnIds.slice(start, end);
    const candidate = snapshotPayload(snapshot, candidateIds);
    const historyCandidate = historyPagePayload(
      snapshot,
      conversationId,
      start,
      end,
    );
    return Math.max(
      serializedUtf8Bytes(candidate),
      serializedUtf8Bytes(historyCandidate),
    );
  };
  const newestBytes = bytesAt(end - 1);
  if (newestBytes > maximumPiSnapshotOrPageBytes) {
    throw oversizedTurn();
  }
  const start =
    newestBytes > targetPiTimelinePayloadBytes
      ? end - 1
      : earliestStartWithinBytes(
          earliestByCount,
          end - 1,
          targetPiTimelinePayloadBytes,
          bytesAt,
        );
  const selectedIds = snapshot.orderedBackendTurnIds.slice(start, end);
  assertTransferablePiTurns(snapshot, selectedIds);
  return backendConversationSnapshotSchema.parse(
    snapshotPayload(snapshot, selectedIds),
  );
}

/**
 * Selects one authoritative Pi projection seed and the exact private boundary
 * immediately before it. The cursor is derived from the complete persisted
 * branch projection, never from the already-trimmed in-memory suffix.
 */
export function selectPiProjectionWindow(
  snapshot: BackendConversationSnapshot,
  maximumTurns: number,
  conversationId: string,
): {
  readonly snapshot: BackendConversationSnapshot;
  readonly history: EstablishedBackendProjection["history"];
} {
  const selected = selectPiSnapshotWindow(
    snapshot,
    maximumTurns,
    conversationId,
  );
  const start =
    selected.orderedBackendTurnIds.length === 0
      ? 0
      : snapshot.orderedBackendTurnIds.indexOf(
          selected.orderedBackendTurnIds[0]!,
        );
  if (start < 0) {
    throw new Error("pi_projection_window_boundary_missing");
  }
  return {
    snapshot: selected,
    history: {
      operational: true,
      ...(start > 0
        ? {
            previousCursor: `pi-history:${encodeURIComponent(conversationId)}:${start}`,
          }
        : {}),
    },
  };
}

function earliestStartWithinBytes(
  earliest: number,
  latest: number,
  maximumBytes: number,
  bytesAt: (start: number) => number,
): number {
  let lower = earliest;
  let upper = latest;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (bytesAt(middle) <= maximumBytes) {
      upper = middle;
    } else {
      lower = middle + 1;
    }
  }
  return lower;
}

function snapshotPayload(
  snapshot: BackendConversationSnapshot,
  orderedBackendTurnIds: readonly string[],
): BackendConversationSnapshot {
  const selected = new Set(orderedBackendTurnIds);
  return {
    runState: snapshot.runState,
    orderedBackendTurnIds: [...orderedBackendTurnIds],
    turnsById: Object.fromEntries(
      orderedBackendTurnIds.map((id) => [id, snapshot.turnsById[id]!]),
    ),
    itemsById: Object.fromEntries(
      Object.entries(snapshot.itemsById).filter(([, item]) =>
        selected.has(item.backendTurnId),
      ),
    ),
    ...(snapshot.activeBackendTurnId &&
    selected.has(snapshot.activeBackendTurnId)
      ? { activeBackendTurnId: snapshot.activeBackendTurnId }
      : {}),
  };
}

function oversizedTurn(): BackendError {
  return error(
    "internal",
    "A Pi turn is too large to transfer as one complete timeline unit.",
    "pi_turn_payload_too_large",
  );
}

function assertTransferablePiTurns(
  snapshot: BackendConversationSnapshot,
  turnIds: readonly string[],
): void {
  if (
    turnIds.some(
      (turnId) =>
        (snapshot.turnsById[turnId]?.orderedBackendItemIds.length ?? 0) >
        maximumPiItemsPerTurn,
    )
  ) {
    throw oversizedTurn();
  }
}

function historyPagePayload(
  snapshot: BackendConversationSnapshot,
  conversationId: string,
  start: number,
  before: number,
): BackendHistoryPage {
  const ids = snapshot.orderedBackendTurnIds.slice(start, before);
  const included = new Set(ids);
  return {
    orderedBackendTurnIds: ids,
    turnsById: Object.fromEntries(
      ids.map((id) => [id, snapshot.turnsById[id]!]),
    ),
    itemsById: Object.fromEntries(
      Object.entries(snapshot.itemsById).filter(([, item]) =>
        included.has(item.backendTurnId),
      ),
    ),
    ...(start > 0
      ? {
          previousCursor: `pi-history:${encodeURIComponent(conversationId)}:${start}`,
        }
      : {}),
  };
}

/**
 * Selects the contiguous page ending exactly at `before`. The returned cursor
 * names the actual first omitted turn, including when bytes truncate a page
 * before its requested count.
 */
export function selectPiHistoryPage(
  snapshot: BackendConversationSnapshot,
  conversationId: string,
  before: number,
  maximumTurns: number,
): BackendHistoryPage {
  if (before === 0) {
    return backendHistoryPageSchema.parse({
      orderedBackendTurnIds: [],
      turnsById: {},
      itemsById: {},
    });
  }
  const earliestByCount = Math.max(0, before - maximumTurns);
  const bytesAt = (start: number) =>
    serializedUtf8Bytes(
      historyPagePayload(snapshot, conversationId, start, before),
    );
  const newestBytes = bytesAt(before - 1);
  if (newestBytes > maximumPiSnapshotOrPageBytes) {
    throw oversizedTurn();
  }
  const start =
    newestBytes > targetPiTimelinePayloadBytes
      ? before - 1
      : earliestStartWithinBytes(
          earliestByCount,
          before - 1,
          targetPiTimelinePayloadBytes,
          bytesAt,
        );
  const selectedIds = snapshot.orderedBackendTurnIds.slice(start, before);
  assertTransferablePiTurns(snapshot, selectedIds);
  return backendHistoryPageSchema.parse(
    historyPagePayload(snapshot, conversationId, start, before),
  );
}

function turnDurablyComplete(
  entries: readonly SessionEntry[],
  providerTurnId: string,
): boolean {
  const start = entries.findIndex(({ id }) => id === providerTurnId);
  if (start < 0) return false;
  const submissionsByUserEntry = new Map(
    [...correlatePiSubmissions(entries).values()].flatMap(
      ({ invalid, marker, userEntryId }) =>
        userEntryId && !invalid ? [[userEntryId, marker] as const] : [],
    ),
  );
  const turnEntries: SessionEntry[] = [];
  for (const entry of entries.slice(start + 1)) {
    if (entry.type === "message" && entry.message.role === "user") {
      const marker = submissionsByUserEntry.get(entry.id);
      if (marker?.mode !== "steer") {
        break;
      }
    }
    turnEntries.push(entry);
  }
  const lastAssistant = turnEntries.findLast(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  if (
    !lastAssistant ||
    lastAssistant.type !== "message" ||
    lastAssistant.message.role !== "assistant"
  ) {
    return false;
  }
  return (
    (lastAssistant.message.stopReason === "stop" ||
      lastAssistant.message.stopReason === "length") &&
    !lastAssistant.message.content.some((part) => part.type === "toolCall")
  );
}

function providerTurnForUserEntry(
  entries: readonly SessionEntry[],
  userEntryId: string,
): string | undefined {
  const correlated = [...correlatePiSubmissions(entries).values()].find(
    ({ userEntryId: candidate }) => candidate === userEntryId,
  );
  if (correlated?.invalid) return undefined;
  return correlated?.providerTurnId ?? userEntryId;
}

function contentText(message: unknown): string {
  if (
    typeof message !== "object" ||
    message === null ||
    !("content" in message)
  ) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .flatMap((part): string[] =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join("")
    : "";
}

export class PiConversationBackendDriver implements ConversationBackendDriver {
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly #resolveThreadEnvironment: ThreadEnvironmentResolver;
  readonly #store: PiSessionStore;
  readonly #sessionFactory: PiSdkSessionFactory;
  readonly #toolProvenanceKey: Uint8Array;
  readonly #toolAccessPolicy: PiDriverOptions["toolAccessPolicy"];
  readonly #onEffectiveSettings: PiDriverOptions["onEffectiveSettings"];
  readonly #agentTools: BackendAgentToolFacade;
  readonly #agentToolSourceCapabilities: AgentToolSourceCapabilityIssuer;
  readonly #agentToolCli: PiAgentToolCliResolution;
  readonly #now: () => string;
  readonly #catalogs: PiCatalogService;
  readonly #nativeDiscoveryNamespaceKey: string;
  readonly #resolveRemoteWorkspace?: PiDriverOptions["resolveRemoteWorkspace"];
  readonly #isolatedWorkspaces?: PiIsolatedWorkspaceResolver;
  readonly #discoverySnapshots: PiDiscoverySnapshotStore;
  readonly #openHandles = new Map<string, PiConversationHandle>();
  readonly #pendingAttachments = new Set<string>();
  readonly #modelPolicy: CompiledBackendModelPolicy;

  constructor(options: PiDriverOptions) {
    this.#resolveThreadEnvironment = options.resolveThreadEnvironment ?? (async () => Object.freeze({}));
    this.instance = options.instance;
    this.connection = options.connection;
    if (options.nativeDiscoveryNamespaceKey.length === 0) {
      throw new Error("pi_discovery_native_namespace_invalid");
    }
    this.#nativeDiscoveryNamespaceKey = options.nativeDiscoveryNamespaceKey;
    this.#resolveRemoteWorkspace = options.resolveRemoteWorkspace;
    this.#isolatedWorkspaces = options.isolatedWorkspaces;
    this.#discoverySnapshots =
      options.discoverySnapshots ?? new PiDiscoverySnapshotStore();
    this.#store =
      options.store ??
      new PiSessionStore({
        sessionDirectory: options.sessionDirectory,
        workspacePathMode: options.workspacePathMode,
      });
    this.#sessionFactory =
      options.sessionFactory ??
      new DefaultPiSdkSessionFactory({ agentDir: options.agentDir });
    const toolIdentityAuthentication = {
      conversationId: "configuration-validation",
      installationKey: options.toolProvenanceKey,
    };
    assertPiToolIdentityAuthentication(toolIdentityAuthentication);
    this.#toolProvenanceKey = new Uint8Array(options.toolProvenanceKey);
    this.#toolAccessPolicy = options.toolAccessPolicy;
    this.#onEffectiveSettings = options.onEffectiveSettings;
    this.#agentTools = options.agentTools;
    this.#agentToolSourceCapabilities = options.agentToolSourceCapabilities;
    this.#agentToolCli =
      options.agentToolCli ??
      Object.freeze({
        availability: "unavailable" as const,
        reason: "remote_environment" as const,
      });
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#modelPolicy = options.modelPolicy;
    this.#catalogs = new PiCatalogService({
      owner: {
        tenantId: this.connection.tenantId,
        ownerPrincipalId: this.connection.ownerPrincipalId,
        backendInstanceId: this.instance.id,
        backendConfigurationRevision: this.instance.configurationRevision,
        connectionProfileId: this.connection.id,
        connectionConfigurationRevision: this.connection.configurationRevision,
      },
    });
    if (
      this.instance.id !== this.connection.backendInstanceId ||
      this.instance.tenantId !== this.connection.tenantId
    ) {
      throw new Error("pi_driver_configuration_invalid");
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.#openHandles.values()].map((handle) => handle.close()),
    );
    this.#openHandles.clear();
  }

  async #resolveWorkspace(input: {
    readonly scope: ExecutionScope;
    readonly applicationThreadId: string;
    readonly sourceWorkspace: ValidatedWorkspace;
    readonly access: "passive" | "prepare" | "active";
  }): Promise<ResolvedPiWorkspace> {
    const isolatedResolution = await this.#isolatedWorkspaces?.resolve(input);
    if (isolatedResolution) {
      if (isolatedResolution.access !== input.access) {
        throw new Error("pi_isolated_workspace_access_mismatch");
      }
      const isolatedWorkspace =
        isolatedResolution.access === "active"
          ? {
              semanticCwd: isolatedResolution.semanticCwd,
              serviceCwd: isolatedResolution.serviceCwd,
              sandboxWorkspaceAccess: isolatedResolution.workspaceAccess,
              executor: isolatedResolution.executor,
              contextReader: isolatedResolution.contextReader,
              environmentLabel: isolatedResolution.environmentLabel,
            }
          : isolatedResolution.access === "passive"
            ? passivePiIsolatedWorkspaceServices(isolatedResolution)
            : undefined;
      return {
        workspace: isolatedResolution.effectiveWorkspace,
        ...(isolatedWorkspace ? { isolatedWorkspace } : {}),
        isolatedResolution,
        release: () => isolatedResolution.release(),
      };
    }
    const remoteWorkspace = this.#resolveRemoteWorkspace?.(
      input.sourceWorkspace,
      input.access === "active" ? "active" : "passive",
    );
    return {
      workspace: input.sourceWorkspace,
      ...(remoteWorkspace ? { remoteWorkspace } : {}),
      async release() {},
    };
  }

  async health(): Promise<BackendHealth> {
    const available =
      this.instance.enabled &&
      this.connection.enabled &&
      this.instance.protocolRelease === PI_PROTOCOL_RELEASE;
    return {
      available,
      checkedAt: this.#now(),
      ...(!available
        ? {
            diagnostic: {
              text:
                this.instance.protocolRelease !== PI_PROTOCOL_RELEASE
                  ? "The persisted Pi integration profile does not match this Sedes build."
                  : "The Pi backend connection is disabled.",
            },
          }
        : {}),
    };
  }

  async catalog(context: BackendCatalogContext): Promise<BackendCatalog> {
    this.#assertScope(context.scope);
    this.#assertWorkspaceTarget(context.workspace);
    return this.#catalogs.read(context.workspace, async () => {
      const manager = this.#store.transient(context.workspace);
      const interactions = new PiInteractionBridge({
        cancelUnpublishedRequests: true,
      });
      const remoteWorkspace = this.#resolveRemoteWorkspace?.(
        context.workspace,
        "passive",
      );
      const session = await backendCall(() =>
        this.#sessionFactory.create({
          manager,
          workspace: context.workspace,
          interactions,
          ...(remoteWorkspace ? { remoteWorkspace } : {}),
        }),
      );
      try {
        await backendCall(() => session.ready());
        return {
          ...session.catalog(),
          models: filterPiModels(this.#modelPolicy, await piModels(session)),
        };
      } finally {
        interactions.close();
        session.dispose();
      }
    });
  }

  async discover(
    input: DiscoverConversationsInput,
  ): Promise<DiscoveredConversationPage> {
    throwIfDiscoveryAborted(input.signal);
    this.#assertScope(input.scope);
    this.#assertWorkspaceTarget(input.workspace);
    validatePage(input.limit);
    const snapshotBinding = {
      tenantId: input.scope.tenantId,
      principalId: input.scope.principalId,
      backendInstanceId: this.instance.id,
      executionEnvironmentId: this.connection.executionEnvironmentId,
      canonicalWorkspacePath: input.workspace.canonicalPath,
      nativeNamespaceKey: this.#nativeDiscoveryNamespaceKey,
    };
    if (input.cursor !== undefined) {
      throwIfDiscoveryAborted(input.signal);
      return this.#discoverySnapshots.continuePage({
        binding: snapshotBinding,
        cursor: input.cursor,
        pageSize: input.limit,
      });
    }
    const sessions = await waitForDiscoveryOperation(
      backendCall(() =>
        this.#store.listWithAncestry(input.workspace, this.#toolProvenanceKey, {
          signal: input.signal,
          assertConversationCount: (count) =>
            this.#discoverySnapshots.assertConversationCount(count),
        }),
      ),
      input.signal,
    );
    throwIfDiscoveryAborted(input.signal);
    this.#discoverySnapshots.assertConversationCount(sessions.length);
    const conversations: DiscoveredConversation[] = [];
    for (const session of sessions) {
      throwIfDiscoveryAborted(input.signal);
      const sourceBackendTurnId = session.nativeAncestry?.sourceBackendTurnId;
      conversations.push({
        backendConversationId: session.backendConversationId,
        canonicalWorkspacePath: session.canonicalWorkspacePath,
        ...(session.title ? { title: session.title } : {}),
        updatedAt: session.updatedAt,
        opaqueBindingDetail: this.#store.bindingDetail(
          session.backendConversationId,
          session.sessionFile,
        ),
        ...(session.nativeAncestry
          ? {
              nativeAncestry: {
                method: "provider_native" as const,
                parentBackendConversationId:
                  session.nativeAncestry.parentBackendConversationId,
                ...(sourceBackendTurnId ? { sourceBackendTurnId } : {}),
                ...(sourceBackendTurnId &&
                session.nativeAncestry.applicationOperationId
                  ? {
                      applicationOperationId:
                        session.nativeAncestry.applicationOperationId,
                      childIdentity: "application_reserved" as const,
                      creationRecovery: "idempotent" as const,
                    }
                  : {}),
              },
            }
          : {}),
      });
    }
    throwIfDiscoveryAborted(input.signal);
    return this.#discoverySnapshots.createFirstPage({
      binding: snapshotBinding,
      conversations,
      pageSize: input.limit,
    });
  }

  async create(
    input: CreateConversationInput,
  ): Promise<CreateConversationResult> {
    this.#assertScope(input.scope);
    this.#assertWorkspaceTarget(input.workspace);
    const requestedBackendConversationId =
      input.requestedBackendConversationId ??
      this.#derivedConversationId(
        "create",
        input.applicationOperationId,
        input.workspace.canonicalPath,
      );
    const resolved = await backendCall(() =>
      this.#resolveWorkspace({
        scope: input.scope,
        applicationThreadId: input.applicationThreadId,
        sourceWorkspace: input.workspace,
        access: "prepare",
      }),
    );
    try {
      const reserved = await backendCall(() =>
        this.#store.reserve(
          resolved.workspace,
          requestedBackendConversationId,
          input.title,
          input.applicationOperationId,
        ),
      );
      return {
        backendConversationId: reserved.manager.getSessionId(),
        reconciliationToken: token(
          "create",
          input.applicationOperationId,
          reserved.manager.getSessionId(),
        ),
        opaqueBindingDetail: reserved.opaqueBindingDetail,
      };
    } finally {
      await resolved.release();
    }
  }

  async attach(input: AttachConversationInput): Promise<ConversationHandle> {
    this.#assertAttach(input);
    const backendConversationId = input.binding.backendConversationId;
    if (
      this.#openHandles.has(backendConversationId) ||
      this.#pendingAttachments.has(backendConversationId)
    ) {
      throw error(
        "invalid_state",
        "This Pi conversation already has an active owner.",
        "pi_conversation_already_attached",
      );
    }
    this.#pendingAttachments.add(backendConversationId);
    try {
      return await this.#attachReserved(input);
    } finally {
      this.#pendingAttachments.delete(backendConversationId);
    }
  }

  async #attachReserved(
    input: AttachConversationInput,
  ): Promise<ConversationHandle> {
    const resolvedWorkspace = await backendCall(() =>
      this.#resolveWorkspace({
        scope: input.scope,
        applicationThreadId: input.binding.applicationThreadId,
        sourceWorkspace: input.workspace,
        access: "active",
      }),
    );
    const manager = await backendCall(() =>
      this.#store.open(
        resolvedWorkspace.workspace,
        input.binding.backendConversationId,
        input.opaqueBindingDetail,
      ),
    ).catch(async (cause) => {
      await resolvedWorkspace.release();
      throw cause;
    });
    const interactions = new PiInteractionBridge();
    const toolIdentityAuthentication = this.#toolIdentityAuthentication(
      input.binding.backendConversationId,
    );
    let agentToolSet: ReturnType<typeof createPiAgentToolSet>;
    const agentToolTurnCorrelation = new PiAgentToolTurnCorrelation();
    let session: PiSdkSession;
    const toolAccess = new PiToolAccessController(
      this.#toolAccessPolicy(input.scope, input.binding.applicationThreadId),
    );
    const agentToolSource: TrustedAgentToolSource = Object.freeze({
      scope: input.scope,
      sourceThreadId: input.binding.applicationThreadId,
      sourceWorkspaceId: input.workspace.summary.id,
      sourceEnvironmentId: input.workspace.summary.environmentId,
      backendKind: this.instance.kind,
    });
    let initialAgentToolPolicy: PiResolvedAgentToolPolicy;
    let initialAgentToolPresentation: PiAgentToolTurnPresentation;
    let cliEnvironment: PiAgentToolCliEnvironment | undefined;
    let cliSourceCapability: string | undefined;
    try {
      initialAgentToolPolicy = this.#agentTools.readPolicy(agentToolSource);
      cliEnvironment =
        initialAgentToolPolicy.presentation.surface === "cli" &&
        !resolvedWorkspace.isolatedResolution &&
        this.#agentToolCli.availability === "available"
          ? (() => {
              cliSourceCapability = this.#agentToolSourceCapabilities.issue(
                agentToolSource,
                "management_http",
              );
              return createPiAgentToolCliEnvironment(
                this.#agentToolCli,
                cliSourceCapability,
                initialAgentToolPolicy.presentation.mode,
              );
            })()
          : undefined;
      agentToolSet = createPiAgentToolSet({
        facade: this.#agentTools,
        source: agentToolSource,
        manager,
        authentication: toolIdentityAuthentication,
        providerTurnCorrelation: () => agentToolTurnCorrelation.current(),
        toolAccess,
      });
      agentToolSet.refreshProgressiveSnapshot(
        initialAgentToolPolicy,
        toolAccess.mode,
      );
      session = await this.#sessionFactory.create({
        executionEnvironment: await this.#resolveThreadEnvironment(input.binding.applicationThreadId),
        manager,
        workspace: resolvedWorkspace.workspace,
        interactions,
        ...(resolvedWorkspace.remoteWorkspace
          ? { remoteWorkspace: resolvedWorkspace.remoteWorkspace }
          : {}),
        ...(resolvedWorkspace.isolatedWorkspace
          ? { isolatedWorkspace: resolvedWorkspace.isolatedWorkspace }
          : {}),
        toolAccess,
        onResourcesChanged: () => this.#catalogs.invalidate(input.workspace),
        customTools: agentToolSet.tools,
        protectedAgentToolNames: new Set(
          agentToolSet.descriptors.flatMap(({ readOnly, toolName }) =>
            readOnly === true ? [] : [toolName],
          ),
        ),
        resolveAgentToolApproval: agentToolSet.resolveApproval,
        recordAgentToolApproval: agentToolSet.recordApproval,
        ...(cliEnvironment && !resolvedWorkspace.isolatedResolution
          ? { cliEnvironment }
          : {}),
      });
    } catch (cause) {
      interactions.close();
      await resolvedWorkspace.release();
      throw mappedError(cause);
    }
    if (session.sessionId !== input.binding.backendConversationId) {
      session.dispose();
      interactions.close();
      await resolvedWorkspace.release();
      throw error(
        "permission_denied",
        "The Pi conversation binding does not match the opened session.",
        "pi_session_binding_mismatch",
      );
    }
    try {
      await backendCall(() => session.ready());
      initialAgentToolPresentation = resolvePiAgentToolTurnPresentation(
        initialAgentToolPolicy,
        agentToolSet.descriptors,
        toolAccess.mode,
      );
      await backendCall(() =>
        applyToolAccess(
          session,
          toolAccess.mode,
          toolAccess,
          new Set(agentToolSet.descriptors.map(({ toolName }) => toolName)),
          initialAgentToolPresentation.enabledNativeToolNames,
          initialAgentToolPresentation.enabledReadOnlyNativeToolNames,
        ),
      );
      recoverPiTaskSubmissionAttestations(
        session.sessionManager.getBranch(),
        (marker) =>
          session.sessionManager.appendCustomEntry(
            piSubmissionAttestationType,
            marker,
          ),
        toolIdentityAuthentication,
      );
      let handle!: PiConversationHandle;
      handle = new PiConversationHandle({
        binding: input.binding,
        scope: input.scope,
        session,
        interactions,
        toolAccess,
        toolIdentityAuthentication,
        agentToolDescriptors: agentToolSet.descriptors,
        resolveAgentToolPolicy: () =>
          this.#agentTools.readPolicy(agentToolSource),
        refreshProgressiveAgentToolSnapshot:
          agentToolSet.refreshProgressiveSnapshot,
        cliEnvironment,
        agentToolTurnCorrelation,
        onEffectiveSettings: this.#onEffectiveSettings,
        modelPolicy: this.#modelPolicy,
        now: this.#now,
        release: async () => {
          if (
            this.#openHandles.get(input.binding.backendConversationId) ===
            handle
          ) {
            this.#openHandles.delete(input.binding.backendConversationId);
          }
          await resolvedWorkspace.release();
        },
      });
      this.#openHandles.set(input.binding.backendConversationId, handle);
      return handle;
    } catch (cause) {
      session.dispose();
      interactions.close();
      await resolvedWorkspace.release();
      throw mappedError(cause);
    }
  }

  async read(input: ReadConversationInput): Promise<ConversationReadResult> {
    this.#assertAttach(input);
    const active = this.#openHandles.get(input.binding.backendConversationId);
    if (active) return active.readCurrent();
    const resolvedWorkspace = await backendCall(() =>
      this.#resolveWorkspace({
        scope: input.scope,
        applicationThreadId: input.binding.applicationThreadId,
        sourceWorkspace: input.workspace,
        access: "passive",
      }),
    );
    const manager = await backendCall(() =>
      this.#store.open(
        resolvedWorkspace.workspace,
        input.binding.backendConversationId,
        input.opaqueBindingDetail,
      ),
    ).catch(async (cause) => {
      await resolvedWorkspace.release();
      throw cause;
    });
    const interactions = new PiInteractionBridge({
      cancelUnpublishedRequests: true,
    });
    const toolAccess = new PiToolAccessController(
      this.#toolAccessPolicy(input.scope, input.binding.applicationThreadId),
    );
    const session = await backendCall(() =>
      this.#sessionFactory.create({
        manager,
        workspace: resolvedWorkspace.workspace,
        interactions,
        toolAccess,
        ...(resolvedWorkspace.remoteWorkspace
          ? { remoteWorkspace: resolvedWorkspace.remoteWorkspace }
          : {}),
        ...(resolvedWorkspace.isolatedWorkspace
          ? { isolatedWorkspace: resolvedWorkspace.isolatedWorkspace }
          : {}),
      }),
    ).catch(async (cause) => {
      interactions.close();
      await resolvedWorkspace.release();
      throw cause;
    });
    try {
      await backendCall(() => session.ready());
      await backendCall(() =>
        applyToolAccess(session, toolAccess.mode, toolAccess),
      );
      const authentication = this.#toolIdentityAuthentication(
        input.binding.backendConversationId,
      );
      recoverPiTaskSubmissionAttestations(
        session.sessionManager.getBranch(),
        (marker) =>
          session.sessionManager.appendCustomEntry(
            piSubmissionAttestationType,
            marker,
          ),
        authentication,
      );
      const snapshot = await backendCall(
        () =>
          new PiHistoryProjector({
            toolIdentityAuthentication: authentication,
          }).project(session.sessionManager.getBranch()).snapshot,
      );
      return {
        snapshot: selectPiSnapshotWindow(
          snapshot,
          readSnapshotTurns,
          input.binding.backendConversationId,
        ),
        usage: piUsage(session),
      };
    } finally {
      interactions.close();
      session.dispose();
      await resolvedWorkspace.release();
    }
  }

  async resolveBranchCheckpoint(
    input: ResolveBranchCheckpointInput,
  ): Promise<BackendCheckpointRef> {
    this.#assertAttach(input);
    if (input.selection.kind === "latest_provider_snapshot") {
      throw error(
        "invalid_state",
        "Pi does not support forking the provider's latest in-flight snapshot.",
        "pi_provider_snapshot_fork_unsupported",
      );
    }
    if (
      await backendCall(
        () =>
          this.#isolatedWorkspaces?.isSelected({
            scope: input.scope,
            applicationThreadId: input.binding.applicationThreadId,
            sourceWorkspace: input.workspace,
          }) ?? false,
      )
    ) {
      throw error(
        "unavailable",
        "Forking is unavailable for isolated Pi workspaces until the exact working tree can be copied safely.",
        "pi_isolated_fork_unsupported",
      );
    }
    const active = this.#openHandles.get(input.binding.backendConversationId);
    if (active && input.selection.kind === "latest_completed") {
      const runState = (await active.readCurrent()).snapshot.runState;
      if (
        runState === "starting" ||
        runState === "running" ||
        runState === "stopping" ||
        runState === "reconciling"
      ) {
        throw error(
          "invalid_state",
          "Pi cannot fork the latest turn while that conversation is active. Select an earlier completed turn instead.",
          "pi_latest_checkpoint_requires_idle",
          true,
        );
      }
    }
    const resolvedWorkspace = await backendCall(() =>
      this.#resolveWorkspace({
        scope: input.scope,
        applicationThreadId: input.binding.applicationThreadId,
        sourceWorkspace: input.workspace,
        access: "passive",
      }),
    );
    let manager;
    try {
      manager = await backendCall(() =>
        this.#store.open(
          resolvedWorkspace.workspace,
          input.binding.backendConversationId,
          input.opaqueBindingDetail,
        ),
      );
      // open() already validated the binding and rejected duplicate IDs. Check
      // that its canonical file still exists without repeating the store scan.
      const sessionFile = manager.getSessionFile();
      const canonicalFile = sessionFile
        ? await realpath(sessionFile).catch(() => undefined)
        : undefined;
      const persisted =
        canonicalFile === sessionFile && sessionFile
          ? await stat(sessionFile).catch(() => undefined)
          : undefined;
      if (
        manager.getSessionId() !== input.binding.backendConversationId ||
        !persisted?.isFile() ||
        persisted.size === 0
      ) {
        throw error(
          "invalid_state",
          "The Pi conversation is not yet persisted and cannot be branched.",
          "pi_checkpoint_unavailable",
        );
      }
    } finally {
      await resolvedWorkspace.release();
    }
    const branch = manager.getBranch();
    const snapshot = new PiHistoryProjector({
      toolIdentityAuthentication: this.#toolIdentityAuthentication(
        input.binding.backendConversationId,
      ),
    }).project(branch).snapshot;
    const backendTurnId =
      input.selection.kind === "selected_completed_turn"
        ? input.selection.backendTurnId
        : snapshot.orderedBackendTurnIds.findLast((candidate) => {
            const turn = snapshot.turnsById[candidate];
            return (
              turn?.status === "completed" && turn.endedBy === "agent_settled"
            );
          });
    const turn = backendTurnId ? snapshot.turnsById[backendTurnId] : undefined;
    if (
      !backendTurnId ||
      !turn ||
      turn.status !== "completed" ||
      turn.endedBy !== "agent_settled"
    ) {
      throw error(
        "invalid_state",
        "The selected Pi turn is not a successfully completed branch boundary.",
        "pi_checkpoint_unavailable",
      );
    }
    const leafId = completedAssistantEntryIdForTurn(branch, backendTurnId);
    if (!leafId) {
      throw error(
        "invalid_state",
        "The Pi conversation has no branchable checkpoint.",
        "pi_checkpoint_unavailable",
      );
    }
    return checkpoint(leafId, this.instance.id);
  }

  async branchConversation(
    input: BranchConversationInput,
  ): Promise<CreateConversationResult> {
    this.#assertScope(input.scope);
    this.#assertWorkspaceTarget(input.workspace);
    this.#assertBinding(input.sourceBinding, input.workspace);
    if (input.creationCorrelation !== undefined) {
      throw error(
        "rejected",
        "Pi branching does not accept a provider creation correlation.",
        "pi_branch_creation_correlation_forbidden",
      );
    }
    if (!input.requestedBackendConversationId) {
      throw error(
        "rejected",
        "Pi branching requires an application-reserved child identity.",
        "pi_branch_identity_required",
      );
    }
    if (!input.inheritedSettings?.toolAccess) {
      throw error(
        "rejected",
        "Pi branching requires a complete inherited settings snapshot.",
        "pi_branch_settings_required",
      );
    }
    if (input.sourceCheckpoint.backendInstanceId !== this.instance.id) {
      throw error(
        "permission_denied",
        "The branch checkpoint belongs to another backend.",
        "pi_checkpoint_backend_mismatch",
      );
    }
    const leafId = checkpointEntryId(input.sourceCheckpoint);
    const requestedBackendConversationId = input.requestedBackendConversationId;
    if (
      await backendCall(
        () =>
          this.#isolatedWorkspaces?.isSelected({
            scope: input.scope,
            applicationThreadId: input.sourceBinding.applicationThreadId,
            sourceWorkspace: input.workspace,
          }) ?? false,
      )
    ) {
      throw error(
        "unavailable",
        "Forking is unavailable for isolated Pi workspaces until the exact working tree can be copied safely.",
        "pi_isolated_fork_unsupported",
      );
    }
    const sourceWorkspace = await backendCall(() =>
      this.#resolveWorkspace({
        scope: input.scope,
        applicationThreadId: input.sourceBinding.applicationThreadId,
        sourceWorkspace: input.workspace,
        access: "passive",
      }),
    );
    if (sourceWorkspace.isolatedResolution) {
      await sourceWorkspace.release();
      throw error(
        "unavailable",
        "Forking is unavailable for isolated Pi workspaces until the exact working tree can be copied safely.",
        "pi_isolated_fork_unsupported",
      );
    }
    let childWorkspace: ResolvedPiWorkspace | undefined;
    try {
      childWorkspace = await backendCall(() =>
        this.#resolveWorkspace({
          scope: input.scope,
          applicationThreadId: input.childApplicationThreadId,
          sourceWorkspace: input.workspace,
          access: "passive",
        }),
      );
      const existingChild = await backendCall(() =>
        this.#store.openPersisted(
          childWorkspace!.workspace,
          requestedBackendConversationId,
        ),
      );
      if (!existingChild) {
        if (input.inheritedSettings.model) {
          assertPiModelPolicy(
            this.#modelPolicy,
            input.inheritedSettings.model,
            input.inheritedSettings.thinkingLevel,
          );
        } else if (this.#modelPolicy.policy.type !== "catalog") {
          throw modelPolicyError();
        }
      }
      const result = await backendCall(() =>
        this.#store.branch(
          sourceWorkspace.workspace,
          input.sourceBinding.backendConversationId,
          this.#store.bindingDetail(input.sourceBinding.backendConversationId),
          leafId,
          this.#toolProvenanceKey,
          requestedBackendConversationId,
          input.applicationOperationId,
          input.title,
          input.inheritedSettings,
          childWorkspace!.workspace,
        ),
      );
      return {
        backendConversationId: result.manager.getSessionId(),
        reconciliationToken: token(
          "branch",
          input.applicationOperationId,
          input.sourceBinding.backendConversationId,
          leafId,
          result.manager.getSessionId(),
        ),
        opaqueBindingDetail: result.opaqueBindingDetail,
      };
    } finally {
      await childWorkspace?.release();
      await sourceWorkspace.release();
    }
  }

  async reconcileSubmission(
    input: ReconcileSubmissionInput,
  ): Promise<SubmissionReconciliation> {
    this.#assertScope(input.scope);
    this.#assertWorkspaceTarget(input.workspace);
    if (input.binding) this.#assertBinding(input.binding, input.workspace);
    let resolvedWorkspace: ResolvedPiWorkspace | undefined;
    try {
      if (input.binding) {
        resolvedWorkspace = await backendCall(() =>
          this.#resolveWorkspace({
            scope: input.scope,
            applicationThreadId: input.binding!.applicationThreadId,
            sourceWorkspace: input.workspace,
            access: "passive",
          }),
        );
      }
      return await this.#reconcileSubmissionInWorkspace(
        input,
        resolvedWorkspace?.workspace ?? input.workspace,
      );
    } finally {
      await resolvedWorkspace?.release();
    }
  }

  async #reconcileSubmissionInWorkspace(
    input: ReconcileSubmissionInput,
    workspace: ValidatedWorkspace,
  ): Promise<SubmissionReconciliation> {
    const retryAnchor = parseRetryAnchor(input.retryAnchor);
    const candidateIds = input.binding
      ? [input.binding.backendConversationId]
      : (await backendCall(() => this.#store.list(workspace))).map(
          ({ backendConversationId }) => backendConversationId,
        );
    const matches: Array<{
      readonly snapshot: BackendConversationSnapshot;
      readonly backendTurnId?: string;
      readonly durablyComplete: boolean;
    }> = [];
    let operationWithDifferentToken = false;
    let anchoredConversationUnchanged = false;
    let anchoredConversationChanged = false;
    for (const candidateId of candidateIds) {
      const manager = await backendCall(() =>
        this.#store.openPersisted(workspace, candidateId),
      );
      if (!manager) continue;
      const branch = manager.getBranch();
      const operation = findSubmission(branch, input.applicationOperationId);
      if (
        operation &&
        input.reconciliationToken !== undefined &&
        operation.marker.reconciliationToken !== input.reconciliationToken
      ) {
        operationWithDifferentToken = true;
        continue;
      }
      const found =
        operation &&
        (input.reconciliationToken === undefined ||
          operation.marker.reconciliationToken === input.reconciliationToken)
          ? operation
          : undefined;
      if (found?.rejected) {
        return { status: "not_accepted", retryable: true };
      }
      if (found?.invalid) {
        return { status: "not_accepted", retryable: true };
      }
      if (!found && retryAnchor && input.binding) {
        const leafId = manager.getLeafId();
        const unchanged =
          branch.length === retryAnchor.entryCount &&
          leafId === retryAnchor.entryId;
        anchoredConversationUnchanged ||= unchanged;
        anchoredConversationChanged ||= !unchanged;
      }
      if (!found) continue;
      if (!found.userEntryId) {
        const active = this.#openHandles.get(candidateId);
        if (
          active?.ownsPendingSteer(input.applicationOperationId) &&
          !active.authoritativelySettled
        ) {
          return {
            status: "unresolved",
            diagnostic: {
              text: "Pi has a durable submission intent that is still awaiting user-message persistence.",
            },
          };
        }
        if (active) {
          active.closeUnmaterializedSubmission(found);
        } else {
          manager.appendCustomEntry(piSubmissionMarkerType, {
            ...found.marker,
            ...(found.marker.mode === "steer"
              ? {
                  phase: "lost" as const,
                  backendTurnId:
                    found.providerTurnId ??
                    (() => {
                      throw new Error("pi_submission_loss_target_missing");
                    })(),
                }
              : { phase: "rejected" as const }),
          } satisfies PiSubmissionMarker);
        }
        return { status: "not_accepted", retryable: true };
      }
      const snapshot = await backendCall(
        () =>
          new PiHistoryProjector({
            toolIdentityAuthentication:
              this.#toolIdentityAuthentication(candidateId),
          }).project(manager.getBranch()).snapshot,
      );
      const backendTurnId = providerTurnForUserEntry(branch, found.userEntryId);
      if (!backendTurnId) {
        return { status: "not_accepted", retryable: true };
      }
      matches.push({
        snapshot,
        durablyComplete: turnDurablyComplete(branch, backendTurnId),
        backendTurnId,
      });
    }
    if (matches.length > 1) {
      return {
        status: "unresolved",
        diagnostic: {
          text: "Multiple Pi conversations contain this submission operation.",
        },
      };
    }
    if (operationWithDifferentToken) {
      if (input.binding) {
        return { status: "not_accepted", retryable: true };
      }
      return {
        status: "unresolved",
        diagnostic: {
          text: "Pi persisted this operation with another reconciliation identity.",
        },
      };
    }
    const match = matches[0];
    if (!match) {
      if (anchoredConversationUnchanged && !anchoredConversationChanged) {
        return { status: "not_accepted", retryable: true };
      }
      return {
        status: "unresolved",
        diagnostic: {
          text: anchoredConversationChanged
            ? "Pi history changed after the retry anchor without a safely correlated submission."
            : "Pi has no durable evidence that proves whether it accepted this submission.",
        },
      };
    }
    let turn = match.backendTurnId
      ? match.snapshot.turnsById[match.backendTurnId]
      : undefined;
    if (turn && !match.durablyComplete) {
      const { completedAt: _completedAt, ...withoutCompletion } = turn;
      turn = { ...withoutCompletion, status: "in_progress" };
    }
    return {
      status: "accepted",
      ...(turn ? { backendTurn: turn } : {}),
      ...(turn && match.durablyComplete
        ? { completionIdentity: `${turn.backendTurnId}:${turn.status}` }
        : {}),
    };
  }

  #assertScope(scope: { tenantId: string; principalId: string }): void {
    if (!this.instance.enabled || !this.connection.enabled) {
      throw error(
        "unavailable",
        "The Pi backend connection is disabled.",
        "pi_connection_disabled",
      );
    }
    if (this.instance.protocolRelease !== PI_PROTOCOL_RELEASE) {
      throw error(
        "incompatible_protocol",
        "The persisted Pi integration profile does not match this Sedes build.",
        "pi_protocol_release_unsupported",
      );
    }
    if (
      scope.tenantId !== this.connection.tenantId ||
      scope.principalId !== this.connection.ownerPrincipalId
    ) {
      throw error(
        "permission_denied",
        "The Pi connection is outside the request scope.",
        "pi_scope_mismatch",
      );
    }
  }

  #derivedConversationId(
    kind: "create" | "branch",
    ...parts: readonly string[]
  ): string {
    return `sedes-${createHash("sha256")
      .update(
        [
          this.connection.id,
          this.connection.ownerPrincipalId,
          kind,
          ...parts,
        ].join("\0"),
      )
      .digest("hex")
      .slice(0, 40)}`;
  }

  #toolIdentityAuthentication(
    backendConversationId: string,
  ): PiToolIdentityAuthentication {
    return {
      conversationId: backendConversationId,
      installationKey: this.#toolProvenanceKey,
    };
  }

  #assertBinding(
    binding: ConversationBinding,
    workspace: ValidatedWorkspace,
  ): void {
    if (
      binding.backendInstanceId !== this.instance.id ||
      binding.connectionProfileId !== this.connection.id ||
      binding.executionEnvironmentId !==
        this.connection.executionEnvironmentId ||
      binding.tenantId !== this.connection.tenantId ||
      binding.ownerPrincipalId !== this.connection.ownerPrincipalId ||
      workspace.summary.environmentId !== this.connection.executionEnvironmentId
    ) {
      throw error(
        "permission_denied",
        "The Pi conversation binding is outside this connection.",
        "pi_binding_scope_mismatch",
      );
    }
  }

  #assertWorkspaceTarget(workspace: ValidatedWorkspace): void {
    if (
      workspace.summary.environmentId !== this.connection.executionEnvironmentId
    ) {
      throw error(
        "permission_denied",
        "The workspace is outside this Pi connection.",
        "pi_workspace_target_mismatch",
      );
    }
  }

  #assertAttach(
    input:
      | AttachConversationInput
      | ReadConversationInput
      | ResolveBranchCheckpointInput,
  ): void {
    this.#assertScope(input.scope);
    this.#assertBinding(input.binding, input.workspace);
  }
}

class PiAgentToolTurnCorrelation {
  #providerTurnCorrelation?: string;

  current(): string | undefined {
    return this.#providerTurnCorrelation;
  }

  captureTurnStart(providerTurnCorrelation: string): void {
    this.#providerTurnCorrelation ??= providerTurnCorrelation;
  }

  replaceTurnStart(providerTurnCorrelation: string): void {
    this.#providerTurnCorrelation = providerTurnCorrelation;
  }

  clear(): void {
    this.#providerTurnCorrelation = undefined;
  }
}

interface PiConversationHandleOptions {
  readonly binding: ConversationBinding;
  readonly scope: ExecutionScope;
  readonly session: PiSdkSession;
  readonly interactions: PiInteractionBridge;
  readonly toolAccess: PiToolAccessController;
  readonly toolIdentityAuthentication: PiToolIdentityAuthentication;
  readonly agentToolDescriptors: readonly TrustedPiAgentToolRegistration[];
  readonly resolveAgentToolPolicy: () => PiResolvedAgentToolPolicy;
  readonly refreshProgressiveAgentToolSnapshot: PiAgentToolSet["refreshProgressiveSnapshot"];
  readonly cliEnvironment?: PiAgentToolCliEnvironment;
  readonly agentToolTurnCorrelation?: PiAgentToolTurnCorrelation;
  readonly onEffectiveSettings?: PiDriverOptions["onEffectiveSettings"];
  readonly now: () => string;
  readonly release: () => void | Promise<void>;
  readonly modelPolicy: CompiledBackendModelPolicy;
}

class PiConversationHandle implements ConversationHandle {
  static readonly #assistantSourceOrderStride = 1_000;

  readonly binding: ConversationBinding;
  readonly #scope: ExecutionScope;
  readonly #session: PiSdkSession;
  readonly #interactions: PiInteractionBridge;
  readonly #toolAccess: PiToolAccessController;
  readonly #toolIdentityAuthentication: PiToolIdentityAuthentication;
  readonly #now: () => string;
  readonly #release: () => void | Promise<void>;
  readonly #onEffectiveSettings?: PiDriverOptions["onEffectiveSettings"];
  readonly #modelPolicy: CompiledBackendModelPolicy;
  readonly #identities: PiToolIdentityCatalog;
  readonly #liveTools: PiLiveToolProjector;
  readonly #agentToolNames: ReadonlySet<string>;
  readonly #agentToolDescriptors: readonly TrustedPiAgentToolRegistration[];
  readonly #resolveAgentToolPolicy: () => PiResolvedAgentToolPolicy;
  readonly #refreshProgressiveAgentToolSnapshot: PiAgentToolSet["refreshProgressiveSnapshot"];
  readonly #cliEnvironment?: PiAgentToolCliEnvironment;
  readonly #agentToolTurnCorrelation?: PiAgentToolTurnCorrelation;
  readonly #projection: PiProjectionEstablisher;
  readonly #listeners = new Set<(event: BackendConversationEvent) => void>();
  readonly #pendingInteractionEvents = new Map<
    string,
    Extract<BackendConversationEvent, { type: "interaction_opened" }>
  >();
  readonly #submissionResults = new Map<string, SubmitTurnResult>();
  readonly #steerResults = new Map<string, SteerTurnResult>();
  readonly #completedInterruptOperations = new Map<string, string>();
  readonly #markedToolCalls = new Set<string>();
  readonly #assistantItems = new Map<
    string,
    {
      readonly itemId: string;
      readonly kind: "assistant_message" | "reasoning";
      readonly contentIndex: number;
      sourceOrder: number;
      text: string;
      startedAt: string;
    }
  >();
  readonly #emittedTurns = new Map<string, BackendTurn>();
  readonly #emittedItems = new Map<string, BackendItem>();
  readonly #unsubscribeSession: Unsubscribe;
  #activeTurnId?: string;
  #runState: BackendConversationSnapshot["runState"];
  #assistantEpoch?: string;
  #terminalAssistantItemIds = new Set<string>();
  #assistantSourceOrderBase = 1;
  #nextAssistantSourceOrderBase = 1;
  #terminalOutcome?: "interrupted" | "failed";
  #terminalFailure?: BackendTurn["failure"];
  #automaticCompactionProjectionPending = false;
  #livePendingSteer?: {
    readonly applicationOperationId: string;
    readonly backendTurnId: string;
  };
  #closed = false;

  constructor(options: PiConversationHandleOptions) {
    this.binding = options.binding;
    this.#scope = options.scope;
    this.#session = options.session;
    this.#interactions = options.interactions;
    this.#toolAccess = options.toolAccess;
    this.#agentToolTurnCorrelation = options.agentToolTurnCorrelation;
    assertPiToolIdentityAuthentication(options.toolIdentityAuthentication);
    this.#toolIdentityAuthentication = {
      conversationId: options.toolIdentityAuthentication.conversationId,
      installationKey: new Uint8Array(
        options.toolIdentityAuthentication.installationKey,
      ),
    };
    this.#now = options.now;
    this.#release = options.release;
    this.#onEffectiveSettings = options.onEffectiveSettings;
    this.#modelPolicy = options.modelPolicy;
    this.#runState = options.session.isIdle ? "idle" : "running";
    if (options.session.isIdle) {
      const branch = options.session.sessionManager.getBranch();
      const latest = branch.findLast((entry) =>
        entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "user"),
      );
      if (latest?.type === "message" && latest.message.role === "assistant" && latest.message.stopReason === "error" && !cancelledPiRetryEntries(branch, this.#toolIdentityAuthentication).has(latest.id)) {
        this.#runState = "failed";
      }
    }
    if (!options.session.isIdle) {
      const activeUserEntry = options.session.sessionManager
        .getBranch()
        .findLast(
          (entry) => entry.type === "message" && entry.message.role === "user",
        );
      if (activeUserEntry?.type === "message") {
        this.#activeTurnId = providerTurnForUserEntry(
          options.session.sessionManager.getBranch(),
          activeUserEntry.id,
        );
        if (this.#activeTurnId) {
          this.#agentToolTurnCorrelation?.captureTurnStart(this.#activeTurnId);
        }
      }
    }
    this.#identities = new PiToolIdentityCatalog(
      options.session.getAllTools(),
      [],
      options.agentToolDescriptors,
      new Set([
        ...(options.cliEnvironment ? (["bash"] as const) : []),
        ...(options.session.trustedBuiltinOverrides ?? []),
      ]),
    );
    this.#agentToolNames = new Set(
      options.agentToolDescriptors.map(({ toolName }) => toolName),
    );
    this.#agentToolDescriptors = options.agentToolDescriptors;
    this.#resolveAgentToolPolicy = options.resolveAgentToolPolicy;
    this.#refreshProgressiveAgentToolSnapshot =
      options.refreshProgressiveAgentToolSnapshot;
    this.#cliEnvironment = options.cliEnvironment;
    this.#liveTools = new PiLiveToolProjector({
      identities: this.#identities,
      now: this.#now,
    });
    const initial = this.#authoritativeProjectionSeed();
    this.#projection = new PiProjectionEstablisher({
      initialSnapshot: initial.snapshot,
      initialHistory: initial.history,
      refreshProjection: () => this.#authoritativeProjectionSeed(),
    });
    this.#interactions.setPublisher((event) => {
      if (event.type === "interaction_opened") {
        this.#pendingInteractionEvents.set(
          event.interaction.backendInteractionId,
          event,
        );
      } else if (event.type === "interaction_resolved") {
        this.#pendingInteractionEvents.delete(event.backendInteractionId);
      }
      this.#emit(event);
    });
    this.#unsubscribeSession = this.#session.subscribe((event) => {
      try {
        this.#consume(event);
      } catch {
        this.#emit({
          type: "resnapshot_required",
          reason: "contradictory_state",
        });
      }
    });
  }

  get authoritativelySettled(): boolean {
    return (
      this.#session.isIdle &&
      (this.#runState === "idle" || this.#runState === "failed")
    );
  }

  ownsPendingSteer(applicationOperationId: string): boolean {
    return (
      this.#livePendingSteer?.applicationOperationId === applicationOperationId
    );
  }

  closeUnmaterializedSubmission(found: {
    readonly marker: PiSubmissionMarker;
    readonly providerTurnId?: string;
  }): void {
    if (
      this.ownsPendingSteer(found.marker.applicationOperationId) &&
      !this.authoritativelySettled
    ) {
      throw new Error("pi_submission_intent_still_active");
    }
    this.#session.sessionManager.appendCustomEntry(piSubmissionMarkerType, {
      ...found.marker,
      ...(found.marker.mode === "steer"
        ? {
            phase: "lost" as const,
            backendTurnId:
              found.providerTurnId ??
              (() => {
                throw new Error("pi_submission_loss_target_missing");
              })(),
          }
        : { phase: "rejected" as const }),
    } satisfies PiSubmissionMarker);
    if (
      this.#livePendingSteer?.applicationOperationId ===
      found.marker.applicationOperationId
    ) {
      this.#livePendingSteer = undefined;
      this.#steerResults.delete(found.marker.applicationOperationId);
    }
  }

  async establishProjection(
    input: EstablishProjectionInput,
  ): Promise<EstablishedBackendProjection> {
    this.#assertOpen();
    await backendCall(() => this.#session.ready());
    const established = await backendCall(() =>
      this.#projection.establishProjection(input),
    );
    for (const event of this.#pendingInteractionEvents.values()) {
      this.#projection.publish(event);
    }
    return established;
  }

  async history(input: HistoryPageInput): Promise<BackendHistoryPage> {
    this.#assertOpen();
    input.signal?.throwIfAborted();
    await backendCall(() => this.#session.ready());
    input.signal?.throwIfAborted();
    validatePage(input.limit);
    const projection = await backendCall(
      () =>
        new PiHistoryProjector({
          runState: this.#runState,
          activeUserEntryId: this.#activeTurnId,
          toolIdentityAuthentication: this.#toolIdentityAuthentication,
        }).project(this.#session.sessionManager.getBranch()).snapshot,
    );
    const before = parseHistoryCursor(
      input.cursor,
      this.#session.sessionId,
      projection.orderedBackendTurnIds.length,
    );
    return selectPiHistoryPage(
      projection,
      this.#session.sessionId,
      before,
      input.limit,
    );
  }

  async locateTurn(input: LocateTurnInput): Promise<LocateTurnResult> {
    this.#assertOpen();
    input.signal?.throwIfAborted();
    await backendCall(() => this.#session.ready());
    input.signal?.throwIfAborted();
    validateTurnCandidateLimit(input.maximumTurnCandidates);
    const projection = await backendCall(
      () =>
        new PiHistoryProjector({
          runState: this.#runState,
          activeUserEntryId: this.#activeTurnId,
          toolIdentityAuthentication: this.#toolIdentityAuthentication,
        }).project(this.#session.sessionManager.getBranch()).snapshot,
    );
    input.signal?.throwIfAborted();
    const candidateCount = Math.min(
      projection.orderedBackendTurnIds.length,
      input.maximumTurnCandidates,
    );
    for (let offset = 0; offset < candidateCount; offset += 1) {
      input.signal?.throwIfAborted();
      const index = projection.orderedBackendTurnIds.length - offset - 1;
      const backendTurnId = projection.orderedBackendTurnIds[index]!;
      const matched = input.matchesBackendTurnId(backendTurnId);
      input.signal?.throwIfAborted();
      if (!matched) continue;
      const selected = selectPiHistoryPage(
        projection,
        this.#session.sessionId,
        index + 1,
        1,
      );
      input.signal?.throwIfAborted();
      const { previousCursor: _previousCursor, ...page } = selected;
      return { status: "found", page };
    }
    return projection.orderedBackendTurnIds.length > candidateCount
      ? { status: "search_limit_reached" }
      : { status: "not_found" };
  }

  async backendCapabilities(): Promise<BackendCapabilityDocument> {
    this.#assertOpen();
    await backendCall(() => this.#session.ready());
    const document = await backendCall(() =>
      capabilities(this.#session, this.#toolAccess.mode, this.#agentToolNames),
    );
    if (this.#onEffectiveSettings) {
      try {
        this.#onEffectiveSettings(
          this.#scope,
          this.binding.applicationThreadId,
          document.effectiveSettings,
        );
      } catch {
        // Durable settings synchronization is best-effort: the live session
        // remains authoritative and the next capability read retries.
      }
    }
    return document;
  }

  async usage(): Promise<UsageSnapshot> {
    this.#assertOpen();
    await backendCall(() => this.#session.ready());
    return backendCall(() => piUsage(this.#session));
  }

  async readCurrent(): Promise<ConversationReadResult> {
    this.#assertOpen();
    await backendCall(() => this.#session.ready());
    const snapshot = this.#projection.snapshot();
    return {
      snapshot: selectPiSnapshotWindow(
        snapshot,
        readSnapshotTurns,
        this.#session.sessionId,
      ),
      usage: piUsage(this.#session),
    };
  }

  async captureSubmissionRetryAnchor(): Promise<string> {
    this.#assertOpen();
    await backendCall(() => this.#session.ready());
    if (!this.authoritativelySettled) {
      throw error(
        "invalid_state",
        "Pi can only capture a submission retry anchor while settled.",
        "pi_retry_anchor_requires_settled",
      );
    }
    const entries = this.#session.sessionManager.getBranch();
    const entryId = this.#session.sessionManager.getLeafId() ?? null;
    if (
      (entries.length === 0 && entryId !== null) ||
      (entries.length > 0 && entryId === null) ||
      (entryId !== null && (entryId.length === 0 || entryId.length > 128))
    ) {
      throw error(
        "internal",
        "Pi returned an invalid durable history position.",
        "pi_retry_anchor_state_invalid",
      );
    }
    return requireSubmissionRetryAnchor(
      JSON.stringify({
        version: 1,
        entryId,
        entryCount: entries.length,
      } satisfies RetryAnchor),
    );
  }

  async submit(input: SubmitTurnInput): Promise<SubmitTurnResult> {
    this.#assertOpen();
    if (!hasDeliverableComposerInput(input)) {
      throw error(
        "rejected",
        "The Pi submission input is empty.",
        "pi_submission_empty",
      );
    }
    await backendCall(() => this.#session.ready());
    const repeated = this.#submissionResults.get(input.applicationOperationId);
    if (repeated) {
      if (repeated.reconciliationToken !== input.reconciliationToken) {
        throw error(
          "rejected",
          "The Pi submission operation was replayed with another identity.",
          "pi_submission_replay_mismatch",
        );
      }
      return repeated;
    }
    const persisted = findSubmission(
      this.#session.sessionManager.getBranch(),
      input.applicationOperationId,
    );
    if (persisted && !persisted.rejected) {
      assertSubmissionReplay(persisted, input, "submit");
      if (!persisted.userEntryId) {
        throw error(
          "submission_unknown",
          "Pi has not durably persisted the submitted user message yet.",
          "pi_submission_persistence_pending",
          true,
          true,
        );
      }
      const result = {
        accepted: true as const,
        reconciliationToken: persisted.marker.reconciliationToken,
        completionCorrelation: persisted.marker.applicationOperationId,
        ...(persisted.userEntryId
          ? { backendTurnId: persisted.userEntryId }
          : {}),
      };
      this.#submissionResults.set(input.applicationOperationId, result);
      return result;
    }
    if (!this.#session.isIdle) {
      throw error(
        "invalid_state",
        "The Pi conversation is already running.",
        "pi_conversation_busy",
      );
    }
    try {
      this.#applyCurrentAgentToolPolicy();
    } catch (cause) {
      throw mappedError(cause);
    }
    let accepted = false;
    let resolveAccepted!: () => void;
    let rejectAccepted!: (cause: unknown) => void;
    const acceptance = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const prepared = await backendCall(async () => {
      const submissionMarker = createPiSubmissionMarker({
        ...input,
        mode: "submit",
      });
      const contextPrompt = piAttachmentPrompt(
        input,
        formatPiContextExcerptPrompt(input.contextExcerpts, input.text),
        this.#toolIdentityAuthentication.installationKey,
      );
      const skillPrompt = input.selectedSkillId
        ? await this.#session.skillPrompt(input.selectedSkillId, contextPrompt)
        : { text: contextPrompt, expandPromptTemplates: false };
      return {
        submissionMarker,
        contextExcerptMarker:
          input.contextExcerpts.length > 0
            ? createPiContextExcerptMarker(
                {
                  applicationOperationId: input.applicationOperationId,
                  requestFingerprint: submissionMarker.requestFingerprint,
                  contextExcerpts: input.contextExcerpts,
                },
                this.#toolIdentityAuthentication,
              )
            : undefined,
        promptText: skillPrompt.text,
        expandPromptTemplates: skillPrompt.expandPromptTemplates,
        images: await piNativeImages(this.#session, input),
      };
    });
    assertPiModelPolicy(
      this.#modelPolicy,
      this.#session.model,
      this.#session.thinkingLevel,
    );
    const operation = this.#session.prompt(prepared.promptText, {
      source: "rpc",
      expandPromptTemplates: prepared.expandPromptTemplates,
      ...(prepared.images.length > 0 ? { images: prepared.images } : {}),
      preflightResult: (success) => {
        if (!success) {
          this.#flushAutomaticCompactionProjection();
          rejectAccepted(
            error(
              "rejected",
              "Pi rejected the input before starting a turn.",
              "pi_prompt_rejected",
            ),
          );
          return;
        }
        if (prepared.contextExcerptMarker) {
          this.#session.sessionManager.appendCustomEntry(
            piContextExcerptMarkerType,
            prepared.contextExcerptMarker,
          );
        }
        this.#session.sessionManager.appendCustomEntry(
          piSubmissionMarkerType,
          prepared.submissionMarker,
        );
        accepted = true;
        resolveAccepted();
      },
    });
    void operation.catch((cause) => {
      if (!accepted) rejectAccepted(mappedError(cause));
      else
        this.#emit({
          type: "notice",
          notice: {
            id: `pi-run-error:${randomUUID()}`,
            tone: "error",
            message: boundText(
              cause instanceof Error ? cause.message : String(cause),
              500,
            ),
            createdAt: this.#now(),
          },
        });
    });
    await acceptance;
    const durable = await this.#awaitSubmissionPersistence(
      input.applicationOperationId,
    );
    if (!durable) {
      throw error(
        "submission_unknown",
        "Pi did not preserve the submitted operation identity.",
        "pi_submission_marker_missing",
        false,
        true,
      );
    }
    assertSubmissionReplay(durable, input, "submit");
    if (!durable.userEntryId) {
      throw error(
        "submission_unknown",
        "Pi has not durably persisted the submitted user message yet.",
        "pi_submission_persistence_pending",
        true,
        true,
      );
    }
    const result = {
      accepted: true as const,
      reconciliationToken: input.reconciliationToken,
      completionCorrelation: input.applicationOperationId,
      backendTurnId: durable.userEntryId,
    };
    this.#submissionResults.set(input.applicationOperationId, result);
    return result;
  }

  async #awaitSubmissionPersistence(applicationOperationId: string): Promise<
    | {
        readonly marker: PiSubmissionMarker;
        readonly userEntryId?: string;
        readonly providerTurnId?: string;
        readonly invalid?: "orphan_steer" | "displaced_steer" | "lost_steer";
      }
    | undefined
  > {
    const current = () =>
      findSubmission(
        this.#session.sessionManager.getBranch(),
        applicationOperationId,
      );
    const alreadyPersisted = current();
    if (alreadyPersisted?.userEntryId) return alreadyPersisted;
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.#listeners.delete(onEvent);
        resolve();
      };
      const onEvent = (event: BackendConversationEvent): void => {
        if (
          (event.type === "turn_started" || event.type === "turn_updated") &&
          event.turn.completionCorrelations?.includes(applicationOperationId)
        ) {
          finish();
        }
      };
      this.#listeners.add(onEvent);
      if (current()?.userEntryId) {
        finish();
        return;
      }
      timer = setTimeout(finish, submissionPersistenceWaitMilliseconds);
      timer.unref();
    });
    return current();
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
    if (!hasDeliverableComposerInput(input)) {
      throw error(
        "rejected",
        "The Pi steering input is empty.",
        "pi_steer_empty",
      );
    }
    await backendCall(() => this.#session.ready());
    const repeated = this.#steerResults.get(input.applicationOperationId);
    if (repeated) {
      if (
        repeated.reconciliationToken !== input.reconciliationToken ||
        repeated.backendTurnId !== expectedBackendTurnId
      ) {
        throw error(
          "rejected",
          "The Pi steering operation was replayed with another identity.",
          "pi_steer_replay_mismatch",
        );
      }
    }
    const persisted = findSubmission(
      this.#session.sessionManager.getBranch(),
      input.applicationOperationId,
    );
    if (persisted && !persisted.rejected) {
      assertSubmissionReplay(persisted, input, "steer");
      if (persisted.invalid) {
        throw error(
          "rejected",
          "The durable Pi steering marker is not attached to an active provider turn.",
          "pi_steer_marker_position_invalid",
        );
      }
      if (!persisted.userEntryId) {
        if (persisted.providerTurnId !== expectedBackendTurnId) {
          throw error(
            "rejected",
            "The Pi steering operation was replayed for another turn.",
            "pi_steer_replay_target_mismatch",
          );
        }
        if (
          repeated?.status === "pending_materialization" &&
          this.#livePendingSteer?.applicationOperationId ===
            input.applicationOperationId
        ) {
          return repeated;
        }
        throw error(
          "submission_unknown",
          "Pi has not durably persisted the steering user message yet.",
          "pi_steer_persistence_pending",
          true,
          true,
        );
      }
      const backendTurnId = providerTurnForUserEntry(
        this.#session.sessionManager.getBranch(),
        persisted.userEntryId,
      );
      if (backendTurnId !== expectedBackendTurnId) {
        throw error(
          "rejected",
          "The Pi steering operation was replayed for another turn.",
          "pi_steer_replay_target_mismatch",
        );
      }
      const result = {
        status: "accepted" as const,
        reconciliationToken: persisted.marker.reconciliationToken,
        completionCorrelation: persisted.marker.applicationOperationId,
        backendTurnId,
      };
      this.#steerResults.set(input.applicationOperationId, result);
      return result;
    }
    if (this.#livePendingSteer) {
      throw error(
        "invalid_state",
        "Wait for the previous Pi steer to appear before steering again.",
        "pi_steer_materialization_pending",
      );
    }
    if (this.#session.isIdle) {
      throw piSteerTargetUnavailable(
        "Pi can only steer an active conversation.",
        "pi_steer_requires_active_run",
      );
    }
    if (this.#activeTurnId !== expectedBackendTurnId) {
      throw piSteerTargetUnavailable(
        "The active Pi turn changed before steering.",
        "pi_steer_target_changed",
      );
    }
    let acceptedByPi = false;
    const prepared = await backendCall(async () => {
      const submissionMarker = createPiSubmissionMarker({
        ...input,
        mode: "steer",
      });
      const contextPrompt = piAttachmentPrompt(
        input,
        formatPiContextExcerptPrompt(input.contextExcerpts, input.text),
        this.#toolIdentityAuthentication.installationKey,
      );
      const skillPrompt = input.selectedSkillId
        ? await this.#session.skillPrompt(input.selectedSkillId, contextPrompt)
        : { text: contextPrompt, expandPromptTemplates: false };
      return {
        submissionMarker,
        contextExcerptMarker:
          input.contextExcerpts.length > 0
            ? createPiContextExcerptMarker(
                {
                  applicationOperationId: input.applicationOperationId,
                  requestFingerprint: submissionMarker.requestFingerprint,
                  contextExcerpts: input.contextExcerpts,
                },
                this.#toolIdentityAuthentication,
              )
            : undefined,
        promptText: skillPrompt.text,
        expandPromptTemplates: skillPrompt.expandPromptTemplates,
        images: await piNativeImages(this.#session, input),
      };
    });
    assertPiModelPolicy(
      this.#modelPolicy,
      this.#session.model,
      this.#session.thinkingLevel,
    );
    if (prepared.contextExcerptMarker) {
      this.#session.sessionManager.appendCustomEntry(
        piContextExcerptMarkerType,
        prepared.contextExcerptMarker,
      );
    }
    this.#session.sessionManager.appendCustomEntry(
      piSubmissionMarkerType,
      prepared.submissionMarker,
    );
    try {
      await this.#session.steer(
        prepared.promptText,
        prepared.expandPromptTemplates,
        prepared.images,
      );
      acceptedByPi = true;
      this.#livePendingSteer = {
        applicationOperationId: input.applicationOperationId,
        backendTurnId: expectedBackendTurnId,
      };
      this.#session.sessionManager.appendCustomEntry(
        piSubmissionMarkerType,
        createPiSubmissionMarker({
          ...input,
          mode: "steer",
          phase: "enqueued",
          backendTurnId: expectedBackendTurnId,
        }),
      );
    } catch (cause) {
      if (!acceptedByPi) {
        this.#session.sessionManager.appendCustomEntry(
          piSubmissionMarkerType,
          createPiSubmissionMarker({
            ...input,
            mode: "steer",
            phase: "rejected",
          }),
        );
      }
      throw mappedError(cause, acceptedByPi);
    }
    const durable = findSubmission(
      this.#session.sessionManager.getBranch(),
      input.applicationOperationId,
    );
    if (!durable) {
      throw error(
        "submission_unknown",
        "Pi did not preserve the steering operation identity.",
        "pi_steer_marker_missing",
        false,
        true,
      );
    }
    assertSubmissionReplay(durable, input, "steer");
    if (durable.invalid) {
      throw error(
        "rejected",
        "The durable Pi steering marker is not attached to an active provider turn.",
        "pi_steer_marker_position_invalid",
      );
    }
    const backendTurnId = durable.userEntryId
      ? providerTurnForUserEntry(
          this.#session.sessionManager.getBranch(),
          durable.userEntryId,
        )
      : durable.providerTurnId;
    if (backendTurnId !== expectedBackendTurnId) {
      throw error(
        "rejected",
        "The persisted Pi steering input belongs to another turn.",
        "pi_steer_target_mismatch",
      );
    }
    if (
      !durable.userEntryId &&
      (this.#closed ||
        this.#session.isIdle ||
        this.#activeTurnId !== expectedBackendTurnId)
    ) {
      this.#closeLivePendingSteerAsLost();
      throw error(
        "rejected",
        "The Pi generation ended before the steering input appeared.",
        "pi_steer_generation_ended",
        true,
      );
    }
    const result = {
      status: durable.userEntryId
        ? ("accepted" as const)
        : ("pending_materialization" as const),
      reconciliationToken: input.reconciliationToken,
      completionCorrelation: input.applicationOperationId,
      backendTurnId,
    };
    if (result.status === "accepted") this.#livePendingSteer = undefined;
    this.#steerResults.set(input.applicationOperationId, result);
    return result;
  }

  async interrupt(input: InterruptTurnInput): Promise<void> {
    this.#assertOpen();
    await backendCall(() => this.#session.ready());
    const priorTarget = this.#completedInterruptOperations.get(
      input.applicationOperationId,
    );
    if (priorTarget) {
      if (priorTarget !== input.expectedBackendTurnId) {
        throw error(
          "rejected",
          "The Pi interrupt operation was replayed for another turn.",
          "pi_interrupt_replay_mismatch",
        );
      }
      return;
    }
    if (this.#session.isIdle) {
      throw error(
        "invalid_state",
        "Pi cannot interrupt an idle conversation.",
        "pi_interrupt_requires_active_turn",
      );
    }
    if (this.#activeTurnId !== input.expectedBackendTurnId) {
      throw error(
        "invalid_state",
        "The active Pi turn changed before interrupt.",
        "pi_interrupt_target_changed",
      );
    }
    const previousOutcome = this.#terminalOutcome;
    this.#terminalOutcome = "interrupted";
    try {
      this.#interactions.cancelPending();
      this.#session.clearQueue();
      await this.#session.abort();
    } catch (cause) {
      this.#terminalOutcome = previousOutcome;
      throw mappedError(cause);
    }
    this.#completedInterruptOperations.set(
      input.applicationOperationId,
      input.expectedBackendTurnId,
    );
    for (const event of this.#liveTools.interruptActive()) this.#emit(event);
  }

  async reconcileInterrupt(
    input: InterruptTurnInput,
  ): Promise<BackendMutationReconciliation> {
    this.#assertOpen();
    await backendCall(() => this.#session.ready());
    if (
      this.#completedInterruptOperations.get(input.applicationOperationId) ===
        input.expectedBackendTurnId ||
      this.#activeTurnId !== input.expectedBackendTurnId
    ) {
      return { outcome: "accepted" };
    }
    return { outcome: "unknown" };
  }

  async perform(
    input: RegisteredBackendActionInput,
  ): Promise<BackendActionResult> {
    this.#assertOpen();
    await backendCall(() => this.#session.ready());
    let actionMayHaveApplied = false;
    try {
      let priorAction;
      try {
        priorAction = findPiActionState(
          this.#session.sessionManager.getBranch(),
          input,
        );
      } catch (cause) {
        throw error(
          "rejected",
          "The Pi backend action was replayed with conflicting durable state.",
          cause instanceof Error ? cause.message : "pi_action_replay_mismatch",
          false,
          false,
          cause,
        );
      }
      if (priorAction.state === "completed") {
        return {
          accepted: true,
          capabilityRevision: capabilities(
            this.#session,
            this.#toolAccess.mode,
            this.#agentToolNames,
          ).revision,
        };
      }
      if (
        priorAction.state === "started" &&
        input.action === "compact" &&
        priorAction.compactObserved
      ) {
        actionMayHaveApplied = true;
        this.#session.sessionManager.appendCustomEntry(
          piActionMarkerType,
          createPiActionMarker(input, "completed"),
        );
        return {
          accepted: true,
          capabilityRevision: capabilities(
            this.#session,
            this.#toolAccess.mode,
            this.#agentToolNames,
          ).revision,
        };
      }
      if (input.action === "compact") {
        assertPiModelPolicy(
          this.#modelPolicy,
          this.#session.model,
          this.#session.thinkingLevel,
        );
      }
      if (priorAction.state === "none") {
        this.#session.sessionManager.appendCustomEntry(
          piActionMarkerType,
          createPiActionMarker(input, "started"),
        );
      }
      if (input.action === "rename") {
        if (!input.title.trim()) throw new Error("pi_title_required");
        actionMayHaveApplied = true;
        this.#session.setSessionName(input.title);
        if (
          this.#session.sessionName !==
          input.title.replace(/[\r\n]+/g, " ").trim()
        ) {
          throw error(
            "invalid_state",
            "Pi did not apply the conversation title.",
            "pi_title_not_applied",
          );
        }
      } else if (input.action === "compact") {
        if (!this.#session.isIdle) throw new Error("pi_session_busy");
        actionMayHaveApplied = true;
        await this.#session.compact(input.instructions);
      } else if (input.action === "set_model") {
        if (!this.#session.isIdle) throw new Error("pi_session_busy");
        const models =
          (await this.#session.availableModels()) as ReadonlyArray<{
            provider?: unknown;
            id?: unknown;
            reasoning?: unknown;
            thinkingLevelMap?: unknown;
          }>;
        const model = models.find(
          (candidate) =>
            candidate.provider === input.provider &&
            candidate.id === input.modelId,
        );
        if (!model) throw new Error("pi_model_not_available");
        if (
          !piModelHasAllowedEffort(this.#modelPolicy, {
            provider: input.provider,
            id: input.modelId,
            reasoning: model.reasoning,
            thinkingLevelMap: model.thinkingLevelMap,
          })
        ) {
          throw modelPolicyError();
        }
        actionMayHaveApplied = true;
        await this.#session.setModel(model);
        if (
          this.#session.model?.provider !== input.provider ||
          this.#session.model.id !== input.modelId
        ) {
          throw error(
            "invalid_state",
            "Pi did not apply the requested model.",
            "pi_model_not_applied",
          );
        }
      } else if (input.action === "set_thinking_level") {
        if (!this.#session.isIdle) throw new Error("pi_session_busy");
        const priorLevel = this.#session.thinkingLevel;
        assertPiModelPolicy(
          this.#modelPolicy,
          this.#session.model,
          input.level,
        );
        actionMayHaveApplied = true;
        try {
          this.#session.setThinkingLevel(input.level);
        } catch (cause) {
          throw thinkingLevelApplicationError(
            cause,
            priorLevel,
            this.#session.thinkingLevel,
          );
        }
        assertPiModelPolicy(
          this.#modelPolicy,
          this.#session.model,
          this.#session.thinkingLevel,
        );
        if (this.#session.thinkingLevel !== input.level) {
          throw thinkingLevelApplicationError(
            undefined,
            priorLevel,
            this.#session.thinkingLevel,
          );
        }
      } else {
        if (!isPiToolAccessMode(input.mode)) {
          throw new Error("pi_tool_access_invalid");
        }
        if (!this.#session.isIdle) throw new Error("pi_session_busy");
        actionMayHaveApplied = true;
        this.#applyCurrentAgentToolPolicy(input.mode);
      }
      this.#session.sessionManager.appendCustomEntry(
        piActionMarkerType,
        createPiActionMarker(input, "completed"),
      );
      const updated = capabilities(
        this.#session,
        this.#toolAccess.mode,
        this.#agentToolNames,
      );
      if (input.action === "compact") {
        // Pi has committed a new persisted branch cut. Reimport that branch as
        // one new normalized projection generation instead of pretending that
        // compaction was only a capability change.
        this.#emit({
          type: "resnapshot_required",
          reason: "persistence_pending",
        });
      } else {
        this.#emit({ type: "capabilities_changed", capabilities: updated });
      }
      return { accepted: true, capabilityRevision: updated.revision };
    } catch (cause) {
      throw mappedError(cause, actionMayHaveApplied);
    }
  }

  #applyCurrentAgentToolPolicy(
    mode: PiToolAccessMode = this.#toolAccess.mode,
  ): void {
    const policy = this.#resolveAgentToolPolicy();
    this.#refreshProgressiveAgentToolSnapshot(policy, mode);
    const presentation = resolvePiAgentToolTurnPresentation(
      policy,
      this.#agentToolDescriptors,
      mode,
    );
    applyToolAccess(
      this.#session,
      mode,
      this.#toolAccess,
      this.#agentToolNames,
      presentation.enabledNativeToolNames,
      presentation.enabledReadOnlyNativeToolNames,
    );
  }

  async reconcileAction(
    input: RegisteredBackendActionInput,
  ): Promise<BackendMutationReconciliation> {
    this.#assertOpen();
    await backendCall(() => this.#session.ready());
    const branch = this.#session.sessionManager.getBranch();
    let state;
    try {
      state = findPiActionState(branch, input);
    } catch (cause) {
      throw error(
        "rejected",
        "The Pi backend action conflicts with durable state.",
        cause instanceof Error ? cause.message : "pi_action_replay_mismatch",
        false,
        false,
        cause,
      );
    }
    if (state.state === "none") return { outcome: "not_applied" };
    if (
      state.state === "completed" ||
      (input.action === "compact" && state.compactObserved)
    ) {
      return { outcome: "accepted" };
    }
    if (
      (input.action === "rename" &&
        this.#session.sessionName ===
          input.title.replace(/[\r\n]+/g, " ").trim()) ||
      (input.action === "set_model" &&
        this.#session.model?.provider === input.provider &&
        this.#session.model.id === input.modelId) ||
      (input.action === "set_thinking_level" &&
        this.#session.thinkingLevel === input.level) ||
      (input.action === "set_tool_access" &&
        isPiToolAccessMode(input.mode) &&
        this.#toolAccess.mode === input.mode)
    ) {
      return { outcome: "accepted" };
    }
    if (state.state === "started" && input.action === "compact") {
      // A compaction entry after the started marker is Pi's durable native
      // evidence that the branch cut applied. The accepted branch above has
      // already handled that evidence, so a lone started marker proves the
      // native action did not apply and is safe to clear or retry.
      return { outcome: "not_applied" };
    }
    if (
      state.state === "started" &&
      (input.action === "rename" ||
        input.action === "set_model" ||
        input.action === "set_thinking_level") &&
      !piActionApplicationEvidence(branch.slice(state.startedIndex + 1), input)
    ) {
      // The action left a started marker but no durable native evidence of
      // the requested value, so it provably never applied and can be
      // safely rejected or retried instead of wedging the thread.
      return { outcome: "not_applied" };
    }
    return { outcome: "unknown" };
  }

  async respond(input: InteractionResponseInput): Promise<void> {
    this.#assertOpen();
    await backendCall(() => this.#session.ready());
    let state;
    try {
      state = findPiInteractionResponseState(
        this.#session.sessionManager.getBranch(),
        input,
      );
    } catch (cause) {
      throw error(
        "rejected",
        "The Pi interaction response conflicts with durable state.",
        cause instanceof Error
          ? cause.message
          : "pi_interaction_response_replay_mismatch",
        false,
        false,
        cause,
      );
    }
    if (state.state === "completed") return;
    if (
      state.state === "started" &&
      !this.#interactions.hasPending(input.interactionId)
    ) {
      throw error(
        "unavailable",
        "The Pi interaction response outcome cannot be determined.",
        "pi_interaction_response_outcome_unknown",
        true,
        true,
      );
    }
    if (state.state === "none") {
      this.#session.sessionManager.appendCustomEntry(
        piInteractionResponseMarkerType,
        createPiInteractionResponseMarker(input, "started"),
      );
    }
    try {
      this.#interactions.respond(input);
    } catch (cause) {
      throw error(
        "rejected",
        "The Pi interaction response is invalid or expired.",
        "pi_interaction_response_invalid",
        false,
        false,
        cause,
      );
    }
    try {
      this.#session.sessionManager.appendCustomEntry(
        piInteractionResponseMarkerType,
        createPiInteractionResponseMarker(input, "completed"),
      );
    } catch (cause) {
      throw error(
        "unavailable",
        "The Pi interaction response was applied but could not be durably confirmed.",
        "pi_interaction_response_completion_not_persisted",
        true,
        true,
        cause,
      );
    }
  }

  async reconcileInteractionResponse(
    input: InteractionResponseInput,
  ): Promise<BackendMutationReconciliation> {
    this.#assertOpen();
    await backendCall(() => this.#session.ready());
    let state;
    try {
      state = findPiInteractionResponseState(
        this.#session.sessionManager.getBranch(),
        input,
      );
    } catch (cause) {
      throw error(
        "rejected",
        "The Pi interaction response conflicts with durable state.",
        cause instanceof Error
          ? cause.message
          : "pi_interaction_response_replay_mismatch",
        false,
        false,
        cause,
      );
    }
    if (state.state === "completed") return { outcome: "accepted" };
    if (this.#interactions.hasPending(input.interactionId)) {
      return { outcome: "not_applied" };
    }
    return { outcome: "unknown" };
  }

  subscribe(listener: (event: BackendConversationEvent) => void): Unsubscribe {
    this.#assertOpen();
    this.#listeners.add(listener);
    for (const event of this.#pendingInteractionEvents.values()) {
      try {
        listener(event);
      } catch {
        // Subscriber failures are isolated.
      }
    }
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    let failure: unknown;
    let failed = false;
    const captureFailure = (cause: unknown): void => {
      if (failed) return;
      failed = true;
      failure = cause;
    };
    try {
      // A running tool call can be suspended on an interaction while Pi's
      // abort waits for that tool call to settle. Cancel those waits first so
      // abort cannot deadlock behind the interaction bridge we own.
      this.#interactions.close();
      this.#session.clearQueue();
      if (!this.#session.isIdle) {
        this.#terminalOutcome = "interrupted";
        await this.#session.abort();
      }
    } catch (cause) {
      captureFailure(cause);
    }
    try {
      this.#closeLivePendingSteerAsLost();
    } catch (cause) {
      captureFailure(cause);
    }
    try {
      this.#agentToolTurnCorrelation?.clear();
    } catch (cause) {
      captureFailure(cause);
    }
    try {
      this.#unsubscribeSession();
    } catch (cause) {
      captureFailure(cause);
    }
    try {
      this.#projection.close();
    } catch (cause) {
      captureFailure(cause);
    }
    this.#listeners.clear();
    try {
      this.#session.dispose();
    } catch (cause) {
      captureFailure(cause);
    }
    try {
      await this.#release();
    } catch (cause) {
      captureFailure(cause);
    }
    if (failed) throw failure;
  }

  #consume(event: AgentSessionEvent): void {
    if (this.#closed) return;
    if (event.type === "entry_appended" && event.entry.type === "usage") {
      // Cache warming can bill requests while the conversation is idle, with
      // no agent settlement to trigger the usual usage refresh.
      this.#emit({ type: "usage_changed", usage: piUsage(this.#session) });
      return;
    }
    if (
      event.type === "compaction_end" &&
      event.reason !== "manual" &&
      event.result !== undefined &&
      !event.aborted
    ) {
      // Automatic compaction can now happen between a tool result and the
      // next assistant response. Keep the current live generation open until
      // the complete provider run settles so that resumed streaming deltas
      // are not discarded while the client re-establishes its projection.
      this.#automaticCompactionProjectionPending = true;
    } else if (
      event.type === "compaction_end" &&
      event.reason !== "manual" &&
      event.result === undefined &&
      !event.aborted &&
      event.errorMessage?.trim()
    ) {
      this.#emit({
        type: "notice",
        notice: {
          id: `pi-compaction-error:${randomUUID()}`,
          tone: "warning",
          message: boundText(event.errorMessage, 500),
          createdAt: this.#now(),
        },
      });
    } else if (event.type === "agent_start") {
      this.#terminalOutcome = undefined;
      this.#terminalFailure = undefined;
      this.#terminalAssistantItemIds.clear();
      this.#setRunState("running");
    } else if (
      event.type === "message_start" &&
      event.message.role === "assistant"
    ) {
      if (this.#terminalOutcome === "failed") {
        this.#terminalOutcome = undefined;
        this.#terminalFailure = undefined;
        this.#setRunState("running", this.#activeTurnId);
      }
      this.#assistantEpoch = randomUUID();
      this.#terminalAssistantItemIds.clear();
      this.#assistantItems.clear();
      if (
        this.#nextAssistantSourceOrderBase >
        Number.MAX_SAFE_INTEGER -
          PiConversationHandle.#assistantSourceOrderStride
      ) {
        this.#emit({
          type: "resnapshot_required",
          reason: "buffer_overflow",
        });
        return;
      }
      this.#assistantSourceOrderBase = this.#nextAssistantSourceOrderBase;
      this.#nextAssistantSourceOrderBase +=
        PiConversationHandle.#assistantSourceOrderStride;
      if (this.#activeTurnId) {
        for (const projected of this.#liveTools.beginAssistantStream({
          streamEpoch: this.#assistantEpoch,
          backendTurnId: this.#activeTurnId,
          sourceOrderBase: this.#assistantSourceOrderBase,
          startedAt: this.#now(),
        })) {
          this.#emit(projected);
        }
      }
    } else if (
      event.type === "message_update" &&
      event.message.role === "assistant"
    ) {
      this.#consumeAssistantUpdate(event);
    } else if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        this.#completeAssistantItems(event.message);
        if (event.message.stopReason === "error") {
          this.#terminalOutcome = "failed";
          this.#terminalFailure = turnFailure(event.message.errorMessage);
        } else if (event.message.stopReason === "aborted") {
          this.#terminalOutcome = "interrupted";
          this.#terminalFailure = undefined;
        }
      }
      queueMicrotask(() => this.#correlatePersistedMessage(event.message));
    } else if (event.type === "agent_settled") {
      if (this.#terminalOutcome === "interrupted" && this.#terminalFailure) {
        // Pi cancels retry backoff without appending an aborted assistant record.
        // Retain the confirmed cancellation as authenticated non-message metadata.
        const latest = this.#session.sessionManager.getBranch().findLast((entry) =>
          entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "user"),
        );
        if (latest?.type === "message" && latest.message.role === "assistant" && latest.message.stopReason === "error") {
          this.#session.sessionManager.appendCustomEntry(piCancelledRetryMarkerType,
            createPiCancelledRetryMarker(latest.id, this.#toolIdentityAuthentication));
        }
      }
      this.#closeLivePendingSteerAsLost();
      for (const projected of this.#liveTools.settlementCheck()) {
        this.#emit(projected);
      }
      if (!this.#terminalOutcome && this.#terminalAssistantItemIds.size > 0) {
        // Settle every block in the native terminal message before publishing
        // completion. A text block finishing is not itself an agent settlement.
        for (const item of this.#emittedItems.values()) {
          if (
            item.backendTurnId === this.#activeTurnId &&
            item.semanticKind === "assistant_message"
          ) {
            this.#emit({
              type: "item_updated",
              item: {
                ...item,
                responsePhase: this.#terminalAssistantItemIds.has(item.backendItemId)
                  ? "final"
                  : "provisional",
              },
            });
          }
        }
      }
      const turn = this.#activeTurnId
        ? this.#trackedTurnUpdate(this.#activeTurnId, undefined)
        : undefined;
      if (turn) {
        const outcome = this.#terminalOutcome;
        this.#emit({
          type: "turn_completed",
          turn: {
            ...turn,
            status: outcome ?? "completed",
            ...(outcome === "failed" ? { failure: this.#terminalFailure ?? turnFailure(undefined) } : {}),
            endedBy:
              outcome === "interrupted"
                ? "interrupted"
                : outcome === "failed"
                  ? "failed"
                  : "agent_settled",
            completedAt: this.#now(),
          },
        });
      }
      this.#activeTurnId = undefined;
      this.#agentToolTurnCorrelation?.clear();
      this.#setRunState(this.#terminalOutcome === "failed" ? "failed" : "idle");
      this.#emit({ type: "usage_changed", usage: piUsage(this.#session) });
      this.#terminalOutcome = undefined;
      this.#terminalFailure = undefined;
      if (this.#automaticCompactionProjectionPending) {
        this.#flushAutomaticCompactionProjection();
      } else {
        this.#requestProjectionRefreshForWindow();
      }
    }
    if (event.type === "tool_execution_start") {
      this.#recordToolIdentityMarker(event.toolCallId, event.toolName);
    }
    for (const projected of this.#liveTools.consumeAgentToolInvocationMarkers(
      this.#session.sessionManager.getBranch(),
      this.#toolIdentityAuthentication,
    )) {
      this.#emit(projected);
    }
    for (const projected of this.#liveTools.consume(event)) {
      this.#emit(projected);
    }
    if (event.type === "tool_execution_start") {
      for (const projected of this.#liveTools.consumeAgentToolInvocationMarkers(
        this.#session.sessionManager.getBranch(),
        this.#toolIdentityAuthentication,
      )) {
        this.#emit(projected);
      }
    }
  }

  #flushAutomaticCompactionProjection(): void {
    if (!this.#automaticCompactionProjectionPending) return;
    this.#automaticCompactionProjectionPending = false;
    this.#emit({
      type: "resnapshot_required",
      reason: "persistence_pending",
    });
  }

  #recordToolIdentityMarker(toolCallId: string, toolName: string): void {
    const branch = this.#session.sessionManager.getBranch();
    const assistantEntryId = findPiToolCallAssistantEntryId(
      branch,
      toolCallId,
      toolName,
    );
    if (!assistantEntryId) {
      throw new Error("pi_tool_identity_marker_correlation_failed");
    }
    const key = JSON.stringify([assistantEntryId, toolCallId]);
    if (this.#markedToolCalls.has(key)) return;
    const identity = this.#identities.require(toolName);
    const existing = branch.flatMap((entry) => {
      const marker = piToolIdentityMarker(
        entry,
        this.#toolIdentityAuthentication,
      );
      return marker &&
        marker.assistantEntryId === assistantEntryId &&
        marker.toolCallId === toolCallId
        ? [marker]
        : [];
    });
    if (existing.length > 0) {
      if (
        existing.every(
          (marker) =>
            marker.toolName === toolName &&
            samePiToolIdentity(marker.identity, identity),
        )
      ) {
        this.#markedToolCalls.add(key);
        return;
      }
      throw new Error("pi_tool_identity_marker_conflict");
    }
    this.#session.sessionManager.appendCustomEntry(
      piToolIdentityMarkerType,
      createPiToolIdentityMarker(
        {
          assistantEntryId,
          toolCallId,
          toolName,
          identity,
        },
        this.#toolIdentityAuthentication,
      ),
    );
    this.#markedToolCalls.add(key);
  }

  #consumeAssistantUpdate(
    event: Extract<AgentSessionEvent, { type: "message_update" }>,
  ): void {
    if (!this.#activeTurnId || !this.#assistantEpoch) return;
    const nested = event.assistantMessageEvent;
    if (nested.type !== "text_delta" && nested.type !== "thinking_delta") {
      return;
    }
    if (
      !Number.isSafeInteger(nested.contentIndex) ||
      nested.contentIndex < 0 ||
      nested.contentIndex >= PiConversationHandle.#assistantSourceOrderStride
    ) {
      this.#emit({
        type: "resnapshot_required",
        reason: "contradictory_state",
      });
      return;
    }
    const kind =
      nested.type === "text_delta"
        ? ("assistant_message" as const)
        : ("reasoning" as const);
    const key = `${kind}:${nested.contentIndex}`;
    let state = this.#assistantItems.get(key);
    if (!state) {
      state = {
        itemId: `${this.#activeTurnId}:live:${this.#assistantEpoch}:${key}`,
        kind,
        contentIndex: nested.contentIndex,
        sourceOrder: this.#assistantSourceOrderBase + nested.contentIndex,
        text: "",
        startedAt: this.#now(),
      };
      this.#assistantItems.set(key, state);
    }
    state.text += nested.delta;
    const item = this.#assistantItem(state, "streaming");
    this.#emit({
      type: state.text === nested.delta ? "item_started" : "item_updated",
      item,
    });
  }

  #completeAssistantItems(message: unknown): void {
    const evidence = piAssistantResponseEvidence(message);
    const responsePhase = evidence === "provisional" ? "provisional" : "unclassified";
    this.#terminalAssistantItemIds.clear();
    for (const state of this.#assistantItems.values()) {
      this.#emit({
        type: "item_completed",
        item: this.#assistantItem(state, "completed", responsePhase),
      });
      if (
        state.kind === "assistant_message" &&
        evidence === "terminal_candidate"
      ) {
        this.#terminalAssistantItemIds.add(state.itemId);
      }
    }
    if (
      this.#assistantItems.size === 0 &&
      this.#activeTurnId &&
      contentText(message)
    ) {
      const state = {
        itemId: `${this.#activeTurnId}:live:${this.#assistantEpoch ?? randomUUID()}:text:0`,
        kind: "assistant_message" as const,
        contentIndex: 0,
        sourceOrder: this.#assistantSourceOrderBase,
        text: contentText(message),
        startedAt: this.#now(),
      };
      this.#emit({
        type: "item_started",
        item: this.#assistantItem(state, "streaming"),
      });
      this.#emit({
        type: "item_completed",
        item: this.#assistantItem(state, "completed", responsePhase),
      });
      if (evidence === "terminal_candidate") {
        this.#terminalAssistantItemIds.add(state.itemId);
      }
    }
  }

  #closeLivePendingSteerAsLost(): void {
    const live = this.#livePendingSteer;
    if (!live) return;
    const found = findSubmission(
      this.#session.sessionManager.getBranch(),
      live.applicationOperationId,
    );
    if (found?.userEntryId) {
      this.#steerResults.set(live.applicationOperationId, {
        status: "accepted",
        reconciliationToken: found.marker.reconciliationToken,
        completionCorrelation: found.marker.applicationOperationId,
        backendTurnId: found.providerTurnId ?? live.backendTurnId,
      });
      this.#livePendingSteer = undefined;
      return;
    }
    if (found && !found.rejected && !found.invalid) {
      this.#session.sessionManager.appendCustomEntry(piSubmissionMarkerType, {
        ...found.marker,
        phase: "lost",
        backendTurnId: found.providerTurnId ?? live.backendTurnId,
      } satisfies PiSubmissionMarker);
    }
    this.#steerResults.delete(live.applicationOperationId);
    this.#livePendingSteer = undefined;
  }

  #assistantItem(
    state: {
      readonly itemId: string;
      readonly kind: "assistant_message" | "reasoning";
      readonly sourceOrder: number;
      readonly text: string;
      readonly startedAt: string;
    },
    status: BackendItem["status"],
    responsePhase: "provisional" | "final" | "unclassified" = "unclassified",
  ): BackendItem {
    const base = {
      backendItemId: state.itemId,
      backendTurnId: this.#activeTurnId!,
      semanticKind: state.kind,
      ...(state.kind === "assistant_message" ? { responsePhase } : {}),
      status,
      sourceOrder: state.sourceOrder,
      startedAt: state.startedAt,
      ...(status === "streaming" ? {} : { completedAt: this.#now() }),
      markdown: state.kind === "assistant_message"
        // #emit validates the complete normalized event, including both text
        // and item bounds. Avoid an extra serialization of accumulated text.
        ? { text: state.text }
        : boundText(state.text),
    };
    return base as BackendItem;
  }

  #correlatePersistedMessage(message: unknown): void {
    if (this.#closed) return;
    const entry = this.#session.sessionManager
      .getBranch()
      .findLast(
        (candidate) =>
          candidate.type === "message" && candidate.message === message,
      );
    if (!entry || entry.type !== "message") {
      this.#emit({
        type: "resnapshot_required",
        reason: "ambiguous_correlation",
      });
      return;
    }
    if (entry.message.role === "user") {
      const correlatedSubmission = [
        ...correlatePiSubmissions(
          this.#session.sessionManager.getBranch(),
        ).values(),
      ].find(({ userEntryId }) => userEntryId === entry.id);
      if (correlatedSubmission?.invalid) {
        this.#emit({
          type: "resnapshot_required",
          reason: "ambiguous_correlation",
        });
        return;
      }
      const steeringExistingTurn =
        correlatedSubmission?.marker.mode === "steer" &&
        this.#activeTurnId !== undefined;
      if (
        !steeringExistingTurn &&
        this.#activeTurnId &&
        this.#activeTurnId !== entry.id
      ) {
        const prior = this.#trackedTurnUpdate(this.#activeTurnId, undefined);
        if (prior) {
          this.#emit({
            type: "turn_completed",
            turn: {
              ...prior,
              status: "completed",
              endedBy: "steer",
              completedAt: entry.timestamp,
            },
          });
        }
      }
      if (!steeringExistingTurn) {
        this.#activeTurnId = entry.id;
        this.#agentToolTurnCorrelation?.replaceTurnStart(entry.id);
        this.#assistantSourceOrderBase = 1;
        this.#nextAssistantSourceOrderBase = 1;
      }
      const backendTurnId = this.#activeTurnId ?? entry.id;
      const completionCorrelation =
        correlatedSubmission?.marker.applicationOperationId;
      if (
        completionCorrelation &&
        this.#livePendingSteer?.applicationOperationId === completionCorrelation
      ) {
        const acceptedResult: SteerTurnResult = {
          status: "accepted",
          reconciliationToken: correlatedSubmission.marker.reconciliationToken,
          completionCorrelation,
          backendTurnId,
        };
        this.#steerResults.set(completionCorrelation, acceptedResult);
        this.#livePendingSteer = undefined;
      }
      const sourceOrder = steeringExistingTurn
        ? this.#nextAssistantSourceOrderBase++
        : 0;
      if (
        correlatedSubmission &&
        !findAuthenticatedPiSubmissionAttestation(
          this.#session.sessionManager.getBranch(),
          entry.id,
          this.#toolIdentityAuthentication,
        )
      ) {
        this.#session.sessionManager.appendCustomEntry(
          piSubmissionAttestationType,
          createPiSubmissionAttestation(
            {
              applicationOperationId:
                correlatedSubmission.marker.applicationOperationId,
              requestFingerprint:
                correlatedSubmission.marker.requestFingerprint,
              userEntryId: entry.id,
            },
            this.#toolIdentityAuthentication,
          ),
        );
      }
      const deliveryAttestation = correlatedSubmission
        ? findAuthenticatedPiSubmissionAttestation(
            this.#session.sessionManager.getBranch(),
            entry.id,
            this.#toolIdentityAuthentication,
          )
        : undefined;
      const item: BackendItem = {
        backendItemId: `${entry.id}:user`,
        backendTurnId,
        semanticKind: "user_message",
        status: "completed",
        sourceOrder,
        startedAt: entry.timestamp,
        completedAt: entry.timestamp,
        ...(deliveryAttestation
          ? {
              deliveryOperationId: deliveryAttestation.applicationOperationId,
            }
          : {}),
        content: projectPiUserMessageContent(
          entry.message.content,
          correlatedSubmission
            ? (findPiContextExcerptsForSubmission(
                this.#session.sessionManager.getBranch(),
                correlatedSubmission.marker.applicationOperationId,
                correlatedSubmission.marker.requestFingerprint,
                this.#toolIdentityAuthentication,
              ) ?? [])
            : [],
          correlatedSubmission
            ? {
                key: this.#toolIdentityAuthentication.installationKey,
                correlation: correlatedSubmission.marker.applicationOperationId,
              }
            : undefined,
          deliveryAttestation && correlatedSubmission
            ? (findPiTaskContextsForSubmission(
                this.#session.sessionManager.getBranch(),
                correlatedSubmission.marker.applicationOperationId,
                correlatedSubmission.marker.requestFingerprint,
                this.#toolIdentityAuthentication,
              ) ?? [])
            : [],
        ),
      };
      if (steeringExistingTurn) {
        this.#emit({ type: "item_completed", item });
        const updated = this.#trackedTurnUpdate(
          backendTurnId,
          completionCorrelation,
        );
        if (!updated) {
          this.#emit({
            type: "resnapshot_required",
            reason: "ambiguous_correlation",
          });
          return;
        }
        this.#emit({
          type: "turn_updated",
          turn: updated,
        });
      } else {
        this.#emit({
          type: "turn_started",
          turn: {
            backendTurnId: entry.id,
            ...(completionCorrelation
              ? { completionCorrelations: [completionCorrelation] }
              : {}),
            status: "in_progress",
            startedAt: entry.timestamp,
            orderedBackendItemIds: [],
          },
        });
        this.#emit({ type: "item_completed", item });
      }
      this.#setRunState("running", backendTurnId);
    } else if (entry.message.role === "assistant") {
      // Tool-call assistant entries persist before their tools finish.
      // This attached generation deliberately retains its live item identity;
      // persisted entry IDs seed only a later attached runtime.
    }
  }

  #trackedTurnUpdate(
    turnId: string,
    completionCorrelation: string | undefined,
  ): BackendTurn | undefined {
    const prior = this.#emittedTurns.get(turnId);
    if (!prior) return undefined;
    const orderedBackendItemIds = [...this.#emittedItems.values()]
      .filter((item) => item.backendTurnId === turnId)
      .sort(
        (left, right) =>
          left.sourceOrder - right.sourceOrder ||
          left.backendItemId.localeCompare(right.backendItemId),
      )
      .map(({ backendItemId }) => backendItemId);
    const completionCorrelations = [
      ...(prior.completionCorrelations ?? []),
      ...(completionCorrelation ? [completionCorrelation] : []),
    ].filter((value, index, values) => values.indexOf(value) === index);
    const { completedAt: _completedAt, endedBy: _endedBy, failure: _failure, ...active } = prior;
    return {
      ...active,
      ...(completionCorrelations.length > 0 ? { completionCorrelations } : {}),
      status: "in_progress",
      orderedBackendItemIds,
    };
  }

  #setRunState(
    state: BackendConversationSnapshot["runState"],
    activeBackendTurnId = this.#activeTurnId,
  ): void {
    this.#runState = state;
    this.#emit({
      type: "run_state_changed",
      state,
      ...(activeBackendTurnId ? { activeBackendTurnId } : {}),
    });
  }

  #authoritativeProjectionSeed(): {
    readonly snapshot: BackendConversationSnapshot;
    readonly history: EstablishedBackendProjection["history"];
  } {
    this.#assistantEpoch = undefined;
    this.#assistantItems.clear();
    this.#liveTools.reset();
    const full = new PiHistoryProjector({
      runState: this.#runState,
      activeUserEntryId: this.#activeTurnId,
      toolIdentityAuthentication: this.#toolIdentityAuthentication,
    }).project(this.#session.sessionManager.getBranch()).snapshot;
    const seed = selectPiProjectionWindow(
      full,
      readSnapshotTurns,
      this.#session.sessionId,
    );
    this.#emittedTurns.clear();
    this.#emittedItems.clear();
    for (const turn of Object.values(seed.snapshot.turnsById)) {
      this.#emittedTurns.set(turn.backendTurnId, turn);
    }
    for (const item of Object.values(seed.snapshot.itemsById)) {
      this.#emittedItems.set(item.backendItemId, item);
    }
    return seed;
  }

  #requestProjectionRefreshForWindow(): void {
    const current = this.#projection.snapshot();
    const bounded = selectPiSnapshotWindow(
      current,
      readSnapshotTurns,
      this.#session.sessionId,
    );
    if (
      bounded.orderedBackendTurnIds.length ===
        current.orderedBackendTurnIds.length &&
      bounded.orderedBackendTurnIds.every(
        (id, index) => id === current.orderedBackendTurnIds[index],
      )
    ) {
      return;
    }
    this.#emit({
      type: "resnapshot_required",
      reason: "buffer_overflow",
    });
  }

  #emit(event: BackendConversationEvent): void {
    const result = backendConversationEventSchema.safeParse(event);
    const parsed: BackendConversationEvent = result.success
      ? result.data
      : {
          type: "resnapshot_required",
          reason: "contradictory_state",
        };
    if (
      parsed.type === "turn_started" ||
      parsed.type === "turn_updated" ||
      parsed.type === "turn_completed"
    ) {
      this.#emittedTurns.set(parsed.turn.backendTurnId, parsed.turn);
    } else if (
      parsed.type === "item_started" ||
      parsed.type === "item_updated" ||
      parsed.type === "item_completed"
    ) {
      this.#emittedItems.set(parsed.item.backendItemId, parsed.item);
    }
    for (const listener of this.#listeners) {
      try {
        listener(parsed);
      } catch {
        // Backend observers cannot affect Pi ownership or acceptance.
      }
    }
    this.#projection.publish(parsed);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw error(
        "invalid_state",
        "The Pi conversation handle is closed.",
        "pi_handle_closed",
      );
    }
  }
}
