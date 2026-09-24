import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createNormalizedApp } from "../../src/server/normalized-app.js";
import { unavailableAgentToolRouterDependencies } from "../support/agent-tool-http.js";
import { unavailableTurnBookmarks } from "../support/unavailable-turn-bookmarks.js";
import { savedAgentBackendTypeIdSchema } from "../../src/shared/protocol/saved-agents.js";
import { directThreadExecutionWorkspaceLifecycle } from "../../src/server/pi-sandbox/pi-sandbox-lifecycle-service.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" } as const;
const agentId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8000-000000000001";
const threadId = "30000000-0000-4000-8000-000000000001";
const copiedThreadId = "40000000-0000-4000-8000-000000000001";
const backendTypeId = savedAgentBackendTypeIdSchema.parse("pi");
const backend = {
  typeId: backendTypeId,
  label: { text: "Pi" },
  brand: "pi" as const,
};
const agent = {
  id: agentId,
  name: "Reviewer",
  backendTypeId,
  backend,
  backendOverrides: [],
  revision: 0,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
};
const target = { id: "target-1", label: { text: "Local Pi" }, backend };
const sedesTools = {
  defaultPolicy: {
    enabled: false,
    enabledToolIds: [],
    presentation: { surface: "native" as const, mode: "progressive" as const },
    accessBoundary: "environment" as const,
  },
  resolvedPolicy: {
    enabled: false,
    enabledToolIds: [],
    presentation: { surface: "native" as const, mode: "progressive" as const },
    accessBoundary: "environment" as const,
  },
  groups: [],
  presentationOptions: [
    {
      surface: "native" as const,
      modes: ["progressive", "individual"] as const,
    },
    { surface: "cli" as const, modes: ["progressive", "individual"] as const },
  ] as const,
};
const configuration = {
  backendTypeId,
  fields: [],
  canonicalOverrides: [],
};

function fixture() {
  const handoffThreadChange = vi.fn();
  const savedAgents = {
    list: vi.fn(() => ({
      items: [
        {
          id: agentId,
          name: agent.name,
          backendTypeId,
          backend,
          overrideCount: 0,
          sedesTools: null,
          revision: 0,
          createdAt: agent.createdAt,
          updatedAt: agent.updatedAt,
        },
      ],
    })),
    get: vi.fn(() => agent),
    createAgent: vi.fn(async () => agent),
    updateAgent: vi.fn(async () => ({ ...agent, revision: 1 })),
    deleteAgent: vi.fn(() => ({ deleted: true as const, agentId })),
    options: vi.fn(async (_scope, input: { targetId?: string }) =>
      input.targetId
        ? {
            kind: "configuration" as const,
            target,
            configuration,
            sedesTools,
          }
        : { kind: "targets" as const, targets: [target] },
    ),
    resolveAgent: vi.fn(async () => ({
      candidates: [{ target, configuration, sedesTools }],
      failures: [],
    })),
    createThread: vi.fn(async () => {
      handoffThreadChange(scope, threadId);
      return { threadId, workspaceId, targetId: target.id };
    }),
    createThreadFromSettings: vi.fn(async () => ({
      threadId: copiedThreadId,
      workspaceId,
      targetId: target.id,
    })),
  };
  const unused = () => {
    throw new Error("route_not_configured_for_test");
  };
  const app = createNormalizedApp({
    usage: {availability: () => {throw new Error("usage_not_configured_in_fixture");}, read: () => { throw new Error("usage_not_configured_in_fixture"); }, analytics: () => { throw new Error("usage_not_configured_in_fixture"); }},
    workpads: {} as never,
    questions: {} as never,
    cannedPrompts: {} as never,
    turnBookmarks: unavailableTurnBookmarks(),
    workspaceDiffReviews: {} as never,
    config: {
      authenticationRequired: true,
      experimentalUsageEnabled: false,
      host: "127.0.0.1",
      port: 4783,
      stateDirectory: "/tmp/saved-agent-http-test",
      allowedTailscaleHosts: [],
      packagedClientOrigins: [],
      conversationRetentionMilliseconds: 600_000,
      conversationRuntimeBudget: 8,
    },
    csrfToken: "saved-agent-csrf",
    identity: { resolve: async () => scope },
    notifications: {} as never,
    principalPreferences: {} as never,
    executionTargets: {
      read: async () => ({ executionTargets: [], defaultTargetId: null }),
      requireSelectable: async () => undefined,
    },
    savedAgents: savedAgents as never,
    threadTemplates: {} as never,
    composerAttachments: {} as never,
    outputArtifacts: {} as never,
    applicationSnapshots: { handoffThreadChange } as never,
    threads: { snapshot: unused } as never,
    history: { loadOlder: unused } as never,
    threadRuntimes: { quiet: unused } as never,
    threadSnapshots: { publish: unused } as never,
    lifecycle: { createServerDraft: unused } as never,
    inventory: {} as never,
    threadGroups: {} as never,
    tasks: {} as never,
    workspaceFiles: {} as never,
    threadArchives: {} as never,
    threadExecutionWorkspaces: directThreadExecutionWorkspaceLifecycle,
    threadForceResets: {} as never,
    attention: {} as never,
    execution: {} as never,
    automations: {} as never,
    automationPrechecks: {} as never,
    agentTools: unavailableAgentToolRouterDependencies(),
    lineage: {
      forkManual: unused,
      updatePlacement: unused,
      listDescendants: unused,
    },
  });
  const get = (path: string) =>
    request(app).get(path).set("Host", "127.0.0.1:4783");
  const mutate = (method: "post" | "patch" | "delete", path: string) =>
    request(app)
      [method](path)
      .set("Host", "127.0.0.1:4783")
      .set("X-CSRF-Token", "saved-agent-csrf");
  return { app, savedAgents, handoffThreadChange, get, mutate };
}

describe("Saved Agent normalized HTTP API", () => {
  it("normalizes CRUD, options, and resolution envelopes", async () => {
    const current = fixture();
    await current.get("/api/agents?pageSize=10").expect(200);
    await current
      .mutate("post", "/api/agents/options")
      .send({ workspaceId })
      .expect(200)
      .expect(({ body }) => expect(body.kind).toBe("targets"));
    await current
      .mutate("post", "/api/agents/options")
      .send({ workspaceId, overrides: [] })
      .expect(400);
    await current
      .mutate("post", "/api/agents")
      .send({
        name: "Reviewer",
        authoringContext: { workspaceId, targetId: target.id },
        backendOverrides: [],
      })
      .expect(201)
      .expect(({ body }) => expect(body.agent.id).toBe(agentId));
    await current.get(`/api/agents/${agentId}`).expect(200);
    await current
      .mutate("patch", `/api/agents/${agentId}`)
      .send({ expectedRevision: 0, name: "Senior Reviewer" })
      .expect(200)
      .expect(({ body }) => expect(body.agent.revision).toBe(1));
    await current
      .mutate("post", `/api/agents/${agentId}/resolve`)
      .send({ workspaceId })
      .expect(200)
      .expect(({ body }) => expect(body.candidates).toHaveLength(1));
    await current
      .mutate("delete", `/api/agents/${agentId}`)
      .send({ expectedRevision: 1 })
      .expect(200)
      .expect({ deleted: true, agentId });
  });

  it("accepts only the discriminated create request and hands off publication", async () => {
    const current = fixture();
    await current
      .mutate("post", "/api/threads")
      .send({ workspaceId, targetId: target.id, title: "Old shape" })
      .expect(400);
    expect(current.savedAgents.createThread).not.toHaveBeenCalled();

    await current
      .mutate("post", "/api/threads")
      .send({
        workspaceId,
        title: "New thread",
        configuration: { kind: "custom", targetId: target.id },
        executionWorkspace: { kind: "direct" },
      })
      .expect(201)
      .expect({ threadId, workspaceId, targetId: target.id });
    expect(current.savedAgents.createThread).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        configuration: { kind: "custom", targetId: target.id },
        executionWorkspace: { kind: "direct" },
      }),
      { kind: "http_ui" },
    );
    expect(current.handoffThreadChange).toHaveBeenCalledWith(scope, threadId);
  });

  it("derives a same-settings child from only the scoped source thread", async () => {
    const current = fixture();
    const mutationId = "50000000-0000-4000-8000-000000000001";
    await current
      .mutate("post", `/api/threads/${threadId}/configuration-copies`)
      .send({
        title: "New thread",
        mutationId,
        targetId: "browser-selected-target",
      })
      .expect(400);
    expect(current.savedAgents.createThreadFromSettings).not.toHaveBeenCalled();

    await current
      .mutate("post", `/api/threads/${threadId}/configuration-copies`)
      .send({ title: "New thread", mutationId })
      .expect(201)
      .expect({ threadId: copiedThreadId, workspaceId, targetId: target.id });
    expect(current.savedAgents.createThreadFromSettings).toHaveBeenCalledWith(
      scope,
      threadId,
      { title: "New thread", mutationId },
    );
  });
});
