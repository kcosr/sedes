import { describe, expect, it } from "vitest";
import type { CodexThreadItem } from "../../src/server/backends/codex/codex-c1-protocol.js";
import { codexSubagentActivitySummary } from "../../src/server/backends/codex/codex-subagent-presentation.js";

const item: Extract<CodexThreadItem, { type: "subAgentActivity" }> = {
  type: "subAgentActivity", id: "activity", kind: "started",
  agentThreadId: "private-child", agentPath: "/root/reviewer",
  model: "gpt-6.1-sol", reasoningEffort: "ultra",
};

describe("Codex subagent settings presentation", () => {
  it("hides both settings only for a known exact match", () => {
    expect(codexSubagentActivitySummary(item, {
      model: "gpt-6.1-sol", reasoningEffort: "ultra",
    })).toBe("Started `/root/reviewer`");
    expect(codexSubagentActivitySummary({ ...item, model: " gpt-6.1-sol " }, {
      model: "gpt-6.1-sol", reasoningEffort: "ultra",
    })).toBe("Started `/root/reviewer` · gpt-6.1-sol · ultra");
  });

  it.each([
    { model: "gpt-6.1-sol", reasoningEffort: "low" },
    { model: "gpt-6-sol", reasoningEffort: "ultra" },
    { model: "gpt-6.1-sol", reasoningEffort: null },
    null,
    undefined,
  ])("shows both when either differs or parent evidence is unknown: %j", (parent) => {
    expect(codexSubagentActivitySummary(item, parent))
      .toBe("Started `/root/reviewer` · gpt-6.1-sol · ultra");
  });

  it("labels missing child values truthfully and preserves an absent suffix", () => {
    expect(codexSubagentActivitySummary({ ...item, model: null }, null))
      .toBe("Started `/root/reviewer` · Model unknown · ultra");
    expect(codexSubagentActivitySummary({ ...item, reasoningEffort: null }, null))
      .toBe("Started `/root/reviewer` · gpt-6.1-sol · Reasoning unknown");
    expect(codexSubagentActivitySummary({ ...item, model: null, reasoningEffort: null }, null))
      .toBe("Started `/root/reviewer`");
  });

  it("preserves native effort identifiers and keeps both fields within one bounded line", () => {
    const text = codexSubagentActivitySummary({ ...item, kind: "completed",
      agentPath: `\n${"x".repeat(5_000)}\tchild`, model: `\n${"m".repeat(2_000)}\n`,
      reasoningEffort: "xhigh" }, null);
    expect(text).toMatch(/^Completed `x+…` · m+… · xhigh$/u);
    expect(text.length).toBeLessThan(4_096);
    expect(text).not.toContain("private-child");
  });

  it("displays future native effort names without treating them as a known parent match", () => {
    expect(codexSubagentActivitySummary({ ...item, reasoningEffort: "future_effort" }, null))
      .toBe("Started `/root/reviewer` · gpt-6.1-sol · future_effort");
    const bounded = codexSubagentActivitySummary({ ...item,
      agentPath: "x".repeat(5_000), model: "m".repeat(2_000),
      reasoningEffort: `future\n${"e".repeat(2_000)}` }, null);
    expect(bounded.length).toBeLessThan(4_096);
    expect(bounded).not.toContain("\n");
    expect(bounded).toContain(" · future ");
  });
});
