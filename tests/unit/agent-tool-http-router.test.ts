import { randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import {
  SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER,
  SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
} from "../../src/server/agent-tools/http/agent-tool-http-contracts.js";
import {
  PolicyCheckedAgentToolHttpService,
  type ResolvedAgentToolSourceContext,
} from "../../src/server/agent-tools/http/agent-tool-http-service.js";
import type { BackendAgentToolPolicy } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import type { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { createAgentToolRouter } from "../../src/server/agent-tools/http/agent-tool-router.js";
import { unavailablePrincipalAgentToolClientService } from "../support/agent-tool-http.js";

const sourceThreadId = "10000000-0000-4000-8000-000000000001";
const sourceCapability = randomBytes(32).toString("base64url");
const targetThreadId = "10000000-0000-4000-8000-000000000002";

function fixture() {
  let policy: BackendAgentToolPolicy = {
    enabled: true,
    presentation: { surface: "cli", mode: "progressive" },
    accessBoundary: "environment",
    enabledToolIds: ["agent.context", "thread.status"],
  };
  const source: ResolvedAgentToolSourceContext = {
    scope: { tenantId: "tenant-1", principalId: "principal-1" },
    sourceThreadId,
    sourceWorkspaceId: "20000000-0000-4000-8000-000000000001",
    sourceEnvironmentId: "environment-1",
    backendKind: "pi",
  };
  const sources = {
    resolve: vi.fn(async (_request: express.Request, capability: string) => {
      if (capability !== sourceCapability) throw new Error("unexpected_source");
      return source;
    }),
  };
  const canonical = new CanonicalInlineAgentToolService({
    application: {
      async readThreadStatus(_scope, threadId) {
        if (threadId !== targetThreadId) return undefined;
        return {
          threadId,
          backend: "codex_app_server",
          lifecycle: "active",
          activity: "idle",
        };
      },
    },
    invocationId: () => "invocation-1",
  });
  const scoped = new SourceScopedAgentToolService(
    canonical,
    {
      get: vi.fn(() => ({ ...policy, revision: 1 })),
    } as unknown as ThreadAgentToolPolicyRepository,
    new AgentToolEnvironmentAuthorityResolver({
      resolveEnvironment: () => undefined,
      resolveWorkspace: () => undefined,
      resolveThread: (_scope, id) =>
        id === targetThreadId
          ? { id, environmentId: "environment-1", label: "Target" }
          : undefined,
      resolveThreadFamily: () => undefined,
      resolveTask: () => undefined,
    resolveWorkpad: () => undefined,
    resolveSavedAgent: () => undefined,
      listEnvironments: () => [
        { id: "environment-1", environmentId: "environment-1", label: "Local" },
      ],
    }),
    { resolveInScope: () => source },
    {
      acquireAgentToolApprovalAuthority: async () => ({
        generation: "generation-1",
        signal: new AbortController().signal,
        isCurrent: () => true,
        release: () => undefined,
      }),
    },
    { requestApplicationDecision: async () => "allow" },
  );
  const tools = new PolicyCheckedAgentToolHttpService(scoped);
  const clients = unavailablePrincipalAgentToolClientService();
  const app = express();
  app.use(express.json({ strict: true, type: "application/json" }));
  app.use(
    createAgentToolRouter({
      sources,
      tools,
      clients,
    }),
  );
  app.use(
    (
      _error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      response.status(500).json({ error: { code: "internal_error" } });
    },
  );
  return {
    app,
    sources,
    tools,
    clients,
    setPolicy(next: BackendAgentToolPolicy) {
      policy = next;
    },
  };
}

function associated(test: request.Test) {
  return test.set(SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER, sourceCapability);
}

describe("agent tool HTTP router", () => {
  it("lists compact summaries and batch-describes only current tools in request order", async () => {
    const value = fixture();
    value.setPolicy({
      enabled: true,
      presentation: { surface: "cli", mode: "progressive" },
      accessBoundary: "environment",
      enabledToolIds: ["thread.status"],
    });

    const catalog = await associated(
      request(value.app).get("/api/agent-tools"),
    ).expect(200);
    expect(catalog.body.tools.map(({ id }: { id: string }) => id)).toEqual([
      "thread.status",
    ]);
    expect(catalog.body.tools[0]).not.toHaveProperty("inputSchema");
    expect(catalog.body.tools[0]).not.toHaveProperty("execution");
    expect(catalog.body.tools[0]).not.toHaveProperty("adapters");
    expect(catalog.headers["cache-control"]).toBe("no-store");

    await associated(request(value.app).post("/api/agent-tool-descriptions"))
      .send({ toolIds: ["agent.context"] })
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe("not_found"));
    await associated(request(value.app).post("/api/agent-tool-descriptions"))
      .send({ toolIds: ["thread.status"] })
      .expect(200)
      .expect(({ body }) => {
        expect(body.tools).toHaveLength(1);
        expect(body.tools[0]).toMatchObject({
          id: "thread.status",
          execution: { waitCeilingMilliseconds: 30_000 },
        });
        expect(body.tools[0]).not.toHaveProperty("adapters");
      });
  });

  it("enforces strict bounded atomic batch description", async () => {
    const value = fixture();

    for (const toolIds of [
      [],
      ["agent.context", "agent.context"],
      Array.from({ length: 17 }, (_, index) => `tool.${index}`),
    ]) {
      await associated(request(value.app).post("/api/agent-tool-descriptions"))
        .send({ toolIds })
        .expect(400);
    }
    await associated(request(value.app).post("/api/agent-tool-descriptions"))
      .send({
        toolIds: Array.from({ length: 16 }, (_, index) => `tool.${index}`),
      })
      .expect(404);

    await associated(request(value.app).post("/api/agent-tool-descriptions"))
      .send({ toolIds: ["thread.status", "agent.context"] })
      .expect(200)
      .expect(({ body }) =>
        expect(body.tools.map(({ id }: { id: string }) => id)).toEqual([
          "thread.status",
          "agent.context",
        ]),
      );

    await associated(request(value.app).post("/api/agent-tool-descriptions"))
      .send({ toolIds: ["thread.status", "task.list"] })
      .expect(404)
      .expect(({ body }) => expect(body).not.toHaveProperty("tools"));

    await associated(
      request(value.app).get("/api/agent-tools/thread.status"),
    ).expect(404);
  });

  it.each(["progressive", "individual"] as const)(
    "fails closed over HTTP while the Pi thread uses native/%s presentation",
    async (presentationMode) => {
      const value = fixture();
      value.setPolicy({
        enabled: true,
        presentation: { surface: "native", mode: presentationMode },
        accessBoundary: "environment",
        enabledToolIds: ["agent.context", "thread.status"],
      });

      await associated(request(value.app).get("/api/agent-tools"))
        .expect(200)
        .expect(({ body }) => expect(body.tools).toEqual([]));
      await associated(request(value.app).post("/api/agent-tool-descriptions"))
        .send({ toolIds: ["agent.context"] })
        .expect(404);
      await associated(request(value.app).post("/api/agent-tool-invocations"))
        .send({
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: `${presentationMode}-request`,
          input: {},
        })
        .expect(403);
    },
  );

  it("requires one exact source header and bodyless query-free GETs", async () => {
    const value = fixture();
    await request(value.app).get("/api/agent-tools").expect(400);
    await request(value.app)
      .get("/api/agent-tools")
      .set(SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER, "not-a-capability")
      .expect(400);
    await request(value.app)
      .get("/api/agent-tools")
      .set(SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER, [
        sourceCapability,
        sourceCapability,
      ] as unknown as string)
      .expect(400);
    await associated(
      request(value.app).get("/api/agent-tools?all=true"),
    ).expect(400);
    await associated(
      request(value.app)
        .get("/api/agent-tools")
        .set("Content-Type", "application/json")
        .send({}),
    ).expect(400);
    expect(value.sources.resolve).not.toHaveBeenCalled();
  });

  it("routes one bounded client credential and rejects ambiguous authority headers", async () => {
    const value = fixture();
    const credential = `hatc1_10000000-0000-4000-8000-000000000003_1_${"A".repeat(43)}`;
    const catalog = vi
      .spyOn(value.clients, "catalogSummaries")
      .mockReturnValue([]);

    await request(value.app)
      .get("/api/agent-tools")
      .set(SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER, credential)
      .expect(200)
      .expect(({ body }) => expect(body).toEqual({ tools: [] }));
    expect(catalog).toHaveBeenCalledWith(credential);
    expect(value.sources.resolve).not.toHaveBeenCalled();

    for (const test of [
      request(value.app)
        .get("/api/agent-tools")
        .set(SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER, sourceCapability)
        .set(SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER, credential),
      request(value.app)
        .get("/api/agent-tools")
        .set(
          SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER,
          `${credential},${credential}`,
        ),
      request(value.app)
        .get("/api/agent-tools")
        .set(SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER, "x".repeat(257)),
      request(value.app)
        .get("/api/agent-tools")
        .set(SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER, [
          credential,
          credential,
        ] as unknown as string),
    ]) {
      await test.expect(400);
    }
    expect(catalog).toHaveBeenCalledTimes(1);
  });

  it("rechecks current policy immediately before inline invocation", async () => {
    const value = fixture();
    await associated(request(value.app).get("/api/agent-tools"))
      .expect(200)
      .expect(({ body }) => expect(body.tools).toHaveLength(2));

    value.setPolicy({
      enabled: false,
      presentation: { surface: "cli", mode: "progressive" },
      accessBoundary: "environment",
      enabledToolIds: ["thread.status"],
    });
    await associated(request(value.app).post("/api/agent-tool-invocations"))
      .send({
        toolId: "thread.status",
        schemaVersion: 2,
        requestId: "request-1",
        input: { threadId: targetThreadId },
      })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe("permission_denied"));

    value.setPolicy({
      enabled: true,
      presentation: { surface: "cli", mode: "progressive" },
      accessBoundary: "environment",
      enabledToolIds: ["thread.status"],
    });
    await associated(request(value.app).post("/api/agent-tool-invocations"))
      .send({
        toolId: "thread.status",
        schemaVersion: 2,
        requestId: "request-2",
        input: { threadId: targetThreadId },
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          invocationId: "invocation-1",
          state: "completed",
          output: {
            threadId: targetThreadId,
            backend: "codex_app_server",
            lifecycle: "active",
            activity: "idle",
          },
        });
      });
  });

  it("rejects identity overrides and invalid canonical input before execute", async () => {
    const value = fixture();
    await associated(request(value.app).post("/api/agent-tool-invocations"))
      .send({
        toolId: "agent.context",
        schemaVersion: 2,
        requestId: "request-1",
        input: {},
        principalId: "caller-selected",
      })
      .expect(400);
    await associated(request(value.app).post("/api/agent-tool-invocations"))
      .send({
        toolId: "thread.status",
        schemaVersion: 2,
        requestId: "request-2",
        input: {},
      })
      .expect(400);
  });

  it("reports invalid service responses as internal errors", async () => {
    const value = fixture();
    vi.spyOn(value.tools, "catalog").mockResolvedValue([{} as never]);

    await associated(request(value.app).get("/api/agent-tools"))
      .expect(500)
      .expect(({ body }) => expect(body.error.code).toBe("internal_error"));
  });

  it("rejects a contract-valid response that exceeds the transport bound", async () => {
    const value = fixture();
    vi.spyOn(value.tools, "invoke").mockResolvedValue({
      invocationId: "oversized-invocation",
      state: "completed",
      output: Array.from({ length: 65 }, () => "x".repeat(65_536)),
    });

    await associated(request(value.app).post("/api/agent-tool-invocations"))
      .send({
        toolId: "agent.context",
        schemaVersion: 2,
        requestId: "oversized-response",
        input: {},
      })
      .expect(500)
      .expect(({ body }) => expect(body.error.code).toBe("internal_error"));
  });
});
