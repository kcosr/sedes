import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNormalizedApp } from "../../src/server/normalized-app.js";
import { directThreadExecutionWorkspaceLifecycle } from "../../src/server/pi-sandbox/pi-sandbox-lifecycle-service.js";
import { unavailableAgentToolRouterDependencies } from "../support/agent-tool-http.js";
import { unavailableTurnBookmarks } from "../support/unavailable-turn-bookmarks.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" } as const;
const INDEX_HTML = "<!doctype html><title>Sedes</title><div id=\"root\"></div>\n";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A built client inside a checkout whose path has a dot-directory segment. */
async function clientDirectoryBehindDotDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-client-fallback-"));
  roots.push(root);
  const clientDirectory = path.join(root, ".worktrees", "sedes", "dist", "client");
  await mkdir(path.join(clientDirectory, "assets"), { recursive: true });
  await writeFile(path.join(clientDirectory, "index.html"), INDEX_HTML);
  await writeFile(path.join(clientDirectory, "assets", "app.js"), "export {};\n");
  return clientDirectory;
}

function fixture(clientDirectory: string) {
  const unused = () => {
    throw new Error("route_not_configured_for_test");
  };
  const app = createNormalizedApp({
    usage: {
      availability: unused,
      read: unused,
      analytics: unused,
    },
    workpads: {} as never,
    questions: {} as never,
    cannedPrompts: {} as never,
    turnBookmarks: unavailableTurnBookmarks(),
    workspaceDiffReviews: {} as never,
    config: {
      authenticationRequired: false,
      experimentalUsageEnabled: false,
      host: "127.0.0.1",
      port: 4783,
      stateDirectory: "/tmp/client-fallback-http-test",
      allowedTailscaleHosts: [],
      packagedClientOrigins: [],
      conversationRetentionMilliseconds: 600_000,
      conversationRuntimeBudget: 8,
      providerPulseUrl: "http://127.0.0.1:4317",
    },
    csrfToken: "fallback-csrf",
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
    clientDirectory,
  });
  return (target: string) => request(app).get(target).set("Host", "127.0.0.1:4783");
}

describe("client static fallback", () => {
  it("serves deep links when the checkout path contains a dot-directory", async () => {
    const get = fixture(await clientDirectoryBehindDotDirectory());

    for (const deepLink of ["/", "/settings/environments", "/threads/thread-1"]) {
      const response = await get(deepLink).expect(200);
      expect(response.headers["content-type"]).toMatch(/^text\/html/u);
      expect(response.text).toBe(INDEX_HTML);
    }
    await get("/assets/app.js")
      .expect(200)
      .expect("Content-Type", /javascript/u);
  });

  it("keeps unknown API routes out of the client fallback", async () => {
    const get = fixture(await clientDirectoryBehindDotDirectory());

    const response = await get("/api/not-a-route").expect(404);
    expect(response.text).not.toBe(INDEX_HTML);
  });
});
