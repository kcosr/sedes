import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCompactOperations } from "../../src/server/backends/claude/claude-compact-operation.js";

const operationId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const input = { operationId, instructions: "Keep the pending task" };
const frame = (value: unknown) => value as SDKMessage;
const lifecycle = (state: string, id = operationId) => frame({ type: "command_lifecycle", command_uuid: id, state });
const boundary = (trigger = "manual") => frame({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger } });
const summary = frame({ type: "user", parent_tool_use_id: null, isSynthetic: true, uuid: secondId, message: { content: "Summary" } });
const receipt = { type: "result", subtype: "success", is_error: false, num_turns: 0,
  uuid: "33333333-3333-4333-8333-333333333333", session_id: "44444444-4444-4444-8444-444444444444",
  user_message_uuid: operationId, local_command: "compact", total_cost_usd: 0.1, result_index: 2,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {} };
const result = frame({ ...receipt, result: "", duration_ms: 1, duration_api_ms: 1,
  permission_denials: [], structured_output: { large: "never retained" } });
const commandFailure = (text: string) => frame({ type: "assistant", parent_tool_use_id: null,
  message: { model: "<synthetic>" }, local_command_run: { command: "compact", args: "Keep the pending task" },
  local_command_source: `<local-command-stderr>${text}</local-command-stderr>`, local_command_outcome: { kind: "failed" } });

describe("Claude's dedicated compact operation journal", () => {
  it("requires manual boundary, delivered summary and a terminal receipt, and replays exact fingerprints", async () => {
    const operations = new ClaudeCompactOperations();
    const submit = vi.fn();
    const pending = operations.run(input, submit);
    expect(operations.run(input, submit)).toBe(pending);
    expect(submit).toHaveBeenCalledExactlyOnceWith("/compact Keep the pending task");
    const delivered: SDKMessage[] = [];
    const consume = (message: SDKMessage) => operations.consume(message, async () => { delivered.push(message); });
    await consume(lifecycle("queued")); await consume(lifecycle("started"));
    expect(operations.reconcile(input)).toEqual({ outcome: "unknown", pending: true });
    await consume(boundary());
    expect(await consume(frame({ ...summary, origin: { kind: "peer", peer_id: "external" } }))).toBe(false);
    expect(await consume(frame({ ...summary, agent_id: "child-agent" }))).toBe(false);
    let settle = false;
    void pending.then(() => { settle = true; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const delivery = operations.consume(summary, async () => { await gate; delivered.push(summary); });
    await Promise.resolve();
    expect(settle).toBe(false);
    release(); await delivery;
    expect(settle).toBe(false);
    await consume(result);
    await expect(pending).resolves.toEqual({ outcome: "compacted", nativeResult: receipt });
    await consume(lifecycle("completed"));
    expect(delivered).toEqual([boundary(), summary]);
    expect(operations.reconcile(input)).toEqual({ outcome: "accepted", pending: false, nativeResult: receipt });
    await expect(operations.run(input, submit)).resolves.toMatchObject({ outcome: "compacted" });
    expect(submit).toHaveBeenCalledOnce();
    await expect(operations.run({ ...input, instructions: "Different" }, submit)).rejects.toMatchObject({
      backendCode: "claude_compact_operation_conflict", crossedSubmissionBoundary: false });
    expect(operations.reconcile({ ...input, instructions: "Different" })).toEqual({ outcome: "unknown", pending: true });
  });

  it("retains the auxiliary accounting receipt when lifecycle completion precedes it", async () => {
    const operations = new ClaudeCompactOperations();
    const pending = operations.run(input, vi.fn());
    let settled = false;
    void pending.then(() => { settled = true; });
    const deliver = vi.fn(async () => undefined);
    await operations.consume(lifecycle("started"), deliver);
    await operations.consume(boundary(), deliver);
    await operations.consume(summary, deliver);
    await operations.consume(lifecycle("completed"), deliver);
    expect(settled).toBe(false);
    await operations.consume(result, deliver);
    await expect(pending).resolves.toEqual({ outcome: "compacted", nativeResult: receipt });
  });

  it("recognizes the pinned CLI's insufficient-history command failure as a successful no-op", async () => {
    const operations = new ClaudeCompactOperations();
    const pending = operations.run(input, vi.fn());
    const deliver = vi.fn(async () => undefined);
    await operations.consume(lifecycle("started"), deliver);
    await operations.consume(commandFailure("Error: No messages to compact"), deliver);
    await operations.consume(result, deliver);
    await expect(pending).resolves.toEqual({ outcome: "noop", message: "Error: No messages to compact", nativeResult: receipt });
    expect(deliver).not.toHaveBeenCalled();
    expect(operations.reconcile(input)).toEqual({ outcome: "accepted", pending: false, nativeResult: receipt });
  });

  it("does not accept a task notification as the manual boundary's summary", async () => {
    const operations = new ClaudeCompactOperations();
    const pending = operations.run(input, vi.fn());
    const rejected = expect(pending).rejects.toMatchObject({ backendCode: "claude_compact_completion_unproven" });
    const deliver = vi.fn(async () => undefined);
    await operations.consume(lifecycle("started"), deliver);
    await operations.consume(boundary(), deliver);
    expect(await operations.consume(frame({ ...summary, origin: { kind: "task-notification" } }), deliver)).toBe(false);
    await operations.consume(result, deliver);
    await rejected;
    expect(operations.reconcile(input)).toMatchObject({ outcome: "unknown", pending: false });
  });

  it("does not accept successful result envelopes or completed lifecycle without compaction evidence", async () => {
    const operations = new ClaudeCompactOperations();
    const pending = operations.run(input, vi.fn());
    const rejection = expect(pending).rejects.toMatchObject({ backendCode: "claude_compact_completion_unproven", crossedSubmissionBoundary: true });
    await operations.consume(lifecycle("started"), async () => undefined);
    await operations.consume(result, async () => undefined);
    await rejection;
    expect(operations.reconcile(input)).toEqual({ outcome: "unknown", pending: false, nativeResult: receipt });
    expect(operations.busy).toBe(false);
    const submit = vi.fn();
    await expect(operations.run(input, submit)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(submit).not.toHaveBeenCalled();
    const next = operations.run({ operationId: secondId }, submit);
    const cleanup = expect(next).rejects.toMatchObject({ backendCode: "claude_compact_owner_lost" });
    expect(submit).toHaveBeenCalledOnce();
    operations.ownerLost(); await cleanup;
  });

  it("retains known summary failure despite Claude's successful local-command result envelope", async () => {
    const operations = new ClaudeCompactOperations();
    const pending = operations.run(input, vi.fn());
    const rejection = expect(pending).rejects.toMatchObject({ backendCode: "claude_compact_failed", crossedSubmissionBoundary: false, nativeResult: receipt });
    await operations.consume(lifecycle("started"), async () => undefined);
    await operations.consume(commandFailure("Error during compaction: API Error: 400 fixture"), async () => undefined);
    await operations.consume(result, async () => undefined);
    await rejection;
    expect(operations.reconcile(input)).toMatchObject({ outcome: "not_applied", pending: false });
    expect(operations.busy).toBe(false);
  });

  it("never attributes automatic compaction or an unrelated result to a manual command", async () => {
    const operations = new ClaudeCompactOperations();
    const pending = operations.run(input, vi.fn());
    const rejection = expect(pending).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await operations.consume(lifecycle("started"), async () => undefined);
    expect(await operations.consume(boundary("auto"), async () => undefined)).toBe(false);
    expect(await operations.consume(frame({ ...result, user_message_uuid: secondId }), async () => undefined)).toBe(false);
    await operations.consume(lifecycle("completed"), async () => undefined);
    await rejection;
  });

  it.each(["cancelled", "discarded", "refused"])("records %s before command start as not applied", async state => {
    const operations = new ClaudeCompactOperations();
    const pending = operations.run(input, vi.fn());
    const rejection = expect(pending).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    await operations.consume(lifecycle(state), async () => undefined);
    await rejection;
    expect(operations.reconcile(input)).toMatchObject({ outcome: "not_applied", pending: false });
  });

  it("keeps owner loss unknown after submission, and submission refusal not applied", async () => {
    const lost = new ClaudeCompactOperations();
    const pending = lost.run(input, vi.fn());
    const rejected = expect(pending).rejects.toMatchObject({ backendCode: "claude_compact_owner_lost", crossedSubmissionBoundary: true });
    lost.ownerLost(); await rejected;
    expect(lost.reconcile(input)).toEqual({ outcome: "unknown", pending: false });
    const refused = new ClaudeCompactOperations();
    await expect(refused.run(input, () => { throw new Error("queue full"); })).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(refused.reconcile(input)).toMatchObject({ outcome: "not_applied", pending: false });
  });

  it("reclaims refused payload slots while retaining exact UUID tombstones", async () => {
    const operations = new ClaudeCompactOperations();
    const first = { operationId: "00000000-0000-4000-8000-000000000000" };
    for (let ordinal = 0; ordinal < 300; ordinal += 1) {
      const operationId = `00000000-0000-4000-8000-${ordinal.toString(16).padStart(12, "0")}`;
      await expect(operations.run({ operationId }, () => { throw new Error("queue full"); })).rejects.toMatchObject({
        backendCode: "claude_compact_not_submitted", crossedSubmissionBoundary: false });
    }
    const redispatch = vi.fn();
    await expect(operations.run(first, redispatch)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(redispatch).not.toHaveBeenCalled();
    expect(operations.reconcile(first)).toEqual({ outcome: "not_applied", pending: false });
    const next = operations.run(input, vi.fn());
    const cleanup = expect(next).rejects.toMatchObject({ backendCode: "claude_compact_owner_lost" });
    operations.ownerLost(); await cleanup;
  });

  it("settles an owner-lost waiter after exact lifecycle completion while awaiting usage", async () => {
    const operations = new ClaudeCompactOperations();
    const pending = operations.run(input, vi.fn());
    const rejected = expect(pending).rejects.toMatchObject({ backendCode: "claude_compact_owner_lost", crossedSubmissionBoundary: true });
    const deliver = vi.fn(async () => undefined);
    await operations.consume(lifecycle("started"), deliver);
    await operations.consume(boundary(), deliver);
    await operations.consume(summary, deliver);
    await operations.consume(lifecycle("completed"), deliver);
    operations.ownerLost(); await rejected;
    expect(operations.reconcile(input)).toEqual({ outcome: "unknown", pending: false });
  });

  it("suppresses only the dedicated command's native local output and preserves ordinary events", async () => {
    const operations = new ClaudeCompactOperations();
    const pending = operations.run(input, vi.fn());
    const rejected = expect(pending).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    const deliver = vi.fn(async () => undefined);
    await operations.consume(lifecycle("started"), deliver);
    expect(await operations.consume(frame({ type: "user", isReplay: true, message: { content: "<local-command-stdout>Compacted </local-command-stdout>" } }), deliver)).toBe(true);
    expect(await operations.consume(frame({ type: "system", subtype: "session_state_changed", state: "running" }), deliver)).toBe(true);
    expect(await operations.consume(frame({ type: "system", subtype: "task_progress" }), deliver)).toBe(false);
    const permissionStatus = frame({ type: "system", subtype: "status", status: "compacting", permissionMode: "plan" });
    expect(await operations.consume(permissionStatus, deliver)).toBe(true);
    expect(deliver).toHaveBeenCalledOnce();
    expect(await operations.consume(frame({ type: "assistant", parent_tool_use_id: "child-tool", message: { content: [] } }), deliver)).toBe(false);
    expect(await operations.consume(frame({ type: "assistant", parent_tool_use_id: null, message: { content: [] } }), deliver)).toBe(false);
    expect(await operations.consume(frame({ type: "user", uuid: secondId, message: { content: "actual input" } }), deliver)).toBe(false);
    operations.ownerLost(); await rejected;
  });
});
