import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { runSedesCli, type SedesCliIo } from "../../src/cli/sedes-cli.js";
import { SEDES_VERSION } from "../../src/shared/version.js";
import { SedesToolHttpClient } from "../../src/cli/sedes-tool-api-client.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import {
  SEDES_AGENT_TOOL_CSRF_ROUTE,
  SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER,
  SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
} from "../../src/server/agent-tools/http/agent-tool-http-contracts.js";
import type { AgentThreadWorktreeService } from "../../src/server/agent-tools/tools/thread-worktree-tools.js";
import { CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES } from "../../src/server/agent-tools/registry/canonical-agent-tool-manifest.js";
import { agentToolCliResultSchema } from "../../src/internal/agent-tool-cli-protocol/index.js";

const sourceCapability = "c".repeat(48);
const sourceCredential = {
  kind: "thread_source" as const,
  value: sourceCapability,
};
const clientToken = `hatc1_10000000-0000-4000-8000-000000000001_1_${"a".repeat(43)}`;
const sourceThreadId = "10000000-0000-4000-8000-000000000001";
const targetThreadId = "10000000-0000-4000-8000-000000000002";

function artifacts() {
  const canonical = new CanonicalInlineAgentToolService({
    application: { readThreadStatus: async () => undefined },
  });
  return canonical.describeMany(
    "cli",
    "thread_agent",
    canonical.catalog("cli", "thread_agent").map(({ id }) => id),
  );
}

function summaries() {
  return new CanonicalInlineAgentToolService({
    application: { readThreadStatus: async () => undefined },
  }).catalogSummaries("cli", "thread_agent");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bufferedIo(): {
  readonly io: SedesCliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(value) {
          stdout += value;
        },
      },
      stderr: {
        write(value) {
          stderr += value;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function environment(mode: "progressive" | "individual" = "progressive") {
  return {
    SEDES_AGENT_TOOL_ENDPOINT: "http://192.168.50.72:4784",
    SEDES_AGENT_TOOL_SOURCE_CAPABILITY: sourceCapability,
    SEDES_AGENT_TOOL_CLI_MODE: mode,
  };
}

describe("Sedes CLI", () => {
  it("transports the complete canonical catalog and renders every individual command in root help", async () => {
    type Dependencies = ConstructorParameters<typeof CanonicalInlineAgentToolService>[0];
    // Help needs the real definitions and projections, but executes no domain
    // operation. Include every optional slice and fence coverage to the manifest.
    const canonical = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      management: {} as NonNullable<Dependencies["management"]>,
      workpads: {} as NonNullable<Dependencies["workpads"]>,
      automations: {} as NonNullable<Dependencies["automations"]>,
      threadCreation: {} as NonNullable<Dependencies["threadCreation"]>,
      savedAgents: {} as NonNullable<Dependencies["savedAgents"]>,
      threadControl: {} as NonNullable<Dependencies["threadControl"]>,
      threadWorktrees: {} as NonNullable<Dependencies["threadWorktrees"]>,
      webSearch: {} as NonNullable<Dependencies["webSearch"]>,
    });
    const tools = canonical.catalogSummaries("cli", "thread_agent");
    expect(tools.map(({ id }) => id).sort()).toEqual(CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES.map(({ id }) => id).sort());
    // This is the same list result validation used by the sidecar relay.
    expect(agentToolCliResultSchema.parse({ type: "list", value: { tools } })).toEqual({ type: "list", value: { tools } });
    const root = bufferedIo();
    expect(await runSedesCli(["--help"], {
      environment: environment("individual"),
      io: root.io,
      fetch: vi.fn(async () => json({ tools })),
    })).toBe(0);
    expect(root.stderr()).toBe("");
    for (const tool of tools) expect(root.stdout()).toContain(tool.cli!.commandPath.join(" "));
  });

  it("prints the product version in a shell without the agent-tool CLI environment", async () => {
    for (const flag of ["--version", "-v"]) {
      const output = bufferedIo();
      const fetch = vi.fn();

      const exit = await runSedesCli([flag], { environment: {}, io: output.io, fetch });

      expect(exit).toBe(0);
      expect(output.stdout()).toBe(`sedes ${SEDES_VERSION}\n`);
      expect(output.stderr()).toBe("");
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("prints the product version in either CLI mode without network access", async () => {
    for (const mode of ["progressive", "individual"] as const) {
      for (const flag of ["--version", "-v"]) {
        const output = bufferedIo();
        const fetch = vi.fn();

        const exit = await runSedesCli([flag], {
          environment: { SEDES_AGENT_TOOL_CLI_MODE: mode },
          io: output.io,
          fetch,
        });

        expect(exit).toBe(0);
        expect(output.stdout()).toBe(`sedes ${SEDES_VERSION}\n`);
        expect(output.stderr()).toBe("");
        expect(fetch).not.toHaveBeenCalled();
      }
    }
  });

  it("prints progressive help without requiring injected caller context", async () => {
    const output = bufferedIo();
    const fetch = vi.fn();

    const exit = await runSedesCli(["--help"], {
      environment: { SEDES_AGENT_TOOL_CLI_MODE: "progressive" },
      io: output.io,
      fetch,
    });

    expect(exit).toBe(0);
    expect(output.stdout()).toContain("Usage:");
    expect(output.stdout()).toContain(
      "Successful invocation stdout matches the described tool outputSchema.",
    );
    expect(output.stdout()).toContain("sedes tool list");
    expect(output.stdout()).not.toContain("typed named options");
    expect(output.stderr()).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders caller-filtered root, group, and exact help in individual mode", async () => {
    const statusSummary = summaries().find(({ id }) => id === "thread.status")!;
    const contextSummary = summaries().find(({ id }) => id === "agent.context")!;
    const statusTool = artifacts().find(({ id }) => id === "thread.status")!;
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/agent-tools") {
        return json({ tools: [contextSummary, statusSummary] });
      }
      return json({ tools: [statusTool] });
    });

    const root = bufferedIo();
    expect(
      await runSedesCli(["--help"], {
        environment: environment("individual"),
        io: root.io,
        fetch,
      }),
    ).toBe(0);
    expect(root.stdout()).toContain("agent context");
    expect(root.stdout()).toContain("thread status");

    const group = bufferedIo();
    expect(
      await runSedesCli(["thread", "--help"], {
        environment: environment("individual"),
        io: group.io,
        fetch,
      }),
    ).toBe(0);
    expect(group.stdout()).toContain("Available thread commands:");
    expect(group.stdout()).toContain("status");
    expect(group.stdout()).not.toContain("agent context");

    const exact = bufferedIo();
    expect(
      await runSedesCli(["thread", "status", "--help"], {
        environment: environment("individual"),
        io: exact.io,
        fetch,
      }),
    ).toBe(0);
    expect(exact.stdout()).toContain("Usage: sedes thread status [options]");
    expect(exact.stdout()).toContain("--thread-id");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("requires an explicit CLI mode and rejects the other command family", async () => {
    const missing = bufferedIo();
    expect(
      await runSedesCli(["--help"], {
        environment: {},
        io: missing.io,
        fetch: vi.fn(),
      }),
    ).toBe(1);
    expect(missing.stderr()).toContain(
      "SEDES_AGENT_TOOL_CLI_MODE must be progressive or individual",
    );

    const progressive = bufferedIo();
    expect(
      await runSedesCli(["task", "create", "--title", "no"], {
        environment: environment("progressive"),
        io: progressive.io,
        fetch: vi.fn(),
      }),
    ).toBe(2);
    expect(progressive.stderr()).toContain(
      "Named commands are unavailable in progressive CLI mode",
    );

    const individual = bufferedIo();
    expect(
      await runSedesCli(["tool", "list", "--json"], {
        environment: environment("individual"),
        io: individual.io,
        fetch: vi.fn(),
      }),
    ).toBe(2);
    expect(individual.stderr()).toContain(
      "Generic tool commands are unavailable in individual CLI mode",
    );
  });

  it("requires structured JSON output for every progressive command", async () => {
    for (const arguments_ of [
      ["tool", "list"],
      ["tool", "describe", "agent.context"],
      ["tool", "invoke", "agent.context", "--input-json", "{}"],
    ]) {
      const output = bufferedIo();
      const fetch = vi.fn();
      expect(
        await runSedesCli(arguments_, {
          environment: environment("progressive"),
          io: output.io,
          fetch,
        }),
      ).toBe(2);
      expect(output.stderr()).toContain(
        "Progressive CLI commands require exactly one --json option",
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("discovers the live catalog with the required source association", async () => {
    const output = bufferedIo();
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(
        new Headers(init?.headers).get(
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
        ),
      ).toBe(sourceCapability);
      return json({ tools: summaries() });
    });

    const exit = await runSedesCli(["tool", "list", "--json"], {
      environment: environment(),
      io: output.io,
      fetch,
    });

    expect(exit, output.stderr()).toBe(0);
    expect(JSON.parse(output.stdout()).tools).toHaveLength(2);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses the principal client header without exposing the token", async () => {
    const output = bufferedIo();
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get(SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER)).toBe(
        clientToken,
      );
      expect(headers.has(SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER)).toBe(
        false,
      );
      return json({ tools: summaries() });
    });

    const exit = await runSedesCli(["tool", "list", "--json"], {
      environment: {
        SEDES_AGENT_TOOL_ENDPOINT: "https://sedes.example",
        SEDES_AGENT_TOOL_CLIENT_TOKEN: clientToken,
        SEDES_AGENT_TOOL_CLI_MODE: "progressive",
      },
      io: output.io,
      fetch,
    });

    expect(exit, output.stderr()).toBe(0);
    expect(output.stdout()).not.toContain(clientToken);
    expect(output.stderr()).not.toContain(clientToken);
  });

  it("requires exactly one caller credential and rejects client tokens over Unix", async () => {
    for (const testEnvironment of [
      {
        SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
        SEDES_AGENT_TOOL_CLI_MODE: "progressive",
      },
      {
        ...environment(),
        SEDES_AGENT_TOOL_CLIENT_TOKEN: clientToken,
      },
      {
        SEDES_AGENT_TOOL_ENDPOINT: "unix:///run/user/1000/sedes.sock",
        SEDES_AGENT_TOOL_CLIENT_TOKEN: clientToken,
        SEDES_AGENT_TOOL_CLI_MODE: "progressive",
      },
    ]) {
      const output = bufferedIo();
      const fetch = vi.fn();
      const connect = vi.fn();
      expect(
        await runSedesCli(["tool", "list", "--json"], {
          environment: testEnvironment,
          io: output.io,
          fetch,
          connect,
        }),
      ).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      expect(output.stdout()).not.toContain(clientToken);
      expect(output.stderr()).not.toContain(clientToken);
    }
  });

  it("batch-describes unique selected IDs in caller order", async () => {
    const output = bufferedIo();
    const selected = ["thread.status", "agent.context"];
    const byId = new Map(artifacts().map((tool) => [tool.id, tool]));
    const fetch = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ toolIds: selected });
        return json({ tools: selected.map((id) => byId.get(id)) });
      },
    );

    const exit = await runSedesCli(
      ["tool", "describe", ...selected, "--json"],
      { environment: environment(), io: output.io, fetch },
    );

    expect(exit, output.stderr()).toBe(0);
    expect(
      JSON.parse(output.stdout()).tools.map(({ id }: { id: string }) => id),
    ).toEqual(selected);
  });

  it("rejects duplicate and oversized describe selections before network access", async () => {
    for (const arguments_ of [
      ["tool", "describe", "agent.context", "agent.context", "--json"],
      [
        "tool",
        "describe",
        ...Array.from({ length: 17 }, (_, index) => `tool.${index}`),
        "--json",
      ],
    ]) {
      const output = bufferedIo();
      const fetch = vi.fn();
      expect(
        await runSedesCli(arguments_, {
          environment: environment(),
          io: output.io,
          fetch,
        }),
      ).toBe(2);
      expect(output.stderr()).toContain("1-16 unique tool IDs");
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("describes, validates, bootstraps CSRF, and invokes canonical input", async () => {
    const output = bufferedIo();
    const tool = artifacts().find(({ id }) => id === "agent.context")!;
    const calls: Array<{ readonly path: string; readonly init?: RequestInit }> =
      [];
    const fetch = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        calls.push({ path, init });
        if (path === "/api/agent-tool-descriptions") {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({
            toolIds: ["agent.context"],
          });
          expect(new Headers(init?.headers).has("X-CSRF-Token")).toBe(false);
          return json({ tools: [tool] });
        }
        if (path === SEDES_AGENT_TOOL_CSRF_ROUTE) {
          expect(
            new Headers(init?.headers).has(
              SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
            ),
          ).toBe(false);
          return json({ csrfToken: "csrf-1" });
        }
        expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf-1");
        expect(
          new Headers(init?.headers).get(
            SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
          ),
        ).toBe(sourceCapability);
        expect(JSON.parse(String(init?.body))).toEqual({
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: "request-1",
          input: {},
        });
        return json({
          invocationId: "invocation-1",
          state: "completed",
          output: {
            threadId: sourceThreadId,
            workspaceId: "20000000-0000-4000-8000-000000000001",
            backend: "pi",
          },
        });
      },
    );

    const exit = await runSedesCli(
      ["tool", "invoke", "agent.context", "--input-json", "{}", "--json"],
      {
        environment: environment(),
        io: output.io,
        fetch,
        id: () => "request-1",
      },
    );

    expect(exit, output.stderr()).toBe(0);
    expect(calls.map(({ path }) => path)).toEqual([
      "/api/agent-tool-descriptions",
      SEDES_AGENT_TOOL_CSRF_ROUTE,
      "/api/agent-tool-invocations",
    ]);
    expect(JSON.parse(output.stdout())).toEqual({
      threadId: sourceThreadId,
      workspaceId: "20000000-0000-4000-8000-000000000001",
      backend: "pi",
    });
  });

  it("keeps invoke caller-abort-only after discovery", async () => {
    vi.useFakeTimers();
    try {
      const output = bufferedIo();
      const base = artifacts().find(({ id }) => id === "agent.context")!;
      const tool = {
        ...base,
        execution: {
          ...base.execution,
          waitCeilingMilliseconds: 90_000,
        },
      };
      let invocationSignal: AbortSignal | null = null;
      const controller = new AbortController();
      const fetch = vi.fn(
        async (input: URL | RequestInfo, init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          if (path === "/api/agent-tool-descriptions")
            return json({ tools: [tool] });
          if (path === SEDES_AGENT_TOOL_CSRF_ROUTE) {
            return json({ csrfToken: "csrf-timeout" });
          }
          invocationSignal = init?.signal ?? null;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
        },
      );

      const pending = runSedesCli(
        [
          "tool",
          "invoke",
          "agent.context",
          "--input-json",
          "{}",
          "--json",
        ],
        {
          environment: environment(),
          io: output.io,
          fetch,
          id: () => "request-timeout",
          signal: controller.signal,
        },
      );
      for (let index = 0; index < 5 && invocationSignal === null; index += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(invocationSignal).not.toBeNull();

      await vi.advanceTimersByTimeAsync(600_000);
      expect(invocationSignal!.aborted).toBe(false);
      controller.abort(new Error("caller_cancelled"));
      expect(await pending).toBe(130);
      expect(output.stderr()).toContain("interrupted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches a live typed thread-status command", async () => {
    const output = bufferedIo();
    const tool = artifacts().find(({ id }) => id === "thread.status")!;
    const fetch = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/agent-tools") {
          return json({
            tools: summaries().filter(({ id }) => id === "thread.status"),
          });
        }
        if (path === "/api/agent-tool-descriptions") {
          return json({ tools: [tool] });
        }
        if (path === SEDES_AGENT_TOOL_CSRF_ROUTE)
          return json({ csrfToken: "csrf" });
        expect(JSON.parse(String(init?.body)).input).toEqual({
          threadId: targetThreadId,
        });
        return json({
          invocationId: "invocation-status",
          state: "completed",
          output: {
            threadId: targetThreadId,
            backend: "codex_app_server",
            lifecycle: "active",
            activity: "idle",
            hasActiveGoal: false,
          },
        });
      },
    );

    const exit = await runSedesCli(
      ["thread", "status", "--thread-id", targetThreadId, "--json"],
      {
        environment: environment("individual"),
        io: output.io,
        fetch,
        id: () => "request-status",
      },
    );

    expect(exit, output.stderr()).toBe(0);
    expect(JSON.parse(output.stdout()).threadId).toBe(targetThreadId);
  });

  it("dispatches a catalog-advertised typed thread-messages command", async () => {
    const output = bufferedIo();
    const canonical = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      threadControl: {} as never,
    });
    const summary = canonical
      .catalogSummaries("cli", "thread_agent")
      .find(({ id }) => id === "thread.messages")!;
    const tool = canonical.describeMany("cli", "thread_agent", [
      "thread.messages",
    ])[0]!;
    const fetch = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/agent-tools") return json({ tools: [summary] });
        if (path === "/api/agent-tool-descriptions") {
          return json({ tools: [tool] });
        }
        if (path === SEDES_AGENT_TOOL_CSRF_ROUTE)
          return json({ csrfToken: "csrf" });
        expect(JSON.parse(String(init?.body)).input).toEqual({
          threadId: targetThreadId,
        });
        return json({
          invocationId: "invocation-messages",
          state: "completed",
          output: { turns: [], nextCursor: null },
        });
      },
    );

    const exit = await runSedesCli(
      ["thread", "messages", "--thread-id", targetThreadId, "--json"],
      {
        environment: environment("individual"),
        io: output.io,
        fetch,
        id: () => "request-messages",
      },
    );

    expect(exit, output.stderr()).toBe(0);
    expect(JSON.parse(output.stdout())).toEqual({
      turns: [],
      nextCursor: null,
    });
  });

  it.each([
    {
      toolId: "thread.worktree_list",
      arguments: ["thread", "worktree-list", "--json"],
      expectedInput: {},
    },
  ])("dispatches the live $toolId named command", async (testCase) => {
    const output = bufferedIo();
    const canonical = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      threadWorktrees: {} as AgentThreadWorktreeService,
    });
    const summary = canonical
      .catalogSummaries("cli", "thread_agent")
      .find(({ id }) => id === testCase.toolId)!;
    const tool = canonical.describeMany("cli", "thread_agent", [
      testCase.toolId,
    ])[0]!;
    const fetch = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/agent-tools") return json({ tools: [summary] });
        if (path === "/api/agent-tool-descriptions")
          return json({ tools: [tool] });
        if (path === SEDES_AGENT_TOOL_CSRF_ROUTE)
          return json({ csrfToken: "csrf-worktree" });
        expect(JSON.parse(String(init?.body)).input).toEqual(
          testCase.expectedInput,
        );
        return json({
          invocationId: `invocation-${testCase.toolId}`,
          state: "completed",
          output:
            testCase.toolId === "thread.worktree_list"
              ? {
                  worktrees: [
                    {
                      rootId: "primary",
                      kind: "primary",
                      displayLabel: "sedes",
                    },
                  ],
                  preference: { rootId: null, revision: 0 },
                }
              : { preference: { rootId: null, revision: 5 } },
        });
      },
    );

    expect(
      await runSedesCli(testCase.arguments, {
        environment: environment("individual"),
        io: output.io,
        fetch,
        id: () => `request-${testCase.toolId}`,
      }),
      output.stderr(),
    ).toBe(0);
    expect(JSON.parse(output.stdout())).toHaveProperty("preference");
  });

  it("requires injected context and returns nonzero for live denial", async () => {
    const missing = bufferedIo();
    const noFetch = vi.fn();
    expect(
      await runSedesCli(["tool", "list", "--json"], {
        environment: {
          SEDES_URL: "http://127.0.0.1:4784",
          SEDES_AGENT_TOOL_CLI_MODE: "progressive",
        },
        io: missing.io,
        fetch: noFetch,
      }),
    ).toBe(1);
    expect(missing.stderr()).toContain("SEDES_AGENT_TOOL_ENDPOINT is required");
    expect(noFetch).not.toHaveBeenCalled();

    const denied = bufferedIo();
    const fetch = vi.fn(async () =>
      json(
        {
          error: {
            code: "permission_denied",
            message: "The tool is not exposed to this thread.",
            retryable: false,
          },
        },
        403,
      ),
    );
    expect(
      await runSedesCli(["tool", "list", "--json"], {
        environment: environment(),
        io: denied.io,
        fetch,
      }),
    ).toBe(1);
    expect(denied.stderr()).toContain("permission_denied");
  });

  it("refreshes bootstrap once after a stale CSRF token", async () => {
    const seenTokens: Array<string | null> = [];
    let bootstraps = 0;
    const fetch = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === SEDES_AGENT_TOOL_CSRF_ROUTE) {
          bootstraps += 1;
          return json({ csrfToken: `csrf-${bootstraps}` });
        }
        const token = new Headers(init?.headers).get("X-CSRF-Token");
        seenTokens.push(token);
        if (token === "csrf-1") {
          return json(
            {
              error: {
                code: "csrf_token_invalid",
                message: "Refresh and try again.",
                retryable: true,
              },
            },
            403,
          );
        }
        return json({
          invocationId: "invocation-retried",
          state: "completed",
          output: {},
        });
      },
    );
    const client = new SedesToolHttpClient(
      new URL(environment().SEDES_AGENT_TOOL_ENDPOINT),
      sourceCredential,
      fetch,
    );

    await expect(
      client.invoke({
        toolId: "agent.context",
        schemaVersion: 2,
        requestId: "request-retried",
        input: {},
      }),
    ).resolves.toMatchObject({ state: "completed" });
    expect(bootstraps).toBe(2);
    expect(seenTokens).toEqual(["csrf-1", "csrf-2"]);
  });

  it("times out bounded HTTP requests while preserving caller cancellation", async () => {
    const hangingFetch = vi.fn(
      async (
        _input: URL | RequestInfo,
        init?: RequestInit,
      ): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const timed = new SedesToolHttpClient(
      new URL(environment().SEDES_AGENT_TOOL_ENDPOINT),
      sourceCredential,
      hangingFetch,
      5,
    );

    await expect(timed.listTools()).rejects.toMatchObject({
      code: "timed_out",
      retryable: true,
    });

    const cancelled = new SedesToolHttpClient(
      new URL(environment().SEDES_AGENT_TOOL_ENDPOINT),
      sourceCredential,
      hangingFetch,
      10_000,
    );
    const controller = new AbortController();
    const reason = new Error("caller_cancelled");
    const pending = cancelled.listTools(controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("does not apply the discovery timeout to a production HTTP invocation", async () => {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === SEDES_AGENT_TOOL_CSRF_ROUTE) {
        response.end(JSON.stringify({ csrfToken: "csrf-node-http" }));
        return;
      }
      setTimeout(
        () =>
          response.end(
            JSON.stringify({
              invocationId: "invocation-node-http",
              state: "completed",
              output: {},
            }),
          ),
        100,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("test_server");
      const client = new SedesToolHttpClient(
        new URL(`http://127.0.0.1:${address.port}`),
        sourceCredential,
        globalThis.fetch,
        50,
      );
      await expect(
        client.invoke({
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: "request-node-http",
          input: {},
        }),
      ).resolves.toMatchObject({ state: "completed" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("keeps a pre-delivery HTTP invocation failure retryable", async () => {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Connection", "close");
      if (request.url === SEDES_AGENT_TOOL_CSRF_ROUTE) {
        response.end(JSON.stringify({ csrfToken: "csrf-pre-delivery" }));
        return;
      }
      response.end(
        JSON.stringify({
          invocationId: "invocation-prime",
          state: "completed",
          output: {},
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test_server");
    const client = new SedesToolHttpClient(
      new URL(`http://127.0.0.1:${address.port}`),
      sourceCredential,
    );
    await client.invoke({
      toolId: "agent.context",
      schemaVersion: 2,
      requestId: "request-prime",
      input: {},
    });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

    await expect(
      client.invoke({
        toolId: "agent.context",
        schemaVersion: 2,
        requestId: "request-pre-delivery",
        input: {},
      }),
    ).rejects.toMatchObject({
      code: "transport_error",
      retryable: true,
    });
  });

  it("keeps a post-delivery HTTP read failure retryable", async () => {
    const server = createServer((request) => request.socket.destroy());
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("test_server");
      const client = new SedesToolHttpClient(
        new URL(`http://127.0.0.1:${address.port}`),
        sourceCredential,
      );

      await expect(client.listTools()).rejects.toMatchObject({
        code: "transport_error",
        retryable: true,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("reports a post-delivery HTTP invocation failure as uncertain", async () => {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === SEDES_AGENT_TOOL_CSRF_ROUTE) {
        response.end(JSON.stringify({ csrfToken: "csrf-post-delivery" }));
        return;
      }
      request.once("end", () => request.socket.destroy());
      request.resume();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("test_server");
      const client = new SedesToolHttpClient(
        new URL(`http://127.0.0.1:${address.port}`),
        sourceCredential,
      );

      await expect(
        client.invoke({
          toolId: "thread.send",
          schemaVersion: 4,
          requestId: "request-post-delivery",
          input: { threadId: targetThreadId, message: "Continue" },
        }),
      ).rejects.toMatchObject({
        code: "uncertain_outcome",
        retryable: false,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("preserves caller cancellation after an HTTP invocation is delivered", async () => {
    let markDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => {
      markDelivered = resolve;
    });
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === SEDES_AGENT_TOOL_CSRF_ROUTE) {
        response.end(JSON.stringify({ csrfToken: "csrf-cancel" }));
        return;
      }
      request.once("end", markDelivered);
      request.resume();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("test_server");
      const client = new SedesToolHttpClient(
        new URL(`http://127.0.0.1:${address.port}`),
        sourceCredential,
      );
      const controller = new AbortController();
      const reason = new Error("caller_cancelled");
      const pending = client.invoke(
        {
          toolId: "thread.send",
          schemaVersion: 4,
          requestId: "request-cancelled",
          input: { threadId: targetThreadId, message: "Continue" },
        },
        controller.signal,
      );
      await delivered;
      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects incomplete reserved tool commands before network access", async () => {
    for (const arguments_ of [
      ["tool"],
      ["tool", "describe"],
      ["tool", "invoke"],
    ]) {
      const output = bufferedIo();
      const fetch = vi.fn();
      expect(
        await runSedesCli(arguments_, {
          environment: environment(),
          io: output.io,
          fetch,
        }),
      ).toBe(2);
      expect(output.stderr()).toContain("complete tool command");
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("accepts the equals form of --input-json", async () => {
    const output = bufferedIo();
    const tool = artifacts().find(({ id }) => id === "agent.context")!;
    const paths: string[] = [];
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/api/agent-tool-descriptions")
        return json({ tools: [tool] });
      if (path === SEDES_AGENT_TOOL_CSRF_ROUTE) {
        return json({ csrfToken: "csrf-equals" });
      }
      return json({
        invocationId: "invocation-equals",
        state: "completed",
        output: {},
      });
    });

    expect(
      await runSedesCli(
        ["tool", "invoke", "agent.context", "--input-json={}", "--json"],
        {
          environment: environment(),
          io: output.io,
          fetch,
          id: () => "request-equals",
        },
      ),
    ).toBe(0);
    expect(paths).toEqual([
      "/api/agent-tool-descriptions",
      SEDES_AGENT_TOOL_CSRF_ROUTE,
      "/api/agent-tool-invocations",
    ]);
  });

  it("reports a schema-valid oversized input as a transport limit", async () => {
    const output = bufferedIo();
    const tool = {
      ...artifacts().find(({ id }) => id === "agent.context")!,
      execution: {
        ...artifacts().find(({ id }) => id === "agent.context")!.execution,
        maximumInputBytes: 1,
      },
    };
    const fetch = vi.fn(async () => json({ tools: [tool] }));

    expect(
      await runSedesCli(
        [
          "tool",
          "invoke",
          "agent.context",
          "--input-json",
          "{}",
          "--json",
        ],
        { environment: environment(), io: output.io, fetch },
      ),
    ).toBe(2);
    expect(output.stderr()).toContain("1-byte transport limit");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
