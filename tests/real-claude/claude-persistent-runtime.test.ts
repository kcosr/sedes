import { claudeResultUserMessageIds } from "../../src/server/backends/claude/claude-result-lifecycle.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { ClaudePersistentRuntimeClient } from "../../src/server/backends/claude/runtime/claude-remote-runtime-client.js";
import type { ClaudePersistentEvent } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-wire.js";
import { compactedStreamSequences, historyCovers } from "../../src/server/backends/claude/runtime/claude-replay-retention.js";
import { ClaudePersistentRuntimeRegistry } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-registry.js";
import { registerClaudePersistentRuntimeHost } from "../../src/server/backends/claude/runtime/claude-sidecar-runtime.js";
import { verifyClaudeRuntimeVersion } from "../../src/server/backends/claude/claude-release-guard.js";
import type { ClaudeRuntimeSessionOptions } from "../../src/server/backends/claude/claude-runtime-client.js";
import { installClaudeWorkerBundle } from "../../src/server/backends/claude/worker/claude-sidecar-worker-artifact.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import type { SidecarRuntimeLease, SidecarRuntimeProvider } from "../../src/server/sidecar/runtime-channel.js";
import { createClaudeFramedCarrier } from "../helpers/persistent-claude-fixture.js";

const MODEL = "claude-sonnet-5";
const TIMEOUT = 240_000;
const scope = {
  tenantId: "real-claude-persistent-tenant",
  principalId: "real-claude-persistent-principal",
  executionEnvironmentId: "real-claude-persistent-environment",
  backendInstanceId: "real-claude-persistent-backend",
};

/** Real provider and managed-worker stdio, with local framed sockets standing
 * in for the SSH carrier. This does not verify an SSH server or remote login. */
describe.sequential("real Claude persistent runtime with local SSH carrier stand-in", () => {
  it("finishes an active turn after main disposal and reattaches its worker without resubmitting", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "sedes-real-claude-persistent-")));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    const auditPath = path.join(root, "query-audit.jsonl");
    const configuration = {
      ...scope,
      executablePath: process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude",
      configDirectory: process.env.SEDES_REAL_CLAUDE_CONFIG_DIRECTORY,
      initializationTimeoutMs: 30_000,
    };
    const serviceConfiguration = { environmentRevision: 1, operationsRevision: 1 };
    const services = new PersistentSidecarServiceRegistry({
      scope: {
        tenantId: scope.tenantId, principalId: scope.principalId,
        executionEnvironmentId: scope.executionEnvironmentId, installationId: "live-fixture",
      },
      buildId: "real-claude-persistent", artifactSha256: "a".repeat(64),
      runtimeWireVersion: 1, configuration: serviceConfiguration,
    });
    const hosts = new ClaudePersistentRuntimeRegistry({
      scope, executionEnvironmentId: scope.executionEnvironmentId,
      environmentChannel: new LocalEnvironmentChannelProvider({ scope, executionEnvironmentId: scope.executionEnvironmentId }),
      environment: process.env, services,
      artifact: () => buildToolDisabledWorker(root, auditPath),
    });
    let current: SidecarRuntimeLease | undefined;
    const sidecarRuntime: SidecarRuntimeProvider = {
      acquire: async signal => {
        signal?.throwIfAborted();
        if (!current) throw new Error("live_carrier_unavailable");
        return current;
      },
    };
    const clients: ClaudePersistentRuntimeClient[] = [];
    const carriers: { close(): Promise<void> }[] = [];
    const failures: unknown[] = [];
    const client = () => {
      const value = new ClaudePersistentRuntimeClient({ ...configuration, scope, sidecarRuntime,
        onBackgroundError: error => { failures.push(error); } });
      clients.push(value);
      return value;
    };
    async function attach() {
      const carrier = await createClaudeFramedCarrier();
      const controllerEpoch = services.attach(serviceConfiguration);
      const detach = registerClaudePersistentRuntimeHost({
        registry: carrier.hostRegistry, channel: carrier.hostChannel, hosts, controllerEpoch,
        onDetach: () => services.detach(controllerEpoch),
      });
      await carrier.start();
      let disconnected!: () => void;
      const lease: SidecarRuntimeLease = {
        channel: carrier.mainChannel, controllerEpoch, serviceIncarnation: services.serviceIncarnation,
        closed: new Promise<void>(resolve => { disconnected = resolve; }), release() {},
      };
      current = lease;
      let closed = false;
      const attached = {
        lease,
        async close() {
          if (closed) return;
          closed = true;
          if (current === lease) current = undefined;
          detach(); disconnected(); await carrier.close();
        },
      };
      carriers.push(attached);
      return attached;
    }
    async function waitFor(predicate: () => boolean | Promise<boolean>) {
      const deadline = Date.now() + TIMEOUT;
      while (!(await predicate())) {
        if (failures.length) throw failures[0];
        if (Date.now() >= deadline) throw new Error("REAL_CLAUDE_FAILURE: persistent turn timed out");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }

    try {
      const firstCarrier = await attach();
      const firstClient = client();
      // The worker's normal CLI auth gate rejects API keys and non-subscription
      // accounts; the fixture additionally records only a verified boolean.
      const probe = await firstClient.probe({
        executablePath: configuration.executablePath, cwd: workspace,
        timeoutMs: configuration.initializationTimeoutMs, environment: {},
      });
      verifyClaudeRuntimeVersion(probe.cliRelease);
      expect(probe.account.apiProvider).toBe("firstParty");
      expect(probe.account.subscriptionType).toBeTruthy();
      const eligible = probe.models.filter(model =>
        (model.resolvedModel ?? model.value) === MODEL && model.supportedEffortLevels?.includes("low"));
      expect(eligible, "REAL_CLAUDE_BLOCKER: exactly one Sonnet 5/low catalog entry required").toHaveLength(1);
      expect((await readAudit(auditPath)).some(entry => entry.authVerified)).toBe(true);

      const sessionId = randomUUID();
      const firstMessages: SDKMessage[] = [];
      const options: ClaudeRuntimeSessionOptions = {
        executablePath: configuration.executablePath,
        initializationTimeoutMs: configuration.initializationTimeoutMs,
        sessionId, cwd: workspace, launch: "new", environment: {},
        model: MODEL, effort: "low", permissionMode: "dontAsk",
        onMessage: message => { firstMessages.push(message); },
        onFailure: error => { failures.push(error); },
      };
      const firstSession = firstClient.createSession(options);
      await firstSession.start();
      const originalQuery = (await readAudit(auditPath)).filter(entry => entry.persistent);
      expect(originalQuery).toHaveLength(1);
      expect(originalQuery[0]).toMatchObject({ model: MODEL, effort: "low", permissionMode: "dontAsk", toolsDisabled: true });
      firstMessages.length = 0;
      const runtimeId = services.status().resources[0]!.resourceId;
      const operationId = randomUUID();
      await firstSession.send({ operationId, content:
        "I am testing the streaming display and reconnection of Sedes. Please generate sample UI content without using tools: 40 numbered lines, each containing SEDES_PERSISTENT_CLAUDE_OK followed by a different short sentence about clouds. No introduction or conclusion." });
      await waitFor(() => firstMessages.some(message => message.type === "stream_event"));
      const steerId = randomUUID();
      await firstSession.send({ operationId: steerId, priority: "next", content:
        "Continue the requested content without tools; include SEDES_LIVE_STEER_OK in your final line." });
      expect(hosts.get(runtimeId).snapshot().blockers).toContain("active_work");
      await firstClient.close();
      await firstCarrier.close();
      const detachedMessageCount = firstMessages.length;
      expect(hosts.get(runtimeId).snapshot().blockers).toContain("active_work");
      // Completion must happen with no main client and no carrier attached.
      await waitFor(() => !hosts.get(runtimeId).snapshot().blockers.includes("active_work"));
      expect(hosts.get(runtimeId).snapshot().blockers).toContain("unsettled_outcome");
      expect(firstMessages).toHaveLength(detachedMessageCount);

      const secondCarrier = await attach();
      expect(secondCarrier.lease.controllerEpoch).toBeGreaterThan(firstCarrier.lease.controllerEpoch);
      expect(secondCarrier.lease.serviceIncarnation).toBe(firstCarrier.lease.serviceIncarnation);
      const restoredMessages: SDKMessage[] = [];
      const secondClient = client();
      const restored = secondClient.createSession({ ...options, launch: "resume",
        onMessage: message => { restoredMessages.push(message); } });
      await restored.start();
      await restored.flushMessages?.();
      await waitFor(() => restoredMessages.some(message => message.type === "result" && claudeResultUserMessageIds(message).includes(steerId)));
      const results = restoredMessages.filter((message): message is Extract<SDKMessage, { type: "result" }> => message.type === "result" && message.num_turns > 0);
      expect(results.every(message => !message.is_error)).toBe(true);
      expect(results.filter(message => claudeResultUserMessageIds(message).includes(steerId))).toHaveLength(1);
      expect(results.some(message => claudeResultUserMessageIds(message).includes(operationId))).toBe(true);
      expect(restored.reattached).toBe(true);
      expect(restored.startupProbeUuid).toBe(firstSession.startupProbeUuid);
      expect(services.status().resources[0]!.resourceId).toBe(runtimeId);
      expect(restoredMessages.some(message => message.type === "stream_event")).toBe(true);
      const replayedAssistant = restoredMessages.filter(message => message.type === "assistant");
      expect(replayedAssistant.length).toBeGreaterThan(0);
      // An unchanged query audit proves no second SDK query or worker was
      // created. There is deliberately no send() after restoring the client.
      expect((await readAudit(auditPath)).filter(entry => entry.persistent)).toEqual(originalQuery);
      // The provider result is not a native-store flush barrier. Wait for
      // those exact assistant identities to become durable before comparing.
      let history = await secondClient.getSessionMessages(sessionId, { dir: workspace }, {});
      await waitFor(async () => {
        history = await secondClient.getSessionMessages(sessionId, { dir: workspace }, {});
        return history.some(message => message.type === "user" && message.uuid === steerId) &&
          replayedAssistant.every(message => history.some(item => item.type === "assistant" && item.uuid === message.uuid));
      });
      expect(history.filter(message => message.type === "user" && message.uuid === operationId)).toHaveLength(1);
      expect(history.filter(message => message.type === "user" && message.uuid === steerId)).toHaveLength(1);
      // Persistence is exact native identity/content, independent of whether
      // the model follows the requested fixture prose or returns other text.
      for (const message of replayedAssistant) {
        expect(history.find(item => item.type === "assistant" && item.uuid === message.uuid)?.message)
          .toHaveProperty("content", message.message.content);
      }
      // Exercise retention against native SDK frames and persisted records,
      // including metadata finalized after a complete block was streamed.
      const replay = new Map<number, ClaudePersistentEvent>(restoredMessages.map((message, index) =>
        [index + 1, { sessionId, sequence: index + 1, payload: { kind: "message", message: message as never } }]));
      expect(compactedStreamSequences(replay, new Map()).length).toBeGreaterThan(0);
      for (const candidate of replay.values()) {
        if (candidate.payload.kind !== "message" || candidate.payload.message.type !== "assistant") continue;
        const live = candidate.payload.message;
        const persisted = history.find(item => item.type === "assistant" && item.uuid === live.uuid);
        const liveBody = live.message as Record<string, unknown>;
        const historyBody = persisted?.message as Record<string, unknown> | undefined;
        const changedKeys = [...new Set([...Object.keys(liveBody), ...Object.keys(historyBody ?? {})])]
          .filter(key => JSON.stringify(liveBody[key]) !== JSON.stringify(historyBody?.[key]));
        expect(historyCovers(candidate, persisted), `native history coverage; changed metadata keys: ${changedKeys.join(", ")}`).toBe(true);
      }
      expect((await secondClient.getSessionInfo(sessionId, { dir: workspace }, {}))?.sessionId).toBe(sessionId);
      await restored.close({ reason: "evicted" });
      const originalPid = originalQuery[0]!.pid!;
      await waitFor(() => {
        try { process.kill(originalPid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      });
      // Last eviction exits the real shared worker; a later conversation
      // resumes native history in a new worker without another submitted turn.
      const reopened = secondClient.createSession({ ...options, launch: "resume", onMessage: () => {} });
      await reopened.start();
      const queries = (await readAudit(auditPath)).filter(entry => entry.persistent);
      expect(queries).toHaveLength(2);
      expect(queries[1]!.pid).not.toBe(originalPid);
      expect(reopened.reattached).toBe(false);
      await reopened.close({ reason: "evicted" });
      expect(failures).toEqual([]);
    } finally {
      try {
        for (const value of clients) await value.close();
        for (const carrier of carriers) await carrier.close();
      } finally {
        try {
          // Test teardown owns the real subprocess even if assertions fail
          // before retained events have been acknowledged.
          await Promise.all(services.status().resources.map(resource => hosts.get(resource.resourceId).input.close()));
        } finally { await rm(root, { recursive: true, force: true }); }
      }
    }
  });
});

type AuditEntry = { authVerified?: boolean; persistent?: boolean; pid?: number; model?: string; effort?: string; permissionMode?: string; toolsDisabled?: boolean };
async function readAudit(filename: string): Promise<AuditEntry[]> {
  return (await readFile(filename, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as AuditEntry);
}

/** Decorate the real facade solely for the live suite's pre-existing safety
 * contract. All worker ownership, supervision, stdio, and artifact admission
 * code remains production code; no provider messages are fabricated. */
async function buildToolDisabledWorker(root: string, auditPath: string) {
  const buildId = "real-claude-persistent";
  const filename = "sedes-claude-runtime-worker.mjs";
  const result = await build({
    entryPoints: [path.resolve("src/server/backends/claude/worker/claude-runtime-worker-main.ts")],
    outfile: path.join(root, filename), bundle: true, platform: "node", format: "esm",
    target: "node24", packages: "bundle", write: false, legalComments: "none",
    define: { __SEDES_CLAUDE_RUNTIME_WORKER_BUILD_ID__: JSON.stringify(buildId) },
    plugins: [{ name: "real-provider-tools-disabled", setup(builder) {
      builder.onLoad({ filter: /[/\\]tracked-claude-sdk-facade\.ts$/ }, async args => ({
        loader: "ts", resolveDir: path.dirname(args.path),
        contents: `${await readFile(args.path, "utf8")}
import { appendFileSync as appendLiveAudit } from "node:fs";
const liveAudit = entry => appendLiveAudit(${JSON.stringify(auditPath)}, JSON.stringify(entry) + "\\n", { mode: 0o600 });
const originalLiveAuth = TrackedClaudeSdkFacade.prototype.readCliAuthStatus;
TrackedClaudeSdkFacade.prototype.readCliAuthStatus = async function (...args) {
  const status = await originalLiveAuth.apply(this, args);
  const authVerified = status.loggedIn === true && status.authMethod === "claude.ai" && status.apiProvider === "firstParty" && !!status.subscriptionType && status.apiKeySource === undefined;
  if (!authVerified) throw new Error("REAL_CLAUDE_BLOCKER: subscription authentication required");
  liveAudit({ authVerified });
  return status;
};
`,
      }));
      builder.onLoad({ filter: /[/\\]claude-sdk-facade\.ts$/ }, async args => ({
        loader: "ts", resolveDir: path.dirname(args.path),
        contents: `${await readFile(args.path, "utf8")}
import { appendFileSync as appendLiveAudit } from "node:fs";
const liveAudit = entry => appendLiveAudit(${JSON.stringify(auditPath)}, JSON.stringify(entry) + "\\n", { mode: 0o600 });
const originalLiveQuery = OfficialClaudeSdkFacade.prototype.createQuery;
OfficialClaudeSdkFacade.prototype.createQuery = function (input) {
  const options = { ...input.options, tools: [], strictMcpConfig: true, mcpServers: {} };
  if (options.persistSession !== false && (options.model !== ${JSON.stringify(MODEL)} || options.effort !== "low" || options.permissionMode !== "dontAsk")) {
    throw new Error("REAL_CLAUDE_BLOCKER: Sonnet 5 low dontAsk required");
  }
  liveAudit({ persistent: options.persistSession !== false, pid: process.pid, model: options.model, effort: options.effort, permissionMode: options.permissionMode, toolsDisabled: true });
  return originalLiveQuery.call(this, { ...input, options });
};`,
      }));
    } }],
  });
  const source = result.outputFiles?.[0]?.text;
  if (!source) throw new Error("real_claude_worker_build_missing");
  return installClaudeWorkerBundle(root, { source, manifest: JSON.stringify({
    schemaVersion: 1, artifactId: "openai.sedes.claude-runtime-worker", filename,
    modes: ["claude_runtime"], sha256: createHash("sha256").update(source).digest("hex"),
    bytes: Buffer.byteLength(source), buildId, minimumNodeVersion: "24.18.0",
  }) });
}
