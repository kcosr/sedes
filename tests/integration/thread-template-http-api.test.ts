import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ThreadTemplateApplicationService } from "../../src/server/application/thread-template-application-service.js";
import { ThreadTemplateRepository } from "../../src/server/db/repositories/thread-template-repository.js";
import { createNormalizedApp } from "../../src/server/normalized-app.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { directThreadExecutionWorkspaceLifecycle } from "../../src/server/pi-sandbox/pi-sandbox-lifecycle-service.js";
import { unavailableAgentToolRouterDependencies } from "../support/agent-tool-http.js";
import { unavailableTurnBookmarks } from "../support/unavailable-turn-bookmarks.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const workspaceId = "20000000-0000-4000-8000-000000000001";
const agentId = "30000000-0000-4000-8000-000000000001";
const selection = {
  workspaceId,
  targetId: "local-primary",
  executionWorkspace: { kind: "direct" as const },
  agentId,
};

function addPrincipal(
  database: ReturnType<typeof savedAgentDatabase>["database"],
  scope: RequestScope,
): void {
  database
    .prepare("INSERT OR IGNORE INTO tenants(id, created_at) VALUES (?, ?)")
    .run(scope.tenantId, 1_000);
  database
    .prepare(
      "INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', ?)",
    )
    .run(scope.tenantId, scope.principalId, 1_000);
}

function httpFixture(
  scope: RequestScope,
  threadTemplates: ThreadTemplateApplicationService,
) {
  const unused = () => {
    throw new Error("route_not_configured_for_test");
  };
  const createThread = vi.fn(unused);
  const app = createNormalizedApp({
    usage: {availability: () => {throw new Error("usage_not_configured_in_fixture");}, read: () => { throw new Error("usage_not_configured_in_fixture"); }, analytics: () => { throw new Error("usage_not_configured_in_fixture"); }},
    workpads: {} as never,
    questions: {} as never,
    cannedPrompts: {} as never,
    turnBookmarks: unavailableTurnBookmarks(),
    workspaceDiffReviews: {} as never,
    config: {
      authenticationRequired: true,
      host: "127.0.0.1",
      port: 4783,
      stateDirectory: "/tmp/thread-template-http-test",
      allowedTailscaleHosts: [],
      packagedClientOrigins: [],
      conversationRetentionMilliseconds: 600_000,
      conversationRuntimeBudget: 8,
    },
    csrfToken: "thread-template-csrf",
    identity: { resolve: async () => scope },
    notifications: {} as never,
    principalPreferences: {} as never,
    executionTargets: {
      read: async () => ({ executionTargets: [], defaultTargetId: null }),
      requireSelectable: async () => undefined,
    },
    savedAgents: { createThread } as never,
    threadTemplates,
    composerAttachments: {} as never,
    outputArtifacts: {} as never,
    applicationSnapshots: { handoffThreadChange: vi.fn() } as never,
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
      .set("X-CSRF-Token", "thread-template-csrf");
  return { createThread, get, mutate };
}

function serviceFixture() {
  const current = savedAgentDatabase();
  let now = 1_000;
  const prepareThreadTemplateSelection = vi.fn(async (_scope, input) => ({
    ...input,
    capturedAgentName: "Server Agent",
    capturedWorkspaceName: "Server Project",
    capturedTargetName: "Server Target",
    assertDurableFences: () => undefined,
  }));
  const service = new ThreadTemplateApplicationService({
    repository: new ThreadTemplateRepository(current.database),
    savedAgents: { prepareThreadTemplateSelection } as never,
    now: () => now++,
  });
  return { ...current, prepareThreadTemplateSelection, service };
}

describe("Thread Template normalized HTTP API", () => {
  it("exposes strict CRUD envelopes, revision CAS, and no spawn route", async () => {
    const current = serviceFixture();
    try {
      const http = httpFixture(current.scope, current.service);

      await http
        .mutate("post", "/api/thread-templates")
        .send({
          name: "Forged display fields",
          ...selection,
          capturedAgentName: "Browser Agent",
        })
        .expect(400);
      expect(current.prepareThreadTemplateSelection).not.toHaveBeenCalled();

      const createdResponse = await http
        .mutate("post", "/api/thread-templates")
        .send({ name: "Review", ...selection })
        .expect(201);
      expect(createdResponse.body).toMatchObject({
        template: {
          name: "Review",
          ...selection,
          capturedAgentName: "Server Agent",
          capturedWorkspaceName: "Server Project",
          capturedTargetName: "Server Target",
          revision: 0,
        },
      });
      expect(Object.keys(createdResponse.body)).toEqual(["template"]);
      const templateId = createdResponse.body.template.id as string;

      await http
        .get("/api/thread-templates?pageSize=10")
        .expect(200)
        .expect(({ body }) => {
          expect(body.items).toHaveLength(1);
          expect(body.items[0].id).toBe(templateId);
        });
      await http
        .get("/api/thread-templates?pageSize=10&principalId=forged")
        .expect(400);
      await http.get(`/api/thread-templates/${templateId}`).expect(200);

      await http
        .mutate("patch", `/api/thread-templates/${templateId}`)
        .send({
          expectedRevision: 0,
          name: "Forged update",
          capturedTargetName: "Browser Target",
        })
        .expect(400);
      const updatedResponse = await http
        .mutate("patch", `/api/thread-templates/${templateId}`)
        .send({ expectedRevision: 0, name: "Updated review" })
        .expect(200);
      expect(updatedResponse.body).toMatchObject({
        template: { id: templateId, name: "Updated review", revision: 1 },
      });

      await http
        .mutate("patch", `/api/thread-templates/${templateId}`)
        .send({ expectedRevision: 0, name: "Stale" })
        .expect(409);
      await http
        .mutate("delete", `/api/thread-templates/${templateId}`)
        .send({ expectedRevision: 0 })
        .expect(409);

      await http
        .mutate("post", `/api/thread-templates/${templateId}/threads`)
        .send({ title: "No template spawn route" })
        .expect(404);
      expect(http.createThread).not.toHaveBeenCalled();

      await http
        .mutate("delete", `/api/thread-templates/${templateId}`)
        .send({ expectedRevision: 1 })
        .expect(200)
        .expect({ deleted: true, templateId });
      await http.get(`/api/thread-templates/${templateId}`).expect(404);
    } finally {
      current.database.close();
    }
  });

  it("derives scope from identity and hides another principal's template", async () => {
    const current = serviceFixture();
    try {
      const foreignScope = {
        tenantId: current.scope.tenantId,
        principalId: "foreign-principal",
      };
      addPrincipal(current.database, foreignScope);
      const owner = httpFixture(current.scope, current.service);
      const foreign = httpFixture(foreignScope, current.service);
      const createdResponse = await owner
        .mutate("post", "/api/thread-templates")
        .send({ name: "Owner only", ...selection })
        .expect(201);
      const templateId = createdResponse.body.template.id as string;

      await foreign
        .get("/api/thread-templates?pageSize=10")
        .expect(200)
        .expect({ items: [] });
      await foreign.get(`/api/thread-templates/${templateId}`).expect(404);
      await foreign
        .mutate("patch", `/api/thread-templates/${templateId}`)
        .send({ expectedRevision: 0, name: "Foreign update" })
        .expect(404);
      await foreign
        .mutate("delete", `/api/thread-templates/${templateId}`)
        .send({ expectedRevision: 0 })
        .expect(404);

      await foreign
        .mutate("post", "/api/thread-templates")
        .send({
          name: "Cannot choose owner",
          ...selection,
          principalId: current.scope.principalId,
        })
        .expect(400);
      await owner.get(`/api/thread-templates/${templateId}`).expect(200);
    } finally {
      current.database.close();
    }
  });
});
