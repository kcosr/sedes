import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { backendAccountUsageSchema } from "../../src/shared/protocol/account-usage.js";
import {
  claudeAccountUsageModelKeys,
  projectClaudeAccountUsage,
} from "../../src/server/backends/claude/claude-account-usage-projection.js";

function response(rate_limits: SDKControlGetUsageResponse["rate_limits"]): SDKControlGetUsageResponse {
  return {
    rate_limits,
    rate_limits_available: true,
    subscription_type: "max",
    behaviors: null,
    session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  };
}
const reset = "2026-12-01T09:59:00-06:00";
const weekly = { utilization: 53, resets_at: reset };
const fable = { display_name: "Fable", utilization: 65, resets_at: reset };

describe("Claude subscription quota projection", () => {
  it("separates the all-models and Fable weekly windows, keeping billing and local activity private", () => {
    const usage = projectClaudeAccountUsage(response({
      seven_day: weekly, model_scoped: [fable],
      seven_day_oauth_apps: weekly,
      extra_usage: { is_enabled: true, monthly_limit: 100, utilization: 1, used_credits: 1 },
    }), 1_000);
    expect(backendAccountUsageSchema.parse(usage)).toEqual({
      capturedAt: 1_000, accountId: null, plan: "Max", includedUsageAllowed: null,
      windows: [
        { scope: { kind: "account" }, remainingPercent: 47, durationMinutes: 10_080, resetsAt: Date.parse(reset) },
        { scope: { kind: "model", label: "Fable", key: "claude:fable" }, remainingPercent: 35, durationMinutes: 10_080, resetsAt: Date.parse(reset) },
      ],
    });
  });

  it("prioritizes matching rows, bounds the payload, and keeps model-only readings", () => {
    const extras = Array.from({ length: 12 }, (_, i) => ({ ...fable, display_name: `Other ${i}` }));
    const limits = { model_scoped: [...extras, { ...fable, display_name: "Fable 5.2" }, fable] };
    const windows = projectClaudeAccountUsage(response(limits), 1_000)?.windows ?? [];
    expect(windows).toHaveLength(8);
    expect(windows.slice(0, 3).map(row => row.scope)).toEqual([
      { kind: "model", key: "claude:fable", label: "Fable" },
      { kind: "model", key: "claude:fable-5-2", label: "Fable 5.2" },
      { kind: "model", key: null, label: "Other 0" },
    ]);
  });

  it("uses finite percentages, valid resets, and distinct named windows", () => {
    const limits = {
      five_hour: { utilization: -10, resets_at: null },
      seven_day: { utilization: 101, resets_at: null },
      model_scoped: [
        { ...fable, display_name: "Opus" },
        { ...fable, display_name: "OPUS" },
        { ...fable, display_name: "No usage", utilization: NaN },
        { ...fable, display_name: "Invalid reset", resets_at: "06/07/26" },
      ],
      seven_day_opus: weekly, seven_day_sonnet: weekly,
    };
    const windows = projectClaudeAccountUsage(response(limits), 1_000)?.windows ?? [];
    expect(windows.map(row => row.remainingPercent)).toEqual([100, 0, 35, 47]);
    expect(windows.slice(2).map(row => row.scope)).toEqual([
      { kind: "model", key: null, label: "Opus" },
      { kind: "model", key: null, label: "Sonnet" },
    ]);
  });

  it("omits absent and unsupported readings, including ignored behavior opt-outs", () => {
    expect(projectClaudeAccountUsage(response(null), 1_000)).toBeNull();
    expect(projectClaudeAccountUsage(response({ seven_day: { utilization: null, resets_at: reset } }), 1_000)).toBeNull();
    const good = response({ seven_day: weekly });
    expect(projectClaudeAccountUsage({ ...good, rate_limits_available: false }, 1_000)).toBeNull();
    expect(projectClaudeAccountUsage({ ...good, behaviors: {} } as SDKControlGetUsageResponse, 1_000)).toBeNull();
  });
});

describe("Claude model quota keys", () => {
  it.each(["claude-fable-5-2", "claude-fable-5-2[1m]"])("matches %s to its version then its family", model => {
    expect(claudeAccountUsageModelKeys(model)).toEqual(["claude:fable-5-2", "claude:fable"]);
  });
  it.each(["default", "fable", "claude-fablex-5", "claude-opus-5", "us.anthropic.claude-fable-5", null])(
    "leaves %s without model-specific membership", model => {
      expect(claudeAccountUsageModelKeys(model)).toBeUndefined();
    },
  );
});
