import { describe, expect, it } from "vitest";
import type { UsageAnalyticsAggregate, UsageAnalyticsResponse } from "../../shared/protocol/usage-analytics.js";
import { csvCell } from "./UsageExplore.js";
import { dimensionLabel, formatCost, formatCount, metricReported, relativeChange, tokenMix } from "./usage-format.js";

const aggregate = (overrides: Partial<UsageAnalyticsAggregate> = {}): UsageAnalyticsAggregate => ({
  tokens: "0", input: "0", uncachedInput: "0", cacheRead: "0", cacheWrite: "0", output: "0", reasoning: "0", requests: "0",
  costs: [], increments: "2", threads: "1", uncostedTokens: "0",
  missing: { input: "0", output: "0", cacheRead: "0", cacheWrite: "0", reasoning: "0", requests: "0", cost: "0" }, ...overrides,
});
const labels = {
  environment: {}, backend: { b1: { label: "Primary Pi", detail: null, kind: "pi", retired: false, workspaceId: null } }, backendKind: {},
  provider: {}, model: {}, effort: {},
  workspace: { w1: { label: "App", detail: "Laptop · /home/me/src/app", kind: null, retired: false, workspaceId: null } },
  thread: { t1: { label: "Fix it", detail: null, kind: "codex_app_server", retired: true, workspaceId: "w1" } },
  agentRole: {}, activity: {},
} satisfies UsageAnalyticsResponse["labels"];

describe("usage presentation", () => {
  it("keeps small estimates visible instead of rounding them to zero", () => {
    expect(formatCost("0.0042", "USD")).toBe("$0.0042");
    expect(formatCost("12.5", "USD")).toBe("$12.50");
    expect(formatCost("0", "USD")).toBe("$0.00");
    expect(formatCount(9_999)).toBe("9,999");
    expect(formatCount(1_250_000)).toBe("1.3M");
  });

  it("treats an unreported metric as unknown rather than zero", () => {
    expect(metricReported(aggregate({ missing: { ...aggregate().missing, requests: "2" } }), "requests")).toBe(false);
    expect(metricReported(aggregate({ missing: { ...aggregate().missing, requests: "1" } }), "requests")).toBe(true);
    expect(metricReported(aggregate(), "cost")).toBe(false);
    expect(metricReported(aggregate({ costs: [{ currency: "USD", amount: "0", kind: "estimated" }] }), "cost")).toBe(true);
  });

  it("partitions tokens into mix segments that add up to input plus output", () => {
    const mix = tokenMix({ input: 100, cacheRead: 70, cacheWrite: 10, output: 40, reasoning: 15 });
    expect(mix).toEqual({ uncached: 20, cacheRead: 70, cacheWrite: 10, output: 25, reasoning: 15 });
    expect(Object.values(mix).reduce((sum, value) => sum + value, 0)).toBe(140);
    expect(tokenMix({ input: 10, cacheRead: 30, cacheWrite: 5, output: 1, reasoning: 9 })).toEqual({ uncached: 0, cacheRead: 10, cacheWrite: 0, output: 0, reasoning: 1 });
  });

  it("labels keys from server labels and names unknown values explicitly", () => {
    expect(dimensionLabel(labels, "model", null)).toMatchObject({ label: "Unknown model", unknown: true });
    expect(dimensionLabel(labels, "effort", null).label).toBe("Not recorded");
    expect(dimensionLabel(labels, "effort", "xhigh").label).toBe("Extra high");
    expect(dimensionLabel(labels, "provider", "firstParty").label).toBe("Anthropic API");
    expect(dimensionLabel(labels, "backend", "b1")).toMatchObject({ label: "Primary Pi", brand: "pi" });
    expect(dimensionLabel(labels, "workspace", "w1").detail).toBe("Laptop · …/src/app");
    expect(dimensionLabel(labels, "thread", "t1")).toMatchObject({ label: "Fix it", detail: "App", brand: "codex", retired: true });
    expect(dimensionLabel(labels, "thread", "gone")).toMatchObject({ label: "Removed thread", unknown: true });
  });

  it("exports names as inert, quoted CSV cells", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("-1+2")).toBe("'-1+2");
    expect(csvCell("plain, with comma")).toBe("\"plain, with comma\"");
    expect(csvCell("12345")).toBe("12345");
  });

  it("reports change only against a nonzero previous period", () => {
    expect(relativeChange(150, 100)).toBe(0.5);
    expect(relativeChange(5, 0)).toBeNull();
    expect(relativeChange(5, null)).toBeNull();
  });
});
