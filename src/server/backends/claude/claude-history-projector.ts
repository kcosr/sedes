import type { ClaudeTaskLifecycleReceipt } from "./claude-thread-repository.js";
import { createHash } from "node:crypto";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
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
  MAXIMUM_USER_MESSAGE_CONTENT_PARTS,
  usageSnapshotSchema,
  type UsageSnapshot,
} from "../../../shared/protocol/conversation.js";
import {
  MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
  MAXIMUM_MESSAGE_ITEM_BYTES,
  PAYLOAD_LIMITS,
  serializedUtf8Bytes,
} from "../../../shared/protocol/payload.js";
import {
  boundDisplayText,
  boundText,
  boundToolResult,
  boundValue,
  preserveMessageText,
} from "../../conversations/payload-policy.js";
import { inspectClaudeContextExcerptEnvelope } from "./claude-context-excerpts.js";
import { inspectClaudeTaskContextEnvelope } from "./claude-task-contexts.js";
import {
  inspectClaudeAttachmentEnvelope,
  isClaudeAttachmentEnvelopeText,
} from "./claude-attachment-manifest.js";
import { isClaudeSkillName } from "./claude-skill-name.js";
import type {
  ClaudeTerminalReceipt,
  ClaudeTerminalStatus,
} from "./claude-thread-repository.js";
import { USER_FORK_CONTEXT_BOUNDARY } from "../fork-context-boundary.js";
import {
  inspectClaudeForkContextBoundary,
  type ClaudeForkBoundaryAuthentication,
} from "./claude-fork-context-boundary.js";
import {
  completeClaudeTool,
  projectClaudeTool,
  settleInterruptedClaudeTool,
} from "./claude-tool-projector.js";

const LATEST_SNAPSHOT_TURNS = 10;
const MAXIMUM_CURSOR_BYTES = 512;
const MAXIMUM_PROVIDER_TOOL_NAME_BYTES = 4_096;
const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CLAUDE_MESSAGE_TIMESTAMP_SCHEMA = z.iso.datetime();

export type ClaudeHistoryProjectionErrorCode =
  | "claude_history_invalid"
  | "claude_message_payload_too_large"
  | "claude_history_session_identity_mismatch"
  | "history_too_large"
  | "claude_history_cursor_invalid"
  | "claude_history_lookup_invalid";

export class ClaudeHistoryProjectionError extends Error {
  readonly code: ClaudeHistoryProjectionErrorCode;

  constructor(code: ClaudeHistoryProjectionErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "ClaudeHistoryProjectionError";
    this.code = code;
  }
}

/** Share exact ordinary-message text and failure semantics between history and live output. */
export function preserveClaudeMessageText(value: string): { text: string } {
  try {
    return preserveMessageText(value);
  } catch (cause) {
    throw new ClaudeHistoryProjectionError("claude_message_payload_too_large", cause);
  }
}

export function assertClaudeMessageItemPayload(item: BackendItem): void {
  if (
    (item.semanticKind === "assistant_message" || item.semanticKind === "user_message") &&
    serializedUtf8Bytes(item) > MAXIMUM_MESSAGE_ITEM_BYTES
  ) {
    throw new ClaudeHistoryProjectionError("claude_message_payload_too_large");
  }
}

export interface ClaudeHistoryProjection {
  readonly snapshot: BackendConversationSnapshot;
  readonly history: {
    readonly operational: true;
    readonly previousCursor?: string;
  };
  readonly usage?: UsageSnapshot;
  /** Application operation identities accepted as main-thread user UUIDs. */
  readonly nativeUserMessageUuidByBackendTurnId: ReadonlyMap<string, string>;
  /** Main-thread tool calls in the entire supplied transcript, including older pages. */
  readonly nativeToolUseIds: ReadonlySet<string>;
  /** Last terminal assistant UUID, used only for provider receipt correlation. */
  readonly terminalAssistantUuidByBackendTurnId: ReadonlyMap<string, string>;
  /** True retained chain leaf for an exact inclusive native fork. */
  readonly terminalCheckpointUuidByBackendTurnId: ReadonlyMap<string, string>;
  readonly authenticatedForkContextBoundaryOperationIds: ReadonlySet<string>;
  readonly authenticatedTaskContextOperationIds: ReadonlySet<string>;
  /** Private live-projection window coordinates within the supplied messages. */
  readonly window: {
    readonly sourceTurnCount: number;
    readonly latestStartTurnIndex: number;
    readonly retainedStartTurnIndex: number;
    readonly retainedNativeMessageStartIndex: number;
    readonly retainedUserMessageOrdinal: number;
  };
}

export interface ClaudeHistoryPageSelection {
  readonly page: BackendHistoryPagePayload;
  readonly previousTurnIndex?: number;
}

export type ClaudeHistoryTurnLocation =
  | {
      readonly status: "found";
      readonly page: BackendHistoryPagePayload;
    }
  | { readonly status: "not_found" }
  | { readonly status: "search_limit_reached" };

export type ClaudeTerminalReceiptOverride = Pick<
  ClaudeTerminalReceipt,
  | "backendTurnId"
  | "status"
  | "providerTerminalReason"
  | "providerResultUuid"
  | "terminalAt"
>;

export interface ClaudeHistoryAuthentication {
  readonly steerOperations?: ReadonlyMap<string, string | null>;
  readonly taskLifecycleReceipts?: readonly ClaudeTaskLifecycleReceipt[];
  readonly attachmentProvenanceKey: Uint8Array;
  readonly forkBoundaryAuthentication: ClaudeForkBoundaryAuthentication;
  readonly isApplicationInputOperation?: (operationId: string) => boolean;
  readonly resolveSkillName?: (operationId: string) => string | undefined;
}

interface ParsedSessionMessage {
  readonly type: SessionMessage["type"];
  readonly uuid: string;
  readonly sessionId: string;
  readonly mainThread: boolean;
  readonly message: SessionMessage["message"];
  readonly origin?: unknown;
  /** Anthropic Messages API identity shared by streamed and durable blocks. */
  readonly assistantMessageId?: string;
  /** Explicit null means this streamed block is not a turn boundary. */
  readonly assistantStopReason?: string | null;
  /** Provider-authored transcript time; absent on older Claude emitters. */
  readonly timestamp?: string;
}

interface ProjectedTimeline {
  readonly orderedBackendTurnIds: readonly string[];
  readonly turnsById: Readonly<Record<string, BackendTurn>>;
  readonly itemsById: Readonly<Record<string, BackendItem>>;
  readonly usage?: UsageSnapshot;
  readonly nativeUserMessageUuidByBackendTurnId: ReadonlyMap<string, string>;
  /** Main-thread tool calls in the entire supplied transcript, including older pages. */
  readonly nativeToolUseIds: ReadonlySet<string>;
  readonly terminalAssistantUuidByBackendTurnId: ReadonlyMap<string, string>;
  readonly terminalCheckpointUuidByBackendTurnId: ReadonlyMap<string, string>;
  readonly authenticatedForkContextBoundaryOperationIds: ReadonlySet<string>;
  readonly authenticatedTaskContextOperationIds: ReadonlySet<string>;
  readonly fingerprint: string;
  readonly nativeMessageStartIndexByBackendTurnId: ReadonlyMap<string, number>;
  readonly userMessageOrdinalByBackendTurnId: ReadonlyMap<string, number>;
  readonly messageCount: number;
  readonly nextUserMessageOrdinal: number;
}

interface MutableTurn {
  readonly backendTurnId: string;
  readonly orderedBackendItemIds: string[];
  readonly completionCorrelations: string[];
  readonly toolItemIdByNativeId: Map<string, string>;
  readonly unresolvedToolIds: Set<string>;
  readonly taskNotificationBoundary: boolean;
  nativeUserMessageUuid?: string;
  terminalAssistantUuid?: string;
  terminalAt?: string;
  interruptedAt?: string;
  lastRetainedMessageUuid?: string;
  readonly nativeMessageStartIndex: number;
  readonly userMessageOrdinal: number;
  sourceOrder: number;
}

interface AssistantResponseGroup {
  readonly hasNativeMessageIdentity: boolean;
  readonly itemIds: string[];
  hasToolUse: boolean;
  stopReason?: string;
}

export interface ClaudeLatestProjectionCoordinates {
  readonly turnOffset: number;
  readonly userMessageOrdinalBase: number;
}

/** Project the bounded latest-ten-turn attach snapshot. */
export function projectClaudeHistory(
  value: unknown,
  terminalReceipts: readonly ClaudeTerminalReceiptOverride[] = [],
  authentication?: ClaudeHistoryAuthentication,
): ClaudeHistoryProjection {
  return projectClaudeLatestSnapshot(value, terminalReceipts, authentication);
}

/** Authenticate an SDK history response against the requested native session. */
export function assertClaudeHistorySession(
  messages: readonly SessionMessage[],
  expectedSessionId: string,
): void {
  if (messages.some((message) => message.session_id !== expectedSessionId)) {
    throw new ClaudeHistoryProjectionError(
      "claude_history_session_identity_mismatch",
    );
  }
}

export function projectClaudeLatestSnapshot(
  value: unknown,
  terminalReceipts: readonly ClaudeTerminalReceiptOverride[] = [],
  authentication?: ClaudeHistoryAuthentication,
  coordinates: ClaudeLatestProjectionCoordinates = {
    turnOffset: 0,
    userMessageOrdinalBase: 0,
  },
): ClaudeHistoryProjection {
  const timeline = buildTimeline(
    value,
    terminalReceipts,
    authentication,
    coordinates.userMessageOrdinalBase,
  );
  const earliestByCount = Math.max(
    0,
    timeline.orderedBackendTurnIds.length - LATEST_SNAPSHOT_TURNS,
  );
  let start: number;
  let selected: Pick<
    BackendConversationSnapshot,
    "orderedBackendTurnIds" | "turnsById" | "itemsById"
  >;
  try {
    start = earliestStartWithinBytes(
      timeline,
      earliestByCount,
      timeline.orderedBackendTurnIds.length,
    );
    selected = pickTimeline(
      timeline,
      timeline.orderedBackendTurnIds.slice(start),
    );
  } catch (error) {
    if (
      !(error instanceof ClaudeHistoryProjectionError) ||
      error.code !== "history_too_large" ||
      timeline.orderedBackendTurnIds.length === 0
    ) {
      throw error;
    }
    start = timeline.orderedBackendTurnIds.length - 1;
    selected = compactOversizedLatestTurn(
      timeline,
      timeline.orderedBackendTurnIds[start]!,
    );
  }
  const turnIds = timeline.orderedBackendTurnIds.slice(start);
  const snapshot = backendConversationSnapshotSchema.parse({
    ...selected,
    runState: inferRunState(timeline, turnIds.at(-1)),
    ...(inferRunState(timeline, turnIds.at(-1)) === "running" && turnIds.at(-1)
      ? { activeBackendTurnId: turnIds.at(-1) }
      : {}),
  });
  const previousCursor =
    start > 0 ? historyCursor(timeline.fingerprint, start) : undefined;
  const retainedStart = Math.max(0, start - 1);
  const retainedTurnId = timeline.orderedBackendTurnIds[retainedStart];
  return {
    snapshot,
    history: {
      operational: true,
      ...(previousCursor ? { previousCursor } : {}),
    },
    ...(timeline.usage ? { usage: timeline.usage } : {}),
    nativeUserMessageUuidByBackendTurnId:
      timeline.nativeUserMessageUuidByBackendTurnId,
    nativeToolUseIds: timeline.nativeToolUseIds,
    terminalAssistantUuidByBackendTurnId:
      timeline.terminalAssistantUuidByBackendTurnId,
    terminalCheckpointUuidByBackendTurnId:
      timeline.terminalCheckpointUuidByBackendTurnId,
    authenticatedForkContextBoundaryOperationIds:
      timeline.authenticatedForkContextBoundaryOperationIds,
    authenticatedTaskContextOperationIds:
      timeline.authenticatedTaskContextOperationIds,
    window: {
      sourceTurnCount:
        coordinates.turnOffset + timeline.orderedBackendTurnIds.length,
      latestStartTurnIndex: coordinates.turnOffset + start,
      retainedStartTurnIndex: coordinates.turnOffset + retainedStart,
      retainedNativeMessageStartIndex:
        retainedTurnId === undefined
          ? timeline.messageCount
          : (timeline.nativeMessageStartIndexByBackendTurnId.get(
              retainedTurnId,
            ) ?? 0),
      retainedUserMessageOrdinal:
        retainedTurnId === undefined
          ? timeline.nextUserMessageOrdinal
          : (timeline.userMessageOrdinalByBackendTurnId.get(retainedTurnId) ??
            coordinates.userMessageOrdinalBase),
    },
  };
}

/**
 * Select a complete-turn page. A cursor names the exclusive upper turn index;
 * omitting it selects backward from the current end. Cursors are bound to the
 * exact projected transcript so stale cursors fail closed.
 */
export function projectClaudeHistoryPage(
  value: unknown,
  input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly terminalReceipts?: readonly ClaudeTerminalReceiptOverride[];
    readonly authentication?: ClaudeHistoryAuthentication;
  },
): BackendHistoryPagePayload {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new ClaudeHistoryProjectionError("claude_history_cursor_invalid");
  }
  const timeline = buildTimeline(
    value,
    input.terminalReceipts ?? [],
    input.authentication,
  );
  const before =
    input.cursor === undefined
      ? timeline.orderedBackendTurnIds.length
      : parseHistoryCursor(
          input.cursor,
          timeline.fingerprint,
          timeline.orderedBackendTurnIds.length,
        );
  const selection = selectHistoryPage(timeline, before, input.limit);
  return backendHistoryPageSchema.parse({
    ...selection.page,
    ...(selection.previousTurnIndex !== undefined
      ? {
          previousCursor: historyCursor(
            timeline.fingerprint,
            selection.previousTurnIndex,
          ),
        }
      : {}),
  });
}

/** Select a local native page by absolute turn index for one attached handle. */
export function projectClaudeHistoryPageAtIndex(
  value: unknown,
  input: {
    readonly before?: number;
    readonly limit: number;
    readonly terminalReceipts?: readonly ClaudeTerminalReceiptOverride[];
    readonly authentication?: ClaudeHistoryAuthentication;
  },
): ClaudeHistoryPageSelection {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new ClaudeHistoryProjectionError("claude_history_cursor_invalid");
  }
  const timeline = buildTimeline(
    value,
    input.terminalReceipts ?? [],
    input.authentication,
  );
  const before = input.before ?? timeline.orderedBackendTurnIds.length;
  if (
    !Number.isSafeInteger(before) ||
    before < 0 ||
    (before === 0 && timeline.orderedBackendTurnIds.length !== 0) ||
    before > timeline.orderedBackendTurnIds.length
  ) {
    throw new ClaudeHistoryProjectionError("claude_history_cursor_invalid");
  }
  return selectHistoryPage(timeline, before, input.limit);
}

/** Locate one turn in retained native history without exposing its identity. */
export function locateClaudeHistoryTurn(
  value: unknown,
  input: {
    readonly matchesBackendTurnId: (backendTurnId: string) => boolean;
    readonly maximumTurnCandidates: number;
    readonly terminalReceipts?: readonly ClaudeTerminalReceiptOverride[];
    readonly authentication?: ClaudeHistoryAuthentication;
  },
): ClaudeHistoryTurnLocation {
  if (
    !Number.isSafeInteger(input.maximumTurnCandidates) ||
    input.maximumTurnCandidates < 1
  ) {
    throw new ClaudeHistoryProjectionError("claude_history_lookup_invalid");
  }
  const timeline = buildTimeline(
    value,
    input.terminalReceipts ?? [],
    input.authentication,
  );
  const firstCandidateIndex = Math.max(
    0,
    timeline.orderedBackendTurnIds.length - input.maximumTurnCandidates,
  );
  for (
    let index = timeline.orderedBackendTurnIds.length - 1;
    index >= firstCandidateIndex;
    index -= 1
  ) {
    const backendTurnId = timeline.orderedBackendTurnIds[index]!;
    if (!input.matchesBackendTurnId(backendTurnId)) continue;
    return {
      status: "found",
      page: backendHistoryPageSchema.parse(
        pickTimeline(timeline, [backendTurnId]),
      ),
    };
  }
  return firstCandidateIndex > 0
    ? { status: "search_limit_reached" }
    : { status: "not_found" };
}

function selectHistoryPage(
  timeline: ProjectedTimeline,
  before: number,
  limit: number,
): ClaudeHistoryPageSelection {
  const earliestByCount = Math.max(0, before - limit);
  const start = earliestStartWithinBytes(timeline, earliestByCount, before);
  const turnIds = timeline.orderedBackendTurnIds.slice(start, before);
  return {
    page: backendHistoryPageSchema.parse(pickTimeline(timeline, turnIds)),
    ...(start > 0 ? { previousTurnIndex: start } : {}),
  };
}

function buildTimeline(
  value: unknown,
  terminalReceipts: readonly ClaudeTerminalReceiptOverride[],
  authentication?: ClaudeHistoryAuthentication,
  userMessageOrdinalBase = 0,
): ProjectedTimeline {
  let messages: readonly ParsedSessionMessage[];
  try {
    if (!Array.isArray(value)) invalid();
    messages = parseMessages(value);
  } catch (error) {
    if (error instanceof ClaudeHistoryProjectionError) throw error;
    throw new ClaudeHistoryProjectionError("claude_history_invalid", error);
  }

  const orderedBackendTurnIds: string[] = [];
  const turnsById: Record<string, BackendTurn> = {};
  const itemsById: Record<string, BackendItem> = {};
  const toolItemsByNativeId = new Map<string, string>();
  const nativeUserMessageUuidByBackendTurnId = new Map<string, string>();
  const terminalAssistantUuidByBackendTurnId = new Map<string, string>();
  const terminalCheckpointUuidByBackendTurnId = new Map<string, string>();
  const authenticatedForkContextBoundaryOperationIds = new Set<string>();
  const authenticatedTaskContextOperationIds = new Set<string>();
  const nativeMessageStartIndexByBackendTurnId = new Map<string, number>();
  const userMessageOrdinalByBackendTurnId = new Map<string, number>();
  const seenTurnIds = new Set<string>();
  let current: MutableTurn | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let assistantMessages = 0;
  const assistantMessageIds = new Set<string>();
  let userMessages = 0;
  let userMessageOrdinal = userMessageOrdinalBase;
  let toolCalls = 0;
  let toolResults = 0;
  const nextAssistantBlockIndexByMessageId = new Map<string, number>();
  const responseGroupsByTurn = new Map<string, Map<string, AssistantResponseGroup>>();
  const lastResponseGroupByTurn = new Map<string, AssistantResponseGroup>();

  const finishTurn = (): void => {
    if (!current) return;
    // A notification without an assistant response is not an active chat turn.
    if (current.taskNotificationBoundary && current.orderedBackendItemIds.length === 0) {
      orderedBackendTurnIds.pop();
      current = undefined;
      return;
    }
    const completed =
      current.interruptedAt === undefined &&
      current.terminalAssistantUuid !== undefined &&
      current.unresolvedToolIds.size === 0;
    turnsById[current.backendTurnId] = {
      backendTurnId: current.backendTurnId,
      ...(current.completionCorrelations.length > 0
        ? { completionCorrelations: current.completionCorrelations }
        : {}),
      status: current.interruptedAt ? "interrupted" : completed ? "completed" : "in_progress",
      ...(current.interruptedAt
        ? { endedBy: "interrupted" as const, completedAt: current.interruptedAt }
        : completed ? { endedBy: "agent_settled" as const } : {}),
      ...(completed && current.terminalAt
        ? { completedAt: current.terminalAt }
        : {}),
      orderedBackendItemIds: current.orderedBackendItemIds,
    };
    if (current.interruptedAt) {
      for (const id of current.orderedBackendItemIds) {
        const item = itemsById[id]!;
        if (item.status === "streaming") {
          itemsById[id] = terminalItem(item, "interrupted", current.interruptedAt);
        }
      }
    }
    nativeMessageStartIndexByBackendTurnId.set(
      current.backendTurnId,
      current.nativeMessageStartIndex,
    );
    userMessageOrdinalByBackendTurnId.set(
      current.backendTurnId,
      current.userMessageOrdinal,
    );
    if (current.nativeUserMessageUuid) {
      nativeUserMessageUuidByBackendTurnId.set(
        current.backendTurnId,
        current.nativeUserMessageUuid,
      );
    }
    if (
      completed &&
      current.terminalAssistantUuid &&
      isOperationId(current.terminalAssistantUuid)
    ) {
      terminalAssistantUuidByBackendTurnId.set(
        current.backendTurnId,
        current.terminalAssistantUuid,
      );
    }
    // The public history API omits attachment chain entries. The SDK documents
    // that structured-output/end-turn-tool turns do not have a trailing
    // assistant, so Sedes supports only the ordinary completed shape whose
    // last retained visible entry is that terminal assistant. This avoids
    // claiming an exact checkpoint for attachment-ended turns we cannot see.
    if (
      completed &&
      current.lastRetainedMessageUuid !== undefined &&
      current.lastRetainedMessageUuid === current.terminalAssistantUuid
    ) {
      terminalCheckpointUuidByBackendTurnId.set(
        current.backendTurnId,
        current.lastRetainedMessageUuid,
      );
    }
    current = undefined;
  };

  for (const [messageIndex, message] of messages.entries()) {
    if (!message.mainThread || message.type === "system") continue;
    const content = parseMessageContent(message.message, message.type);
    if (current && isInterruptionMarker(message, content, authentication?.isApplicationInputOperation)) {
      current.interruptedAt = message.timestamp!;
      current.lastRetainedMessageUuid = message.uuid;
      continue;
    }
    const taskNotification = isTaskNotification(message, content);
    const forkBoundaryOperationId =
      message.type === "user" &&
      content.length === 1 &&
      content[0]?.type === "text" &&
      authentication
        ? inspectClaudeForkContextBoundary(
            content[0].text,
            USER_FORK_CONTEXT_BOUNDARY,
            authentication.forkBoundaryAuthentication,
          )
        : undefined;
    if (message.type === "user" && forkBoundaryOperationId !== undefined) {
      finishTurn();
      authenticatedForkContextBoundaryOperationIds.add(forkBoundaryOperationId);
      continue;
    }
    // Retained native enqueue echoes are not consumption evidence. A scoped
    // association must be durable before Steer becomes accepted in history.
    if (message.type === "user" && authentication?.steerOperations?.get(message.uuid) === null) continue;
    const startsTurn =
      message.type === "user" &&
      content.some((block) => block.type !== "tool_result");
    const steerRoot = authentication?.steerOperations?.get(message.uuid);
    // Only an observed native association can join an earlier application turn.
    // A pending enqueue is not evidence that a user message belongs to it.
    const joinsCurrent = startsTurn && current !== undefined && steerRoot !== undefined &&
      steerRoot !== null && current.completionCorrelations.includes(steerRoot);
    if (startsTurn && !joinsCurrent) finishTurn();
    if (!current) {
      const backendTurnId = stableId(
        "claude-turn",
        `${message.sessionId}\0${message.uuid}`,
      );
      if (seenTurnIds.has(backendTurnId)) {
        throw new ClaudeHistoryProjectionError("claude_history_invalid");
      }
      seenTurnIds.add(backendTurnId);
      orderedBackendTurnIds.push(backendTurnId);
      current = {
        backendTurnId,
        orderedBackendItemIds: [],
        completionCorrelations: [],
        toolItemIdByNativeId: new Map(),
        unresolvedToolIds: new Set(),
        nativeMessageStartIndex: messageIndex,
        userMessageOrdinal,
        taskNotificationBoundary: taskNotification,
        sourceOrder: 0,
      };
    }
    current.lastRetainedMessageUuid = message.uuid;

    if (message.type === "user") {
      const ordinaryBlocks = content.filter(
        (block) => block.type !== "tool_result",
      );
      if (ordinaryBlocks.length > 0 && !taskNotification) {
        userMessages += 1;
        if (isOperationId(message.uuid)) {
          current.completionCorrelations.push(message.uuid);
          current.nativeUserMessageUuid ??= message.uuid;
        }
        addUserMessage(
          current,
          itemsById,
          message,
          ordinaryBlocks,
          authentication,
          userMessageOrdinal,
          authenticatedTaskContextOperationIds,
        );
        userMessageOrdinal += 1;
      }
      for (const [blockIndex, block] of content.entries()) {
        if (block.type !== "tool_result") continue;
        toolResults += 1;
        applyToolResult(current, itemsById, message, blockIndex, block);
      }
    } else {
      let responseGroups = responseGroupsByTurn.get(current.backendTurnId);
      if (!responseGroups) {
        responseGroups = new Map();
        responseGroupsByTurn.set(current.backendTurnId, responseGroups);
      }
      const responseGroupId = message.assistantMessageId ?? message.uuid;
      let responseGroup = responseGroups.get(responseGroupId);
      if (!responseGroup) {
        responseGroup = {
          hasNativeMessageIdentity: message.assistantMessageId !== undefined,
          itemIds: [],
          hasToolUse: false,
        };
        responseGroups.set(responseGroupId, responseGroup);
      }
      responseGroup.hasToolUse ||= content.some((block) => block.type === "tool_use") ||
        message.assistantStopReason === "tool_use";
      if (typeof message.assistantStopReason === "string") {
        responseGroup.stopReason = message.assistantStopReason;
      }
      lastResponseGroupByTurn.set(current.backendTurnId, responseGroup);
      if (
        !message.assistantMessageId ||
        !assistantMessageIds.has(message.assistantMessageId)
      ) {
        assistantMessages += 1;
        if (message.assistantMessageId) {
          assistantMessageIds.add(message.assistantMessageId);
        }
      }
      const assistantBlockBase = message.assistantMessageId
        ? (nextAssistantBlockIndexByMessageId.get(message.assistantMessageId) ??
          0)
        : 0;
      if (
        message.assistantStopReason !== null &&
        !content.some((block) => block.type === "tool_use")
      ) {
        current.terminalAssistantUuid = message.uuid;
        current.terminalAt = message.timestamp;
      }
      for (const [blockIndex, block] of content.entries()) {
        if (block.type === "text") {
          const itemId = addItem(
            current,
            itemsById,
            message,
            blockIndex,
            {
              semanticKind: "assistant_message",
              markdown: preserveClaudeMessageText(block.text),
            },
            "completed",
            assistantItemIdentity(message, assistantBlockBase + blockIndex),
          );
          responseGroup.itemIds.push(itemId);
        } else if (block.type === "thinking") {
          addItem(
            current,
            itemsById,
            message,
            blockIndex,
            {
              semanticKind: "reasoning",
              markdown: boundText(block.thinking),
            },
            "completed",
            assistantItemIdentity(message, assistantBlockBase + blockIndex),
          );
        } else if (block.type === "tool_use") {
          toolCalls += 1;
          const backendItemId = addItem(
            current,
            itemsById,
            message,
            blockIndex,
            projectClaudeTool(block.name, block.input),
            "streaming",
            assistantItemIdentity(message, assistantBlockBase + blockIndex),
          );
          if (current.toolItemIdByNativeId.has(block.id)) {
            throw new ClaudeHistoryProjectionError("claude_history_invalid");
          }
          current.toolItemIdByNativeId.set(block.id, backendItemId);
          toolItemsByNativeId.set(block.id, backendItemId);
          current.unresolvedToolIds.add(block.id);
        } else if (block.type === "image") {
          addItem(current, itemsById, message, blockIndex, {
            semanticKind: "notice",
            tone: "neutral",
            text: boundText("Claude assistant image content omitted."),
          });
        } else {
          addUnsupportedBlock(
            current,
            itemsById,
            message,
            blockIndex,
            block.type === "unsupported" ? block.nativeType : block.type,
          );
        }
      }
      if (message.assistantMessageId) {
        nextAssistantBlockIndexByMessageId.set(
          message.assistantMessageId,
          assistantBlockBase + content.length,
        );
      }
      if (message.assistantStopReason !== null) {
        const usage = parseUsage(message.message);
        inputTokens = safeAdd(inputTokens, usage.input);
        outputTokens = safeAdd(outputTokens, usage.output);
        cacheReadTokens = safeAdd(cacheReadTokens, usage.cacheRead);
        cacheWriteTokens = safeAdd(cacheWriteTokens, usage.cacheWrite);
      }
    }
  }
  finishTurn();
  applyTerminalReceipts(
    terminalReceipts,
    turnsById,
    itemsById,
    terminalAssistantUuidByBackendTurnId,
    terminalCheckpointUuidByBackendTurnId,
  );
  classifyAssistantResponses(
    responseGroupsByTurn,
    lastResponseGroupByTurn,
    terminalReceipts,
    turnsById,
    itemsById,
  );

  applyTaskLifecycleReceipts(authentication?.taskLifecycleReceipts ?? [], toolItemsByNativeId, turnsById, itemsById);

  const usage = usageSnapshotSchema.parse({
    tokens: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
      total: safeAdd(
        safeAdd(inputTokens, outputTokens),
        safeAdd(cacheReadTokens, cacheWriteTokens),
      ),
    },
    counters: {
      requests: assistantMessages,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: safeAdd(userMessages, assistantMessages),
    },
  });
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        orderedBackendTurnIds,
        turnsById,
        itemsById,
      }),
    )
    .digest("base64url")
    .slice(0, 32);
  return {
    orderedBackendTurnIds,
    turnsById,
    itemsById,
    usage,
    nativeUserMessageUuidByBackendTurnId,
    nativeToolUseIds: new Set(toolItemsByNativeId.keys()),
    terminalAssistantUuidByBackendTurnId,
    terminalCheckpointUuidByBackendTurnId,
    authenticatedForkContextBoundaryOperationIds,
    authenticatedTaskContextOperationIds,
    fingerprint,
    nativeMessageStartIndexByBackendTurnId,
    userMessageOrdinalByBackendTurnId,
    messageCount: messages.length,
    nextUserMessageOrdinal: userMessageOrdinal,
  };
}

/** Classify whole native messages, including SDK blocks emitted before their stop reason. */
function classifyAssistantResponses(
  groupsByTurn: ReadonlyMap<string, ReadonlyMap<string, AssistantResponseGroup>>,
  lastGroupByTurn: ReadonlyMap<string, AssistantResponseGroup>,
  receipts: readonly ClaudeTerminalReceiptOverride[],
  turnsById: Readonly<Record<string, BackendTurn>>,
  itemsById: Record<string, BackendItem>,
): void {
  const successfulReceipts = new Set(
    receipts.filter((receipt) => receipt.status === "completed").map((receipt) => receipt.backendTurnId),
  );
  for (const [turnId, groups] of groupsByTurn) {
    const last = lastGroupByTurn.get(turnId);
    const identifiedFinal = turnsById[turnId]?.status === "completed" && last && last.hasNativeMessageIdentity && !last.hasToolUse && (
      last.stopReason === "end_turn" || last.stopReason === "stop_sequence" ||
      (last.stopReason === undefined && successfulReceipts.has(turnId))
    ) ? last : undefined;
    for (const group of groups.values()) {
      const responsePhase = group === identifiedFinal ? "final" as const :
        group.hasToolUse || identifiedFinal !== undefined ? "provisional" as const : undefined;
      if (responsePhase === undefined) continue;
      for (const id of group.itemIds) {
        const item = itemsById[id];
        if (item?.semanticKind === "assistant_message") {
          itemsById[id] = { ...item, responsePhase };
        }
      }
    }
  }
}

function applyTaskLifecycleReceipts(
  receipts: readonly ClaudeTaskLifecycleReceipt[],
  toolItemsByNativeId: ReadonlyMap<string, string>,
  turnsById: Record<string, BackendTurn>,
  itemsById: Record<string, BackendItem>,
): void {
  for (const receipt of receipts) {
    const toolItemId = toolItemsByNativeId.get(receipt.nativeToolUseId);
    const launch = toolItemId ? itemsById[toolItemId] : undefined;
    // Never attach background or nested-agent events to a nearby main turn.
    // The provider-owned parent tool call must still exist in this history.
    if (!launch || launch.semanticKind !== "collaboration") continue;
    if (!receipt.terminalStatus || receipt.terminalAt === null) continue;
    const turn = turnsById[launch.backendTurnId]!;
    if (turn.orderedBackendItemIds.length >= MAXIMUM_BACKEND_ITEMS_PER_TURN) {
      throw new ClaudeHistoryProjectionError("history_too_large");
    }
    const backendItemId = stableId("claude-task-terminal", `${launch.backendItemId}\0${receipt.nativeTaskId}`);
    if (itemsById[backendItemId]) continue;
    // Native items occupy even slots; the paired lifecycle row has a stable
    // adjacent slot even if other agents finish or the parent keeps streaming.
    const sourceOrder = launch.sourceOrder + 1;
    const label = receipt.terminalStatus === "completed" ? "Subagent completed"
      : receipt.terminalStatus === "failed" ? "Subagent failed" : "Subagent stopped";
    itemsById[backendItemId] = {
      backendItemId, backendTurnId: launch.backendTurnId, sourceOrder,
      semanticKind: "collaboration", action: "status",
      status: receipt.terminalStatus === "stopped" ? "interrupted" : receipt.terminalStatus,
      completedAt: new Date(receipt.terminalAt).toISOString(),
      ...(launch.agentLabel ? { agentLabel: launch.agentLabel } : {}),
      summary: boundText(receipt.description ? `${label} · ${receipt.description}` : label),
    };
    const orderedBackendItemIds = [...turn.orderedBackendItemIds, backendItemId]
      .sort((a, b) => itemsById[a]!.sourceOrder - itemsById[b]!.sourceOrder);
    turnsById[launch.backendTurnId] = { ...turn, orderedBackendItemIds };
  }
}

function applyTerminalReceipts(
  receipts: readonly ClaudeTerminalReceiptOverride[],
  turnsById: Record<string, BackendTurn>,
  itemsById: Record<string, BackendItem>,
  terminalAssistantUuidByBackendTurnId: Map<string, string>,
  terminalCheckpointUuidByBackendTurnId: Map<string, string>,
): void {
  if (!Array.isArray(receipts)) invalid();
  const seen = new Set<string>();
  for (const receipt of receipts) {
    const candidate: unknown = receipt;
    if (
      !isPlainRecord(candidate) ||
      !boundedNativeId(candidate.backendTurnId) ||
      (candidate.status !== "completed" &&
        candidate.status !== "interrupted" &&
        candidate.status !== "failed") ||
      typeof candidate.terminalAt !== "number" ||
      !Number.isSafeInteger(candidate.terminalAt) ||
      candidate.terminalAt < 0 ||
      candidate.terminalAt > 8_640_000_000_000_000 ||
      !nullableBoundedProviderText(candidate.providerTerminalReason) ||
      !nullableBoundedProviderText(candidate.providerResultUuid) ||
      seen.has(candidate.backendTurnId)
    ) {
      invalid();
    }
    seen.add(candidate.backendTurnId);
    const turn = turnsById[candidate.backendTurnId];
    // Claude's same-user native store may be compacted or cleared outside
    // Sedes. A receipt for a turn no longer present in the authoritative
    // chain is stale evidence, not grounds to make the whole session unreadable.
    if (!turn) continue;
    if (
      candidate.status === "completed" &&
      turn.orderedBackendItemIds.some(
        (itemId) => itemsById[itemId]?.status === "streaming",
      )
    ) {
      continue;
    }
    const completedAt = new Date(candidate.terminalAt).toISOString();
    turnsById[candidate.backendTurnId] = {
      ...turn,
      status: candidate.status,
      endedBy:
        candidate.status === "completed" ? "agent_settled" : candidate.status,
      completedAt,
    };
    if (candidate.status !== "completed") {
      terminalAssistantUuidByBackendTurnId.delete(candidate.backendTurnId);
      terminalCheckpointUuidByBackendTurnId.delete(candidate.backendTurnId);
    }
    for (const itemId of turn.orderedBackendItemIds) {
      const item = itemsById[itemId];
      if (!item || item.status !== "streaming") continue;
      if (candidate.status !== "completed") {
        itemsById[itemId] = terminalItem(item, candidate.status, completedAt);
      }
    }
  }
}

function terminalItem(
  item: BackendItem,
  status: Exclude<ClaudeTerminalStatus, "completed">,
  completedAt: string,
): BackendItem {
  return settleInterruptedClaudeTool(item, status, completedAt);
}

function nullableBoundedProviderText(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= 2_048)
  );
}

type ParsedContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly toolUseId: string;
      readonly content: unknown;
      readonly isError: boolean;
    }
  | { readonly type: "image" }
  | { readonly type: "unsupported"; readonly nativeType: string };

function parseMessages(
  value: readonly unknown[],
): readonly ParsedSessionMessage[] {
  const result: ParsedSessionMessage[] = [];
  const uuids = new Set<string>();
  let sessionId: string | undefined;
  for (const candidate of value) {
    if (!isPlainRecord(candidate)) invalid();
    const type = candidate.type;
    const uuid = candidate.uuid;
    const nativeSessionId = candidate.session_id;
    const parentToolUseId = candidate.parent_tool_use_id;
    const parentAgentId = candidate.parent_agent_id;
    const timestamp = candidate.timestamp;
    if (
      (type !== "user" && type !== "assistant" && type !== "system") ||
      !boundedNativeId(uuid) ||
      !boundedNativeId(nativeSessionId) ||
      (parentToolUseId !== null && !boundedNativeId(parentToolUseId)) ||
      (parentAgentId !== null && !boundedNativeId(parentAgentId)) ||
      (timestamp !== undefined &&
        (typeof timestamp !== "string" ||
          !CLAUDE_MESSAGE_TIMESTAMP_SCHEMA.safeParse(timestamp).success)) ||
      !("message" in candidate) ||
      uuids.has(uuid)
    ) {
      invalid();
    }
    if (sessionId !== undefined && nativeSessionId !== sessionId) invalid();
    sessionId = nativeSessionId;
    uuids.add(uuid);
    result.push({
      type,
      uuid,
      sessionId: nativeSessionId,
      mainThread: parentToolUseId === null && parentAgentId === null,
      message: candidate.message,
      ...(candidate.origin !== undefined ? { origin: candidate.origin } : {}),
      ...(type === "assistant" &&
      isPlainRecord(candidate.message) &&
      boundedNativeId(candidate.message.id)
        ? { assistantMessageId: candidate.message.id }
        : {}),
      ...(type === "assistant" &&
      isPlainRecord(candidate.message) &&
      (candidate.message.stop_reason === null ||
        typeof candidate.message.stop_reason === "string")
        ? { assistantStopReason: candidate.message.stop_reason }
        : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    });
  }
  return result;
}

/** Match provider-stamped background bookends, never user text by itself.
 * Scheduled/peer deliveries share the broad origin kind and remain visible. */
function isTaskNotification(message: ParsedSessionMessage, content: readonly ParsedContentBlock[]): boolean {
  return message.type === "user" && isPlainRecord(message.origin) &&
    message.origin.kind === "task-notification" && message.origin.subkind === undefined &&
    content.length === 1 && content[0]?.type === "text" &&
    content[0].text.startsWith("<task-notification>") &&
    content[0].text.trimEnd().endsWith("</task-notification>");
}

/** Native CLI control markers have no origin or synthetic flag, even in SDK
 * history. Recognize only the exact timestamped, single-block native shape.
 * Explicit provider provenance and authenticated Sedes inputs remain messages. */
function isInterruptionMarker(
  message: ParsedSessionMessage,
  content: readonly ParsedContentBlock[],
  isApplicationInputOperation?: (operationId: string) => boolean,
): boolean {
  return message.type === "user" && message.origin === undefined &&
    message.timestamp !== undefined && isPlainRecord(message.message) &&
    Array.isArray(message.message.content) && content.length === 1 &&
    content[0]?.type === "text" &&
    (content[0].text === "[Request interrupted by user]" ||
      content[0].text === "[Request interrupted by user for tool use]") &&
    !isApplicationInputOperation?.(message.uuid);
}

function parseMessageContent(
  message: unknown,
  wrapperType: "user" | "assistant",
): readonly ParsedContentBlock[] {
  if (!isPlainRecord(message) || message.role !== wrapperType) invalid();
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content) || content.length > 2_000) invalid();
  return content.map((candidate): ParsedContentBlock => {
    if (!isPlainRecord(candidate) || typeof candidate.type !== "string")
      invalid();
    if (candidate.type === "text") {
      if (typeof candidate.text !== "string") invalid();
      return { type: "text", text: candidate.text };
    }
    if (candidate.type === "thinking") {
      if (typeof candidate.thinking !== "string") invalid();
      return { type: "thinking", thinking: candidate.thinking };
    }
    if (candidate.type === "tool_use") {
      if (
        !boundedNativeId(candidate.id) ||
        typeof candidate.name !== "string" ||
        candidate.name.length === 0 ||
        Buffer.byteLength(candidate.name, "utf8") >
          MAXIMUM_PROVIDER_TOOL_NAME_BYTES
      ) {
        invalid();
      }
      return {
        type: "tool_use",
        id: candidate.id,
        name: candidate.name,
        input: candidate.input,
      };
    }
    if (candidate.type === "tool_result") {
      if (!boundedNativeId(candidate.tool_use_id)) invalid();
      if (
        candidate.is_error !== undefined &&
        typeof candidate.is_error !== "boolean"
      ) {
        invalid();
      }
      return {
        type: "tool_result",
        toolUseId: candidate.tool_use_id,
        content: candidate.content,
        isError: candidate.is_error === true,
      };
    }
    if (candidate.type === "image") return { type: "image" };
    return { type: "unsupported", nativeType: candidate.type };
  });
}

function addUserMessage(
  turn: MutableTurn,
  itemsById: Record<string, BackendItem>,
  message: ParsedSessionMessage,
  blocks: readonly ParsedContentBlock[],
  authentication?: ClaudeHistoryAuthentication,
  userMessageOrdinal = 0,
  authenticatedTaskContextOperationIds = new Set<string>(),
): void {
  const content: Extract<
    BackendItem,
    { semanticKind: "user_message" }
  >["content"] = [];
  let authenticatedNativeImagesToSuppress = 0;
  for (const [blockIndex, block] of blocks.entries()) {
    if (block.type === "text") {
      // Native image submissions put one authenticated envelope first,
      // followed by the corresponding image blocks. Only that exact shape is
      // deduplicated; unrelated provider-native images remain visible as
      // omitted placeholders.
      authenticatedNativeImagesToSuppress = 0;
      const skillName =
        blockIndex === 0
          ? authentication?.resolveSkillName?.(message.uuid)
          : undefined;
      const authenticatedSkillName =
        skillName &&
        isClaudeSkillName(skillName) &&
        (block.text === `/${skillName}` ||
          block.text.startsWith(`/${skillName} `))
          ? skillName
          : undefined;
      const providerText = authenticatedSkillName
        ? block.text.slice(authenticatedSkillName.length + 2)
        : block.text;
      if (authenticatedSkillName) {
        content.unshift({
          kind: "skill",
          name: boundDisplayText(authenticatedSkillName),
        });
      }
      const attachmentInspection = authentication
        ? inspectClaudeAttachmentEnvelope(providerText, {
            key: authentication.attachmentProvenanceKey,
            operationId: message.uuid,
          })
        : isClaudeAttachmentEnvelopeText(providerText)
          ? ({
              type: "invalid",
              prompt: providerText.split("\n").slice(4).join("\n"),
            } as const)
          : ({ type: "ordinary", prompt: providerText } as const);
      if (attachmentInspection.type === "authenticated") {
        for (const attachment of attachmentInspection.attachments) {
          content.push({ kind: "attachment", attachment });
          if (attachment.kind === "image") {
            authenticatedNativeImagesToSuppress += 1;
          }
        }
      }
      const safeText = attachmentInspection.prompt;
      const taskInspection = authentication
        ? inspectClaudeTaskContextEnvelope(
            safeText,
            authentication.forkBoundaryAuthentication,
          )
        : {
            type: "ordinary_prompt" as const,
            prompt: safeText,
            taskContexts: [] as const,
          };
      const authenticatedTaskInspection =
        taskInspection.type === "envelope" &&
        taskInspection.userMessageOrdinal === userMessageOrdinal &&
        !authenticatedTaskContextOperationIds.has(taskInspection.operationId) &&
        authentication?.isApplicationInputOperation?.(
          taskInspection.operationId,
        ) === true &&
        !taskInspection.prompt.startsWith(
          '<sedes-task-contexts version="1">',
        ) &&
        !taskInspection.prompt.startsWith('<harness-task-contexts version="1">')
          ? taskInspection
          : undefined;
      if (authenticatedTaskInspection) {
        authenticatedTaskContextOperationIds.add(
          authenticatedTaskInspection.operationId,
        );
        for (const task of authenticatedTaskInspection.taskContexts) {
          content.push({ kind: "task_context", task });
        }
      }
      const inspection = authentication
        ? inspectClaudeContextExcerptEnvelope(
            authenticatedTaskInspection?.prompt ?? safeText,
            authentication.forkBoundaryAuthentication,
          )
        : {
            type: "ordinary_prompt" as const,
            prompt: authenticatedTaskInspection?.prompt ?? safeText,
            contextExcerpts: [] as const,
          };
      if (inspection.type === "envelope") {
        for (const excerpt of inspection.contextExcerpts) {
          content.push({ kind: "context_excerpt", excerpt });
        }
        addClaudeUserPromptContent(content, inspection.prompt);
      } else {
        addClaudeUserPromptContent(content, inspection.prompt);
      }
    } else if (block.type === "image") {
      if (authenticatedNativeImagesToSuppress > 0) {
        authenticatedNativeImagesToSuppress -= 1;
      } else {
        content.push({ kind: "image", omitted: true });
      }
    } else if (block.type === "unsupported") {
      authenticatedNativeImagesToSuppress = 0;
      content.push({
        kind: "text",
        text: boundText(
          `[Unsupported Claude content block: ${block.nativeType}]`,
        ),
      });
    }
  }
  if (content.length > MAXIMUM_USER_MESSAGE_CONTENT_PARTS) {
    throw new ClaudeHistoryProjectionError("claude_message_payload_too_large");
  }
  if (content.length === 0) content.push({ kind: "text", text: preserveClaudeMessageText("") });
  addItem(turn, itemsById, message, 0, {
    semanticKind: "user_message",
    ...(isOperationId(message.uuid)
      ? { deliveryOperationId: message.uuid }
      : {}),
    content,
  });
}

function addClaudeUserPromptContent(
  content: Extract<BackendItem, { semanticKind: "user_message" }>["content"],
  prompt: string,
): void {
  if (prompt.length > 0 || content.length === 0) {
    content.push({ kind: "text", text: preserveClaudeMessageText(prompt) });
  }
}

/** Ordinal of the next main-thread ordinary user message in native history. */
export function nextClaudeUserMessageOrdinal(
  value: readonly SessionMessage[],
  authentication: ClaudeForkBoundaryAuthentication,
  isApplicationInputOperation?: (operationId: string) => boolean,
): number {
  let hasTurn = false;
  return parseMessages(value).filter((message) => {
    if (!message.mainThread || message.type === "system") return false;
    const content = parseMessageContent(message.message, message.type);
    if (hasTurn && isInterruptionMarker(message, content, isApplicationInputOperation)) return false;
    if (message.type === "assistant") { hasTurn = true; return false; }
    if (isTaskNotification(message, content)) return false;
    if (
      content.length === 1 &&
      content[0]?.type === "text" &&
      inspectClaudeForkContextBoundary(
        content[0].text,
        USER_FORK_CONTEXT_BOUNDARY,
        authentication,
      ) !== undefined
    ) {
      return false;
    }
    hasTurn = true;
    return content.some((block) => block.type !== "tool_result");
  }).length;
}

function applyToolResult(
  turn: MutableTurn,
  itemsById: Record<string, BackendItem>,
  message: ParsedSessionMessage,
  blockIndex: number,
  block: Extract<ParsedContentBlock, { type: "tool_result" }>,
): void {
  const existingId = turn.toolItemIdByNativeId.get(block.toolUseId);
  if (existingId) {
    // A native tool ID is terminal exactly once. Repeated evidence—whether
    // byte-identical or conflicting—makes the authoritative transcript
    // ambiguous and must not regress or rewrite an already settled item.
    if (!turn.unresolvedToolIds.has(block.toolUseId)) invalid();
    const existing = itemsById[existingId];
    if (!existing) invalid();
    try {
      itemsById[existingId] = completeClaudeTool(
        existing,
        block.content,
        block.isError,
      );
    } catch {
      invalid();
    }
    turn.unresolvedToolIds.delete(block.toolUseId);
    return;
  }
  addItem(
    turn,
    itemsById,
    message,
    blockIndex,
    {
      semanticKind: "tool",
      phase: block.isError ? "failed" : "completed",
      toolName: boundDisplayText("unknown"),
      title: boundDisplayText("Claude tool result"),
      category: "other",
      result: boundToolResult(
        Array.isArray(block.content)
          ? { content: block.content }
          : block.content,
        block.isError,
      ),
    },
    block.isError ? "failed" : "completed",
  );
}

function addUnsupportedBlock(
  turn: MutableTurn,
  itemsById: Record<string, BackendItem>,
  message: ParsedSessionMessage,
  blockIndex: number,
  nativeType: string,
): void {
  addItem(turn, itemsById, message, blockIndex, {
    semanticKind: "notice",
    tone: "neutral",
    text: boundText(`Unsupported Claude content block: ${nativeType}`),
  });
}

type WithoutItemBase<Item> = Item extends BackendItem
  ? Omit<Item, "backendItemId" | "backendTurnId" | "status" | "sourceOrder">
  : never;
type ItemSpecific = WithoutItemBase<BackendItem>;

function addItem(
  turn: MutableTurn,
  itemsById: Record<string, BackendItem>,
  message: ParsedSessionMessage,
  blockIndex: number,
  specific: ItemSpecific,
  status: BackendItem["status"] = "completed",
  identity?: { readonly messageId: string; readonly blockIndex: number },
): string {
  if (turn.orderedBackendItemIds.length >= MAXIMUM_BACKEND_ITEMS_PER_TURN) {
    throw new ClaudeHistoryProjectionError("history_too_large");
  }
  const backendItemId = stableId(
    "claude-item",
    identity
      ? `${message.sessionId}\0${identity.messageId}\0${identity.blockIndex}\0${specific.semanticKind}`
      : `${message.sessionId}\0${message.uuid}\0${blockIndex}\0${specific.semanticKind}`,
  );
  if (itemsById[backendItemId]) invalid();
  const item = {
    backendItemId,
    backendTurnId: turn.backendTurnId,
    status,
    sourceOrder: turn.sourceOrder,
    ...specific,
  } as BackendItem;
  // Reject an invalid individual message before aggregate latest-turn
  // compaction could hide it behind an omission notice.
  assertClaudeMessageItemPayload(item);
  turn.sourceOrder += 2;
  turn.orderedBackendItemIds.push(backendItemId);
  itemsById[backendItemId] = item;
  return backendItemId;
}

function assistantItemIdentity(
  message: ParsedSessionMessage,
  blockIndex: number,
): { readonly messageId: string; readonly blockIndex: number } | undefined {
  return message.assistantMessageId
    ? { messageId: message.assistantMessageId, blockIndex }
    : undefined;
}

function pickTimeline(
  timeline: ProjectedTimeline,
  turnIds: readonly string[],
): Pick<
  BackendConversationSnapshot,
  "orderedBackendTurnIds" | "turnsById" | "itemsById"
> {
  const selected = pickTimelineUnchecked(timeline, turnIds);
  if (serializedUtf8Bytes(selected) > MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES) {
    throw new ClaudeHistoryProjectionError("history_too_large");
  }
  return selected;
}

function compactOversizedLatestTurn(
  timeline: ProjectedTimeline,
  turnId: string,
): Pick<
  BackendConversationSnapshot,
  "orderedBackendTurnIds" | "turnsById" | "itemsById"
> {
  const originalTurn = timeline.turnsById[turnId];
  if (!originalTurn) {
    throw new ClaudeHistoryProjectionError("claude_history_invalid");
  }
  const originalIds = originalTurn.orderedBackendItemIds;
  const firstId = originalIds[0];
  const firstItem = firstId ? timeline.itemsById[firstId] : undefined;
  const preservedPrefixIds =
    firstItem?.semanticKind === "user_message" ? [firstId!] : [];
  const suffixCandidates = originalIds.slice(preservedPrefixIds.length);
  const omissionId = stableId("claude-item-omission", turnId);
  const candidate = (suffixCount: number) => {
    const suffixIds =
      suffixCount === 0
        ? []
        : suffixCandidates.slice(suffixCandidates.length - suffixCount);
    const retained = new Set([...preservedPrefixIds, ...suffixIds]);
    const omittedIds = originalIds.filter((itemId) => !retained.has(itemId));
    if (omittedIds.length === 0) {
      return pickTimelineUnchecked(timeline, [turnId]);
    }
    const firstOmitted = timeline.itemsById[omittedIds[0]!];
    if (!firstOmitted) {
      throw new ClaudeHistoryProjectionError("claude_history_invalid");
    }
    const orderedBackendItemIds = [
      ...preservedPrefixIds,
      omissionId,
      ...suffixIds,
    ];
    const itemsById = Object.fromEntries(
      [...preservedPrefixIds, ...suffixIds].map((itemId) => [
        itemId,
        timeline.itemsById[itemId]!,
      ]),
    );
    itemsById[omissionId] = {
      backendItemId: omissionId,
      backendTurnId: turnId,
      semanticKind: "notice",
      status: "completed",
      sourceOrder: firstOmitted.sourceOrder,
      tone: "warning",
      text: boundText(
        `Claude omitted ${omittedIds.length} earlier item${omittedIds.length === 1 ? "" : "s"} from this oversized current turn.`,
      ),
    };
    return {
      orderedBackendTurnIds: [turnId],
      turnsById: {
        [turnId]: { ...originalTurn, orderedBackendItemIds },
      },
      itemsById,
    };
  };
  const runState = inferRunState(timeline, turnId);
  const fits = (suffixCount: number): boolean =>
    serializedUtf8Bytes({
      ...candidate(suffixCount),
      runState,
      ...(runState === "running" ? { activeBackendTurnId: turnId } : {}),
    }) <= MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES;
  if (!fits(0)) {
    throw new ClaudeHistoryProjectionError("history_too_large");
  }
  let low = 0;
  let high = suffixCandidates.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return candidate(low);
}

function earliestStartWithinBytes(
  timeline: ProjectedTimeline,
  earliestByCount: number,
  end: number,
): number {
  if (end <= 0) return 0;
  const bytesAt = (start: number): number =>
    serializedUtf8Bytes(
      pickTimelineUnchecked(
        timeline,
        timeline.orderedBackendTurnIds.slice(start, end),
      ),
    );
  if (bytesAt(end - 1) > MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES) {
    throw new ClaudeHistoryProjectionError("history_too_large");
  }
  let low = earliestByCount;
  let high = end - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (bytesAt(middle) <= MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

function pickTimelineUnchecked(
  timeline: ProjectedTimeline,
  turnIds: readonly string[],
): Pick<
  BackendConversationSnapshot,
  "orderedBackendTurnIds" | "turnsById" | "itemsById"
> {
  const turnsById = Object.fromEntries(
    turnIds.map((turnId) => [turnId, timeline.turnsById[turnId]!]),
  );
  const itemIds = turnIds.flatMap(
    (turnId) => turnsById[turnId]!.orderedBackendItemIds,
  );
  return {
    orderedBackendTurnIds: [...turnIds],
    turnsById,
    itemsById: Object.fromEntries(
      itemIds.map((itemId) => [itemId, timeline.itemsById[itemId]!]),
    ),
  };
}

function inferRunState(
  timeline: ProjectedTimeline,
  finalTurnId: string | undefined,
): "idle" | "running" | "failed" {
  const status = finalTurnId
    ? timeline.turnsById[finalTurnId]?.status
    : undefined;
  return status === "in_progress"
    ? "running"
    : status === "failed"
      ? "failed"
      : "idle";
}

function parseUsage(message: unknown): {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
} {
  if (!isPlainRecord(message) || !isPlainRecord(message.usage)) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  return {
    input: safeCount(message.usage.input_tokens),
    output: safeCount(message.usage.output_tokens),
    cacheRead: safeCount(message.usage.cache_read_input_tokens),
    cacheWrite: safeCount(message.usage.cache_creation_input_tokens),
  };
}

function historyCursor(fingerprint: string, before: number): string {
  return `claude-history:v1:${fingerprint}:${before}`;
}

function parseHistoryCursor(
  cursor: string,
  fingerprint: string,
  maximum: number,
): number {
  if (Buffer.byteLength(cursor, "utf8") > MAXIMUM_CURSOR_BYTES) invalidCursor();
  const match = /^claude-history:v1:([A-Za-z0-9_-]{32}):(\d+)$/u.exec(cursor);
  const before = match ? Number(match[2]) : Number.NaN;
  if (
    !match ||
    match[1] !== fingerprint ||
    !Number.isSafeInteger(before) ||
    before < 1 ||
    before > maximum
  ) {
    invalidCursor();
  }
  return before;
}

function stableId(prefix: string, input: string): string {
  return `${prefix}:${createHash("sha256").update(input).digest("base64url")}`;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function safeAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function isOperationId(value: string): boolean {
  return value.length <= 160 && OPERATION_ID_PATTERN.test(value);
}

function boundedNativeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    Buffer.byteLength(value, "utf8") <= 2_048
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(): never {
  throw new ClaudeHistoryProjectionError("claude_history_invalid");
}

function invalidCursor(): never {
  throw new ClaudeHistoryProjectionError("claude_history_cursor_invalid");
}
