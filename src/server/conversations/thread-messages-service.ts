import { randomUUID } from "node:crypto";
import type {
  BoundedText,
  TruncationInfo,
} from "../../shared/protocol/payload.js";
import { serializedUtf8Bytes } from "../../shared/protocol/payload.js";
import type {
  ConversationItem,
  ConversationTurn,
  DeliveryInputOrigin,
  HistoryPage,
} from "../../shared/protocol/conversation.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import {
  environmentAuthorityContinuationDigest,
  requireAdmittedResource,
  type TrustedEnvironmentAuthorityGrant,
} from "../agent-tools/environment/environment-authority.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../agent-tools/registry/canonical-agent-tool-manifest.js";
import type { ThreadRuntimeCoordinator } from "../events/thread-runtime-coordinator.js";
import type { ThreadApplicationInventoryReader } from "./thread-application-service.js";
import {
  projectedThreadForkSourceCapability,
  projectedTurnForkCapability,
  type ProjectedConversationTimeline,
} from "./conversation-projector.js";

export const DEFAULT_THREAD_MESSAGES_PAGE_SIZE = 10;
export const MAXIMUM_THREAD_MESSAGES_PAGE_SIZE = 25;
export const MAXIMUM_THREAD_MESSAGES_OUTPUT_BYTES = 1_024 * 1_024;

const DEFAULT_MAXIMUM_CURSORS = 2_048;
const DEFAULT_CURSOR_LIFETIME_MILLISECONDS = 30 * 60 * 1_000;
const MAXIMUM_MESSAGES_PER_TURN = 16;
const MAXIMUM_TOOL_MESSAGE_TEXT_PREVIEW_BYTES = 16 * 1_024;
const TARGET_PAGE_TEXT_BUDGET_BYTES = 768 * 1_024;
const MAXIMUM_HISTORY_SCAN_PAGES = 128;
const THREAD_MESSAGES_TOOL = CANONICAL_AGENT_TOOL_MANIFEST["thread.messages"];

type TerminalTurnStatus = Exclude<ConversationTurn["status"], "in_progress">;
type ThreadMessageOrigin = Extract<
  DeliveryInputOrigin,
  { readonly kind: "agent_message" | "agent_result" }
>;

export interface ThreadMessagesInput {
  readonly cursor?: string;
  readonly pageSize?: number;
  readonly environmentAuthority: TrustedEnvironmentAuthorityGrant;
}

export type ThreadMessagesMessage =
  | {
      readonly role: "user";
      readonly text: BoundedText;
      readonly origin?: ThreadMessageOrigin;
    }
  | {
      readonly role: "assistant";
      readonly text: BoundedText;
    };

export type ThreadMessagesActiveMessage = ThreadMessagesMessage & {
  readonly id: string;
};

export interface ThreadMessagesTurn {
  readonly id: string;
  readonly revision: number;
  readonly status: TerminalTurnStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly forkable: boolean;
  readonly messages: readonly ThreadMessagesMessage[];
  readonly messagesTruncation?: {
    readonly truncated: true;
    readonly omittedCount: number;
    readonly reason: "entry_limit";
  };
}

export interface ThreadMessagesActiveTurn {
  readonly id: string;
  readonly status: "in_progress";
  readonly startedAt?: string;
  readonly messages: readonly ThreadMessagesActiveMessage[];
  readonly messagesTruncation?: {
    readonly truncated: true;
    readonly omittedCount: number;
    readonly reason: "entry_limit";
  };
}

export interface ThreadMessagesPage {
  /** Pages move from newest to oldest; turns inside one page are chronological. */
  readonly turns: readonly ThreadMessagesTurn[];
  readonly nextCursor: string | null;
  /** Present only on a fresh cursorless read; null means no turn is active. */
  readonly activeTurn?: ThreadMessagesActiveTurn | null;
}

type RawMessage =
  | {
      readonly id: string;
      readonly role: "user";
      readonly text: string;
      readonly origin?: ThreadMessageOrigin;
      readonly sourceTruncation?: TruncationInfo;
    }
  | {
      readonly id: string;
      readonly role: "assistant";
      readonly text: string;
      readonly sourceTruncation?: TruncationInfo;
    };

interface RawTurn {
  readonly id: string;
  readonly revision: number;
  readonly status: TerminalTurnStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly forkable: boolean;
  readonly messages: readonly RawMessage[];
  readonly omittedMessages: number;
}

interface RawActiveTurn {
  readonly id: string;
  readonly status: "in_progress";
  readonly startedAt?: string;
  readonly messages: readonly RawMessage[];
  readonly omittedMessages: number;
}

interface LiveBoundary {
  readonly turnId: string;
  readonly turnRevision: number;
}

interface MessagesCursorEntry {
  readonly tenantId: string;
  readonly principalId: string;
  readonly applicationThreadId: string;
  readonly sourceEnvironmentId: string;
  readonly targetEnvironmentIds: readonly string[];
  readonly continuationAuthorityDigest: string;
  readonly policyRevision: number;
  readonly projectionGeneration: string;
  readonly pageSize: number;
  readonly expiresAt: number;
  readonly liveThrough?: LiveBoundary;
  readonly backendCursor?: string;
  pending?: Promise<ThreadMessagesPage>;
}

function terminal(turn: ConversationTurn): turn is ConversationTurn & {
  readonly status: TerminalTurnStatus;
} {
  return turn.status !== "in_progress";
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let retained = "";
  let retainedBytes = 0;
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (retainedBytes + codePointBytes > maximumBytes) break;
    retained += codePoint;
    retainedBytes += codePointBytes;
  }
  return retained;
}

function boundedText(message: RawMessage, maximumBytes: number): BoundedText {
  const currentBytes = Buffer.byteLength(message.text, "utf8");
  const text = utf8Prefix(message.text, maximumBytes);
  const retainedBytes = Buffer.byteLength(text, "utf8");
  if (retainedBytes === currentBytes && !message.sourceTruncation) {
    return { text };
  }
  return {
    text,
    truncation: {
      truncated: true,
      reason: message.sourceTruncation?.reason ?? "byte_limit",
      retainedBytes,
      ...(message.sourceTruncation?.originalBytes !== undefined
        ? { originalBytes: message.sourceTruncation.originalBytes }
        : message.sourceTruncation
          ? {}
          : { originalBytes: currentBytes }),
    },
  };
}

function projectMessage(
  message: RawMessage,
  maximumTextBytes: number,
): ThreadMessagesMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      text: boundedText(message, maximumTextBytes),
    };
  }
  return {
    role: "user",
    text: boundedText(message, maximumTextBytes),
    ...(message.origin ? { origin: message.origin } : {}),
  };
}

function rawMessage(item: ConversationItem): RawMessage | undefined {
  if (item.kind === "assistant_message") {
    return {
      id: item.id,
      role: "assistant",
      text: item.markdown.text,
    };
  }
  if (item.kind !== "user_message") return undefined;
  const textParts = item.content.filter(
    (part): part is Extract<(typeof item.content)[number], { kind: "text" }> =>
      part.kind === "text",
  );
  const omittedPart = item.content.find((part) => part.kind !== "text");
  if (textParts.length === 0 && !omittedPart) return undefined;
  const text = textParts.map((part) => part.text.text).join("\n\n");
  const omission: TruncationInfo | undefined = omittedPart
    ? {
        truncated: true,
        retainedBytes: Buffer.byteLength(text, "utf8"),
        reason: omittedPart.kind === "image" ? "binary_omitted" : "entry_limit",
      }
    : undefined;
  // Transcript tools expose inter-agent provenance, not question interaction
  // envelopes. The ordinary user message text already contains the answer.
  const origin =
    item.origin?.kind === "agent_message" || item.origin?.kind === "agent_result"
      ? item.origin
      : undefined;
  return {
    id: item.id,
    role: "user",
    text,
    ...(origin ? { origin } : {}),
    ...(omission ? { sourceTruncation: omission } : {}),
  };
}

function rawActiveTurn(
  turn: ConversationTurn & { readonly status: "in_progress" },
  itemsById: ProjectedConversationTimeline["itemsById"],
): RawActiveTurn {
  const allMessages = turn.orderedItemIds
    .map((itemId) => itemsById[itemId])
    .filter(
      (item): item is ConversationItem =>
        Boolean(item) && item?.status === "completed",
    )
    .map(rawMessage)
    .filter((message): message is RawMessage => Boolean(message));
  const omittedMessages = Math.max(
    0,
    allMessages.length - MAXIMUM_MESSAGES_PER_TURN,
  );
  return {
    id: turn.id,
    status: "in_progress",
    ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
    messages: allMessages.slice(-MAXIMUM_MESSAGES_PER_TURN),
    omittedMessages,
  };
}

function rawTurn(
  turn: ConversationTurn & { readonly status: TerminalTurnStatus },
  itemsById:
    ProjectedConversationTimeline["itemsById"] | HistoryPage["itemsById"],
  forkable: boolean,
): RawTurn {
  const allMessages = turn.orderedItemIds
    .map((itemId) => itemsById[itemId])
    .filter((item): item is ConversationItem => Boolean(item))
    .map(rawMessage)
    .filter((message): message is RawMessage => Boolean(message));
  const messages = allMessages.slice(0, MAXIMUM_MESSAGES_PER_TURN);
  return {
    id: turn.id,
    revision: turn.revision,
    status: turn.status,
    ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
    ...(turn.completedAt ? { completedAt: turn.completedAt } : {}),
    forkable,
    messages,
    omittedMessages: allMessages.length - messages.length,
  };
}

function projectPage(
  turns: readonly RawTurn[],
  nextCursor: string | null,
  activeTurn: RawActiveTurn | null | undefined,
): ThreadMessagesPage {
  const messageCount =
    turns.reduce((sum, turn) => sum + turn.messages.length, 0) +
    (activeTurn?.messages.length ?? 0);
  let maximumTextBytes = Math.min(
    MAXIMUM_TOOL_MESSAGE_TEXT_PREVIEW_BYTES,
    messageCount === 0
      ? MAXIMUM_TOOL_MESSAGE_TEXT_PREVIEW_BYTES
      : Math.floor(TARGET_PAGE_TEXT_BUDGET_BYTES / messageCount),
  );
  const build = (): ThreadMessagesPage => {
    const page: ThreadMessagesPage = {
      turns: turns.map((turn) => ({
        id: turn.id,
        revision: turn.revision,
        status: turn.status,
        ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
        ...(turn.completedAt ? { completedAt: turn.completedAt } : {}),
        forkable: turn.forkable,
        messages: turn.messages.map((message) =>
          projectMessage(message, maximumTextBytes),
        ),
        ...(turn.omittedMessages > 0
          ? {
              messagesTruncation: {
                truncated: true as const,
                omittedCount: turn.omittedMessages,
                reason: "entry_limit" as const,
              },
            }
          : {}),
      })),
      nextCursor,
      ...(activeTurn === undefined
        ? {}
        : {
            activeTurn:
              activeTurn === null
                ? null
                : {
                    id: activeTurn.id,
                    status: activeTurn.status,
                    ...(activeTurn.startedAt
                      ? { startedAt: activeTurn.startedAt }
                      : {}),
                    messages: activeTurn.messages.map((message) => ({
                      id: message.id,
                      ...projectMessage(message, maximumTextBytes),
                    })),
                    ...(activeTurn.omittedMessages > 0
                      ? {
                          messagesTruncation: {
                            truncated: true as const,
                            omittedCount: activeTurn.omittedMessages,
                            reason: "entry_limit" as const,
                          },
                        }
                      : {}),
                  },
          }),
    };
    return page;
  };
  let page = build();
  while (
    serializedUtf8Bytes(page) > MAXIMUM_THREAD_MESSAGES_OUTPUT_BYTES &&
    maximumTextBytes > 0
  ) {
    maximumTextBytes = Math.floor(maximumTextBytes / 2);
    page = build();
  }
  if (serializedUtf8Bytes(page) > MAXIMUM_THREAD_MESSAGES_OUTPUT_BYTES) {
    throw new DomainError(
      "runtime_unavailable",
      "The bounded conversation transcript page could not be projected safely.",
    );
  }
  return page;
}

/**
 * Read-only, backend-neutral transcript projection for agent control tools.
 *
 * This service borrows the actor's private history capture directly and never
 * publishes `history_prepend` (or any other browser/SSE event).
 */
export class ThreadMessagesService {
  readonly #inventory: ThreadApplicationInventoryReader;
  readonly #runtimes: Pick<ThreadRuntimeCoordinator, "acquire">;
  readonly #maximumCursors: number;
  readonly #cursorLifetimeMilliseconds: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, MessagesCursorEntry>();

  constructor(input: {
    readonly inventory: ThreadApplicationInventoryReader;
    readonly runtimes: Pick<ThreadRuntimeCoordinator, "acquire">;
    readonly maximumCursors?: number;
    readonly cursorLifetimeMilliseconds?: number;
    readonly now?: () => number;
  }) {
    this.#inventory = input.inventory;
    this.#runtimes = input.runtimes;
    this.#maximumCursors = input.maximumCursors ?? DEFAULT_MAXIMUM_CURSORS;
    this.#cursorLifetimeMilliseconds =
      input.cursorLifetimeMilliseconds ?? DEFAULT_CURSOR_LIFETIME_MILLISECONDS;
    this.#now = input.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.#maximumCursors) ||
      this.#maximumCursors <= 0 ||
      !Number.isSafeInteger(this.#cursorLifetimeMilliseconds) ||
      this.#cursorLifetimeMilliseconds <= 0
    ) {
      throw new Error("thread_messages_configuration_invalid");
    }
  }

  async list(
    scope: RequestScope,
    applicationThreadId: string,
    input: ThreadMessagesInput,
  ): Promise<ThreadMessagesPage> {
    const pageSize = input.pageSize ?? DEFAULT_THREAD_MESSAGES_PAGE_SIZE;
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > MAXIMUM_THREAD_MESSAGES_PAGE_SIZE
    ) {
      throw new DomainError(
        "cursor_invalid",
        `Transcript page size must be between 1 and ${MAXIMUM_THREAD_MESSAGES_PAGE_SIZE}.`,
      );
    }
    const authorized = await this.#inventory.getAuthorized(
      scope,
      applicationThreadId,
    );
    if (
      authorized.tenantId !== scope.tenantId ||
      authorized.ownerPrincipalId !== scope.principalId ||
      authorized.thread.id !== applicationThreadId
    ) {
      throw new Error("thread_messages_scope_mismatch");
    }
    requireAdmittedResource(input.environmentAuthority, {
      kind: "thread",
      id: authorized.thread.id,
      environmentId: authorized.environment.id,
      workspaceId: authorized.workspace.id,
    });
    if (authorized.thread.backingState === "unbound") {
      if (input.cursor) this.#invalidCursor();
      return { turns: [], nextCursor: null, activeTurn: null };
    }

    this.#prune();
    const entry = input.cursor ? this.#entries.get(input.cursor) : undefined;
    if (
      input.cursor &&
      (!entry ||
        entry.expiresAt <= this.#now() ||
        entry.tenantId !== scope.tenantId ||
        entry.principalId !== scope.principalId ||
        entry.applicationThreadId !== applicationThreadId ||
        entry.sourceEnvironmentId !==
          input.environmentAuthority.defaults.environmentId ||
        entry.continuationAuthorityDigest !==
          environmentAuthorityContinuationDigest(
            input.environmentAuthority,
            THREAD_MESSAGES_TOOL,
          ) ||
        entry.policyRevision !==
          input.environmentAuthority.policyIdentity.revision ||
        entry.targetEnvironmentIds.length !==
          input.environmentAuthority.targetEnvironmentIds.length ||
        entry.targetEnvironmentIds.some(
          (environmentId, index) =>
            environmentId !==
            input.environmentAuthority.targetEnvironmentIds[index],
        ) ||
        entry.pageSize !== pageSize)
    ) {
      this.#invalidCursor();
    }
    if (entry?.pending) return entry.pending;

    const operation = this.#capture(
      scope,
      applicationThreadId,
      pageSize,
      entry,
      input.environmentAuthority,
    );
    if (entry) {
      entry.pending = operation;
      try {
        const result = await entry.pending;
        if (input.cursor && this.#entries.get(input.cursor) === entry) {
          this.#entries.delete(input.cursor);
        }
        return result;
      } catch (error) {
        entry.pending = undefined;
        throw error;
      }
    }
    return operation;
  }

  async #capture(
    scope: RequestScope,
    applicationThreadId: string,
    pageSize: number,
    entry: MessagesCursorEntry | undefined,
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
  ): Promise<ThreadMessagesPage> {
    const runtime = await this.#runtimes.acquire(scope, applicationThreadId);
    try {
      const state = await runtime.actor.captureSnapshotState();
      if (entry && state.timeline.generation !== entry.projectionGeneration) {
        this.#invalidCursor();
      }
      const generation = state.timeline.generation;
      const activeTurn = entry ? undefined : this.#activeTurn(state.timeline);
      const allLiveTurns = this.#liveTurns(
        state.timeline,
        state.backendCapabilities.branching,
      );
      let liveTurns = allLiveTurns;
      if (entry?.liveThrough) {
        const boundaryIndex = allLiveTurns.findIndex(
          (turn) => turn.id === entry.liveThrough!.turnId,
        );
        if (
          boundaryIndex < 0 ||
          allLiveTurns[boundaryIndex]!.revision !==
            entry.liveThrough.turnRevision
        ) {
          this.#invalidCursor();
        }
        liveTurns = allLiveTurns.slice(0, boundaryIndex + 1);
      } else if (entry) {
        liveTurns = [];
      }

      let selected: RawTurn[];
      let liveThrough: LiveBoundary | undefined;
      let backendCursor = entry
        ? entry.backendCursor
        : state.history?.operational
          ? state.history.previousCursor
          : undefined;
      if (liveTurns.length > pageSize) {
        const splitAt = liveTurns.length - pageSize;
        selected = liveTurns.slice(splitAt);
        const boundary = liveTurns[splitAt - 1]!;
        liveThrough = { turnId: boundary.id, turnRevision: boundary.revision };
      } else {
        selected = [...liveTurns];
        const visited = new Set<string>();
        let pages = 0;
        while (selected.length < pageSize && backendCursor) {
          pages += 1;
          if (
            pages > MAXIMUM_HISTORY_SCAN_PAGES ||
            visited.has(backendCursor)
          ) {
            throw new DomainError(
              "runtime_unavailable",
              "The backend transcript cursor did not make bounded forward progress.",
              true,
            );
          }
          visited.add(backendCursor);
          const missing = pageSize - selected.length;
          const capture = await runtime.actor.history({
            cursor: backendCursor,
            limit: missing,
          });
          if (capture.generation !== generation) this.#invalidCursor();
          if (capture.page.orderedTurnIds.length > missing) {
            throw new DomainError(
              "runtime_unavailable",
              "The backend returned more transcript turns than requested.",
            );
          }
          const older = this.#historyTurns(capture.page);
          selected = [...older, ...selected];
          const previousCursor = capture.page.previousCursor;
          if (
            previousCursor &&
            (previousCursor === backendCursor ||
              capture.page.orderedTurnIds.length === 0)
          ) {
            throw new DomainError(
              "runtime_unavailable",
              "The backend transcript cursor did not make forward progress.",
              true,
            );
          }
          backendCursor = previousCursor;
        }
      }

      const nextCursor =
        liveThrough || backendCursor
          ? this.#register(scope, applicationThreadId, generation, pageSize, {
              environmentAuthority,
              ...(liveThrough ? { liveThrough } : {}),
              ...(backendCursor ? { backendCursor } : {}),
            })
          : null;
      return projectPage(selected, nextCursor, activeTurn);
    } finally {
      runtime.release();
    }
  }

  #activeTurn(timeline: ProjectedConversationTimeline): RawActiveTurn | null {
    if (!timeline.activeTurnId) return null;
    const turn = timeline.turnsById[timeline.activeTurnId];
    // A terminal turn can briefly remain referenced until the following
    // run-state event clears activeTurnId. In that atomic snapshot it belongs
    // only to settled history, so report no in-progress turn.
    if (!turn || turn.status !== "in_progress") return null;
    return rawActiveTurn(
      { ...turn, status: "in_progress" },
      timeline.itemsById,
    );
  }

  #liveTurns(
    timeline: ProjectedConversationTimeline,
    branching: Parameters<
      typeof projectedThreadForkSourceCapability
    >[0]["branching"],
  ): RawTurn[] {
    const forkSource = projectedThreadForkSourceCapability({
      branching,
      sourceRunState: timeline.runState,
    });
    return timeline.orderedTurnIds.flatMap((turnId: string) => {
      const turn = timeline.turnsById[turnId];
      if (!turn || !terminal(turn)) return [];
      return [
        rawTurn(
          turn,
          timeline.itemsById,
          projectedTurnForkCapability({
            turn,
            branching,
            sourceRunState: timeline.runState,
          }).available && forkSource.selectedCompletedTurn.available,
        ),
      ];
    });
  }

  #historyTurns(page: HistoryPage): RawTurn[] {
    return page.orderedTurnIds.flatMap((turnId) => {
      const turn = page.turnsById[turnId];
      if (!turn || !terminal(turn)) return [];
      return [
        rawTurn(
          turn,
          page.itemsById,
          page.forksByTurnId[turnId]?.available === true,
        ),
      ];
    });
  }

  #register(
    scope: RequestScope,
    applicationThreadId: string,
    projectionGeneration: string,
    pageSize: number,
    continuation: Pick<MessagesCursorEntry, "liveThrough" | "backendCursor"> & {
      readonly environmentAuthority: TrustedEnvironmentAuthorityGrant;
    },
  ): string {
    this.#prune();
    while (this.#entries.size >= this.#maximumCursors) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest);
    }
    const token = `thread_messages_${randomUUID()}`;
    this.#entries.set(token, {
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      applicationThreadId,
      sourceEnvironmentId:
        continuation.environmentAuthority.defaults.environmentId,
      targetEnvironmentIds: Object.freeze([
        ...continuation.environmentAuthority.targetEnvironmentIds,
      ]),
      continuationAuthorityDigest: environmentAuthorityContinuationDigest(
        continuation.environmentAuthority,
        THREAD_MESSAGES_TOOL,
      ),
      policyRevision: continuation.environmentAuthority.policyIdentity.revision,
      projectionGeneration,
      pageSize,
      expiresAt: this.#now() + this.#cursorLifetimeMilliseconds,
      ...(continuation.liveThrough
        ? { liveThrough: continuation.liveThrough }
        : {}),
      ...(continuation.backendCursor
        ? { backendCursor: continuation.backendCursor }
        : {}),
    });
    return token;
  }

  #prune(): void {
    const now = this.#now();
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(token);
    }
  }

  #invalidCursor(): never {
    throw new DomainError(
      "cursor_invalid",
      "The conversation transcript cursor is stale or invalid.",
    );
  }
}
