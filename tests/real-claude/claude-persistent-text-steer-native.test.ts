import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GetSessionMessagesOptions, Query, SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { OfficialClaudeSdkFacade, type ClaudeCliAuthStatus, type ClaudeQueryInput } from "../../src/server/backends/claude/claude-sdk-facade.js";
import { ClaudeSdkSession } from "../../src/server/backends/claude/claude-sdk-session.js";
import { ClaudeSdkRuntimeAdapter, type ClaudeRuntimeSessionOptions } from "../../src/server/backends/claude/claude-runtime-client.js";
import { claudeCommandLifecycle, claudeResultUserMessageIds } from "../../src/server/backends/claude/claude-result-lifecycle.js";
import { readClaudeSessionMessages } from "../../src/server/backends/claude/claude-native-transcript.js";
import { ClaudePersistentRuntimeClient } from "../../src/server/backends/claude/runtime/claude-remote-runtime-client.js";
import { ClaudePersistentRuntimeRegistry } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-registry.js";
import { registerClaudePersistentRuntimeHost } from "../../src/server/backends/claude/runtime/claude-sidecar-runtime.js";
import { claudeRuntimeModelInfoSchema, claudeRuntimeSlashCommandSchema } from "../../src/server/backends/claude/worker/claude-runtime-v3.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import type { SidecarRuntimeLease, SidecarRuntimeProvider } from "../../src/server/sidecar/runtime-channel.js";
import { createSidecarFramedCarrier } from "../helpers/persistent-sidecar-framed-fixture.js";

/**
 * The actual SDK/CLI produce every lifecycle and result frame. The production
 * session, persistent owner, and framed carrier handle them. Only subscription
 * identity is a fixture shim: the CLI has a fake key and a loopback model, not
 * a real login. The unused catalogs are narrowed to the worker's fields.
 * The authenticated persistent test separately covers admission and managed-
 * worker process supervision.
 */
it("settles a text-stream steer while detached and replays the same native query", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "sedes-text-steer-native-")));
  const home = path.join(root, "home"), workspace = path.join(root, "workspace");
  const configDirectory = path.join(home, ".claude");
  await mkdir(configDirectory, { recursive: true });
  await mkdir(workspace);
  let releaseFirst!: () => void, releaseSecond!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const requests: { firstInput: boolean; steerInput: boolean; firstReply: boolean }[] = [];
  const errors: unknown[] = [];
  const nativeMessages: SDKMessage[] = [];
  const firstId = randomUUID(), steerId = randomUUID(), sessionId = randomUUID();
  const inputText = "SEDES_FIXTURE_ORIGINAL_INPUT", steerText = "SEDES_FIXTURE_NEXT_INPUT";
  const firstReply = "SEDES_FIXTURE_FIRST_REPLY", secondReply = "SEDES_FIXTURE_NEXT_REPLY";
  const writeEvent = (response: ServerResponse, type: string, rest: Record<string, unknown>) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
  const server = createServer(async (request, response) => {
    try {
      if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
        response.writeHead(404).end(); return;
      }
      expect(request.headers["x-api-key"]).toBe("sedes-local-fixture-only");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const messages = JSON.stringify((JSON.parse(Buffer.concat(chunks).toString()) as { messages: unknown }).messages);
      requests.push({ firstInput: messages.includes(inputText), steerInput: messages.includes(steerText), firstReply: messages.includes(firstReply) });
      const ordinal = requests.length;
      expect(ordinal).toBeLessThanOrEqual(2);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const usage = { input_tokens: 12, output_tokens: 1 };
      writeEvent(response, "message_start", { message: { id: `msg_detached_${ordinal}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage } });
      writeEvent(response, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      writeEvent(response, "content_block_delta", { index: 0, delta: { type: "text_delta", text: ordinal === 1 ? firstReply : secondReply } });
      await (ordinal === 1 ? firstGate : secondGate);
      if (response.destroyed) return;
      writeEvent(response, "content_block_stop", { index: 0 });
      writeEvent(response, "message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage });
      writeEvent(response, "message_stop", {});
      response.end();
    } catch (error) { errors.push(error); response.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address_missing");
  const environment: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  Object.assign(environment, { PATH: process.env.PATH, HOME: home, TMPDIR: root, CLAUDE_CONFIG_DIR: configDirectory,
    ANTHROPIC_API_KEY: "sedes-local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" });

  class LoopbackFacade extends OfficialClaudeSdkFacade {
    queryCount = 0;
    override async readCliAuthStatus(): Promise<ClaudeCliAuthStatus> {
      return { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "fixture" };
    }
    override createQuery(input: ClaudeQueryInput): Query {
      this.queryCount++;
      const query = super.createQuery({ ...input, options: { ...input.options,
        env: environment, tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true,
        plugins: [], settingSources: [], settings: { disableAllHooks: true }, maxTurns: 4,
      } });
      const nativeInitialization = query.initializationResult.bind(query);
      query.initializationResult = async () => {
        const initialized = await nativeInitialization();
        return { ...initialized, account: { apiProvider: "firstParty", subscriptionType: "fixture" },
          models: initialized.models.map(model => claudeRuntimeModelInfoSchema.strip().parse(model)),
          commands: initialized.commands.map(command => claudeRuntimeSlashCommandSchema.strip().parse(command)) };
      };
      return query;
    }
    override getSessionMessages(id: string, options: GetSessionMessagesOptions): Promise<SessionMessage[]> {
      return readClaudeSessionMessages(id, { ...options, dir: workspace }, environment);
    }
  }
  const sdk = new LoopbackFacade();
  class LoopbackRuntime extends ClaudeSdkRuntimeAdapter {
    readonly sessions: ClaudeSdkSession[] = [];
    override createSession(options: ClaudeRuntimeSessionOptions): ClaudeSdkSession {
      const session = new ClaudeSdkSession({ ...options, environment, sdk,
        onMessage: async message => { nativeMessages.push(message); return options.onMessage(message); } });
      this.sessions.push(session);
      return session;
    }
    async close() { await Promise.all(this.sessions.map(session => session.close())); }
  }
  const runtime = new LoopbackRuntime(sdk);
  const scope = { tenantId: "fixture-tenant", principalId: "fixture-principal", executionEnvironmentId: "fixture-environment", backendInstanceId: "fixture-backend" };
  const configuration = { ...scope, executablePath: process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude", configDirectory, initializationTimeoutMs: 15_000 };
  const serviceConfiguration = { environmentRevision: 1, operationsRevision: 1 };
  const services = new PersistentSidecarServiceRegistry({ scope: { tenantId: scope.tenantId, principalId: scope.principalId,
    executionEnvironmentId: scope.executionEnvironmentId, installationId: "fixture" }, buildId: "fixture", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration: serviceConfiguration });
  const hosts = new ClaudePersistentRuntimeRegistry({ scope, executionEnvironmentId: scope.executionEnvironmentId,
    environmentChannel: new LocalEnvironmentChannelProvider({ scope, executionEnvironmentId: scope.executionEnvironmentId }),
    environment, services, createRuntime: () => runtime,
    artifact: async () => { throw new Error("fixture_uses_in_process_sdk_owner"); } });
  let current: SidecarRuntimeLease | undefined;
  const sidecarRuntime: SidecarRuntimeProvider = {
    acquireExisting: async () => { throw new Error("fixture_unused_existing_carrier"); },
    acquire: async signal => { signal?.throwIfAborted(); if (!current) throw new Error("fixture_carrier_absent"); return current; },
  };
  const clients: ClaudePersistentRuntimeClient[] = [], carriers: { close(): Promise<void> }[] = [];
  const client = () => {
    const value = new ClaudePersistentRuntimeClient({ ...configuration, scope, sidecarRuntime, onBackgroundError: error => errors.push(error) });
    clients.push(value); return value;
  };
  async function attach() {
    const carrier = await createSidecarFramedCarrier();
    const controllerEpoch = services.attach(serviceConfiguration);
    const detach = registerClaudePersistentRuntimeHost({ registry: carrier.hostRegistry, channel: carrier.hostChannel, hosts, controllerEpoch,
      onDetach: () => services.detach(controllerEpoch) });
    await carrier.start();
    let disconnected!: () => void;
    const lease: SidecarRuntimeLease = { channel: carrier.mainChannel, controllerEpoch, serviceIncarnation: services.serviceIncarnation,
      closed: new Promise<void>(resolve => { disconnected = resolve; }), release() {} };
    current = lease;
    let closed = false;
    const attached = { lease, async close() {
      if (closed) return; closed = true;
      if (current === lease) current = undefined;
      detach(); disconnected(); await carrier.close();
    } };
    carriers.push(attached); return attached;
  }
  const lifecycle = (id: string) => nativeMessages.flatMap(message => {
    const entry = claudeCommandLifecycle(message);
    return entry?.commandUuid === id ? [entry.state] : [];
  });
  const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 20_000;
    while (!(await predicate())) {
      if (errors.length) throw errors[0];
      if (Date.now() > deadline) throw new Error(`fixture_timeout: ${JSON.stringify({ requests, first: lifecycle(firstId), steer: lifecycle(steerId), hosts: services.status().resources.map(resource => hosts.get(resource.resourceId).abandonmentEvidence()) })}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    const firstCarrier = await attach(), firstClient = client();
    const seen: SDKMessage[] = [];
    const options: ClaudeRuntimeSessionOptions = { ...configuration, sessionId, cwd: workspace, launch: "new", environment: {},
      model: "claude-sonnet-5", effort: "low", permissionMode: "dontAsk", onMessage: message => { seen.push(message); }, onFailure: error => errors.push(error) };
    const original = firstClient.createSession(options);
    await original.start();
    expect(sdk.queryCount).toBe(1);
    seen.length = 0;
    const runtimeId = services.status().resources[0]!.resourceId, host = hosts.get(runtimeId);
    await original.send({ operationId: firstId, content: inputText });
    await waitFor(() => seen.some(message => message.type === "stream_event" && message.event.type === "content_block_delta"));
    await original.send({ operationId: steerId, content: steerText, priority: "next" });
    await waitFor(() => lifecycle(steerId).includes("queued"));
    expect(lifecycle(steerId)).toEqual(["queued"]);
    expect(host.abandonmentEvidence().sessions[0]).toMatchObject({ providerState: "running", activeOperationIds: [firstId, steerId], pendingInputIds: [steerId] });
    expect(requests).toEqual([{ firstInput: true, steerInput: false, firstReply: false }]);
    await firstClient.close(); await firstCarrier.close();
    const detachedCount = seen.length;
    expect(host.snapshot().blockers).toContain("active_work");

    releaseFirst();
    await waitFor(() => requests.length === 2 && lifecycle(steerId).includes("started"));
    expect(requests[1]).toEqual({ firstInput: true, steerInput: true, firstReply: true });
    expect(host.snapshot().blockers).toContain("active_work");
    expect(host.abandonmentEvidence().sessions[0]!.activeOperationIds).toContain(steerId);
    expect(host.abandonmentEvidence().sessions[0]!.pendingInputIds).toEqual([]);
    expect(seen).toHaveLength(detachedCount);
    releaseSecond();
    await waitFor(() => !host.snapshot().blockers.includes("active_work"));
    expect(host.snapshot().blockers).toContain("unsettled_outcome");
    expect(host.abandonmentEvidence().sessions[0]).toMatchObject({ providerState: "idle", activeOperationIds: [], pendingInputIds: [] });
    expect(seen).toHaveLength(detachedCount);

    const secondCarrier = await attach(), replacement = client();
    expect(secondCarrier.lease.controllerEpoch).toBeGreaterThan(firstCarrier.lease.controllerEpoch);
    const replay: SDKMessage[] = [];
    const restored = replacement.createSession({ ...options, launch: "resume", onMessage: message => { replay.push(message); } });
    await restored.start(); await restored.flushMessages?.();
    await waitFor(() => replay.some(message => message.type === "result" && claudeResultUserMessageIds(message).includes(steerId)));
    expect(restored.reattached).toBe(true);
    expect(restored.startupProbeUuid).toBe(original.startupProbeUuid);
    expect(sdk.queryCount).toBe(1);
    expect(runtime.sessions).toHaveLength(1);
    for (const id of [firstId, steerId]) {
      expect(lifecycle(id)).toEqual(["queued", "started", "completed"]);
      expect(replay.filter(message => message.type === "result" && claudeResultUserMessageIds(message).includes(id))).toHaveLength(1);
      expect(replay.filter(message => message.type === "user" && message.uuid === id)).toHaveLength(1);
    }
    expect(replay.filter(message => message.type === "result").every(message => !message.is_error)).toBe(true);
    await waitFor(async () => {
      const history = await readClaudeSessionMessages(sessionId, { dir: workspace }, environment);
      return [firstId, steerId].every(id => history.filter(message => message.uuid === id).length === 1) &&
        [firstReply, secondReply].every(text => history.some(message => message.type === "assistant" && JSON.stringify(message.message).includes(text)));
    });
    expect(requests).toHaveLength(2);
    expect(errors).toEqual([]);
    console.info("[native-persistent-text-steer]", JSON.stringify({ queries: sdk.queryCount, providerRequests: requests.length,
      firstLifecycle: lifecycle(firstId), steerLifecycle: lifecycle(steerId), detachedState: "idle", reattached: restored.reattached }));
    await restored.close({ reason: "evicted" });
  } finally {
    releaseFirst(); releaseSecond();
    for (const value of clients) await value.close();
    for (const carrier of carriers) await carrier.close();
    await runtime.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
