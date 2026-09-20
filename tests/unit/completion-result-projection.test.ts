import { describe, expect, it } from "vitest";
import type { ProjectedConversationTimeline } from "../../src/server/conversations/conversation-projector.js";
import { projectAuthoritativeCompletionResult, projectClassifiedAssistantResult } from "../../src/server/conversations/completion-result-projection.js";

const applicationTurnId = "turn_application";

function timeline(input: {
  readonly assistantText: string;
  readonly includeLateTool?: boolean;
}): ProjectedConversationTimeline {
  const orderedItemIds = ["assistant-one", "reasoning-one"];
  if (input.includeLateTool) orderedItemIds.push("late-grok-tool");
  return {
    generation: "generation-one",
    orderedTurnIds: [applicationTurnId],
    turnsById: {
      [applicationTurnId]: {
        id: applicationTurnId,
        revision: 1,
        status: "completed",
        endedBy: "agent_settled",
        orderedItemIds,
      },
    },
    itemsById: {
      "assistant-one": {
        id: "assistant-one",
        turnId: applicationTurnId,
        revision: 1,
        status: "completed",
        kind: "assistant_message",
        markdown: { text: input.assistantText },
      },
      "reasoning-one": {
        id: "reasoning-one",
        turnId: applicationTurnId,
        revision: 1,
        status: "completed",
        kind: "reasoning",
        markdown: { text: "private reasoning is not callback output" },
      },
      ...(input.includeLateTool
        ? {
            "late-grok-tool": {
              id: "late-grok-tool",
              turnId: applicationTurnId,
              revision: 1,
              status: "completed" as const,
              kind: "tool" as const,
              phase: "completed" as const,
              toolName: { text: "background" },
              title: { text: "Late Grok background tool" },
              category: "other" as const,
            },
          }
        : {}),
    },
    runState: "idle",
  };
}

function project(projected: ProjectedConversationTimeline) {
  return projectAuthoritativeCompletionResult({
    backendTurnId: "backend-turn-one",
    timeline: projected,
    matchesApplicationTurnId: (backendTurnId, candidateTurnId) =>
      backendTurnId === "backend-turn-one" &&
      candidateTurnId === applicationTurnId,
  });
}

describe("authoritative completion result projection", () => {
  it("returns a JSON-friendly bounded snapshot of ordinary assistant text", () => {
    const result = project(timeline({ assistantText: "x".repeat(20_000) }));

    expect(result.applicationTurnId).toBe(applicationTurnId);
    expect(new TextEncoder().encode(result.result.text).byteLength).toBeLessThanOrEqual(
      16_384,
    );
    expect(result.result.truncation).toMatchObject({
      truncated: true,
      reason: "byte_limit",
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("keeps the Grok disposition immutable when tool-only evidence arrives after terminal", () => {
    const beforeLateTool = project(timeline({ assistantText: "Final answer" }));
    const afterLateTool = project(
      timeline({ assistantText: "Final answer", includeLateTool: true }),
    );

    expect(afterLateTool).toEqual(beforeLateTool);
    expect(afterLateTool.result).toEqual({ text: "Final answer" });
  });

  it("fails closed when the backend turn cannot resolve to exactly one application turn", () => {
    expect(() =>
      projectAuthoritativeCompletionResult({
        backendTurnId: "unknown",
        timeline: timeline({ assistantText: "answer" }),
        matchesApplicationTurnId: () => false,
      }),
    ).toThrow("authoritative_completion_turn_unresolved");
  });
});

describe("classified completion result", () => {
  const message = (text: string, responsePhase?: "provisional" | "final" | "unclassified") => ({
    backendItemId: "item", backendTurnId: "turn", sourceOrder: 0,
    semanticKind: "assistant_message" as const, status: "completed" as const,
    markdown: { text }, ...(responsePhase ? { responsePhase } : {}),
  });
  it("concatenates each phase in order and distinguishes absent from empty", () => {
    expect(projectClassifiedAssistantResult([
      message("Checking", "provisional"), message("Unknown"),
      message("Found it", "provisional"), message("", "final"),
    ])).toEqual({ provisional: { text: "Checking\n\nFound it" }, final: { text: "" }, unclassified: { text: "Unknown" } });
    expect(projectClassifiedAssistantResult([])).toEqual({ provisional: null, final: null, unclassified: null });
  });
  it("reserves the shared text budget for final even after long commentary", () => {
    const result = projectClassifiedAssistantResult([
      message("p".repeat(30_000), "provisional"), message("Answer 😀", "final"), message("u".repeat(30_000)),
    ]);
    expect(result.final).toEqual({ text: "Answer 😀" });
    expect(result.provisional?.truncation?.truncated).toBe(true);
    expect(result.unclassified).toMatchObject({ text: "", truncation: { truncated: true, retainedBytes: 0 } });
    expect(Object.values(result).reduce((n, part) => n + Buffer.byteLength(part?.text ?? ""), 0)).toBeLessThanOrEqual(16_384);
  });
});
