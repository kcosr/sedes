import { turnFailure } from "../turn-failure.js";
import { createHash } from "node:crypto";
import type {
  BackendConversationSnapshot,
  BackendItem,
  BackendTurn,
} from "../../../shared/protocol/backend.js";
import {
  backendConversationSnapshotSchema,
  backendItemSchema,
} from "../../../shared/protocol/backend.js";
import {
  MAXIMUM_REASONING_SUMMARY_PARTS,
  MAXIMUM_USER_MESSAGE_CONTENT_PARTS,
  type UsageSnapshot,
} from "../../../shared/protocol/conversation.js";
import {
  MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
  MAXIMUM_MESSAGE_ITEM_BYTES,
  PAYLOAD_LIMITS,
  serializedUtf8Bytes,
  type BoundedText,
} from "../../../shared/protocol/payload.js";
import {
  boundDisplayText,
  boundText,
  boundToolResult,
  boundValue,
  countUnifiedDiff,
  preserveMessageText,
} from "../../conversations/payload-policy.js";
import {
  CODEX_C1_MAX_ITEMS_PER_TURN,
  codexAsyncQuestionsFromAgentMessage,
  projectCodexThread,
  refineCodexThreadTokenUsage,
  type CodexThread,
  type CodexThreadItem,
  type CodexThreadTokenUsage,
  type CodexTurn,
} from "./codex-c1-protocol.js";
import {
  inspectCodexForkContextBoundaryHookRunId,
  inspectCodexSubmissionCorrelation,
  type CodexSubmissionCorrelationScope,
} from "./codex-submission-correlation.js";
import { inspectCodexContextExcerptCarrier } from "./codex-context-excerpts.js";
import { inspectCodexTaskContextCarrier } from "./codex-task-contexts.js";
import { inspectStagedAttachmentManifest } from "../staged-attachment-manifest.js";
import { USER_FORK_CONTEXT_BOUNDARY_TEXT } from "../fork-context-boundary.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../provider-protocol/transport/framed-message-limits.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { DomainError } from "../../domain/errors.js";
import type {
  OutputArtifactPublisher,
  OutputImageArtifactDescriptor,
} from "../../output-artifacts/contracts.js";
import {
  CODEX_MAXIMUM_GENERATED_IMAGE_BYTES,
  decodeCodexGeneratedImage,
  type DecodedCodexGeneratedImage,
} from "./codex-generated-image.js";

export type CodexHistoryProjectionErrorCode =
  "codex_history_invalid" | "codex_history_incomplete" | "history_too_large" |
  "codex_message_payload_too_large";

export class CodexHistoryProjectionError extends Error {
  readonly code: CodexHistoryProjectionErrorCode;

  constructor(code: CodexHistoryProjectionErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "CodexHistoryProjectionError";
    this.code = code;
  }
}

export interface CodexHistoryProjection {
  readonly snapshot: BackendConversationSnapshot;
  readonly serializedSnapshotBytes: number;
  readonly projectedItemCount: number;
  readonly nativeThreadId: string;
  readonly backendTurnIdByNativeId: ReadonlyMap<string, string>;
  readonly projectedItemByNativeCoordinate: ReadonlyMap<
    string,
    CodexProjectedItemCoordinate
  >;
  readonly authenticatedForkContextBoundaryOperationIds: ReadonlySet<string>;
  readonly authenticatedForkContextBoundaryNativeTurnIds: ReadonlySet<string>;
  /** Server-private durable enrichment intents; never part of normalized history. */
  readonly pendingGeneratedImages: readonly DeferredCodexGeneratedImagePublication[];
}

export interface CodexProjectedItemCoordinate {
  readonly nativeTurnId: string;
  readonly nativeItemId: string;
  readonly nativeOrdinal: number;
  readonly itemType: CodexThreadItem["type"];
  readonly backendTurnId: string;
  readonly sourceOrder: number;
  readonly orderedBackendItemIds: readonly string[];
}

const MAXIMUM_CODEX_REASONING_SUMMARY_BYTES = 128 * 1_024;

function projectReasoningSummaryParts(parts: readonly string[]): BoundedText[] {
  const retained = parts
    .filter((part) => part.length > 0)
    .slice(0, MAXIMUM_REASONING_SUMMARY_PARTS);
  if (retained.length === 0) return [];
  const maximumPartBytes = Math.max(
    3,
    Math.min(
      PAYLOAD_LIMITS.textCharacters,
      Math.floor(MAXIMUM_CODEX_REASONING_SUMMARY_BYTES / retained.length),
    ),
  );
  return retained.map((part) => boundText(part, maximumPartBytes));
}

export function codexNativeItemCoordinate(
  nativeTurnId: string,
  nativeItemId: string,
): string {
  return `${nativeTurnId}\0${nativeItemId}`;
}

function generatedImageItem(
  identity: {
    readonly backendItemId: string;
    readonly backendTurnId: string;
    readonly sourceOrder: number;
  },
  descriptor: OutputImageArtifactDescriptor,
  revisedPrompt: string | null,
): BackendItem {
  return {
    ...identity,
    ...terminalItem,
    semanticKind: "image",
    image: {
      representation: "artifact",
      artifactId: descriptor.artifactId,
      mimeType: descriptor.mediaType,
      byteSize: descriptor.byteSize,
      sha256: descriptor.sha256,
      alt: boundDisplayText(revisedPrompt ?? "Generated image"),
      fileName: boundDisplayText("generated-image.png"),
    },
  };
}

function omittedGeneratedImageItem(
  identity: {
    readonly backendItemId: string;
    readonly backendTurnId: string;
    readonly sourceOrder: number;
  },
  reason: "byte_limit" | "invalid_data" | "unavailable",
): BackendItem {
  return {
    ...identity,
    ...terminalItem,
    semanticKind: "image",
    image: {
      representation: "omitted",
      mimeType: "image/png",
      alt: boundDisplayText("Generated image unavailable"),
      reason,
    },
  };
}

export interface CodexForkContextBoundaryInspection {
  readonly operationIds: ReadonlySet<string>;
  readonly nativeTurnIds: ReadonlySet<string>;
}

export function inspectCodexForkContextBoundaries(
  thread: CodexThread,
  correlationScope: CodexSubmissionCorrelationScope,
): CodexForkContextBoundaryInspection {
  const authenticatedOperationIds = new Set<string>();
  const authenticatedNativeTurnIds = new Set<string>();
  const nativeTurnIds = new Set<string>();
  for (const turn of thread.turns) {
    if (nativeTurnIds.has(turn.id)) {
      throw new CodexHistoryProjectionError("codex_history_invalid");
    }
    nativeTurnIds.add(turn.id);
    const boundary = inspectAuthenticatedBoundaryItems(turn, correlationScope);
    for (const operationId of boundary.operationIds) {
      if (authenticatedOperationIds.has(operationId)) {
        throw new CodexHistoryProjectionError("codex_history_invalid");
      }
      authenticatedOperationIds.add(operationId);
    }
    if (boundary.boundaryOnly) authenticatedNativeTurnIds.add(turn.id);
  }
  return {
    operationIds: authenticatedOperationIds,
    nativeTurnIds: authenticatedNativeTurnIds,
  };
}

export type CodexStreamingNativeItems = ReadonlyMap<
  string,
  ReadonlySet<string>
>;

export interface CodexGeneratedImageProjectionContext {
  readonly scope: RequestScope;
  readonly applicationThreadId: string;
  readonly outputArtifacts: OutputArtifactPublisher;
  /** Successful publications verified within this exact handle/read pass. */
  readonly verifiedPublicationKeys: Set<string>;
}

export interface DeferredCodexGeneratedImagePublication {
  readonly identity: {
    readonly backendItemId: string;
    readonly backendTurnId: string;
    readonly sourceOrder: number;
  };
  readonly publicationKey: string;
  readonly revisedPrompt: string | null;
  readonly nativeItem: Extract<
    CodexThreadItem,
    { readonly type: "imageGeneration" }
  >;
}

const PROVISIONAL_OUTPUT_ARTIFACT_ID = "00000000-0000-4000-8000-000000000000";

function assertPublishedImageMatches(
  descriptor: OutputImageArtifactDescriptor,
  image: DecodedCodexGeneratedImage,
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
      "The published Codex image descriptor did not match its bytes.",
    );
  }
}

async function resolveGeneratedImagePublications(
  snapshot: BackendConversationSnapshot,
  pending: readonly DeferredCodexGeneratedImagePublication[],
  context: CodexGeneratedImageProjectionContext,
): Promise<BackendConversationSnapshot> {
  if (pending.length === 0) return snapshot;
  const itemsById = { ...snapshot.itemsById };
  for (const publication of pending) {
    let replacement: BackendItem;
    try {
      const decoded = decodeCodexGeneratedImage(
        publication.nativeItem,
        CODEX_MAXIMUM_GENERATED_IMAGE_BYTES,
      );
      if (decoded.type === "unavailable") {
        replacement = backendItemSchema.parse(
          omittedGeneratedImageItem(
            publication.identity,
            decoded.reason === "too_large" ? "byte_limit" : "invalid_data",
          ),
        );
        itemsById[publication.identity.backendItemId] = replacement;
        continue;
      }
      const published = await context.outputArtifacts.publishImage({
        scope: context.scope,
        threadId: context.applicationThreadId,
        publicationKey: publication.publicationKey,
        mediaType: decoded.image.mediaType,
        bytes: decoded.image.bytes,
        expectedByteSize: decoded.image.byteSize,
        expectedSha256: decoded.image.sha256,
      });
      assertPublishedImageMatches(published, decoded.image);
      replacement = backendItemSchema.parse(
        generatedImageItem(
          publication.identity,
          published,
          publication.revisedPrompt,
        ),
      );
      context.verifiedPublicationKeys.add(publication.publicationKey);
    } catch (error) {
      replacement = backendItemSchema.parse(
        omittedGeneratedImageItem(
          publication.identity,
          error instanceof DomainError && error.code === "invalid_transition"
            ? "invalid_data"
            : "unavailable",
        ),
      );
    }
    // The pure planning pass validated an artifact item with the production
    // UUID width, maximum legal byte count, and fixed-width digest. Exact
    // async enrichment therefore cannot enlarge the accepted snapshot beyond
    // its proven budget.
    itemsById[publication.identity.backendItemId] = replacement;
  }
  return { ...snapshot, itemsById };
}

function omitPendingGeneratedImages(
  snapshot: BackendConversationSnapshot,
  pending: readonly DeferredCodexGeneratedImagePublication[],
): BackendConversationSnapshot {
  if (pending.length === 0) return snapshot;
  const itemsById = { ...snapshot.itemsById };
  for (const publication of pending) {
    itemsById[publication.identity.backendItemId] = backendItemSchema.parse({
      ...publication.identity,
      ...terminalItem,
      semanticKind: "image",
      image: { representation: "omitted", reason: "unavailable" },
    });
  }
  return { ...snapshot, itemsById };
}

export async function materializeCodexGeneratedImagePublications(
  projection: CodexHistoryProjection,
  context: CodexGeneratedImageProjectionContext,
): Promise<CodexHistoryProjection> {
  if (projection.pendingGeneratedImages.length === 0) return projection;
  const snapshot = await resolveGeneratedImagePublications(
    projection.snapshot,
    projection.pendingGeneratedImages,
    context,
  );
  return Object.freeze({
    ...projection,
    snapshot,
    serializedSnapshotBytes: serializedUtf8Bytes(snapshot),
    pendingGeneratedImages: Object.freeze([]),
  });
}

const terminalItem = Object.freeze({
  status: "completed" as const,
});

type CodexCollabAgentToolCall = Extract<
  CodexThreadItem,
  { readonly type: "collabAgentToolCall" }
>;
type PublicCodexCollabAgentToolCall = CodexCollabAgentToolCall & {
  readonly tool: Exclude<
    CodexCollabAgentToolCall["tool"],
    "sendMessage" | "followupTask" | "interruptAgent" | "listAgents"
  >;
};

const collaborationToolSummaries = {
  spawnAgent: {
    inProgress: "Starting agent",
    completed: "Spawned agent",
    failed: "Agent spawn failed",
    interrupted: "Agent spawn interrupted",
  },
  sendInput: {
    inProgress: "Sending input to agent",
    completed: "Sent input to agent",
    failed: "Sending input failed",
    interrupted: "Sending input interrupted",
  },
  resumeAgent: {
    inProgress: "Resuming agent",
    completed: "Resumed agent",
    failed: "Agent resume failed",
    interrupted: "Agent resume interrupted",
  },
  closeAgent: {
    inProgress: "Closing agent",
    completed: "Closed agent",
    failed: "Closing agent failed",
    interrupted: "Closing agent interrupted",
  },
} as const satisfies Record<
  Exclude<PublicCodexCollabAgentToolCall["tool"], "wait">,
  Record<CodexCollabAgentToolCall["status"], string>
>;

function isPublicCollaborationTool(
  item: CodexCollabAgentToolCall,
): item is PublicCodexCollabAgentToolCall {
  return (
    item.tool !== "sendMessage" &&
    item.tool !== "followupTask" &&
    item.tool !== "interruptAgent" &&
    item.tool !== "listAgents"
  );
}

function collaborationToolSummary(
  item: PublicCodexCollabAgentToolCall,
): string {
  if (item.tool !== "wait") {
    return collaborationToolSummaries[item.tool][item.status];
  }
  if (item.status === "completed") return "Finished waiting";
  if (item.status === "failed") return "Waiting for agents failed";
  if (item.status === "interrupted") return "Waiting for agents interrupted";
  const targetCount = item.receiverThreadIds.length;
  return targetCount === 0
    ? "Waiting for agents"
    : targetCount === 1
      ? "Waiting for agent"
      : `Waiting for ${targetCount} agents`;
}

function subAgentActivitySummary(
  item: Extract<CodexThreadItem, { readonly type: "subAgentActivity" }>,
): string {
  const prefix =
    item.kind === "started"
      ? "Started"
      : item.kind === "interacted"
        ? "Interacted with"
        : item.kind === "completed"
          ? "Completed"
          : "Interrupted";
  // The native field is generously bounded, while this is deliberately one
  // quiet display line. Reserve room for the longest prefix and delimiters.
  const agentPath = boundText(
    item.agentPath.trim().replace(/\s+/gu, " ") || "agent",
    4_000,
  ).text;
  return `${prefix} \`${agentPath}\``;
}

export function projectCodexHistory(
  value: CodexThread,
  correlationScope: CodexSubmissionCorrelationScope,
  streamingNativeItems: CodexStreamingNativeItems,
  generatedImages: CodexGeneratedImageProjectionContext,
): CodexHistoryProjection {
  let thread: CodexThread;
  const rawNativeHistoryBytes = serializedUtf8Bytes(value);
  try {
    if (rawNativeHistoryBytes > MAXIMUM_PROVIDER_FRAME_BYTES) {
      throw new CodexHistoryProjectionError("history_too_large");
    }
    preflightPerTurnItemCounts(value);
    thread = projectCodexThread(value);
  } catch (error) {
    if (error instanceof CodexHistoryProjectionError) throw error;
    throw new CodexHistoryProjectionError("codex_history_invalid", error);
  }
  if (thread.turns.some(({ itemsView }) => itemsView !== "full")) {
    throw new CodexHistoryProjectionError("codex_history_incomplete");
  }
  if (
    correlationScope.toolProvenanceKey.byteLength !== 32 ||
    correlationScope.tenantId.length === 0 ||
    correlationScope.principalId.length === 0 ||
    correlationScope.backendInstanceId.length === 0 ||
    correlationScope.nativeThreadId !== thread.id ||
    correlationScope.correlationAncestorThreadIds.length > 100 ||
    correlationScope.correlationAncestorThreadIds.includes(thread.id) ||
    new Set(correlationScope.correlationAncestorThreadIds).size !==
      correlationScope.correlationAncestorThreadIds.length
  ) {
    throw new CodexHistoryProjectionError("codex_history_invalid");
  }
  const orderedBackendTurnIds: string[] = [];
  const turnsById: Record<string, BackendTurn> = {};
  const itemsById: Record<string, BackendItem> = {};
  const turnIds = new Set<string>();
  const itemCoordinates = new Set<string>();
  const authenticatedOperationIds = new Set<string>();
  const authenticatedForkContextBoundaryOperationIds = new Set<string>();
  const authenticatedForkContextBoundaryNativeTurnIds = new Set<string>();
  const backendTurnIdByNativeId = new Map<string, string>();
  const projectedItemByNativeCoordinate = new Map<
    string,
    CodexProjectedItemCoordinate
  >();
  const pendingGeneratedImages: DeferredCodexGeneratedImagePublication[] = [];
  let projectedItemCount = 0;

  for (const turn of thread.turns) {
    if (turnIds.has(turn.id)) {
      throw new CodexHistoryProjectionError("codex_history_invalid");
    }
    turnIds.add(turn.id);
    const boundary = inspectAuthenticatedBoundaryItems(turn, correlationScope);
    if (boundary.operationIds.length > 0) {
      for (const boundaryOperationId of boundary.operationIds) {
        if (
          authenticatedForkContextBoundaryOperationIds.has(boundaryOperationId)
        ) {
          throw new CodexHistoryProjectionError("codex_history_invalid");
        }
        authenticatedForkContextBoundaryOperationIds.add(boundaryOperationId);
      }
    }
    if (boundary.boundaryOnly) {
      authenticatedForkContextBoundaryNativeTurnIds.add(turn.id);
      continue;
    }
    const backendTurnId = codexBackendTurnId(thread.id, turn.id);
    backendTurnIdByNativeId.set(turn.id, backendTurnId);
    orderedBackendTurnIds.push(backendTurnId);
    const orderedBackendItemIds: string[] = [];
    const completionCorrelations: string[] = [];
    let sourceOrder = 0;
    for (const [nativeItemOrdinal, item] of turn.items.entries()) {
      if (boundary.itemOrdinals.has(nativeItemOrdinal)) continue;
      let authenticatedClientUserMessageId: string | undefined;
      let authenticatedApplicationOperationId: string | undefined;
      if (item.type === "userMessage") {
        const correlation = inspectCodexSubmissionCorrelation(
          item.clientId,
          correlationScope,
        );
        if (correlation.type === "malformed" || correlation.type === "forged") {
          throw new CodexHistoryProjectionError("codex_history_invalid");
        }
        if (correlation.type === "authenticated") {
          authenticatedClientUserMessageId = item.clientId ?? undefined;
          authenticatedApplicationOperationId =
            correlation.applicationOperationId;
          if (
            authenticatedOperationIds.has(correlation.applicationOperationId)
          ) {
            throw new CodexHistoryProjectionError("codex_history_invalid");
          }
          authenticatedOperationIds.add(correlation.applicationOperationId);
          completionCorrelations.push(correlation.applicationOperationId);
        }
      }
      const coordinate = codexNativeItemCoordinate(turn.id, item.id);
      if (itemCoordinates.has(coordinate)) {
        throw new CodexHistoryProjectionError("codex_history_invalid");
      }
      itemCoordinates.add(coordinate);
      const projected = projectCodexItemSlice(
        thread.id,
        turn,
        item,
        backendTurnId,
        nativeItemOrdinal,
        sourceOrder,
        streamingNativeItems.get(turn.id)?.has(item.id) ?? false,
        correlationScope,
        authenticatedClientUserMessageId,
        authenticatedApplicationOperationId,
        generatedImages,
        pendingGeneratedImages,
      );
      sourceOrder += projected.length;
      projectedItemCount += projected.length;
      if (sourceOrder > CODEX_C1_MAX_ITEMS_PER_TURN) {
        throw new CodexHistoryProjectionError("history_too_large");
      }
      for (const backendItem of projected) {
        if (
          (backendItem.semanticKind === "assistant_message" ||
            backendItem.semanticKind === "user_message") &&
          serializedUtf8Bytes(backendItem) > MAXIMUM_MESSAGE_ITEM_BYTES
        ) {
          throw new CodexHistoryProjectionError("codex_message_payload_too_large");
        }
        if (itemsById[backendItem.backendItemId]) {
          throw new CodexHistoryProjectionError("codex_history_invalid");
        }
        orderedBackendItemIds.push(backendItem.backendItemId);
        itemsById[backendItem.backendItemId] = backendItem;
      }
      projectedItemByNativeCoordinate.set(coordinate, {
        nativeTurnId: turn.id,
        nativeItemId: item.id,
        nativeOrdinal: nativeItemOrdinal,
        itemType: item.type,
        backendTurnId,
        sourceOrder: sourceOrder - projected.length,
        orderedBackendItemIds: projected.map(
          ({ backendItemId }) => backendItemId,
        ),
      });
    }
    turnsById[backendTurnId] = projectCodexTurnFromSlices(
      turn,
      backendTurnId,
      orderedBackendItemIds,
      completionCorrelations,
    );
  }

  const activeTurns = thread.turns.filter(
    ({ status }) => status === "inProgress",
  );
  const liveTurn = thread.turns.at(-1);
  if (
    activeTurns.length > 1 ||
    (activeTurns.length === 1 &&
      (thread.status.type !== "active" || liveTurn?.status !== "inProgress"))
  ) {
    throw new CodexHistoryProjectionError("codex_history_invalid");
  }
  const activeNativeTurn = activeTurns[0];
  const candidate: BackendConversationSnapshot = {
    orderedBackendTurnIds,
    turnsById,
    itemsById,
    runState: projectRunState(thread),
    ...(activeNativeTurn
      ? {
          activeBackendTurnId: backendTurnIdByNativeId.get(
            activeNativeTurn.id,
          )!,
        }
      : {}),
  };
  const provisionalSnapshotBytes = serializedUtf8Bytes(candidate);
  if (provisionalSnapshotBytes > MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES) {
    throw new CodexHistoryProjectionError("history_too_large");
  }
  try {
    const validatedCandidate =
      backendConversationSnapshotSchema.parse(candidate);
    const snapshot = omitPendingGeneratedImages(
      validatedCandidate,
      pendingGeneratedImages,
    );
    const serializedSnapshotBytes = serializedUtf8Bytes(snapshot);
    return Object.freeze({
      snapshot,
      serializedSnapshotBytes,
      projectedItemCount,
      nativeThreadId: thread.id,
      backendTurnIdByNativeId,
      projectedItemByNativeCoordinate,
      authenticatedForkContextBoundaryOperationIds,
      authenticatedForkContextBoundaryNativeTurnIds,
      pendingGeneratedImages: Object.freeze(pendingGeneratedImages),
    });
  } catch (error) {
    if (error instanceof CodexHistoryProjectionError) throw error;
    throw new CodexHistoryProjectionError("codex_history_invalid", error);
  }
}

function inspectAuthenticatedBoundaryItems(
  turn: CodexTurn,
  correlationScope: CodexSubmissionCorrelationScope,
): {
  readonly operationIds: readonly string[];
  readonly itemOrdinals: ReadonlySet<number>;
  readonly boundaryOnly: boolean;
} {
  const authenticatedOperationIds: string[] = [];
  const boundaryItemOrdinals = new Set<number>();
  for (const [itemOrdinal, item] of turn.items.entries()) {
    if (item.type !== "hookPrompt") continue;
    const itemOperationIds: string[] = [];
    for (const fragment of item.fragments) {
      const inspection = inspectCodexForkContextBoundaryHookRunId(
        fragment.hookRunId,
        correlationScope,
      );
      if (inspection.type === "malformed" || inspection.type === "forged") {
        throw new CodexHistoryProjectionError("codex_history_invalid");
      }
      if (inspection.type === "authenticated") {
        if (fragment.text !== USER_FORK_CONTEXT_BOUNDARY_TEXT) {
          throw new CodexHistoryProjectionError("codex_history_invalid");
        }
        itemOperationIds.push(inspection.applicationOperationId);
      }
    }
    if (itemOperationIds.length === 0) continue;
    if (
      itemOperationIds.length !== item.fragments.length ||
      new Set(itemOperationIds).size !== itemOperationIds.length
    ) {
      throw new CodexHistoryProjectionError("codex_history_invalid");
    }
    boundaryItemOrdinals.add(itemOrdinal);
    authenticatedOperationIds.push(...itemOperationIds);
  }
  if (
    new Set(authenticatedOperationIds).size !== authenticatedOperationIds.length
  ) {
    throw new CodexHistoryProjectionError("codex_history_invalid");
  }
  return {
    operationIds: authenticatedOperationIds,
    itemOrdinals: boundaryItemOrdinals,
    boundaryOnly:
      boundaryItemOrdinals.size > 0 &&
      boundaryItemOrdinals.size === turn.items.length,
  };
}

function preflightPerTurnItemCounts(value: unknown): void {
  if (typeof value !== "object" || value === null || !("turns" in value))
    return;
  const turns = (value as { readonly turns?: unknown }).turns;
  if (!Array.isArray(turns)) return;
  for (const turn of turns) {
    if (typeof turn !== "object" || turn === null || !("items" in turn))
      continue;
    const items = (turn as { readonly items?: unknown }).items;
    if (Array.isArray(items) && items.length > CODEX_C1_MAX_ITEMS_PER_TURN) {
      throw new CodexHistoryProjectionError("history_too_large");
    }
  }
}

/**
 * Select at most `visibleLimit` normalized turns ending at one native turn
 * boundary. Authenticated fork-boundary-only turns remain in the private
 * slice so their evidence is validated and projected away, but do not consume
 * the visible page limit.
 */
export function selectCodexNativeHistorySlice(
  thread: CodexThread,
  correlationScope: CodexSubmissionCorrelationScope,
  beforeNativeTurnIndex: number,
  visibleLimit: number,
): { readonly startNativeTurnIndex: number; readonly thread: CodexThread } {
  if (
    !Number.isSafeInteger(beforeNativeTurnIndex) ||
    beforeNativeTurnIndex < 0 ||
    beforeNativeTurnIndex > thread.turns.length ||
    !Number.isSafeInteger(visibleLimit) ||
    visibleLimit <= 0
  ) {
    throw new CodexHistoryProjectionError("codex_history_invalid");
  }
  let startNativeTurnIndex = beforeNativeTurnIndex;
  let visibleTurns = 0;
  while (startNativeTurnIndex > 0 && visibleTurns < visibleLimit) {
    startNativeTurnIndex -= 1;
    if (
      !inspectAuthenticatedBoundaryItems(
        thread.turns[startNativeTurnIndex]!,
        correlationScope,
      ).boundaryOnly
    ) {
      visibleTurns += 1;
    }
  }
  // Carry an immediately preceding hidden-only stretch with this page. The
  // opaque cursor then always advances to a boundary before visible history;
  // callers never receive an empty page merely to traverse private boundary
  // evidence.
  while (
    startNativeTurnIndex > 0 &&
    inspectAuthenticatedBoundaryItems(
      thread.turns[startNativeTurnIndex - 1]!,
      correlationScope,
    ).boundaryOnly
  ) {
    startNativeTurnIndex -= 1;
  }
  const includesNativeTail = beforeNativeTurnIndex === thread.turns.length;
  return {
    startNativeTurnIndex,
    thread: {
      ...thread,
      ...(!includesNativeTail ? { status: { type: "idle" as const } } : {}),
      turns: thread.turns.slice(startNativeTurnIndex, beforeNativeTurnIndex),
    },
  };
}

export function codexNativeHistoryVisibleTurnCount(
  thread: CodexThread,
  correlationScope: CodexSubmissionCorrelationScope,
): number {
  return thread.turns.reduce(
    (count, turn) =>
      count +
      (inspectAuthenticatedBoundaryItems(turn, correlationScope).boundaryOnly
        ? 0
        : 1),
    0,
  );
}

export function projectCodexUsage(value: CodexThreadTokenUsage): UsageSnapshot {
  const usage = refineCodexThreadTokenUsage(value);
  const context =
    usage.modelContextWindow === null || usage.modelContextWindow === 0
      ? undefined
      : {
          usedTokens: usage.last.totalTokens,
          windowTokens: usage.modelContextWindow,
          percent: (usage.last.totalTokens / usage.modelContextWindow) * 100,
        };
  return {
    ...(context ? { context } : {}),
    tokens: {
      input: usage.total.inputTokens,
      output: usage.total.outputTokens,
      cacheRead: usage.total.cachedInputTokens,
      cacheWrite: usage.total.cacheWriteInputTokens,
      total: usage.total.totalTokens,
    },
  };
}

function projectRunState(
  thread: CodexThread,
): BackendConversationSnapshot["runState"] {
  switch (thread.status.type) {
    case "notLoaded":
    case "idle":
      return thread.turns.at(-1)?.status === "failed" ? "failed" : "idle";
    case "systemError":
      return "failed";
    case "active":
      return "running";
  }
}

export function projectCodexTurnFromSlices(
  turn: CodexTurn,
  backendTurnId: string,
  orderedBackendItemIds: readonly string[],
  completionCorrelations: readonly string[],
): BackendTurn {
  const identity = {
    backendTurnId,
    ...(completionCorrelations.length > 0
      ? { completionCorrelations: [...completionCorrelations] }
      : {}),
  };
  const timestamps = {
    ...(turn.startedAt === null
      ? {}
      : { startedAt: epochSeconds(turn.startedAt) }),
    ...(turn.completedAt === null
      ? {}
      : { completedAt: epochSeconds(turn.completedAt) }),
  };
  switch (turn.status) {
    case "inProgress":
      return {
        ...identity,
        status: "in_progress",
        orderedBackendItemIds: [...orderedBackendItemIds],
        ...timestamps,
      };
    case "completed":
      return {
        ...identity,
        status: "completed",
        endedBy: "agent_settled",
        orderedBackendItemIds: [...orderedBackendItemIds],
        ...timestamps,
      };
    case "interrupted":
      return {
        ...identity,
        status: "interrupted",
        endedBy: "interrupted",
        orderedBackendItemIds: [...orderedBackendItemIds],
        ...timestamps,
      };
    case "failed":
      return {
        ...identity,
        status: "failed",
        endedBy: "failed",
        failure: turnFailure(turn.error?.message),
        orderedBackendItemIds: [...orderedBackendItemIds],
        ...timestamps,
      };
  }
}

export function projectCodexItemSlice(
  threadId: string,
  turn: CodexTurn,
  item: CodexThreadItem,
  backendTurnId: string,
  nativeItemOrdinal: number,
  sourceOrder: number,
  streaming: boolean,
  correlationScope: CodexSubmissionCorrelationScope,
  authenticatedClientUserMessageId: string | undefined,
  authenticatedApplicationOperationId: string | undefined,
  generatedImages: CodexGeneratedImageProjectionContext,
  pendingGeneratedImages: DeferredCodexGeneratedImagePublication[],
): readonly BackendItem[] {
  const base = (subkey = "item", offset = 0) => ({
    // Stable 0.153.0 may rewrite native item IDs when a live turn is persisted.
    // Turn-local semantic coordinates remain ordered and are therefore the
    // durable normalized identity across live projection and reattach.
    backendItemId: hashedId(
      "item",
      threadId,
      turn.id,
      String(nativeItemOrdinal),
      item.type,
      subkey,
    ),
    backendTurnId,
    sourceOrder: sourceOrder + offset,
  });
  switch (item.type) {
    case "userMessage":
      return [
        {
          ...base(),
          ...terminalItem,
          semanticKind: "user_message",
          ...(authenticatedApplicationOperationId
            ? {
                deliveryOperationId: authenticatedApplicationOperationId,
              }
            : {}),
          content: projectUserContent(
            item.content,
            correlationScope,
            authenticatedClientUserMessageId,
          ),
        },
      ];
    case "hookPrompt":
      return [
        notice(
          base(),
          "Codex hook supplied additional instructions.",
          "neutral",
        ),
      ];
    case "agentMessage": {
      const asyncQuestions = codexAsyncQuestionsFromAgentMessage(item);
      return [
        {
          ...base(),
          ...(streaming ? { status: "streaming" as const } : terminalItem),
          semanticKind: "assistant_message",
          responsePhase:
            item.phase === "final_answer"
              ? "final"
              : item.phase === "commentary"
                ? "provisional"
                : "unclassified",
          markdown: preserveCodexMessageText(item.text),
          ...(asyncQuestions ? { nonblockingQuestions: asyncQuestions } : {}),
        },
      ];
    }
    case "functionCallOutput":
      // Standalone tool-authority output is model context rather than an
      // independently meaningful Sedes timeline action. Admit it so native
      // history remains readable, but keep its provider content private.
      return [];
    case "plan":
      return [
        {
          ...base(),
          ...(streaming ? { status: "streaming" as const } : terminalItem),
          semanticKind: "plan",
          entries: [
            {
              id: hashedId(
                "plan-entry",
                threadId,
                turn.id,
                String(nativeItemOrdinal),
              ),
              text: boundDisplayText(item.text),
              status: streaming ? "in_progress" : "completed",
            },
          ],
        },
      ];
    case "reasoning": {
      const summaryParts = projectReasoningSummaryParts(item.summary);
      return [
        {
          ...base(),
          ...(streaming ? { status: "streaming" as const } : terminalItem),
          semanticKind: "reasoning",
          ...(summaryParts.length > 0 ? { summaryParts } : {}),
          markdown: boundText(item.content.filter(Boolean).join("\n\n")),
        },
      ];
    }
    case "commandExecution":
      return [projectCommand(base(), item)];
    case "fileChange":
      return projectFileChanges(base, item);
    case "mcpToolCall":
      return [projectMcp(base(), item)];
    case "dynamicToolCall":
      return [projectDynamicTool(base(), item)];
    case "collabAgentToolCall":
      if (!isPublicCollaborationTool(item)) return [];
      return [
        {
          ...base(),
          ...terminalItem,
          semanticKind: "collaboration",
          action:
            item.tool === "spawnAgent"
              ? "spawn"
              : item.tool === "sendInput"
                ? "message"
                : "status",
          summary: boundDisplayText(collaborationToolSummary(item)),
        },
      ];
    case "subAgentActivity":
      return [
        {
          ...base(),
          ...terminalItem,
          semanticKind: "collaboration",
          action:
            item.kind === "started"
              ? "spawn"
              : item.kind === "interacted"
                ? "message"
                : "status",
          summary: boundDisplayText(subAgentActivitySummary(item)),
        },
      ];
    case "webSearch":
      return [
        {
          ...base(),
          ...terminalItem,
          semanticKind: "web_search",
          phase: "completed",
          query: boundDisplayText(item.query || searchActionQuery(item)),
          result: boundToolResult(
            {
              content: [],
              details: { resultCount: item.results?.length ?? 0 },
            },
            false,
          ),
        },
      ];
    case "imageView":
      return [notice(base(), "Codex viewed a local image.", "neutral")];
    case "sleep":
      return [
        {
          ...base(),
          ...terminalItem,
          semanticKind: "tool",
          phase: "completed",
          toolName: boundDisplayText("clock.sleep"),
          title: boundDisplayText("Sleep"),
          category: "other",
          arguments: boundValue({ durationMs: item.durationMs }),
        },
      ];
    case "imageGeneration": {
      const state =
        item.status === "in_progress"
          ? operationState("inProgress", item.result.length > 0)
          : item.status === "failed"
            ? operationState("failed", item.result.length > 0)
            : operationState("completed", item.result.length > 0);
      const tool: BackendItem = {
        ...base(),
        semanticKind: "tool",
        ...state,
        toolName: boundDisplayText("image_generation"),
        title: boundDisplayText("Image generation"),
        category: "other",
        ...(item.revisedPrompt === null
          ? {}
          : {
              arguments: boundValue({
                revisedPrompt: item.revisedPrompt,
              }),
            }),
        result: boundToolResult(
          state.status === "completed"
            ? "Codex generated an image."
            : "Codex did not generate an image.",
          state.status === "failed",
        ),
        ...(state.status === "failed"
          ? {
              error: {
                category: "internal" as const,
                message: boundDisplayText("Codex image generation failed."),
                code: "codex_image_generation_failed",
              },
            }
          : {}),
      };
      if (streaming || item.status !== "completed") return [tool];

      const imageIdentity = base("image", 1);
      const publicationKey = imageIdentity.backendItemId;
      try {
        if (generatedImages.verifiedPublicationKeys.has(publicationKey)) {
          const existing = generatedImages.outputArtifacts.findImage(
            generatedImages.scope,
            generatedImages.applicationThreadId,
            publicationKey,
          );
          if (existing) {
            return [
              tool,
              generatedImageItem(imageIdentity, existing, item.revisedPrompt),
            ];
          }
        }

        pendingGeneratedImages.push({
          identity: imageIdentity,
          publicationKey,
          revisedPrompt: item.revisedPrompt,
          nativeItem: item,
        });
        return [
          tool,
          generatedImageItem(
            imageIdentity,
            {
              artifactId: PROVISIONAL_OUTPUT_ARTIFACT_ID,
              mediaType: "image/png",
              byteSize: CODEX_MAXIMUM_GENERATED_IMAGE_BYTES,
              sha256: "f".repeat(64),
            },
            item.revisedPrompt,
          ),
        ];
      } catch (error) {
        // A generated-output storage failure must not make the provider-owned
        // textual conversation unreadable. The stable omission card preserves
        // ordering and identity without exposing bytes, paths, or diagnostics.
        return [
          tool,
          omittedGeneratedImageItem(
            imageIdentity,
            error instanceof DomainError && error.code === "invalid_transition"
              ? "invalid_data"
              : "unavailable",
          ),
        ];
      }
    }
    case "enteredReviewMode":
    case "exitedReviewMode":
      return [
        {
          ...base(),
          ...terminalItem,
          semanticKind: "review_marker",
          verdict: "comment",
          label: boundDisplayText(
            item.type === "enteredReviewMode"
              ? "Review started"
              : "Review ended",
          ),
          body: boundText(item.review),
        },
      ];
    case "contextCompaction":
      return [
        {
          ...base(),
          ...(streaming ? { status: "streaming" as const } : terminalItem),
          semanticKind: "compaction",
        },
      ];
    default:
      return exhaustive(item);
  }
}

function projectUserContent(
  content: Extract<CodexThreadItem, { type: "userMessage" }>["content"],
  correlationScope: CodexSubmissionCorrelationScope,
  authenticatedClientUserMessageId: string | undefined,
): Extract<BackendItem, { semanticKind: "user_message" }>["content"] {
  type ProjectedPart = Extract<
    BackendItem,
    { semanticKind: "user_message" }
  >["content"][number];
  const projected: ProjectedPart[] = [];
  let nativeStart = 0;
  let stagedNativeImages = 0;
  let taskCarrierConsumed = false;
  const leadingPart = content[nativeStart];
  if (leadingPart?.type === "skill") {
    projected.push(projectCodexUserInputPart(leadingPart));
    nativeStart += 1;
  }
  while (content[nativeStart]?.type === "text") {
    const first = content[nativeStart] as Extract<
      (typeof content)[number],
      { type: "text" }
    >;
    const unauthenticatedLegacyTaskCarrier =
      !authenticatedClientUserMessageId &&
      first.text.startsWith("<harness-task-contexts");
    const taskCarrier = authenticatedClientUserMessageId
      ? inspectCodexTaskContextCarrier(first.text, {
          toolProvenanceKey: correlationScope.toolProvenanceKey,
          clientUserMessageId: authenticatedClientUserMessageId,
        })
      : first.text.startsWith("<sedes-task-contexts") ||
          unauthenticatedLegacyTaskCarrier
        ? ({ type: "invalid" } as const)
        : ({ type: "non_carrier" } as const);
    if (taskCarrier.type === "authenticated") {
      if (taskCarrierConsumed) break;
      projected.push(
        ...taskCarrier.taskContexts.map((task) => ({
          kind: "task_context" as const,
          task,
        })),
      );
      taskCarrierConsumed = true;
      nativeStart += 1;
      continue;
    }
    if (taskCarrier.type === "invalid" && unauthenticatedLegacyTaskCarrier) {
      // Exact pre-rename carrier framing contains application metadata, not
      // provider-owned user text. Without its authenticated client identity,
      // fail closed rather than exposing the historical carrier bytes.
      nativeStart += 1;
      continue;
    }
    const attachmentManifest = authenticatedClientUserMessageId
      ? inspectStagedAttachmentManifest(
          first.text,
          {
            key: correlationScope.toolProvenanceKey,
            correlation: authenticatedClientUserMessageId,
          },
          { acceptLegacyHarness: true },
        )
      : first.text.startsWith("<sedes-staged-attachments") ||
          first.text.startsWith("<harness-staged-attachments")
        ? ({ type: "invalid" } as const)
        : ({ type: "non_manifest" } as const);
    if (attachmentManifest.type === "authenticated") {
      projected.push(
        ...attachmentManifest.attachments.map((attachment) => ({
          kind: "attachment" as const,
          attachment,
        })),
      );
      stagedNativeImages += attachmentManifest.attachments.filter(
        ({ kind }) => kind === "image",
      ).length;
      nativeStart += 1;
      continue;
    }
    if (attachmentManifest.type === "invalid") {
      // Provider-private staging paths must never cross into browser history.
      nativeStart += 1;
      continue;
    }
    if (!authenticatedClientUserMessageId) break;
    const carrier = inspectCodexContextExcerptCarrier(first.text, {
      toolProvenanceKey: correlationScope.toolProvenanceKey,
      clientUserMessageId: authenticatedClientUserMessageId,
    });
    if (carrier.type === "authenticated") {
      projected.push(
        ...carrier.contextExcerpts.map((excerpt) => ({
          kind: "context_excerpt" as const,
          excerpt,
        })),
      );
      nativeStart += 1;
      continue;
    }
    break;
  }
  // Preserve native parts independently of the composer submission limits.
  projected.push(
    ...content
      .slice(nativeStart)
      .filter((part) => {
        if (part.type !== "localImage" || stagedNativeImages === 0) return true;
        stagedNativeImages -= 1;
        return false;
      })
      .map(projectCodexUserInputPart),
  );
  if (projected.length > MAXIMUM_USER_MESSAGE_CONTENT_PARTS) {
    throw new CodexHistoryProjectionError("codex_message_payload_too_large");
  }
  return projected.length > 0
    ? projected
    : [{ kind: "text", text: boundText("[Empty Codex user message]") }];
}

function preserveCodexMessageText(
  value: string,
): ReturnType<typeof preserveMessageText> {
  try {
    return preserveMessageText(value);
  } catch (error) {
    throw new CodexHistoryProjectionError("codex_message_payload_too_large", error);
  }
}

function projectCodexUserInputPart(
  part: Extract<CodexThreadItem, { type: "userMessage" }>["content"][number],
): Extract<BackendItem, { semanticKind: "user_message" }>["content"][number] {
  switch (part.type) {
    case "text":
      return {
        kind: "text" as const,
        text: preserveCodexMessageText(part.text),
      };
    case "image":
    case "localImage":
      return {
        kind: "image" as const,
        omitted: true as const,
        alt: boundDisplayText("Image attachment omitted"),
      };
    case "audio":
    case "localAudio":
      return {
        kind: "text" as const,
        text: boundText("[Audio attachment omitted]"),
      };
    case "skill":
      return {
        kind: "skill" as const,
        name: boundDisplayText(part.name),
      };
    case "mention":
      return {
        kind: "text" as const,
        text: boundText(`[Mention: ${part.name}]`),
      };
    default:
      return exhaustive(part);
  }
}

function projectCommand(
  base: ReturnType<
    (
      subkey?: string,
      offset?: number,
    ) => {
      backendItemId: string;
      backendTurnId: string;
      sourceOrder: number;
    }
  >,
  item: Extract<CodexThreadItem, { type: "commandExecution" }>,
): BackendItem {
  const operation = operationState(item.status, item.aggregatedOutput !== null);
  return {
    ...base,
    semanticKind: "command",
    ...operation,
    command: boundDisplayText(item.command),
    cwd: boundDisplayText(item.cwd),
    ...(item.aggregatedOutput === null
      ? {}
      : { output: boundText(item.aggregatedOutput) }),
    ...(item.exitCode === null ? {} : { exitCode: item.exitCode }),
    ...(item.durationMs === null ? {} : { durationMs: item.durationMs }),
    ...(item.status === "declined"
      ? {
          error: {
            category: "rejected",
            message: boundDisplayText("Codex command execution was declined."),
            code: "codex_command_declined",
          },
        }
      : item.status === "failed"
        ? {
            error: {
              category: "internal",
              message: boundDisplayText("Codex command execution failed."),
              code: "codex_command_failed",
            },
          }
        : {}),
  };
}

function projectFileChanges(
  base: (
    subkey?: string,
    offset?: number,
  ) => {
    backendItemId: string;
    backendTurnId: string;
    sourceOrder: number;
  },
  item: Extract<CodexThreadItem, { type: "fileChange" }>,
): readonly BackendItem[] {
  if (item.changes.length === 0) {
    return [
      notice(
        base(),
        "Codex reported a file change without file entries.",
        "warning",
      ),
    ];
  }
  return item.changes.map((change, index) => {
    const counts = countCodexFileChange(change);
    const operation = operationState(item.status, false);
    const kind = change.kind;
    return {
      ...base(`change:${index}`, index),
      semanticKind: "file_change" as const,
      ...operation,
      operation:
        kind.type === "add"
          ? ("write" as const)
          : kind.type === "delete"
            ? ("delete" as const)
            : kind.move_path === null
              ? ("edit" as const)
              : ("move" as const),
      effect:
        item.status === "inProgress"
          ? ("proposed" as const)
          : item.status === "completed"
            ? ("applied" as const)
            : item.status === "declined"
              ? ("not_applied" as const)
              : ("unknown" as const),
      path: boundDisplayText(change.path),
      ...(kind.type === "update" && kind.move_path !== null
        ? { destinationPath: boundDisplayText(kind.move_path) }
        : {}),
      diff: { text: boundText(change.diff) },
      ...counts,
      ...(item.status === "declined"
        ? {
            error: {
              category: "rejected" as const,
              message: boundDisplayText("Codex file change was declined."),
              code: "codex_file_change_declined",
            },
          }
        : item.status === "failed"
          ? {
              error: {
                category: "internal" as const,
                message: boundDisplayText("Codex file change failed."),
                code: "codex_file_change_failed",
              },
            }
          : {}),
    };
  });
}

function countCodexFileChange(
  change: Extract<CodexThreadItem, { type: "fileChange" }>["changes"][number],
): { readonly additions?: number; readonly deletions?: number } {
  if (change.diff.length === 0) return {};
  // Despite the field name, Codex sends whole-file content for Add/Delete and
  // reserves unified diffs for Update/Move.
  if (change.kind.type === "add") {
    return { additions: countRawFileLines(change.diff), deletions: 0 };
  }
  if (change.kind.type === "delete") {
    return { additions: 0, deletions: countRawFileLines(change.diff) };
  }
  const counts = countUnifiedDiff(change.diff);
  return counts.additions > 0 || counts.deletions > 0 ? counts : {};
}

function countRawFileLines(content: string): number {
  let lines = content.endsWith("\n") ? 0 : 1;
  for (const character of content) {
    if (character === "\n") lines += 1;
  }
  return lines;
}

function projectMcp(
  base: {
    backendItemId: string;
    backendTurnId: string;
    sourceOrder: number;
  },
  item: Extract<CodexThreadItem, { type: "mcpToolCall" }>,
): BackendItem {
  const operation = operationState(item.status, item.result !== null);
  const isError = item.status === "failed" || item.error !== null;
  const safeResult =
    item.error !== null
      ? {
          content: [{ type: "text", text: item.error.message }],
        }
      : item.result === null
        ? undefined
        : {
            content: item.result.content,
            ...(item.result.structuredContent === null
              ? {}
              : {
                  details: {
                    structuredContent: item.result.structuredContent,
                  },
                }),
          };
  return {
    ...base,
    semanticKind: "mcp",
    ...(isError
      ? operationState("failed", safeResult !== undefined)
      : operation),
    server: boundDisplayText(item.server),
    toolName: boundDisplayText(item.tool),
    arguments: boundValue(item.arguments),
    ...(safeResult === undefined
      ? {}
      : { result: boundToolResult(safeResult, isError) }),
    ...(item.durationMs === null ? {} : { durationMs: item.durationMs }),
    ...(isError
      ? {
          error: {
            category: "internal",
            message: boundDisplayText("Codex MCP tool call failed."),
            code: "codex_mcp_tool_failed",
          },
        }
      : {}),
  };
}

function projectDynamicTool(
  base: {
    backendItemId: string;
    backendTurnId: string;
    sourceOrder: number;
  },
  item: Extract<CodexThreadItem, { type: "dynamicToolCall" }>,
): BackendItem {
  const isError = item.status === "failed" || item.success === false;
  const content =
    item.contentItems?.map((part) =>
      part.type === "inputText"
        ? { type: "text", text: part.text }
        : {
            type: "text",
            text:
              part.type === "inputImage"
                ? "[Image output omitted]"
                : "[Audio output omitted]",
          },
    ) ?? [];
  return {
    ...base,
    semanticKind: "tool",
    ...operationState(isError ? "failed" : item.status, content.length > 0),
    toolName: boundDisplayText(item.tool),
    title: boundDisplayText(
      item.namespace === null ? item.tool : `${item.namespace}: ${item.tool}`,
    ),
    category: "other",
    arguments: boundValue(item.arguments),
    ...(content.length > 0
      ? { result: boundToolResult({ content }, isError) }
      : {}),
    ...(isError
      ? {
          error: {
            category: "internal",
            message: boundDisplayText("Codex dynamic tool call failed."),
            code: "codex_dynamic_tool_failed",
          },
        }
      : {}),
  };
}

function operationState(
  status: "inProgress" | "completed" | "failed" | "declined",
  hasResult: boolean,
): Pick<BackendItem, "status"> & {
  phase: "preflight_or_executing" | "result_streaming" | "completed" | "failed";
} {
  switch (status) {
    case "inProgress":
      return {
        status: "streaming",
        phase: hasResult ? "result_streaming" : "preflight_or_executing",
      };
    case "completed":
      return { status: "completed", phase: "completed" };
    case "failed":
    case "declined":
      return { status: "failed", phase: "failed" };
  }
}

function notice(
  base: {
    backendItemId: string;
    backendTurnId: string;
    sourceOrder: number;
  },
  text: string,
  tone: Extract<BackendItem, { semanticKind: "notice" }>["tone"],
): BackendItem {
  return {
    ...base,
    ...terminalItem,
    semanticKind: "notice",
    tone,
    text: boundText(text),
  };
}

function searchActionQuery(
  item: Extract<CodexThreadItem, { type: "webSearch" }>,
): string {
  return item.action?.type === "search"
    ? (item.action.query ?? item.action.queries?.join(", ") ?? "")
    : "";
}

function epochSeconds(value: number): string {
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.valueOf())) {
    throw new CodexHistoryProjectionError("codex_history_invalid");
  }
  return date.toISOString();
}

function hashedId(kind: string, ...parts: readonly string[]): string {
  return `codex:${kind}:${createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")}`;
}

export function codexBackendTurnId(
  nativeThreadId: string,
  nativeTurnId: string,
): string {
  return hashedId("turn", nativeThreadId, nativeTurnId);
}

function exhaustive(value: never): never {
  throw new CodexHistoryProjectionError("codex_history_invalid", {
    unsupported: value,
  });
}
