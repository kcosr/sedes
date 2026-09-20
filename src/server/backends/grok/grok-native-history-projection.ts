import { createHash } from "node:crypto";
import { ACP_CLIENT_NOTIFICATIONS } from "../../provider-protocol/bindings/acp-v1/index.js";
import {
  GROK_XAI_NOTIFICATIONS,
  type GrokMultiplexedSessionNotification,
  type GrokStoredSessionUpdate,
} from "./grok-acp-dialect.js";
import {
  GrokHistoryProjector,
  type GrokHistoryProjectionResult,
} from "./grok-history-projector.js";
import type { GrokNativeHistoryReadResult } from "./grok-native-history-reader.js";

const CURSOR_PREFIX = "grok-native-history:v2:";
const MAXIMUM_CURSOR_BYTES = 512;

export type GrokNativeHistoryProjectionFailureCode =
  "grok_native_history_cursor_invalid" | "grok_native_history_data_invalid" |
  "grok_message_payload_too_large";

export class GrokNativeHistoryProjectionError extends Error {
  readonly code: GrokNativeHistoryProjectionFailureCode;
  readonly retryable = false;

  constructor(code: GrokNativeHistoryProjectionFailureCode) {
    super(code);
    this.name = "GrokNativeHistoryProjectionError";
    this.code = code;
  }
}

export interface GrokNativeHistoryCursorState {
  readonly epoch: string;
  readonly beforeOffset: number;
  readonly boundaryDigest: string;
  readonly promptStartsPrefixHash: string;
  readonly issuedFrontierOffset: number;
  readonly issuedFrontierDigest: string;
}

export function projectGrokNativeHistory(
  history: GrokNativeHistoryReadResult,
  input: {
    readonly nativeNamespaceKey: string;
    readonly sessionId: string;
    readonly retainedCompletedPromptWindow: number;
  },
): GrokHistoryProjector {
  const projector = new GrokHistoryProjector(input);
  for (const stored of history.updates) ingestStored(projector, stored);
  requireProjection(projector.sealReplay());
  return projector;
}

export function latestGrokNativeHistoryCursor(
  history: GrokNativeHistoryReadResult,
  input: { readonly epoch: string; readonly retainedTurns: number },
): string | undefined {
  if (history.promptStarts.length <= input.retainedTurns) return undefined;
  const beforeOffset = history.promptStarts.at(-input.retainedTurns);
  if (beforeOffset === undefined) return undefined;
  return cursorForBoundary(
    history,
    input.epoch,
    beforeOffset,
    history.totalCount - history.updates.length,
  );
}

export function latestGrokNativeHistoryCursorsByPromptId(
  history: GrokNativeHistoryReadResult,
  epoch: string,
  issuedFrontier?: { readonly offset: number; readonly digest: string },
  pageStart = history.totalCount - history.updates.length,
): Readonly<Record<string, string>> {
  if (
    !Number.isSafeInteger(pageStart) ||
    pageStart < 0 ||
    pageStart + history.updates.length > history.totalCount
  ) {
    dataInvalid();
  }
  const cursors: Record<string, string> = {};
  for (const [ordinal, beforeOffset] of history.promptStarts.entries()) {
    if (
      beforeOffset < pageStart ||
      !history.promptStarts.some((offset) => offset < beforeOffset)
    )
      continue;
    const nextOffset = history.promptStarts[ordinal + 1] ?? history.totalCount;
    const promptId = promptIdWithin(
      history.updates.slice(
        beforeOffset - pageStart,
        Math.min(nextOffset, history.totalCount) - pageStart,
      ),
    );
    if (!promptId) continue;
    cursors[promptId] = cursorForBoundary(
      history,
      epoch,
      beforeOffset,
      pageStart,
      issuedFrontier,
    );
  }
  return Object.freeze(cursors);
}

export function decodeGrokNativeHistoryCursor(
  cursor: string,
  expectedEpoch: string,
): GrokNativeHistoryCursorState {
  if (
    typeof cursor !== "string" ||
    Buffer.byteLength(cursor) > MAXIMUM_CURSOR_BYTES ||
    !cursor.startsWith(CURSOR_PREFIX)
  ) {
    invalidCursor();
  }
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    );
  } catch {
    invalidCursor();
  }
  if (!isRecord(value) || Object.keys(value).length !== 6) invalidCursor();
  const epoch = value.epoch;
  const beforeOffset = value.beforeOffset;
  const boundaryDigest = value.boundaryDigest;
  const promptStartsPrefixHash = value.promptStartsPrefixHash;
  const issuedFrontierOffset = value.issuedFrontierOffset;
  const issuedFrontierDigest = value.issuedFrontierDigest;
  if (
    epoch !== expectedEpoch ||
    !boundedDigest(epoch) ||
    !Number.isSafeInteger(beforeOffset) ||
    (beforeOffset as number) <= 0 ||
    !boundedDigest(boundaryDigest) ||
    !boundedDigest(promptStartsPrefixHash) ||
    !Number.isSafeInteger(issuedFrontierOffset) ||
    (issuedFrontierOffset as number) < (beforeOffset as number) ||
    !boundedDigest(issuedFrontierDigest)
  ) {
    invalidCursor();
  }
  return {
    epoch,
    beforeOffset: beforeOffset as number,
    boundaryDigest,
    promptStartsPrefixHash,
    issuedFrontierOffset: issuedFrontierOffset as number,
    issuedFrontierDigest,
  };
}

export function validateGrokNativeHistoryFrontier(
  history: GrokNativeHistoryReadResult,
  cursor: GrokNativeHistoryCursorState,
): void {
  if (
    history.updates.length !== 1 ||
    history.totalCount <= cursor.issuedFrontierOffset ||
    storedDigest(history.updates[0]!) !== cursor.issuedFrontierDigest
  ) {
    invalidCursor();
  }
}

export function validateGrokNativeHistoryBoundary(
  history: GrokNativeHistoryReadResult,
  cursor: GrokNativeHistoryCursorState,
): readonly number[] {
  if (
    history.updates.length !== 1 ||
    history.totalCount < cursor.beforeOffset + 1 ||
    storedDigest(history.updates[0]!) !== cursor.boundaryDigest ||
    prefixHash(history.promptStarts, cursor.beforeOffset) !==
      cursor.promptStartsPrefixHash ||
    !history.promptStarts.includes(cursor.beforeOffset)
  ) {
    invalidCursor();
  }
  return history.promptStarts.filter((offset) => offset < cursor.beforeOffset);
}

export function validateGrokNativeHistoryPage(
  history: GrokNativeHistoryReadResult,
  input: {
    readonly startOffset: number;
    readonly endOffset: number;
    readonly expectedPrefixHash: string;
  },
): void {
  if (
    history.updates.length !== input.endOffset - input.startOffset ||
    prefixHash(history.promptStarts, input.endOffset) !==
      input.expectedPrefixHash
  ) {
    dataInvalid();
  }
}

export function previousGrokNativeHistoryCursor(
  history: GrokNativeHistoryReadResult,
  input: {
    readonly epoch: string;
    readonly startOffset: number;
    readonly issuedFrontierOffset: number;
    readonly issuedFrontierDigest: string;
  },
): string | undefined {
  return history.promptStarts.some((offset) => offset < input.startOffset)
    ? cursorForBoundary(
        history,
        input.epoch,
        input.startOffset,
        input.startOffset,
        {
          offset: input.issuedFrontierOffset,
          digest: input.issuedFrontierDigest,
        },
      )
    : undefined;
}

function cursorForBoundary(
  history: GrokNativeHistoryReadResult,
  epoch: string,
  beforeOffset: number,
  pageStart: number,
  issuedFrontier?: { readonly offset: number; readonly digest: string },
): string {
  const boundary = history.updates[beforeOffset - pageStart];
  if (!boundary || !history.promptStarts.includes(beforeOffset)) dataInvalid();
  const frontierOffset = issuedFrontier?.offset ?? history.totalCount - 1;
  const frontier = history.updates[frontierOffset - pageStart];
  if (!issuedFrontier && !frontier) dataInvalid();
  const state: GrokNativeHistoryCursorState = {
    epoch,
    beforeOffset,
    boundaryDigest: storedDigest(boundary),
    promptStartsPrefixHash: prefixHash(history.promptStarts, beforeOffset),
    issuedFrontierOffset: frontierOffset,
    issuedFrontierDigest: issuedFrontier?.digest ?? storedDigest(frontier!),
  };
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(state)).toString("base64url")}`;
}

function ingestStored(
  projector: GrokHistoryProjector,
  stored: GrokStoredSessionUpdate,
): void {
  const params = replayParams(stored.params);
  if (stored.method === "session/update") {
    const notification =
      ACP_CLIENT_NOTIFICATIONS.sessionUpdate.decodeParams(params);
    if (!notification) dataInvalid();
    requireProjection(projector.ingestStandard(notification));
    return;
  }
  const decoded =
    GROK_XAI_NOTIFICATIONS.replaySessionUpdate.decodeParams(params);
  if (!decoded) dataInvalid();
  ingestMultiplexed(projector, decoded);
}

function ingestMultiplexed(
  projector: GrokHistoryProjector,
  decoded: GrokMultiplexedSessionNotification,
): void {
  if (decoded.kind === "passive_ignored") return;
  requireProjection(
    decoded.kind === "turn_completed"
      ? projector.ingestSourceCandidateTurnCompleted(decoded.notification)
      : projector.ingestSubagentEvent(decoded.event),
  );
}

function replayParams(
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const metadata = isRecord(params._meta) ? params._meta : {};
  if ("isReplay" in metadata && metadata.isReplay !== true) dataInvalid();
  return Object.freeze({
    ...params,
    _meta: Object.freeze({ ...metadata, isReplay: true }),
  });
}

function promptIdWithin(
  updates: readonly GrokStoredSessionUpdate[],
): string | undefined {
  let promptId: string | undefined;
  for (const stored of updates) {
    const update = isRecord(stored.params.update)
      ? stored.params.update
      : undefined;
    const sessionUpdate = update?.sessionUpdate;
    const ownsPromptBoundary =
      sessionUpdate === "user_message_chunk" ||
      sessionUpdate === "agent_message_chunk" ||
      sessionUpdate === "agent_thought_chunk" ||
      sessionUpdate === "turn_completed";
    if (!ownsPromptBoundary) continue;
    const metadataPromptId = isRecord(stored.params._meta)
      ? stored.params._meta.promptId
      : undefined;
    const terminalPromptId =
      sessionUpdate === "turn_completed" ? update?.prompt_id : undefined;
    const candidate =
      typeof terminalPromptId === "string"
        ? terminalPromptId
        : typeof metadataPromptId === "string"
          ? metadataPromptId
          : undefined;
    if (!candidate) continue;
    if (promptId !== undefined && promptId !== candidate) dataInvalid();
    promptId = candidate;
  }
  return promptId;
}

function requireProjection(result: GrokHistoryProjectionResult): void {
  if (
    result.kind === "resnapshot_required" &&
    result.reason === "grok_message_payload_too_large"
  ) {
    throw new GrokNativeHistoryProjectionError(result.reason);
  }
  if (result.kind === "resnapshot_required") dataInvalid();
}

function storedDigest(stored: GrokStoredSessionUpdate): string {
  return digest("boundary", JSON.stringify(stored));
}

function prefixHash(
  promptStarts: readonly number[],
  beforeOffset: number,
): string {
  return digest(
    "prompt-starts-prefix",
    JSON.stringify(promptStarts.filter((offset) => offset < beforeOffset)),
  );
}

function digest(domain: string, value: string): string {
  return (
    createHash("sha256")
      // Persisted cursors depend on this opaque format domain. It intentionally
      // retains the historical spelling across the product rename.
      .update(`harness.grok.native-history.${domain}.v1\n`)
      .update(value)
      .digest("base64url")
  );
}

function boundedDigest(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function invalidCursor(): never {
  throw new GrokNativeHistoryProjectionError(
    "grok_native_history_cursor_invalid",
  );
}

function dataInvalid(): never {
  throw new GrokNativeHistoryProjectionError(
    "grok_native_history_data_invalid",
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
