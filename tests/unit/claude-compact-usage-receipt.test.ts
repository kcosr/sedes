import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { claudeCompactUsageReceiptSchema, projectClaudeCompactUsageReceipt } from "../../src/server/backends/claude/claude-compact-usage-receipt.js";
import { claudePipelineObservation } from "../../src/server/backends/claude/claude-usage-accounting.js";

const native = {
  type: "result", subtype: "success", is_error: false, num_turns: 0,
  uuid: "11111111-1111-4111-8111-111111111111", session_id: "22222222-2222-4222-8222-222222222222",
  user_message_uuid: "33333333-3333-4333-8333-333333333333", local_command: "compact", result_index: 3,
  duration_ms: 100, duration_api_ms: 90, total_cost_usd: 0.25, result: "private output".repeat(100_000),
  stop_reason: null, permission_denials: [], structured_output: { private: "tool output" },
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, fallback_credit: null,
    inference_geo: "", iterations: [], output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: "standard", speed: "standard" },
  modelUsage: { "claude-sonnet-5-5": {
    inputTokens: 100, outputTokens: 30, cacheReadInputTokens: 20, cacheCreationInputTokens: 10,
    thinkingTokens: 8, costUSD: 0.25, canonicalModel: "claude-sonnet-5-5", provider: "firstParty", costBasis: "managed",
    contextWindow: 1_000_000, maxOutputTokens: 64_000, webSearchRequests: 0,
  } },
} satisfies SDKResultMessage;

describe("Claude compaction auxiliary accounting receipts", () => {
  it("retains exactly the evidence used by pipeline accounting and omits content", () => {
    const receipt = projectClaudeCompactUsageReceipt(native);
    expect(claudePipelineObservation(receipt, "low", "claude-sonnet-5-5"))
      .toEqual(claudePipelineObservation(native, "low", "claude-sonnet-5-5"));
    expect(JSON.stringify(receipt).length).toBeLessThan(2_000);
    for (const key of ["result", "structured_output", "permission_denials", "duration_ms"]) expect(receipt).not.toHaveProperty(key);
    expect(receipt.modelUsage["claude-sonnet-5-5"]).not.toHaveProperty("contextWindow");
  });

  it("rejects unknown fields, excess models and oversized receipts instead of retaining them", () => {
    const receipt = projectClaudeCompactUsageReceipt(native);
    expect(claudeCompactUsageReceiptSchema.safeParse({ ...receipt, structured_output: {} }).success).toBe(false);
    const model = receipt.modelUsage["claude-sonnet-5-5"]!;
    expect(claudeCompactUsageReceiptSchema.safeParse({ ...receipt, modelUsage: Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`model-${index}`, model]),
    ) }).success).toBe(false);
    expect(claudeCompactUsageReceiptSchema.safeParse({ ...receipt, modelUsage: Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`${index}${"x".repeat(1_000)}`, { ...model, canonicalModel: "x".repeat(1_024) }]),
    ) }).success).toBe(false);
    expect(claudeCompactUsageReceiptSchema.safeParse({ ...receipt, usage: { ...receipt.usage, private: "metadata" } }).success).toBe(false);
  });
});
