import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** Explicit child output cannot establish parent input acceptance or activity. */
export function claudeMessageIsChildOwned(message: SDKMessage): boolean {
  return (message.type === "user" || message.type === "assistant" || message.type === "stream_event") &&
    (typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id.length > 0 ||
     "subagent_type" in message && typeof message.subagent_type === "string" && message.subagent_type.length > 0);
}
