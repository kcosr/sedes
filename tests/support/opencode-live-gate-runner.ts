import { openCodeRuntimeTarget } from "../../src/server/backends/opencode/opencode-conversation-context.js";
import { openCodeTestMutationControl } from "../helpers/opencode-native-port-fixture.js";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";
import type { ConversationHandle, SubmitTurnInput } from "../../src/server/backends/contracts.js";
import { OpenCodeRuntime } from "../../src/server/backends/opencode/opencode-runtime.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OpenCodeNativeMutations } from "../../src/server/backends/opencode/opencode-native-mutations.js";
import { OpenCodeInputEvidenceRepository } from "../../src/server/backends/opencode/opencode-input-evidence.js";
import { openCodeHistoryTurnId } from "../../src/server/backends/opencode/opencode-history-projection.js";
import { parseLiveInput, liveConfiguration, settledCanaryPeriod, within, cleanupLiveGate, assertLiveGateBudget, LIVE_GATE_LIMITS, LIVE_GATE_PROVIDER_ID } from "./opencode-live-gate.js";
import { monitorLiveGate } from "./opencode-live-monitor.js";
import { createOpenCodeConversationFixture, scope, threadID } from "./opencode-conversation-fixture.js";

const { deadlineMs, outputBytes } = LIVE_GATE_LIMITS;

/** Test-only runner. Live callers must pass strict parseLiveInput output; loopback tests inject synthetic input. */
export async function runOpenCodeReadonlyGate(input: ReturnType<typeof parseLiveInput>, credential: string, options: {
  readonly canary?: string;
  readonly beforeSubmit?: (input: { canaryFile: string; workspace: string }) => void | Promise<void>;
} = {}): Promise<void> {
  const deadlineAt = Date.now() + deadlineMs;
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-opencode-live-"));
  const workspace = path.join(root, "workspace"), config = path.join(root, "config"), store = path.join(root, "store", "opencode.db");
  const canary = options.canary ?? randomBytes(12).toString("hex"), canaryFile = path.join(workspace, "canary.txt");
  const lifetime = new AbortController();
  let runtime: OpenCodeRuntime | undefined, current: ReturnType<typeof createOpenCodeConversationFixture> | undefined;
  let handle: ConversationHandle | undefined, monitor: ReturnType<typeof monitorLiveGate> | undefined;
  let monitorFailure: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, originalFailure: unknown;
  const reads = new Set<Promise<unknown>>();
  const wait = <T>(work: Promise<T>): Promise<T> => {
    reads.add(work); void work.finally(() => reads.delete(work)).catch(() => undefined);
    return within(work, lifetime.signal);
  };
  const promptSpy = vi.spyOn(OpenCodeNativeMutations.prototype, "prompt");
  const fail = (error: Error) => {
    monitorFailure ??= error; lifetime.abort(error);
    const stopping = handle?.interrupt({ applicationOperationId: "live-gate-stop", deadlineAt: Date.now() + 5_000 });
    if (stopping) {
      reads.add(stopping);
      void stopping.finally(() => reads.delete(stopping)).catch(() => undefined);
    }
  };
  timer = setTimeout(() => fail(new Error("Live-gate deadline exceeded")), Math.max(0, deadlineAt - Date.now()));
  try {
    await Promise.all([workspace, config, path.dirname(store), path.join(root, "home")].map(folder => mkdir(folder, { recursive: true, mode: 0o700 })));
    await writeFile(canaryFile, canary, { mode: 0o600 });
    await writeFile(path.join(root, "models.json"), "{}", { mode: 0o600 });
    await writeFile(path.join(config, "opencode.json"), JSON.stringify(liveConfiguration(input, canaryFile)), { mode: 0o600 });
    runtime = new OpenCodeRuntime({ hostIncarnation: "fixture-host", authority: { tenantId: scope.tenantId, principalId: scope.principalId, backendInstanceId: "live-gate", executionEnvironmentId: "local" },
      nativeStorePath: store, configDirectory: config,
      connection: { ownership: "owned", channel: { type: "process_stdio", workingDirectory: workspace, executablePath: input.executable } },
      environment: { PATH: process.env.PATH, LANG: "C.UTF-8", SHELL: "/bin/sh", HOME: path.join(root, "home"),
        XDG_CONFIG_HOME: config, XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
        OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_MODELS_PATH: path.join(root, "models.json"),
        OPENCODE_DISABLE_FFF: "1", OPENCODE_FILEWATCHER_DISABLE: "1", OPENCODE_LIVE_GATE_API_KEY: credential } });
    await wait(runtime.start()); assertLiveGateBudget(deadlineAt, lifetime.signal);
    const lease = runtime.acquire({ directory: workspace });
    let sessionLease: ReturnType<OpenCodeRuntime["acquire"]> | undefined;
    try {
      const native = new OpenCodeNativeMutations(lease.client);
      const model = { providerID: LIVE_GATE_PROVIDER_ID, id: input.model };
      // Stock native provider discovery finishes after the server readiness ACK.
      // Qualify the exact tuple before creating or prompting a session.
      await wait(vi.waitFor(async () => {
        assertLiveGateBudget(deadlineAt, lifetime.signal);
        expect((await native.listModels(workspace, lifetime.signal)).filter(value => value.providerID === LIVE_GATE_PROVIDER_ID && value.id === input.model)).toHaveLength(1);
      }, { timeout: Math.min(20_000, Math.max(1, deadlineAt - Date.now())), interval: 50 }));
      const session = await wait(native.createSession({ id: `ses_${randomBytes(16).toString("hex")}`, title: "Sedes explicit live qualification", location: { directory: workspace }, model }, { ...openCodeTestMutationControl("live-create"), deadlineAt }, lifetime.signal));
      current = createOpenCodeConversationFixture({ native: { sessionID: session.id, directory: workspace, runtime } });
      sessionLease = runtime.acquire(openCodeRuntimeTarget(current.target));
      const api = new OpenCodeNativeApi(sessionLease.client);
      current.context.settings.updateDesired(scope, threadID, { expectedRevision: 0, desired: model, now: Date.now() });
      expect((await api.getSession(session.id, lifetime.signal)).model).toEqual({ ...model, variant: "default" });
      // Attach itself has no caller signal; preserve any late handle for cleanup.
      await wait(current.driver.attach(current.target).then(value => { handle = value; }));
      await wait(handle!.establishProjection({ signal: lifetime.signal }));
      monitor = monitorLiveGate({ observe: options => api.observe(options), sessionID: session.id, signal: lifetime.signal, onFailure: fail });
      await wait(monitor.ready);
      const operation: SubmitTurnInput = { applicationOperationId: "live-canary", mutationId: "live-canary", reconciliationToken: "live-canary", source: { kind: "user" },
        text: `Read ${canaryFile} with the read tool and reply with its exact contents.`, attachments: [], contextExcerpts: [], taskContexts: [] };
      await options.beforeSubmit?.({ canaryFile, workspace });
      let accepted = false;
      try {
        assertLiveGateBudget(deadlineAt, lifetime.signal);
        const sending = handle!.submit(operation);
        reads.add(sending); void sending.finally(() => reads.delete(sending)).catch(() => undefined);
        const result = await within(sending, lifetime.signal);
        expect(result).toMatchObject({ accepted: true, reconciliationToken: operation.reconciliationToken, completionCorrelation: operation.applicationOperationId });
        accepted = true;
      } catch (error) {
        // Reconcile only a possibly dispatched operation; never send again.
        const receipt = current.repository.readOperation(scope, threadID, operation.applicationOperationId, "submit");
        if (!receipt || !["dispatched", "unknown", "accepted"].includes(receipt.disposition)) throw error;
      }
      while (!accepted) {
        if (monitorFailure) throw monitorFailure; lifetime.signal.throwIfAborted();
        const read = current.driver.reconcileSubmission({ ...current.target, applicationOperationId: operation.applicationOperationId, reconciliationToken: operation.reconciliationToken });
        reads.add(read); void read.finally(() => reads.delete(read)).catch(() => undefined);
        const result = await within(read, lifetime.signal);
        if (result.status === "accepted") accepted = true;
        else if (result.status !== "unresolved") throw new Error("Exact canary input was not accepted");
        else await delay(50, undefined, { signal: lifetime.signal });
      }
      const evidence = new OpenCodeInputEvidenceRepository(current.repository).get(scope, threadID, operation.applicationOperationId, "submit");
      expect(evidence.consumedFingerprint !== null && !evidence.payloadConflict).toBe(true);
      const inputId = evidence.receipt.nativeInputId!;
      expect(promptSpy).toHaveBeenCalledTimes(1);
      while (true) {
        if (monitorFailure) throw monitorFailure; lifetime.signal.throwIfAborted();
        const page = await api.getHistoryPage(session.id, { order: "asc", limit: 64, signal: lifetime.signal });
        // Stock cursors mark the last record even on a short final page.
        if (page.data.length >= 64) throw new Error("Live-gate history budget exceeded");
        const period = settledCanaryPeriod(page.data, inputId);
        const assistants = (period?.messages ?? []).filter(message => message.type === "assistant");
        const text = assistants.flatMap(message => message.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n");
        if (Buffer.byteLength(text) > outputBytes) throw new Error("Live-gate response exceeded limit");
        const interactions = await api.getInteractions(session.id, lifetime.signal);
        if (interactions.permissions.length || interactions.forms.length) throw new Error("Unexpected live-gate interaction");
        const activity = await api.getActivity(session.id, workspace, lifetime.signal);
        if (activity.activeChildren.length || activity.shells.length) throw new Error("Unexpected live-gate background work");
        if (period && !activity.active) {
          const completedRead = assistants.some(message => message.content.some(part => part.type === "tool" && part.name === "read"
            && part.state.status === "completed" && part.state.input.path === canaryFile));
          if (!completedRead) throw new Error("Canary read did not complete");
          expect(text.includes(canary)).toBe(true);
          const snapshot = await handle!.establishProjection({ signal: lifetime.signal });
          const turnId = openCodeHistoryTurnId(session.id, period.openingId);
          expect(snapshot.snapshot.turnsById[turnId]).toMatchObject({ status: "completed", completionCorrelations: expect.arrayContaining([operation.applicationOperationId]) });
          break;
        }
        await delay(50, undefined, { signal: lifetime.signal });
      }
      if (monitorFailure) throw monitorFailure;
      await handle!.close(); handle = undefined;
      await wait(current.driver.attach(current.target).then(value => { handle = value; }));
      const reread = await handle!.establishProjection({ signal: lifetime.signal });
      expect(Object.values(reread.snapshot.turnsById).some(turn => turn.status === "completed" && turn.completionCorrelations?.includes(operation.applicationOperationId))).toBe(true);
      const reconciled = current.driver.reconcileSubmission({ ...current.target, applicationOperationId: operation.applicationOperationId, reconciliationToken: operation.reconciliationToken });
      reads.add(reconciled); void reconciled.finally(() => reads.delete(reconciled)).catch(() => undefined);
      expect(await within(reconciled, lifetime.signal)).toMatchObject({ status: "accepted" });
      expect(promptSpy).toHaveBeenCalledTimes(1);
      // Close and settle the observation before success or lifetime cancellation.
      // The monitor inspects matching events in the pump, so none can remain in
      // the native observation's queue when close discards it.
      await monitor.finish();
      if (monitorFailure) throw monitorFailure;
      // Native cost, if reported, is an estimate. This gate has no bill guarantee.
    } finally { sessionLease?.release(); lease.release(); }
  } catch (error) { originalFailure = monitorFailure ?? error; }
  finally {
    clearTimeout(timer); lifetime.abort();
    const cleanup = await cleanupLiveGate({
      observer: async () => { await monitor?.close(); },
      handle: async () => { await handle?.close(); },
      stopRuntime: async () => { if (runtime) { const result = await runtime.stop(); if (result.cleanup !== "proved") throw new Error("Owned cleanup unproved"); } },
      pendingReads: async () => { await Promise.allSettled([...reads]); await handle?.close(); },
      disposeSqlite: async () => {
        // Close the in-memory database even if manager disposal itself rejects.
        try { await current?.dispose(); } finally { if (current?.database.open) current.database.close(); }
      },
      removeRoot: () => rm(root, { recursive: true, force: true }),
    });
    promptSpy.mockRestore();
    const failures = [...new Set([...(originalFailure === undefined ? [] : [originalFailure]), ...(monitorFailure ? [monitorFailure] : [])]), ...cleanup.failures];
    if (failures.length) throw new AggregateError(failures, `OpenCode live gate failed${monitorFailure ? `: ${monitorFailure.message}` : ""}${cleanup.rootRetained ? `; isolated root retained: ${root}` : ""}`);
  }
}
