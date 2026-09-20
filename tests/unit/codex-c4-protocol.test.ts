import { describe, expect, expectTypeOf, it } from "vitest";
import {
  codexThreadForkMethod,
  type CodexThreadForkParams,
} from "../../src/server/backends/codex/codex-c4-protocol.js";

function forkResponse() {
  return {
    thread: {
      id: "child-thread",
      extra: null,
      sessionId: "native-session-tree",
      forkedFromId: "source-thread",
      parentThreadId: null,
      preview: "selected history",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "legacy" as const,
      modelProvider: "openai",
      model: null,
      reasoningEffort: null,
      createdAt: 10,
      updatedAt: 11,
      recencyAt: 11,
      status: { type: "idle" as const },
      path: "/codex/child.jsonl",
      cwd: "/workspace",
      cliVersion: "0.153.0",
      source: "appServer" as const,
      canAcceptDirectInput: true,
      threadSource: "sedes-fork-operation",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [
        {
          id: "selected-native-turn",
          items: [
            {
              type: "mcpToolCall" as const,
              id: "tool-call",
              server: "fixture",
              tool: "read",
              status: "completed" as const,
              arguments: { path: "README.md" },
              appContext: null,
              pluginId: null,
              readOnlyHint: null,
              result: {
                content: [{ type: "text" as const, text: "preserved" }],
                structuredContent: null,
                _meta: null,
              },
              error: null,
              durationMs: 5,
            },
          ],
          itemsView: "full" as const,
          status: "completed" as const,
          error: null,
          startedAt: 8,
          completedAt: 9,
          durationMs: 1_000,
        },
      ],
    },
    model: "gpt-5.6",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/workspace",
    runtimeWorkspaceRoots: ["/workspace"],
    instructionSources: ["/workspace/AGENTS.md"],
    approvalPolicy: "on-request" as const,
    approvalsReviewer: "user" as const,
    sandbox: { type: "readOnly" as const, networkAccess: false },
    activePermissionProfile: null,
    reasoningEffort: "high",
    multiAgentMode: "explicitRequestOnly" as const,
  };
}

function projectedForkResponse() {
  const {
    runtimeWorkspaceRoots: _runtimeWorkspaceRoots,
    activePermissionProfile: _activePermissionProfile,
    multiAgentMode: _multiAgentMode,
    ...projected
  } = forkResponse();
  return projected;
}

describe("Codex C4 pinned fork protocol", () => {
  it("exposes only the established Sedes fork parameter subset", () => {
    const accepted: CodexThreadForkParams = {
      threadId: "source-thread",
      lastTurnId: "selected-native-turn",
    };
    expectTypeOf(accepted).toMatchTypeOf<CodexThreadForkParams>();

    const rejected: CodexThreadForkParams = {
      threadId: "source-thread",
      // @ts-expect-error Experimental rollout-path forking is not a Sedes API.
      path: "/provider/rollout.jsonl",
    };
    expect(rejected.threadId).toBe("source-thread");
  });

  it("encodes the exact explicit inclusive selected-turn request", () => {
    expect(codexThreadForkMethod.method).toBe("thread/fork");
    expect(
      codexThreadForkMethod.encodeParams({
        threadId: "source-thread",
        lastTurnId: "selected-native-turn",
        model: "gpt-5.6",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "read-only",
        config: { model_reasoning_effort: "high" },
        baseInstructions: null,
        developerInstructions: null,
        ephemeral: false,
        threadSource: "sedes-fork-operation",
      }),
    ).toEqual({
      threadId: "source-thread",
      lastTurnId: "selected-native-turn",
      model: "gpt-5.6",
      modelProvider: "openai",
      serviceTier: null,
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only",
      config: { model_reasoning_effort: "high" },
      baseInstructions: null,
      developerInstructions: null,
      ephemeral: false,
      threadSource: "sedes-fork-operation",
    });
  });

  it("omits lastTurnId only for the provider-latest snapshot request", () => {
    expect(
      codexThreadForkMethod.encodeParams({ threadId: "source-thread" }),
    ).toEqual({ threadId: "source-thread" });

    for (const invalid of [
      { threadId: "source-thread", lastTurnId: null },
      { threadId: "source-thread", lastTurnId: "" },
      {
        threadId: "source-thread",
        lastTurnId: "selected-native-turn",
        path: "/obsolete/path-fork.jsonl",
      },
    ]) {
      expect(() =>
        codexThreadForkMethod.encodeParams(invalid as never),
      ).toThrow();
    }
  });

  it("enforces Sedes bounds after official fork shape validation", () => {
    const overlongId = "i".repeat(513);
    const overlongText = "t".repeat(7 * 1024 * 1024 + 1);

    for (const invalid of [
      { threadId: overlongId },
      { threadId: "source-thread", lastTurnId: overlongId },
      { threadId: "source-thread", model: overlongText },
      {
        threadId: "source-thread",
        config: { nested: [overlongText] },
      },
      {
        threadId: "source-thread",
        approvalPolicy: {
          granular: {
            sandbox_approval: true,
            rules: true,
            skill_approval: true,
            request_permissions: true,
            mcp_elicitations: true,
          },
          unreviewedProviderField: true,
        },
      },
      {
        threadId: "source-thread",
        approvalPolicy: {
          granular: {
            sandbox_approval: true,
            rules: true,
            skill_approval: true,
            request_permissions: true,
            mcp_elicitations: true,
            unreviewedProviderField: true,
          },
        },
      },
      { threadId: "source-thread", unreviewedProviderField: true },
    ]) {
      expect(() =>
        codexThreadForkMethod.encodeParams(invalid as never),
      ).toThrow();
    }
  });

  it("decodes an exact official-valid experimental fork response", () => {
    expect(codexThreadForkMethod.decodeResult(forkResponse())).toEqual(
      projectedForkResponse(),
    );
  });

  it("projects the consumed response subset after official validation", () => {
    const response = {
      ...forkResponse(),
      futureEnvelopeField: { ignored: true },
    };

    expect(codexThreadForkMethod.decodeResult(response)).toEqual(
      projectedForkResponse(),
    );
  });

  it.each([
    [
      "approval policy extension",
      {
        approvalPolicy: {
          granular: {
            sandbox_approval: true,
            rules: true,
            skill_approval: true,
            request_permissions: true,
            mcp_elicitations: true,
            futureApprovalField: true,
          },
        },
      },
    ],
    [
      "sandbox extension",
      {
        sandbox: {
          type: "readOnly" as const,
          networkAccess: false,
          futureSandboxField: true,
        },
      },
    ],
    [
      "thread status extension",
      {
        thread: {
          status: { type: "idle" as const, futureStatusField: true },
        },
      },
    ],
  ])("rejects nested %s", (_label, replacement) => {
    const base = forkResponse();
    const recordReplacement = replacement as Readonly<
      Record<string, unknown>
    > & {
      readonly thread?: Readonly<Record<string, unknown>>;
    };
    const threadReplacement = recordReplacement.thread;
    const candidate = {
      ...base,
      ...recordReplacement,
      ...(threadReplacement
        ? {
            thread: {
              ...base.thread,
              ...threadReplacement,
            },
          }
        : {}),
    };

    expect(() => codexThreadForkMethod.decodeResult(candidate)).toThrow();
  });

  it.each([
    ["empty child identity", { thread: { id: "" } }],
    ["empty session identity", { thread: { sessionId: "" } }],
    ["malformed fork ancestry", { thread: { forkedFromId: 17 } }],
    ["malformed turn identity", { thread: { turns: [{ id: "" }] } }],
    ["malformed turn status", { thread: { turns: [{ status: "succeeded" }] } }],
  ])("rejects %s", (_label, replacement) => {
    const base = forkResponse();
    const threadReplacement = replacement.thread as Readonly<
      Record<string, unknown>
    > & {
      readonly turns?: readonly Readonly<Record<string, unknown>>[];
    };
    const turnsReplacement = threadReplacement?.turns;
    const candidate = {
      ...base,
      ...replacement,
      ...(threadReplacement
        ? {
            thread: {
              ...base.thread,
              ...threadReplacement,
              ...(turnsReplacement
                ? {
                    turns: [
                      {
                        ...base.thread.turns[0],
                        ...turnsReplacement[0],
                      },
                    ],
                  }
                : {}),
            },
          }
        : {}),
    };

    expect(() => codexThreadForkMethod.decodeResult(candidate)).toThrow();
  });
});
