import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** Claude exposes these external inputs even when it marks them as meta. */
export function claudeMessageHasVisibleExternalOrigin(origin: unknown): boolean {
  if (typeof origin !== "object" || origin === null || !("kind" in origin)) return false;
  return origin.kind === "peer" || origin.kind === "channel" || origin.kind === "observer" ||
    origin.kind === "observer-activity" || origin.kind === "slack-ping";
}

/** Explicit child output cannot establish parent input acceptance or activity. */
export function claudeMessageIsChildOwned(message: SDKMessage): boolean {
  return (message.type === "user" || message.type === "assistant" || message.type === "stream_event") &&
    (typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id.length > 0 ||
     "subagent_type" in message && typeof message.subagent_type === "string" && message.subagent_type.length > 0);
}
