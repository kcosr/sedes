import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ClientControlService } from "../../src/server/domain/client-control-service.js";
import { ClientControlToolService } from "../../src/server/agent-tools/tools/client-control-tools.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import { AgentToolEnvironmentAuthorityResolver, type AgentToolEnvironmentAuthorityReader } from "../../src/server/agent-tools/environment/environment-authority.js";
import type { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import type { ConversationInputRuntimeObservation } from "../../src/server/conversations/conversation-actor-manager.js";
import type { BackendKind } from "../../src/server/backends/contracts.js";
import type { AgentToolAdapter } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";

const services: ClientControlService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
const scope = { tenantId: "tenant", principalId: "principal" };
const sourceThreadId = randomUUID(), destination = randomUUID();
const state = { runtime: { foreground: true, voiceReady: false, interactionActive: false }, settings: null };
const reader: AgentToolEnvironmentAuthorityReader = {
  resolveEnvironment: (_scope, id) => ({ id, environmentId: id }), resolveWorkspace: () => undefined,
  resolveWorkspaceProject: () => "project", resolveProject: () => undefined,
  resolveThread: (_scope, id) => ({ id, environmentId: id === destination ? "other-environment" : "environment", label: "Destination" }),
  resolveThreadFamily: () => undefined, resolveSavedAgent: () => undefined, resolveWorkpad: () => undefined, resolveTask: () => undefined,
  listEnvironments: () => [{ id: "environment", environmentId: "environment" }, { id: "other-environment", environmentId: "other-environment" }],
};
function fixture(backendKind: BackendKind = "pi", adapter: AgentToolAdapter = "cli", boundary = "unrestricted") {
  const clients = new ClientControlService(); services.push(clients);
  const register = () => clients.register(scope, undefined, { platform: "browser", capabilities: { navigate: true, voice: false, voiceSettings: false }, state });
  const starting = register(), other = register();
  let turn = "turn", owner = "owner", current = true;
  const source = { scope, sourceThreadId, sourceWorkspaceId: "workspace", sourceEnvironmentId: "environment", backendKind };
  const controls = new ClientControlToolService(clients, {
    observeInputRuntime: () => ({ authoritative: current, ownerGeneration: owner, runState: "running", sourceTurnId: turn,
      activeTurnId: turn, sourceTurnStatus: "in_progress", settled: false, firstInput: { operationId: "initial-input" } } as ConversationInputRuntimeObservation),
  }, { originForTurn: () => ({ clientId: starting.clientId }) }, reader);
  const request = vi.spyOn(clients, "request").mockImplementation(async target => ({ status: "applied", state, client: clients.describe(target) }));
  const approve = vi.fn(async () => "allow" as const);
  const release = vi.fn();
  const acquire = vi.fn(async () => ({ signal: new AbortController().signal, isCurrent: () => true, release }));
  const canonical = new CanonicalInlineAgentToolService({ application: { readThreadStatus: async () => undefined }, clientControls: controls });
  const gate = new SourceScopedAgentToolService(canonical, { get: () => ({ enabled: true, revision: 1,
    enabledToolIds: ["client.list", "client.settings.get", "client.settings.update", "client.switch_thread", "client.end_interaction"],
    presentation: { surface: adapter === "cli" ? "cli" : "native", mode: "progressive" }, accessBoundary: boundary,
  }) } as unknown as ThreadAgentToolPolicyRepository, new AgentToolEnvironmentAuthorityResolver(reader), { resolveInScope: () => source },
  { acquireAgentToolApprovalAuthority: async () => ({ generation: "generation", signal: new AbortController().signal, isCurrent: () => true, release: () => {} }) },
  { requestApplicationDecision: approve }, controls);
  const invoke = (toolId = "client.settings.get", input = {}) => gate.invoke({ source, adapter,
    request: { toolId, schemaVersion: 1, requestId: randomUUID(), input }, signal: new AbortController().signal,
    ...(backendKind === "opencode" ? { accessDecisionAuthority: { acquire } } : {}) });
  return { invoke, clients, starting, other, request, approve, acquire, release, canonical,
    changeTurn: () => { turn = "another-turn"; }, changeOwner: () => { owner = "another-owner"; }, loseAuthority: () => { current = false; } };
}

describe("canonical client controls", () => {
  it("identifies the turn's starting client in discovery without selecting another connected client", async () => {
    const current = fixture();
    const result = await current.invoke("client.list");
    if (result.state !== "completed") throw new Error(`Unexpected client discovery state: ${result.state}`);
    expect(result.output).toMatchObject({ defaultClientId: current.starting.clientId,
      clients: [{ clientId: current.starting.clientId }, { clientId: current.other.clientId }] });
    expect(current.request).not.toHaveBeenCalled();
  });
  it.each([
    ["pi", "pi_sdk"], ["codex_app_server", "mcp"], ["claude_agent_sdk", "mcp"], ["grok_build", "cli"], ["opencode", "mcp"],
    ["pi", "cli"], ["codex_app_server", "cli"], ["claude_agent_sdk", "cli"], ["opencode", "cli"],
  ] as const)("captures the admitted turn through %s/%s with that backend's authority disposition", async (backend, adapter) => {
    const current = fixture(backend, adapter);
    await current.invoke();
    expect(current.request.mock.calls[0]?.[0].clientId).toBe(current.starting.clientId);
    expect(current.request.mock.calls[0]?.[1]).toMatchObject({ sourceThreadId, sourceTurnId: "turn", action: "settings.get" });
    expect(current.acquire).toHaveBeenCalledTimes(backend === "opencode" ? 1 : 0);
    expect(current.release).toHaveBeenCalledTimes(backend === "opencode" ? 1 : 0);
    await current.invoke("client.settings.get", { clientId: current.other.clientId });
    expect(current.request.mock.calls[1]?.[0].clientId).toBe(current.other.clientId);
    expect(current.approve).not.toHaveBeenCalled();
  });

  it("captures before an asynchronous provider lease and rejects a turn replaced during that check", async () => {
    const current = fixture("opencode", "mcp");
    current.acquire.mockImplementation(async () => {
      current.changeTurn();
      return { signal: new AbortController().signal, isCurrent: () => true, release: current.release };
    });
    await expect(current.invoke()).rejects.toBeDefined();
    expect(current.request).not.toHaveBeenCalled();
  });

  it.each(["changeTurn", "changeOwner", "loseAuthority"] as const)("rejects %s during destination approval rather than retargeting", async change => {
    const current = fixture("pi", "cli", "environment");
    current.approve.mockImplementation(async () => { current[change](); return "allow"; });
    await expect(current.invoke("client.switch_thread", { threadId: destination, listen: true })).rejects.toBeDefined();
    expect(current.request).not.toHaveBeenCalled(); expect(current.approve).toHaveBeenCalledOnce();
  });

  it("authorizes a nested default-thread patch and does not let it bypass the environment boundary", async () => {
    const current = fixture("pi", "cli", "environment");
    await current.invoke("client.settings.update", { expectedRevision: 7, patch: { voice: { voiceThreadId: destination, pinDefaultVoiceThread: true } } });
    expect(current.approve).toHaveBeenCalledOnce();
    expect(current.request.mock.calls[0]?.[1]).toMatchObject({ action: "settings.update", expectedRevision: 7,
      patch: { voiceThreadId: destination, pinDefaultVoiceThread: true }, threadTitle: "Destination" });
  });

  it("excludes client controls from standalone tool clients and rejects unknown settings", async () => {
    const current = fixture();
    expect(current.canonical.catalog("mcp", "principal_client").some(tool => tool.id.startsWith("client."))).toBe(false);
    await expect(current.invoke("client.settings.update", { expectedRevision: 0, patch: { voice: { speechCredential: "secret" } } })).rejects.toBeDefined();
    expect(current.request).not.toHaveBeenCalled();
  });
});
