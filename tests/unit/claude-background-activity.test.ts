import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBackgroundActivity } from "../../src/server/backends/claude/claude-background-activity.js";

describe("Claude background inventory", () => {
  it("replaces complete levels, excludes ambient entries and does not pair unordered edges", () => {
    const activity = new ClaudeBackgroundActivity();
    const level = (tasks: unknown[]) => activity.consume({ type: "system", subtype: "background_tasks_changed", tasks } as SDKMessage);
    expect(activity.snapshot().state).toBe("unknown");
    activity.reset();
    level([
      { task_id: "agent", task_type: "local_agent", description: "Audit" },
      { task_id: "shell", task_type: "local_bash", description: "Test" },
      { task_id: "mcp", task_type: "mcp_task", description: "Remote work" },
      { task_id: "watcher", task_type: "local_bash", description: "Watcher", ambient: true },
    ]);
    expect(activity.snapshot()).toEqual({ state: "known", agents: 1, commands: 1, other: 1 });
    expect(activity.consume({ type: "system", subtype: "task_notification", task_id: "agent", status: "completed" } as SDKMessage)).toBe(false);
    expect(activity.snapshot().agents).toBe(1);
    level([{ task_id: "shell", task_type: "local_bash", description: "Test" }]);
    expect(activity.snapshot()).toEqual({ state: "known", agents: 0, commands: 1, other: 0, description: { text: "Test" } });
    level([]);
    expect(activity.active).toBe(false);
    expect(activity.retirementBlocked).toBe(false);
    expect(activity.pendingTaskIds()).toEqual([]);
  });

  it.each([false, true, undefined])("holds correlated top-level agents independently of initial background state %s and inventory IDs", (is_backgrounded) => {
    const activity = new ClaudeBackgroundActivity();
    const started = { type: "system", subtype: "task_started", task_id: "edge-id", task_type: "local_agent",
      tool_use_id: "call", is_backgrounded, spawn_depth: 1 } as const;
    for (const extra of [{ spawn_depth: 2 }, { task_type: "local_bash" }, { task_type: "mcp_task" },
      { task_type: "local_workflow" }, { tool_use_id: undefined },
      { ambient: true }, { skip_transcript: true }]) {
      expect(activity.observeTaskStarted({ ...started, ...extra } as Parameters<ClaudeBackgroundActivity["observeTaskStarted"]>[0])).toBe(false);
    }
    expect(activity.retirementBlocked).toBe(false);
    expect(activity.observeTaskStarted(started as Parameters<ClaudeBackgroundActivity["observeTaskStarted"]>[0])).toBe(true);
    activity.consume({ type: "system", subtype: "background_tasks_changed", tasks: [
      { task_id: "inventory-id", task_type: "local_agent" },
    ] } as SDKMessage);
    activity.consume({ type: "system", subtype: "background_tasks_changed", tasks: [] } as unknown as SDKMessage);
    expect(activity.pendingTaskIds()).toEqual(["edge-id"]);
    const recovered = new ClaudeBackgroundActivity();
    recovered.restore(activity.snapshot(), activity.pendingTaskIds());
    expect(recovered.retirementBlocked).toBe(true);
    expect(recovered.settleTask("inventory-id")).toBe(false);
    expect(recovered.settleTask("edge-id")).toBe(true);
    expect(recovered.retirementBlocked).toBe(false);
  });

  it("bounds the private settlement hold independently of visible inventory", () => {
    const activity = new ClaudeBackgroundActivity();
    expect(() => activity.restore({ state: "known", agents: 0, commands: 0, other: 0 },
      Array.from({ length: 8193 }, (_, index) => `task-${index}`))).toThrow("claude_background_task_tracking_capacity_exceeded");
    activity.invalidate();
    expect(activity.retirementBlocked).toBe(false);
  });

  it("drops stale observations at generation loss and does not resurrect them on restart", () => {
    const activity = new ClaudeBackgroundActivity();
    activity.consume({ type: "system", subtype: "background_tasks_changed", tasks: [
      { task_id: "agent", task_type: "local_agent", description: "x".repeat(10000) },
    ] } as SDKMessage);
    expect(activity.snapshot().description!.text.length).toBeLessThan(10000);
    activity.invalidate();
    expect(activity.snapshot()).toEqual({ state: "unknown", agents: 0, commands: 0, other: 0 });
    activity.reset();
    expect(activity.snapshot()).toEqual({ state: "known", agents: 0, commands: 0, other: 0 });
  });
});
