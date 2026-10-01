import Database from "better-sqlite3";
import { sidecarRuntimeBodySchema } from "../../src/server/sidecar/runtime-body-channel.js";
import { openCodeRuntimeDiagnostic } from "../../src/server/backends/opencode/opencode-runtime-diagnostic.js";
import { recoverOpenCodeRuntimeAdministration } from "../../src/server/backends/opencode/opencode-runtime-administration.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistentOpenCodeFixture } from "../helpers/persistent-opencode-fixture.js";
import { callOpenCodeRemoteRuntime } from "../../src/server/backends/opencode/opencode-remote-runtime.js";
import { openCodeRuntimeExecuteOperation, openCodeRuntimeResponseSchema, openCodeRuntimeCommandSchema, openCodePortAdmissionSchema } from "../../src/server/backends/opencode/opencode-runtime-wire.js";
import type { OpenCodeMutationControl, OpenCodeObservationRecord } from "../../src/server/backends/opencode/opencode-native-port.js";

const fixtures: ReturnType<typeof createPersistentOpenCodeFixture>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.close(); });
function fixture(ownership: "owned" | "external" = "owned") {
  const f = createPersistentOpenCodeFixture(ownership); fixtures.push(f); return f;
}
const control = (id: string, step = "prompt"): OpenCodeMutationControl => ({
  identity: { origin: "application", applicationOperationId: id, operationKind: step === "prompt" ? "submit" : "interrupt", step }, deadlineAt: null,
});
function nativeEvent(seq: number, type: string, data: Record<string, unknown>) {
  return { id: `evt_${seq}`, type, created: 1, durable: { aggregateID: "ses_fixture", seq, version: 1 }, data: { sessionID: "ses_fixture", ...data } };
}

describe("OpenCode resident runtime over shared sidecar framing", () => {
  it.each(["owned", "external"] as const)("learns the %s database namespace on the remote host when paths are omitted", async ownership => {
    const f = fixture(ownership); await f.attach();
    const { nativeStorePath: _store, configDirectory: _config, ...defaults } = f.configuration;
    if (defaults.connection.ownership === "owned") defaults.connection = { ownership: "owned", channel: { type: "process_stdio" } };
    const client = f.client(defaults);
    expect(() => client.nativeNamespaceKey).toThrow();
    await client.start();
    expect(client.nativeNamespaceKey).toBe(f.owners[0]!.nativeNamespaceKey);
    expect(client.snapshot().identity?.nativeStorePath).toBe("/native/opencode.db");
    expect(f.owners[0]!.input.nativeStorePath).toBeUndefined();
    const lease = client.acquire(f.target);
    await expect(lease.client.read("getSession", { sessionID: f.wire.sessionID })).resolves.toMatchObject({ id: f.wire.sessionID });
    lease.release();
  });

  it("rejects a remote namespace inconsistent with the observed database identity", async () => {
    const f = fixture(); const carrier = await f.attach();
    const { nativeStorePath: _store, ...defaults } = f.configuration;
    await f.hosts.ensure(defaults, carrier.lease.controllerEpoch);
    const owner = f.owners[0]!, snapshot = owner.snapshot();
    vi.spyOn(owner, "snapshot").mockReturnValue({ ...snapshot, identity: { ...snapshot.identity!, nativeStorePath: "/other/opencode.db" } });
    await expect(f.client(defaults).start()).rejects.toThrow("opencode_runtime_unavailable");
  });

  it("keeps failed startup cleanup administrable before the native namespace is known", async () => {
    const f = fixture(), carrier = await f.attach();
    f.controls.startupFailure = f.controls.cleanupFailure = true;
    await expect(f.client().start()).rejects.toThrow("opencode_owned_cleanup_unproved");
    const owner = f.owners[0]!;
    Object.defineProperty(owner, "nativeNamespaceKey", { get() { throw new Error("opencode_runtime_not_started"); } });
    await carrier.close();
    const reattached = await f.attach();
    const failure = await f.client().start().catch(error => error);
    expect(failure).toMatchObject({ code: "opencode_owned_cleanup_unproved" });
    expect(openCodeRuntimeDiagnostic(failure)).toMatchObject({ recoveryAction: "stop", connectionState: "recovery_required" });
    expect(f.owners).toHaveLength(1);
    const retained = await callOpenCodeRemoteRuntime(reattached.lease, { action: "lookup_retained", backendInstanceId: f.configuration.instance.id });
    expect(retained).toMatchObject({ runtimeId: owner.runtimeId, nativeNamespaceKey: null, snapshot: { state: "cleanup_unproved" } });
    const database = new Database(":memory:");
    try {
      const administration = await recoverOpenCodeRuntimeAdministration({ database, scope: f.scope, instance: f.configuration.instance,
        connections: f.configuration.connections, sidecarRuntime: { acquireRecovery: f.acquireRecovery } });
      const inspection = await administration!.inspect();
      expect(inspection.blockers).toContain("cleanup_unproven");
      await expect(administration!.stop({ expectedRevision: inspection.revision, force: true })).rejects.toMatchObject({ reason: "cleanup_unproven" });
      f.controls.cleanupFailure = false;
      const retry = await administration!.inspect();
      await administration!.stop({ expectedRevision: retry.revision, force: true });
      expect(await f.hosts.lookupRetained(f.configuration.instance.id, reattached.lease.controllerEpoch)).toBeUndefined();
      expect(owner.close).toHaveBeenCalledTimes(2);
    } finally { f.controls.cleanupFailure = false; database.close(); }
  });

  it("multiplexes 150 idle presentation subscriptions and keeps control capacity available", async () => {
    const f = fixture(), carrier = await f.attach(), client = f.client(); await client.start();
    const lease = client.acquire(f.target), observations = [];
    const call = carrier.mainChannel.call.bind(carrier.mainChannel);
    let activePolls = 0, maximumPolls = 0;
    vi.spyOn(carrier.mainChannel, "call").mockImplementation(async (definition, body, options) => {
      const parsed = sidecarRuntimeBodySchema.safeParse(body);
      const value = parsed.success && parsed.data.type === "inline" ? openCodeRuntimeCommandSchema.safeParse(parsed.data.value) : undefined;
      const polling = value?.success && value.data.action === "observe_poll";
      if (polling) maximumPolls = Math.max(maximumPolls, ++activePolls);
      try { return await call(definition, body, options); }
      finally { if (polling) activePolls--; }
    });
    for (let index = 0; index < 150; index++) {
      const observation = lease.client.observe({ purpose: "presentation" }); await observation.ready; observations.push(observation);
    }
    const evidence = lease.client.observe({ purpose: "evidence" }); await evidence.ready; observations.push(evidence);
    await expect(lease.client.mutate("interruptSession", { sessionID: f.wire.sessionID }, control("many-observers-stop", "interrupt")))
      .resolves.toEqual({ interrupted: true });
    expect(maximumPolls).toBeLessThanOrEqual(2);
    f.wire.send(nativeEvent(1, "session.renamed", { title: "delivered to all" }));
    await Promise.all(observations.map(async observation => {
      const received: OpenCodeObservationRecord[] = [];
      await vi.waitFor(() => { received.push(...observation.drain()); expect(received).toHaveLength(1); }, { timeout: 3_000 });
    }));
    await Promise.all(observations.map(observation => observation.close()));
  });

  it.each(["closed", "wrong_port", "wrong_generation"] as const)("isolates a %s poll target from other observations in the batch", async failure => {
    const f = fixture(), carrier = await f.attach(), client = f.client(); await client.start();
    const base = { runtimeId: client.runtimeId!, nativeGeneration: f.owners[0]!.generation };
    const admitted = openCodePortAdmissionSchema.parse(await callOpenCodeRemoteRuntime(carrier.lease, { ...base, action: "acquire", target: f.target }));
    const port = { ...base, portId: admitted.portId };
    const open = async () => {
      const value = await callOpenCodeRemoteRuntime(carrier.lease, { ...port, action: "observe_open", purpose: "presentation" }) as { observationId: string };
      return { observationId: value.observationId };
    };
    const first = await open(), second = await open();
    if (failure === "closed") await callOpenCodeRemoteRuntime(carrier.lease, { ...port, ...first, action: "observe_close" });
    const bad = { ...port, ...first, ...(failure === "wrong_port" ? { portId: "foreign" } : {}),
      ...(failure === "wrong_generation" ? { nativeGeneration: "foreign" } : {}) };
    f.wire.send(nativeEvent(1, "session.renamed", { title: "healthy" }));
    await vi.waitFor(() => expect(f.owners[0]!.nativeHost.retentionSnapshot().observation.pendingEvidenceCount).toBe(1));
    const result = await callOpenCodeRemoteRuntime(carrier.lease, { action: "observe_poll", purpose: "presentation", targets: [bad, { ...port, ...second }] });
    expect(result).toEqual([
      { observationId: first.observationId, result: { status: "ended", reason: "failed", failure: expect.objectContaining({ code: "opencode_request_authority_mismatch" }) } },
      { observationId: second.observationId, result: { status: "events", records: [expect.objectContaining({ kind: "native", event: expect.objectContaining({ type: "session.renamed" }) })] } },
    ]);
  });

  it.each(["aborted", "acquire", "unsupported", "encoding", "capacity"] as const)("preserves an earlier effect when an exact retry has a local %s failure", async failure => {
    const f = fixture(), carrier = await f.attach(), client = f.client(); await client.start();
    const initial = client.acquire(f.target);
    const prompt = { sessionID: f.wire.sessionID, id: "msg_prior_effect", text: "held", delivery: "queue" as const, resume: true };
    await initial.client.mutate("prompt", prompt, control("prior-effect"));
    const lease = client.acquire(f.target);
    if (failure !== "acquire") await lease.client.read("getSession", { sessionID: f.wire.sessionID });
    if (failure === "aborted") await carrier.close();
    else if (failure === "acquire") vi.spyOn(carrier.mainChannel, "encodeBody").mockRejectedValueOnce(new Error("acquire refused"));
    else if (failure === "unsupported") vi.spyOn(carrier.mainChannel, "supportsOperation").mockReturnValue(false);
    else if (failure === "encoding") vi.spyOn(carrier.mainChannel, "encodeBody").mockRejectedValueOnce(new Error("body encoding refused"));
    else vi.spyOn(carrier.mainChannel, "call").mockRejectedValueOnce(new Error("sidecar_protocol_outbound_request_limit"));
    await expect(lease.client.mutate("prompt", prompt, control("prior-effect")))
      .rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    expect(f.promptCount()).toBe(1);
  });

  it.each(["disabled", "stale"] as const)("recovers only exact retained thread authority with %s configuration", async kind => {
    const f = fixture(), first = await f.attach(), initial = f.client(); await initial.start();
    const scope = initial.acquire(f.target);
    await scope.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_retained", text: "retained", delivery: "queue", resume: true }, control("retained"));
    await first.close();
    f.wire.send(nativeEvent(1, "session.inbox.enqueued", { inboxID: "msg_retained", item: { type: "user", delivery: "queue", payload: { text: "retained" } } }));
    await f.attach({ recovery: true, ...(kind === "stale" ? { environmentRevision: 2 } : {}) });
    if (kind === "stale") f.setNormalError(new Error("sidecar_revision_changed"));
    const recovery = f.client(kind === "disabled" ? { ...f.configuration, instance: { ...f.configuration.instance, enabled: false } } : f.configuration);
    await recovery.start();
    expect(f.acquireRecovery).toHaveBeenCalledOnce(); expect(f.owners).toHaveLength(1);
    const retained = recovery.acquire(f.target);
    await expect(retained.client.read("getSession", { sessionID: f.wire.sessionID })).resolves.toMatchObject({ id: f.wire.sessionID });
    await expect(retained.client.outcome("prompt", control("retained").identity)).resolves.toMatchObject({ status: "completed", result: { id: "msg_retained" } });
    const evidence = retained.client.observe({ purpose: "evidence" }), boundary = await evidence.ready;
    const replay: OpenCodeObservationRecord[] = [];
    await vi.waitFor(() => { replay.push(...evidence.drain()); expect(replay).toHaveLength(1); });
    await evidence.acknowledge({ journalId: boundary.journalId, sequence: replay[0]!.sequence });
    await retained.client.acknowledgeOperation({ applicationOperationId: "retained", operationKind: "submit" });
    await evidence.close();
    await expect(retained.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_fresh", text: "new", delivery: "queue", resume: true }, control("new")))
      .rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    await expect(retained.client.read("listSessions", { directory: f.target.directory })).rejects.toBeDefined();
    for (const target of [
      { ...f.target, session: { ...f.target.session, applicationThreadId: "different-thread" } },
      { ...f.target, session: { ...f.target.session, bindingFingerprint: "changed" } },
      { ...f.target, session: { ...f.target.session, nativeSessionID: "ses_foreign" } },
      { ...f.target, directory: "/different-workspace" },
    ]) {
      const foreign = recovery.acquire(target);
      await expect(foreign.client.read("getSession", { sessionID: f.wire.sessionID })).rejects.toBeDefined(); foreign.release();
    }
    const unbound = recovery.acquire({ directory: f.target.directory });
    await expect(unbound.client.read("getSession", { sessionID: f.wire.sessionID })).rejects.toBeDefined(); unbound.release();
    await expect(retained.client.mutate("interruptSession", { sessionID: f.wire.sessionID }, control("recovery-stop", "interrupt")))
      .resolves.toEqual({ interrupted: true });
    expect(f.promptCount()).toBe(1); retained.release();
  });

  it("never ensures a missing owner during disabled recovery", async () => {
    const f = fixture(); await f.attach({ recovery: true });
    const client = f.client({ ...f.configuration, instance: { ...f.configuration.instance, enabled: false } });
    await expect(client.start()).rejects.toBeDefined(); expect(f.owners).toEqual([]);
    expect(f.provider.acquire).not.toHaveBeenCalled(); expect(f.acquireRecovery).toHaveBeenCalledOnce();
  });

  it("recovers administrative Stop after desired native paths change without thread authority", async () => {
    const f = fixture(), first = await f.attach(), initial = f.client(); await initial.start();
    await first.close(); const carrier = await f.attach({ recovery: true, environmentRevision: 2 });
    const changed = f.client({ ...f.configuration, nativeStorePath: "/edited/opencode.db" });
    f.setNormalError(new Error("sidecar_revision_changed"));
    await expect(changed.start()).rejects.toBeDefined();
    const database = new Database(":memory:");
    try {
      const administration = await recoverOpenCodeRuntimeAdministration({ database, scope: f.scope, instance: f.configuration.instance,
        connections: f.configuration.connections, sidecarRuntime: { acquireRecovery: f.acquireRecovery } });
      const inspection = await administration!.inspect();
      await administration!.stop({ expectedRevision: inspection.revision, force: true });
      expect(f.owners[0]!.close).toHaveBeenCalledOnce();
      expect(await f.hosts.lookupRetained(f.configuration.instance.id, carrier.lease.controllerEpoch)).toBeUndefined();
    } finally { database.close(); }
  });

  it("retains a dispatched prompt after response loss and recovers it without another native write", async () => {
    const f = fixture(), first = await f.attach(), client = f.client(); await client.start();
    const scope = client.acquire(f.target), held = f.holdPromptResponse();
    const pending = scope.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_lost", text: "held", delivery: "queue", resume: true }, control("lost"))
      .catch(error => error);
    await held.entered; await first.close();
    expect(await pending).toMatchObject({ delivery: "sent_outcome_unknown" });
    held.release(); await f.attach(); await client.start();
    const recovered = client.acquire(f.target);
    await vi.waitFor(async () => expect(await recovered.client.outcome("prompt", control("lost").identity)).toMatchObject({ status: "completed", result: { id: "msg_lost" } }));
    await recovered.client.acknowledgeOperation({ applicationOperationId: "lost", operationKind: "submit" });
    expect(f.promptCount()).toBe(1);
  });

  it("streams large native requests and history through the shared bounded body channel", async () => {
    const f = fixture(), carrier = await f.attach(), client = f.client(); await client.start();
    const encodeRequest = vi.spyOn(carrier.mainChannel, "encodeBody"), encodeResponse = vi.spyOn(carrier.hostChannel, "encodeBody");
    const scope = client.acquire(f.target), text = "long native message ".repeat(8_000);
    await scope.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_bulk", text, delivery: "queue", resume: true }, control("bulk"));
    f.wire.messages.push({ id: "msg_bulk", type: "user", text, time: { created: 1 } });
    const history = await scope.client.read("getHistoryPage", { sessionID: f.wire.sessionID });
    expect(history.data[0]).toMatchObject({ text });
    expect((await Promise.all(encodeRequest.mock.results.map(result => result.value))).some(body => body.type === "stream")).toBe(true);
    expect((await Promise.all(encodeResponse.mock.results.map(result => result.value))).some(body => body.type === "stream")).toBe(true);
  });

  it("admits a fresh Stop and evidence scope on control while ordinary history requests fill the carrier", async () => {
    const f = fixture(), carrier = await f.attach(), client = f.client(); await client.start();
    const calls = vi.spyOn(carrier.mainChannel, "call"), scope = client.acquire(f.target), held = f.wire.hold(`/api/session/${f.wire.sessionID}/message`);
    const reads = Array.from({ length: 96 }, () => scope.client.read("getHistoryPage", { sessionID: f.wire.sessionID }).catch(error => error));
    try {
      await vi.waitFor(() => expect(f.wire.requests.filter(request => request.pathname.endsWith("/message"))).toHaveLength(96));
      const fresh = client.acquire(f.target);
      await expect(fresh.client.mutate("interruptSession", { sessionID: f.wire.sessionID }, control("priority-stop", "interrupt")))
        .resolves.toEqual({ interrupted: true });
      const evidence = fresh.client.observe({ purpose: "evidence" }); await evidence.ready;
      const commands = calls.mock.calls.flatMap(([definition, body]) => {
        const parsed = sidecarRuntimeBodySchema.safeParse(body);
        const command = parsed.success && parsed.data.type === "inline" ? openCodeRuntimeCommandSchema.safeParse(parsed.data.value) : undefined;
        return command?.success ? [{ definition, command: command.data }] : [];
      }).filter(record => ["acquire", "observe_open", "observe_poll"].includes(record.command.action));
      expect(commands.length).toBeGreaterThanOrEqual(3);
      expect(commands.every(record => record.definition.lane === "control")).toBe(true);
      await evidence.close(); fresh.release();
    } finally { held.release(); await Promise.all(reads); }
  });

  it.each(["owned", "external"] as const)("retains %s ownership, receipts and evidence after a carrier replacement", async ownership => {
    const f = fixture(ownership), first = await f.attach(), client = f.client(); await client.start();
    const lease = client.acquire(f.target), observation = lease.client.observe({ purpose: "evidence" });
    const baseline = await observation.ready;
    await lease.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_pending", text: "hello", delivery: "queue", resume: true }, control("send"));
    await first.close();
    expect(f.owners).toHaveLength(1); expect(f.owners[0]!.close).not.toHaveBeenCalled();
    f.wire.send(nativeEvent(1, "session.inbox.enqueued", { inboxID: "msg_pending", item: { type: "user", delivery: "queue", payload: { text: "hello" } } }));
    f.wire.send(nativeEvent(2, "session.inbox.delivered", { inboxID: "msg_pending" }));
    await vi.waitFor(() => expect(f.owners[0]!.nativeHost.retentionSnapshot().observation.pendingEvidenceCount).toBe(2));
    await f.attach(); await client.start();
    const replacement = client.acquire(f.target);
    await expect(replacement.client.outcome("prompt", control("send").identity)).resolves.toMatchObject({ status: "completed", result: { id: "msg_pending" } });
    const replay = replacement.client.observe({ purpose: "evidence", after: { journalId: baseline.journalId, sequence: baseline.throughSequence } });
    expect((await replay.ready).journalId).toBe(baseline.journalId);
    const records: OpenCodeObservationRecord[] = [];
    await vi.waitFor(() => { records.push(...replay.drain()); expect(records).toHaveLength(2); });
    expect(records.map(record => record.sequence)).toEqual([1, 2]);
    await replay.acknowledge({ journalId: baseline.journalId, sequence: 2 });
    await replacement.client.acknowledgeOperation({ applicationOperationId: "send", operationKind: "submit" });
    expect(f.promptCount()).toBe(1); expect(f.owners).toHaveLength(1);
    await client.close(); expect(f.owners[0]!.close).not.toHaveBeenCalled();
  });

  it("keeps Stop on the control lane while a history read is blocked", async () => {
    const f = fixture(); await f.attach(); const client = f.client(); await client.start();
    const lease = client.acquire(f.target), held = f.wire.hold(`/api/session/${f.wire.sessionID}/message`);
    const reading = lease.client.read("getHistoryPage", { sessionID: f.wire.sessionID }).catch(error => error);
    try {
      await held.entered;
      await expect(lease.client.mutate("interruptSession", { sessionID: f.wire.sessionID }, control("stop", "interrupt")))
        .resolves.toEqual({ interrupted: true });
    } finally { held.release(); await reading; }
  });

  it("rejects stale controllers, wrong lanes and administrative scope escalation", async () => {
    const f = fixture(), first = await f.attach();
    const client = f.client(); await client.start(); const runtimeId = client.runtimeId!;
    const changed = { ...f.configuration, nativeStorePath: "/different/opencode.db" };
    await expect(callOpenCodeRemoteRuntime(first.lease, { action: "lookup", configuration: { ...f.configuration, instance: { ...f.configuration.instance, enabled: false } } }))
      .rejects.toBeDefined();
    await expect(callOpenCodeRemoteRuntime(first.lease, { action: "lookup", configuration: changed })).rejects.toBeDefined();
    const body = await first.mainChannel.encodeBody({ action: "inspect", runtimeId,
      controllerEpoch: first.lease.controllerEpoch, serviceIncarnation: first.lease.serviceIncarnation });
    const response = openCodeRuntimeResponseSchema.parse(await first.mainChannel.decodeBody(await first.mainChannel.call(openCodeRuntimeExecuteOperation, body)));
    expect(response.status).toBe("failed");
    const second = await f.attach();
    await expect(callOpenCodeRemoteRuntime(first.lease, { action: "info", runtimeId })).rejects.toBeDefined();
    const retained = await callOpenCodeRemoteRuntime(second.lease, { action: "lookup_retained", backendInstanceId: f.configuration.instance.id }) as { runtimeId: string };
    expect(retained.runtimeId).toBe(runtimeId);
    await expect(callOpenCodeRemoteRuntime(second.lease, { action: "acquire", runtimeId,
      nativeGeneration: f.owners[0]!.generation, target: f.target })).rejects.toBeDefined();
    await expect(callOpenCodeRemoteRuntime(second.lease, { action: "inspect", runtimeId })).resolves.toMatchObject({ blockers: ["unknown_state"] });
  });

  it.each(["owned", "external"] as const)("only explicit Stop retires the %s host attachment", async ownership => {
    const f = fixture(ownership); await f.attach(); const client = f.client(); await client.start();
    await expect(client.stop()).resolves.toMatchObject({ cleanup: "proved", nativeInterrupts: ownership === "external" ? "not_owned" : "incomplete" });
    expect(f.owners[0]!.close).toHaveBeenCalledOnce(); expect(f.archive).toHaveBeenCalled();
    expect(await f.hosts.lookupRetained(f.configuration.instance.id, f.services.controllerEpoch)).toBeUndefined();
  });
});
