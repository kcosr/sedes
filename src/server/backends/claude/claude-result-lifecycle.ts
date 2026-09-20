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
