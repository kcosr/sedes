import { attachFixturePolicy } from "../helpers/execution-policy-fixture.js";
import { runtimeLaunchDigest } from "../../src/server/backends/provider-launch-digest.js";
import { createSidecarFramedCarrier } from "../helpers/persistent-sidecar-framed-fixture.js";
import { claudeResultUserMessageIds } from "../../src/server/backends/claude/claude-result-lifecycle.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { ClaudePersistentRuntimeClient } from "../../src/server/backends/claude/runtime/claude-remote-runtime-client.js";
import type { ClaudePersistentEvent } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-wire.js";
import { compactedStreamSequences, historyCovers } from "../../src/server/backends/claude/runtime/claude-replay-retention.js";
import { ClaudePersistentRuntimeRegistry } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-registry.js";
import { registerClaudePersistentRuntimeHost } from "../../src/server/backends/claude/runtime/claude-sidecar-runtime.js";
import { verifyClaudeRuntimeVersion } from "../../src/server/backends/claude/claude-release-guard.js";
import type { ClaudeRuntimeSessionOptions } from "../../src/server/backends/claude/claude-runtime-client.js";
import { LIVE_CLAUDE_MODEL as MODEL, assertLiveClaudeCatalog } from "../support/live-claude-model.js";
import { buildToolDisabledWorker } from "../support/live-claude-worker.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import type { SidecarRuntimeLease, SidecarRuntimeProvider } from "../../src/server/sidecar/runtime-channel.js";
import { claudeTranscriptContentFingerprint, verifyClaudeForkChild } from "../../src/server/backends/claude/claude-fork-lineage.js";
import { claudeResumableHistoryStart } from "../../src/server/backends/claude/claude-history-projector.js";

const TIMEOUT = 240_000;
const scope = {
  tenantId: "real-claude-persistent-tenant",
  principalId: "real-claude-persistent-principal",
  executionEnvironmentId: "real-claude-persistent-environment",
  backendInstanceId: "real-claude-persistent-backend",
};

/** Real provider and managed-worker stdio, with zstd-compressed local framed
 * sockets standing in for SSH. This does not verify an SSH server or remote login. */
describe.sequential("real Claude persistent runtime with a compressed local SSH carrier stand-in", () => {
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
    acquireExisting: async () => { throw new Error("unused_existing_carrier_admission"); },
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
      const carrier = await createSidecarFramedCarrier("zstd");
      const controllerEpoch = attachFixturePolicy(services, serviceConfiguration, "normal", { roots: [], capabilities: [], backends: [{
        id: configuration.backendInstanceId, kind: "claude_agent_sdk", generation: 1, launchDigest: runtimeLaunchDigest.claude_agent_sdk(configuration),
        targets: [{ id: "live-target", generation: 1 }],
      }] });
      const detach = registerClaudePersistentRuntimeHost({ getExecutionPolicy: () => services.executionPolicy(controllerEpoch),
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
    async function waitFor(predicate: () => boolean | Promise<boolean>, phase = "predicate") {
      const deadline = Date.now() + TIMEOUT;
      while (!(await predicate())) {
        if (failures.length) throw failures[0];
        if (Date.now() >= deadline) {
          console.info("[real-claude-persistent-diagnostic]", JSON.stringify({
            phase,
            hosts: services.status().resources.map(resource => hosts.get(resource.resourceId).abandonmentEvidence()),
            // This test's audit contains only allowlisted fixture metadata.
            audit: (await readAudit(auditPath)).slice(-160),
          }));
          throw new Error("REAL_CLAUDE_FAILURE: persistent turn timed out");
        }
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
      assertLiveClaudeCatalog(probe.models);
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
      await waitFor(() => !hosts.get(runtimeId).snapshot().blockers.includes("active_work"), "detached_active_work");
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
      const context = await restored.contextUsage();
      expect(context.usedTokens).toBeGreaterThan(0);
      expect(context.windowTokens).toBeGreaterThan(0);
      expect(context.percent).toBe(context.usedTokens / context.windowTokens * 100);
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
      // Native presence crosses the real worker and persistent carrier too.
      await expect(secondClient.hasSessionTranscript(sessionId, { dir: workspace }, {})).resolves.toBe(true);
      await expect(secondClient.hasSessionTranscript(randomUUID(), { dir: workspace }, {})).resolves.toBe(false);
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

      // A fork is one locked-down launch inside the host: it copies the
      // source prefix into the reserved child without a model turn and leaves
      // no session behind. The child then attaches and answers on its own.
      const sourceHistory = await secondClient.getSessionMessages(sessionId, { dir: workspace }, {});
      const leafIndex = sourceHistory.findLastIndex(message => message.type === "assistant");
      const sourcePrefix = sourceHistory.slice(claudeResumableHistoryStart(sourceHistory), leafIndex + 1);
      const childSessionId = randomUUID();
      await expect(secondClient.forkSession({
        executablePath: configuration.executablePath, initializationTimeoutMs: configuration.initializationTimeoutMs,
        sessionId: childSessionId, sourceSessionId: sessionId, resumeSessionAt: sourceHistory[leafIndex]!.uuid,
        cwd: workspace, model: MODEL, effort: "low", environment: {},
      })).resolves.toEqual({ cliRelease: probe.cliRelease });
      const forkQueries = (await readAudit(auditPath)).filter(entry => entry.fork);
      expect(forkQueries).toEqual([expect.objectContaining({ persistent: true, permissionMode: "default", lockedDown: true })]);
      const forkHost = hosts.get(services.status().resources[0]!.resourceId);
      expect(forkHost.abandonmentEvidence().sessions.map(session => session.sessionId)).toEqual([sessionId]);
      expect(forkHost.snapshot().blockers).not.toContain("active_work");
      const childHistory = await secondClient.getSessionMessages(childSessionId, { dir: workspace }, {});
      expect(verifyClaudeForkChild({ childMessages: childHistory, sourcePrefix,
        retainedContentDigest: claudeTranscriptContentFingerprint(sourcePrefix) }))
        .toEqual({ omittedTasks: [], omittedTaskNotificationUuids: [] });
      const childMessages: SDKMessage[] = [];
      const child = secondClient.createSession({ ...options, sessionId: childSessionId, launch: "resume",
        onMessage: message => { childMessages.push(message); } });
      await child.start();
      const childOperationId = randomUUID();
      await child.send({ operationId: childOperationId, content: "Reply with exactly SEDES_PERSISTENT_FORK_OK. Do not use tools." });
      await waitFor(() => childMessages.some(message => message.type === "result" && claudeResultUserMessageIds(message).includes(childOperationId)));
      expect(childMessages.filter((message): message is Extract<SDKMessage, { type: "result" }> =>
        message.type === "result" && claudeResultUserMessageIds(message).includes(childOperationId))
        .every(message => !message.is_error)).toBe(true);
      let childAfter = await secondClient.getSessionMessages(childSessionId, { dir: workspace }, {});
      await waitFor(async () => {
        childAfter = await secondClient.getSessionMessages(childSessionId, { dir: workspace }, {});
        return childAfter.some(message => message.type === "user" && message.uuid === childOperationId);
      });
      expect(claudeTranscriptContentFingerprint(childAfter.slice(0, sourcePrefix.length)))
        .toBe(claudeTranscriptContentFingerprint(sourcePrefix));
      expect((await secondClient.getSessionMessages(sessionId, { dir: workspace }, {}))
        .some(message => message.uuid === childOperationId)).toBe(false);
      await child.close({ reason: "evicted" });
      await reopened.close({ reason: "evicted" });
      // With both queries evicted and the fork launch settled, the shared
      // worker exits, which proves no Claude process remained.
      const reopenedPid = queries[1]!.pid!;
      await waitFor(() => {
        try { process.kill(reopenedPid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      });
      expect(forkHost.abandonmentEvidence().sessionCount).toBe(0);
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

type AuditEntry = { authVerified?: boolean; persistent?: boolean; pid?: number; model?: string; effort?: string; permissionMode?: string; toolsDisabled?: boolean; fork?: boolean; lockedDown?: boolean };
async function readAudit(filename: string): Promise<AuditEntry[]> {
  return (await readFile(filename, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as AuditEntry);
}
