import { describe, expect, it } from "vitest";

import {
  decodeGrokSubagentEvent,
  GrokSubagentReducer,
  type GrokSubagentEvent,
} from "../../src/server/backends/grok/grok-subagent-reducer.js";

function notification(
  update: Record<string, unknown>,
  input: { readonly replay?: true; readonly promptId?: string } = {},
): unknown {
  return {
    sessionId: "parent-session",
    update,
    _meta: {
      eventId: `event-${String(update.sessionUpdate)}`,
      ...(input.replay ? { isReplay: true } : {}),
      ...(input.promptId ? { promptId: input.promptId } : {}),
    },
  };
}

function spawned(overrides: Record<string, unknown> = {}): unknown {
  return notification(
    {
      sessionUpdate: "subagent_spawned",
      subagent_id: "child-session",
      parent_session_id: "parent-session",
      parent_prompt_id: "prompt-1",
      child_session_id: "child-session",
      subagent_type: "reviewer",
      description: "Review the change",
      effective_context_source: "new",
      context_normalized: false,
      capability_mode: "read-only",
      additive_future_field: true,
      ...overrides,
    },
    { promptId: "prompt-1" },
  );
}

function progress(overrides: Record<string, unknown> = {}): unknown {
  return {
    sessionId: "parent-session",
    update: {
      sessionUpdate: "subagent_progress",
      subagent_id: "child-session",
      parent_session_id: "parent-session",
      child_session_id: "child-session",
      duration_ms: 100,
      turn_count: 1,
      tool_call_count: 2,
      tokens_used: 300,
      context_window_tokens: 1_000,
      context_usage_pct: 30,
      tools_used: ["Read", "Bash"],
      error_count: 0,
      ...overrides,
    },
  };
}

function finished(
  status: "completed" | "failed" | "cancelled",
  overrides: Record<string, unknown> = {},
  promptId?: string,
): unknown {
  return notification(
    {
      sessionUpdate: "subagent_finished",
      subagent_id: "child-session",
      child_session_id: "child-session",
      status,
      tool_calls: 3,
      turns: 2,
      duration_ms: 200,
      tokens_used: 400,
      will_wake: false,
      ...overrides,
    },
    promptId === undefined ? {} : { promptId },
  );
}

function decode(value: unknown): GrokSubagentEvent {
  const decoded = decodeGrokSubagentEvent(value, { replay: false });
  if (!decoded) throw new Error("expected decoded event");
  return decoded;
}

function reducer(): GrokSubagentReducer {
  return new GrokSubagentReducer({
    nativeNamespaceKey: "grok-native:test",
    sessionId: "parent-session",
  });
}

describe("Grok private subagent reducer", () => {
  it("decodes exact spawned, progress, and finished source shapes", () => {
    expect(decode(spawned())).toMatchObject({
      kind: "spawned",
      parentPromptId: "prompt-1",
      subagentType: "reviewer",
    });
    expect(decode(progress())).toMatchObject({
      kind: "progress",
      contextUsagePercent: 30,
      toolsUsed: ["Read", "Bash"],
    });
    expect(
      decode(finished("completed", { output: "Looks good" }, "prompt-1")),
    ).toMatchObject({
      kind: "finished",
      promptId: "prompt-1",
      outcome: "completed",
      output: "Looks good",
    });
  });

  it("enforces replay, correlation, bounds, counters, and terminal status", () => {
    expect(
      decodeGrokSubagentEvent(spawned(), { replay: true }),
    ).toBeUndefined();
    expect(
      decodeGrokSubagentEvent(
        notification(
          {
            ...(spawned() as { update: Record<string, unknown> }).update,
          },
          { replay: true, promptId: "prompt-1" },
        ),
        { replay: true },
      ),
    ).toBeDefined();
    expect(
      decodeGrokSubagentEvent(spawned({ child_session_id: "other" }), {
        replay: false,
      }),
    ).toBeDefined();
    const mismatchedSpawn = decode(
      spawned({
        subagent_id: "subagent-handle",
        child_session_id: "child-session",
      }),
    );
    expect(reducer().ingest(mismatchedSpawn)).toEqual({
      kind: "invalid",
      reason: "identity_mismatch",
    });
    expect(
      decodeGrokSubagentEvent(progress({ context_usage_pct: 101 }), {
        replay: false,
      }),
    ).toBeUndefined();
    const liveProgress = progress() as Record<string, unknown>;
    expect(
      decodeGrokSubagentEvent(
        { ...liveProgress, _meta: { eventId: "invented-progress-id" } },
        { replay: false },
      ),
    ).toBeUndefined();
    expect(
      decodeGrokSubagentEvent(progress(), { replay: true }),
    ).toBeUndefined();
    expect(
      decodeGrokSubagentEvent(finished("failed", { status: "unknown" }), {
        replay: false,
      }),
    ).toBeUndefined();
    expect(
      decodeGrokSubagentEvent(spawned({ description: "x".repeat(65_537) }), {
        replay: false,
      }),
    ).toBeDefined();
  });

  it("keeps one stable sanitized collaboration projection and compacts progress", () => {
    const state = reducer();
    const spawn = state.ingest(decode(spawned()));
    expect(spawn).toMatchObject({
      kind: "applied",
      projection: {
        promptId: "prompt-1",
        item: {
          semanticKind: "collaboration",
          status: "streaming",
          action: "spawn",
          agentLabel: { text: "reviewer" },
          summary: { text: "Review the change" },
        },
      },
    });
    if (spawn.kind !== "applied") throw new Error("spawn not applied");
    const activityId = spawn.projection.activityId;
    expect(activityId).toBe(
      "grok-activity:f32cf64e10890b548ae462338fcf658bdc7d3d1c9f378dd52667193d165432ef",
    );

    const firstProgress = state.ingest(decode(progress()));
    const latestProgress = state.ingest(
      decode(progress({ duration_ms: 250, turn_count: 2, tool_call_count: 4 })),
    );
    expect(firstProgress).toMatchObject({
      kind: "applied",
      projection: { activityId },
    });
    expect(latestProgress).toMatchObject({
      kind: "applied",
      projection: {
        activityId,
        item: {
          status: "streaming",
          action: "status",
          summary: { text: expect.stringContaining("2 turns · 4 tool calls") },
        },
      },
    });
    expect(state.projection("child-session")).toEqual(
      latestProgress.kind === "applied" ? latestProgress.projection : undefined,
    );
    expect(JSON.stringify(state.projection("child-session"))).not.toContain(
      "child-session",
    );
  });

  it("ignores exact duplicate and regressive progress frontiers", () => {
    const state = reducer();
    state.ingest(decode(spawned()));

    expect(state.ingest(decode(progress()))).toMatchObject({ kind: "applied" });
    expect(state.ingest(decode(progress()))).toEqual({
      kind: "ignored",
      reason: "duplicate_or_regressive",
    });
    expect(
      state.ingest(
        decode(
          progress({
            duration_ms: 99,
            turn_count: 2,
            tool_call_count: 3,
            tokens_used: 301,
          }),
        ),
      ),
    ).toEqual({
      kind: "ignored",
      reason: "duplicate_or_regressive",
    });
    expect(
      state.ingest(
        decode(
          progress({
            duration_ms: 101,
            turn_count: 2,
            tool_call_count: 3,
            tokens_used: 1,
          }),
        ),
      ),
    ).toMatchObject({ kind: "applied" });
  });

  it("explicitly releases retained private state", () => {
    const state = reducer();
    const spawn = state.ingest(decode(spawned()));
    if (spawn.kind !== "applied") throw new Error("spawn not applied");
    expect(state.retainedStateCount).toBe(1);
    expect(state.releaseActivity(spawn.projection.activityId)).toBe(true);
    expect(state.retainedStateCount).toBe(0);
    expect(state.projection("child-session")).toBeUndefined();
    expect(state.releaseActivity(spawn.projection.activityId)).toBe(false);
    expect(state.release("child-session")).toBe(false);
  });

  it("returns to zero across many spawn, finish, and release cycles", () => {
    const state = reducer();
    for (let index = 0; index < 500; index += 1) {
      const subagentId = `child-${index}`;
      state.ingest(
        decode(
          spawned({
            subagent_id: subagentId,
            child_session_id: subagentId,
          }),
        ),
      );
      state.ingest(
        decode(
          finished("completed", {
            subagent_id: subagentId,
            child_session_id: subagentId,
          }),
        ),
      );
      expect(state.release(subagentId)).toBe(true);
    }
    expect(state.retainedStateCount).toBe(0);
  });

  it("bounds oversized presentation without rejecting healthy private events", () => {
    const state = reducer();
    const largeDescription = "x".repeat(100_000);
    const spawn = state.ingest(
      decode(spawned({ description: largeDescription })),
    );
    expect(spawn).toMatchObject({
      kind: "applied",
      projection: {
        item: {
          summary: {
            truncation: { truncated: true, reason: "byte_limit" },
          },
        },
      },
    });
    const tools = Array.from({ length: 300 }, (_, index) => `tool-${index}`);
    const update = state.ingest(decode(progress({ tools_used: tools })));
    expect(update).toMatchObject({
      kind: "applied",
      projection: {
        item: {
          summary: { text: expect.stringContaining("+284 more") },
        },
      },
    });
  });

  it.each([
    ["completed", "completed", undefined, "Looks good"],
    ["failed", "failed", "grok_subagent_failed", "Review failed"],
    ["cancelled", "interrupted", "grok_subagent_cancelled", undefined],
  ] as const)(
    "maps %s to a truthful terminal collaboration state",
    (outcome, status, code, output) => {
      const state = reducer();
      state.ingest(decode(spawned()));
      const result = state.ingest(
        decode(
          finished(outcome, {
            ...(output ? { output } : {}),
            ...(outcome === "failed" ? { error: "Review failed" } : {}),
          }),
        ),
      );
      expect(result).toMatchObject({
        kind: "applied",
        projection: {
          item: {
            status,
            action: "result",
            ...(code ? { error: { code } } : {}),
          },
        },
      });
      const regressive = state.ingest(decode(progress({ duration_ms: 999 })));
      expect(regressive).toEqual({
        kind: "ignored",
        reason: "duplicate_or_regressive",
      });
    },
  );

  it("rejects identity changes and ignores events without an authoritative spawn", () => {
    const state = reducer();
    expect(state.ingest(decode(progress()))).toEqual({
      kind: "ignored",
      reason: "missing_spawn",
    });
    const uncorrelated = spawned() as {
      sessionId: string;
      update: Record<string, unknown>;
    };
    expect(
      state.ingest(
        decode({
          ...uncorrelated,
          update: { ...uncorrelated.update, parent_prompt_id: undefined },
          _meta: { eventId: "uncorrelated-spawn" },
        }),
      ),
    ).toEqual({ kind: "ignored", reason: "uncorrelated_spawn" });

    const correlated = reducer();
    correlated.ingest(decode(spawned()));
    expect(
      correlated.ingest(decode(finished("completed", {}, "other-prompt"))),
    ).toEqual({ kind: "invalid", reason: "identity_mismatch" });
    expect(
      correlated.ingest(
        decode(progress({ child_session_id: "different-child" })),
      ),
    ).toEqual({ kind: "invalid", reason: "identity_mismatch" });

    const boundedCollision = reducer();
    const sharedPrefix = "x".repeat(100_000);
    boundedCollision.ingest(
      decode(spawned({ description: `${sharedPrefix}-first` })),
    );
    expect(
      boundedCollision.ingest(
        decode(spawned({ description: `${sharedPrefix}-second` })),
      ),
    ).toEqual({ kind: "invalid", reason: "identity_mismatch" });
  });
});
