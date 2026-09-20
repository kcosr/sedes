import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { CannedPromptRepository } from "../../src/server/db/repositories/canned-prompt-repository.js";
import { CannedPromptService } from "../../src/server/domain/canned-prompt-service.js";
import { createNormalizedApp } from "../../src/server/normalized-app.js";
import { directThreadExecutionWorkspaceLifecycle } from "../../src/server/pi-sandbox/pi-sandbox-lifecycle-service.js";
import { unavailableAgentToolRouterDependencies } from "../support/agent-tool-http.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { unavailableTurnBookmarks } from "../support/unavailable-turn-bookmarks.js";

function fixture() {
  const { database, scope } = savedAgentDatabase();
  const unused = () => {
    throw new Error("route_not_configured_for_test");
  };
  const app = createNormalizedApp({
    workpads: {} as never,
    questions: {} as never,
    cannedPrompts: new CannedPromptService(
      new CannedPromptRepository(database),
    ),
    turnBookmarks: unavailableTurnBookmarks(),
    workspaceDiffReviews: {} as never,
    config: {
      authenticationRequired: true,
      host: "127.0.0.1",
      port: 4783,
      stateDirectory: "/tmp/canned-prompts-http-test",
      allowedTailscaleHosts: [],
      packagedClientOrigins: [],
      conversationRetentionMilliseconds: 600_000,
      conversationRuntimeBudget: 8,
    },
    csrfToken: "canned-prompts-csrf",
    identity: { resolve: async () => scope },
    notifications: {} as never,
    principalPreferences: {} as never,
    executionTargets: {
      read: async () => ({ executionTargets: [], defaultTargetId: null }),
      requireSelectable: async () => undefined,
    },
    savedAgents: {} as never,
    threadTemplates: {} as never,
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
  const get = () =>
    request(app)
      .get("/api/application/canned-prompts")
      .set("Host", "127.0.0.1:4783");
  const mutate = (method: "post" | "put" | "delete", path: string) =>
    request(app)
      [method](path)
      .set("Host", "127.0.0.1:4783")
      .set("X-CSRF-Token", "canned-prompts-csrf");
  return { database, get, mutate };
}

describe("Canned prompts normalized HTTP API", () => {
  it("serves no-store CRUD and exact-order mutations", async () => {
    const current = fixture();
    const empty = await current.get().expect(200);
    expect(empty.headers["cache-control"]).toBe("no-store");
    expect(empty.body).toEqual({ revision: 0, items: [] });

    const first = await current
      .mutate("post", "/api/application/canned-prompts")
      .send({
        title: "Summarize",
        text: "Summarize the current status.",
        expectedRevision: 0,
        mutationId: randomUUID(),
      })
      .expect(201);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.body).toMatchObject({
      revision: 1,
      replayed: false,
      items: [{ title: "Summarize", position: 0 }],
    });

    const second = await current
      .mutate("post", "/api/application/canned-prompts")
      .send({
        title: "Next steps",
        text: "List the next steps.",
        expectedRevision: 1,
        mutationId: randomUUID(),
      })
      .expect(201);
    const [firstPrompt, secondPrompt] = second.body.items as Array<{
      id: string;
    }>;

    const reordered = await current
      .mutate("put", "/api/application/canned-prompts/order")
      .send({
        promptIds: [secondPrompt!.id, firstPrompt!.id],
        expectedRevision: 2,
        mutationId: randomUUID(),
      })
      .expect(200);
    expect(
      reordered.body.items.map((item: { title: string }) => item.title),
    ).toEqual(["Next steps", "Summarize"]);

    const updated = await current
      .mutate("put", `/api/application/canned-prompts/${firstPrompt!.id}`)
      .send({
        title: "Summarize thread",
        text: "Summarize this thread.",
        expectedRevision: 3,
        mutationId: randomUUID(),
      })
      .expect(200);
    expect(updated.body.items[1]).toMatchObject({
      title: "Summarize thread",
      position: 1,
    });

    const removed = await current
      .mutate("delete", `/api/application/canned-prompts/${secondPrompt!.id}`)
      .send({ expectedRevision: 4, mutationId: randomUUID() })
      .expect(200);
    expect(removed.body).toMatchObject({
      revision: 5,
      items: [{ title: "Summarize thread", position: 0 }],
    });

    current.database.close();
  });

  it("rejects unknown mutation fields through strict request schemas", async () => {
    const current = fixture();
    await current
      .mutate("post", "/api/application/canned-prompts")
      .send({
        title: "Review",
        text: "Review this.",
        expectedRevision: 0,
        mutationId: randomUUID(),
        principalId: "another-principal",
      })
      .expect(400);
    await current.get().expect(200, { revision: 0, items: [] });
    current.database.close();
  });
});
