import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  BackendConversationSnapshot,
  BackendItem,
  BackendRunState,
  BackendTurn,
} from "../../../shared/protocol/backend.js";
import {
  boundText,
  preserveMessageText,
  DEFAULT_PAYLOAD_LIMITS,
  type PayloadLimits,
} from "../../conversations/payload-policy.js";
import { piActionMarker } from "./pi-action-marker.js";
import {
  authenticatedPiAgentToolInvocationNativeToolName,
  authenticatedAgentToolCorrelation,
  isPiAgentToolInvocationMarkerType,
  piAgentToolInvocationMarkerType,
  readPiAgentToolInvocationMarker,
  type PiAgentToolInvocationMarker,
} from "./pi-agent-tool-invocation-marker.js";
import { piInteractionResponseMarker } from "./pi-interaction-response-marker.js";
import { projectPiUserMessageContent } from "./pi-skill-message.js";
import {
  isPiContextExcerptMarkerType,
  piContextExcerptMarkerType,
  readPiContextExcerptMarker,
} from "./pi-context-excerpt-marker.js";
import type { ContextExcerpt } from "../../../shared/protocol/context-excerpts.js";
import type { MaterializedTaskContext } from "../../../shared/protocol/tasks.js";
import {
  isPiTaskContextMarkerType,
  piTaskContextMarkerType,
  readPiTaskContextMarker,
} from "./pi-task-context-marker.js";
import type { PiToolIdentity } from "./pi-tool-identities.js";
import { PiToolSemanticMapperRegistry } from "./pi-tool-mappers.js";
import {
  correlatePiSubmissions,
  piSubmissionMarker,
} from "./pi-submission-marker.js";
import {
  isPiSubmissionAttestationType,
  readPiSubmissionAttestation,
  type PiSubmissionAttestation,
} from "./pi-submission-attestation.js";
import {
  authenticatedPiToolIdentityNativeToolName,
  assertPiToolIdentityAuthentication,
  isPiToolIdentityMarkerType,
  piToolIdentityMarkerType,
  readPiToolIdentityMarker,
  type PiToolIdentityAuthentication,
  type PiToolIdentityMarker,
} from "./pi-tool-identity-marker.js";
import {
  isExactPiForkContextBoundary,
  isPiForkContextBoundaryType,
} from "./pi-fork-context-boundary.js";
import { readPiBranchMarker } from "./pi-branch-marker.js";
import { USER_FORK_CONTEXT_BOUNDARY } from "../fork-context-boundary.js";
import { piAssistantResponseEvidence } from "./pi-assistant-response-phase.js";

interface MutableTurn {
  backendTurnId: string;
  completionCorrelations?: string[];
  status: BackendTurn["status"];
  endedBy?: BackendTurn["endedBy"];
  startedAt?: string;
  completedAt?: string;
  orderedBackendItemIds: string[];
}

type BackendUserMessageItem = Extract<
  BackendItem,
  { semanticKind: "user_message" }
>;
type BackendAssistantMessageItem = Extract<
  BackendItem,
  { semanticKind: "assistant_message" }
>;
type BackendReasoningItem = Extract<BackendItem, { semanticKind: "reasoning" }>;
type BackendCompactionItem = Extract<
  BackendItem,
  { semanticKind: "compaction" }
>;
type BackendNoticeItem = Extract<BackendItem, { semanticKind: "notice" }>;
type BackendOperationItem = Extract<BackendItem, { phase: string }>;

interface PendingHistoryTool {
  readonly itemId: string;
  readonly backendTurnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly identity: PiToolIdentity;
  readonly arguments: unknown;
  readonly agentToolInvocation?: Extract<
    BackendItem,
    { semanticKind: "tool" }
  >["agentToolInvocation"];
}

export interface PiHistoryDiagnostic {
  readonly code:
    | "orphan_content"
    | "unknown_custom_entry"
    | "hidden_custom_message"
    | "tool_result_unmatched"
    | "tool_result_ambiguous"
    | "tool_result_name_mismatch"
    | "tool_result_missing"
    | "tool_identity_marker_missing"
    | "tool_identity_marker_malformed"
    | "tool_identity_marker_unauthenticated"
    | "tool_identity_marker_conflict"
    | "tool_identity_marker_mismatch"
    | "agent_tool_invocation_marker_missing"
    | "agent_tool_invocation_marker_malformed"
    | "agent_tool_invocation_marker_unauthenticated"
    | "agent_tool_invocation_marker_conflict"
    | "agent_tool_invocation_marker_mismatch"
    | "context_excerpt_marker_malformed"
    | "context_excerpt_marker_unauthenticated"
    | "context_excerpt_marker_conflict"
    | "task_context_marker_malformed"
    | "task_context_marker_unauthenticated"
    | "task_context_marker_conflict"
    | "submission_attestation_malformed"
    | "submission_attestation_unauthenticated"
    | "submission_attestation_mismatch"
    | "submission_attestation_conflict"
    | "submission_marker_invalid";
  readonly entryId: string;
}

export interface PiHistoryProjection {
  readonly snapshot: BackendConversationSnapshot;
  readonly diagnostics: readonly PiHistoryDiagnostic[];
}

export interface PiHistoryProjectorOptions {
  readonly mapper?: PiToolSemanticMapperRegistry;
  readonly limits?: PayloadLimits;
  readonly runState?: BackendRunState;
  readonly activeUserEntryId?: string;
  readonly allowedCustomMessageTypes?: readonly string[];
  readonly toolIdentityAuthentication?: PiToolIdentityAuthentication;
}

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function role(value: unknown): string | undefined {
  const candidate = own(value, "role");
  return typeof candidate === "string" ? candidate : undefined;
}

const textEncoder = new TextEncoder();

function boundedTextContent(
  value: unknown,
  maximumBytes: number,
  maximumParts: number,
): ReturnType<typeof boundText> {
  if (typeof value === "string") {
    return boundText(value, maximumBytes);
  }
  if (!Array.isArray(value)) {
    return { text: "" };
  }
  const selected: string[] = [];
  const count = Math.min(value.length, maximumParts);
  let remainingBytes = Math.max(0, maximumBytes);
  let truncated = value.length > count;
  for (let index = 0; index < count; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const part =
      descriptor && "value" in descriptor ? descriptor.value : undefined;
    const text = own(part, "text");
    if (own(part, "type") !== "text" || typeof text !== "string") {
      continue;
    }
    const bounded = boundText(text, remainingBytes);
    selected.push(bounded.text);
    remainingBytes = Math.max(
      0,
      remainingBytes - textEncoder.encode(bounded.text).byteLength,
    );
    truncated ||= bounded.truncation !== undefined;
    if (remainingBytes === 0) {
      truncated ||= index + 1 < count;
      break;
    }
  }
  // Each selected chunk consumed the one shared byte budget before joining.
  const text = selected.join("");
  return {
    text,
    ...(truncated
      ? {
          truncation: {
            truncated: true as const,
            retainedBytes: textEncoder.encode(text).byteLength,
            reason:
              remainingBytes === 0
                ? ("byte_limit" as const)
                : ("entry_limit" as const),
          },
        }
      : {}),
  };
}

function historicalUnknownIdentity(toolName: string): PiToolIdentity {
  return {
    registrationId: `pi:historical:${encodeURIComponent(toolName)}`,
    origin: "extension",
    displayName: toolName || "tool",
  };
}

function resultError(message: unknown): boolean {
  return own(message, "isError") === true;
}

function terminalPhase(
  message: unknown,
): "completed" | "failed" | "interrupted" {
  return resultError(message) ? "failed" : "completed";
}

function applyAssistantOutcome(
  turn: MutableTurn,
  message: unknown,
  completedAt: string,
): void {
  const stopReason = own(message, "stopReason");
  if (stopReason === "aborted") {
    turn.status = "interrupted";
    turn.endedBy = "interrupted";
    turn.completedAt = completedAt;
  } else if (stopReason === "error") {
    turn.status = "failed";
    turn.endedBy = "failed";
    turn.completedAt = completedAt;
  } else if (stopReason === "stop" || stopReason === "length") {
    turn.status = "completed";
    turn.endedBy = "agent_settled";
    turn.completedAt = completedAt;
  }
}

export class PiHistoryProjector {
  readonly #mapper: PiToolSemanticMapperRegistry;
  readonly #limits: PayloadLimits;
  readonly #runState: BackendRunState;
  readonly #activeUserEntryId?: string;
  readonly #allowedCustomMessageTypes: ReadonlySet<string>;
  readonly #toolIdentityAuthentication?: PiToolIdentityAuthentication;

  constructor(options: PiHistoryProjectorOptions) {
    this.#limits = options.limits ?? DEFAULT_PAYLOAD_LIMITS;
    this.#mapper =
      options.mapper ?? new PiToolSemanticMapperRegistry(this.#limits);
    this.#runState = options.runState ?? "idle";
    this.#activeUserEntryId = options.activeUserEntryId;
    if (options.toolIdentityAuthentication) {
      assertPiToolIdentityAuthentication(options.toolIdentityAuthentication);
    }
    this.#toolIdentityAuthentication = options.toolIdentityAuthentication
      ? {
          conversationId: options.toolIdentityAuthentication.conversationId,
          installationKey: new Uint8Array(
            options.toolIdentityAuthentication.installationKey,
          ),
        }
      : undefined;
    this.#allowedCustomMessageTypes = new Set(
      options.allowedCustomMessageTypes ?? [],
    );
  }

  project(branch: readonly SessionEntry[]): PiHistoryProjection {
    const turns: MutableTurn[] = [];
    const items: BackendItem[] = [];
    const itemIndex = new Map<string, number>();
    const pendingTools = new Map<string, PendingHistoryTool[]>();
    const diagnostics: PiHistoryDiagnostic[] = [];
    const identityMarkers = new Map<
      string,
      Array<{
        readonly entryId: string;
        readonly marker?: PiToolIdentityMarker;
        readonly nativeToolName?: string;
      }>
    >();
    const usedIdentityMarkerKeys = new Set<string>();
    const invocationMarkers = new Map<
      string,
      Array<{
        readonly entryId: string;
        readonly marker?: PiAgentToolInvocationMarker;
        readonly nativeToolName?: string;
      }>
    >();
    const usedInvocationMarkerKeys = new Set<string>();
    const authenticatedBoundaryEntryIds = new Set<string>();
    if (this.#toolIdentityAuthentication) {
      for (let index = 0; index < branch.length - 1; index += 1) {
        const marker = readPiBranchMarker(
          branch[index]!,
          this.#toolIdentityAuthentication.installationKey,
        );
        if (
          marker.status === "authenticated" &&
          isExactPiForkContextBoundary(
            branch[index + 1],
            marker.marker.applicationOperationId,
            USER_FORK_CONTEXT_BOUNDARY,
          )
        ) {
          authenticatedBoundaryEntryIds.add(branch[index + 1]!.id);
        }
      }
    }
    const contextExcerptsBySubmission = new Map<
      string,
      readonly ContextExcerpt[] | undefined
    >();
    for (const entry of branch) {
      if (
        entry.type !== "custom" ||
        !isPiContextExcerptMarkerType(entry.customType)
      ) {
        continue;
      }
      const result = readPiContextExcerptMarker(
        entry,
        this.#toolIdentityAuthentication,
      );
      if (result.status !== "authenticated") {
        diagnostics.push({
          code:
            result.status === "malformed"
              ? "context_excerpt_marker_malformed"
              : "context_excerpt_marker_unauthenticated",
          entryId: entry.id,
        });
        continue;
      }
      const key = JSON.stringify([
        result.marker.applicationOperationId,
        result.marker.requestFingerprint,
      ]);
      const prior = contextExcerptsBySubmission.get(key);
      if (
        prior !== undefined &&
        JSON.stringify(prior) !== JSON.stringify(result.marker.contextExcerpts)
      ) {
        contextExcerptsBySubmission.set(key, undefined);
        diagnostics.push({
          code: "context_excerpt_marker_conflict",
          entryId: entry.id,
        });
        continue;
      }
      if (!contextExcerptsBySubmission.has(key)) {
        contextExcerptsBySubmission.set(key, result.marker.contextExcerpts);
      }
    }
    const taskContextsBySubmission = new Map<
      string,
      readonly MaterializedTaskContext[] | undefined
    >();
    for (const entry of branch) {
      if (
        entry.type !== "custom" ||
        !isPiTaskContextMarkerType(entry.customType)
      ) {
        continue;
      }
      const result = readPiTaskContextMarker(
        entry,
        this.#toolIdentityAuthentication,
      );
      if (result.status !== "authenticated") {
        diagnostics.push({
          code:
            result.status === "malformed"
              ? "task_context_marker_malformed"
              : "task_context_marker_unauthenticated",
          entryId: entry.id,
        });
        continue;
      }
      const key = JSON.stringify([
        result.marker.applicationOperationId,
        result.marker.requestFingerprint,
      ]);
      if (taskContextsBySubmission.has(key)) {
        taskContextsBySubmission.set(key, undefined);
        diagnostics.push({
          code: "task_context_marker_conflict",
          entryId: entry.id,
        });
        continue;
      }
      if (!taskContextsBySubmission.has(key)) {
        taskContextsBySubmission.set(key, result.marker.taskContexts);
      }
    }
    const markerKey = (assistantEntryId: string, toolCallId: string): string =>
      JSON.stringify([assistantEntryId, toolCallId]);
    for (const entry of branch) {
      if (
        entry.type !== "custom" ||
        !isPiToolIdentityMarkerType(entry.customType)
      ) {
        continue;
      }
      const markerResult = readPiToolIdentityMarker(
        entry,
        this.#toolIdentityAuthentication,
      );
      const marker =
        markerResult.status === "authenticated"
          ? markerResult.marker
          : undefined;
      if (markerResult.status !== "authenticated") {
        diagnostics.push({
          code:
            markerResult.status === "malformed"
              ? "tool_identity_marker_malformed"
              : "tool_identity_marker_unauthenticated",
          entryId: entry.id,
        });
      }
      const assistantEntryId = marker
        ? marker.assistantEntryId
        : own(entry.data, "assistantEntryId");
      const toolCallId = marker
        ? marker.toolCallId
        : own(entry.data, "toolCallId");
      if (
        typeof assistantEntryId !== "string" ||
        typeof toolCallId !== "string"
      ) {
        continue;
      }
      const key = markerKey(assistantEntryId, toolCallId);
      const candidates = identityMarkers.get(key) ?? [];
      candidates.push({
        entryId: entry.id,
        ...(marker ? { marker } : {}),
        ...(marker
          ? {
              nativeToolName: authenticatedPiToolIdentityNativeToolName(
                entry,
                this.#toolIdentityAuthentication,
              ),
            }
          : {}),
      });
      identityMarkers.set(key, candidates);
    }
    for (const entry of branch) {
      if (
        entry.type !== "custom" ||
        !isPiAgentToolInvocationMarkerType(entry.customType)
      ) {
        continue;
      }
      const markerResult = readPiAgentToolInvocationMarker(
        entry,
        this.#toolIdentityAuthentication,
      );
      const marker =
        markerResult.status === "authenticated"
          ? markerResult.marker
          : undefined;
      if (markerResult.status !== "authenticated") {
        diagnostics.push({
          code:
            markerResult.status === "malformed"
              ? "agent_tool_invocation_marker_malformed"
              : "agent_tool_invocation_marker_unauthenticated",
          entryId: entry.id,
        });
      }
      const assistantEntryId = marker
        ? marker.assistantEntryId
        : own(entry.data, "assistantEntryId");
      const toolCallId = marker
        ? marker.toolCallId
        : own(entry.data, "toolCallId");
      if (
        typeof assistantEntryId !== "string" ||
        typeof toolCallId !== "string"
      ) {
        continue;
      }
      const key = markerKey(assistantEntryId, toolCallId);
      const candidates = invocationMarkers.get(key) ?? [];
      candidates.push({
        entryId: entry.id,
        ...(marker ? { marker } : {}),
        ...(marker
          ? {
              nativeToolName: authenticatedPiAgentToolInvocationNativeToolName(
                entry,
                this.#toolIdentityAuthentication,
              ),
            }
          : {}),
      });
      invocationMarkers.set(key, candidates);
    }
    let current: MutableTurn | undefined;
    let sourceOrder = 0;
    const submissionCorrelations = [...correlatePiSubmissions(branch).values()];
    const submissionsByUserEntry = new Map(
      submissionCorrelations.flatMap(({ invalid, marker, userEntryId }) =>
        userEntryId && !invalid ? [[userEntryId, marker] as const] : [],
      ),
    );
    const invalidSubmissionUserEntries = new Set(
      submissionCorrelations.flatMap(({ invalid, userEntryId }) =>
        invalid && userEntryId ? [userEntryId] : [],
      ),
    );
    const submissionAttestationsByUserEntry = new Map<
      string,
      PiSubmissionAttestation | undefined
    >();
    for (const entry of branch) {
      if (
        entry.type !== "custom" ||
        !isPiSubmissionAttestationType(entry.customType)
      ) {
        continue;
      }
      const result = readPiSubmissionAttestation(
        entry,
        this.#toolIdentityAuthentication,
      );
      if (result.status !== "authenticated") {
        diagnostics.push({
          code:
            result.status === "malformed"
              ? "submission_attestation_malformed"
              : "submission_attestation_unauthenticated",
          entryId: entry.id,
        });
        continue;
      }
      const submission = submissionsByUserEntry.get(result.marker.userEntryId);
      if (
        !submission ||
        submission.applicationOperationId !==
          result.marker.applicationOperationId ||
        submission.requestFingerprint !== result.marker.requestFingerprint
      ) {
        diagnostics.push({
          code: "submission_attestation_mismatch",
          entryId: entry.id,
        });
        continue;
      }
      if (submissionAttestationsByUserEntry.has(result.marker.userEntryId)) {
        submissionAttestationsByUserEntry.set(
          result.marker.userEntryId,
          undefined,
        );
        diagnostics.push({
          code: "submission_attestation_conflict",
          entryId: entry.id,
        });
        continue;
      }
      submissionAttestationsByUserEntry.set(
        result.marker.userEntryId,
        result.marker,
      );
    }

    const createTurn = (
      backendTurnId: string,
      startedAt: string | undefined,
      orphanEntryId?: string,
    ): MutableTurn => {
      const turn: MutableTurn = {
        backendTurnId,
        ...(submissionsByUserEntry.get(backendTurnId)
          ? {
              completionCorrelations: [
                submissionsByUserEntry.get(backendTurnId)!
                  .applicationOperationId,
              ],
            }
          : {}),
        status: "completed",
        ...(startedAt ? { startedAt } : {}),
        orderedBackendItemIds: [],
      };
      turns.push(turn);
      current = turn;
      if (orphanEntryId) {
        diagnostics.push({
          code: "orphan_content",
          entryId: orphanEntryId,
        });
      }
      return turn;
    };

    const requireTurn = (entry: SessionEntry): MutableTurn =>
      current ?? createTurn(`orphan:${entry.id}`, entry.timestamp, entry.id);

    // Replace the candidate on every native assistant message, including ones
    // without text. Never infer finality from the last projected text block.
    const terminalAssistantItems = new Map<string, Set<string>>();

    const pushItem = (turn: MutableTurn, item: BackendItem): void => {
      if (itemIndex.has(item.backendItemId)) {
        throw new Error("pi_history_item_identity_duplicate");
      }
      itemIndex.set(item.backendItemId, items.length);
      items.push(item);
      turn.orderedBackendItemIds.push(item.backendItemId);
      sourceOrder += 1;
    };

    const replaceItem = (item: BackendItem): void => {
      const index = itemIndex.get(item.backendItemId);
      if (index === undefined) {
        throw new Error("pi_history_item_missing");
      }
      items[index] = item;
    };

    const historicalIdentity = (
      assistantEntryId: string,
      toolCallId: string,
      toolName: string,
    ): PiToolIdentity => {
      const candidates =
        identityMarkers.get(markerKey(assistantEntryId, toolCallId)) ?? [];
      if (candidates.length > 0) {
        usedIdentityMarkerKeys.add(markerKey(assistantEntryId, toolCallId));
      }
      if (candidates.length === 0) {
        diagnostics.push({
          code: "tool_identity_marker_missing",
          entryId: assistantEntryId,
        });
        return historicalUnknownIdentity(toolName);
      }
      if (candidates.some(({ marker }) => !marker)) {
        return historicalUnknownIdentity(toolName);
      }
      if (candidates.length !== 1) {
        diagnostics.push({
          code: "tool_identity_marker_conflict",
          entryId: candidates[0]!.entryId,
        });
        return historicalUnknownIdentity(toolName);
      }
      const markers = candidates.flatMap(({ marker }) =>
        marker ? [marker] : [],
      );
      if (candidates[0]!.nativeToolName !== toolName) {
        diagnostics.push({
          code: "tool_identity_marker_mismatch",
          entryId: candidates[0]!.entryId,
        });
        return historicalUnknownIdentity(toolName);
      }
      return markers[0]!.identity;
    };

    const historicalAgentToolInvocation = (
      assistantEntryId: string,
      toolCallId: string,
      toolName: string,
      identity: PiToolIdentity,
    ): PendingHistoryTool["agentToolInvocation"] => {
      const key = markerKey(assistantEntryId, toolCallId);
      const candidates = invocationMarkers.get(key) ?? [];
      if (candidates.length > 0) {
        usedInvocationMarkerKeys.add(key);
      }
      const expectsInvocationMarker =
        identity.origin === "sedes_agent_tool" ||
        (identity.origin === "sedes_agent_tool_gateway" &&
          (toolName === "sedes_read" ||
            toolName === "sedes_act" ||
            toolName === "harness_read" ||
            toolName === "harness_act"));
      if (!expectsInvocationMarker) {
        if (candidates.length > 0) {
          diagnostics.push({
            code: "agent_tool_invocation_marker_mismatch",
            entryId: candidates[0]!.entryId,
          });
        }
        return undefined;
      }
      if (candidates.length === 0) {
        diagnostics.push({
          code: "agent_tool_invocation_marker_missing",
          entryId: assistantEntryId,
        });
        return undefined;
      }
      if (candidates.length !== 1) {
        diagnostics.push({
          code: "agent_tool_invocation_marker_conflict",
          entryId: candidates[0]!.entryId,
        });
        return undefined;
      }
      if (!candidates[0]!.marker) {
        return undefined;
      }
      const marker = candidates[0]!.marker!;
      if (candidates[0]!.nativeToolName !== toolName) {
        diagnostics.push({
          code: "agent_tool_invocation_marker_mismatch",
          entryId: candidates[0]!.entryId,
        });
        return undefined;
      }
      const correlation = authenticatedAgentToolCorrelation(
        marker,
        identity,
        marker.toolName,
      );
      if (!correlation) {
        diagnostics.push({
          code: "agent_tool_invocation_marker_mismatch",
          entryId: candidates[0]!.entryId,
        });
      }
      return correlation;
    };

    for (const entry of branch) {
      if (entry.type === "message") {
        const message = entry.message;
        const messageRole = role(message);
        if (messageRole === "user") {
          if (invalidSubmissionUserEntries.has(entry.id)) {
            diagnostics.push({
              code: "submission_marker_invalid",
              entryId: entry.id,
            });
            continue;
          }
          const submission = submissionsByUserEntry.get(entry.id);
          const steeringCurrentTurn =
            submission?.mode === "steer" && current !== undefined;
          if (current && !steeringCurrentTurn) {
            current.completedAt ??= entry.timestamp;
          }
          const turn = steeringCurrentTurn
            ? current!
            : createTurn(entry.id, entry.timestamp);
          if (steeringCurrentTurn) {
            const correlation = submission.applicationOperationId;
            turn.completionCorrelations ??= [];
            if (!turn.completionCorrelations.includes(correlation)) {
              turn.completionCorrelations.push(correlation);
            }
            turn.status = "in_progress";
            delete turn.endedBy;
            delete turn.completedAt;
          }
          const item: BackendUserMessageItem = {
            backendItemId: `${entry.id}:user`,
            backendTurnId: turn.backendTurnId,
            semanticKind: "user_message",
            status: "completed",
            sourceOrder,
            startedAt: entry.timestamp,
            completedAt: entry.timestamp,
            ...(submissionAttestationsByUserEntry.get(entry.id)
              ? {
                  deliveryOperationId: submissionAttestationsByUserEntry.get(
                    entry.id,
                  )!.applicationOperationId,
                }
              : {}),
            content: projectPiUserMessageContent(
              own(message, "content"),
              submission
                ? (contextExcerptsBySubmission.get(
                    JSON.stringify([
                      submission.applicationOperationId,
                      submission.requestFingerprint,
                    ]),
                  ) ?? [])
                : [],
              submission && this.#toolIdentityAuthentication
                ? {
                    key: this.#toolIdentityAuthentication.installationKey,
                    correlation: submission.applicationOperationId,
                  }
                : undefined,
              submissionAttestationsByUserEntry.get(entry.id) && submission
                ? (taskContextsBySubmission.get(
                    JSON.stringify([
                      submission.applicationOperationId,
                      submission.requestFingerprint,
                    ]),
                  ) ?? [])
                : [],
            ),
          };
          pushItem(turn, item);
          continue;
        }
        if (messageRole === "assistant") {
          const turn = requireTurn(entry);
          const evidence = piAssistantResponseEvidence(message);
          const candidateItems = new Set<string>();
          terminalAssistantItems.set(turn.backendTurnId, candidateItems);
          const assistantParts = own(message, "content");
          const assistantPartCount = Array.isArray(assistantParts)
            ? assistantParts.length
            : 0;
          for (
            let contentIndex = 0;
            contentIndex < assistantPartCount;
            contentIndex += 1
          ) {
            const descriptor = Object.getOwnPropertyDescriptor(
              assistantParts,
              String(contentIndex),
            );
            const part =
              descriptor && "value" in descriptor
                ? descriptor.value
                : undefined;
            const type = own(part, "type");
            const itemId = `${entry.id}:${contentIndex}`;
            if (type === "text" && typeof own(part, "text") === "string") {
              const item: BackendAssistantMessageItem = {
                backendItemId: itemId,
                backendTurnId: turn.backendTurnId,
                semanticKind: "assistant_message",
                responsePhase:
                  evidence === "provisional" ? "provisional" : "unclassified",
                status: "completed",
                sourceOrder,
                startedAt: entry.timestamp,
                completedAt: entry.timestamp,
                markdown: preserveMessageText(own(part, "text") as string),
              };
              pushItem(turn, item);
              if (evidence === "terminal_candidate") {
                candidateItems.add(itemId);
              }
              continue;
            }
            if (
              type === "thinking" &&
              typeof own(part, "thinking") === "string"
            ) {
              const item: BackendReasoningItem = {
                backendItemId: itemId,
                backendTurnId: turn.backendTurnId,
                semanticKind: "reasoning",
                status: "completed",
                sourceOrder,
                startedAt: entry.timestamp,
                completedAt: entry.timestamp,
                markdown: boundText(
                  own(part, "thinking"),
                  this.#limits.maximumStringBytes,
                ),
              };
              pushItem(turn, item);
              continue;
            }
            if (
              type === "toolCall" &&
              typeof own(part, "id") === "string" &&
              typeof own(part, "name") === "string"
            ) {
              const toolCallId = own(part, "id") as string;
              const toolName = own(part, "name") as string;
              const identity = historicalIdentity(
                entry.id,
                toolCallId,
                toolName,
              );
              const agentToolInvocation = historicalAgentToolInvocation(
                entry.id,
                toolCallId,
                toolName,
                identity,
              );
              const item = this.#mapper.map({
                backendItemId: itemId,
                backendTurnId: turn.backendTurnId,
                sourceOrder,
                status: "streaming",
                phase: "arguments_complete",
                startedAt: entry.timestamp,
                identity,
                ...(agentToolInvocation ? { agentToolInvocation } : {}),
                arguments: own(part, "arguments"),
              });
              pushItem(turn, item);
              const candidates = pendingTools.get(toolCallId) ?? [];
              candidates.push({
                itemId,
                backendTurnId: turn.backendTurnId,
                toolCallId,
                toolName,
                identity,
                arguments: own(part, "arguments"),
                ...(agentToolInvocation ? { agentToolInvocation } : {}),
              });
              pendingTools.set(toolCallId, candidates);
            }
          }
          applyAssistantOutcome(turn, message, entry.timestamp);
          continue;
        }
        if (messageRole === "toolResult") {
          const toolCallId = own(message, "toolCallId");
          const toolName = own(message, "toolName");
          if (typeof toolCallId !== "string" || typeof toolName !== "string") {
            diagnostics.push({
              code: "tool_result_unmatched",
              entryId: entry.id,
            });
            continue;
          }
          const candidates = (pendingTools.get(toolCallId) ?? []).filter(
            (candidate) => candidate.backendTurnId === current?.backendTurnId,
          );
          const matches = candidates.filter(
            (candidate) => candidate.toolName === toolName,
          );
          if (matches.length === 0) {
            diagnostics.push({
              code:
                candidates.length > 0
                  ? "tool_result_name_mismatch"
                  : "tool_result_unmatched",
              entryId: entry.id,
            });
            continue;
          }
          if (matches.length > 1) {
            diagnostics.push({
              code: "tool_result_ambiguous",
              entryId: entry.id,
            });
            continue;
          }
          const match = matches[0]!;
          const remaining = (pendingTools.get(toolCallId) ?? []).filter(
            (candidate) => candidate !== match,
          );
          if (remaining.length > 0) {
            pendingTools.set(toolCallId, remaining);
          } else {
            pendingTools.delete(toolCallId);
          }
          const prior = items[itemIndex.get(match.itemId)!]!;
          const phase = terminalPhase(message);
          replaceItem(
            this.#mapper.map({
              backendItemId: prior.backendItemId,
              backendTurnId: prior.backendTurnId,
              sourceOrder: prior.sourceOrder,
              status: phase,
              phase,
              startedAt: prior.startedAt,
              completedAt: entry.timestamp,
              identity: match.identity,
              ...(match.agentToolInvocation
                ? { agentToolInvocation: match.agentToolInvocation }
                : {}),
              arguments: match.arguments,
              result: message,
              isError: resultError(message),
            }),
          );
        }
        continue;
      }

      if (entry.type === "compaction") {
        const turn = requireTurn(entry);
        const summary = boundText(
          entry.summary,
          this.#limits.maximumStringBytes,
        );
        const item: BackendCompactionItem = {
          backendItemId: `${entry.id}:compaction`,
          backendTurnId: turn.backendTurnId,
          semanticKind: "compaction",
          status: "completed",
          sourceOrder,
          startedAt: entry.timestamp,
          completedAt: entry.timestamp,
          ...(summary.text.trim().length > 0 ? { summary } : {}),
        };
        pushItem(turn, item);
        continue;
      }

      if (entry.type === "branch_summary") {
        const turn = requireTurn(entry);
        const item: BackendNoticeItem = {
          backendItemId: `${entry.id}:branch-summary`,
          backendTurnId: turn.backendTurnId,
          semanticKind: "notice",
          status: "completed",
          sourceOrder,
          startedAt: entry.timestamp,
          completedAt: entry.timestamp,
          tone: "neutral",
          text: boundText(entry.summary, this.#limits.maximumStringBytes),
        };
        pushItem(turn, item);
        continue;
      }

      if (entry.type === "custom_message") {
        if (!entry.display) {
          if (
            isPiForkContextBoundaryType(entry.customType) &&
            authenticatedBoundaryEntryIds.has(entry.id)
          ) {
            continue;
          }
          diagnostics.push({
            code: "hidden_custom_message",
            entryId: entry.id,
          });
          continue;
        }
        if (!this.#allowedCustomMessageTypes.has(entry.customType)) {
          diagnostics.push({
            code: "unknown_custom_entry",
            entryId: entry.id,
          });
          continue;
        }
        const turn = requireTurn(entry);
        const item: BackendNoticeItem = {
          backendItemId: `${entry.id}:custom-message`,
          backendTurnId: turn.backendTurnId,
          semanticKind: "notice",
          status: "completed",
          sourceOrder,
          startedAt: entry.timestamp,
          completedAt: entry.timestamp,
          tone: "neutral",
          text: boundedTextContent(
            entry.content,
            this.#limits.maximumStringBytes,
            this.#limits.maximumArrayEntries,
          ),
        };
        pushItem(turn, item);
        continue;
      }

      if (entry.type === "custom") {
        if (isPiContextExcerptMarkerType(entry.customType)) {
          continue;
        }
        if (isPiTaskContextMarkerType(entry.customType)) {
          continue;
        }
        if (isPiSubmissionAttestationType(entry.customType)) {
          continue;
        }
        if (
          piSubmissionMarker(entry) ||
          piActionMarker(entry) ||
          piInteractionResponseMarker(entry) ||
          isPiToolIdentityMarkerType(entry.customType) ||
          isPiAgentToolInvocationMarkerType(entry.customType)
        ) {
          continue;
        }
        diagnostics.push({
          code: "unknown_custom_entry",
          entryId: entry.id,
        });
      }
    }

    for (const candidates of pendingTools.values()) {
      for (const pending of candidates) {
        const prior = items[itemIndex.get(pending.itemId)!]!;
        const active =
          this.#runState === "running" &&
          current?.backendTurnId === prior.backendTurnId;
        if (active) {
          continue;
        }
        if (!("phase" in prior)) {
          throw new Error("pi_history_pending_tool_item_invalid");
        }
        diagnostics.push({
          code: "tool_result_missing",
          entryId: pending.itemId.split(":")[0] ?? pending.itemId,
        });
        const interrupted: BackendOperationItem = {
          ...prior,
          status: "interrupted",
          phase: "interrupted",
          error: {
            category: "interrupted",
            message: {
              text: "Pi history did not contain a matching tool result.",
            },
            code: "pi_tool_result_missing",
          },
        };
        replaceItem(interrupted);
      }
    }
    for (const [key, candidates] of identityMarkers) {
      if (
        !usedIdentityMarkerKeys.has(key) &&
        candidates.some(({ marker }) => marker !== undefined)
      ) {
        diagnostics.push({
          code: "tool_identity_marker_mismatch",
          entryId: candidates[0]!.entryId,
        });
      }
    }
    for (const [key, candidates] of invocationMarkers) {
      if (
        !usedInvocationMarkerKeys.has(key) &&
        candidates.some(({ marker }) => marker !== undefined)
      ) {
        diagnostics.push({
          code: "agent_tool_invocation_marker_mismatch",
          entryId: candidates[0]!.entryId,
        });
      }
    }

    if (
      this.#runState === "running" &&
      current &&
      (!this.#activeUserEntryId ||
        current.backendTurnId === this.#activeUserEntryId)
    ) {
      current.status = "in_progress";
    }
    const snapshotTurns = turns.map<BackendTurn>((turn) => ({
      ...turn,
      ...(turn.status === "completed" && !turn.completedAt
        ? { completedAt: turn.startedAt }
        : {}),
    }));
    for (const turn of snapshotTurns) {
      const finalIds = terminalAssistantItems.get(turn.backendTurnId);
      if (
        turn.status !== "completed" ||
        turn.endedBy !== "agent_settled" ||
        !finalIds?.size
      ) {
        continue;
      }
      for (const itemId of turn.orderedBackendItemIds) {
        const item = items[itemIndex.get(itemId)!]!;
        if (item.semanticKind === "assistant_message") {
          replaceItem({
            ...item,
            responsePhase: finalIds.has(itemId) ? "final" : "provisional",
          });
        }
      }
    }
    return {
      snapshot: {
        orderedBackendTurnIds: snapshotTurns.map(
          ({ backendTurnId }) => backendTurnId,
        ),
        turnsById: Object.fromEntries(
          snapshotTurns.map((turn) => [turn.backendTurnId, turn]),
        ),
        itemsById: Object.fromEntries(
          items.map((item) => [item.backendItemId, item]),
        ),
        runState: this.#runState,
        ...(this.#runState === "running" && current
          ? { activeBackendTurnId: current.backendTurnId }
          : {}),
      },
      diagnostics,
    };
  }
}
