import { createHash, type Hash } from "node:crypto";
import type {
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type {
  BoundedDisplayText,
  BoundedText,
  SafeItemError,
} from "../../../shared/protocol/payload.js";
import { MAXIMUM_BACKEND_ITEMS_PER_TURN } from "../../../shared/protocol/backend.js";
import { boundText, preserveMessageText } from "../../conversations/payload-policy.js";
import type {
  GrokEventMetadata,
  GrokSourceCandidateTurnCompletedNotification,
} from "./grok-acp-dialect.js";
import {
  GrokAcpPlanNormalizationError,
  projectGrokAcpPlanReplacement,
  type GrokAcpPlanReplacement,
} from "./grok-acp-plan-normalization.js";
import {
  GrokToolProjectionError,
  mergeGrokToolPatches,
  settleGrokToolPatchAtParentTerminal,
} from "./grok-tool-projector.js";
import {
  decodeGrokCanonicalToolMetadata,
  decodeGrokRawToolOutputVariant,
  type GrokCandidateToolDisposition,
  type GrokCanonicalToolMetadata,
  type GrokRawToolOutputVariant,
} from "./grok-tool-normalization.js";
import {
  GrokSubagentReducer,
  type GrokSubagentCollaborationProjection,
  type GrokSubagentEvent,
} from "./grok-subagent-reducer.js";

const DEFAULT_RETAINED_COMPLETED_PROMPTS = 10;
const MAXIMUM_DATE_MILLISECONDS = 8_640_000_000_000_000;
// Grok compacts one prompt into a bounded provider-private record window and
// reserves one normalized item for a truthful omission notice. Keep that
// reviewed source-replay bound independent of the wider shared protocol cap.
const MAXIMUM_DETAILED_RECORDS_PER_PROMPT = Math.min(
  1_999,
  MAXIMUM_BACKEND_ITEMS_PER_TURN - 1,
);

export type GrokHistoryRecord =
  | GrokHistoryTextRecord
  | GrokHistoryPlanRecord
  | GrokHistoryToolRecord
  | GrokHistoryCollaborationRecord
  | GrokHistoryOmissionRecord
  | GrokHistoryTurnCompletedRecord;

export interface GrokHistoryIdentity {
  readonly nativeNamespaceKey: string;
  readonly eventId: string;
  readonly promptId?: string;
  readonly blockId: string;
  readonly blockOccurrence: number;
}

export interface GrokHistoryTextRecord {
  readonly kind: "user_text" | "assistant_text" | "reasoning";
  readonly id: string;
  readonly sessionId: string;
  readonly identity: GrokHistoryIdentity;
  readonly text: BoundedText;
  readonly exactTextDigest: string;
  readonly replay: boolean;
}

export interface GrokHistoryTurnCompletedRecord {
  readonly kind: "turn_completed";
  readonly id: string;
  readonly sessionId: string;
  readonly identity: GrokHistoryIdentity;
  readonly stopReason: string;
  readonly agentResult?: string | null;
  readonly completedAtMs?: number;
  readonly replay: boolean;
}

export interface GrokHistoryPlanRecord {
  readonly kind: "plan";
  readonly id: string;
  readonly sessionId: string;
  readonly identity: GrokHistoryIdentity;
  readonly replacement: GrokAcpPlanReplacement;
  readonly replay: boolean;
}

export interface GrokHistoryCollaborationRecord {
  readonly kind: "collaboration";
  readonly id: string;
  readonly sessionId: string;
  readonly identity: GrokHistoryIdentity;
  readonly activityId: string;
  readonly status: "streaming" | "completed" | "failed" | "interrupted";
  readonly action: "spawn" | "message" | "result" | "status";
  readonly agentLabel?: BoundedDisplayText;
  readonly summary?: BoundedText;
  readonly error?: SafeItemError;
  readonly replay: boolean;
}

export interface GrokHistoryOmissionRecord {
  readonly kind: "omission";
  readonly id: string;
  readonly sessionId: string;
  readonly identity: GrokHistoryIdentity;
  readonly replay: boolean;
}

export interface GrokHistoryToolPatch {
  readonly title?: string | null;
  readonly name?: string | null;
  readonly toolKind?: ToolKind | null;
  readonly status?: ToolCallStatus | null;
  readonly content?: readonly ToolCallContent[] | null;
  readonly locations?: readonly ToolCallLocation[] | null;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly canonicalToolMetadata?: GrokCanonicalToolMetadata;
  readonly rawOutputVariant?: GrokRawToolOutputVariant;
  readonly semanticDisposition?: GrokCandidateToolDisposition;
}

export interface GrokHistoryToolRecord {
  readonly kind: "tool";
  readonly id: string;
  readonly sessionId: string;
  readonly identity: GrokHistoryIdentity;
  readonly toolCallId: string;
  readonly patch: GrokHistoryToolPatch;
  readonly replay: boolean;
}

export type GrokHistoryProjectionResult =
  | {
      readonly kind: "accepted";
      readonly record?: GrokHistoryRecord;
      readonly records?: readonly GrokHistoryRecord[];
    }
  | { readonly kind: "duplicate" }
  | { readonly kind: "ignored" }
  | { readonly kind: "resnapshot_required"; readonly reason: string };

export interface GrokHistoryProjectorDiagnostics {
  readonly retainedCompletedPromptWindow: number;
  readonly visiblePromptCount: number;
  readonly offWindowToolPromptCount: number;
  readonly offWindowCollaborationPromptCount: number;
  readonly retainedSubagentStateCount: number;
  readonly evictedPromptCount: number;
  readonly retainedRecordCount: number;
  readonly retainedBytes: number;
  readonly fingerprintCount: number;
  readonly fingerprintBytes: number;
  readonly promptlessUserRecordCount: number;
  readonly promptlessUserBytes: number;
}

export type GrokToolPromptCorrelation =
  | { readonly kind: "current_or_unknown" }
  | {
      readonly kind: "retained_background";
      readonly promptId: string;
    };

type HistoryRecordDraft =
  | {
      readonly kind: "user_text" | "assistant_text" | "reasoning";
      readonly text: string;
    }
  | {
      readonly kind: "turn_completed";
      readonly stopReason: string;
      readonly agentResult?: string | null;
      readonly completedAtMs?: number;
    }
  | {
      readonly kind: "collaboration";
      readonly activityId: string;
      readonly status: "streaming" | "completed" | "failed" | "interrupted";
      readonly action: "spawn" | "message" | "result" | "status";
      readonly agentLabel?: BoundedDisplayText;
      readonly summary?: BoundedText;
      readonly error?: SafeItemError;
    }
  | {
      readonly kind: "plan";
      readonly replacement: GrokAcpPlanReplacement;
    }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly patch: GrokHistoryToolPatch;
    };

interface HistoryEnvelope {
  readonly sessionId: string;
  readonly metadata: GrokEventMetadata;
  readonly draft: HistoryRecordDraft;
  readonly fingerprint: string;
  readonly bytes: number;
}

/**
 * Provider-private replay interpreter. A load is a transaction: replay and
 * early live frames remain private until the load response succeeds and
 * sealReplay atomically publishes them. Event IDs are opaque durable
 * identities, never numeric cursors or gap evidence.
 */
export class GrokHistoryProjector {
  readonly #nativeNamespaceKey: string;
  readonly #sessionId: string;
  readonly #subagents: GrokSubagentReducer;
  readonly #retainedCompletedPromptWindow: number;
  readonly #workingRecords: GrokHistoryRecord[] = [];
  readonly #workingTextRecordIndexes = new Map<string, number>();
  readonly #rebindableUnassignedRecordIndexes: number[] = [];
  readonly #fingerprints = new Map<string, string>();
  readonly #fingerprintPromptIds = new Map<string, string | undefined>();
  readonly #fingerprintToolKeys = new Map<string, string | undefined>();
  readonly #fingerprintCollaborationActivityIds = new Map<
    string,
    string | undefined
  >();
  readonly #promptlessFingerprintKeys = new Set<string>();
  readonly #textHashes = new Map<string, Hash>();
  readonly #terminalFingerprints = new Map<string, string>();
  readonly #planRecordIndexes = new Map<string, number>();
  readonly #planRetainedBytes = new Map<string, number>();
  readonly #collaborationRecordIndexes = new Map<string, number>();
  readonly #collaborationRetainedBytes = new Map<string, number>();
  readonly #collaborationTerminalFingerprints = new Map<string, string>();
  readonly #toolRecordIndexes = new Map<string, number>();
  readonly #toolRetainedBytes = new Map<string, number>();
  readonly #toolPromptIds = new Map<string, string>();
  readonly #promptOrder: string[] = [];
  readonly #sealedPromptIds = new Set<string>();
  readonly #offWindowToolPromptIds = new Set<string>();
  readonly #offWindowCollaborationPromptIds = new Set<string>();
  readonly #channelOccurrences = new Map<string, number>();
  #lastChannelKey: string | undefined;
  #lastBlockOccurrence: number | undefined;
  #retainedBytes = 0;
  #dedupeBytes = 0;
  #evictedPromptCount = 0;
  #replaySealed = false;
  #published = false;
  #failure: GrokHistoryProjectionResult | undefined;
  #currentPromptId: string | undefined;

  constructor(input: {
    readonly nativeNamespaceKey: string;
    readonly sessionId: string;
    readonly retainedCompletedPromptWindow?: number;
  }) {
    if (
      !boundedString(input.nativeNamespaceKey, 1_024) ||
      !boundedString(input.sessionId, 1_024)
    ) {
      throw new Error("grok_history_scope_invalid");
    }
    this.#nativeNamespaceKey = input.nativeNamespaceKey;
    this.#sessionId = input.sessionId;
    this.#subagents = new GrokSubagentReducer({
      nativeNamespaceKey: input.nativeNamespaceKey,
      sessionId: input.sessionId,
    });
    const retainedCompletedPromptWindow =
      input.retainedCompletedPromptWindow ?? DEFAULT_RETAINED_COMPLETED_PROMPTS;
    if (
      !Number.isSafeInteger(retainedCompletedPromptWindow) ||
      retainedCompletedPromptWindow < 1
    ) {
      throw new Error("grok_history_window_invalid");
    }
    this.#retainedCompletedPromptWindow = retainedCompletedPromptWindow;
  }

  ingestStandard(
    notification: SessionNotification,
  ): GrokHistoryProjectionResult {
    if (this.#failure) return this.#failure;
    if (notification.update.sessionUpdate === "plan") {
      let replacement: GrokAcpPlanReplacement | undefined;
      try {
        replacement = projectGrokAcpPlanReplacement({
          nativeNamespaceKey: this.#nativeNamespaceKey,
          notification,
        });
      } catch (error) {
        if (error instanceof GrokAcpPlanNormalizationError) {
          return this.#fail("malformed_known_history_dependency");
        }
        throw error;
      }
      if (!replacement) return { kind: "ignored" };
      const envelope = decodePlanEnvelope(notification, replacement);
      if (!envelope || envelope.sessionId !== this.#sessionId) {
        return this.#fail("malformed_known_history_dependency");
      }
      return this.#ingest(envelope);
    }
    let projectedNotification = notification;
    const update = notification.update;
    if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      const rawMetadata = isRecord(notification._meta)
        ? notification._meta
        : undefined;
      if (!rawMetadata) {
        return this.#fail("malformed_known_history_dependency");
      }
      const metadataPromptId =
        rawMetadata.promptId === undefined
          ? undefined
          : boundedString(rawMetadata.promptId, 1_024)
            ? rawMetadata.promptId
            : INVALID;
      if (
        metadataPromptId === INVALID ||
        (rawMetadata.isReplay !== undefined && rawMetadata.isReplay !== true)
      ) {
        return this.#fail("malformed_known_history_dependency");
      }
      const replay = rawMetadata.isReplay === true;
      const toolPromptKey = JSON.stringify([replay, update.toolCallId]);
      const knownPromptId = this.#toolPromptIds.get(toolPromptKey);
      if (
        metadataPromptId !== undefined &&
        knownPromptId !== undefined &&
        metadataPromptId !== knownPromptId &&
        !this.#toolMayBeRebound(knownPromptId, update.toolCallId)
      ) {
        return this.#fail("conflicting_tool_identity");
      }
      let promptId = metadataPromptId;
      if (promptId === undefined) {
        if (
          update.sessionUpdate !== "tool_call_update" ||
          knownPromptId === undefined
        ) {
          return this.#fail("malformed_known_history_dependency");
        }
        promptId = knownPromptId;
      }
      let eventId = rawMetadata.eventId;
      if (!boundedString(eventId, 1_024)) {
        if (
          eventId !== undefined ||
          replay ||
          update.sessionUpdate !== "tool_call_update" ||
          knownPromptId === undefined
        ) {
          return this.#fail("malformed_known_history_dependency");
        }
        eventId = `grok-transient-tool-event:${fingerprint({
          sessionId: notification.sessionId,
          promptId,
          update,
        })}`;
      }
      projectedNotification = Object.freeze({
        ...notification,
        _meta: Object.freeze({
          ...rawMetadata,
          eventId,
          promptId,
        }),
      });
    }
    const envelope = decodeStandardEnvelope(projectedNotification);
    if (envelope === "ignored") return { kind: "ignored" };
    if (!envelope || envelope.sessionId !== this.#sessionId) {
      return this.#fail("malformed_known_history_dependency");
    }
    return this.#ingest(envelope);
  }

  ingestSourceCandidateTurnCompleted(
    notification: GrokSourceCandidateTurnCompletedNotification,
  ): GrokHistoryProjectionResult {
    if (this.#failure) return this.#failure;
    const envelope = decodeTerminalEnvelope(notification);
    if (!envelope || envelope.sessionId !== this.#sessionId) {
      return this.#fail("malformed_known_history_dependency");
    }
    return this.#ingest(envelope);
  }

  ingestSubagentEvent(event: GrokSubagentEvent): GrokHistoryProjectionResult {
    if (this.#failure) return this.#failure;
    if (this.#replaySealed && event.replay) {
      return this.#fail("replay_after_cutover");
    }
    if (!this.#replaySealed && !event.replay) {
      return this.#fail("live_before_replay_sealed");
    }
    return event.kind === "progress"
      ? this.#ingestSubagentProgress(event)
      : this.#ingestDurableSubagentEvent(event);
  }

  sealReplay(): GrokHistoryProjectionResult {
    if (this.#failure) return this.#failure;
    if (this.#replaySealed) return this.#fail("replay_already_sealed");
    this.#replaySealed = true;
    // A replay can end after a user-only turn. Preserve those blocks without a
    // prompt identity; assigning one without a later correlated frame would be
    // a guess.
    this.#published = true;
    return { kind: "accepted" };
  }

  records(): readonly GrokHistoryRecord[] {
    return this.#published && !this.#failure
      ? Object.freeze(
          this.#workingRecords.filter(
            (record) =>
              record.identity.promptId === undefined ||
              (!this.#offWindowToolPromptIds.has(record.identity.promptId) &&
                !this.#offWindowCollaborationPromptIds.has(
                  record.identity.promptId,
                )),
          ),
        )
      : Object.freeze([]);
  }

  toolPromptCorrelation(
    toolCallId: string,
    promptId: string | undefined,
    activePromptId: string | undefined,
  ): GrokToolPromptCorrelation {
    if (
      !boundedString(toolCallId, 1_024) ||
      (promptId !== undefined && !boundedString(promptId, 1_024)) ||
      !boundedString(activePromptId, 1_024)
    ) {
      return { kind: "current_or_unknown" };
    }
    const retainedPromptId = this.#toolPromptIds.get(
      JSON.stringify([false, toolCallId]),
    );
    if (
      retainedPromptId === undefined ||
      (promptId !== undefined && promptId !== retainedPromptId)
    ) {
      return { kind: "current_or_unknown" };
    }
    const index = this.#toolRecordIndexes.get(
      JSON.stringify([retainedPromptId, toolCallId]),
    );
    const record =
      index === undefined ? undefined : this.#workingRecords[index];
    return retainedPromptId !== activePromptId &&
      record?.kind === "tool" &&
      !toolStatusSettled(record.patch.status)
      ? Object.freeze({
          kind: "retained_background",
          promptId: retainedPromptId,
        })
      : { kind: "current_or_unknown" };
  }

  diagnostics(): GrokHistoryProjectorDiagnostics {
    return Object.freeze({
      retainedCompletedPromptWindow: this.#retainedCompletedPromptWindow,
      visiblePromptCount: this.#promptOrder.length,
      offWindowToolPromptCount: this.#offWindowToolPromptIds.size,
      offWindowCollaborationPromptCount:
        this.#offWindowCollaborationPromptIds.size,
      retainedSubagentStateCount: this.#subagents.retainedStateCount,
      evictedPromptCount: this.#evictedPromptCount,
      retainedRecordCount: this.#workingRecords.length,
      retainedBytes: this.#retainedBytes,
      fingerprintCount: this.#fingerprints.size,
      fingerprintBytes: this.#dedupeBytes,
      promptlessUserRecordCount: this.#rebindableUnassignedRecordIndexes.length,
      promptlessUserBytes: this.#rebindableUnassignedRecordIndexes.reduce(
        (bytes, index) =>
          bytes + retainedRecordBytes(this.#workingRecords[index]!),
        0,
      ),
    });
  }

  /**
   * Adds a server-private terminal boundary after the driver has authenticated
   * an abandoned Sedes prompt against the exact binding scope. This does not
   * mutate Grok's native history. Its identity is stable across fresh loads so
   * repeated attachment projects the same interrupted turn and preserves every
   * provider record identity that preceded it.
   */
  appendLocallyInterruptedPrompt(
    promptId: string,
  ): GrokHistoryProjectionResult {
    if (this.#failure) return this.#failure;
    if (!this.#published || !this.#replaySealed) {
      return this.#fail("local_interruption_before_replay_sealed");
    }
    const finalRecord = this.#workingRecords.at(-1);
    if (
      !boundedString(promptId, 1_024) ||
      !finalRecord ||
      finalRecord.kind === "turn_completed" ||
      finalRecord.identity.promptId !== promptId ||
      this.#terminalFingerprints.has(promptId)
    ) {
      return this.#fail("local_interruption_target_invalid");
    }
    // This server-private identity is regenerated from native history. Preserve
    // the historical prefix for an authenticated pre-rename prompt while new
    // Sedes prompts retain the current identity family.
    const eventPrefix = promptId.startsWith("harness-grok:v1:")
      ? "harness-local-interruption:v1:"
      : "sedes-local-interruption:v1:";
    const eventId = `${eventPrefix}${createHash("sha256")
      .update(
        JSON.stringify([this.#nativeNamespaceKey, this.#sessionId, promptId]),
      )
      .digest("base64url")}`;
    const draft = Object.freeze({
      kind: "turn_completed" as const,
      stopReason: "cancelled",
    });
    const metadata = Object.freeze({ eventId, promptId });
    return this.#accept(
      Object.freeze({
        sessionId: this.#sessionId,
        metadata,
        draft,
        fingerprint: fingerprint({
          sessionId: this.#sessionId,
          draft,
        }),
        bytes: Buffer.byteLength(
          JSON.stringify({
            sessionId: this.#sessionId,
            eventId,
            promptId,
            draft,
          }),
        ),
      }),
    );
  }

  #ingestDurableSubagentEvent(
    event: Exclude<GrokSubagentEvent, { readonly kind: "progress" }>,
  ): GrokHistoryProjectionResult {
    const retained = this.#subagents.projection(event.subagentId);
    const promptId =
      event.kind === "spawned"
        ? event.parentPromptId
        : (event.promptId ?? retained?.promptId);
    if (!promptId) return { kind: "ignored" };
    const eventKey = JSON.stringify([promptId, event.eventId]);
    const eventFingerprint = durableSubagentFingerprint(event);
    const priorEventFingerprint = this.#fingerprints.get(eventKey);
    if (priorEventFingerprint !== undefined) {
      return priorEventFingerprint === eventFingerprint
        ? { kind: "duplicate" }
        : this.#fail("conflicting_event_identity");
    }
    if (event.kind === "finished" && retained) {
      const priorTerminal = this.#collaborationTerminalFingerprints.get(
        retained.activityId,
      );
      if (priorTerminal !== undefined) {
        if (priorTerminal !== eventFingerprint) {
          return this.#fail("conflicting_collaboration_terminal");
        }
        this.#rememberFingerprint(eventKey, eventFingerprint, promptId);
        return { kind: "duplicate" };
      }
    }
    const reduced = this.#subagents.ingest(event);
    if (reduced.kind === "invalid") {
      return this.#fail("conflicting_collaboration_identity");
    }
    if (reduced.kind === "ignored") {
      if (reduced.reason === "duplicate_or_regressive") {
        this.#rememberFingerprint(eventKey, eventFingerprint, promptId);
        return { kind: "duplicate" };
      }
      return { kind: "ignored" };
    }
    if (event.kind === "finished") {
      this.#collaborationTerminalFingerprints.set(
        reduced.projection.activityId,
        eventFingerprint,
      );
    }
    const envelope = collaborationEnvelope(
      this.#sessionId,
      event.eventId,
      event.replay,
      reduced.projection,
      eventFingerprint,
    );
    const result = this.#accept(envelope);
    if (result.kind === "resnapshot_required") {
      this.#subagents.releaseActivity(reduced.projection.activityId);
    }
    return result;
  }

  #ingestSubagentProgress(
    event: Extract<GrokSubagentEvent, { readonly kind: "progress" }>,
  ): GrokHistoryProjectionResult {
    const reduced = this.#subagents.ingest(event);
    if (reduced.kind === "invalid") {
      return this.#fail("conflicting_collaboration_identity");
    }
    if (reduced.kind === "ignored") return { kind: "ignored" };
    const index = this.#collaborationRecordIndexes.get(
      reduced.projection.activityId,
    );
    if (index === undefined) {
      return this.#fail("conflicting_collaboration_identity");
    }
    const prior = this.#workingRecords[index];
    if (!prior || prior.kind !== "collaboration") {
      return this.#fail("conflicting_collaboration_identity");
    }
    const compacted = collaborationRecordReplacement(prior, reduced.projection);
    const priorBytes = this.#collaborationRetainedBytes.get(
      reduced.projection.activityId,
    );
    if (priorBytes === undefined) {
      return this.#fail("conflicting_collaboration_identity");
    }
    const compactedBytes = retainedRecordBytes(compacted);
    this.#workingRecords[index] = compacted;
    this.#retainedBytes += compactedBytes - priorBytes;
    this.#collaborationRetainedBytes.set(
      reduced.projection.activityId,
      compactedBytes,
    );
    const hidden = this.#offWindowCollaborationPromptIds.has(
      compacted.identity.promptId!,
    );
    return this.#published && !hidden
      ? { kind: "accepted", record: compacted }
      : { kind: "accepted" };
  }

  #ingest(envelope: HistoryEnvelope): GrokHistoryProjectionResult {
    const replay = envelope.metadata.isReplay === true;
    if (this.#replaySealed && replay) return this.#fail("replay_after_cutover");
    if (!this.#replaySealed && !replay) {
      return this.#fail("live_before_replay_sealed");
    }
    try {
      return this.#accept(envelope);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "normalized_payload_exceeds_serialized_byte_limit"
      ) {
        // #accept can already have advanced identity/hash bookkeeping. Discard
        // the entire projection and keep the failure sticky for subsequent
        // notifications, exactly like other inconsistent provider history.
        return this.#fail("grok_message_payload_too_large");
      }
      throw error;
    }
  }

  #accept(envelope: HistoryEnvelope): GrokHistoryProjectionResult {
    const eventKey = eventIdentityKey(envelope.metadata);
    const prior = this.#fingerprints.get(eventKey);
    if (prior !== undefined) {
      if (prior === envelope.fingerprint) return { kind: "duplicate" };
      return this.#fail("conflicting_event_identity");
    }
    if (envelope.draft.kind === "turn_completed") {
      const promptId = envelope.metadata.promptId!;
      const priorTerminal = this.#terminalFingerprints.get(promptId);
      if (priorTerminal !== undefined) {
        if (priorTerminal === envelope.fingerprint) {
          this.#rememberFingerprint(eventKey, envelope.fingerprint, promptId);
          return { kind: "duplicate" };
        }
        return this.#fail("conflicting_prompt_terminal");
      }
    }
    const promptlessUser =
      envelope.draft.kind === "user_text" &&
      envelope.metadata.promptId === undefined;
    const emitted: GrokHistoryRecord[] = [];
    const promptId = envelope.metadata.promptId;
    if (
      promptId !== undefined &&
      !this.#observePrompt(promptId, envelope.draft.kind)
    ) {
      return this.#fail("noncontiguous_prompt_history");
    }
    if (
      envelope.draft.kind !== "user_text" &&
      promptId !== undefined &&
      !this.#rebindPromptlessFingerprints(promptId)
    ) {
      return this.#fail("conflicting_event_identity");
    }
    if (
      envelope.draft.kind !== "user_text" &&
      promptId !== undefined &&
      this.#rebindableUnassignedRecordIndexes.length > 0 &&
      !this.#rebindUnassignedUsers(promptId, emitted)
    ) {
      return this.#fail("conflicting_history_state");
    }
    if (envelope.draft.kind === "collaboration") {
      const collaborationKey = envelope.draft.activityId;
      const priorIndex = this.#collaborationRecordIndexes.get(collaborationKey);
      if (priorIndex !== undefined) {
        const prior = this.#workingRecords[priorIndex];
        if (prior?.kind !== "collaboration") {
          return this.#fail("conflicting_collaboration_identity");
        }
        const materialized = this.#materialize(
          envelope,
        ) as GrokHistoryCollaborationRecord;
        const compacted = Object.freeze({
          ...materialized,
          identity: Object.freeze({
            ...materialized.identity,
            blockId: prior.identity.blockId,
            blockOccurrence: prior.identity.blockOccurrence,
          }),
        });
        const priorBytes =
          this.#collaborationRetainedBytes.get(collaborationKey);
        if (priorBytes === undefined) {
          return this.#fail("conflicting_collaboration_identity");
        }
        const compactedBytes = retainedRecordBytes(compacted);
        this.#rememberFingerprint(
          eventKey,
          envelope.fingerprint,
          promptId,
          undefined,
          collaborationKey,
        );
        this.#workingRecords[priorIndex] = compacted;
        this.#retainedBytes += compactedBytes - priorBytes;
        this.#collaborationRetainedBytes.set(collaborationKey, compactedBytes);
        const hidden = this.#offWindowCollaborationPromptIds.has(promptId!);
        if (compacted.status !== "streaming") {
          this.#releaseSettledOffWindowCollaboration(compacted);
        }
        if (hidden) return { kind: "accepted" };
        return this.#published
          ? {
              kind: "accepted",
              record: compacted,
              records: Object.freeze([...emitted, compacted]),
            }
          : { kind: "accepted" };
      }
    }
    if (envelope.draft.kind === "plan") {
      const planKey = envelope.draft.replacement.promptId;
      const priorIndex = this.#planRecordIndexes.get(planKey);
      if (priorIndex !== undefined) {
        const prior = this.#workingRecords[priorIndex];
        if (prior?.kind !== "plan") {
          return this.#fail("conflicting_plan_identity");
        }
        const materialized = this.#materialize(
          envelope,
        ) as GrokHistoryPlanRecord;
        const compacted = Object.freeze({
          ...materialized,
          identity: Object.freeze({
            ...materialized.identity,
            blockId: prior.identity.blockId,
            blockOccurrence: prior.identity.blockOccurrence,
          }),
        });
        const priorBytes = this.#planRetainedBytes.get(planKey);
        if (priorBytes === undefined) {
          return this.#fail("conflicting_plan_identity");
        }
        const compactedBytes = retainedRecordBytes(compacted);
        this.#rememberFingerprint(eventKey, envelope.fingerprint, promptId);
        this.#workingRecords[priorIndex] = compacted;
        this.#retainedBytes += compactedBytes - priorBytes;
        this.#planRetainedBytes.set(planKey, compactedBytes);
        return this.#published
          ? {
              kind: "accepted",
              record: compacted,
              records: Object.freeze([...emitted, compacted]),
            }
          : { kind: "accepted" };
      }
    }
    if (envelope.draft.kind === "tool") {
      const toolKey = JSON.stringify([
        envelope.metadata.promptId,
        envelope.draft.toolCallId,
      ]);
      const priorIndex = this.#toolRecordIndexes.get(toolKey);
      if (priorIndex !== undefined) {
        const prior = this.#workingRecords[priorIndex];
        if (prior?.kind !== "tool") {
          return this.#fail("conflicting_tool_identity");
        }
        let patch: GrokHistoryToolPatch;
        try {
          const priorPatch = this.#terminalFingerprints.has(promptId!)
            ? settleGrokToolPatchAtParentTerminal(prior.patch)
            : prior.patch;
          patch = mergeGrokToolPatches(priorPatch, envelope.draft.patch);
        } catch (error) {
          if (error instanceof GrokToolProjectionError) {
            return this.#fail("conflicting_tool_state");
          }
          throw error;
        }
        const compacted = Object.freeze({
          ...(this.#materialize(envelope) as GrokHistoryToolRecord),
          patch,
        });
        const priorBytes = this.#toolRetainedBytes.get(toolKey);
        if (priorBytes === undefined) {
          return this.#fail("conflicting_tool_identity");
        }
        const compactedBytes = retainedRecordBytes(compacted);
        this.#rememberFingerprint(
          eventKey,
          envelope.fingerprint,
          promptId,
          toolKey,
        );
        this.#workingRecords[priorIndex] = compacted;
        this.#retainedBytes += compactedBytes - priorBytes;
        this.#toolRetainedBytes.set(toolKey, compactedBytes);
        const hidden = this.#offWindowToolPromptIds.has(promptId!);
        this.#releaseSettledOffWindowTool(promptId!, toolKey, compacted);
        if (hidden) return { kind: "accepted" };
        return this.#published
          ? {
              kind: "accepted",
              record: compacted,
              records: Object.freeze([...emitted, compacted]),
            }
          : { kind: "accepted" };
      }
    }
    const record = this.#materialize(envelope);
    if (
      promptId !== undefined &&
      envelope.draft.kind !== "turn_completed" &&
      !this.#hasRetainedBlock(record.identity.blockId) &&
      this.#detailedRecordCount(promptId) >= MAXIMUM_DETAILED_RECORDS_PER_PROMPT
    ) {
      if (isTextRecord(record))
        this.#textHashes.delete(record.identity.blockId);
      if (record.kind === "collaboration") {
        this.#subagents.releaseActivity(record.activityId);
        this.#collaborationTerminalFingerprints.delete(record.activityId);
      }
      this.#channelOccurrences.delete(
        JSON.stringify([
          promptId,
          envelope.draft.kind,
          envelope.draft.kind === "collaboration"
            ? envelope.draft.activityId
            : envelope.draft.kind === "plan"
              ? envelope.draft.replacement.planId
              : envelope.draft.kind === "tool"
                ? envelope.draft.toolCallId
                : null,
        ]),
      );
      this.#lastChannelKey = undefined;
      this.#lastBlockOccurrence = undefined;
      const omission = this.#retainOmission(promptId, record.replay);
      return this.#published && omission
        ? {
            kind: "accepted",
            record: omission,
            records: Object.freeze([...emitted, omission]),
          }
        : { kind: "accepted" };
    }
    if (envelope.draft.kind === "turn_completed") {
      this.#terminalFingerprints.set(
        envelope.metadata.promptId!,
        envelope.fingerprint,
      );
    }
    if (!this.#retain(record)) return this.#fail("conflicting_history_state");
    if (record.kind === "tool") {
      this.#toolPromptIds.set(
        JSON.stringify([record.replay, record.toolCallId]),
        promptId!,
      );
    }
    this.#rememberFingerprint(
      eventKey,
      envelope.fingerprint,
      promptId,
      envelope.draft.kind === "tool"
        ? JSON.stringify([promptId, envelope.draft.toolCallId])
        : undefined,
      envelope.draft.kind === "collaboration"
        ? envelope.draft.activityId
        : undefined,
    );
    if (promptlessUser) this.#promptlessFingerprintKeys.add(eventKey);
    if (envelope.draft.kind === "turn_completed") {
      this.#sealedPromptIds.add(promptId!);
    }
    this.#evictOldPrompts();
    emitted.push(record);
    if (
      promptId !== undefined &&
      (this.#offWindowToolPromptIds.has(promptId) ||
        this.#offWindowCollaborationPromptIds.has(promptId))
    ) {
      return { kind: "accepted" };
    }
    return this.#published && !promptlessUser
      ? { kind: "accepted", record, records: Object.freeze(emitted) }
      : { kind: "accepted" };
  }

  #materialize(envelope: HistoryEnvelope): GrokHistoryRecord {
    const promptId = envelope.metadata.promptId;
    const channelKey = JSON.stringify([
      promptId ?? null,
      envelope.draft.kind,
      envelope.draft.kind === "collaboration"
        ? envelope.draft.activityId
        : envelope.draft.kind === "plan"
          ? envelope.draft.replacement.planId
          : envelope.draft.kind === "tool"
            ? envelope.draft.toolCallId
            : null,
    ]);
    let occurrence = this.#channelOccurrences.get(channelKey) ?? -1;
    if (this.#lastChannelKey !== channelKey) {
      occurrence += 1;
      this.#channelOccurrences.set(channelKey, occurrence);
      this.#lastChannelKey = channelKey;
      this.#lastBlockOccurrence = occurrence;
    } else {
      occurrence = this.#lastBlockOccurrence!;
    }
    const stableEventIdentity = privateStableId("grok-event", [
      this.#nativeNamespaceKey,
      this.#sessionId,
      promptId ?? null,
      envelope.metadata.eventId,
    ]);
    const identity: GrokHistoryIdentity = Object.freeze({
      nativeNamespaceKey: this.#nativeNamespaceKey,
      eventId: envelope.metadata.eventId,
      ...(promptId !== undefined ? { promptId } : {}),
      blockId: privateStableId("grok-block", [
        ...(envelope.draft.kind === "plan"
          ? [envelope.draft.replacement.planId]
          : [
              this.#nativeNamespaceKey,
              this.#sessionId,
              promptId ?? null,
              envelope.draft.kind,
              envelope.draft.kind === "collaboration"
                ? envelope.draft.activityId
                : envelope.draft.kind === "tool"
                  ? envelope.draft.toolCallId
                  : occurrence,
            ]),
      ]),
      blockOccurrence: occurrence,
    });
    const common = {
      id: stableEventIdentity,
      sessionId: this.#sessionId,
      identity,
      replay: envelope.metadata.isReplay === true,
    } as const;
    if (
      envelope.draft.kind === "user_text" ||
      envelope.draft.kind === "assistant_text" ||
      envelope.draft.kind === "reasoning"
    ) {
      const hash =
        this.#textHashes.get(identity.blockId) ?? createHash("sha256");
      if (!this.#textHashes.has(identity.blockId)) {
        this.#textHashes.set(identity.blockId, hash);
      }
      hash.update(envelope.draft.text);
      return Object.freeze({
        ...common,
        kind: envelope.draft.kind,
        text: envelope.draft.kind === "reasoning"
          ? boundText(envelope.draft.text)
          : preserveMessageText(envelope.draft.text),
        exactTextDigest: hash.copy().digest("base64url"),
      });
    }
    const nonTextDraft = envelope.draft as Exclude<
      HistoryRecordDraft,
      { readonly kind: "user_text" | "assistant_text" | "reasoning" }
    >;
    return Object.freeze({ ...common, ...nonTextDraft });
  }

  #hasRetainedBlock(blockId: string): boolean {
    return this.#workingRecords.some(
      (record) =>
        record.kind !== "turn_completed" && record.identity.blockId === blockId,
    );
  }

  #detailedRecordCount(promptId: string): number {
    return new Set(
      this.#workingRecords.flatMap((record) =>
        record.identity.promptId === promptId &&
        record.kind !== "turn_completed" &&
        record.kind !== "omission"
          ? [record.identity.blockId]
          : [],
      ),
    ).size;
  }

  #retainOmission(
    promptId: string,
    replay: boolean,
  ): GrokHistoryOmissionRecord | undefined {
    if (
      this.#workingRecords.some(
        (record) =>
          record.kind === "omission" && record.identity.promptId === promptId,
      )
    ) {
      return undefined;
    }
    const eventId = privateStableId("grok-event", [
      "omission",
      this.#nativeNamespaceKey,
      this.#sessionId,
      promptId,
    ]);
    const record = Object.freeze({
      kind: "omission" as const,
      id: eventId,
      sessionId: this.#sessionId,
      identity: Object.freeze({
        nativeNamespaceKey: this.#nativeNamespaceKey,
        eventId,
        promptId,
        blockId: privateStableId("grok-block", [
          "omission",
          this.#nativeNamespaceKey,
          this.#sessionId,
          promptId,
        ]),
        blockOccurrence: MAXIMUM_DETAILED_RECORDS_PER_PROMPT,
      }),
      replay,
    });
    if (!this.#retain(record)) return undefined;
    return record;
  }

  /**
   * Retain semantic blocks rather than provider chunks. Live publication still
   * receives the exact accepted delta, while authoritative replay/history keeps
   * one cumulative text record per stable block identity. This makes native
   * tokenization an ingestion detail instead of a conversation-lifetime record
   * limit and keeps terminal projection proportional to semantic history.
   */
  #retain(record: GrokHistoryRecord): boolean {
    if (isTextRecord(record)) {
      const priorIndex = this.#workingTextRecordIndexes.get(
        record.identity.blockId,
      );
      if (priorIndex !== undefined) {
        const prior = this.#workingRecords[priorIndex];
        if (
          !prior ||
          !isTextRecord(prior) ||
          prior.kind !== record.kind ||
          prior.sessionId !== record.sessionId ||
          prior.identity.promptId !== record.identity.promptId
        ) {
          return false;
        }
        const next = Object.freeze({
          ...prior,
          text: record.kind === "reasoning"
            ? appendBoundedText(prior.text, record.text)
            : preserveMessageText(prior.text.text + record.text.text),
          exactTextDigest: record.exactTextDigest,
        });
        this.#workingRecords[priorIndex] = next;
        this.#retainedBytes +=
          retainedRecordBytes(next) - retainedRecordBytes(prior);
        return true;
      }
    }
    const recordBytes = retainedRecordBytes(record);
    const index = this.#workingRecords.length;
    this.#workingRecords.push(record);
    this.#retainedBytes += recordBytes;
    if (isTextRecord(record)) {
      this.#workingTextRecordIndexes.set(record.identity.blockId, index);
      if (
        record.kind === "user_text" &&
        record.identity.promptId === undefined
      ) {
        this.#rebindableUnassignedRecordIndexes.push(index);
      }
    } else if (record.kind === "plan") {
      const planKey = record.replacement.promptId;
      if (this.#planRecordIndexes.has(planKey)) return false;
      this.#planRecordIndexes.set(planKey, index);
      this.#planRetainedBytes.set(planKey, recordBytes);
    } else if (record.kind === "tool") {
      const toolKey = JSON.stringify([
        record.identity.promptId,
        record.toolCallId,
      ]);
      if (this.#toolRecordIndexes.has(toolKey)) return false;
      this.#toolRecordIndexes.set(toolKey, index);
      this.#toolRetainedBytes.set(toolKey, recordBytes);
    } else if (record.kind === "collaboration") {
      if (this.#collaborationRecordIndexes.has(record.activityId)) return false;
      this.#collaborationRecordIndexes.set(record.activityId, index);
      this.#collaborationRetainedBytes.set(record.activityId, recordBytes);
    }
    return true;
  }

  #rebindUnassignedUsers(
    promptId: string,
    emitted: GrokHistoryRecord[],
  ): boolean {
    let retainedBytes = this.#retainedBytes;
    const replacements: Array<{
      readonly index: number;
      readonly prior: GrokHistoryTextRecord;
      readonly next: GrokHistoryTextRecord;
    }> = [];
    for (const index of this.#rebindableUnassignedRecordIndexes) {
      const prior = this.#workingRecords[index];
      if (!prior || prior.kind !== "user_text") return false;
      const identity = Object.freeze({
        ...prior.identity,
        promptId,
        blockId: privateStableId("grok-block", [
          this.#nativeNamespaceKey,
          this.#sessionId,
          promptId,
          prior.kind,
          prior.identity.blockOccurrence,
        ]),
      });
      const next = Object.freeze({
        ...prior,
        id: privateStableId("grok-event", [
          this.#nativeNamespaceKey,
          this.#sessionId,
          promptId,
          prior.identity.eventId,
        ]),
        identity,
      });
      retainedBytes += retainedRecordBytes(next) - retainedRecordBytes(prior);
      replacements.push({ index, prior, next });
    }
    for (const { index, prior, next } of replacements) {
      this.#workingTextRecordIndexes.delete(prior.identity.blockId);
      this.#workingTextRecordIndexes.set(next.identity.blockId, index);
      const hash = this.#textHashes.get(prior.identity.blockId);
      if (hash) {
        this.#textHashes.delete(prior.identity.blockId);
        this.#textHashes.set(next.identity.blockId, hash);
      }
      this.#workingRecords[index] = next;
      emitted.push(next);
    }
    this.#retainedBytes = retainedBytes;
    this.#rebindableUnassignedRecordIndexes.length = 0;
    return true;
  }

  #rememberFingerprint(
    eventKey: string,
    fingerprint: string,
    promptId: string | undefined,
    toolKey?: string,
    collaborationActivityId?: string,
  ): void {
    if (this.#fingerprints.has(eventKey)) return;
    const bytes =
      Buffer.byteLength(eventKey, "utf8") +
      Buffer.byteLength(fingerprint, "utf8");
    this.#fingerprints.set(eventKey, fingerprint);
    this.#fingerprintPromptIds.set(eventKey, promptId);
    this.#fingerprintToolKeys.set(eventKey, toolKey);
    this.#fingerprintCollaborationActivityIds.set(
      eventKey,
      collaborationActivityId,
    );
    this.#dedupeBytes += bytes;
  }

  #rebindPromptlessFingerprints(promptId: string): boolean {
    for (const priorKey of this.#promptlessFingerprintKeys) {
      const parsed = JSON.parse(priorKey) as [null, string];
      const nextKey = JSON.stringify([promptId, parsed[1]]);
      const nextFingerprint = this.#fingerprints.get(priorKey)!;
      const existing = this.#fingerprints.get(nextKey);
      if (existing !== undefined && existing !== nextFingerprint) return false;
      this.#deleteFingerprint(priorKey);
      this.#rememberFingerprint(nextKey, nextFingerprint, promptId);
    }
    this.#promptlessFingerprintKeys.clear();
    return true;
  }

  #deleteFingerprint(eventKey: string): void {
    const fingerprint = this.#fingerprints.get(eventKey);
    if (fingerprint === undefined) return;
    this.#dedupeBytes -=
      Buffer.byteLength(eventKey, "utf8") +
      Buffer.byteLength(fingerprint, "utf8");
    this.#fingerprints.delete(eventKey);
    this.#fingerprintPromptIds.delete(eventKey);
    this.#fingerprintToolKeys.delete(eventKey);
    this.#fingerprintCollaborationActivityIds.delete(eventKey);
    this.#promptlessFingerprintKeys.delete(eventKey);
  }

  #observePrompt(promptId: string, kind: HistoryRecordDraft["kind"]): boolean {
    const visible = this.#promptOrder.includes(promptId);
    const offWindow =
      this.#offWindowToolPromptIds.has(promptId) ||
      this.#offWindowCollaborationPromptIds.has(promptId);
    if (visible || offWindow) {
      return (
        promptId === this.#currentPromptId ||
        kind === "tool" ||
        kind === "collaboration"
      );
    }
    if (this.#currentPromptId !== undefined) {
      this.#sealedPromptIds.add(this.#currentPromptId);
    }
    this.#currentPromptId = promptId;
    this.#promptOrder.push(promptId);
    this.#evictOldPrompts();
    return true;
  }

  #evictOldPrompts(): void {
    while (this.#sealedPromptIds.size > this.#retainedCompletedPromptWindow) {
      const promptId = this.#promptOrder.find((candidate) =>
        this.#sealedPromptIds.has(candidate),
      );
      if (promptId === undefined) return;
      const unsettledToolKeys = new Set(
        this.#workingRecords.flatMap((record) => {
          if (
            record.kind !== "tool" ||
            record.identity.promptId !== promptId ||
            toolStatusSettled(record.patch.status)
          ) {
            return [];
          }
          return [JSON.stringify([promptId, record.toolCallId])];
        }),
      );
      const unsettledCollaborationActivityIds = new Set(
        this.#workingRecords.flatMap((record) => {
          if (
            record.kind !== "collaboration" ||
            record.identity.promptId !== promptId ||
            record.status !== "streaming"
          ) {
            return [];
          }
          return [record.activityId];
        }),
      );
      for (const record of this.#workingRecords) {
        if (record.identity.promptId === promptId && isTextRecord(record)) {
          this.#textHashes.delete(record.identity.blockId);
        }
        if (
          record.kind === "collaboration" &&
          record.identity.promptId === promptId &&
          !unsettledCollaborationActivityIds.has(record.activityId)
        ) {
          this.#subagents.releaseActivity(record.activityId);
          this.#collaborationTerminalFingerprints.delete(record.activityId);
        }
      }
      this.#workingRecords.splice(
        0,
        this.#workingRecords.length,
        ...this.#workingRecords.filter((record) => {
          if (record.identity.promptId !== promptId) return true;
          return (
            (record.kind === "tool" &&
              unsettledToolKeys.has(
                JSON.stringify([promptId, record.toolCallId]),
              )) ||
            (record.kind === "collaboration" &&
              unsettledCollaborationActivityIds.has(record.activityId))
          );
        }),
      );
      for (const [eventKey, ownerPromptId] of this.#fingerprintPromptIds) {
        if (ownerPromptId !== promptId) continue;
        const toolKey = this.#fingerprintToolKeys.get(eventKey);
        const collaborationActivityId =
          this.#fingerprintCollaborationActivityIds.get(eventKey);
        if (
          (toolKey === undefined || !unsettledToolKeys.has(toolKey)) &&
          (collaborationActivityId === undefined ||
            !unsettledCollaborationActivityIds.has(collaborationActivityId))
        ) {
          this.#deleteFingerprint(eventKey);
        }
      }
      this.#terminalFingerprints.delete(promptId);
      this.#sealedPromptIds.delete(promptId);
      this.#promptOrder.splice(this.#promptOrder.indexOf(promptId), 1);
      this.#evictedPromptCount += 1;
      if (unsettledToolKeys.size > 0) {
        this.#offWindowToolPromptIds.add(promptId);
      } else {
        for (const [correlationKey, ownerPromptId] of this.#toolPromptIds) {
          if (ownerPromptId === promptId) {
            this.#toolPromptIds.delete(correlationKey);
          }
        }
      }
      if (unsettledCollaborationActivityIds.size > 0) {
        this.#offWindowCollaborationPromptIds.add(promptId);
      }
      for (const channelKey of this.#channelOccurrences.keys()) {
        try {
          if (JSON.parse(channelKey)[0] === promptId) {
            this.#channelOccurrences.delete(channelKey);
          }
        } catch {
          this.#channelOccurrences.delete(channelKey);
        }
      }
      this.#rebuildRecordIndexes();
    }
  }

  #releaseSettledOffWindowTool(
    promptId: string,
    toolKey: string,
    record: GrokHistoryToolRecord,
  ): void {
    if (
      !this.#offWindowToolPromptIds.has(promptId) ||
      !toolStatusSettled(record.patch.status)
    ) {
      return;
    }
    const toolCallId = record.toolCallId;
    this.#workingRecords.splice(
      0,
      this.#workingRecords.length,
      ...this.#workingRecords.filter(
        (candidate) =>
          candidate.kind !== "tool" ||
          candidate.identity.promptId !== promptId ||
          candidate.toolCallId !== toolCallId,
      ),
    );
    for (const [eventKey, ownerToolKey] of this.#fingerprintToolKeys) {
      if (ownerToolKey === toolKey) this.#deleteFingerprint(eventKey);
    }
    for (const [correlationKey, ownerPromptId] of this.#toolPromptIds) {
      const parsed = JSON.parse(correlationKey) as [boolean, string];
      if (ownerPromptId === promptId && parsed[1] === toolCallId) {
        this.#toolPromptIds.delete(correlationKey);
      }
    }
    if (
      !this.#workingRecords.some(
        (candidate) =>
          candidate.kind === "tool" && candidate.identity.promptId === promptId,
      )
    ) {
      this.#offWindowToolPromptIds.delete(promptId);
    }
    this.#rebuildRecordIndexes();
  }

  #releaseSettledOffWindowCollaboration(
    record: GrokHistoryCollaborationRecord,
  ): void {
    const promptId = record.identity.promptId;
    if (
      promptId === undefined ||
      !this.#offWindowCollaborationPromptIds.has(promptId) ||
      record.status === "streaming"
    ) {
      return;
    }
    this.#workingRecords.splice(
      0,
      this.#workingRecords.length,
      ...this.#workingRecords.filter(
        (candidate) =>
          candidate.kind !== "collaboration" ||
          candidate.activityId !== record.activityId,
      ),
    );
    for (const [eventKey, activityId] of this
      .#fingerprintCollaborationActivityIds) {
      if (activityId === record.activityId) this.#deleteFingerprint(eventKey);
    }
    this.#subagents.releaseActivity(record.activityId);
    this.#collaborationTerminalFingerprints.delete(record.activityId);
    if (
      !this.#workingRecords.some(
        (candidate) =>
          candidate.kind === "collaboration" &&
          candidate.identity.promptId === promptId,
      )
    ) {
      this.#offWindowCollaborationPromptIds.delete(promptId);
    }
    this.#rebuildRecordIndexes();
  }

  #toolMayBeRebound(promptId: string, toolCallId: string): boolean {
    const index = this.#toolRecordIndexes.get(
      JSON.stringify([promptId, toolCallId]),
    );
    const record =
      index === undefined ? undefined : this.#workingRecords[index];
    return record?.kind === "tool" && toolStatusSettled(record.patch.status);
  }

  #rebuildRecordIndexes(): void {
    this.#workingTextRecordIndexes.clear();
    this.#rebindableUnassignedRecordIndexes.length = 0;
    this.#planRecordIndexes.clear();
    this.#planRetainedBytes.clear();
    this.#collaborationRecordIndexes.clear();
    this.#collaborationRetainedBytes.clear();
    this.#toolRecordIndexes.clear();
    this.#toolRetainedBytes.clear();
    this.#retainedBytes = 0;
    for (const [index, record] of this.#workingRecords.entries()) {
      const recordBytes = retainedRecordBytes(record);
      this.#retainedBytes += recordBytes;
      if (isTextRecord(record)) {
        this.#workingTextRecordIndexes.set(record.identity.blockId, index);
        if (
          record.kind === "user_text" &&
          record.identity.promptId === undefined
        ) {
          this.#rebindableUnassignedRecordIndexes.push(index);
        }
      } else if (record.kind === "plan") {
        const planKey = record.replacement.promptId;
        this.#planRecordIndexes.set(planKey, index);
        this.#planRetainedBytes.set(planKey, recordBytes);
      } else if (record.kind === "tool") {
        const toolKey = JSON.stringify([
          record.identity.promptId,
          record.toolCallId,
        ]);
        this.#toolRecordIndexes.set(toolKey, index);
        this.#toolRetainedBytes.set(toolKey, recordBytes);
      } else if (record.kind === "collaboration") {
        this.#collaborationRecordIndexes.set(record.activityId, index);
        this.#collaborationRetainedBytes.set(record.activityId, recordBytes);
      }
    }
  }

  #fail(reason: string): GrokHistoryProjectionResult {
    this.#failure = Object.freeze({ kind: "resnapshot_required", reason });
    for (const record of this.#workingRecords) {
      if (record.kind === "collaboration") {
        this.#subagents.releaseActivity(record.activityId);
      }
    }
    this.#workingRecords.length = 0;
    this.#workingTextRecordIndexes.clear();
    this.#rebindableUnassignedRecordIndexes.length = 0;
    this.#fingerprints.clear();
    this.#fingerprintPromptIds.clear();
    this.#fingerprintToolKeys.clear();
    this.#fingerprintCollaborationActivityIds.clear();
    this.#promptlessFingerprintKeys.clear();
    this.#textHashes.clear();
    this.#terminalFingerprints.clear();
    this.#planRecordIndexes.clear();
    this.#planRetainedBytes.clear();
    this.#collaborationRecordIndexes.clear();
    this.#collaborationRetainedBytes.clear();
    this.#collaborationTerminalFingerprints.clear();
    this.#toolRecordIndexes.clear();
    this.#toolRetainedBytes.clear();
    this.#toolPromptIds.clear();
    this.#promptOrder.length = 0;
    this.#sealedPromptIds.clear();
    this.#offWindowToolPromptIds.clear();
    this.#offWindowCollaborationPromptIds.clear();
    this.#channelOccurrences.clear();
    this.#lastChannelKey = undefined;
    this.#lastBlockOccurrence = undefined;
    this.#retainedBytes = 0;
    this.#dedupeBytes = 0;
    this.#evictedPromptCount = 0;
    this.#currentPromptId = undefined;
    this.#published = false;
    return this.#failure;
  }
}

function retainedRecordBytes(record: GrokHistoryRecord): number {
  return Buffer.byteLength(JSON.stringify(record));
}

function isTextRecord(
  record: GrokHistoryRecord,
): record is GrokHistoryTextRecord {
  return (
    record.kind === "user_text" ||
    record.kind === "assistant_text" ||
    record.kind === "reasoning"
  );
}

function appendBoundedText(
  prior: BoundedText,
  delta: BoundedText,
): BoundedText {
  if (prior.truncation) return prior;
  return boundText(prior.text + delta.text);
}

function decodeStandardEnvelope(
  notification: SessionNotification,
): HistoryEnvelope | "ignored" | undefined {
  const update = notification.update;
  if (
    update.sessionUpdate === "tool_call" ||
    update.sessionUpdate === "tool_call_update"
  ) {
    return decodeToolEnvelope(notification);
  }
  if (
    update.sessionUpdate !== "user_message_chunk" &&
    update.sessionUpdate !== "agent_message_chunk" &&
    update.sessionUpdate !== "agent_thought_chunk"
  ) {
    return "ignored";
  }
  if (!boundedString(notification.sessionId, 1_024)) return undefined;
  // Grok may echo user attachment blocks independently. Provider-private image
  // bytes and staged resource paths must never enter normalized history, so a
  // validated non-text user block is safely omitted while text and prompt
  // correlation remain authoritative.
  if (update.content.type !== "text") {
    return update.sessionUpdate === "user_message_chunk"
      ? "ignored"
      : undefined;
  }
  const metadata = decodeMetadata(notification._meta);
  if (!metadata) return undefined;
  const kind =
    update.sessionUpdate === "user_message_chunk"
      ? "user_text"
      : update.sessionUpdate === "agent_message_chunk"
        ? "assistant_text"
        : "reasoning";
  const draft = Object.freeze({ kind, text: update.content.text });
  const canonicalEnvelope = {
    sessionId: notification.sessionId,
    eventId: metadata.eventId,
    promptId: metadata.promptId ?? null,
    draft,
  };
  return Object.freeze({
    sessionId: notification.sessionId,
    metadata,
    draft,
    fingerprint: fingerprint({
      sessionId: notification.sessionId,
      draft,
    }),
    bytes: Buffer.byteLength(JSON.stringify(canonicalEnvelope)),
  });
}

function decodePlanEnvelope(
  notification: SessionNotification,
  replacement: GrokAcpPlanReplacement,
): HistoryEnvelope | undefined {
  if (
    notification.update.sessionUpdate !== "plan" ||
    !boundedString(notification.sessionId, 1_024)
  ) {
    return undefined;
  }
  const metadata = decodeMetadata(notification._meta);
  if (
    !metadata?.promptId ||
    metadata.eventId !== replacement.eventId ||
    metadata.promptId !== replacement.promptId
  ) {
    return undefined;
  }
  const draft = Object.freeze({ kind: "plan" as const, replacement });
  const semanticDraft = Object.freeze({
    kind: "plan" as const,
    planId: replacement.planId,
    backendItemId: replacement.backendItemId,
    entries: replacement.entries,
  });
  return Object.freeze({
    sessionId: notification.sessionId,
    metadata,
    draft,
    fingerprint: fingerprint({
      sessionId: notification.sessionId,
      draft: semanticDraft,
    }),
    bytes: Buffer.byteLength(
      JSON.stringify({
        sessionId: notification.sessionId,
        eventId: metadata.eventId,
        promptId: metadata.promptId,
        draft: semanticDraft,
      }),
    ),
  });
}

function decodeToolEnvelope(
  notification: SessionNotification,
): HistoryEnvelope | undefined {
  const update = notification.update;
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  ) {
    return undefined;
  }
  const metadata = decodeMetadata(notification._meta);
  if (
    !metadata?.promptId ||
    !boundedString(notification.sessionId, 1_024) ||
    !boundedString(update.toolCallId, 1_024)
  ) {
    return undefined;
  }
  const updateMetadata = Object.getOwnPropertyDescriptor(
    update,
    "_meta",
  )?.value;
  const canonicalToolMetadata = decodeGrokCanonicalToolMetadata(updateMetadata);
  const rawOutput = Object.getOwnPropertyDescriptor(update, "rawOutput")?.value;
  const rawOutputVariant = decodeGrokRawToolOutputVariant(rawOutput);
  const patch: GrokHistoryToolPatch = Object.freeze({
    ...(Object.hasOwn(update, "title") ? { title: update.title } : {}),
    ...(Object.hasOwn(update, "name") ? { name: update.name } : {}),
    ...(Object.hasOwn(update, "kind") ? { toolKind: update.kind } : {}),
    ...(Object.hasOwn(update, "status") ? { status: update.status } : {}),
    ...(Object.hasOwn(update, "content")
      ? {
          content:
            update.content === null ? null : Object.freeze(update.content),
        }
      : {}),
    ...(Object.hasOwn(update, "locations")
      ? (() => {
          const locations = update.locations;
          return {
            locations:
              locations == null
                ? null
                : Object.freeze(
                    locations.map((location) => Object.freeze({ ...location })),
                  ),
          };
        })()
      : {}),
    ...(Object.hasOwn(update, "rawInput") ? { rawInput: update.rawInput } : {}),
    ...(Object.hasOwn(update, "rawOutput")
      ? { rawOutput: update.rawOutput }
      : {}),
    ...(canonicalToolMetadata === undefined ? {} : { canonicalToolMetadata }),
    ...(rawOutputVariant === undefined ? {} : { rawOutputVariant }),
  });
  const draft = Object.freeze({
    kind: "tool" as const,
    toolCallId: update.toolCallId,
    patch,
  });
  const canonicalEnvelope = {
    sessionId: notification.sessionId,
    eventId: metadata.eventId,
    promptId: metadata.promptId,
    draft,
  };
  return Object.freeze({
    sessionId: notification.sessionId,
    metadata,
    draft,
    fingerprint: fingerprint({
      sessionId: notification.sessionId,
      draft,
    }),
    bytes: Buffer.byteLength(JSON.stringify(canonicalEnvelope)),
  });
}

function decodeTerminalEnvelope(
  notification: GrokSourceCandidateTurnCompletedNotification,
): HistoryEnvelope | undefined {
  const metadata = decodeMetadata(notification._meta);
  const update = notification.update;
  if (
    !metadata ||
    !boundedString(notification.sessionId, 1_024) ||
    !boundedString(update.prompt_id, 1_024) ||
    !boundedString(update.stop_reason, 1_024) ||
    (metadata.promptId !== undefined &&
      metadata.promptId !== update.prompt_id) ||
    (update.agent_result !== undefined &&
      update.agent_result !== null &&
      !boundedString(update.agent_result, 64 * 1_024))
  ) {
    return undefined;
  }
  const terminalMetadata = Object.freeze({
    ...metadata,
    promptId: update.prompt_id,
  });
  const draft = Object.freeze({
    kind: "turn_completed" as const,
    stopReason: update.stop_reason,
    ...(update.agent_result !== undefined
      ? { agentResult: update.agent_result }
      : {}),
    ...(terminalMetadata.agentTimestampMs !== undefined
      ? { completedAtMs: terminalMetadata.agentTimestampMs }
      : {}),
  });
  const canonicalEnvelope = {
    sessionId: notification.sessionId,
    eventId: terminalMetadata.eventId,
    promptId: terminalMetadata.promptId,
    draft,
  };
  return Object.freeze({
    sessionId: notification.sessionId,
    metadata: terminalMetadata,
    draft,
    fingerprint: fingerprint({
      sessionId: notification.sessionId,
      draft,
    }),
    bytes: Buffer.byteLength(JSON.stringify(canonicalEnvelope)),
  });
}

function collaborationEnvelope(
  sessionId: string,
  eventId: string,
  replay: boolean,
  projection: GrokSubagentCollaborationProjection,
  eventFingerprint: string,
): HistoryEnvelope {
  const draft: Extract<HistoryRecordDraft, { readonly kind: "collaboration" }> =
    Object.freeze({
      kind: "collaboration" as const,
      activityId: projection.activityId,
      status: projection.item.status,
      action: projection.item.action,
      ...(projection.item.agentLabel
        ? { agentLabel: projection.item.agentLabel }
        : {}),
      ...(projection.item.summary ? { summary: projection.item.summary } : {}),
      ...(projection.item.error ? { error: projection.item.error } : {}),
    });
  const metadata = Object.freeze({
    eventId,
    promptId: projection.promptId,
    ...(replay ? { isReplay: true as const } : {}),
  });
  const canonicalEnvelope = {
    sessionId,
    eventId,
    promptId: projection.promptId,
    draft,
  };
  return Object.freeze({
    sessionId,
    metadata,
    draft,
    fingerprint: eventFingerprint,
    bytes: Buffer.byteLength(JSON.stringify(canonicalEnvelope)),
  });
}

function collaborationRecordReplacement(
  prior: GrokHistoryCollaborationRecord,
  projection: GrokSubagentCollaborationProjection,
): GrokHistoryCollaborationRecord {
  return Object.freeze({
    kind: "collaboration",
    id: prior.id,
    sessionId: prior.sessionId,
    identity: prior.identity,
    activityId: prior.activityId,
    status: projection.item.status,
    action: projection.item.action,
    ...(projection.item.agentLabel
      ? { agentLabel: projection.item.agentLabel }
      : {}),
    ...(projection.item.summary ? { summary: projection.item.summary } : {}),
    ...(projection.item.error ? { error: projection.item.error } : {}),
    replay: prior.replay,
  });
}

function durableSubagentFingerprint(
  event: Exclude<GrokSubagentEvent, { readonly kind: "progress" }>,
): string {
  const {
    eventId: _eventId,
    replay: _replay,
    promptId: _metadataPromptId,
    ...semantic
  } = event;
  return fingerprint({ sessionId: event.sessionId, event: semantic });
}

function decodeMetadata(value: unknown): GrokEventMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const eventId = boundedString(value.eventId, 1_024)
    ? value.eventId
    : undefined;
  const promptId =
    value.promptId === undefined
      ? undefined
      : boundedString(value.promptId, 1_024)
        ? value.promptId
        : INVALID;
  if (
    !eventId ||
    promptId === INVALID ||
    (value.isReplay !== undefined && value.isReplay !== true) ||
    (value.agentTimestampMs !== undefined &&
      (!Number.isSafeInteger(value.agentTimestampMs) ||
        (value.agentTimestampMs as number) < 0 ||
        (value.agentTimestampMs as number) > MAXIMUM_DATE_MILLISECONDS))
  ) {
    return undefined;
  }
  return Object.freeze({
    eventId,
    ...(promptId !== undefined ? { promptId } : {}),
    ...(value.isReplay === true ? { isReplay: true as const } : {}),
    ...(value.agentTimestampMs !== undefined
      ? { agentTimestampMs: value.agentTimestampMs as number }
      : {}),
  });
}

function eventIdentityKey(metadata: GrokEventMetadata): string {
  return JSON.stringify([metadata.promptId ?? null, metadata.eventId]);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

const INVALID = Symbol("invalid");

function toolStatusSettled(status: ToolCallStatus | null | undefined): boolean {
  return status === "completed" || status === "failed";
}

function boundedString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximumBytes &&
    !value.includes("\0")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function privateStableId(
  domain: "grok-event" | "grok-block" | "grok-activity",
  parts: readonly (string | number | null)[],
): string {
  const digest = createHash("sha256")
    .update(domain)
    .update("\0")
    .update(JSON.stringify(parts))
    .digest("hex");
  return `${domain}:${digest}`;
}
