import type { SessionNotification } from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GrokSourceCandidateTurnCompletedNotification } from "../../src/server/backends/grok/grok-acp-dialect.js";
import { GrokHistoryProjector } from "../../src/server/backends/grok/grok-history-projector.js";
import { projectGrokLatestHistory } from "../../src/server/backends/grok/grok-normalized-history.js";
import type { GrokSubagentEvent } from "../../src/server/backends/grok/grok-subagent-reducer.js";
import { MAXIMUM_MESSAGE_TEXT_BYTES } from "../../src/shared/protocol/payload.js";

describe("Grok oversized live messages", () => {
  it.each(["user_message_chunk", "agent_message_chunk"] as const)(
    "invalidates %s accumulation and rejects all later events",
    (kind) => {
      const history = projector();
      history.sealReplay();
      const first = "x".repeat(MAXIMUM_MESSAGE_TEXT_BYTES / 2);
      expect(history.ingestStandard(textUpdate({
        event: "part-1", promptId: "prompt-1", kind, text: first,
      })).kind).toBe("accepted");
      expect(history.records()).toHaveLength(1);
      const failure = history.ingestStandard(textUpdate({
        event: "part-2", promptId: "prompt-1", kind, text: first,
      }));
      expect(failure).toEqual({
        kind: "resnapshot_required", reason: "grok_message_payload_too_large",
      });
      expect(history.records()).toEqual([]);
      expect(history.ingestStandard(textUpdate({
        event: "part-3", promptId: "prompt-1", kind, text: "late text",
      }))).toBe(failure);
      expect(history.ingestSourceCandidateTurnCompleted(terminal({
        event: "terminal", promptId: "prompt-1",
      }))).toBe(failure);
    },
  );

  it("fails closed when the first live chunk exceeds the serialized byte ceiling", () => {
    const history = projector();
    history.sealReplay();
    expect(history.ingestStandard(textUpdate({
      event: "oversized", promptId: "prompt-1",
      text: "\u0000".repeat(Math.floor(MAXIMUM_MESSAGE_TEXT_BYTES / 6)),
    }))).toEqual({
      kind: "resnapshot_required", reason: "grok_message_payload_too_large",
    });
    expect(history.records()).toEqual([]);
  });
});

function projector(retainedCompletedPromptWindow?: number) {
  return new GrokHistoryProjector({
    nativeNamespaceKey: "grok-store:tenant-principal",
    sessionId: "session-1",
    ...(retainedCompletedPromptWindow === undefined
      ? {}
      : { retainedCompletedPromptWindow }),
  });
}

function textUpdate(input: {
  event: string;
  text: string;
  kind?: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
  replay?: true;
  promptId?: string;
}): SessionNotification {
  return {
    sessionId: "session-1",
    update: {
      sessionUpdate: input.kind ?? "agent_message_chunk",
      content: { type: "text", text: input.text },
    },
    _meta: {
      eventId: input.event,
      ...(input.replay ? { isReplay: true } : {}),
      ...(input.promptId ? { promptId: input.promptId } : {}),
    },
  };
}

function terminal(input: {
  event: string;
  promptId?: string;
  replay?: true;
  stopReason?: string;
  agentTimestampMs?: number;
}): GrokSourceCandidateTurnCompletedNotification {
  const promptId = input.promptId ?? "prompt-1";
  return {
    sessionId: "session-1",
    update: {
      sessionUpdate: "turn_completed",
      prompt_id: promptId,
      stop_reason: input.stopReason ?? "end_turn",
      agent_result: null,
    },
    _meta: {
      eventId: input.event,
      promptId,
      ...(input.replay ? { isReplay: true } : {}),
      ...(input.agentTimestampMs !== undefined
        ? { agentTimestampMs: input.agentTimestampMs }
        : {}),
    },
  };
}

function toolUpdate(input: {
  event?: string;
  promptId?: string;
  toolCallId?: string;
  replay?: true;
  update?: Record<string, unknown>;
}): SessionNotification {
  return {
    sessionId: "session-1",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: input.toolCallId ?? "tool-1",
      ...input.update,
    },
    _meta: {
      ...(input.event ? { eventId: input.event } : {}),
      ...(input.promptId ? { promptId: input.promptId } : {}),
      ...(input.replay ? { isReplay: true } : {}),
    },
  } as SessionNotification;
}

function planUpdate(input: {
  event?: string;
  promptId?: string;
  replay?: true;
  entries: Array<{
    content: string;
    priority: "high" | "medium" | "low";
    status: "pending" | "in_progress" | "completed";
    _meta?: Record<string, unknown>;
  }>;
}): SessionNotification {
  return {
    sessionId: "session-1",
    update: { sessionUpdate: "plan", entries: input.entries },
    ...(input.event || input.promptId || input.replay
      ? {
          _meta: {
            ...(input.event ? { eventId: input.event } : {}),
            ...(input.promptId ? { promptId: input.promptId } : {}),
            ...(input.replay ? { isReplay: true } : {}),
          },
        }
      : {}),
  } as SessionNotification;
}

function subagentSpawned(
  promptId = "prompt-1",
  replay = false,
  childSessionId = "private-child",
): GrokSubagentEvent {
  return {
    kind: "spawned",
    sessionId: "session-1",
    subagentId: childSessionId,
    childSessionId,
    parentSessionId: "session-1",
    parentPromptId: promptId,
    subagentType: "reviewer",
    description: "Review the change",
    eventId: `${promptId}-spawn`,
    replay,
  };
}

function subagentProgress(
  childSessionId = "private-child",
  overrides: Partial<Extract<GrokSubagentEvent, { kind: "progress" }>> = {},
): GrokSubagentEvent {
  return {
    kind: "progress",
    sessionId: "session-1",
    subagentId: childSessionId,
    childSessionId,
    parentSessionId: "session-1",
    replay: false,
    durationMs: 10,
    turnCount: 1,
    toolCallCount: 2,
    tokensUsed: 3,
    contextWindowTokens: 100,
    contextUsagePercent: 3,
    toolsUsed: ["Read"],
    omittedToolCount: 0,
    errorCount: 0,
    ...overrides,
  };
}

function subagentFinished(
  outcome: "completed" | "failed" | "cancelled" = "completed",
  childSessionId = "private-child",
  eventId = "finish-1",
): GrokSubagentEvent {
  return {
    kind: "finished",
    sessionId: "session-1",
    subagentId: childSessionId,
    childSessionId,
    eventId,
    replay: false,
    outcome,
    toolCalls: 2,
    turns: 1,
    durationMs: 20,
    tokensUsed: 4,
    output: outcome === "completed" ? "Looks good" : undefined,
    willWake: false,
  };
}

describe("Grok source-candidate windowed replay/live history projector", () => {
  it("compacts live subagent progress and terminal state into one stable collaboration", () => {
    const history = projector();
    history.sealReplay();
    const spawned = history.ingestSubagentEvent(subagentSpawned());
    const spawnRecord =
      spawned.kind === "accepted" ? spawned.record : undefined;
    expect(spawnRecord).toMatchObject({
      kind: "collaboration",
      status: "streaming",
      action: "spawn",
    });
    const progressed = history.ingestSubagentEvent(subagentProgress());
    expect(progressed).toMatchObject({
      kind: "accepted",
      record: { status: "streaming", action: "status" },
    });
    expect(
      history.ingestSubagentEvent(
        subagentProgress("private-child", { durationMs: 9 }),
      ),
    ).toEqual({ kind: "ignored" });
    const finished = history.ingestSubagentEvent(subagentFinished());
    expect(finished).toMatchObject({
      kind: "accepted",
      record: {
        status: "completed",
        action: "result",
        summary: { text: "Looks good" },
      },
    });
    const records = history
      .records()
      .filter((record) => record.kind === "collaboration");
    expect(records).toHaveLength(1);
    expect(records[0]?.identity.blockId).toBe(spawnRecord?.identity.blockId);
    expect(JSON.stringify(records)).not.toContain("private-child");
  });

  it("detects conflicting durable subagent terminals outside the reducer", () => {
    const history = projector();
    history.sealReplay();
    history.ingestSubagentEvent(subagentSpawned());
    history.ingestSubagentEvent(subagentFinished("completed"));
    expect(
      history.ingestSubagentEvent(subagentFinished("failed", "private-child")),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "conflicting_event_identity",
    });

    const distinctEvent = projector();
    distinctEvent.sealReplay();
    distinctEvent.ingestSubagentEvent(subagentSpawned());
    distinctEvent.ingestSubagentEvent(subagentFinished("completed"));
    expect(
      distinctEvent.ingestSubagentEvent(
        subagentFinished("failed", "private-child", "finish-2"),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "conflicting_collaboration_terminal",
    });
  });

  it("keeps active collaboration hidden off-window and releases it at settlement", () => {
    const history = projector(1);
    history.sealReplay();
    history.ingestSubagentEvent(subagentSpawned("p1"));
    history.ingestSourceCandidateTurnCompleted(
      terminal({ event: "p1-terminal", promptId: "p1" }),
    );
    history.ingestStandard(
      textUpdate({ event: "p2-text", text: "next", promptId: "p2" }),
    );
    history.ingestSourceCandidateTurnCompleted(
      terminal({ event: "p2-terminal", promptId: "p2" }),
    );
    expect(history.diagnostics()).toMatchObject({
      offWindowCollaborationPromptCount: 1,
      retainedSubagentStateCount: 1,
    });
    expect(
      history.records().some((record) => record.identity.promptId === "p1"),
    ).toBe(false);
    expect(history.ingestSubagentEvent(subagentFinished())).toEqual({
      kind: "accepted",
    });
    expect(history.diagnostics()).toMatchObject({
      offWindowCollaborationPromptCount: 0,
      retainedSubagentStateCount: 0,
    });
  });

  it("clears independent off-window tool and collaboration markers in settlement order", () => {
    const history = projector(1);
    history.sealReplay();
    history.ingestSubagentEvent(subagentSpawned("p1"));
    history.ingestStandard(
      toolUpdate({
        event: "p1-tool-start",
        promptId: "p1",
        update: { title: "Background work", status: "in_progress" },
      }),
    );
    history.ingestSourceCandidateTurnCompleted(
      terminal({ event: "p1-terminal", promptId: "p1" }),
    );
    history.ingestStandard(
      textUpdate({ event: "p2-text", text: "next", promptId: "p2" }),
    );
    history.ingestSourceCandidateTurnCompleted(
      terminal({ event: "p2-terminal", promptId: "p2" }),
    );
    expect(history.diagnostics()).toMatchObject({
      offWindowToolPromptCount: 1,
      offWindowCollaborationPromptCount: 1,
    });

    expect(
      history.ingestStandard(
        toolUpdate({
          update: { status: "completed", rawOutput: { result: "done" } },
        }),
      ),
    ).toEqual({ kind: "accepted" });
    expect(history.diagnostics()).toMatchObject({
      offWindowToolPromptCount: 0,
      offWindowCollaborationPromptCount: 1,
      retainedSubagentStateCount: 1,
    });

    expect(history.ingestSubagentEvent(subagentFinished())).toEqual({
      kind: "accepted",
    });
    expect(history.diagnostics()).toMatchObject({
      offWindowToolPromptCount: 0,
      offWindowCollaborationPromptCount: 0,
      retainedSubagentStateCount: 0,
    });
  });

  it("compacts durable Plan replacements and settles the common item at the terminal", () => {
    const history = projector();
    expect(
      history.ingestStandard(
        planUpdate({
          event: "plan-1",
          promptId: "p1",
          replay: true,
          entries: [
            { content: "Inspect", priority: "high", status: "in_progress" },
            { content: "Remove me", priority: "low", status: "pending" },
          ],
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    const firstDiagnostics = history.diagnostics();
    expect(
      history.ingestStandard(
        planUpdate({
          event: "plan-2",
          promptId: "p1",
          replay: true,
          entries: [
            { content: "Implement", priority: "medium", status: "in_progress" },
            {
              content: "Obsolete",
              priority: "low",
              status: "completed",
              _meta: { cancelled: true },
            },
          ],
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(
      history.ingestSourceCandidateTurnCompleted(
        terminal({ event: "terminal", promptId: "p1", replay: true }),
      ),
    ).toMatchObject({ kind: "accepted" });
    history.sealReplay();

    const plans = history.records().filter((record) => record.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      replacement: {
        eventId: "plan-2",
        entries: [
          { text: { text: "Implement" }, status: "in_progress" },
          { text: { text: "Obsolete" }, status: "cancelled" },
        ],
      },
    });
    expect(history.diagnostics()).toMatchObject({ retainedRecordCount: 2 });
    expect(history.diagnostics().retainedBytes).toBeLessThan(
      firstDiagnostics.retainedBytes + 4_096,
    );

    const item = Object.values(
      projectGrokLatestHistory(history.records()).snapshot.itemsById,
    ).find((candidate) => candidate.semanticKind === "plan");
    expect(item).toMatchObject({
      semanticKind: "plan",
      status: "completed",
      entries: [
        { text: { text: "Implement" }, status: "completed" },
        { text: { text: "Obsolete" }, status: "cancelled" },
      ],
    });
  });

  it("publishes a durable live Plan as streaming before turn terminal", () => {
    const history = projector();
    history.sealReplay();
    expect(
      history.ingestStandard(
        planUpdate({
          event: "live-plan",
          promptId: "p1",
          entries: [
            { content: "Implement", priority: "medium", status: "in_progress" },
            {
              content: "Obsolete",
              priority: "low",
              status: "completed",
              _meta: { cancelled: true },
            },
          ],
        }),
      ),
    ).toMatchObject({ kind: "accepted" });

    const item = Object.values(
      projectGrokLatestHistory(history.records()).snapshot.itemsById,
    ).find((candidate) => candidate.semanticKind === "plan");
    expect(item).toMatchObject({
      semanticKind: "plan",
      status: "streaming",
      entries: [
        { text: { text: "Implement" }, status: "in_progress" },
        { text: { text: "Obsolete" }, status: "cancelled" },
      ],
    });
  });

  it("ignores only metadata-free transient Plan cleanup", () => {
    const history = projector();
    expect(
      history.ingestStandard(
        planUpdate({
          entries: [
            { content: "Done", priority: "medium", status: "completed" },
          ],
        }),
      ),
    ).toEqual({ kind: "ignored" });
    expect(history.records()).toEqual([]);

    expect(
      history.ingestStandard(
        planUpdate({
          event: "partial-plan",
          entries: [
            { content: "Done", priority: "medium", status: "completed" },
          ],
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "malformed_known_history_dependency",
    });
  });

  it("retains a valid terminal timestamp and rejects an unrepresentable one", () => {
    const history = projector();
    expect(
      history.ingestSourceCandidateTurnCompleted(
        terminal({
          event: "terminal-time",
          replay: true,
          agentTimestampMs: 1_775_000_000_000,
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(history.sealReplay()).toMatchObject({ kind: "accepted" });
    expect(history.records()).toMatchObject([
      { kind: "turn_completed", completedAtMs: 1_775_000_000_000 },
    ]);

    expect(
      projector().ingestSourceCandidateTurnCompleted(
        terminal({
          event: "terminal-time-invalid",
          agentTimestampMs: 8_640_000_000_000_001,
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "malformed_known_history_dependency",
    });
  });

  it("retains sparse tool updates under one stable block with relative display locations", () => {
    const history = projector();
    expect(
      history.ingestStandard(
        toolUpdate({
          event: "tool-start",
          promptId: "p1",
          replay: true,
          update: {
            title: "Inspect repository",
            name: "read_file",
            kind: "read",
            status: "in_progress",
            rawInput: { path: "src/example.ts" },
            locations: [{ path: "src/example.ts", line: 7 }],
            _meta: {
              "x.ai/tool": {
                version: 1,
                name: "read_file",
                kind: "read",
                namespace: "grok_build",
                label: "Read",
                read_only: true,
                input: { path: "src/example.ts", offset: 7 },
              },
            },
          },
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(
      history.ingestStandard(
        toolUpdate({
          event: "tool-finish",
          replay: true,
          update: {
            status: "completed",
            content: [
              {
                type: "content",
                content: { type: "text", text: "file contents" },
              },
            ],
            rawOutput: { bytes: 13 },
          },
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    history.sealReplay();

    const tools = history.records().filter((record) => record.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      toolCallId: "tool-1",
      patch: {
        title: "Inspect repository",
        name: "read_file",
        toolKind: "read",
        status: "completed",
        locations: [{ path: "src/example.ts", line: 7 }],
        rawOutput: { bytes: 13 },
        canonicalToolMetadata: {
          version: 1,
          name: "read_file",
          kind: "read",
          namespace: "grok_build",
          label: "Read",
          readOnly: true,
          input: { path: "src/example.ts", offset: 7 },
        },
      },
    });

    const reused = projector();
    reused.sealReplay();
    expect(
      reused.ingestStandard(
        toolUpdate({
          event: "first-prompt-tool",
          promptId: "first-prompt",
          update: { status: "completed" },
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(
      reused.ingestSourceCandidateTurnCompleted(
        terminal({ event: "first-terminal", promptId: "first-prompt" }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(
      reused.ingestStandard(
        toolUpdate({
          event: "second-prompt-tool",
          promptId: "second-prompt",
          update: { status: "in_progress" },
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
  });

  it("reads tool taxonomy only from nested update metadata and leaves presentation sizing to shared projection", () => {
    const history = projector();
    const rootOnly = toolUpdate({
      event: "root-only-taxonomy",
      promptId: "p1",
      replay: true,
      update: {
        title: "x".repeat(64 * 1_024 + 1),
        status: "completed",
        rawInput: { command: "pwd" },
      },
    }) as SessionNotification & { _meta: Record<string, unknown> };
    rootOnly._meta["x.ai/tool"] = {
      version: 1,
      name: "run_terminal_cmd",
      kind: "execute",
      namespace: "grok_build",
      label: "Run Command",
      read_only: false,
      input: { command: "pwd" },
    };
    expect(history.ingestStandard(rootOnly)).toMatchObject({
      kind: "accepted",
    });
    history.sealReplay();
    const record = history
      .records()
      .find((candidate) => candidate.kind === "tool");
    expect(record).toMatchObject({
      patch: { status: "completed", rawInput: { command: "pwd" } },
    });
    expect(
      record?.kind === "tool" ? record.patch.canonicalToolMetadata : undefined,
    ).toBeUndefined();
  });

  it("binds a live eventless sparse patch only to an open correlated tool", () => {
    const history = projector();
    history.sealReplay();
    expect(
      history.ingestStandard(
        toolUpdate({
          event: "tool-start",
          promptId: "p1",
          update: { title: "Run", status: "in_progress" },
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(
      history.ingestStandard(
        toolUpdate({ update: { rawOutput: { progress: 1 } } }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(history.records()).toMatchObject([
      {
        kind: "tool",
        identity: { promptId: "p1" },
        patch: {
          title: "Run",
          status: "in_progress",
          rawOutput: { progress: 1 },
        },
      },
    ]);

    const unknown = projector();
    unknown.sealReplay();
    expect(
      unknown.ingestStandard(toolUpdate({ update: { status: "in_progress" } })),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "malformed_known_history_dependency",
    });

    const replay = projector();
    expect(
      replay.ingestStandard(
        toolUpdate({
          event: "replay-start",
          promptId: "p1",
          replay: true,
          update: { status: "in_progress" },
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(
      replay.ingestStandard(
        toolUpdate({ replay: true, update: { rawOutput: { progress: 1 } } }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "malformed_known_history_dependency",
    });
  });

  it("allows same-terminal enrichment and rejects terminal status changes", () => {
    const enriched = projector();
    enriched.ingestStandard(
      toolUpdate({
        event: "completed",
        promptId: "p1",
        replay: true,
        update: { title: "Run", status: "completed" },
      }),
    );
    expect(
      enriched.ingestStandard(
        toolUpdate({
          event: "output",
          promptId: "p1",
          replay: true,
          update: {
            status: "completed",
            rawOutput: { type: "Bash", output: [111, 107] },
          },
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    enriched.sealReplay();
    expect(
      enriched.records().find((record) => record.kind === "tool"),
    ).toMatchObject({
      patch: {
        title: "Run",
        status: "completed",
        rawOutput: { type: "Bash", output: [111, 107] },
        rawOutputVariant: "Bash",
      },
    });

    const changed = projector();
    changed.ingestStandard(
      toolUpdate({
        event: "completed",
        promptId: "p1",
        replay: true,
        update: { title: "Run", status: "completed" },
      }),
    );
    expect(
      changed.ingestStandard(
        toolUpdate({
          event: "changed",
          promptId: "p1",
          replay: true,
          update: { status: "failed" },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "conflicting_tool_state",
    });
  });

  it("compacts repeated retained tool updates by prompt and tool identity", () => {
    const history = projector();
    for (let index = 0; index < 500; index += 1) {
      expect(
        history.ingestStandard(
          toolUpdate({
            event: `tool-update-${index}`,
            promptId: "p1",
            replay: true,
            update: {
              ...(index === 0
                ? { title: "Long-running tool", status: "in_progress" }
                : {}),
              rawOutput: { progress: index },
            },
          }),
        ),
      ).toMatchObject({ kind: "accepted" });
    }
    history.sealReplay();
    expect(history.records()).toHaveLength(1);
    expect(history.records()[0]).toMatchObject({
      kind: "tool",
      patch: {
        title: "Long-running tool",
        status: "in_progress",
        rawOutput: { progress: 499 },
      },
    });
  });

  it("deduplicates exact tool events and fences conflicting or malformed root tool traffic", () => {
    const history = projector();
    const update = toolUpdate({
      event: "tool-event",
      promptId: "p1",
      replay: true,
      update: { title: "Run tests", status: "in_progress" },
    });
    expect(history.ingestStandard(update)).toMatchObject({ kind: "accepted" });
    expect(history.ingestStandard(update)).toEqual({ kind: "duplicate" });
    expect(
      history.ingestStandard(
        toolUpdate({
          event: "tool-event",
          promptId: "p1",
          replay: true,
          update: { title: "Different", status: "in_progress" },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "conflicting_event_identity",
    });

    const malformed = projector();
    expect(
      malformed.ingestStandard(
        toolUpdate({
          event: "missing-prompt",
          replay: true,
          update: { title: "No correlation" },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "malformed_known_history_dependency",
    });
  });

  it("scopes reused provider event IDs to their exact prompt", () => {
    const history = projector();
    for (const input of [
      textUpdate({
        event: "p1-user",
        text: "first",
        kind: "user_message_chunk",
        promptId: "p1",
        replay: true,
      }),
      toolUpdate({
        event: "reused-event",
        promptId: "p1",
        replay: true,
        update: {
          toolCallId: "tool-p1",
          title: "First tool",
          status: "completed",
        },
      }),
    ]) {
      expect(history.ingestStandard(input)).toMatchObject({ kind: "accepted" });
    }
    expect(
      history.ingestSourceCandidateTurnCompleted(
        terminal({ event: "p1-terminal", promptId: "p1", replay: true }),
      ),
    ).toMatchObject({ kind: "accepted" });
    for (const input of [
      textUpdate({
        event: "p2-user",
        text: "second",
        kind: "user_message_chunk",
        promptId: "p2",
        replay: true,
      }),
      toolUpdate({
        event: "reused-event",
        promptId: "p2",
        replay: true,
        update: {
          toolCallId: "tool-p2",
          title: "Second tool",
          status: "completed",
        },
      }),
    ]) {
      expect(history.ingestStandard(input)).toMatchObject({ kind: "accepted" });
    }
    expect(
      history.ingestSourceCandidateTurnCompleted(
        terminal({ event: "p2-terminal", promptId: "p2", replay: true }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(history.sealReplay()).toEqual({ kind: "accepted" });

    const tools = history.records().filter((record) => record.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]?.id).not.toBe(tools[1]?.id);
    expect(projectGrokLatestHistory(history.records()).snapshot).toMatchObject({
      runState: "idle",
      orderedBackendTurnIds: [
        expect.stringMatching(/^grok-turn:/u),
        expect.stringMatching(/^grok-turn:/u),
      ],
    });
  });

  it("seals selected replay before accepting live traffic", () => {
    const history = projector();
    expect(
      history.ingestStandard(
        textUpdate({
          event: "opaque-z",
          text: "hello",
          replay: true,
          promptId: "p",
        }),
      ),
    ).toEqual({ kind: "accepted" });
    expect(
      history.ingestStandard(
        textUpdate({
          event: "opaque-middle",
          text: "thinking",
          kind: "agent_thought_chunk",
          replay: true,
          promptId: "p",
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(history.records()).toEqual([]);

    expect(history.sealReplay()).toEqual({ kind: "accepted" });
    expect(
      history.ingestSourceCandidateTurnCompleted(
        terminal({ event: "opaque-a", promptId: "p" }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(history.records()).toMatchObject([
      {
        kind: "assistant_text",
        identity: {
          nativeNamespaceKey: "grok-store:tenant-principal",
          eventId: "opaque-z",
          promptId: "p",
          blockOccurrence: 0,
        },
      },
      {
        kind: "reasoning",
        identity: { eventId: "opaque-middle", blockOccurrence: 0 },
      },
      {
        kind: "turn_completed",
        identity: { eventId: "opaque-a", blockOccurrence: 0 },
      },
    ]);
  });

  it("rejects live traffic before replay selection is sealed", () => {
    const history = projector();
    history.ingestStandard(
      textUpdate({ event: "replay", text: "private", replay: true }),
    );
    expect(
      history.ingestStandard(textUpdate({ event: "live", text: "unsealed" })),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "live_before_replay_sealed",
    });
    expect(history.records()).toEqual([]);
  });

  it("compacts promptless staged user volume without a Grok-only failure budget", () => {
    const history = projector();
    const chunks = Array.from(
      { length: 1_000 },
      (_, index) => `${index.toString().padStart(4, "0")}:${"x".repeat(27)}`,
    );
    for (const [index, text] of chunks.entries()) {
      expect(
        history.ingestStandard(
          textUpdate({
            event: `user-${index}`,
            text,
            kind: "user_message_chunk",
            replay: true,
          }),
        ),
      ).toMatchObject({ kind: "accepted" });
    }
    expect(history.diagnostics()).toMatchObject({
      promptlessUserRecordCount: 1,
      fingerprintCount: 1_000,
    });
    expect(history.sealReplay()).toEqual({ kind: "accepted" });
    expect(history.records()).toMatchObject([
      {
        kind: "user_text",
        text: { text: chunks.join("") },
        exactTextDigest: createHash("sha256")
          .update(chunks.join(""))
          .digest("base64url"),
      },
    ]);
    expect(history.diagnostics().retainedBytes).toBeGreaterThan(32_000);
  });

  it("deduplicates exact opaque event identities and rejects conflicting reuse", () => {
    const history = projector();
    const replay = textUpdate({
      event: "event-X",
      text: "same",
      replay: true,
    });
    expect(history.ingestStandard(replay)).toMatchObject({ kind: "accepted" });
    expect(history.sealReplay()).toEqual({ kind: "accepted" });
    expect(
      history.ingestStandard(textUpdate({ event: "event-X", text: "same" })),
    ).toEqual({ kind: "duplicate" });
    expect(
      history.ingestStandard(textUpdate({ event: "event-X", text: "changed" })),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "conflicting_event_identity",
    });
    expect(history.records()).toEqual([]);
  });

  it("retains dedupe evidence for the current prompt without a lifetime quota", () => {
    const history = projector();
    history.sealReplay();
    for (let index = 0; index < 3; index += 1) {
      expect(
        history.ingestStandard(
          textUpdate({
            event: `event-${index}`,
            text: "x",
            promptId: "prompt",
          }),
        ),
      ).toMatchObject({ kind: "accepted" });
    }
    expect(history.records()).toMatchObject([
      { kind: "assistant_text", text: { text: "xxx" } },
    ]);
    expect(
      history.ingestStandard(
        textUpdate({
          event: "e".repeat(80),
          text: "x",
          promptId: "prompt",
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(history.records()).toMatchObject([
      { kind: "assistant_text", text: { text: "xxxx" } },
    ]);
    expect(history.diagnostics().fingerprintCount).toBe(4);
  });

  it("charges tool dedupe evidence by fixed digest rather than raw payload", () => {
    const history = projector();
    history.sealReplay();
    for (let index = 0; index < 3; index += 1) {
      expect(
        history.ingestStandard(
          toolUpdate({
            event: `tool-${index}`,
            promptId: "prompt",
            update: { rawOutput: "x".repeat(1_024 + index) },
          }),
        ),
      ).toMatchObject({ kind: "accepted" });
    }
    expect(history.records()).toHaveLength(1);
    expect(
      history.ingestStandard(
        toolUpdate({
          event: "tool-0",
          promptId: "prompt",
          update: { rawOutput: "conflicting" },
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "conflicting_event_identity",
    });
  });

  it("uses contiguous channel occurrences without message or chunk identifiers", () => {
    const history = projector();
    history.ingestStandard(
      textUpdate({
        event: "u1",
        text: "first user block",
        kind: "user_message_chunk",
        replay: true,
      }),
    );
    history.ingestStandard(
      textUpdate({
        event: "u2",
        text: "same user occurrence",
        kind: "user_message_chunk",
        replay: true,
      }),
    );
    history.ingestStandard(
      textUpdate({ event: "a1", text: "answer", replay: true }),
    );
    history.ingestStandard(
      textUpdate({
        event: "u3",
        text: "next user occurrence",
        kind: "user_message_chunk",
        replay: true,
      }),
    );
    history.sealReplay();
    const records = history.records();
    expect(records.map((record) => record.identity.blockOccurrence)).toEqual([
      0, 0, 1,
    ]);
    expect(records[0]).toMatchObject({
      kind: "user_text",
      text: { text: "first user blocksame user occurrence" },
    });
    expect(records[2]?.identity.blockId).not.toBe(records[0]?.identity.blockId);
    expect(records[2]?.identity).not.toHaveProperty("promptId");
  });

  it("keys a block by its contiguous semantic occurrence ordinal", () => {
    const baseline = projector();
    const withEarlierOccurrence = projector();
    const later = [
      textUpdate({
        event: "u1",
        text: "user one",
        kind: "user_message_chunk",
        replay: true,
      }),
      textUpdate({ event: "a1", text: "answer one", replay: true }),
      textUpdate({
        event: "stable-later-user",
        text: "user two",
        kind: "user_message_chunk",
        replay: true,
      }),
    ];
    for (const update of later) baseline.ingestStandard(update);
    for (const update of [
      textUpdate({
        event: "inserted-user",
        text: "inserted",
        kind: "user_message_chunk",
        replay: true,
      }),
      textUpdate({ event: "inserted-answer", text: "inserted", replay: true }),
      ...later,
    ]) {
      withEarlierOccurrence.ingestStandard(update);
    }
    baseline.sealReplay();
    withEarlierOccurrence.sealReplay();
    const baselineLater = baseline
      .records()
      .find((record) => record.identity.eventId === "stable-later-user")!;
    const shiftedLater = withEarlierOccurrence
      .records()
      .find((record) => record.identity.eventId === "stable-later-user")!;
    expect(shiftedLater.identity.blockOccurrence).not.toBe(
      baselineLater.identity.blockOccurrence,
    );
    expect(shiftedLater.identity.blockId).not.toBe(
      baselineLater.identity.blockId,
    );
  });

  it("keeps semantic block IDs stable across different event IDs and chunk merging", () => {
    const live = projector();
    const replay = projector();
    live.sealReplay();
    for (const update of [
      textUpdate({
        event: "live-u1",
        text: "hel",
        kind: "user_message_chunk",
        promptId: "p",
      }),
      textUpdate({
        event: "live-u2",
        text: "lo",
        kind: "user_message_chunk",
        promptId: "p",
      }),
      textUpdate({ event: "live-a1", text: "wor", promptId: "p" }),
      textUpdate({ event: "live-a2", text: "ld", promptId: "p" }),
    ]) {
      live.ingestStandard(update);
    }
    live.ingestSourceCandidateTurnCompleted(
      terminal({ event: "live-terminal", promptId: "p" }),
    );
    replay.ingestStandard(
      textUpdate({
        event: "replay-user",
        text: "hello",
        kind: "user_message_chunk",
        promptId: "p",
        replay: true,
      }),
    );
    replay.ingestStandard(
      textUpdate({
        event: "replay-assistant",
        text: "world",
        promptId: "p",
        replay: true,
      }),
    );
    replay.ingestSourceCandidateTurnCompleted(
      terminal({ event: "replay-terminal", promptId: "p", replay: true }),
    );
    replay.sealReplay();
    expect(
      replay.records().map((record) => [record.kind, record.identity.blockId]),
    ).toEqual(
      live
        .records()
        .filter(
          (record, index, all) =>
            index ===
            all.findIndex(
              (candidate) =>
                candidate.identity.blockId === record.identity.blockId,
            ),
        )
        .map((record) => [record.kind, record.identity.blockId]),
    );
  });

  it("compacts more native chunks than the semantic record limit into one block", () => {
    const history = projector();
    history.sealReplay();
    for (let index = 0; index < 12_000; index += 1) {
      expect(
        history.ingestStandard(
          textUpdate({
            event: `token-${index}`,
            text: "x",
            promptId: "large-prompt",
          }),
        ),
      ).toMatchObject({ kind: "accepted" });
    }
    expect(
      history.ingestSourceCandidateTurnCompleted(
        terminal({ event: "large-terminal", promptId: "large-prompt" }),
      ),
    ).toMatchObject({ kind: "accepted" });

    expect(history.records()).toMatchObject([
      { kind: "assistant_text", text: { text: "x".repeat(12_000) } },
      { kind: "turn_completed" },
    ]);
  });

  it("bounds one turn at the Grok retained-record contract with a truthful omission notice", () => {
    const history = projector();
    history.sealReplay();
    for (let index = 0; index < 2_050; index += 1) {
      expect(
        history.ingestStandard(
          toolUpdate({
            event: `tool-event-${index}`,
            promptId: "many-tools",
            toolCallId: `tool-${index}`,
            update: { title: `Tool ${index}`, status: "completed" },
          }),
        ),
      ).toMatchObject({ kind: "accepted" });
    }
    expect(
      history.ingestSourceCandidateTurnCompleted(
        terminal({ event: "many-tools-terminal", promptId: "many-tools" }),
      ),
    ).toMatchObject({ kind: "accepted" });

    const records = history.records();
    expect(records.filter((record) => record.kind === "tool")).toHaveLength(
      1_999,
    );
    expect(records.filter((record) => record.kind === "omission")).toHaveLength(
      1,
    );
    expect(history.diagnostics()).toMatchObject({
      retainedRecordCount: 2_001,
      fingerprintCount: 2_000,
    });
    const snapshot = projectGrokLatestHistory(records).snapshot;
    const turn = snapshot.turnsById[snapshot.orderedBackendTurnIds[0]!]!;
    expect(turn.orderedBackendItemIds).toHaveLength(2_000);
    expect(
      turn.orderedBackendItemIds.map((id) => snapshot.itemsById[id]).at(-1),
    ).toMatchObject({
      semanticKind: "notice",
      text: {
        text: "Additional provider activity was omitted from this turn.",
      },
    });
  });

  it("preserves one text frame above one MiB and subsequent appended text", () => {
    const history = projector();
    history.sealReplay();
    const text = `${"z".repeat(1 * 1_024 * 1_024)}suffix`;
    expect(
      history.ingestStandard(
        textUpdate({ event: "large-single-frame", text, promptId: "p1" }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(history.records()).toMatchObject([
      {
        kind: "assistant_text",
        text: { text },
        exactTextDigest: createHash("sha256").update(text).digest("base64url"),
      },
    ]);
    expect(history.ingestStandard(textUpdate({
      event: "after-large-frame", text: " appended 雪🙂", promptId: "p1",
    }))).toMatchObject({ kind: "accepted" });
    expect(history.records()[0]).toMatchObject({ text: { text: `${text} appended 雪🙂` } });
    expect(history.records()[0]!.kind).toBe("assistant_text");
    expect(history.diagnostics().retainedBytes).toBeGreaterThan(Buffer.byteLength(text));
  });

  it("releases sealed prompt records and fingerprints outside the retained window", () => {
    const history = projector(2);
    history.sealReplay();
    for (let index = 1; index <= 25; index += 1) {
      expect(
        history.ingestStandard(
          textUpdate({
            event: `answer-${index}`,
            text: `answer ${index}`,
            promptId: `prompt-${index}`,
          }),
        ),
      ).toMatchObject({ kind: "accepted" });
      if (index < 25) {
        expect(
          history.ingestSourceCandidateTurnCompleted(
            terminal({
              event: `terminal-${index}`,
              promptId: `prompt-${index}`,
            }),
          ),
        ).toMatchObject({ kind: "accepted" });
        expect(history.diagnostics()).toMatchObject({
          visiblePromptCount: Math.min(index, 2),
          retainedRecordCount: Math.min(index, 2) * 2,
          fingerprintCount: Math.min(index, 2) * 2,
        });
      }
    }

    expect(history.records().map((record) => record.identity.promptId)).toEqual(
      ["prompt-23", "prompt-23", "prompt-24", "prompt-24", "prompt-25"],
    );
    expect(history.diagnostics()).toMatchObject({
      retainedCompletedPromptWindow: 2,
      visiblePromptCount: 3,
      offWindowToolPromptCount: 0,
      evictedPromptCount: 22,
      retainedRecordCount: 5,
      fingerprintCount: 5,
    });
    expect(
      history.ingestStandard(
        textUpdate({
          event: "answer-1",
          text: "a new prompt may reuse an old provider event id",
          promptId: "prompt-6",
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
  });

  it("keeps only compact unsettled tool evidence after display eviction", () => {
    const history = projector(1);
    history.sealReplay();
    const started = history.ingestStandard(
      toolUpdate({
        event: "background-start",
        promptId: "prompt-1",
        update: { title: "Background work", status: "in_progress" },
      }),
    );
    expect(started).toMatchObject({ kind: "accepted" });
    history.ingestStandard(
      textUpdate({ event: "p1-text", text: "done", promptId: "prompt-1" }),
    );
    history.ingestSourceCandidateTurnCompleted(
      terminal({ event: "p1-terminal", promptId: "prompt-1" }),
    );
    const terminalSnapshot = projectGrokLatestHistory(
      history.records(),
    ).snapshot;
    expect(terminalSnapshot.runState).toBe("idle");
    expect(Object.values(terminalSnapshot.itemsById)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semanticKind: "tool",
          status: "streaming",
          phase: "preflight_or_executing",
        }),
      ]),
    );
    history.ingestStandard(
      textUpdate({ event: "p2-text", text: "second", promptId: "prompt-2" }),
    );
    history.ingestSourceCandidateTurnCompleted(
      terminal({ event: "p2-terminal", promptId: "prompt-2" }),
    );
    history.ingestStandard(
      textUpdate({ event: "p3-text", text: "third", promptId: "prompt-3" }),
    );

    expect(history.records()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identity: { promptId: "prompt-1" } }),
      ]),
    );
    expect(history.diagnostics()).toMatchObject({
      visiblePromptCount: 2,
      offWindowToolPromptCount: 1,
    });

    const completed = history.ingestStandard(
      toolUpdate({
        update: { status: "completed", rawOutput: { result: "finished" } },
      }),
    );
    expect(completed).toEqual({ kind: "accepted" });
    expect(history.diagnostics()).toMatchObject({
      offWindowToolPromptCount: 0,
      retainedRecordCount: 3,
      fingerprintCount: 3,
    });
  });

  it("keeps durable IDs independent from connection generations", () => {
    const first = projector();
    const second = projector();
    first.ingestStandard(
      textUpdate({ event: "resettable-0", text: "same", replay: true }),
    );
    second.ingestStandard(
      textUpdate({ event: "resettable-0", text: "same", replay: true }),
    );
    first.sealReplay();
    second.sealReplay();
    expect(first.records()[0]?.id).toBe(second.records()[0]?.id);
    expect(first.records()[0]?.identity).not.toHaveProperty(
      "connectionGeneration",
    );
  });

  it("appends a deterministic local interruption without changing native identities", () => {
    const first = projector();
    const second = projector();
    for (const history of [first, second]) {
      history.ingestStandard(
        textUpdate({
          event: "restart-user",
          text: "unfinished",
          kind: "user_message_chunk",
          promptId: "authenticated-by-driver",
          replay: true,
        }),
      );
      history.ingestStandard(
        textUpdate({
          event: "restart-thought",
          text: "working",
          kind: "agent_thought_chunk",
          promptId: "authenticated-by-driver",
          replay: true,
        }),
      );
      history.sealReplay();
    }
    const nativeRecords = first.records();
    expect(
      first.appendLocallyInterruptedPrompt("authenticated-by-driver"),
    ).toMatchObject({ kind: "accepted" });
    expect(
      second.appendLocallyInterruptedPrompt("authenticated-by-driver"),
    ).toMatchObject({ kind: "accepted" });

    expect(first.records().slice(0, -1)).toEqual(nativeRecords);
    expect(first.records().at(-1)).toMatchObject({
      kind: "turn_completed",
      stopReason: "cancelled",
      identity: { promptId: "authenticated-by-driver" },
    });
    expect(first.records().at(-1)).toEqual(second.records().at(-1));
  });

  it("permits one semantically identical terminal per prompt and fences contradictions", () => {
    const duplicate = projector();
    duplicate.ingestSourceCandidateTurnCompleted(
      terminal({ event: "terminal-1", promptId: "prompt", replay: true }),
    );
    duplicate.sealReplay();
    duplicate.ingestSourceCandidateTurnCompleted(
      terminal({ event: "terminal-2", promptId: "prompt" }),
    );
    expect(duplicate.records()).toHaveLength(1);
    expect(
      duplicate.ingestStandard(
        textUpdate({
          event: "terminal-2",
          text: "reused identity",
          promptId: "prompt",
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "conflicting_event_identity",
    });

    const conflict = projector();
    conflict.ingestSourceCandidateTurnCompleted(
      terminal({ event: "terminal-1", promptId: "prompt", replay: true }),
    );
    expect(conflict.sealReplay()).toEqual({ kind: "accepted" });
    expect(
      conflict.ingestSourceCandidateTurnCompleted(
        terminal({
          event: "terminal-2",
          promptId: "prompt",
          stopReason: "cancelled",
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "conflicting_prompt_terminal",
    });
    expect(conflict.records()).toEqual([]);
  });

  it("accepts terminal aliases without turning their count into a failure budget", () => {
    const history = projector();
    history.sealReplay();
    expect(
      history.ingestSourceCandidateTurnCompleted(
        terminal({ event: "terminal-1", promptId: "prompt" }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(
      history.ingestSourceCandidateTurnCompleted(
        terminal({ event: "terminal-2", promptId: "prompt" }),
      ),
    ).toEqual({ kind: "duplicate" });
    expect(
      history.ingestSourceCandidateTurnCompleted(
        terminal({ event: "terminal-3", promptId: "prompt" }),
      ),
    ).toEqual({ kind: "duplicate" });
    expect(history.diagnostics().fingerprintCount).toBe(3);
  });

  it("does not bind a pending user block to a duplicate prior terminal", () => {
    const history = projector();
    history.sealReplay();
    history.ingestSourceCandidateTurnCompleted(
      terminal({ event: "p1-terminal-1", promptId: "p1" }),
    );
    history.ingestStandard(
      textUpdate({
        event: "p2-user",
        text: "second prompt",
        kind: "user_message_chunk",
      }),
    );
    expect(
      history.ingestSourceCandidateTurnCompleted(
        terminal({ event: "p1-terminal-2", promptId: "p1" }),
      ),
    ).toEqual({ kind: "duplicate" });
    history.ingestStandard(
      textUpdate({
        event: "p2-assistant",
        text: "second answer",
        promptId: "p2",
      }),
    );
    expect(
      history.records().find((record) => record.identity.eventId === "p2-user")
        ?.identity.promptId,
    ).toBe("p2");
  });

  it("rebinds a replay-tail user block when live prompt correlation arrives", () => {
    const history = projector();
    history.ingestStandard(
      textUpdate({
        event: "replay-user",
        text: "continue",
        kind: "user_message_chunk",
        replay: true,
      }),
    );
    expect(history.sealReplay()).toEqual({ kind: "accepted" });
    expect(history.records()[0]?.identity).not.toHaveProperty("promptId");
    const unboundRecordId = history.records()[0]?.id;

    expect(
      history.ingestStandard(
        textUpdate({
          event: "live-answer",
          text: "done",
          promptId: "active-prompt",
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(
      history.ingestSourceCandidateTurnCompleted(
        terminal({ event: "live-terminal", promptId: "active-prompt" }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(history.records()).toMatchObject([
      {
        kind: "user_text",
        text: { text: "continue" },
        identity: { promptId: "active-prompt" },
      },
      {
        kind: "assistant_text",
        text: { text: "done" },
        identity: { promptId: "active-prompt" },
      },
      { kind: "turn_completed", identity: { promptId: "active-prompt" } },
    ]);
    expect(history.records()[0]?.id).not.toBe(unboundRecordId);
    expect(projectGrokLatestHistory(history.records()).snapshot).toMatchObject({
      runState: "idle",
      orderedBackendTurnIds: [expect.stringMatching(/^grok-turn:/u)],
    });
  });

  it("ignores unused variants and user-image echoes without retaining raw image data", () => {
    const history = projector();
    const ignored: SessionNotification = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      },
    };
    const image: SessionNotification = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "image",
          data: "cmF3LWltYWdlLXNlbnRpbmVsLW11c3Qtbm90LWxlYWs=",
          mimeType: "image/png",
        },
      },
    };
    expect(history.ingestStandard(ignored)).toEqual({ kind: "ignored" });
    expect(history.ingestStandard(image)).toEqual({ kind: "ignored" });
    expect(history.records()).toEqual([]);
    expect(JSON.stringify(history.records())).not.toContain(
      "cmF3LWltYWdlLXNlbnRpbmVsLW11c3Qtbm90LWxlYWs=",
    );
  });

  it("fails on actual cutover and malformed dependencies but not finite interleave volume", () => {
    const late = projector();
    late.sealReplay();
    expect(
      late.ingestStandard(
        textUpdate({ event: "late", text: "late", replay: true }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "replay_after_cutover",
    });

    const malformed = projector();
    expect(
      malformed.ingestStandard({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "missing metadata" },
        },
      }),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "malformed_known_history_dependency",
    });

    const bounded = projector();
    expect(bounded.sealReplay()).toEqual({ kind: "accepted" });
    expect(
      bounded.ingestStandard(textUpdate({ event: "one", text: "one" })),
    ).toMatchObject({ kind: "accepted" });
    expect(
      bounded.ingestStandard(textUpdate({ event: "two", text: "two" })),
    ).toMatchObject({ kind: "accepted" });
    expect(bounded.records()).toMatchObject([
      { kind: "assistant_text", text: { text: "onetwo" } },
    ]);
  });
});
