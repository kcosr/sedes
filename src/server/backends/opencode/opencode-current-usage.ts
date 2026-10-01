import type { UsageSnapshot } from "../../../shared/protocol/conversation.js";
import type { OpenCodeModelCatalogRead } from "./opencode-model-catalog.js";
import type { OpenCodeNativeMessage, OpenCodeNativeSession } from "./opencode-native-api.js";

/** Live context and retained-branch counters, independent of recorded accounting.
 * The context anchor follows stock 2.0.18's TUI: the latest reported assistant
 * usage after compaction, before a staged revert. It is not a sum of requests
 * or an estimate of unmeasured new inputs/tool results. */
export function projectOpenCodeCurrentUsage(input: {
  readonly messages: readonly OpenCodeNativeMessage[];
  readonly session: Pick<OpenCodeNativeSession, "model" | "revert">;
  readonly catalog?: OpenCodeModelCatalogRead;
}): UsageSnapshot {
  const boundary = input.session.revert?.messageID;
  const end = boundary ? input.messages.findIndex(message => message.id === boundary) : input.messages.length;
  // A missing branch boundary cannot establish which records are still active.
  if (end < 0) return {};
  const counters = { userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, compactions: 0 };
  let last: Extract<OpenCodeNativeMessage, { type: "assistant" }> | undefined;
  for (let index = 0; index < end; index++) {
    const message = input.messages[index]!;
    if (message.type === "user") counters.userMessages++;
    if (message.type === "compaction" && message.status === "completed") {
      counters.compactions++;
      last = undefined;
    }
    if (message.type === "model-switched") last = undefined;
    if (message.type !== "assistant") continue;
    counters.assistantMessages++;
    if (message.tokens !== undefined) last = message;
    const calls = new Set<string>();
    for (const part of message.content) {
      if (part.type !== "tool" || part.state.status === "streaming" || calls.has(part.id)) continue;
      calls.add(part.id);
      counters.toolCalls++;
      if (part.state.status === "completed" || part.state.status === "error") counters.toolResults++;
    }
  }
  // Native idle/system/selection rows and tool parts are not separate messages.
  counters.totalMessages = counters.userMessages + counters.assistantMessages;
  const selected = input.session.model;
  if (selected && last && (selected.providerID !== last.model.providerID || selected.id !== last.model.id)) last = undefined;
  const model = last?.model ?? selected;
  const descriptor = model
    ? [...(input.catalog?.modelsById.values() ?? [])].find(value => value.providerID === model.providerID && value.id === model.id)
    : input.catalog?.modelsById.get(input.catalog.catalog.models.find(value => value.isDefault)?.id ?? "");
  const windowTokens = descriptor?.limit.context;
  if (!validCount(windowTokens) || windowTokens === 0) return { counters };
  const tokens = last?.tokens;
  const components = tokens && [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write];
  // In this pinned native contract output is visible output, separate from
  // reasoning, and input excludes both cache categories. All five are disjoint.
  const total = components?.every(validCount) ? components.reduce((sum, count) => sum + count, 0) : undefined;
  const usedTokens = validCount(total) && total > 0 ? total : undefined;
  return { counters, context: { windowTokens,
    ...(usedTokens === undefined ? {} : { usedTokens, percent: usedTokens / windowTokens * 100 }) } };
}

function validCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}
