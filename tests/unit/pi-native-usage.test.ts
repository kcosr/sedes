import { describe, expect, it, vi } from "vitest";
import { PiNativeUsageAccounting } from "../../src/server/backends/pi/native/driver/usage.js";
import { projectNativeHistory } from "../../src/server/backends/pi/native/driver/history.js";
import type { PiNativeHistory } from "../../src/server/backends/pi/native/port.js";
import type { ConversationBinding } from "../../src/server/backends/contracts.js";
import { NO_USAGE_CAPTURE, NO_USAGE_SINK, type UsageObservation } from "../../src/server/usage/contracts.js";
const timestamp = "2026-10-26T00:00:00.000Z";
const binding: ConversationBinding = { tenantId: "tenant", ownerPrincipalId: "principal", applicationThreadId: "thread", backendConversationId: "native", backendInstanceId: "backend", connectionProfileId: "connection", executionEnvironmentId: "environment", createdAt: timestamp };
const user = (id: string, parentId: string | null) => ({ id, parentId, type: "message", timestamp, message: { role: "user", timestamp: Date.parse(timestamp), content: [{ type: "text", text: "Hello" }] } });
const assistant = (id: string, parentId: string, usage = { input: 7, cacheRead: 2, cacheWrite: 3, output: 5, totalTokens: 17, cost: { total: 0.000042 } }) => ({ id, parentId, type: "message", timestamp,
  message: { role: "assistant", timestamp: Date.parse(timestamp), content: [{ type: "text", text: "Done" }], model: "model", provider: "provider", api: "openai-completions", stopReason: "stop", usage } });
function history(entries: PiNativeHistory["entries"], extra: Partial<PiNativeHistory> = {}): PiNativeHistory {
  return { sessionId: "native", sessionFile: "/agent/native.jsonl", cwd: "/work", entries, leafId: String(entries.at(-1)?.id ?? ""), operations: [], toolCalls: [], toolResults: [], inheritedEntryIds: [], inheritance: "none", ...extra };
}
function fixture(initial: PiNativeHistory) {
  const values: UsageObservation[] = [];
  const capture = { ...NO_USAGE_CAPTURE, capture: vi.fn((input: readonly UsageObservation[]) => { values.push(...input); return true; }), gap: vi.fn(), registerTurns: vi.fn(), reconcile: vi.fn(() => true), seal: vi.fn() };
  const accounting = new PiNativeUsageAccounting({ ...NO_USAGE_SINK, enabled: true, open: () => capture }, binding, "namespace", initial);
  return { values, capture, accounting };
}
describe("native Pi usage accounting", () => {
  it("captures immutable assistant usage once across live/history replay", () => {
    const source = history([user("u", null), assistant("a", "u")]); const { accounting, values, capture } = fixture(source);
    accounting.update(source, projectNativeHistory(source), "history"); accounting.update(source, projectNativeHistory(source), "live");
    expect(values).toHaveLength(1);
    expect(values[0]?.facts[0]).toMatchObject({ tokens: { input: "12", uncachedInput: "7", cacheRead: "2", cacheWrite: "3", output: "5", total: "17", requests: "1" }, turn: { backendTurnId: "u" }, models: [{ provider: "provider", model: "model" }] });
    expect(capture.gap).not.toHaveBeenCalled(); accounting.close(); expect(capture.seal).toHaveBeenCalledWith("detached");
  });
  it("excludes verified fork history while charging only child work", () => {
    const source = history([user("u", null), assistant("a", "u"), user("child-u", "a"), assistant("child-a", "child-u")], { inheritance: "verified", inheritedEntryIds: ["u", "a"], parentSessionId: "parent" });
    const { accounting, values, capture } = fixture(source); accounting.update(source, projectNativeHistory(source), "history");
    expect(values.map(value => value.id)).toEqual(["child-a:usage"]);
    expect(capture.registerTurns).toHaveBeenCalledWith(expect.any(Array), { nativeSession: "parent", turns: [{ backendTurnId: "u", sourceBackendTurnId: "u" }] });
  });
  it("records ambiguous inherited baseline instead of charging copied history", () => {
    const initial = history([user("u", null), assistant("a", "u")], { inheritance: "unknown" });
    const { accounting, values, capture } = fixture(initial); accounting.update(initial, projectNativeHistory(initial), "history");
    expect(values).toEqual([]); expect(capture.gap).toHaveBeenCalledWith("inherited_baseline_unknown");
    const next = history([...initial.entries, user("new-u", "a"), assistant("new-a", "new-u")], { inheritance: "unknown" });
    accounting.update(next, projectNativeHistory(next), "live"); expect(values.map(value => value.id)).toEqual(["new-a:usage"]);
  });
  it("does not silently accept fractional native counts", () => {
    const source = history([user("u", null), assistant("a", "u", { input: 1.5, cacheRead: 0, cacheWrite: 0, output: 1, totalTokens: 2, cost: { total: 0 } })]);
    const { accounting, capture, values } = fixture(source); accounting.update(source, projectNativeHistory(source), "history");
    expect(values).toEqual([]); expect(capture.gap).toHaveBeenCalledWith("invalid_evidence");
  });
});
