import { createHash } from "node:crypto";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeTaskLifecycleReceipt } from "./claude-thread-repository.js";

/**
 * Provider-private evidence for one Claude fork: which rows of the child copy
 * the retained source prefix, which rows Claude Code appended itself, and
 * which background tasks the child can truthfully inherit.
 */

const SYNTHETIC_NO_RESPONSE_TEXT = "No response requested.";
const MAXIMUM_APPENDED_ROWS = 256;

/** Content identity of a native chain, independent of per-session row UUIDs. */
export function claudeTranscriptContentFingerprint(
  messages: readonly SessionMessage[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(messages.map(contentIdentity)))
    .digest("base64url");
}

function contentIdentity(message: SessionMessage) {
  return {
    type: message.type,
    parentToolUseId: message.parent_tool_use_id,
    parentAgentId: message.parent_agent_id,
    origin: "origin" in message ? message.origin : undefined,
    message: message.message,
  };
}

export interface ClaudeTaskNotification {
  readonly taskId: string;
  readonly toolUseId?: string;
  readonly status: string;
}

/**
 * Parse Claude Code's model-visible task notification row: a user row with
 * exactly `{ kind: "task-notification" }` provenance whose content is one
 * `<task-notification>` envelope naming a task and its status.
 */
export function parseClaudeTaskNotification(
  message: SessionMessage,
): ClaudeTaskNotification | undefined {
  if (message.type !== "user") return undefined;
  const origin = (message as { readonly origin?: unknown }).origin;
  if (
    typeof origin !== "object" ||
    origin === null ||
    Object.keys(origin).length !== 1 ||
    (origin as { readonly kind?: unknown }).kind !== "task-notification"
  ) {
    return undefined;
  }
  const body = message.message as { readonly role?: unknown; readonly content?: unknown } | undefined;
  const content = body?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) && content.length === 1 &&
        (content[0] as { type?: unknown }).type === "text" &&
        typeof (content[0] as { text?: unknown }).text === "string"
      ? (content[0] as { text: string }).text
      : undefined;
  if (body?.role !== "user" || text === undefined) return undefined;
  const envelope = text.trimEnd();
  if (!envelope.startsWith("<task-notification>") || !envelope.endsWith("</task-notification>")) return undefined;
  const taskId = singleElement(envelope, "task-id");
  const status = singleElement(envelope, "status");
  const toolUseId = singleElement(envelope, "tool-use-id");
  if (!taskId || !status || !/^[a-z_]{1,32}$/u.test(status) || toolUseId === "") return undefined;
  return { taskId, status, ...(toolUseId ? { toolUseId } : {}) };
}

/** Exactly one bounded, tag-free element value; absent returns undefined. */
function singleElement(text: string, name: string): string | undefined {
  const matches = [...text.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "gu"))];
  if (matches.length === 0) return undefined;
  const value = matches.length === 1 ? matches[0]![1]!.trim() : "";
  return value.length <= 512 ? value : "";
}

function isSyntheticNoResponse(message: SessionMessage): boolean {
  if (message.type !== "assistant") return false;
  const body = message.message as { readonly model?: unknown; readonly content?: unknown } | undefined;
  const content = body?.content;
  return body?.model === "<synthetic>" && Array.isArray(content) && content.length === 1 &&
    (content[0] as { type?: unknown }).type === "text" &&
    (content[0] as { text?: unknown }).text === SYNTHETIC_NO_RESPONSE_TEXT;
}

export interface ClaudeForkChildVerification {
  /** Background tasks launched in the prefix that Claude reported unfinished. */
  readonly omittedTasks: readonly ClaudeTaskNotification[];
  /** Child row UUIDs of those provider-appended notifications. */
  readonly omittedTaskNotificationUuids: readonly string[];
}

/** Why a fork child's history is not the verified retained prefix. */
export class ClaudeForkHistoryMismatchError extends Error {
  constructor(readonly detail: string) {
    super(`claude_fork_history_mismatch: ${detail}`);
    this.name = "ClaudeForkHistoryMismatchError";
  }
}

/**
 * The child must begin with an exact content copy of the retained prefix.
 * After it, Claude Code may append only transcript-only notifications for
 * background tasks that the prefix launched and never saw finish, and
 * `<synthetic>` "No response requested." rows from later launches. Each
 * appended row is validated by its exact shape; anything else fails.
 */
export function verifyClaudeForkChild(input: {
  readonly childMessages: readonly SessionMessage[];
  readonly sourcePrefix: readonly SessionMessage[];
  readonly retainedContentDigest: string;
}): ClaudeForkChildVerification {
  const { childMessages, sourcePrefix } = input;
  const retained = sourcePrefix.length;
  if (childMessages.length < retained) {
    throw new ClaudeForkHistoryMismatchError(
      `expected ${retained} retained messages, found ${childMessages.length}${firstDifference(sourcePrefix, childMessages)}`,
    );
  }
  if (claudeTranscriptContentFingerprint(childMessages.slice(0, retained)) !== input.retainedContentDigest) {
    throw new ClaudeForkHistoryMismatchError(
      `the first ${retained} messages differ from the retained prefix${firstDifference(sourcePrefix, childMessages)}`,
    );
  }
  const appended = childMessages.slice(retained);
  if (appended.length > MAXIMUM_APPENDED_ROWS) {
    throw new ClaudeForkHistoryMismatchError(`${appended.length} rows follow the retained prefix`);
  }
  const finished = new Set<string>();
  for (const message of sourcePrefix) {
    const notification = parseClaudeTaskNotification(message);
    if (notification) finished.add(notification.taskId);
  }
  const omittedTasks: ClaudeTaskNotification[] = [];
  const omittedTaskNotificationUuids: string[] = [];
  for (const [offset, message] of appended.entries()) {
    const notification = parseClaudeTaskNotification(message);
    if (notification && !finished.has(notification.taskId) &&
        !omittedTasks.some(task => task.taskId === notification.taskId)) {
      omittedTasks.push(notification);
      omittedTaskNotificationUuids.push(message.uuid);
      continue;
    }
    if (isSyntheticNoResponse(message)) continue;
    throw new ClaudeForkHistoryMismatchError(
      `unexpected ${message.type} row ${message.uuid} at index ${retained + offset} after the retained prefix`,
    );
  }
  return { omittedTasks, omittedTaskNotificationUuids };
}

function firstDifference(source: readonly SessionMessage[], child: readonly SessionMessage[]): string {
  const length = Math.min(source.length, child.length);
  for (let index = 0; index < length; index++) {
    if (JSON.stringify(contentIdentity(source[index]!)) !== JSON.stringify(contentIdentity(child[index]!))) {
      return `; first difference at index ${index} (source ${source[index]!.uuid}, child ${child[index]!.uuid})`;
    }
  }
  return source.length === child.length ? "" : `; first difference at index ${length}`;
}

/**
 * Task receipts the child inherits. A task Claude reported unfinished in the
 * child is never carried. Otherwise its terminal status needs evidence inside
 * the prefix: a notification naming it, or the ordinary result of a launch
 * that did not ask to run in the background.
 */
export function claudeForkCarriedTaskReceipts(input: {
  readonly sourcePrefix: readonly SessionMessage[];
  readonly receipts: readonly ClaudeTaskLifecycleReceipt[];
  readonly omittedTasks: readonly ClaudeTaskNotification[];
}): readonly ClaudeTaskLifecycleReceipt[] {
  const background = new Map<string, boolean>();
  const results = new Set<string>();
  const notifiedTasks = new Set<string>();
  const notifiedToolUses = new Set<string>();
  for (const message of input.sourcePrefix) {
    if (message.parent_tool_use_id !== null) continue;
    const notification = parseClaudeTaskNotification(message);
    if (notification) {
      notifiedTasks.add(notification.taskId);
      if (notification.toolUseId) notifiedToolUses.add(notification.toolUseId);
      continue;
    }
    const content = (message.message as { readonly content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as readonly Record<string, unknown>[]) {
      if (message.type === "assistant" && block.type === "tool_use" && typeof block.id === "string") {
        const request = block.input as { readonly run_in_background?: unknown } | undefined;
        background.set(block.id, request?.run_in_background === true);
      } else if (message.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
        results.add(block.tool_use_id);
      }
    }
  }
  const omitted = new Set(input.omittedTasks.map(task => task.taskId));
  return input.receipts.flatMap((receipt) => {
    if (!background.has(receipt.nativeToolUseId) || omitted.has(receipt.nativeTaskId)) return [];
    if (receipt.terminalStatus === null) return [];
    const evidence = notifiedTasks.has(receipt.nativeTaskId) ||
      notifiedToolUses.has(receipt.nativeToolUseId) ||
      (background.get(receipt.nativeToolUseId) === false && results.has(receipt.nativeToolUseId));
    return evidence ? [receipt] : [];
  });
}
