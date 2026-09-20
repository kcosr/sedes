import { createHash } from "node:crypto";
import {
  backendConversationSnapshotSchema,
  backendHistoryPageSchema,
  MAXIMUM_BACKEND_ITEMS_PER_TURN,
  type BackendConversationSnapshot,
  type BackendHistoryPagePayload,
  type BackendItem,
  type BackendTurn,
} from "../../../shared/protocol/backend.js";
import {
  MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
  serializedUtf8Bytes,
  type BoundedText,
} from "../../../shared/protocol/payload.js";
import {
  boundDisplayText,
  boundText,
  preserveMessageText,
} from "../../conversations/payload-policy.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type {
  OutputArtifactPublisher,
  OutputImageArtifactDescriptor,
} from "../../output-artifacts/contracts.js";
import {
  grokGeneratedImagePublicationKey,
  inspectCompletedGrokGeneratedImageOutput,
  inspectGrokGeneratedImageCandidate,
  inspectGrokGeneratedImageOutput,
  readGrokGeneratedImage,
  removeGrokGeneratedImageMarkdownReferences,
  type GrokGeneratedImageCandidate,
  type GrokGeneratedImageReadAuthority,
} from "./grok-generated-image.js";
import type {
  GrokHistoryCollaborationRecord,
  GrokHistoryRecord,
} from "./grok-history-projector.js";
import {
  settleGrokAcpPlanAtTerminal,
  type GrokAcpPlanReplacement,
} from "./grok-acp-plan-normalization.js";
import {
  inspectGrokSubmissionPromptId,
  type GrokSubmissionCorrelationScope,
} from "./grok-submission-correlation.js";
import {
  applyGrokToolPatch,
  createGrokToolBlock,
  GrokToolProjectionError,
  prepareGrokToolBlockForPublication,
  projectGrokToolBlock,
  type GrokMutableToolBlock,
} from "./grok-tool-projector.js";

const LATEST_SNAPSHOT_TURNS = 10;
const MAXIMUM_HISTORY_PAGE_TURNS = 100;
const MAXIMUM_DATE_MILLISECONDS = 8_640_000_000_000_000;
const MAXIMUM_CURSOR_BYTES = 512;

export class GrokNormalizedHistoryError extends Error {
  readonly code:
    | "grok_normalized_history_invalid"
    | "grok_normalized_history_too_large"
    | "grok_normalized_history_cursor_invalid";

  constructor(code: GrokNormalizedHistoryError["code"], cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "GrokNormalizedHistoryError";
    this.code = code;
  }
}

interface Timeline {
  readonly orderedBackendTurnIds: readonly string[];
  readonly turnsById: Readonly<Record<string, BackendTurn>>;
  readonly itemsById: BackendConversationSnapshot["itemsById"];
  readonly cursorFingerprints: readonly string[];
  readonly semanticFingerprint: string;
  readonly promptIdByBackendTurnId: ReadonlyMap<string, string>;
  readonly exactUserTextDigestByBackendTurnId: Readonly<Record<string, string>>;
  readonly exactTextDigestByBackendItemId: Readonly<Record<string, string>>;
  readonly generatedImages: readonly TimelineGeneratedImage[];
}

interface TimelineGeneratedImage {
  readonly toolBackendItemId: string;
  readonly imageBackendItemId: string;
  readonly backendTurnId: string;
  readonly candidate: GrokGeneratedImageCandidate;
}

type SelectedTimeline = Pick<
  BackendConversationSnapshot,
  "orderedBackendTurnIds" | "turnsById" | "itemsById"
>;

export interface GrokGeneratedImageProjectionContext {
  readonly scope: RequestScope;
  readonly applicationThreadId: string;
  readonly outputArtifacts: OutputArtifactPublisher;
  readonly authority: GrokGeneratedImageReadAuthority;
}

export interface GrokProviderHistoryCursorSelection {
  readonly previousCursor?: string;
  readonly previousCursorByPromptId: Readonly<Record<string, string>>;
}

type GrokGeneratedImageResolution = ReadonlyMap<
  string,
  | {
      readonly kind: "published";
      readonly descriptor: OutputImageArtifactDescriptor;
    }
  | {
      readonly kind: "omitted";
      readonly reason: "byte_limit" | "invalid_data" | "unavailable";
    }
>;

export interface GrokNormalizedHistoryEvidence {
  readonly transcriptFingerprint: string;
  readonly runState: "idle" | "running";
  readonly matchingTurns: readonly BackendTurn[];
  readonly userTextDigestByBackendTurnId: Readonly<Record<string, string>>;
}

export function sanitizeGrokLiveGeneratedImageMarkdown(
  item: BackendItem,
  records: readonly GrokHistoryRecord[],
  promptId: string | undefined,
): BackendItem {
  if (
    promptId === undefined ||
    (item.semanticKind !== "assistant_message" &&
      item.semanticKind !== "reasoning")
  ) {
    return item;
  }
  const fileNames = new Set(
    records.flatMap((record) => {
      if (
        record.kind !== "tool" ||
        record.identity.promptId !== promptId ||
        record.patch.status !== "completed"
      ) {
        return [];
      }
      const output = inspectCompletedGrokGeneratedImageOutput(
        record.patch.rawOutput,
      );
      return output ? [output.fileName] : [];
    }),
  );
  if (fileNames.size === 0) return item;
  const text = removeGrokGeneratedImageMarkdownReferences(
    item.markdown.text,
    fileNames,
  );
  return text === item.markdown.text
    ? item
    : { ...item, markdown: item.semanticKind === "assistant_message"
        ? preserveMessageText(text)
        : boundText(text) };
}

/**
 * Returns the native identity of the one recoverable interrupted turn.
 *
 * This is deliberately stricter than merely observing a running snapshot:
 * the incomplete turn must be final, carry an exact prompt identity, and
 * authenticate as a Sedes submission in the supplied native binding scope.
 * Invalid or forged Sedes-shaped history continues to fail closed through
 * buildTimeline; promptless and provider-native turns are never recovered.
 */
export function recoverableInterruptedGrokPromptId(
  records: readonly GrokHistoryRecord[],
  submissionCorrelation: GrokSubmissionCorrelationScope,
): string | undefined {
  const timeline = buildTimeline(records, submissionCorrelation);
  const finalTurnId = timeline.orderedBackendTurnIds.at(-1);
  if (
    !finalTurnId ||
    timeline.turnsById[finalTurnId]?.status !== "in_progress"
  ) {
    return undefined;
  }
  const promptId = timeline.promptIdByBackendTurnId.get(finalTurnId);
  if (!promptId) return undefined;
  return inspectGrokSubmissionPromptId(promptId, submissionCorrelation).type ===
    "authenticated"
    ? promptId
    : undefined;
}

export function grokNormalizedItemId(
  record: Exclude<GrokHistoryRecord, { readonly kind: "turn_completed" }>,
): string {
  if (record.kind === "plan") return record.replacement.backendItemId;
  const turnKey =
    record.identity.promptId === undefined
      ? JSON.stringify(["unassigned-user", record.identity.blockId])
      : JSON.stringify(["prompt", record.identity.promptId]);
  return stableId("grok-item", [
    record.identity.nativeNamespaceKey,
    record.sessionId,
    turnKey,
    record.identity.blockId,
    record.kind,
  ]);
}

interface MutableTurn {
  readonly turnKey: string;
  readonly promptId?: string;
  readonly backendTurnId: string;
  readonly applicationOperationId?: string;
  replayOnly: boolean;
  readonly orderedBackendItemIds: string[];
  readonly blocks: Map<
    string,
    | {
        readonly kind: "user_text" | "assistant_text" | "reasoning";
        readonly backendItemId: string;
        readonly sourceOrder: number;
        text: BoundedText;
        exactTextDigest: string;
      }
    | {
        readonly kind: "collaboration";
        readonly backendItemId: string;
        readonly sourceOrder: number;
        readonly activityId: string;
        status: GrokHistoryCollaborationRecord["status"];
        action: GrokHistoryCollaborationRecord["action"];
        agentLabel?: GrokHistoryCollaborationRecord["agentLabel"];
        summary?: GrokHistoryCollaborationRecord["summary"];
        error?: GrokHistoryCollaborationRecord["error"];
      }
    | {
        readonly kind: "plan";
        readonly backendItemId: string;
        readonly sourceOrder: number;
        replacement: GrokAcpPlanReplacement;
      }
    | {
        readonly kind: "omission";
        readonly backendItemId: string;
        readonly sourceOrder: number;
      }
    | GrokMutableToolBlock
  >;
  terminal?: Extract<GrokHistoryRecord, { readonly kind: "turn_completed" }>;
  inferredInterrupted?: true;
}

export function projectGrokLatestHistory(
  records: readonly GrokHistoryRecord[],
  submissionCorrelation?: GrokSubmissionCorrelationScope,
): {
  readonly snapshot: BackendConversationSnapshot;
  readonly previousCursor?: string;
} {
  const timeline = buildTimeline(records, submissionCorrelation);
  return projectGrokLatestTimeline(timeline);
}

function projectGrokLatestTimeline(timeline: Timeline): {
  readonly snapshot: BackendConversationSnapshot;
  readonly previousCursor?: string;
} {
  return projectGrokLatestSelection(
    timeline,
    selectGrokLatestTimeline(timeline),
  );
}

interface GrokLatestTimelineSelection {
  readonly selected: SelectedTimeline;
  readonly start: number;
  readonly finalTurnId?: string;
  readonly runState: "idle" | "running";
}

function selectGrokLatestTimeline(
  timeline: Timeline,
): GrokLatestTimelineSelection {
  const end = timeline.orderedBackendTurnIds.length;
  const earliestByCount = Math.max(0, end - LATEST_SNAPSHOT_TURNS);
  if (end === 0) {
    return {
      selected: pickTimeline(timeline, []),
      start: 0,
      runState: "idle",
    };
  }
  const finalTurnId = timeline.orderedBackendTurnIds[end - 1]!;
  const runState =
    timeline.turnsById[finalTurnId]?.status === "in_progress"
      ? "running"
      : "idle";
  const bytesAt = (start: number) => {
    const selected = pickTimeline(
      timeline,
      timeline.orderedBackendTurnIds.slice(start, end),
    );
    return serializedUtf8Bytes({
      ...selected,
      runState,
      ...(runState === "running" ? { activeBackendTurnId: finalTurnId } : {}),
    });
  };
  if (bytesAt(end - 1) > MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES) {
    oversizedTurn();
  }
  const start = earliestStartWithinBytes(earliestByCount, end - 1, bytesAt);
  const turnIds = timeline.orderedBackendTurnIds.slice(start, end);
  const selected = pickTimeline(timeline, turnIds);
  return { selected, start, finalTurnId, runState };
}

function projectGrokLatestSelection(
  timeline: Timeline,
  selection: GrokLatestTimelineSelection,
  generatedImages?: GrokGeneratedImageResolution,
): {
  readonly snapshot: BackendConversationSnapshot;
  readonly previousCursor?: string;
} {
  const { selected, start, finalTurnId, runState } = selection;
  let snapshot: BackendConversationSnapshot;
  try {
    // Validate all native history before reading or publishing provider bytes.
    backendConversationSnapshotSchema.parse({
      ...selected,
      runState,
      ...(runState === "running" && finalTurnId
        ? { activeBackendTurnId: finalTurnId }
        : {}),
    });
    const resolved = generatedImages
      ? resolveGeneratedImages(
          selected,
          timeline.generatedImages,
          generatedImages,
        )
      : selected;
    snapshot = backendConversationSnapshotSchema.parse({
      ...resolved,
      runState,
      ...(runState === "running" && finalTurnId
        ? { activeBackendTurnId: finalTurnId }
        : {}),
    });
  } catch (error) {
    if (error instanceof GrokNormalizedHistoryError) throw error;
    throw new GrokNormalizedHistoryError(
      "grok_normalized_history_invalid",
      error,
    );
  }
  return Object.freeze({
    snapshot,
    ...(start > 0
      ? {
          previousCursor: historyCursor(
            timeline.cursorFingerprints[start]!,
            start,
          ),
        }
      : {}),
  });
}

export function projectGrokHistoryPage(
  records: readonly GrokHistoryRecord[],
  input: { readonly cursor?: string; readonly limit: number },
  submissionCorrelation?: GrokSubmissionCorrelationScope,
): BackendHistoryPagePayload {
  validateHistoryPageInput(input);
  const timeline = buildTimeline(records, submissionCorrelation);
  return projectGrokHistoryPageTimeline(timeline, input);
}

function validateHistoryPageInput(input: {
  readonly cursor?: string;
  readonly limit: number;
}): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAXIMUM_HISTORY_PAGE_TURNS
  ) {
    invalidCursor();
  }
}

function projectGrokHistoryPageTimeline(
  timeline: Timeline,
  input: { readonly cursor?: string; readonly limit: number },
): BackendHistoryPagePayload {
  return projectGrokHistoryPageSelection(
    timeline,
    selectGrokHistoryPageTimeline(timeline, input),
  );
}

interface GrokHistoryPageTimelineSelection {
  readonly selected: SelectedTimeline;
  readonly start: number;
}

function selectGrokHistoryPageTimeline(
  timeline: Timeline,
  input: { readonly cursor?: string; readonly limit: number },
): GrokHistoryPageTimelineSelection {
  const before =
    input.cursor === undefined
      ? timeline.orderedBackendTurnIds.length
      : parseHistoryCursor(
          input.cursor,
          timeline.cursorFingerprints,
          timeline.orderedBackendTurnIds.length,
        );
  if (before === 0) {
    return { selected: pickTimeline(timeline, []), start: 0 };
  }
  const earliestByCount = Math.max(0, before - input.limit);
  const bytesAt = (start: number) =>
    serializedUtf8Bytes(historyPagePayload(timeline, start, before));
  if (bytesAt(before - 1) > MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES) {
    oversizedTurn();
  }
  const start = earliestStartWithinBytes(earliestByCount, before - 1, bytesAt);
  const turnIds = timeline.orderedBackendTurnIds.slice(start, before);
  return { selected: pickTimeline(timeline, turnIds), start };
}

function projectGrokHistoryPageSelection(
  timeline: Timeline,
  selection: GrokHistoryPageTimelineSelection,
  generatedImages?: GrokGeneratedImageResolution,
  maximumSelectedBytes = MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
): BackendHistoryPagePayload {
  const { selected, start } = selection;
  try {
    // Publication is a post-validation enrichment and cannot make malformed
    // native history produce a durable artifact.
    backendHistoryPageSchema.parse({
      ...selected,
      ...(start > 0
        ? {
            previousCursor: historyCursor(
              timeline.cursorFingerprints[start]!,
              start,
            ),
          }
        : {}),
    });
    const resolved = generatedImages
      ? resolveGeneratedImages(
          selected,
          timeline.generatedImages,
          generatedImages,
          maximumSelectedBytes,
        )
      : selected;
    return backendHistoryPageSchema.parse({
      ...resolved,
      ...(start > 0
        ? {
            previousCursor: historyCursor(
              timeline.cursorFingerprints[start]!,
              start,
            ),
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof GrokNormalizedHistoryError) throw error;
    throw new GrokNormalizedHistoryError(
      "grok_normalized_history_invalid",
      error,
    );
  }
}

export function inspectGrokNormalizedHistory(
  records: readonly GrokHistoryRecord[],
  submissionCorrelation: GrokSubmissionCorrelationScope,
  applicationOperationId: string,
  expectedPromptId?: string,
): GrokNormalizedHistoryEvidence {
  const timeline = buildTimeline(records, submissionCorrelation);
  const finalTurnId = timeline.orderedBackendTurnIds.at(-1);
  const runState =
    finalTurnId && timeline.turnsById[finalTurnId]?.status === "in_progress"
      ? "running"
      : "idle";
  const matchingTurns = timeline.orderedBackendTurnIds.flatMap((turnId) => {
    const turn = timeline.turnsById[turnId]!;
    return turn.completionCorrelations?.includes(applicationOperationId) &&
      (expectedPromptId === undefined ||
        timeline.promptIdByBackendTurnId.get(turnId) === expectedPromptId)
      ? [turn]
      : [];
  });
  const userTextDigestByBackendTurnId = Object.fromEntries(
    matchingTurns.flatMap((turn) => {
      const digest =
        timeline.exactUserTextDigestByBackendTurnId[turn.backendTurnId];
      return digest === undefined ? [] : [[turn.backendTurnId, digest]];
    }),
  );
  return Object.freeze({
    transcriptFingerprint: timeline.semanticFingerprint,
    runState,
    matchingTurns: Object.freeze(matchingTurns),
    userTextDigestByBackendTurnId: Object.freeze(userTextDigestByBackendTurnId),
  });
}

function buildTimeline(
  records: readonly GrokHistoryRecord[],
  submissionCorrelation?: GrokSubmissionCorrelationScope,
): Timeline {
  const mutableTurns = new Map<string, MutableTurn>();
  const orderedTurnKeys: string[] = [];
  const seenRecordIds = new Set<string>();
  const closedTurnKeys = new Set<string>();
  let currentTurnKey: string | undefined;
  let transcriptSessionId: string | undefined;
  let transcriptNativeNamespaceKey: string | undefined;
  for (const record of records) {
    const promptId = record.identity.promptId;
    if (
      (promptId !== undefined &&
        (promptId.length < 1 || promptId.length > 1_024)) ||
      (promptId === undefined && record.kind !== "user_text") ||
      (record.kind === "turn_completed" &&
        record.completedAtMs !== undefined &&
        (!Number.isSafeInteger(record.completedAtMs) ||
          record.completedAtMs < 0 ||
          record.completedAtMs > MAXIMUM_DATE_MILLISECONDS)) ||
      seenRecordIds.has(record.id)
    ) {
      invalid();
    }
    transcriptSessionId ??= record.sessionId;
    transcriptNativeNamespaceKey ??= record.identity.nativeNamespaceKey;
    if (
      record.sessionId !== transcriptSessionId ||
      record.identity.nativeNamespaceKey !== transcriptNativeNamespaceKey
    ) {
      invalid();
    }
    seenRecordIds.add(record.id);
    // Grok replay can end with user chunks that have no prompt correlation.
    // Preserve exactly that final contiguous run as one uncorrelated active
    // turn, keyed by its first durable block identity. No later prompt may be
    // attached to it without a reviewed provider correlation.
    const currentTurn =
      currentTurnKey === undefined
        ? undefined
        : mutableTurns.get(currentTurnKey);
    const turnKey =
      promptId !== undefined
        ? JSON.stringify(["prompt", promptId])
        : currentTurn?.promptId === undefined
          ? (currentTurnKey ??
            JSON.stringify(["unassigned-user", record.identity.blockId]))
          : JSON.stringify(["unassigned-user", record.identity.blockId]);
    if (currentTurnKey === undefined) {
      currentTurnKey = turnKey;
    } else if (currentTurnKey !== turnKey) {
      const previousTurn = mutableTurns.get(currentTurnKey);
      if (
        !previousTurn ||
        closedTurnKeys.has(turnKey) ||
        mutableTurns.has(turnKey)
      ) {
        invalid();
      }
      if (!previousTurn.terminal) {
        // A process can disappear after Grok durably records an authenticated
        // Sedes prompt but before it records turn_completed. On a later
        // authoritative replay, a following durable user prompt proves that
        // this specific turn is no longer active. Infer interruption only at
        // that exact boundary; live traffic, a native/unscoped prompt, or a
        // non-user transition remains contradictory.
        if (
          previousTurn.applicationOperationId === undefined ||
          !previousTurn.replayOnly ||
          record.kind !== "user_text" ||
          !record.replay
        ) {
          invalid();
        }
        previousTurn.inferredInterrupted = true;
      }
      // A cancelled replay may carry one or more same-prompt reasoning blocks
      // after its terminal (handled below). A different prompt is a real next
      // turn only when its durable user run starts; do not reinterpret
      // cross-prompt reasoning or other late traffic as that boundary.
      if (
        previousTurn.terminal?.stopReason === "cancelled" &&
        record.kind !== "user_text"
      ) {
        invalid();
      }
      closedTurnKeys.add(currentTurnKey);
      currentTurnKey = turnKey;
    }
    let turn = mutableTurns.get(turnKey);
    if (!turn) {
      const correlation =
        promptId === undefined
          ? { type: "non_sedes" as const }
          : inspectGrokSubmissionPromptId(promptId, submissionCorrelation);
      if (correlation.type === "malformed" || correlation.type === "forged") {
        invalid();
      }
      turn = {
        turnKey,
        ...(promptId === undefined ? {} : { promptId }),
        backendTurnId: stableId("grok-turn", [
          record.identity.nativeNamespaceKey,
          record.sessionId,
          promptId ?? ["unassigned-user", record.identity.blockId],
        ]),
        ...(correlation.type === "authenticated"
          ? { applicationOperationId: correlation.applicationOperationId }
          : {}),
        replayOnly: record.replay,
        orderedBackendItemIds: [],
        blocks: new Map(),
      };
      mutableTurns.set(turnKey, turn);
      orderedTurnKeys.push(turnKey);
    } else {
      turn.replayOnly &&= record.replay;
    }
    // A provider turn terminal is final status evidence, not an ordering
    // fence for the native event journal. Grok can persist or deliver a
    // delayed assistant, reasoning, collaboration, user echo, or tool record
    // for the same prompt after its terminal. Keep that contiguous evidence
    // in the terminal turn; a different prompt remains the real boundary and
    // a second terminal remains contradictory.
    if (turn.terminal && record.kind === "turn_completed") {
      invalid();
    }
    if (record.kind === "turn_completed") {
      turn.terminal = record;
      continue;
    }
    const prior = turn.blocks.get(record.identity.blockId);
    if (prior) {
      if (prior.kind !== record.kind) invalid();
      if (prior.kind === "collaboration") {
        if (
          record.kind !== "collaboration" ||
          prior.activityId !== record.activityId
        ) {
          invalid();
        }
        prior.status = record.status;
        prior.action = record.action;
        prior.agentLabel = record.agentLabel;
        prior.summary = record.summary;
        prior.error = record.error;
      } else if (prior.kind === "plan") {
        if (
          record.kind !== "plan" ||
          prior.replacement.planId !== record.replacement.planId ||
          prior.backendItemId !== record.replacement.backendItemId
        ) {
          invalid();
        }
        prior.replacement = record.replacement;
      } else if (prior.kind === "tool") {
        if (record.kind !== "tool" || prior.toolCallId !== record.toolCallId) {
          invalid();
        }
        invokeToolProjection(() => applyGrokToolPatch(prior, record.patch));
      } else if (prior.kind === "omission") {
        continue;
      } else {
        if (
          record.kind === "collaboration" ||
          record.kind === "plan" ||
          record.kind === "tool" ||
          record.kind === "omission"
        )
          invalid();
        prior.text = record.kind === "reasoning"
          ? appendGrokBoundedText(prior.text, record.text)
          : preserveMessageText(prior.text.text + record.text.text);
        prior.exactTextDigest = record.exactTextDigest;
      }
      continue;
    }
    if (turn.orderedBackendItemIds.length >= MAXIMUM_BACKEND_ITEMS_PER_TURN) {
      throw new GrokNormalizedHistoryError("grok_normalized_history_too_large");
    }
    const backendItemId = grokNormalizedItemId(record);
    turn.orderedBackendItemIds.push(backendItemId);
    turn.blocks.set(
      record.identity.blockId,
      record.kind === "collaboration"
        ? {
            kind: record.kind,
            backendItemId,
            sourceOrder: turn.orderedBackendItemIds.length - 1,
            activityId: record.activityId,
            status: record.status,
            action: record.action,
            agentLabel: record.agentLabel,
            summary: record.summary,
            error: record.error,
          }
        : record.kind === "plan"
          ? {
              kind: record.kind,
              backendItemId,
              sourceOrder: turn.orderedBackendItemIds.length - 1,
              replacement: record.replacement,
            }
          : record.kind === "tool"
            ? invokeToolProjection(() =>
                createGrokToolBlock(
                  backendItemId,
                  turn.orderedBackendItemIds.length - 1,
                  record.toolCallId,
                  record.patch,
                ),
              )
            : record.kind === "omission"
              ? {
                  kind: record.kind,
                  backendItemId,
                  sourceOrder: turn.orderedBackendItemIds.length - 1,
                }
              : {
                  kind: record.kind,
                  backendItemId,
                  sourceOrder: turn.orderedBackendItemIds.length - 1,
                  text: record.text,
                  exactTextDigest: record.exactTextDigest,
                },
    );
  }

  const turnsById: Record<string, BackendTurn> = Object.create(null);
  const itemsById: Record<string, BackendItem> = Object.create(null);
  const exactUserTextDigestByBackendTurnId: Record<string, string> =
    Object.create(null);
  const exactTextDigestByBackendItemId: Record<string, string> =
    Object.create(null);
  const orderedBackendTurnIds: string[] = [];
  const generatedImages: TimelineGeneratedImage[] = [];
  for (const turnKey of orderedTurnKeys) {
    const turn = mutableTurns.get(turnKey)!;
    const stopReason =
      turn.terminal?.stopReason ??
      (turn.inferredInterrupted ? "cancelled" : undefined);
    const visibleBlocks = [...turn.blocks.values()].filter(
      (block) =>
        block.kind !== "tool" ||
        invokeToolProjection(() =>
          prepareGrokToolBlockForPublication(block, stopReason),
        ),
    );
    const hasUserText = visibleBlocks.some(
      (block) => block.kind === "user_text",
    );
    const synthesizedUserItemId =
      turn.applicationOperationId !== undefined && !hasUserText
        ? stableId("grok-item", [turn.backendTurnId, "delivery-input"])
        : undefined;
    const orderedBackendItemIds = synthesizedUserItemId
      ? [
          synthesizedUserItemId,
          ...visibleBlocks.map((block) => block.backendItemId),
        ]
      : visibleBlocks.map((block) => block.backendItemId);
    if (orderedBackendItemIds.length > MAXIMUM_BACKEND_ITEMS_PER_TURN) {
      oversizedTurn();
    }
    const sourceOrderOffset = synthesizedUserItemId ? 1 : 0;
    const terminal = terminalState(stopReason);
    const generatedImageFileNames = new Set(
      [...turn.blocks.values()].flatMap((block) => {
        if (block.kind !== "tool") return [];
        const output = inspectGrokGeneratedImageOutput(block);
        return output ? [output.fileName] : [];
      }),
    );
    orderedBackendTurnIds.push(turn.backendTurnId);
    turnsById[turn.backendTurnId] = {
      backendTurnId: turn.backendTurnId,
      ...(turn.applicationOperationId
        ? { completionCorrelations: [turn.applicationOperationId] }
        : {}),
      status: terminal.status,
      ...(terminal.endedBy ? { endedBy: terminal.endedBy } : {}),
      ...(turn.terminal?.completedAtMs !== undefined
        ? { completedAt: new Date(turn.terminal.completedAtMs).toISOString() }
        : {}),
      orderedBackendItemIds,
    };
    const exactUserMessages = visibleBlocks.flatMap((block) =>
      block.kind === "user_text" ? [block.exactTextDigest] : [],
    );
    if (exactUserMessages.length === 1) {
      exactUserTextDigestByBackendTurnId[turn.backendTurnId] =
        exactUserMessages[0]!;
    }
    if (synthesizedUserItemId) {
      itemsById[synthesizedUserItemId] = {
        backendItemId: synthesizedUserItemId,
        backendTurnId: turn.backendTurnId,
        status: "completed",
        sourceOrder: 0,
        semanticKind: "user_message",
        deliveryOperationId: turn.applicationOperationId!,
        content: [{ kind: "text", text: preserveMessageText("") }],
      };
    }
    for (const [visibleBlockIndex, block] of visibleBlocks.entries()) {
      const streaming =
        stopReason === undefined &&
        block.kind !== "user_text" &&
        visibleBlockIndex + sourceOrderOffset ===
          orderedBackendItemIds.length - 1;
      const common = {
        backendItemId: block.backendItemId,
        backendTurnId: turn.backendTurnId,
        status: streaming ? ("streaming" as const) : ("completed" as const),
        sourceOrder: block.sourceOrder + sourceOrderOffset,
      };
      itemsById[block.backendItemId] =
        block.kind === "omission"
          ? {
              ...common,
              status: "completed",
              semanticKind: "notice",
              tone: "info",
              text: boundText(
                "Additional provider activity was omitted from this turn.",
              ),
            }
          : block.kind === "collaboration"
            ? {
                ...common,
                status: block.status,
                semanticKind: "collaboration",
                action: block.action,
                ...(block.agentLabel ? { agentLabel: block.agentLabel } : {}),
                ...(block.summary ? { summary: block.summary } : {}),
                ...(block.error ? { error: block.error } : {}),
              }
            : block.kind === "plan"
              ? {
                  ...common,
                  status:
                    stopReason === undefined
                      ? ("streaming" as const)
                      : ("completed" as const),
                  semanticKind: "plan",
                  entries:
                    stopReason === undefined
                      ? [...block.replacement.entries]
                      : [
                          ...settleGrokAcpPlanAtTerminal(block.replacement)
                            .entries,
                        ],
                }
              : block.kind === "tool"
                ? invokeToolProjection(() =>
                    projectGrokToolBlock(
                      block,
                      turn.backendTurnId,
                      stopReason,
                      block.sourceOrder + sourceOrderOffset,
                    ),
                  )
                : block.kind === "user_text"
                  ? {
                      ...common,
                      semanticKind: "user_message",
                      ...(turn.applicationOperationId
                        ? { deliveryOperationId: turn.applicationOperationId }
                        : {}),
                      content: [{ kind: "text", text: preserveMessageText(block.text.text) }],
                    }
                  : block.kind === "assistant_text"
                    ? {
                        ...common,
                        semanticKind: "assistant_message",
                        markdown: preserveMessageText(
                          removeGrokGeneratedImageMarkdownReferences(
                            block.text.text,
                            generatedImageFileNames,
                          ),
                        ),
                      }
                    : {
                        ...common,
                        semanticKind: "reasoning",
                        markdown: block.text,
                      };
      if (
        block.kind === "user_text" ||
        block.kind === "assistant_text" ||
        block.kind === "reasoning"
      ) {
        exactTextDigestByBackendItemId[block.backendItemId] =
          block.exactTextDigest;
      }
      if (block.kind === "tool") {
        const candidate = inspectGrokGeneratedImageCandidate(
          block,
          turn.promptId,
        );
        if (candidate) {
          generatedImages.push(
            Object.freeze({
              toolBackendItemId: block.backendItemId,
              imageBackendItemId: stableId("grok-item", [
                transcriptNativeNamespaceKey,
                transcriptSessionId,
                candidate.promptId,
                candidate.toolCallId,
                "generated-image",
              ]),
              backendTurnId: turn.backendTurnId,
              candidate,
            }),
          );
        }
      }
    }
  }
  const cursorHash = createHash("sha256").update(
    // Opaque durable history format domain; preserve its original bytes.
    "harness.grok.normalized-history.cursor.v2\n",
  );
  const cursorFingerprints = [
    cursorHash.copy().digest("base64url").slice(0, 32),
  ];
  for (const backendTurnId of orderedBackendTurnIds) {
    const turn = turnsById[backendTurnId]!;
    cursorHash.update(
      JSON.stringify({
        backendTurnId,
        turn,
        items: turn.orderedBackendItemIds.map((itemId) => ({
          item: itemsById[itemId],
          exactTextDigest: exactTextDigestByBackendItemId[itemId],
        })),
      }),
    );
    cursorFingerprints.push(cursorHash.copy().digest("base64url").slice(0, 32));
  }
  const semanticFingerprint = createHash("sha256")
    // Retry anchors persist this fingerprint, so a product rename must not
    // invalidate otherwise identical authoritative history.
    .update("harness.grok.normalized-history.semantic.v2\n")
    .update(
      JSON.stringify({
        orderedBackendTurnIds,
        turnsById,
        itemsById,
        exactUserTextDigestsByBackendTurnId: exactUserTextDigestByBackendTurnId,
        exactTextDigestByBackendItemId,
      }),
    )
    .digest("base64url");
  return Object.freeze({
    orderedBackendTurnIds: Object.freeze(orderedBackendTurnIds),
    turnsById: Object.freeze(turnsById),
    itemsById: Object.freeze(itemsById),
    cursorFingerprints: Object.freeze(cursorFingerprints),
    semanticFingerprint,
    exactUserTextDigestByBackendTurnId: Object.freeze(
      exactUserTextDigestByBackendTurnId,
    ),
    exactTextDigestByBackendItemId: Object.freeze(
      exactTextDigestByBackendItemId,
    ),
    generatedImages: Object.freeze(generatedImages),
    promptIdByBackendTurnId: new Map(
      orderedTurnKeys.flatMap((turnKey) => {
        const turn = mutableTurns.get(turnKey)!;
        return turn.promptId === undefined
          ? []
          : [[turn.backendTurnId, turn.promptId] as const];
      }),
    ),
  });
}

function invokeToolProjection<T>(project: () => T): T {
  try {
    return project();
  } catch (error) {
    if (error instanceof GrokToolProjectionError) invalid();
    throw error;
  }
}

function appendGrokBoundedText(
  prior: BoundedText,
  delta: BoundedText,
): BoundedText {
  if (prior.truncation) return prior;
  return boundText(prior.text + delta.text);
}

type TimelineSelection = Pick<
  BackendConversationSnapshot,
  "orderedBackendTurnIds" | "turnsById" | "itemsById"
>;

const PROVISIONAL_GROK_ARTIFACT: OutputImageArtifactDescriptor = Object.freeze({
  artifactId: "00000000-0000-4000-8000-000000000000",
  mediaType: "image/jpeg",
  byteSize: 16 * 1_024 * 1_024,
  sha256: "f".repeat(64),
});

function resolveGeneratedImages(
  selected: TimelineSelection,
  candidates: readonly TimelineGeneratedImage[],
  resolution: GrokGeneratedImageResolution,
  maximumSelectedBytes = MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
): TimelineSelection {
  const selectedCandidates = candidates.filter(
    ({ toolBackendItemId }) =>
      selected.itemsById[toolBackendItemId] !== undefined,
  );
  if (selectedCandidates.length === 0) return selected;

  const provisional = insertGeneratedImages(
    selected,
    selectedCandidates,
    (candidate) =>
      generatedImageItem(
        PROVISIONAL_GROK_ARTIFACT,
        candidate.candidate.fileName,
      ),
  );
  if (serializedUtf8Bytes(provisional) > maximumSelectedBytes) {
    const omitted = insertGeneratedImages(selected, selectedCandidates, () =>
      omittedGeneratedImageItem("unavailable"),
    );
    return serializedUtf8Bytes(omitted) <= maximumSelectedBytes
      ? omitted
      : selected;
  }

  const resolved = new Map<string, BackendItem>();
  for (const candidate of selectedCandidates) {
    const publicationKey = grokGeneratedImagePublicationKey(
      candidate.candidate,
    );
    const outcome = resolution.get(publicationKey);
    if (outcome?.kind === "published") {
      resolved.set(
        candidate.imageBackendItemId,
        generatedImageItem(outcome.descriptor, candidate.candidate.fileName),
      );
    } else {
      resolved.set(
        candidate.imageBackendItemId,
        omittedGeneratedImageItem(outcome?.reason ?? "unavailable"),
      );
    }
  }
  return insertGeneratedImages(
    selected,
    selectedCandidates,
    ({ imageBackendItemId }) =>
      resolved.get(imageBackendItemId) ??
      omittedGeneratedImageItem("unavailable"),
  );
}

export async function projectGrokLatestHistoryWithGeneratedImages(
  records: readonly GrokHistoryRecord[],
  submissionCorrelation: GrokSubmissionCorrelationScope | undefined,
  context: GrokGeneratedImageProjectionContext,
  signal?: AbortSignal,
): Promise<{
  readonly snapshot: BackendConversationSnapshot;
  readonly previousCursor?: string;
}> {
  const timeline = buildTimeline(records, submissionCorrelation);
  const selection = selectGrokLatestTimeline(timeline);
  const base = projectGrokLatestSelection(timeline, selection);
  const resolution = await publishSelectedGrokGeneratedImages(
    timeline,
    new Set(Object.keys(base.snapshot.itemsById)),
    context,
    signal,
  );
  throwIfProjectionAborted(signal);
  return projectGrokLatestSelection(timeline, selection, resolution);
}

export async function projectSelectedGrokLatestHistoryWithGeneratedImages(
  records: readonly GrokHistoryRecord[],
  providerHistory: GrokProviderHistoryCursorSelection,
  submissionCorrelation: GrokSubmissionCorrelationScope | undefined,
  context: GrokGeneratedImageProjectionContext,
  signal?: AbortSignal,
): Promise<{
  readonly snapshot: BackendConversationSnapshot;
  readonly previousCursor?: string;
}> {
  const timeline = buildTimeline(records, submissionCorrelation);
  const selection = selectGrokLatestTimeline(timeline);
  const base = projectGrokLatestSelection(timeline, selection);
  const resolution = await publishSelectedGrokGeneratedImages(
    timeline,
    new Set(Object.keys(base.snapshot.itemsById)),
    context,
    signal,
  );
  throwIfProjectionAborted(signal);
  const projected = projectGrokLatestSelection(timeline, selection, resolution);
  const previousCursor = selectedProviderPreviousCursor(
    timeline,
    selection.selected,
    selection.start,
    providerHistory,
  );
  return Object.freeze({
    snapshot: projected.snapshot,
    ...(previousCursor ? { previousCursor } : {}),
  });
}

export async function projectGrokHistoryPageWithGeneratedImages(
  records: readonly GrokHistoryRecord[],
  input: { readonly cursor?: string; readonly limit: number },
  submissionCorrelation: GrokSubmissionCorrelationScope | undefined,
  context: GrokGeneratedImageProjectionContext,
): Promise<BackendHistoryPagePayload> {
  validateHistoryPageInput(input);
  const timeline = buildTimeline(records, submissionCorrelation);
  const selection = selectGrokHistoryPageTimeline(timeline, input);
  const base = projectGrokHistoryPageSelection(timeline, selection);
  const resolution = await publishSelectedGrokGeneratedImages(
    timeline,
    new Set(Object.keys(base.itemsById)),
    context,
  );
  return projectGrokHistoryPageSelection(timeline, selection, resolution);
}

export async function projectSelectedGrokHistoryPageWithGeneratedImages(
  records: readonly GrokHistoryRecord[],
  input: {
    readonly limit: number;
  } & GrokProviderHistoryCursorSelection,
  submissionCorrelation: GrokSubmissionCorrelationScope | undefined,
  context: GrokGeneratedImageProjectionContext,
  signal?: AbortSignal,
): Promise<BackendHistoryPagePayload> {
  validateHistoryPageInput({ limit: input.limit });
  const timeline = buildTimeline(records, submissionCorrelation);
  const selection = selectGrokProviderHistoryPageTimeline(timeline, input);
  const base = projectGrokHistoryPageSelection(timeline, selection);
  const resolution = await publishSelectedGrokGeneratedImages(
    timeline,
    new Set(Object.keys(base.itemsById)),
    context,
    signal,
  );
  throwIfProjectionAborted(signal);
  const projected = projectGrokHistoryPageSelection(
    timeline,
    selection,
    resolution,
    maximumSelectedBytesForCursor(
      selectedProviderPreviousCursor(
        timeline,
        selection.selected,
        selection.start,
        input,
      ),
    ),
  );
  const selectedPreviousCursor = selectedProviderPreviousCursor(
    timeline,
    selection.selected,
    selection.start,
    input,
  );
  const { previousCursor: _localCursor, ...providerPage } = projected;
  return backendHistoryPageSchema.parse({
    ...providerPage,
    ...(selectedPreviousCursor
      ? { previousCursor: selectedPreviousCursor }
      : {}),
  });
}

export async function locateGrokHistoryTurnWithGeneratedImages(
  records: readonly GrokHistoryRecord[],
  input: {
    readonly matchesBackendTurnId: (backendTurnId: string) => boolean;
    readonly maximumTurnCandidates: number;
  },
  submissionCorrelation: GrokSubmissionCorrelationScope | undefined,
  context: GrokGeneratedImageProjectionContext,
  signal?: AbortSignal,
): Promise<{
  readonly page?: BackendHistoryPagePayload;
  readonly inspectedTurnCount: number;
  readonly retainedTurnCount: number;
}> {
  const timeline = buildTimeline(records, submissionCorrelation);
  const inspectedTurnCount = Math.min(
    input.maximumTurnCandidates,
    timeline.orderedBackendTurnIds.length,
  );
  const oldestInspectedIndex =
    timeline.orderedBackendTurnIds.length - inspectedTurnCount;
  for (
    let index = timeline.orderedBackendTurnIds.length - 1;
    index >= oldestInspectedIndex;
    index -= 1
  ) {
    throwIfProjectionAborted(signal);
    const backendTurnId = timeline.orderedBackendTurnIds[index]!;
    if (!input.matchesBackendTurnId(backendTurnId)) continue;
    const selection = {
      selected: pickTimeline(timeline, [backendTurnId]),
      start: 0,
    };
    const base = projectGrokHistoryPageSelection(timeline, selection);
    const resolution = await publishSelectedGrokGeneratedImages(
      timeline,
      new Set(Object.keys(base.itemsById)),
      context,
      signal,
    );
    throwIfProjectionAborted(signal);
    return Object.freeze({
      page: projectGrokHistoryPageSelection(timeline, selection, resolution),
      inspectedTurnCount,
      retainedTurnCount: timeline.orderedBackendTurnIds.length,
    });
  }
  return Object.freeze({
    inspectedTurnCount,
    retainedTurnCount: timeline.orderedBackendTurnIds.length,
  });
}

function selectGrokProviderHistoryPageTimeline(
  timeline: Timeline,
  input: { readonly limit: number } & GrokProviderHistoryCursorSelection,
): GrokHistoryPageTimelineSelection {
  const before = timeline.orderedBackendTurnIds.length;
  if (before === 0) {
    return { selected: pickTimeline(timeline, []), start: 0 };
  }
  const earliestByCount = Math.max(0, before - input.limit);
  const bytesAt = (start: number) => {
    const selected = pickTimeline(
      timeline,
      timeline.orderedBackendTurnIds.slice(start, before),
    );
    const previousCursor = selectedProviderPreviousCursor(
      timeline,
      selected,
      start,
      input,
    );
    return serializedUtf8Bytes({
      ...selected,
      ...(previousCursor ? { previousCursor } : {}),
    });
  };
  if (bytesAt(before - 1) > MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES) {
    oversizedTurn();
  }
  const start = earliestStartWithinBytes(earliestByCount, before - 1, bytesAt);
  return {
    selected: pickTimeline(
      timeline,
      timeline.orderedBackendTurnIds.slice(start, before),
    ),
    start,
  };
}

function selectedProviderPreviousCursor(
  timeline: Timeline,
  selected: SelectedTimeline,
  start: number,
  providerHistory: GrokProviderHistoryCursorSelection,
): string | undefined {
  const oldestTurnId = selected.orderedBackendTurnIds[0];
  if (oldestTurnId === undefined) return undefined;
  const oldestPromptId = timeline.promptIdByBackendTurnId.get(oldestTurnId);
  const cursor = oldestPromptId
    ? providerHistory.previousCursorByPromptId[oldestPromptId]
    : undefined;
  if (cursor !== undefined) return cursor;
  if (start === 0) return providerHistory.previousCursor;
  if (cursor === undefined) invalidCursor();
}

function maximumSelectedBytesForCursor(cursor: string | undefined): number {
  if (cursor === undefined) return MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES;
  const propertyBytes = serializedUtf8Bytes({ previousCursor: cursor }) - 1;
  return MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES - propertyBytes;
}

async function publishSelectedGrokGeneratedImages(
  timeline: Timeline,
  selectedItemIds: ReadonlySet<string>,
  context: GrokGeneratedImageProjectionContext,
  signal?: AbortSignal,
): Promise<GrokGeneratedImageResolution> {
  const resolution = new Map<
    string,
    | {
        readonly kind: "published";
        readonly descriptor: OutputImageArtifactDescriptor;
      }
    | {
        readonly kind: "omitted";
        readonly reason: "byte_limit" | "invalid_data" | "unavailable";
      }
  >();
  throwIfProjectionAborted(signal);
  for (const candidate of timeline.generatedImages) {
    throwIfProjectionAborted(signal);
    if (!selectedItemIds.has(candidate.toolBackendItemId)) continue;
    const publicationKey = grokGeneratedImagePublicationKey(
      candidate.candidate,
    );
    try {
      const existing = context.outputArtifacts.findImage(
        context.scope,
        context.applicationThreadId,
        publicationKey,
      );
      const decoded = await waitForProjectionOperation(
        () => readGrokGeneratedImage(candidate.candidate, context.authority),
        signal,
      );
      if (decoded.type === "unavailable") {
        if (existing && decoded.reason === "unavailable") {
          resolution.set(publicationKey, {
            kind: "published",
            descriptor: existing,
          });
          continue;
        }
        resolution.set(publicationKey, {
          kind: "omitted",
          reason: decoded.reason,
        });
        continue;
      }
      const descriptor = await waitForProjectionOperation(
        () =>
          context.outputArtifacts.publishImage({
            scope: context.scope,
            threadId: context.applicationThreadId,
            publicationKey,
            mediaType: decoded.image.mediaType,
            bytes: decoded.image.bytes,
            expectedByteSize: decoded.image.byteSize,
            expectedSha256: decoded.image.sha256,
          }),
        signal,
      );
      assertPublishedImageMatches(descriptor, decoded.image);
      resolution.set(publicationKey, { kind: "published", descriptor });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      resolution.set(publicationKey, {
        kind: "omitted",
        reason:
          error instanceof DomainError && error.code === "invalid_transition"
            ? "invalid_data"
            : "unavailable",
      });
    }
  }
  return resolution;
}

async function waitForProjectionOperation<T>(
  start: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return await start();
  throwIfProjectionAborted(signal);
  const operation = start();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function throwIfProjectionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

function insertGeneratedImages(
  selected: TimelineSelection,
  candidates: readonly TimelineGeneratedImage[],
  imageFor: (candidate: TimelineGeneratedImage) => BackendItem,
): TimelineSelection {
  const byToolId = new Map(
    candidates.map((candidate) => [candidate.toolBackendItemId, candidate]),
  );
  const turnsById: Record<string, BackendTurn> = Object.create(null);
  const itemsById: Record<string, BackendItem> = Object.create(null);
  for (const turnId of selected.orderedBackendTurnIds) {
    const turn = selected.turnsById[turnId]!;
    const orderedBackendItemIds: string[] = [];
    for (const itemId of turn.orderedBackendItemIds) {
      const item = selected.itemsById[itemId]!;
      itemsById[itemId] = {
        ...item,
        sourceOrder: orderedBackendItemIds.length,
      } as BackendItem;
      orderedBackendItemIds.push(itemId);
      const candidate = byToolId.get(itemId);
      if (!candidate) continue;
      itemsById[candidate.imageBackendItemId] = {
        ...imageFor(candidate),
        backendItemId: candidate.imageBackendItemId,
        backendTurnId: candidate.backendTurnId,
        sourceOrder: orderedBackendItemIds.length,
      } as BackendItem;
      orderedBackendItemIds.push(candidate.imageBackendItemId);
    }
    turnsById[turnId] = { ...turn, orderedBackendItemIds };
  }
  return {
    orderedBackendTurnIds: [...selected.orderedBackendTurnIds],
    turnsById,
    itemsById,
  };
}

function generatedImageItem(
  descriptor: OutputImageArtifactDescriptor,
  fileName: string,
): BackendItem {
  return {
    backendItemId: "provisional",
    backendTurnId: "provisional",
    sourceOrder: 0,
    status: "completed",
    semanticKind: "image",
    image: {
      representation: "artifact",
      artifactId: descriptor.artifactId,
      mimeType: descriptor.mediaType,
      byteSize: descriptor.byteSize,
      sha256: descriptor.sha256,
      alt: boundDisplayText("Generated image"),
      fileName: boundDisplayText(fileName),
    },
  };
}

function omittedGeneratedImageItem(
  reason: "byte_limit" | "invalid_data" | "unavailable",
): BackendItem {
  return {
    backendItemId: "provisional",
    backendTurnId: "provisional",
    sourceOrder: 0,
    status: "completed",
    semanticKind: "image",
    image: {
      representation: "omitted",
      mimeType: "image/jpeg",
      alt: boundDisplayText("Generated image unavailable"),
      reason,
    },
  };
}

function assertPublishedImageMatches(
  descriptor: OutputImageArtifactDescriptor,
  image: {
    readonly mediaType: "image/jpeg";
    readonly byteSize: number;
    readonly sha256: string;
  },
): void {
  if (
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(
      descriptor.artifactId,
    ) ||
    descriptor.mediaType !== image.mediaType ||
    descriptor.byteSize !== image.byteSize ||
    descriptor.sha256 !== image.sha256
  ) {
    throw new DomainError(
      "invalid_transition",
      "The published Grok image descriptor did not match its bytes.",
    );
  }
}

function pickTimeline(
  timeline: Timeline,
  turnIds: readonly string[],
): SelectedTimeline {
  const turnsById = Object.fromEntries(
    turnIds.map((turnId) => [turnId, timeline.turnsById[turnId]!]),
  );
  const itemIds = turnIds.flatMap(
    (turnId) => turnsById[turnId]!.orderedBackendItemIds,
  );
  const selected = {
    orderedBackendTurnIds: [...turnIds],
    turnsById,
    itemsById: Object.fromEntries(
      itemIds.map((itemId) => [itemId, timeline.itemsById[itemId]!]),
    ),
  };
  return selected;
}

function historyPagePayload(
  timeline: Timeline,
  start: number,
  before: number,
): BackendHistoryPagePayload {
  const selected = pickTimeline(
    timeline,
    timeline.orderedBackendTurnIds.slice(start, before),
  );
  return {
    ...selected,
    ...(start > 0
      ? {
          previousCursor: historyCursor(
            timeline.cursorFingerprints[start]!,
            start,
          ),
        }
      : {}),
  };
}

function earliestStartWithinBytes(
  earliest: number,
  latest: number,
  bytesAt: (start: number) => number,
): number {
  let lower = earliest;
  let upper = latest;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (bytesAt(middle) <= MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES) {
      upper = middle;
    } else {
      lower = middle + 1;
    }
  }
  return lower;
}

function oversizedTurn(): never {
  throw new GrokNormalizedHistoryError("grok_normalized_history_too_large");
}

function terminalState(stopReason: string | undefined): {
  readonly status: "in_progress" | "completed" | "interrupted";
  readonly endedBy?: "agent_settled" | "interrupted";
} {
  // Exactly one final contiguous prompt may lack a durable terminal. It is
  // represented as active, never inferred completed from load completion.
  if (stopReason === undefined) return { status: "in_progress" };
  if (stopReason === "end_turn") {
    return { status: "completed", endedBy: "agent_settled" };
  }
  if (stopReason === "cancelled") {
    return { status: "interrupted", endedBy: "interrupted" };
  }
  invalid();
}

function stableId(prefix: string, values: readonly unknown[]): string {
  return `${prefix}:${createHash("sha256")
    .update(JSON.stringify(values))
    .digest("base64url")}`;
}

function historyCursor(fingerprint: string, before: number): string {
  return `grok-history:v1:${fingerprint}:${before}`;
}

function parseHistoryCursor(
  cursor: string,
  fingerprints: readonly string[],
  maximum: number,
): number {
  if (Buffer.byteLength(cursor) > MAXIMUM_CURSOR_BYTES) invalidCursor();
  const match = /^grok-history:v1:([A-Za-z0-9_-]{32}):(\d+)$/u.exec(cursor);
  const before = match ? Number(match[2]) : Number.NaN;
  if (
    !match ||
    !Number.isSafeInteger(before) ||
    before < 1 ||
    before > maximum ||
    match[1] !== fingerprints[before]
  ) {
    invalidCursor();
  }
  return before;
}

function invalid(): never {
  throw new GrokNormalizedHistoryError("grok_normalized_history_invalid");
}

function invalidCursor(): never {
  throw new GrokNormalizedHistoryError(
    "grok_normalized_history_cursor_invalid",
  );
}
