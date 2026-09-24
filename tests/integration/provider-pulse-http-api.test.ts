import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createNormalizedApp } from "../../src/server/normalized-app.js";
import { ApiError } from "../../src/server/http/errors.js";
import { unavailableAgentToolRouterDependencies } from "../support/agent-tool-http.js";
import { unavailableTurnBookmarks } from "../support/unavailable-turn-bookmarks.js";
import type { ProviderPulseGateway } from "../../src/server/provider-pulse/gateway.js";
import { directThreadExecutionWorkspaceLifecycle } from "../../src/server/pi-sandbox/pi-sandbox-lifecycle-service.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" } as const;

function fixture(
  gateway: ProviderPulseGateway,
  resolveIdentity: () => Promise<typeof scope> = async () => scope,
) {
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
      stateDirectory: "/tmp/provider-pulse-http-test",
      allowedTailscaleHosts: [],
      packagedClientOrigins: [],
      conversationRetentionMilliseconds: 600_000,
      conversationRuntimeBudget: 8,
      providerPulseUrl: "http://127.0.0.1:4317",
    },
    csrfToken: "pulse-csrf",
    identity: { resolve: resolveIdentity },
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
    providerPulse: gateway,
  });
  const get = (path: string) =>
    request(app).get(path).set("Host", "127.0.0.1:4783");
  const mutate = (path: string) =>
    request(app)
      .post(path)
      .set("Host", "127.0.0.1:4783")
      .set("X-CSRF-Token", "pulse-csrf");
  return { get, mutate };
}

describe("Provider Pulse HTTP proxy", () => {
  it("returns projected status and forwards checks and snapshots", async () => {
    const status = {
      version: 1 as const,
      generatedAt: "2026-08-16T19:00:00.000Z",
      health: "healthy" as const,
      accounts: [
        {
          id: "claude-work",
          label: "Claude · work",
          provider: "claude",
          usage: {
            health: "healthy" as const,
            inFlight: false,
          },
        },
      ],
      usageBaseline: { health: "healthy" as const, metrics: [] },
    };
    const receipt = {
      operationId: "op-1",
      accepted: true,
      targetId: "claude-work",
      kind: "usage-check" as const,
      coalesced: false,
    };
    const gateway: ProviderPulseGateway = {
      enabled: true,
      readStatus: vi.fn(async () => status),
      checkAccount: vi.fn(async () => receipt),
      checkAll: vi.fn(async () => ({ receipts: [receipt] })),
      snapshot: vi.fn(async () => ({
        usageBaseline: status.usageBaseline,
      })),
    };
    const current = fixture(gateway);

    await current
      .get("/api/provider-pulse/status")
      .expect(200)
      .expect(({ body }) => {
        expect(body.accounts[0].id).toBe("claude-work");
        expect(body).not.toHaveProperty("heartbeats");
      });
    await current
      .mutate("/api/provider-pulse/accounts/claude-work/check")
      .send({})
      .expect(202)
      .expect(({ body }) => expect(body.operationId).toBe("op-1"));
    await current
      .mutate("/api/provider-pulse/check-all")
      .send({})
      .expect(202)
      .expect(({ body }) => expect(body.receipts).toHaveLength(1));
    await current.mutate("/api/provider-pulse/snapshot").send({}).expect(200);
    expect(gateway.checkAccount).toHaveBeenCalledWith("claude-work");
  });

  it("rejects an invalid account id before calling Pulse", async () => {
    const gateway: ProviderPulseGateway = {
      enabled: true,
      readStatus: vi.fn(),
      checkAccount: vi.fn(),
      checkAll: vi.fn(),
      snapshot: vi.fn(),
    };
    const current = fixture(gateway);
    await current
      .mutate("/api/provider-pulse/accounts/bad%20id/check")
      .send({})
      .expect(400);
    expect(gateway.checkAccount).not.toHaveBeenCalled();
  });

  it("admits every installation-owned Pulse operation through server identity", async () => {
    const gateway: ProviderPulseGateway = {
      enabled: true,
      readStatus: vi.fn(),
      checkAccount: vi.fn(),
      checkAll: vi.fn(),
      snapshot: vi.fn(),
    };
    const resolveIdentity = vi.fn(async () => {
      throw new ApiError(403, "backend_rejected", "Identity denied.");
    });
    const current = fixture(gateway, resolveIdentity);

    await current.get("/api/provider-pulse/status").expect(403);
    await current
      .mutate("/api/provider-pulse/accounts/claude-work/check")
      .send({})
      .expect(403);
    await current.mutate("/api/provider-pulse/check-all").send({}).expect(403);
    await current.mutate("/api/provider-pulse/snapshot").send({}).expect(403);

    expect(resolveIdentity).toHaveBeenCalledTimes(4);
    expect(gateway.readStatus).not.toHaveBeenCalled();
    expect(gateway.checkAccount).not.toHaveBeenCalled();
    expect(gateway.checkAll).not.toHaveBeenCalled();
    expect(gateway.snapshot).not.toHaveBeenCalled();
  });
});
