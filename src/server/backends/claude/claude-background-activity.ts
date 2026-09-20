import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundActivity } from "../../../shared/protocol/background-activity.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";

/** Generation-volatile inventory. Bookend ordering never mutates the level snapshot. */
export class ClaudeBackgroundActivity {
  readonly #pendingTaskOutcomes = new Set<string>();
  #snapshot: BackgroundActivity = { state: "unknown", agents: 0, commands: 0, other: 0 };

  reset(): void { this.#pendingTaskOutcomes.clear(); this.#snapshot = { state: "known", agents: 0, commands: 0, other: 0 }; }
  invalidate(): void { this.#pendingTaskOutcomes.clear(); this.#snapshot = { state: "unknown", agents: 0, commands: 0, other: 0 }; }
  /** An attachment snapshot from the runtime that owns this exact live query. */
  restore(snapshot: BackgroundActivity, pendingTaskIds: readonly string[]): void {
    this.#pendingTaskOutcomes.clear();
    for (const taskId of pendingTaskIds) this.#awaitOutcome(taskId);
    this.#snapshot = structuredClone(snapshot);
  }

  observeTaskStarted(message: Extract<SDKMessage, { type: "system"; subtype: "task_started" }>): boolean {
    // Foreground agents can move to the background later. Hold every eligible
    // launch until its outcome is durable, independently of that transition.
    if (message.ambient || message.skip_transcript ||
        message.task_type !== "local_agent" || !message.tool_use_id ||
        (message.spawn_depth !== undefined && message.spawn_depth !== 1)) return false;
    const wasPending = this.#pendingTaskOutcomes.has(message.task_id);
    this.#awaitOutcome(message.task_id);
    return !wasPending;
  }

  /** Release only after a terminal bookend has been applied durably. */
  settleTask(taskId: string): boolean { return this.#pendingTaskOutcomes.delete(taskId); }
  pendingTaskIds(): readonly string[] { return [...this.#pendingTaskOutcomes]; }
  get retirementBlocked(): boolean { return this.#pendingTaskOutcomes.size > 0; }

  #awaitOutcome(taskId: string): void {
    if (taskId.length < 1 || taskId.length > 512 ||
        (!this.#pendingTaskOutcomes.has(taskId) && this.#pendingTaskOutcomes.size >= 8192)) {
      throw new Error("claude_background_task_tracking_capacity_exceeded");
    }
    this.#pendingTaskOutcomes.add(taskId);
  }

  consume(message: SDKMessage): boolean {
    if (message.type !== "system" || message.subtype !== "background_tasks_changed") return false;
    // Inventory IDs are not correlated with edge IDs. Only exact top-level
    // starts awaiting durable receipts can hold cleanup after a level empties.
    const tasks = message.tasks.filter(task => !task.ambient);
    let agents = 0, commands = 0, other = 0;
    for (const task of tasks) {
      if (task.task_type === "local_agent") agents++;
      else if (task.task_type === "local_bash") commands++;
      else other++;
    }
    this.#snapshot = {
      state: "known",
      agents, commands, other,
      ...(tasks.length === 1 && tasks[0]!.description
        ? { description: boundDisplayText(tasks[0]!.description) } : {}),
    };
    return true;
  }

  snapshot(): BackgroundActivity { return structuredClone(this.#snapshot); }

  get active(): boolean { return this.#snapshot.agents + this.#snapshot.commands + this.#snapshot.other > 0; }
}
