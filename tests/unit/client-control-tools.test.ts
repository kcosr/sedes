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
import { TurnReplySpeechService } from "../../src/server/domain/turn-reply-speech-service.js";
import { clientCommandSchema, type ClientActionResult } from "../../src/shared/protocol/client-controls.js";
import type { SelectedAssistantResult } from "../../src/shared/protocol/notification.js";
import { serializedUtf8Bytes } from "../../src/shared/protocol/payload.js";

const services: ClientControlService[] = [];
let threadLabel: string | undefined = "Destination";
afterEach(() => { for (const service of services.splice(0)) service.close(); threadLabel = "Destination"; });
const scope = { tenantId: "tenant", principalId: "principal" };
const sourceThreadId = randomUUID(), destination = randomUUID(), sameEnvironment = randomUUID(), missing = randomUUID();
const state = { runtime: { foreground: true, voiceReady: false, interactionActive: false }, settings: null };
const reader: AgentToolEnvironmentAuthorityReader = {
  resolveEnvironment: (_scope, id) => ({ id, environmentId: id }), resolveWorkspace: () => undefined,
  resolveWorkspaceProject: () => "project", resolveProject: () => undefined,
  resolveThread: (_scope, id) => id === missing ? undefined : ({ id, environmentId: id === destination ? "other-environment" : "environment", label: threadLabel }),
  resolveThreadFamily: () => undefined, resolveSavedAgent: () => undefined, resolveWorkpad: () => undefined, resolveTask: () => undefined,
  listEnvironments: () => [{ id: "environment", environmentId: "environment" }, { id: "other-environment", environmentId: "other-environment" }],
};
const storedReply: SelectedAssistantResult = { final: { text: "Done." }, unclassified: null };
const allClientTools = ["client.list", "client.settings.get", "client.settings.update", "client.switch_thread", "client.end_interaction", "client.replay_turn"];
function fixture(backendKind: BackendKind = "pi", adapter: AgentToolAdapter = "cli", boundary = "unrestricted",
  options: { replies?: Pick<TurnReplySpeechService, "select">; enabledToolIds?: string[] } = {}) {
  const clients = new ClientControlService(); services.push(clients);
  const register = () => clients.register(scope, undefined, { platform: "browser", capabilities: { navigate: true, voice: false, voiceSettings: false }, state });
  const starting = register(), other = register();
  let turn = "turn", owner = "owner", current = true;
  const source = { scope, sourceThreadId, sourceWorkspaceId: "workspace", sourceEnvironmentId: "environment", backendKind };
  const controls = new ClientControlToolService(clients, {
    observeInputRuntime: () => ({ authoritative: current, ownerGeneration: owner, runState: "running", sourceTurnId: turn,
      activeTurnId: turn, sourceTurnStatus: "in_progress", settled: false, firstInput: { operationId: "initial-input" } } as ConversationInputRuntimeObservation),
  }, { originForTurn: () => ({ clientId: starting.clientId }) }, reader, options.replies ?? { select: () => storedReply });
  const select = vi.spyOn(controls.replies, "select");
  const request = vi.spyOn(clients, "request").mockImplementation(async target => ({ status: "applied", state, client: clients.describe(target) }));
  const approve = vi.fn(async () => "allow" as const);
  const release = vi.fn();
  const acquire = vi.fn(async () => ({ signal: new AbortController().signal, isCurrent: () => true, release }));
  const canonical = new CanonicalInlineAgentToolService({ application: { readThreadStatus: async () => undefined }, clientControls: controls });
  const gate = new SourceScopedAgentToolService(canonical, { get: () => ({ enabled: true, revision: 1,
    enabledToolIds: options.enabledToolIds ?? allClientTools,
    presentation: { surface: adapter === "cli" ? "cli" : "native", mode: "progressive" }, accessBoundary: boundary,
  }) } as unknown as ThreadAgentToolPolicyRepository, new AgentToolEnvironmentAuthorityResolver(reader), { resolveInScope: () => source },
  { acquireAgentToolApprovalAuthority: async () => ({ generation: "generation", signal: new AbortController().signal, isCurrent: () => true, release: () => {} }) },
  { requestApplicationDecision: approve }, controls);
  const invoke = (toolId = "client.settings.get", input = {}) => gate.invoke({ source, adapter,
    request: { toolId, schemaVersion: 1, requestId: randomUUID(), input }, signal: new AbortController().signal,
    ...(backendKind === "opencode" ? { accessDecisionAuthority: { acquire } } : {}) });
  return { invoke, clients, starting, other, request, select, approve, acquire, release, canonical,
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

  it.each([
    ["changeTurn", "client.switch_thread", { threadId: destination, listen: true }],
    ["changeOwner", "client.switch_thread", { threadId: destination, listen: true }],
    ["loseAuthority", "client.switch_thread", { threadId: destination, listen: true }],
    ["changeTurn", "client.replay_turn", { threadId: destination, turnId: "ended-turn" }],
    ["changeOwner", "client.replay_turn", { threadId: destination, turnId: "ended-turn" }],
    ["loseAuthority", "client.replay_turn", { threadId: destination, turnId: "ended-turn" }],
  ] as const)("rejects %s during destination approval for %s rather than retargeting", async (change, toolId, input) => {
    const current = fixture("pi", "cli", "environment");
    current.approve.mockImplementation(async () => { current[change](); return "allow"; });
    await expect(current.invoke(toolId, input)).rejects.toBeDefined();
    expect(current.request).not.toHaveBeenCalled(); expect(current.select).not.toHaveBeenCalled();
    expect(current.approve).toHaveBeenCalledOnce();
  });

  it("authorizes a nested default-thread patch and does not let it bypass the environment boundary", async () => {
    const current = fixture("pi", "cli", "environment");
    await current.invoke("client.settings.update", { expectedRevision: 7, patch: { voice: { voiceThreadId: destination, pinDefaultVoiceThread: true } } });
    expect(current.approve).toHaveBeenCalledOnce();
    expect(current.request.mock.calls[0]?.[1]).toMatchObject({ action: "settings.update", expectedRevision: 7,
      patch: { voiceThreadId: destination, pinDefaultVoiceThread: true }, threadTitle: "Destination" });
  });

  it("sends a blank inventory title as null and bounds a long one without splitting a surrogate pair", async () => {
    const current = fixture();
    threadLabel = "  \t ";
    await current.invoke("client.replay_turn", { turnId: "ended-turn" });
    await current.invoke("client.switch_thread", { threadId: sameEnvironment });
    expect(current.request.mock.calls.map(([, command]) => command.threadTitle)).toEqual([null, null]);
    threadLabel = undefined;
    await current.invoke("client.replay_turn", { turnId: "ended-turn" });
    expect(current.request.mock.calls[2]?.[1].threadTitle).toBeNull();
    threadLabel = `  ${"a".repeat(511)}\u{1F50A} trailing  `;
    await current.invoke("client.replay_turn", { turnId: "ended-turn" });
    expect(current.request.mock.calls[3]?.[1].threadTitle).toBe("a".repeat(511));
    threadLabel = "  Replay me  ";
    await current.invoke("client.replay_turn", { turnId: "ended-turn" });
    expect(current.request.mock.calls[4]?.[1].threadTitle).toBe("Replay me");
  });

  it("excludes client controls from standalone tool clients and rejects unknown settings", async () => {
    const current = fixture();
    expect(current.canonical.catalog("mcp", "principal_client").some(tool => tool.id.startsWith("client."))).toBe(false);
    await expect(current.invoke("client.settings.update", { expectedRevision: 0, patch: { voice: { speechCredential: "secret" } } })).rejects.toBeDefined();
    expect(current.request).not.toHaveBeenCalled();
  });
});

describe("client.replay_turn", () => {
  const replay = (current: ReturnType<typeof fixture>, input: Record<string, unknown>, result?: Omit<ClientActionResult, "state">) => {
    if (result) current.request.mockImplementation(async target => ({ ...result, state, client: current.clients.describe(target) }));
    return current.invoke("client.replay_turn", input);
  };

  it.each([
    ["pi", "pi_sdk"], ["codex_app_server", "mcp"], ["claude_agent_sdk", "mcp"], ["grok_build", "cli"], ["opencode", "mcp"],
    ["pi", "cli"], ["codex_app_server", "cli"], ["claude_agent_sdk", "cli"], ["opencode", "cli"],
  ] as const)("queues an ended turn of this thread on the starting client through %s/%s", async (backend, adapter) => {
    const current = fixture(backend, adapter);
    const result = await replay(current, { turnId: "ended-turn" }, { status: "applied", reason: "replay_playing" });
    expect(result).toMatchObject({ state: "completed", output: { status: "applied", reason: "replay_playing", client: { clientId: current.starting.clientId } } });
    expect(current.select).toHaveBeenCalledExactlyOnceWith(scope, sourceThreadId, "ended-turn", expect.objectContaining({ action: "replay_turn" }));
    expect(current.request).toHaveBeenCalledOnce();
    const [target, command] = current.request.mock.calls[0]!;
    expect(target.clientId).toBe(current.starting.clientId);
    expect(command).toEqual({ action: "replay_turn", sourceThreadId, sourceTurnId: "turn", threadId: sourceThreadId,
      threadTitle: "Destination", turnId: "ended-turn", assistantResult: storedReply });
    expect(current.approve).not.toHaveBeenCalled();
    expect(current.acquire).toHaveBeenCalledTimes(backend === "opencode" ? 1 : 0);
  });

  it.each([
    ["applied", "replay_queued"], ["noop", "replay_already_queued"], ["noop", "voice_off"], ["noop", "voice_not_ready"], ["noop", "voice_unsupported"],
  ] as const)("passes the client's %s %s result through unchanged", async (status, reason) => {
    const current = fixture();
    expect(await replay(current, { turnId: "ended-turn" }, { status, reason })).toMatchObject({ state: "completed", output: { status, reason } });
  });

  it.each(["voice_reply_empty", "voice_queue_full"])("reports a failed %s replay as unavailable with the client's reason", async reason => {
    const current = fixture();
    await expect(replay(current, { turnId: "ended-turn" }, { status: "failed", reason })).rejects.toMatchObject({
      toolError: { code: "unavailable", message: `The client rejected the request: ${reason}.`, retryable: false },
    });
  });

  it("rejects the in-progress source turn but replays the same turn id in another thread", async () => {
    const current = fixture();
    for (const input of [{ turnId: "turn" }, { threadId: sourceThreadId, turnId: "turn" }]) {
      await expect(replay(current, input)).rejects.toMatchObject({ toolError: { code: "invalid_input", message: "The turn has not ended." } });
    }
    expect(current.select).not.toHaveBeenCalled(); expect(current.request).not.toHaveBeenCalled();
    await replay(current, { threadId: sameEnvironment, turnId: "turn" });
    expect(current.select).toHaveBeenCalledExactlyOnceWith(scope, sameEnvironment, "turn", expect.any(Object));
    expect(current.request.mock.calls[0]?.[1]).toMatchObject({ threadId: sameEnvironment, turnId: "turn", sourceTurnId: "turn" });
  });

  it("does not find unknown, foreign, unapproved, or vanished threads and never reads their replies", async () => {
    const current = fixture("pi", "cli", "environment");
    await expect(replay(current, { threadId: missing, turnId: "ended-turn" })).rejects.toMatchObject({ toolError: { code: "not_found" } });
    current.approve.mockResolvedValueOnce("deny" as never);
    await expect(replay(current, { threadId: destination, turnId: "ended-turn" })).rejects.toMatchObject({ toolError: { code: "permission_denied" } });
    // A thread that disappears after admission is rechecked at execution.
    const resolveThread = vi.spyOn(reader, "resolveThread");
    resolveThread.mockImplementationOnce((_scope, id) => ({ id, environmentId: "environment", label: "Destination" })).mockImplementationOnce(() => undefined);
    await expect(replay(current, { threadId: sameEnvironment, turnId: "ended-turn" })).rejects.toMatchObject({ toolError: { code: "not_found" } });
    resolveThread.mockRestore();
    expect(current.select).not.toHaveBeenCalled(); expect(current.request).not.toHaveBeenCalled();
  });

  it("fails as not found when Sedes stored no reply for the turn", async () => {
    const current = fixture(undefined, undefined, undefined, { replies: { select: () => null } });
    await expect(replay(current, { turnId: "unsubmitted-turn" })).rejects.toMatchObject({
      toolError: { code: "not_found", message: "Sedes stored no reply for that turn." },
    });
    expect(current.request).not.toHaveBeenCalled();
  });

  it("targets only an explicit client in the same principal scope and never falls back", async () => {
    const current = fixture();
    await replay(current, { clientId: current.other.clientId, turnId: "ended-turn" });
    expect(current.request.mock.calls[0]?.[0].clientId).toBe(current.other.clientId);
    const foreign = current.clients.register({ ...scope, principalId: "foreign" }, undefined,
      { platform: "android", capabilities: { navigate: true, voice: true, voiceSettings: true }, state });
    for (const clientId of [foreign.clientId, randomUUID()]) {
      await expect(replay(current, { clientId, turnId: "ended-turn" })).rejects.toMatchObject({ toolError: { code: "unavailable" } });
    }
    expect(current.request).toHaveBeenCalledOnce();
  });

  it("is not granted by a policy that enabled only the earlier client controls", async () => {
    const current = fixture("pi", "cli", "unrestricted", { enabledToolIds: allClientTools.filter(id => id !== "client.replay_turn") });
    await expect(replay(current, { turnId: "ended-turn" })).rejects.toBeDefined();
    expect(current.select).not.toHaveBeenCalled(); expect(current.request).not.toHaveBeenCalled();
    await expect(current.invoke("client.settings.get")).resolves.toMatchObject({ state: "completed" });
  });

  it("fits a large stored reply beside the delivered command within 64 KiB", async () => {
    // Every unit escapes or widens in JSON, so the raw text alone is far over the budget.
    const large = "\"é\n".repeat(20_000);
    const replies = new TurnReplySpeechService({
      inventory: { getThread: () => ({}) as never },
      completions: {
        latestClassifiedResult: () => ({ provisional: { text: large }, final: { text: large }, unclassified: null }),
        latestAssistantResult: () => ({ text: large }),
      },
      notifications: { read: () => ({ assistantResultPhases: ["provisional", "final", "unclassified"] }) as never },
    });
    threadLabel = "\u{1F50A}".repeat(256);
    const current = fixture(undefined, undefined, undefined, { replies });
    current.request.mockRestore();
    const invocation = replay(current, { turnId: "ended-turn" });
    const { commands } = await current.clients.poll(scope, current.starting.connectionToken, undefined, { state, acknowledgements: [] }, new AbortController().signal);
    expect(commands).toHaveLength(1);
    const command = clientCommandSchema.parse(commands[0]);
    expect(serializedUtf8Bytes(command)).toBeLessThanOrEqual(65_536);
    expect(serializedUtf8Bytes(command)).toBeGreaterThan(60_000);
    expect(command).toMatchObject({ action: "replay_turn", turnId: "ended-turn", threadTitle: "\u{1F50A}".repeat(256),
      assistantResult: { provisional: { truncation: { reason: "byte_limit" } }, unclassified: null } });
    expect(command.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
    const done = new AbortController(); done.abort();
    await current.clients.poll(scope, current.starting.connectionToken, undefined,
      { state, acknowledgements: [{ id: command.id, result: { status: "applied", reason: "replay_queued", state } }] }, done.signal);
    await expect(invocation).resolves.toMatchObject({ state: "completed", output: { status: "applied", reason: "replay_queued" } });
  });
});
