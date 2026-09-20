import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendKind } from "../../src/server/backends/contracts.js";
import { DomainError } from "../../src/server/domain/errors.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import type { ThreadMessagesInput } from "../../src/server/conversations/thread-messages-service.js";
import { SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER } from "../../src/server/agent-tools/http/agent-tool-http-contracts.js";
import { PolicyCheckedAgentToolHttpService } from "../../src/server/agent-tools/http/agent-tool-http-service.js";
import { createAgentToolRouter } from "../../src/server/agent-tools/http/agent-tool-router.js";
import {
  CanonicalAgentToolRequestError,
  CanonicalInlineAgentToolService,
} from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { createThreadCreateToolDefinition } from "../../src/server/agent-tools/tools/thread-management-tools.js";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import { unavailablePrincipalAgentToolClientService } from "../support/agent-tool-http.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

const scope: RequestScope = {
  tenantId: "019196f7-a0a8-7bc4-a89b-8cf013978400",
  principalId: "019196f7-a0a8-7bc4-a89b-8cf013978401",
};
const workspaceId = "019196f7-a0a8-7bc4-a89b-8cf013978402";
const sourceThreadIds: Record<BackendKind, string> = {
  pi: "019196f7-a0a8-7bc4-a89b-8cf013978410",
  codex_app_server: "019196f7-a0a8-7bc4-a89b-8cf013978411",
  claude_agent_sdk: "019196f7-a0a8-7bc4-a89b-8cf013978412",
  grok_build: "019196f7-a0a8-7bc4-a89b-8cf013978413",
};
const targetThreadId = "019196f7-a0a8-7bc4-a89b-8cf013978420";
const childThreadId = "019196f7-a0a8-7bc4-a89b-8cf013978421";

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("agent_control_test_listener_invalid");
  }
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function buildSedesToolExecutable(): Promise<string> {
  const buildRoot = await mkdtemp(
    path.resolve(".agent-control-cli-test-build-"),
  );
  temporaryRoots.push(buildRoot);
  const outputRoot = path.join(buildRoot, "output");
  const compilerConfiguration = path.join(buildRoot, "tsconfig.json");
  await writeFile(
    compilerConfiguration,
    JSON.stringify({
      extends: path.resolve("tsconfig.server.json"),
      compilerOptions: { outDir: outputRoot },
      include: [],
      files: [path.resolve("src/cli/provider-bin/sedes.ts")],
    }),
    "utf8",
  );
  await execFileAsync(
    process.execPath,
    [
      path.resolve("node_modules/typescript/bin/tsc"),
      "--project",
      compilerConfiguration,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  const compiled = path.join(outputRoot, "cli", "provider-bin", "sedes.js");
  const executable = path.join(outputRoot, "cli", "provider-bin", "sedes");
  await copyFile(compiled, executable);
  await chmod(executable, 0o755);
  return executable;
}

type SettledTurn = {
  readonly id: string;
  readonly revision: number;
  readonly status: "completed";
  readonly forkable: boolean;
  readonly messages: readonly {
    readonly role: "user" | "assistant";
    readonly text: { readonly text: string };
  }[];
};

function fixture() {
  const sources = new Map(
    Object.entries(sourceThreadIds).map(([backend, sourceThreadId]) => [
      sourceThreadId,
      backend as BackendKind,
    ]),
  );
  const sourceCapabilities = new Map(
    [...sources.keys()].map((sourceThreadId, index) => [
      sourceThreadId,
      `agent-control-capability-${index}-${"x".repeat(32)}`,
    ]),
  );
  const sourceByCapability = new Map(
    [...sourceCapabilities].map(([threadId, capability]) => [
      capability,
      threadId,
    ]),
  );
  const policies = new Map(
    [...sources.keys()].map((sourceThreadId) => [
      sourceThreadId,
      {
        enabled: false,
        revision: 1,
        presentation: { surface: "cli" as const, mode: "progressive" as const },
        accessBoundary: "environment" as const,
        enabledToolIds: [
          "thread.status",
          "thread.create",
          "thread.messages",
          "thread.send",
          "thread.fork",
          "thread.archive",
          "thread.restore",
        ],
      },
    ]),
  );
  const drafts = new Map<string, string>();
  const turns = new Map<string, SettledTurn[]>([[childThreadId, []]]);
  let turnSequence = 0;
  const requireThread = (threadId: string) => {
    const found = turns.get(threadId);
    if (!found) throw new DomainError("not_found", "Thread not found.");
    return found;
  };
  const controls = {
    messages: {
      async list(
        requestScope: RequestScope,
        threadId: string,
        input: ThreadMessagesInput,
      ) {
        expect(requestScope).toEqual(scope);
        return {
          turns: requireThread(threadId).slice(-(input.pageSize ?? 10)),
          nextCursor: null,
          activeTurn: null,
        };
      },
    },
    send: {
      async sendDirect(
        requestScope: RequestScope,
        input: {
          readonly initiator:
            | {
                readonly kind: "thread_agent";
                readonly sourceThreadId: string;
                readonly sourceWorkspaceId: string;
              }
            | {
                readonly kind: "principal_client";
                readonly clientId: string;
              };
          readonly targetThreadId: string;
          readonly message: string;
          readonly callback?: boolean;
          readonly mutationId: string;
        },
      ) {
        expect(requestScope).toEqual(scope);
        if (input.initiator.kind !== "thread_agent") {
          throw new Error("principal_client_not_used_by_this_fixture");
        }
        expect(sources.has(input.initiator.sourceThreadId)).toBe(true);
        const destination = requireThread(input.targetThreadId);
        const id = `turn-${++turnSequence}`;
        destination.push({
          id,
          revision: 1,
          status: "completed",
          forkable: true,
          messages: [
            { role: "user", text: { text: input.message } },
            {
              role: "assistant",
              text: { text: `Completed: ${input.message}` },
            },
          ],
        });
        return {
          status: "delivery_accepted" as const,
          operationId: input.mutationId,
          ...(input.callback
            ? { callbackId: `callback-${input.mutationId}` }
            : {}),
        };
      },
    },
    forks: {
      async forkAgent(input: {
        readonly scope: RequestScope;
        readonly controllerThreadId: string;
        readonly sourceThreadId: string;
        readonly sourceTurnId: string;
        readonly expectedTurnRevision: number;
      }) {
        expect(input.scope).toEqual(scope);
        expect(sources.has(input.controllerThreadId)).toBe(true);
        const sourceTurns = requireThread(input.sourceThreadId);
        const index = sourceTurns.findIndex(
          ({ id, revision }) =>
            id === input.sourceTurnId &&
            revision === input.expectedTurnRevision,
        );
        if (index < 0) throw new DomainError("conflict", "Turn changed.");
        turns.set(childThreadId, sourceTurns.slice(0, index + 1));
        return { status: "created" as const, childThreadId };
      },
      async forkPrincipalClient() {
        throw new Error("principal_client_not_used_by_this_fixture");
      },
    },
    inventory: {
      async archive(_requestScope: RequestScope, input: { threadId: string }) {
        requireThread(input.threadId);
        return { threadId: input.threadId, archivedThreadCount: 1 };
      },
      async restore(_requestScope: RequestScope, input: { threadId: string }) {
        requireThread(input.threadId);
        return { threadId: input.threadId };
      },
    },
  };
  const application = {
    async readThreadStatus(requestScope: RequestScope, threadId: string) {
      expect(requestScope).toEqual(scope);
      if (!turns.has(threadId)) return undefined;
      return {
        threadId,
        backend: "pi" as const,
        lifecycle: "active" as const,
        activity: "idle" as const,
      };
    },
    async resolve(_request: express.Request, sourceCapability: string) {
      const sourceThreadId = sourceByCapability.get(sourceCapability);
      if (!sourceThreadId) {
        throw new CanonicalAgentToolRequestError(
          "permission_denied",
          "The agent-tool source capability is invalid or expired.",
        );
      }
      const backendKind = sources.get(sourceThreadId);
      if (!backendKind) {
        throw new CanonicalAgentToolRequestError(
          "not_found",
          "The requested source thread was not found.",
        );
      }
      return {
        scope,
        sourceThreadId,
        sourceWorkspaceId: workspaceId,
        sourceEnvironmentId: "environment-1",
        backendKind,
      };
    },
  };
  const threadCreation = createThreadCreateToolDefinition({
    async createThread(requestScope, input, caller) {
      expect(requestScope).toEqual(scope);
      expect(caller).toMatchObject({
        kind: "agent_tool",
        initiator: {
          kind: "thread_agent",
          sourceWorkspaceId: workspaceId,
        },
      });
      if (turns.has(targetThreadId)) {
        throw new DomainError("conflict", "The test thread already exists.");
      }
      turns.set(targetThreadId, []);
      drafts.set(targetThreadId, "");
      return {
        threadId: targetThreadId,
        workspaceId: input.workspaceId,
        targetId: input.configuration.targetId ?? "pi-local",
      };
    },
  });
  const canonical = new CanonicalInlineAgentToolService({
    application,
    threadControl: controls,
    additionalDefinitions: [threadCreation],
    invocationId: () => "agent-control-invocation",
    mutationId: () => "019196f7-a0a8-7bc4-a89b-8cf013978430",
  });
  const authorityReader = {
    resolveEnvironment: (_requestScope: RequestScope, id: string) => ({
      id,
      environmentId: id,
      label: id,
    }),
    resolveWorkspace: (_requestScope: RequestScope, id: string) => ({
      id,
      environmentId: "environment-1",
      label: id,
    }),
    resolveThread: (_requestScope: RequestScope, id: string) =>
      turns.has(id) || sources.has(id)
        ? { id, environmentId: "environment-1", label: id }
        : undefined,
    resolveThreadFamily: (_requestScope: RequestScope, id: string) =>
      turns.has(id)
        ? [{ id, environmentId: "environment-1", label: id }]
        : undefined,
    resolveTask: () => undefined,
    resolveWorkpad: () => undefined,
    resolveSavedAgent: () => undefined,
    listEnvironments: () => [
      {
        id: "environment-1",
        environmentId: "environment-1",
        label: "Environment 1",
      },
    ],
  };
  const scoped = new SourceScopedAgentToolService(
    canonical,
    {
      get: (_requestScope: RequestScope, id: string) => policies.get(id)!,
    } as never,
    new AgentToolEnvironmentAuthorityResolver(authorityReader),
    {
      resolveInScope(_requestScope, sourceThreadId) {
        const backendKind = sources.get(sourceThreadId);
        if (!backendKind) {
          throw new CanonicalAgentToolRequestError(
            "not_found",
            "The requested source thread was not found.",
          );
        }
        return {
          scope,
          sourceThreadId,
          sourceWorkspaceId: workspaceId,
          sourceEnvironmentId: "environment-1",
          backendKind,
        };
      },
    },
    {
      acquireAgentToolApprovalAuthority: async () => ({
        generation: "generation-1",
        signal: new AbortController().signal,
        isCurrent: () => true,
        release: () => undefined,
      }),
    },
    {
      requestApplicationDecision: async () => "deny" as const,
    },
  );
  const tools = new PolicyCheckedAgentToolHttpService(scoped);
  const app = express();
  app.use(express.json({ strict: true, type: "application/json" }));
  app.get("/api/agent-tool-csrf", (_request, response) => {
    response.json({ csrfToken: "agent-control-test-csrf" });
  });
  app.use(
    createAgentToolRouter({
      sources: application,
      tools,
      clients: unavailablePrincipalAgentToolClientService(),
    }),
  );
  return {
    app,
    canonical,
    controls,
    drafts,
    policies,
    turns,
    sourceCapabilities,
  };
}

describe("agent control tools through canonical adapters", () => {
  it("keeps the five tools default-off and exposes the same bounded contracts for Pi, Codex, Claude, and Grok", async () => {
    const value = fixture();
    for (const [backend, sourceThreadId] of Object.entries(sourceThreadIds)) {
      await request(value.app)
        .get("/api/agent-tools")
        .set(
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
          value.sourceCapabilities.get(sourceThreadId)!,
        )
        .expect(200)
        .expect(({ body }) => expect(body.tools).toEqual([]));

      value.policies.get(sourceThreadId)!.enabled = true;
      await request(value.app)
        .get("/api/agent-tools")
        .set(
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
          value.sourceCapabilities.get(sourceThreadId)!,
        )
        .expect(200)
        .expect(({ body }) =>
          expect(body.tools.map(({ id }: { id: string }) => id)).toEqual([
            "thread.status",
            "thread.create",
            "thread.messages",
            "thread.send",
            "thread.fork",
            "thread.archive",
            "thread.restore",
          ]),
        );
      await request(value.app)
        .post("/api/agent-tool-invocations")
        .set(
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
          value.sourceCapabilities.get(sourceThreadId)!,
        )
        .send({
          toolId: "thread.messages",
          schemaVersion: 4,
          requestId: `messages-${backend}`,
          input: { threadId: childThreadId },
        })
        .expect(200)
        .expect(({ body }) =>
          expect(body.output).toEqual({
            turns: [],
            nextCursor: null,
            activeTurn: null,
          }),
        );

      const adapter = backend === "pi" ? "pi_sdk" : "cli";
      expect(
        value.canonical
          .catalog(adapter, "thread_agent")
          .filter(({ id }) => id.startsWith("thread."))
          .map(({ id }) => id),
      ).toEqual([
        "thread.status",
        "thread.create",
        "thread.messages",
        "thread.send",
        "thread.fork",
        "thread.archive",
        "thread.restore",
      ]);
      if (backend === "pi") {
        await expect(
          value.canonical.invoke(
            {
              toolId: "thread.messages",
              schemaVersion: 4,
              requestId: "pi-native-messages",
              input: { threadId: childThreadId },
            },
            {
              scope,
              subject: {
                kind: "thread_agent",
                sourceThreadId,
                backendKind: "pi",
              },
              defaults: {
                kind: "thread_agent",
                environmentId: "environment-1",
                workspaceId,
                threadId: sourceThreadId,
              },
              policyIdentity: {
                ownerKind: "thread",
                ownerId: sourceThreadId,
                revision: 1,
              },
              environmentAuthority: {
                id: "grant-native",
                callerKind: "thread_agent",
                defaults: {
                  kind: "thread_agent",
                  environmentId: "environment-1",
                  workspaceId,
                  threadId: sourceThreadId,
                },
                policyIdentity: {
                  ownerKind: "thread",
                  ownerId: sourceThreadId,
                  revision: 1,
                },
                admittedEnvironmentIds: ["environment-1"],
                targetEnvironmentIds: [],
                resolvedResourceRefs: [
                  {
                    kind: "thread",
                    id: childThreadId,
                    environmentId: "environment-1",
                  },
                ],
                canonicalInputDigest: "input-digest",
                authorityDigest: "authority-digest",
                display: { targetEnvironmentLabels: [], resourceLabels: [] },
              },
              adapter: "pi_sdk",
              signal: new AbortController().signal,
            },
          ),
        ).resolves.toMatchObject({
          state: "completed",
          output: { turns: [], nextCursor: null, activeTurn: null },
        });
      }
    }
  });

  it("composes create, send, status, messages, fork, and child send without changing the human draft", async () => {
    const value = fixture();
    const sourceThreadId = sourceThreadIds.pi;
    value.policies.get(sourceThreadId)!.enabled = true;
    const invoke = (requestId: string, toolId: string, input: object) =>
      request(value.app)
        .post("/api/agent-tool-invocations")
        .set(
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
          value.sourceCapabilities.get(sourceThreadId)!,
        )
        .send({
          toolId,
          schemaVersion:
            toolId === "thread.create"
              ? 5
              : toolId === "thread.messages"
                ? 4
                : toolId === "thread.send"
                  ? 2
                : toolId === "thread.status"
                  ? 2
                  : 1,
          requestId,
          input,
        });

    await invoke("create-parent", "thread.create", {
      title: "Agent-created parent",
      configuration: { kind: "custom", targetId: "pi-local" },
    })
      .expect(200)
      .expect(({ body }) =>
        expect(body.output).toEqual({
          threadId: targetThreadId,
          workspaceId,
          targetId: "pi-local",
        }),
      );
    value.drafts.set(targetThreadId, "unfinished human draft");

    await invoke("send-parent", "thread.send", {
      threadId: targetThreadId,
      message: "Inspect the implementation",
      callback: true,
    })
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          state: "completed",
          output: {
            status: "delivery_accepted",
            callbackId:
              "callback-019196f7-a0a8-7bc4-a89b-8cf013978430",
          },
        }),
      );
    expect(value.drafts.get(targetThreadId)).toBe("unfinished human draft");

    await request(value.app)
      .post("/api/agent-tool-invocations")
      .set(
        SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
        value.sourceCapabilities.get(sourceThreadId)!,
      )
      .send({
        toolId: "thread.status",
        schemaVersion: 2,
        requestId: "status-parent",
        input: { threadId: targetThreadId },
      })
      .expect(200)
      .expect(({ body }) =>
        expect(body.output).toMatchObject({
          threadId: targetThreadId,
          activity: "idle",
        }),
      );

    const messages = await invoke("messages-parent", "thread.messages", {
      threadId: targetThreadId,
      pageSize: 10,
    }).expect(200);
    expect(messages.body.output.turns).toEqual([
      expect.objectContaining({
        id: "turn-1",
        revision: 1,
        messages: [
          { role: "user", text: { text: "Inspect the implementation" } },
          {
            role: "assistant",
            text: { text: "Completed: Inspect the implementation" },
          },
        ],
      }),
    ]);
    expect(messages.body.output.activeTurn).toBeNull();

    await invoke("fork-parent", "thread.fork", {
      threadId: targetThreadId,
      sourceTurnId: "turn-1",
      expectedTurnRevision: 1,
    })
      .expect(200)
      .expect(({ body }) =>
        expect(body.output).toEqual({
          status: "created",
          childThreadId,
        }),
      );
    await invoke("send-child", "thread.send", {
      threadId: childThreadId,
      message: "Try the alternate approach",
    }).expect(200);
    expect(value.turns.get(childThreadId)).toHaveLength(2);
    expect(value.drafts.get(targetThreadId)).toBe("unfinished human draft");
  });

  it("fails closed for disabled policy, unknown sources, and unknown targets", async () => {
    const value = fixture();
    const sourceThreadId = sourceThreadIds.codex_app_server;
    const input = {
      toolId: "thread.send",
      schemaVersion: 2,
      requestId: "denial-check",
      input: { threadId: targetThreadId, message: "Do not deliver" },
    };
    await request(value.app)
      .post("/api/agent-tool-invocations")
      .set(
        SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
        value.sourceCapabilities.get(sourceThreadId)!,
      )
      .send(input)
      .expect(403);

    value.policies.get(sourceThreadId)!.enabled = true;
    await request(value.app)
      .post("/api/agent-tool-invocations")
      .set(
        SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
        "019196f7-a0a8-7bc4-a89b-8cf013978499",
      )
      .send(input)
      .expect(403);
    value.turns.set(targetThreadId, []);
    await request(value.app)
      .post("/api/agent-tool-invocations")
      .set(
        SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
        value.sourceCapabilities.get(sourceThreadId)!,
      )
      .send({
        ...input,
        requestId: "unknown-target",
        input: {
          threadId: "019196f7-a0a8-7bc4-a89b-8cf013978498",
          message: "Do not deliver",
        },
      })
      .expect(404);
    expect(value.turns.get(targetThreadId)).toEqual([]);
  });

  it("discovers and composes the controls through the compiled generic CLI", async () => {
    const value = fixture();
    const sourceThreadId = sourceThreadIds.claude_agent_sdk;
    value.policies.get(sourceThreadId)!.enabled = true;
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-control-cli-"));
    temporaryRoots.push(root);
    const executable = await buildSedesToolExecutable();
    await symlink(executable, path.join(root, "sedes"));
    const server = createServer(value.app);
    try {
      const port = await listen(server);
      const environment = {
        ...process.env,
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
        SEDES_AGENT_TOOL_ENDPOINT: `http://127.0.0.1:${port}`,
        SEDES_AGENT_TOOL_SOURCE_CAPABILITY:
          value.sourceCapabilities.get(sourceThreadId)!,
        SEDES_AGENT_TOOL_CLI_MODE: "progressive",
      };
      const run = (arguments_: readonly string[]) =>
        execFileAsync("sedes", arguments_, {
          cwd: root,
          env: environment,
          encoding: "utf8",
          timeout: 10_000,
        });

      const catalog = JSON.parse(
        (await run(["tool", "list", "--json"])).stdout,
      );
      expect(catalog.tools.map(({ id }: { id: string }) => id)).toEqual([
        "thread.status",
        "thread.create",
        "thread.messages",
        "thread.send",
        "thread.fork",
        "thread.archive",
        "thread.restore",
      ]);
      const created = JSON.parse(
        (
          await run([
            "tool",
            "invoke",
            "thread.create",
            "--input-json",
            JSON.stringify({
              title: "CLI-created parent",
              configuration: { kind: "custom", targetId: "pi-local" },
            }),
            "--json",
          ])
        ).stdout,
      );
      expect(created.threadId).toBe(targetThreadId);
      value.drafts.set(targetThreadId, "unfinished human draft");
      const sent = JSON.parse(
        (
          await run([
            "tool",
            "invoke",
            "thread.send",
            "--input-json",
            JSON.stringify({
              threadId: targetThreadId,
              message: "CLI parent message",
            }),
            "--json",
          ])
        ).stdout,
      );
      expect(sent).toMatchObject({
        status: "delivery_accepted",
      });
      const messages = JSON.parse(
        (
          await run([
            "tool",
            "invoke",
            "thread.messages",
            "--input-json",
            JSON.stringify({ threadId: targetThreadId }),
            "--json",
          ])
        ).stdout,
      );
      expect(messages.turns[0]).toMatchObject({ id: "turn-1" });
      const forked = JSON.parse(
        (
          await run([
            "tool",
            "invoke",
            "thread.fork",
            "--input-json",
            JSON.stringify({
              threadId: targetThreadId,
              sourceTurnId: "turn-1",
              expectedTurnRevision: 1,
            }),
            "--json",
          ])
        ).stdout,
      );
      const archived = JSON.parse(
        (
          await run([
            "tool",
            "invoke",
            "thread.archive",
            "--input-json",
            JSON.stringify({ threadId: targetThreadId }),
            "--json",
          ])
        ).stdout,
      );
      expect(archived).toEqual({
        threadId: targetThreadId,
        archivedThreadCount: 1,
      });
      const restored = JSON.parse(
        (
          await run([
            "tool",
            "invoke",
            "thread.restore",
            "--input-json",
            JSON.stringify({ threadId: targetThreadId }),
            "--json",
          ])
        ).stdout,
      );
      expect(restored).toEqual({ threadId: targetThreadId });
      expect(forked).toEqual({ status: "created", childThreadId });
      await run([
        "tool",
        "invoke",
        "thread.send",
        "--input-json",
        JSON.stringify({
          threadId: childThreadId,
          message: "CLI child message",
        }),
        "--json",
      ]);
      expect(value.turns.get(childThreadId)).toHaveLength(2);
      expect(value.drafts.get(targetThreadId)).toBe("unfinished human draft");
    } finally {
      if (server.listening) await close(server);
    }
  }, 30_000);
});
