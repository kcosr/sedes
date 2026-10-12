import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().finite().nonnegative();
const label = z.string().max(1_024);
const modelUsageSchema = z.strictObject({
  inputTokens: count, outputTokens: count, cacheReadInputTokens: count, cacheCreationInputTokens: count,
  costUSD: amount, thinkingTokens: count.optional(), provider: label.optional(), canonicalModel: label.optional(),
  costBasis: z.enum(["list", "managed", "unknown"]).optional(),
});

/** Exact auxiliary accounting evidence; no transcript, tools, or unknown fields. */
export const claudeCompactUsageReceiptSchema = z.strictObject({
  type: z.literal("result"),
  subtype: z.enum(["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]),
  is_error: z.boolean(), num_turns: count,
  uuid: z.string().uuid(), session_id: z.string().uuid(),
  user_message_uuid: z.string().uuid().optional(), user_message_uuids: z.array(z.string().uuid()).min(1).max(64).optional(),
  result_index: count.optional(), local_command: z.literal("compact").optional(), total_cost_usd: amount,
  usage: z.strictObject({ input_tokens: count, output_tokens: count, cache_creation_input_tokens: count, cache_read_input_tokens: count }),
  modelUsage: z.record(label, modelUsageSchema).refine(value => Object.keys(value).length <= 64),
}).refine(value => value.user_message_uuid !== undefined || value.user_message_uuids !== undefined)
  .refine(value => Buffer.byteLength(JSON.stringify(value)) <= 64 * 1_024, "A compact accounting receipt must fit in 64 KiB.");

export type ClaudeCompactUsageReceipt = z.infer<typeof claudeCompactUsageReceiptSchema>;

export function projectClaudeCompactUsageReceipt(message: SDKResultMessage): ClaudeCompactUsageReceipt {
  const models = Object.fromEntries(Object.entries(message.modelUsage).map(([model, usage]) => [model, {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens, costUSD: usage.costUSD,
    ...(usage.thinkingTokens !== undefined ? { thinkingTokens: usage.thinkingTokens } : {}),
    ...(usage.provider !== undefined ? { provider: usage.provider } : {}),
    ...(usage.canonicalModel !== undefined ? { canonicalModel: usage.canonicalModel } : {}),
    ...(usage.costBasis !== undefined ? { costBasis: usage.costBasis } : {}),
  }]));
  return claudeCompactUsageReceiptSchema.parse({
    type: message.type, subtype: message.subtype, is_error: message.is_error, num_turns: message.num_turns,
    uuid: message.uuid, session_id: message.session_id, total_cost_usd: message.total_cost_usd, modelUsage: models,
    ...(message.user_message_uuid ? { user_message_uuid: message.user_message_uuid } : {}),
    ...(message.user_message_uuids ? { user_message_uuids: [...message.user_message_uuids] } : {}),
    ...(message.result_index !== undefined ? { result_index: message.result_index } : {}),
    ...("local_command" in message && message.local_command === "compact" ? { local_command: "compact" } : {}),
    usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens,
      cache_creation_input_tokens: message.usage.cache_creation_input_tokens, cache_read_input_tokens: message.usage.cache_read_input_tokens },
  });
}
