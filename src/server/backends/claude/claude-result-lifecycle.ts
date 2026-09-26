import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

/** Provider-native receipt identities; queued sends may share one result. */
export function claudeResultUserMessageIds(
  message: { readonly user_message_uuid?: string; readonly user_message_uuids?: readonly string[] },
): string[] {
  return [
    ...new Set([
      ...(message.user_message_uuids ?? []),
      ...(message.user_message_uuid ? [message.user_message_uuid] : []),
    ]),
  ];
}

export type ClaudeCommandLifecycleState =
  | "queued" | "started" | "completed" | "cancelled" | "discarded" | "refused";
const COMMAND_LIFECYCLE_STATES: ReadonlySet<string> = new Set<ClaudeCommandLifecycleState>([
  "queued", "started", "completed", "cancelled", "discarded", "refused",
]);
const COMMAND_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Claude Code's stream-json lifecycle frame for a uuid-stamped input. The SDK
 * forwards it verbatim but does not type it. `queued` proves native admission;
 * `started` is emitted when a turn dequeues the input or folds it into the
 * running turn, before any model request. `refused` means the session's
 * receive-side policy declined the input before queueing it: it is not
 * preceded by `queued` and never runs in this session. Any other shape is not
 * evidence.
 */
export function claudeCommandLifecycle(message: unknown): {
  readonly commandUuid: string;
  readonly state: ClaudeCommandLifecycleState;
} | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const frame = message as Record<string, unknown>;
  if (frame.type !== "command_lifecycle" || typeof frame.command_uuid !== "string" ||
      !COMMAND_UUID.test(frame.command_uuid) || typeof frame.state !== "string" ||
      !COMMAND_LIFECYCLE_STATES.has(frame.state)) return undefined;
  return { commandUuid: frame.command_uuid, state: frame.state as ClaudeCommandLifecycleState };
}

/** A background queue receipt cannot settle an unrelated application turn. */
export function claudeResultIsUnrelated(
  message: SDKResultMessage,
  expectedUserMessageIds: readonly string[],
): boolean {
  // 2.1.274 batches task notifications: intermediate entries get empty,
  // zero-round-trip success receipts. The same result shape also occurs for
  // legitimate foreground commands, so require native background provenance.
  if (
    message.origin?.kind === "task-notification" &&
    message.subtype === "success" &&
    !message.is_error &&
    message.num_turns === 0 &&
    message.result === ""
  )
    return true;
  const identities = claudeResultUserMessageIds(message);
  return (
    identities.length > 0 &&
    !identities.some((id) => expectedUserMessageIds.includes(id))
  );
}
