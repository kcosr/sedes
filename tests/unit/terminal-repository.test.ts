import { interactiveTerminalV2Operations } from "../../src/internal/sidecar-protocol/interactive-terminal-v2.js";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalResourcesMigration } from "../../src/server/db/migrations/080-terminal-resources.js";
import { terminalTerminationEffectMigration } from "../../src/server/db/migrations/086-terminal-termination-effect.js";
import { terminalEndCleanupPhaseMigration } from "../../src/server/db/migrations/081-terminal-end-cleanup-phase.js";
import type { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import type {
  InteractiveTerminalExit,
  InteractiveTerminalProcess,
} from "../../src/server/execution/interactive-terminal.js";
import { InteractiveTerminalStartUncertainError } from "../../src/server/execution/interactive-terminal.js";
import type { TerminalServerFrame } from "../../src/shared/protocol/terminals.js";
import { TerminalJournalStore } from "../../src/server/terminals/terminal-journal.js";
import { TerminalRepository } from "../../src/server/terminals/terminal-repository.js";
import { TerminalActor } from "../../src/server/terminals/terminal-actor.js";
import { SidecarOperationError } from "../../src/internal/sidecar-protocol/operation-registry.js";
import { TerminalService } from "../../src/server/terminals/terminal-service.js";
import { RemoteInteractiveTerminalProcess, SshInteractiveTerminalProvider } from "../../src/server/execution/ssh-interactive-terminal-provider.js";
import { terminalPrepareOperation, terminalCreateOperation } from "../../src/internal/sidecar-protocol/interactive-terminal-v2.js";
import { FakePersistentPty, terminalHostFixture } from "../helpers/persistent-terminal-fixture.js";

const databases: Database.Database[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("terminal environment retirement", () => {
  it("fences project terminal admission, drains in-flight launch and retains a live process as a removal blocker", async () => {
    const launched = deferred<InteractiveTerminalProcess>();
    const fixture = terminalMaintenanceFixture(() => launched.promise);
    const starting = fixture.create();
    const commit = vi.fn(async () => "removed");
    const retiring = fixture.service.runWithWorkspaceRetired(fixture.scope, fixture.workspaceId, commit);
    const rejected = expect(retiring).rejects.toMatchObject({ code: "conflict" });
    await expect(fixture.create()).rejects.toMatchObject({ code: "conflict" });
    expect(commit).not.toHaveBeenCalled();
    const process = new FakePersistentPty();
    launched.resolve(process);
    const terminal = await starting;
    await rejected;
    expect(process.terminate).not.toHaveBeenCalled();
    process.exit();
    await vi.waitFor(() => expect(fixture.repository.get(fixture.scope, terminal.terminalId)?.lifecycle).toBe("exited"));
    await expect(fixture.service.runWithWorkspaceRetired(fixture.scope, fixture.workspaceId, commit)).resolves.toBe("removed");
    expect(fixture.repository.get(fixture.scope, terminal.terminalId)).toBeDefined();
    await fixture.service.close();
  });

  it("rejects removed-project launches before opening the terminal provider", async () => {
    const fixture = terminalMaintenanceFixture(async () => new FakePersistentPty());
    vi.mocked(fixture.inventory.assertWorkspaceActive).mockImplementation(() => {
      throw new Error("project_removed");
    });
    await expect(fixture.create()).rejects.toThrow("project_removed");
    expect(fixture.provider.openTerminal).not.toHaveBeenCalled();
    await fixture.service.close();
  });

  it("does not block a different project's removal because this environment has a live terminal", async () => {
    const fixture = terminalMaintenanceFixture(async () => new FakePersistentPty());
    await fixture.create();
    const commit = vi.fn(async () => "removed");
    await expect(fixture.service.runWithWorkspaceRetired(fixture.scope, "another-project", commit)).resolves.toBe("removed");
    expect(commit).toHaveBeenCalledOnce();
    await expect(fixture.service.runWithWorkspaceRetired({ ...fixture.scope, principalId: "other" }, fixture.workspaceId, commit))
      .rejects.toMatchObject({ code: "not_found" });
    await fixture.service.close();
  });

  it("drains an admitted start before inspecting impact and rejects new interactive ownership without stopping the PTY", async () => {
    const launched = deferred<InteractiveTerminalProcess>();
    const fixture = terminalMaintenanceFixture(() => launched.promise);
    const starting = fixture.create();
    expect(fixture.provider.openTerminal).toHaveBeenCalledTimes(1);
    const commit = vi.fn(async () => "removed");
    const retiring = fixture.service.runWithEnvironmentRetired(fixture.scope, fixture.environmentId, commit);
    const rejected = expect(retiring).rejects.toMatchObject({ code: "conflict" });
    await expect(fixture.create()).rejects.toMatchObject({ code: "conflict" });
    const pending = fixture.repository.listAll(fixture.scope)[0]!;
    await expect(fixture.service.attach({ scope: fixture.scope, terminalId: pending.terminalId, incarnationId: pending.incarnationId!,
      attachmentId: randomUUID(), producerId: randomUUID(), requestedRole: "controller", restore: { kind: "checkpoint" }, emit() {},
    })).rejects.toMatchObject({ code: "conflict" });
    expect(await fixture.service.reconcileRemote(fixture.scope, fixture.environmentId)).toEqual({ connected: 0, unavailable: 1 });
    expect(fixture.provider.attachTerminal).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    const process = new FakePersistentPty();
    launched.resolve(process);
    const terminal = await starting;
    await rejected;
    expect(fixture.repository.get(fixture.scope, terminal.terminalId)?.lifecycle).toBe("running");
    expect(commit).not.toHaveBeenCalled();
    expect(process.terminate).not.toHaveBeenCalled();
    process.exit();
    await vi.waitFor(() => expect(fixture.repository.get(fixture.scope, terminal.terminalId)?.lifecycle).toBe("exited"));
    await expect(fixture.service.runWithEnvironmentRetired(fixture.scope, fixture.environmentId, commit)).resolves.toBe("removed");
    await fixture.service.close();
  });

  it("retains an uncertain start as a blocker after admitted launch delivery fails", async () => {
    const launched = deferred<InteractiveTerminalProcess>();
    const fixture = terminalMaintenanceFixture(() => launched.promise);
    const starting = fixture.create();
    const failedStart = expect(starting).rejects.toMatchObject({ code: "runtime_unavailable" });
    const commit = vi.fn(async () => undefined);
    const retiring = fixture.service.runWithEnvironmentRetired(fixture.scope, fixture.environmentId, commit);
    const rejected = expect(retiring).rejects.toMatchObject({ code: "conflict" });
    launched.reject(new InteractiveTerminalStartUncertainError());
    await failedStart;
    await rejected;
    expect(fixture.service.impact(fixture.scope, fixture.environmentId)).toMatchObject({ liveCount: 0, unknownCount: 1 });
    expect(commit).not.toHaveBeenCalled();
    await fixture.service.close();
  });

  it("drains the same admitted launches before application shutdown disposes actors", async () => {
    const launched = deferred<InteractiveTerminalProcess>();
    const fixture = terminalMaintenanceFixture(() => launched.promise);
    const starting = fixture.create();
    const closing = fixture.service.close();
    const process = new FakePersistentPty();
    launched.resolve(process);
    const terminal = await starting;
    await closing;
    expect(process.terminate).toHaveBeenCalledWith("kill");
    expect(fixture.repository.get(fixture.scope, terminal.terminalId)?.lifecycle).toBe("interrupted");
  });

  it("holds the fence through commit, permits explicit recovery, and releases after a failed commit", async () => {
    const fixture = terminalMaintenanceFixture(async () => new FakePersistentPty());
    const inserted = insertTerminal(fixture.repository, fixture.scope);
    fixture.repository.finalize(fixture.scope, inserted.terminalId, { lifecycle: "exited", exitCode: 0, headSeq: 0, now: 2_000 });
    const commit = deferred<string>();
    const entered = deferred<void>();
    const retiring = fixture.service.runWithEnvironmentRetired(fixture.scope, fixture.environmentId, async () => {
      entered.resolve(); return await commit.promise;
    });
    const rejected = expect(retiring).rejects.toThrow("save_failed");
    await entered.promise;
    await expect(fixture.create()).rejects.toMatchObject({ code: "conflict" });
    await fixture.service.reconcileRemote(fixture.scope, fixture.environmentId);
    expect(fixture.provider.attachTerminal).not.toHaveBeenCalled();
    await fixture.service.reconcileRemote(fixture.scope, fixture.environmentId, { recoveryOnly: true });
    expect(fixture.provider.recoverTerminal).toHaveBeenCalledTimes(1);
    commit.reject(new Error("save_failed"));
    await rejected;
    const terminal = await fixture.create();
    expect(terminal.lifecycle).toBe("running");
    await fixture.service.close();
  });

  it("rejects another principal before installing a fence or invoking the commit", async () => {
    const fixture = terminalMaintenanceFixture(async () => new FakePersistentPty());
    const commit = vi.fn(async () => undefined);
    await expect(fixture.service.runWithEnvironmentRetired({ ...fixture.scope, principalId: "other-principal" }, fixture.environmentId, commit)).rejects.toMatchObject({ code: "not_found" });
    await expect(fixture.service.runWithEnvironmentRetired({ ...fixture.scope, tenantId: "other-tenant" }, fixture.environmentId, commit)).rejects.toMatchObject({ code: "not_found" });
    expect(commit).not.toHaveBeenCalled();
    expect((await fixture.create()).lifecycle).toBe("running");
    await fixture.service.close();
  });
});

describe("TerminalRepository", () => {
  it("keeps a remote viewer and its controller authority through TUI resize erasures", async () => {
    const database = createDatabase();
    database.exec("UPDATE execution_environments SET kind = 'ssh'");
    const repository = new TerminalRepository(database);
    const scope = { tenantId: "tenant", principalId: "principal" };
    const terminal = repository.markRunning(scope, insertTerminal(repository, scope).terminalId, 1200);
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-redraw-"));
    directories.push(directory);
    const journal = new TerminalJournalStore({ stateDirectory: directory });
    const remote = terminalHostFixture();
    const identity = { terminalId: terminal.terminalId, incarnationId: terminal.incarnationId! };
    await remote.caller.call(terminalCreateOperation, await remote.caller.call(terminalPrepareOperation, {
      ...identity, initialCwd: "/work", rows: 24, columns: 80,
    }));
    const process = await RemoteInteractiveTerminalProcess.attach(remote.caller, identity);
    const actor = new TerminalActor({ scope, terminal, repository, journal, process,
      onTerminalSummaryChanged() {}, onFinalized() {},
    });
    const frames: TerminalServerFrame[] = [];
    const producerId = randomUUID();
    const pty = remote.processes[0]!;
    pty.resize.mockImplementation(async ({ rows }) => { pty.output(`\u001b[H\u001b[2J\u001b[3JTUI:${rows}`); });
    try {
      await actor.ready();
      const viewer = await actor.attach({ attachmentId: randomUUID(), producerId, requestedRole: "controller",
        restore: { kind: "checkpoint" }, emit: frame => { frames.push(frame); },
      });
      await vi.waitFor(() => expect(frames.some(frame => frame.type === "caught_up")).toBe(true));
      const attached = frames.find(frame => frame.type === "attached")!;
      if (attached.type !== "attached") throw new Error("viewer did not attach");
      const controllerEpoch = attached.controllerEpoch;
      for (const [index, rows] of [12, 24, 12, 24].entries()) {
        const start = frames.length;
        await viewer.dispatch({ v: 2, type: "resize", ...identity, controllerEpoch, rows, columns: 80 });
        await vi.waitFor(() => expect(frames.slice(start).some(frame => frame.type === "output"
          && Buffer.from(frame.data, "base64url").toString().includes(`TUI:${rows}`))).toBe(true));
        await viewer.dispatch({ v: 2, type: "input", ...identity, controllerEpoch, producerId,
          inputSeq: index + 1, data: Buffer.from("typed").toString("base64url"),
        });
        expect(frames.at(-1)).toMatchObject({ type: "input_result", outcome: "accepted", inputSeq: index + 1 });
      }
      expect(frames.filter(frame => frame.type === "resync_required" || frame.type === "control_changed" || frame.type === "error")).toEqual([]);
      expect(frames.filter(frame => frame.type === "snapshot_begin")).toHaveLength(1);
      expect(pty.writes.map(bytes => Buffer.from(bytes).toString())).toEqual(Array(4).fill("typed"));
      viewer.close();
    } finally {
      await actor.close();
      pty.exit();
    }
  });

  it.each([
    { action: "end" as const, existingActor: false },
    { action: "end" as const, existingActor: true },
    { action: "delete" as const, existingActor: false },
  ])("uses lifecycle recovery for disabled terminal $action (existing actor: $existingActor)", async ({ action, existingActor }) => {
    const database = createDatabase();
    database.exec("UPDATE execution_environments SET kind = 'ssh'");
    const repository = new TerminalRepository(database);
    const scope = { tenantId: "tenant", principalId: "principal" };
    const starting = insertTerminal(repository, scope);
    const terminal = repository.markRunning(scope, starting.terminalId, 1_200);
    const remote = terminalHostFixture();
    const identity = { terminalId: terminal.terminalId, incarnationId: terminal.incarnationId! };
    await remote.caller.call(terminalCreateOperation, await remote.caller.call(terminalPrepareOperation, {
      ...identity, initialCwd: "/work", rows: 24, columns: 80,
    }));
    remote.processes[0]!.output("retained before capability disabled\r\n");
    remote.processes[0]!.terminate.mockImplementation(async () => {
      remote.processes[0]!.output("final cleanup output\r\n");
      remote.processes[0]!.exit({ disposition: "interrupted", exitCode: null, signal: "SIGHUP", cleanupConfirmed: true });
    });
    if (action === "delete") {
      remote.processes[0]!.output("final cleanup output\r\n");
      remote.processes[0]!.exit();
      repository.finalize(scope, terminal.terminalId, { lifecycle: "exited", exitCode: 0, headSeq: 0, now: 1_500 });
    }
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-disabled-terminal-lifecycle-"));
    directories.push(directory);
    const journal = new TerminalJournalStore({ stateDirectory: directory });
    let ordinaryEnabled = existingActor;
    let caller = remote.caller;
    const ordinaryOperations: string[] = [];
    const durableHandoffs: string[] = [];
    const releaseRecovery = vi.fn();
    const negotiatedCapabilities = [{ capabilityId: "interactive_terminal", majorVersion: 2, operations: interactiveTerminalV2Operations.map(operation => operation.operation) }];
    const acquireOperation = vi.fn(async () => {
      if (!ordinaryEnabled) throw new Error("ordinary_terminal_admission_disabled");
      return { session: { negotiatedCapabilities, call: async (definition: Parameters<typeof caller.call>[0], request: unknown) => {
        ordinaryOperations.push(definition.operation); return await caller.call(definition, request);
      } }, release() {}, carrierGeneration: 1 };
    });
    const acquireRecovery = vi.fn(async () => {
      caller = remote.connect();
      return { session: { negotiatedCapabilities, call: async (definition: Parameters<typeof caller.call>[0], request: unknown) => {
        if (definition.operation === "terminal.acknowledge") {
          const history = journal.read(scope, terminal.terminalId);
          expect(repository.get(scope, terminal.terminalId)?.lifecycle).toBe(action === "end" ? "interrupted" : "exited");
          expect(history.records.at(-1)?.kind).toBe("final_status");
          const output = Buffer.from(history.checkpoint.bytes).toString() + history.records.flatMap(record => record.kind === "output" ? [Buffer.from(record.bytes).toString()] : []).join("");
          expect(output).toContain("retained before capability disabled");
          expect(output).toContain("final cleanup output");
          durableHandoffs.push(output);
        }
        return await caller.call(definition, request);
      } }, release: releaseRecovery, carrierGeneration: 2 };
    });
    const provider = (enabled: boolean) => new SshInteractiveTerminalProvider({ scope, environmentId: terminal.environmentId, enabled,
      configurationRevision: 1, activeConfigurationRevision: () => 1,
      runtime: { canAcquireCapability: () => true, negotiatedCapabilities, acquireOperation, acquireRecovery } as unknown as ConstructorParameters<typeof SshInteractiveTerminalProvider>[0]["runtime"],
    });
    const providers = new Map([[terminal.environmentId, provider(existingActor)]]);
    const service = new TerminalService({ inventory: { assertWorkspaceActive: vi.fn() } as unknown as InventoryRepository, repository, journal, providers, onTerminalSummaryChanged() {} });
    if (existingActor) expect(await service.reconcileRemote(scope)).toEqual({ connected: 1, unavailable: 0 });
    ordinaryEnabled = false;
    ordinaryOperations.length = 0;
    providers.set(terminal.environmentId, provider(false));
    if (action === "end") {
      await expect(service.attach({ scope, ...identity, attachmentId: randomUUID(), producerId: randomUUID(), requestedRole: "controller", restore: { kind: "checkpoint" }, emit() {} })).rejects.toMatchObject({ code: "environment_unavailable" });
    }
    const current = repository.get(scope, terminal.terminalId)!;
    await service[action](scope, terminal.terminalId, { mutationId: randomUUID(), expectedRevision: current.lifecycleRevision });
    expect(new Set(durableHandoffs).size).toBe(1);
    expect(acquireRecovery).toHaveBeenCalledWith(scope, terminal.environmentId, expect.any(AbortSignal), [{ capabilityId: "interactive_terminal", majorVersion: 2 }]);
    expect(releaseRecovery).toHaveBeenCalledTimes(1);
    expect(ordinaryOperations).toEqual([]);
    expect(remote.openTerminal).toHaveBeenCalledTimes(1);
    expect(remote.processes[0]!.terminate).toHaveBeenCalledTimes(action === "end" ? 1 : 0);
    expect(remote.processes[0]!.writes).toEqual([]);
    expect(remote.resources.size).toBe(0);
    expect(repository.get(scope, terminal.terminalId)).toBeUndefined();
    await service.close();
  });

  it("keeps persistent SSH incarnations unknown across restart while preserving legacy/local recovery", () => {
    const database = createDatabase();
    const repository = new TerminalRepository(database);
    const scope = { tenantId: "tenant", principalId: "principal" };
    database.exec("UPDATE execution_environments SET kind = 'ssh'");
    const persistent = insertTerminal(repository, scope);
    const oldCarrier = insertTerminal(repository, scope, "11111111-1111-4111-8111-111111111112", "disconnect_transport");
    repository.markRunning(scope, persistent.terminalId, 1200);
    repository.markRunning(scope, oldCarrier.terminalId, 1200);
    repository.recoverInterrupted(scope, 2000);
    expect(repository.get(scope, persistent.terminalId)).toMatchObject({ lifecycle: "running", incarnationId: "66666666-6666-4666-8666-666666666666" });
    expect(repository.get(scope, oldCarrier.terminalId)).toMatchObject({ lifecycle: "interrupted", publicReason: "server_restarted" });
  });

  it("reattaches one remote PTY after main shutdown and durably hands off its offline final history", async () => {
    const database = createDatabase();
    const repository = new TerminalRepository(database);
    const scope = { tenantId: "tenant", principalId: "principal" };
    database.exec("UPDATE execution_environments SET kind = 'ssh'");
    const starting = insertTerminal(repository, scope);
    const terminal = repository.markRunning(scope, starting.terminalId, 1200);
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-persistent-terminal-recovery-"));
    directories.push(directory);
    const journal = new TerminalJournalStore({ stateDirectory: directory });
    const remote = terminalHostFixture();
    const identity = { terminalId: terminal.terminalId, incarnationId: terminal.incarnationId! };
    await remote.caller.call(terminalCreateOperation, await remote.caller.call(terminalPrepareOperation, {
      ...identity, initialCwd: "/work", rows: 24, columns: 80,
    }));
    let unavailable = false;
    const provider = {
      terminationEffect: "end_process" as const,
      availability: () => "available" as const,
      openTerminal: vi.fn(async () => { throw new Error("recovery_must_not_launch"); }),
      attachTerminal: async () => {
        if (unavailable) throw new Error("carrier_unavailable");
        return await RemoteInteractiveTerminalProcess.attach(remote.caller, identity);
      },
      recoverTerminal: vi.fn(async () => {
        if (unavailable) throw new Error("carrier_unavailable");
        return await RemoteInteractiveTerminalProcess.attach(remote.caller, identity);
      }),
    };
    const makeService = () => new TerminalService({ inventory: { assertWorkspaceActive: vi.fn() } as unknown as InventoryRepository, repository, journal,
      providers: new Map([[terminal.environmentId, provider]]), onTerminalSummaryChanged() {},
    });
    const first = makeService();
    expect(await first.reconcileRemote(scope)).toEqual({ connected: 1, unavailable: 0 });
    remote.processes[0]!.output("\u001b[6n");
    await vi.waitFor(() => expect(remote.processes[0]!.writes).toHaveLength(1));
    remote.processes[0]!.output("before main shutdown\r\n");
    await vi.waitFor(() => expect(journal.read(scope, terminal.terminalId).records.some((record) => record.kind === "output")).toBe(true));
    await first.close();
    expect(remote.processes[0]!.writes).toHaveLength(1);
    expect(remote.processes[0]!.terminate).not.toHaveBeenCalled();
    expect(repository.get(scope, terminal.terminalId)?.lifecycle).toBe("running");
    remote.processes[0]!.output("final output while main absent\r\n");
    remote.processes[0]!.exit();
    const second = makeService();
    second.recover(scope);
    expect(second.impact(scope)).toMatchObject({ liveCount: 0, unknownCount: 1 });
    expect(await second.reconcileRemote(scope, undefined, { recoveryOnly: true })).toEqual({ connected: 1, unavailable: 0 });
    expect(provider.recoverTerminal).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(repository.get(scope, terminal.terminalId)?.lifecycle).toBe("exited"));
    await vi.waitFor(() => expect(remote.host.snapshot().blockers).toEqual([]));
    const state = journal.read(scope, terminal.terminalId);
    expect(Buffer.from(state.checkpoint.bytes).toString()).toContain("before main shutdown");
    expect(Buffer.from(state.checkpoint.bytes).toString()).toContain("final output while main absent");
    expect(state.records.at(-1)).toMatchObject({ kind: "final_status", lifecycle: "exited", exitCode: 0 });
    expect(remote.openTerminal).toHaveBeenCalledTimes(1);
    expect(provider.openTerminal).not.toHaveBeenCalled();
    await second.close();
    unavailable = true;
    const third = makeService();
    const final = repository.get(scope, terminal.terminalId)!;
    await expect(third.delete(scope, terminal.terminalId, { mutationId: "77777777-7777-4777-8777-777777777777", expectedRevision: final.lifecycleRevision })).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(repository.get(scope, terminal.terminalId)).toBeDefined();
    await third.close();
    const fourth = makeService();
    fourth.recover(scope);
    expect(repository.get(scope, terminal.terminalId)).toBeDefined();
    unavailable = false;
    await fourth.reconcileRemote(scope);
    expect(repository.get(scope, terminal.terminalId)).toBeUndefined();
    await fourth.close();
  });

  it.each([false, true])("bounds End after stop delivery loses its carrier and recovers real exit evidence (restart=%s)", async (restart) => {
    const database = createDatabase();
    database.exec("UPDATE execution_environments SET kind = 'ssh'");
    const repository = new TerminalRepository(database);
    const scope = { tenantId: "tenant", principalId: "principal" };
    const terminal = repository.markRunning(scope, insertTerminal(repository, scope).terminalId, 1200);
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-end-carrier-"));
    directories.push(directory);
    const journal = new TerminalJournalStore({ stateDirectory: directory });
    const remote = terminalHostFixture();
    const identity = { terminalId: terminal.terminalId, incarnationId: terminal.incarnationId! };
    await remote.caller.call(terminalCreateOperation, await remote.caller.call(terminalPrepareOperation, {
      ...identity, initialCwd: "/work", rows: 24, columns: 80,
    }));
    const process = remote.processes[0]!;
    process.output("history before stop\r\n");
    process.terminate.mockImplementation(async () => undefined);
    let connected = true;
    const caller: typeof remote.caller = { call: async (definition, request) => {
      if (!connected) throw new Error("carrier_unavailable");
      if (definition.operation === "terminal.acknowledge") {
        const history = journal.read(scope, terminal.terminalId);
        expect(history.records.at(-1)).toMatchObject({ kind: "final_status", lifecycle: "exited", exitCode: 0 });
        expect(Buffer.from(history.checkpoint.bytes).toString()).toContain("final cleanup output");
      }
      const result = await remote.caller.call(definition, request);
      if (definition.operation === "terminal.stop") connected = false;
      return result;
    } };
    const provider = {
      terminationEffect: "end_process" as const, availability: () => "available" as const,
      openTerminal: vi.fn(async () => { throw new Error("must_not_launch"); }),
      attachTerminal: () => RemoteInteractiveTerminalProcess.attach(caller, identity),
      recoverTerminal: () => RemoteInteractiveTerminalProcess.attach(caller, identity),
    };
    const makeService = () => new TerminalService({ inventory: { assertWorkspaceActive: vi.fn() } as unknown as InventoryRepository, repository, journal,
      providers: new Map([[terminal.environmentId, provider]]), onTerminalSummaryChanged() {},
    });
    let service = makeService();
    const request = { mutationId: randomUUID(), expectedRevision: terminal.lifecycleRevision };
    vi.useFakeTimers();
    try {
      const ending = expect(service.end(scope, terminal.terminalId, request)).rejects.toMatchObject({
        code: "runtime_unavailable", retryable: true, message: expect.stringContaining("still pending"),
      });
      await vi.advanceTimersByTimeAsync(10_001);
      await ending;
      expect(process.terminate).toHaveBeenCalledTimes(1);
      expect(repository.get(scope, terminal.terminalId)).toMatchObject({ lifecycle: "stopping", exitCode: null, publicReason: null });
      expect(repository.getPendingDeletion(scope, terminal.terminalId)).toMatchObject({ mutationId: request.mutationId, cleanupConfirmed: false });
      expect(journal.read(scope, terminal.terminalId).records.some(record => record.kind === "final_status")).toBe(false);
      expect(remote.resources.size).toBe(1);
      if (restart) {
        await service.close();
        service = makeService();
        service.recover(scope);
        expect(repository.getPendingDeletion(scope, terminal.terminalId)).toBeUndefined();
      }
      const joinedRetry = restart ? undefined : service.end(scope, terminal.terminalId, request);
      process.output("final cleanup output\r\n");
      process.exit();
      expect(repository.get(scope, terminal.terminalId)?.lifecycle).toBe("stopping");
      connected = true;
      if (restart) {
        const reconciling = service.reconcileRemote(scope);
        await vi.advanceTimersByTimeAsync(1_000);
        await reconciling;
      }
      else await vi.advanceTimersByTimeAsync(1_000);
      if (restart) {
        // Startup retains unconfirmed End history for explicit inspection/removal.
        const final = repository.get(scope, terminal.terminalId)!;
        expect(final).toMatchObject({ lifecycle: "exited", exitCode: 0 });
        const history = journal.read(scope, terminal.terminalId);
        expect(Buffer.from(history.checkpoint.bytes).toString()).toContain("final cleanup output");
        expect(history.records.at(-1)).toMatchObject({ kind: "final_status", lifecycle: "exited", exitCode: 0 });
        await service.delete(scope, terminal.terminalId, { mutationId: randomUUID(), expectedRevision: final.lifecycleRevision });
      } else {
        await joinedRetry;
        await expect(service.end(scope, terminal.terminalId, request)).resolves.toBeUndefined();
      }
      expect(repository.get(scope, terminal.terminalId)).toBeUndefined();
      expect(remote.host.snapshot().blockers).toEqual([]);
      if (!restart) expect(remote.resources.size).toBe(0);
      expect(remote.openTerminal).toHaveBeenCalledTimes(1);
    } finally { await service.close(); vi.useRealTimers(); }
  });

  it("does not invent an exit when a persistent terminal cannot receive End, and permits a later retry", async () => {
    const repository = new TerminalRepository(createDatabase());
    const scope = { tenantId: "tenant", principalId: "principal" };
    const terminal = repository.markRunning(scope, insertTerminal(repository, scope).terminalId, 1200);
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-unreachable-"));
    directories.push(directory);
    const process = new FakePersistentPty();
    const persistent: NonNullable<InteractiveTerminalProcess["persistent"]> = {
      ownsDeviceReplies: true, start: async () => undefined, detach: async () => undefined,
      acknowledgeFinal: vi.fn(async () => undefined), forget: async () => undefined, inputHighWater: async () => 0,
    };
    Object.assign(process, { persistent });
    process.terminate.mockRejectedValue(new Error("terminal_unavailable"));
    const actor = new TerminalActor({ scope, terminal, repository, process,
      journal: new TerminalJournalStore({ stateDirectory: directory }), onFinalized() {}, onTerminalSummaryChanged() {},
    });
    await actor.ready();
    vi.useFakeTimers();
    try {
      await expect(actor.end(terminal.lifecycleRevision)).rejects.toThrow("terminal_unavailable");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(repository.get(scope, terminal.terminalId)).toMatchObject({ lifecycle: "stopping", exitCode: null, publicReason: null });
      expect(persistent.acknowledgeFinal).not.toHaveBeenCalled();
      process.terminate.mockImplementation(async () => process.exit({ disposition: "exited", exitCode: 0, signal: null, cleanupConfirmed: true }));
      await expect(actor.end(actor.terminal.lifecycleRevision)).resolves.toMatchObject({ lifecycle: "exited", exitCode: 0 });
    } finally { vi.useRealTimers(); await actor.close(); }
  });

  it("retains interrupted history only after a reachable host proves the incarnation is unknown", async () => {
    const fixture = terminalMaintenanceFixture(async () => new FakePersistentPty());
    const terminal = fixture.repository.markRunning(fixture.scope, insertTerminal(fixture.repository, fixture.scope).terminalId, 1200);
    fixture.provider.attachTerminal.mockRejectedValueOnce(Object.assign(new Error("untrusted failure"), { code: "terminal_incarnation_unknown" }));
    await fixture.service.reconcileRemote(fixture.scope);
    expect(fixture.repository.get(fixture.scope, terminal.terminalId)?.lifecycle).toBe("running");
    const replacement = terminalHostFixture();
    const missing = () => RemoteInteractiveTerminalProcess.attach(replacement.caller, { terminalId: terminal.terminalId, incarnationId: terminal.incarnationId! });
    fixture.provider.attachTerminal.mockImplementation(missing);
    fixture.provider.recoverTerminal.mockImplementation(missing);
    await fixture.service.reconcileRemote(fixture.scope);
    const final = fixture.repository.get(fixture.scope, terminal.terminalId)!;
    expect(final).toMatchObject({ lifecycle: "interrupted", exitCode: null, exitSignal: null, publicReason: "execution_host_continuity_lost" });
    expect(fixture.service.impact(fixture.scope)).toMatchObject({ liveCount: 0, unknownCount: 0 });
    const frames: TerminalServerFrame[] = [];
    await fixture.service.attach({ scope: fixture.scope, terminalId: final.terminalId, incarnationId: final.incarnationId!,
      attachmentId: randomUUID(), producerId: randomUUID(), requestedRole: "observer", restore: { kind: "checkpoint" }, emit: frame => frames.push(frame),
    });
    expect(frames.find(frame => frame.type === "terminal_status")).toMatchObject({ lifecycle: "interrupted", publicReason: "execution_host_continuity_lost" });
    await fixture.service.delete(fixture.scope, final.terminalId, { mutationId: randomUUID(), expectedRevision: final.lifecycleRevision });
    expect(fixture.repository.get(fixture.scope, final.terminalId)).toBeUndefined();
    expect(replacement.openTerminal).not.toHaveBeenCalled();
    await fixture.service.close();
  });

  it.each([false, true])("retries final handoff without separating journal and database heads (prior journal failure: %s)", async (journalFailure) => {
    const database = createDatabase();
    database.exec("UPDATE execution_environments SET kind = 'ssh'");
    const repository = new TerminalRepository(database);
    const scope = { tenantId: "tenant", principalId: "principal" };
    const terminal = repository.markRunning(scope, insertTerminal(repository, scope).terminalId, 1200);
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-final-retry-"));
    directories.push(directory);
    const journal = new TerminalJournalStore({ stateDirectory: directory });
    const remote = terminalHostFixture();
    const identity = { terminalId: terminal.terminalId, incarnationId: terminal.incarnationId! };
    await remote.caller.call(terminalCreateOperation, await remote.caller.call(terminalPrepareOperation, { ...identity, initialCwd: "/work", rows: 24, columns: 80 }));
    remote.processes[0]!.output("durable final output\r\n");
    remote.processes[0]!.exit();
    let failAck = true;
    const caller: typeof remote.caller = { call: async (definition, request) => {
      if (definition.operation === "terminal.acknowledge" && failAck) throw new SidecarOperationError("temporary_failure");
      return remote.caller.call(definition, request);
    } };
    const provider = { terminationEffect: "end_process" as const, availability: () => "available" as const,
      openTerminal: vi.fn(async () => { throw new Error("must_not_launch"); }),
      attachTerminal: () => RemoteInteractiveTerminalProcess.attach(caller, identity),
    };
    const makeService = () => new TerminalService({ inventory: { assertWorkspaceActive: vi.fn() } as unknown as InventoryRepository, repository, journal,
      providers: new Map([[terminal.environmentId, provider]]), onTerminalSummaryChanged() {},
    });
    const first = makeService();
    const append = journalFailure ? vi.spyOn(journal, "append").mockImplementationOnce(() => { throw new Error("disk_full"); }) : undefined;
    await first.reconcileRemote(scope);
    await vi.waitFor(() => expect(repository.get(scope, terminal.terminalId)?.lifecycle).toBe(journalFailure ? "failed" : "exited"));
    append?.mockRestore();
    await first.close();
    expect(remote.host.snapshot().blockers).toEqual(["unsettled_outcome"]);
    const before = repository.get(scope, terminal.terminalId)!;
    failAck = false;
    const second = makeService();
    second.recover(scope);
    await second.reconcileRemote(scope);
    await vi.waitFor(() => expect(remote.host.snapshot().blockers).toEqual([]));
    const final = repository.get(scope, terminal.terminalId)!;
    const state = journal.read(scope, terminal.terminalId);
    expect(state.headSeq).toBe(final.headSeq);
    expect(state.records.at(-1)).toMatchObject({ kind: "final_status", lifecycle: final.lifecycle });
    expect(Buffer.from(state.checkpoint.bytes).toString()).toContain("durable final output");
    if (!journalFailure) expect(final.headSeq).toBe(before.headSeq);
    const frames: TerminalServerFrame[] = [];
    await second.attach({ scope, terminalId: terminal.terminalId, incarnationId: terminal.incarnationId!, attachmentId: randomUUID(),
      producerId: randomUUID(), requestedRole: "observer", restore: { kind: "checkpoint" }, emit: frame => frames.push(frame),
    });
    expect(frames.find(frame => frame.type === "snapshot_begin")).toBeDefined();
    await second.close();
  });

  it("preserves tenant and principal authority and recovery semantics", () => {
    const database = createDatabase();
    const repository = new TerminalRepository(database);
    const scope = { tenantId: "tenant", principalId: "principal" };
    const terminal = repository.insert(scope, {
      terminalId: "11111111-1111-4111-8111-111111111111",
      threadId: "22222222-2222-4222-8222-222222222222",
      workspaceId: "33333333-3333-4333-8333-333333333333",
      environmentId: "44444444-4444-4444-8444-444444444444",
      environmentLabel: "Local",
      terminationEffect: "end_process",
      displayName: "Shell",
      shellProfile: null,
      initialCwd: "/work",
      rows: 24,
      columns: 80,
      now: 1_000,
    });
    expect(terminal.lifecycle).toBe("reserved");
    expect(
      repository.get(
        { tenantId: "tenant", principalId: "other-principal" },
        terminal.terminalId,
      ),
    ).toBeUndefined();
    expect(repository.recoverInterrupted(scope, 2_000)[0]).toMatchObject({
      lifecycle: "failed",
      publicReason: "start_not_attempted",
    });
  });

  it("publishes scoped terminal inventory invalidation after rename", () => {
    const database = createDatabase();
    const repository = new TerminalRepository(database);
    const scope = { tenantId: "tenant", principalId: "principal" };
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-rename-"));
    directories.push(directory);
    const current = repository.get(
      scope,
      insertTerminal(repository, scope).terminalId,
    )!;
    const onTerminalSummaryChanged = vi.fn();
    const service = new TerminalService({
      inventory: { assertWorkspaceActive: vi.fn() } as unknown as InventoryRepository,
      repository,
      journal: new TerminalJournalStore({ stateDirectory: directory }),
      providers: new Map(),
      onTerminalSummaryChanged,
    });

    const renamed = service.rename(scope, current.terminalId, {
      mutationId: "55555555-5555-4555-8555-555555555555",
      expectedRevision: current.lifecycleRevision,
      displayName: "Build shell",
    });

    expect(renamed.displayName).toBe("Build shell");
    expect(onTerminalSummaryChanged).toHaveBeenCalledOnce();
    expect(onTerminalSummaryChanged).toHaveBeenCalledWith(
      scope,
      current.threadId,
    );
  });

  it("interrupts every abandoned process lifecycle after a server restart", () => {
    const database = createDatabase();
    const repository = new TerminalRepository(database);
    const scope = { tenantId: "tenant", principalId: "principal" };
    const starting = insertTerminal(
      repository,
      scope,
      "11111111-1111-4111-8111-111111111111",
    );
    const running = repository.markRunning(
      scope,
      insertTerminal(
        repository,
        scope,
        "11111111-1111-4111-8111-111111111112",
      ).terminalId,
      1_200,
    );
    const stoppingBase = repository.markRunning(
      scope,
      insertTerminal(
        repository,
        scope,
        "11111111-1111-4111-8111-111111111113",
      ).terminalId,
      1_200,
    );
    const stopping = repository.markStopping(
      scope,
      stoppingBase.terminalId,
      stoppingBase.lifecycleRevision,
      1_300,
    );

    expect(repository.get(scope, starting.terminalId)?.lifecycle).toBe(
      "starting",
    );
    expect(running.lifecycle).toBe("running");
    expect(stopping.lifecycle).toBe("stopping");

    const recovered = new Map(
      repository
        .recoverInterrupted(scope, 2_000)
        .map((terminal) => [terminal.terminalId, terminal]),
    );
    for (const terminalId of [
      starting.terminalId,
      running.terminalId,
      stopping.terminalId,
    ]) {
      expect(recovered.get(terminalId)).toMatchObject({
        lifecycle: "interrupted",
        publicReason: "server_restarted",
        exitedAt: "1970-01-01T00:00:02.000Z",
        updatedAt: "1970-01-01T00:00:02.000Z",
      });
    }
  });

  it("reconciles restart history, quarantines a missing suffix, and resumes deletion", () => {
    const database = createDatabase();
    const repository = new TerminalRepository(database);
    const scope = { tenantId: "tenant", principalId: "principal" };
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-recovery-"));
    directories.push(directory);
    const journal = new TerminalJournalStore({ stateDirectory: directory });

    const retained = repository.markRunning(
      scope,
      insertTerminal(
        repository,
        scope,
        "11111111-1111-4111-8111-111111111111",
      ).terminalId,
      1_200,
    );
    journal.append(scope, retained.terminalId, {
      seq: 1,
      kind: "output",
      bytes: Buffer.from("retained"),
    });
    repository.updateHead(scope, retained.terminalId, 1, 1_250);

    const corrupt = repository.markRunning(
      scope,
      insertTerminal(
        repository,
        scope,
        "11111111-1111-4111-8111-111111111112",
      ).terminalId,
      1_200,
    );
    journal.append(scope, corrupt.terminalId, {
      seq: 1,
      kind: "output",
      bytes: Buffer.from("only retained prefix"),
    });
    repository.updateHead(scope, corrupt.terminalId, 2, 1_250);

    const deleting = repository.finalize(
      scope,
      insertTerminal(
        repository,
        scope,
        "11111111-1111-4111-8111-111111111113",
      ).terminalId,
      { lifecycle: "failed", headSeq: 0, publicReason: "start_failed", now: 1_300 },
    );
    journal.append(scope, deleting.terminalId, {
      seq: 1,
      kind: "output",
      bytes: Buffer.from("delete me"),
    });
    const deletionRequest = {
      terminalId: deleting.terminalId,
      mutationId: "55555555-5555-4555-8555-555555555555",
      expectedRevision: deleting.lifecycleRevision,
    };
    repository.prepareDeletion(scope, {
      ...deletionRequest,
      operationKind: "terminal_delete",
      request: deletionRequest,
      now: 1_400,
    });
    const scopeHash = createHash("sha256")
      .update(`${scope.tenantId}\0${scope.principalId}`)
      .digest("hex");
    const deletingDirectory = path.join(
      directory,
      "terminals",
      scopeHash,
      deleting.terminalId,
    );
    const deletionTombstone = `${deletingDirectory}.deleting`;
    renameSync(deletingDirectory, deletionTombstone);

    const service = new TerminalService({
      inventory: { assertWorkspaceActive: vi.fn() } as unknown as InventoryRepository,
      repository,
      journal,
      providers: new Map(),
      onTerminalSummaryChanged: () => undefined,
    });
    service.recover(scope);

    expect(repository.get(scope, retained.terminalId)).toMatchObject({
      lifecycle: "interrupted",
      headSeq: 1,
      publicReason: "server_restarted",
    });
    expect(repository.get(scope, corrupt.terminalId)).toMatchObject({
      lifecycle: "failed",
      headSeq: 0,
      publicReason: "history_corrupt",
    });
    expect(
      existsSync(
        path.join(
          directory,
          "terminals",
          scopeHash,
          `${corrupt.terminalId}.corrupt`,
        ),
      ),
    ).toBe(true);
    expect(repository.get(scope, deleting.terminalId)).toBeUndefined();
    expect(existsSync(deletionTombstone)).toBe(false);
    expect(journal.recover(scope, deleting.terminalId)).toEqual({
      kind: "ok",
      state: {
        checkpoint: expect.objectContaining({ seq: 0, bytes: new Uint8Array() }),
        records: [],
        headSeq: 0,
      },
    });
    expect(
      repository.prepareDeletion(scope, {
        ...deletionRequest,
        operationKind: "terminal_delete",
        request: deletionRequest,
        now: 1_600,
      }),
    ).toEqual({
      kind: "completed",
      result: { terminalId: deleting.terminalId },
    });
  });

  it("replays a scoped mutation receipt and rejects changed input", () => {
    const database = createDatabase();
    const repository = new TerminalRepository(database);
    const scope = { tenantId: "tenant", principalId: "principal" };
    let calls = 0;
    const input = {
      mutationId: "55555555-5555-4555-8555-555555555555",
      operationKind: "test",
      request: { value: 1 },
      now: 1,
      run: () => ({ value: ++calls }),
    };
    expect(repository.receipt(scope, input)).toEqual({ value: 1 });
    expect(repository.receipt(scope, input)).toEqual({ value: 1 });
    expect(calls).toBe(1);
    expect(() =>
      repository.receipt(scope, { ...input, request: { value: 2 } }),
    ).toThrow("terminal_mutation_id_conflict");
  });

  it("persists scoped deletion intent and completes it idempotently after restart", () => {
    const database = createDatabase();
    const scope = { tenantId: "tenant", principalId: "principal" };
    const repository = new TerminalRepository(database);
    const terminal = insertTerminal(repository, scope);
    const running = repository.markRunning(scope, terminal.terminalId, 1_200);
    expect(
      repository
        .summariesByThread(scope, [terminal.threadId])
        .get(terminal.threadId),
    ).toEqual({ runningCount: 1, retainedCount: 1 });
    const finalized = repository.finalize(scope, terminal.terminalId, {
      lifecycle: "exited",
      headSeq: 0,
      exitCode: 0,
      now: 1_300,
    });
    expect(running.lifecycle).toBe("running");

    const request = {
      terminalId: terminal.terminalId,
      mutationId: "55555555-5555-4555-8555-555555555555",
      expectedRevision: finalized.lifecycleRevision,
    };
    expect(
      repository.prepareDeletion(scope, {
        ...request,
        operationKind: "terminal_delete",
        request,
        now: 1_400,
      }),
    ).toMatchObject({ kind: "prepared" });
    expect(repository.listPendingDeletions(scope)).toHaveLength(1);
    expect(() =>
      repository.completeDeletion(
        { tenantId: "tenant", principalId: "other-principal" },
        terminal.terminalId,
        1_450,
      ),
    ).toThrow("terminal_deletion_not_prepared");
    expect(repository.get(scope, terminal.terminalId)).toBeDefined();
    expect(
      repository.listPendingDeletions({
        tenantId: "tenant",
        principalId: "other-principal",
      }),
    ).toEqual([]);
    expect(
      repository
        .summariesByThread(scope, [terminal.threadId])
        .get(terminal.threadId),
    ).toEqual({
      runningCount: 0,
      retainedCount: 0,
    });

    const restarted = new TerminalRepository(database);
    expect(
      restarted.completeDeletion(scope, terminal.terminalId, 1_500),
    ).toEqual({
      terminalId: terminal.terminalId,
    });
    expect(restarted.get(scope, terminal.terminalId)).toBeUndefined();
    expect(
      restarted.prepareDeletion(scope, {
        ...request,
        operationKind: "terminal_delete",
        request,
        now: 1_600,
      }),
    ).toEqual({
      kind: "completed",
      result: { terminalId: terminal.terminalId },
    });
  });

  it("reconciles verified journal authority and fails closed on corruption", () => {
    const database = createDatabase();
    const repository = new TerminalRepository(database);
    const scope = { tenantId: "tenant", principalId: "principal" };
    const terminal = insertTerminal(repository, scope);
    repository.markRunning(scope, terminal.terminalId, 1_200);
    const reconciled = repository.reconcileJournal(scope, terminal.terminalId, {
      headSeq: 3,
      historyFloorSeq: 0,
      rows: 40,
      columns: 120,
      finalStatus: {
        lifecycle: "exited",
        exitCode: 7,
        exitSignal: null,
        publicReason: "done",
      },
      now: 1_500,
    });
    expect(reconciled).toMatchObject({
      lifecycle: "exited",
      headSeq: 3,
      rows: 40,
      columns: 120,
      exitCode: 7,
      publicReason: "done",
    });
    expect(
      repository.markJournalCorrupt(scope, terminal.terminalId, 1_600),
    ).toMatchObject({
      lifecycle: "failed",
      headSeq: 0,
      rows: 24,
      columns: 80,
      publicReason: "history_corrupt",
    });
  });

  it("prevents deletion of thread and workspace rows referenced by retained terminals", () => {
    const database = createDatabase();
    const repository = new TerminalRepository(database);
    insertTerminal(repository, { tenantId: "tenant", principalId: "principal" });

    expect(() =>
      database
        .prepare(
          `DELETE FROM application_threads
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(
          "tenant",
          "principal",
          "22222222-2222-4222-8222-222222222222",
        ),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      database
        .prepare(
          `DELETE FROM workspaces
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(
          "tenant",
          "principal",
          "33333333-3333-4333-8333-333333333333",
        ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it.each(["end_process", "disconnect_transport"] as const)("ends a live %s terminal before receipted resource and history deletion", async (terminationEffect) => {
    const database = createDatabase();
    const repository = new TerminalRepository(database);
    const scope = { tenantId: "tenant", principalId: "principal" };
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-end-"));
    directories.push(directory);
    const journal = new TerminalJournalStore({ stateDirectory: directory });
    const process = new ControlledProcess();
    const inventory = {
    assertWorkspaceActive: vi.fn(),
      getThread: vi.fn(() => ({
        thread: {
          workspaceId: "33333333-3333-4333-8333-333333333333",
          environmentId: "44444444-4444-4444-8444-444444444444",
        },
      })),
      getWorkspace: vi.fn(() => ({
        id: "33333333-3333-4333-8333-333333333333",
        environmentId: "44444444-4444-4444-8444-444444444444",
        availability: "available",
        canonicalPath: "/work",
      })),
      getEnvironment: vi.fn(() => ({
        id: "44444444-4444-4444-8444-444444444444",
        label: "Local",
      })),
    } as unknown as InventoryRepository;
    const provider = {
      terminationEffect,
      availability: () => "available" as const,
      openTerminal: vi.fn(async () => process),
    };
    const service = new TerminalService({
      inventory,
      repository,
      journal,
      providers: new Map([["44444444-4444-4444-8444-444444444444", provider]]),
      onTerminalSummaryChanged: () => undefined,
    });
    const mutationId = "55555555-5555-4555-8555-555555555555";
    const terminal = await service.create(
      scope,
      "22222222-2222-4222-8222-222222222222",
      {
        mutationId: "77777777-7777-4777-8777-777777777777",
        displayName: "Shell",
        rows: 24,
        columns: 80,
      },
    );
    process.output(Buffer.from("visible until end is confirmed"));
    await vi.waitFor(() => expect(repository.get(scope, terminal.terminalId)?.headSeq).toBe(1));

    let settled = false;
    const ending = service.end(scope, terminal.terminalId, {
      mutationId,
      expectedRevision: terminal.lifecycleRevision,
    }).then(() => { settled = true; });
    const joinedRetry = service.end(scope, terminal.terminalId, {
      mutationId,
      expectedRevision: terminal.lifecycleRevision,
    });
    await vi.waitFor(() => expect(process.terminations).toEqual(["hangup"]));
    expect(settled).toBe(false);
    expect(repository.get(scope, terminal.terminalId)?.lifecycle).toBe("stopping");
    expect(journal.read(scope, terminal.terminalId).records).toHaveLength(1);

    process.exit({
      disposition: "exited",
      exitCode: 0,
      signal: null,
      cleanupConfirmed: terminationEffect === "end_process",
      transportClosed: terminationEffect === "disconnect_transport",
    });
    await Promise.all([ending, joinedRetry]);
    expect(repository.get(scope, terminal.terminalId)).toBeUndefined();
    expect(journal.read(scope, terminal.terminalId).records).toEqual([]);
    await expect(service.end(scope, terminal.terminalId, {
      mutationId,
      expectedRevision: terminal.lifecycleRevision,
    })).resolves.toBeUndefined();
    await expect(service.end(scope, terminal.terminalId, {
      mutationId,
      expectedRevision: terminal.lifecycleRevision + 1,
    })).rejects.toMatchObject({ code: "conflict" });

    const uncertainProcess = new ControlledProcess();
    provider.openTerminal.mockResolvedValueOnce(uncertainProcess);
    const uncertain = await service.create(
      scope,
      "22222222-2222-4222-8222-222222222222",
      {
        mutationId: "88888888-8888-4888-8888-888888888888",
        displayName: "Uncertain cleanup",
        rows: 24,
        columns: 80,
      },
    );
    uncertainProcess.output(Buffer.from("evidence to retain"));
    await vi.waitFor(() =>
      expect(repository.get(scope, uncertain.terminalId)?.headSeq).toBe(1),
    );
    const uncertainEnd = service.end(scope, uncertain.terminalId, {
      mutationId: "99999999-9999-4999-8999-999999999999",
      expectedRevision: uncertain.lifecycleRevision,
    });
    await vi.waitFor(() =>
      expect(uncertainProcess.terminations).toEqual(["hangup"]),
    );
    uncertainProcess.exit({
      disposition: "interrupted",
      exitCode: null,
      signal: null,
      diagnosticCode: "ssh_terminal_cleanup_unconfirmed",
      transportClosed: terminationEffect === "end_process",
    });
    await expect(uncertainEnd).rejects.toMatchObject({
      code: "runtime_unavailable",
      retryable: true,
    });
    expect(repository.get(scope, uncertain.terminalId)).toMatchObject({
      lifecycle: "interrupted",
      publicReason: "ssh_terminal_cleanup_unconfirmed",
    });
    expect(journal.read(scope, uncertain.terminalId).records).toHaveLength(2);
    const uncertainRetained = repository.get(scope, uncertain.terminalId)!;
    await expect(service.end(scope, uncertain.terminalId, {
      mutationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      expectedRevision: uncertainRetained.lifecycleRevision,
    })).rejects.toMatchObject({ code: "invalid_transition" });

    const independentProcess = new ControlledProcess();
    provider.openTerminal.mockResolvedValueOnce(independentProcess);
    const independent = await service.create(
      scope,
      "22222222-2222-4222-8222-222222222222",
      {
        mutationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        displayName: "Independent exit",
        rows: 24,
        columns: 80,
      },
    );
    independentProcess.exit({
      disposition: "exited",
      exitCode: 0,
      signal: null,
    });
    await expect(service.end(scope, independent.terminalId, {
      mutationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      expectedRevision: independent.lifecycleRevision,
    })).rejects.toMatchObject({ code: "invalid_transition" });
    expect(repository.get(scope, independent.terminalId)).toMatchObject({
      lifecycle: "exited",
      exitCode: 0,
    });

    const journalFailureProcess = new ControlledProcess();
    provider.openTerminal.mockResolvedValueOnce(journalFailureProcess);
    const journalFailure = await service.create(
      scope,
      "22222222-2222-4222-8222-222222222222",
      {
        mutationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        displayName: "Journal deletion retry",
        rows: 24,
        columns: 80,
      },
    );
    const journalEndRequest = {
      mutationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      expectedRevision: journalFailure.lifecycleRevision,
    };
    const journalViewerFrames: TerminalServerFrame[] = [];
    await service.attach({
      scope,
      terminalId: journalFailure.terminalId,
      incarnationId: journalFailure.incarnationId!,
      attachmentId: "13131313-1313-4313-8313-131313131313",
      producerId: "14141414-1414-4414-8414-141414141414",
      requestedRole: "observer",
      restore: { kind: "checkpoint" },
      emit: (frame) => journalViewerFrames.push(frame),
    });
    const journalDelete = vi.spyOn(journal, "delete").mockImplementationOnce(() => {
      throw new Error("journal_delete_failed");
    });
    const failedJournalEnd = service.end(
      scope,
      journalFailure.terminalId,
      journalEndRequest,
    );
    await vi.waitFor(() =>
      expect(journalFailureProcess.terminations).toEqual(["hangup"]),
    );
    journalFailureProcess.exit({
      disposition: "exited",
      exitCode: 0,
      signal: null,
      cleanupConfirmed: terminationEffect === "end_process",
      transportClosed: terminationEffect === "disconnect_transport",
    });
    await expect(failedJournalEnd).rejects.toMatchObject({
      code: "invalid_transition",
    });
    expect(repository.getPendingDeletion(scope, journalFailure.terminalId)).toMatchObject({
      cleanupConfirmed: terminationEffect === "end_process",
      transportClosed: terminationEffect === "disconnect_transport",
      mutationId: journalEndRequest.mutationId,
    });
    expect(journalViewerFrames.some((frame) => frame.type === "terminal_removed")).toBe(false);
    journalDelete.mockRestore();
    await expect(service.end(
      scope,
      journalFailure.terminalId,
      journalEndRequest,
    )).resolves.toBeUndefined();
    expect(repository.get(scope, journalFailure.terminalId)).toBeUndefined();
    expect(journalViewerFrames.filter((frame) => frame.type === "terminal_removed")).toHaveLength(1);

    const databaseFailureProcess = new ControlledProcess();
    provider.openTerminal.mockResolvedValueOnce(databaseFailureProcess);
    const databaseFailure = await service.create(
      scope,
      "22222222-2222-4222-8222-222222222222",
      {
        mutationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        displayName: "Database deletion retry",
        rows: 24,
        columns: 80,
      },
    );
    const databaseEndRequest = {
      mutationId: "12121212-1212-4212-8212-121212121212",
      expectedRevision: databaseFailure.lifecycleRevision,
    };
    const databaseViewerFrames: TerminalServerFrame[] = [];
    await service.attach({
      scope,
      terminalId: databaseFailure.terminalId,
      incarnationId: databaseFailure.incarnationId!,
      attachmentId: "15151515-1515-4515-8515-151515151515",
      producerId: "16161616-1616-4616-8616-161616161616",
      requestedRole: "observer",
      restore: { kind: "checkpoint" },
      emit: (frame) => databaseViewerFrames.push(frame),
    });
    const completeDeletion = vi
      .spyOn(repository, "completeDeletion")
      .mockImplementationOnce(() => {
        throw new Error("database_delete_failed");
      });
    const failedDatabaseEnd = service.end(
      scope,
      databaseFailure.terminalId,
      databaseEndRequest,
    );
    await vi.waitFor(() =>
      expect(databaseFailureProcess.terminations).toEqual(["hangup"]),
    );
    databaseFailureProcess.exit({
      disposition: "exited",
      exitCode: 0,
      signal: null,
      cleanupConfirmed: terminationEffect === "end_process",
      transportClosed: terminationEffect === "disconnect_transport",
    });
    await expect(failedDatabaseEnd).rejects.toMatchObject({
      code: "invalid_transition",
    });
    expect(repository.getPendingDeletion(scope, databaseFailure.terminalId)).toMatchObject({
      cleanupConfirmed: terminationEffect === "end_process",
      transportClosed: terminationEffect === "disconnect_transport",
      mutationId: databaseEndRequest.mutationId,
    });
    expect(databaseViewerFrames.some((frame) => frame.type === "terminal_removed")).toBe(false);
    completeDeletion.mockRestore();
    await expect(service.end(
      scope,
      databaseFailure.terminalId,
      databaseEndRequest,
    )).resolves.toBeUndefined();
    expect(repository.get(scope, databaseFailure.terminalId)).toBeUndefined();
    expect(databaseViewerFrames.filter((frame) => frame.type === "terminal_removed")).toHaveLength(1);
  });

  it.each([
    ["end_process", true, false, true],
    ["end_process", false, true, false],
    ["disconnect_transport", false, true, true],
    ["disconnect_transport", true, false, false],
    ["disconnect_transport", false, false, false],
  ] as const)("matches durable %s deletion evidence cleanup=%s transport=%s", (effect, cleanup, transport, ready) => {
    const repository = new TerminalRepository(createDatabase());
    const scope = { tenantId: "tenant", principalId: "principal" };
    const terminal = insertTerminal(repository, scope, undefined, effect);
    const running = repository.markRunning(scope, terminal.terminalId, 1_200);
    prepareEnd(repository, scope, running);
    repository.finalize(scope, terminal.terminalId, {
      lifecycle: "interrupted", headSeq: 0, now: 1_400,
      confirmPendingEndCleanup: cleanup,
      confirmPendingTransportClosed: transport,
    });
    expect(repository.getPendingDeletion(scope, terminal.terminalId)).toMatchObject({
      terminationEffect: effect, cleanupConfirmed: cleanup, transportClosed: transport,
    });
    expect(() => repository.completeDeletion({ ...scope, principalId: "other-principal" }, terminal.terminalId, 1_500)).toThrow("terminal_deletion_not_prepared");
    if (ready) expect(repository.completeDeletion(scope, terminal.terminalId, 1_500)).toEqual({ terminalId: terminal.terminalId });
    else expect(() => repository.completeDeletion(scope, terminal.terminalId, 1_500)).toThrow("terminal_cleanup_not_confirmed");
  });

  it.each([
    ["disconnect_transport", false, true, true],
    ["disconnect_transport", true, false, false],
    ["end_process", false, true, false],
  ] as const)("recovers %s only with matching cleanup=%s transport=%s evidence", (effect, cleanup, transport, removed) => {
    const repository = new TerminalRepository(createDatabase());
    const scope = { tenantId: "tenant", principalId: "principal" };
    const terminal = insertTerminal(repository, scope, undefined, effect);
    prepareEnd(repository, scope, repository.markRunning(scope, terminal.terminalId, 1_200));
    repository.finalize(scope, terminal.terminalId, {
      lifecycle: "interrupted", headSeq: 0, now: 1_400,
      confirmPendingEndCleanup: cleanup, confirmPendingTransportClosed: transport,
    });
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-evidence-recovery-"));
    directories.push(directory);
    new TerminalService({
      inventory: { assertWorkspaceActive: vi.fn() } as unknown as InventoryRepository, repository,
      journal: new TerminalJournalStore({ stateDirectory: directory }),
      providers: new Map(), onTerminalSummaryChanged: () => undefined,
    }).recover(scope);
    expect(repository.get(scope, terminal.terminalId) === undefined).toBe(removed);
    expect(repository.listPendingDeletions(scope)).toEqual([]);
  });

  it("recovers End crash windows without deleting before cleanup confirmation", () => {
    const database = createDatabase();
    const repository = new TerminalRepository(database);
    const scope = { tenantId: "tenant", principalId: "principal" };
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-end-recovery-"));
    directories.push(directory);
    const journal = new TerminalJournalStore({ stateDirectory: directory });

    const beforeSignal = repository.markRunning(
      scope,
      insertTerminal(repository, scope, "11111111-1111-4111-8111-111111111121").terminalId,
      1_200,
    );
    prepareEnd(repository, scope, beforeSignal);

    const whileWaiting = repository.markRunning(
      scope,
      insertTerminal(repository, scope, "11111111-1111-4111-8111-111111111122").terminalId,
      1_200,
    );
    prepareEnd(repository, scope, whileWaiting);
    const waitingPrepared = repository.get(scope, whileWaiting.terminalId)!;
    repository.markStopping(
      scope,
      whileWaiting.terminalId,
      waitingPrepared.lifecycleRevision,
      1_300,
    );

    const confirmed = repository.markRunning(
      scope,
      insertTerminal(repository, scope, "11111111-1111-4111-8111-111111111123").terminalId,
      1_200,
    );
    prepareEnd(repository, scope, confirmed);
    const confirmedPrepared = repository.get(scope, confirmed.terminalId)!;
    repository.markStopping(
      scope,
      confirmed.terminalId,
      confirmedPrepared.lifecycleRevision,
      1_300,
    );
    repository.finalize(scope, confirmed.terminalId, {
      lifecycle: "exited",
      headSeq: 0,
      exitCode: 0,
      confirmPendingEndCleanup: true,
      now: 1_400,
    });

    const phases = new Map(
      repository.listPendingDeletions(scope).map((pending) => [
        pending.terminalId,
        pending.cleanupConfirmed,
      ]),
    );
    expect(phases.get(beforeSignal.terminalId)).toBe(false);
    expect(phases.get(whileWaiting.terminalId)).toBe(false);
    expect(phases.get(confirmed.terminalId)).toBe(true);

    new TerminalService({
      inventory: { assertWorkspaceActive: vi.fn() } as unknown as InventoryRepository,
      repository,
      journal,
      providers: new Map(),
      onTerminalSummaryChanged: () => undefined,
    }).recover(scope);

    expect(repository.get(scope, beforeSignal.terminalId)).toMatchObject({
      lifecycle: "interrupted",
      publicReason: "server_restarted",
    });
    expect(repository.get(scope, whileWaiting.terminalId)).toMatchObject({
      lifecycle: "interrupted",
      publicReason: "server_restarted",
    });
    expect(repository.get(scope, confirmed.terminalId)).toBeUndefined();
    expect(repository.listPendingDeletions(scope)).toEqual([]);
  });
});

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function terminalMaintenanceFixture(open: () => Promise<InteractiveTerminalProcess>) {
  const repository = new TerminalRepository(createDatabase());
  const scope = { tenantId: "tenant", principalId: "principal" };
  const environmentId = "44444444-4444-4444-8444-444444444444";
  const workspaceId = "33333333-3333-4333-8333-333333333333";
  const threadId = "22222222-2222-4222-8222-222222222222";
  const assertScope = (candidate: typeof scope) => {
    if (candidate.tenantId !== scope.tenantId || candidate.principalId !== scope.principalId) throw new Error("not_found");
  };
  const inventory = {
    assertWorkspaceActive: vi.fn(),
    getThread(candidate: typeof scope) { assertScope(candidate); return { thread: { workspaceId, environmentId } }; },
    getWorkspace(candidate: typeof scope) { assertScope(candidate); return { id: workspaceId, environmentId, availability: "available", canonicalPath: "/work" }; },
    getEnvironment(candidate: typeof scope, id: string) { assertScope(candidate); if (id !== environmentId) throw new Error("not_found"); return { id, label: "Remote" }; },
  } as unknown as InventoryRepository;
  const provider = { terminationEffect: "end_process" as const, availability: () => "available" as const,
    openTerminal: vi.fn(open),
    attachTerminal: vi.fn(async (): Promise<InteractiveTerminalProcess> => { throw new Error("not_available"); }),
    recoverTerminal: vi.fn(async (): Promise<InteractiveTerminalProcess> => { throw new Error("not_available"); }),
  };
  const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-terminal-maintenance-"));
  directories.push(directory);
  const service = new TerminalService({ repository, inventory, journal: new TerminalJournalStore({ stateDirectory: directory }),
    providers: new Map([[environmentId, provider]]), onTerminalSummaryChanged() {},
  });
  return { scope, environmentId, workspaceId, inventory, repository, provider, service,
    create: () => service.create(scope, threadId, { mutationId: randomUUID(), displayName: "Shell", rows: 24, columns: 80 }),
  };
}

function prepareEnd(
  repository: TerminalRepository,
  scope: { tenantId: string; principalId: string },
  terminal: { terminalId: string; lifecycleRevision: number },
): void {
  const mutationId = terminal.terminalId;
  repository.prepareDeletion(scope, {
    terminalId: terminal.terminalId,
    expectedRevision: terminal.lifecycleRevision,
    mutationId,
    operationKind: "terminal_end",
    request: {
      terminalId: terminal.terminalId,
      mutationId,
      expectedRevision: terminal.lifecycleRevision,
    },
    now: 1_250,
  });
}

class ControlledProcess implements InteractiveTerminalProcess {
  readonly terminations: Array<"hangup" | "terminate" | "kill"> = [];
  readonly #outputListeners = new Set<(bytes: Uint8Array) => void>();
  readonly #exitListeners = new Set<(exit: InteractiveTerminalExit) => void>();
  pauseOutput(): void {}
  resumeOutput(): void {}
  async write() { return { outcome: "sent" as const }; }
  async resize() {}
  async terminate(signal: "hangup" | "terminate" | "kill") {
    this.terminations.push(signal);
  }
  onOutput(listener: (bytes: Uint8Array) => void) {
    this.#outputListeners.add(listener);
    return () => this.#outputListeners.delete(listener);
  }
  onExit(listener: (exit: InteractiveTerminalExit) => void) {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }
  output(bytes: Uint8Array) {
    for (const listener of this.#outputListeners) listener(bytes);
  }
  exit(exit: InteractiveTerminalExit) {
    for (const listener of this.#exitListeners) listener(exit);
  }
}

function insertTerminal(
  repository: TerminalRepository,
  scope: { tenantId: string; principalId: string },
  terminalId = "11111111-1111-4111-8111-111111111111",
  terminationEffect: "end_process" | "disconnect_transport" = "end_process",
) {
  const terminal = repository.insert(scope, {
    terminalId,
    threadId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    environmentId: "44444444-4444-4444-8444-444444444444",
    environmentLabel: "Local",
    terminationEffect,
    displayName: "Shell",
    shellProfile: null,
    initialCwd: "/work",
    rows: 24,
    columns: 80,
    now: 1_000,
  });
  repository.beginStart(
    scope,
    terminal.terminalId,
    "66666666-6666-4666-8666-666666666666",
    1_100,
  );
  return terminal;
}

function createDatabase(): Database.Database {
  const database = new Database(":memory:");
  databases.push(database);
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE tenants(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE principals(
      tenant_id TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY(tenant_id, id),
      FOREIGN KEY(tenant_id) REFERENCES tenants(id)
    ) STRICT;
    CREATE TABLE execution_environments(
      kind TEXT NOT NULL DEFAULT 'local',
      tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY(tenant_id, id),
      UNIQUE(tenant_id, owner_principal_id, id),
      FOREIGN KEY(tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id)
    ) STRICT;
    CREATE TABLE workspaces(
      tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL,
      environment_id TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY(tenant_id, id),
      UNIQUE(tenant_id, owner_principal_id, environment_id, id),
      FOREIGN KEY(tenant_id, owner_principal_id, environment_id)
        REFERENCES execution_environments(tenant_id, owner_principal_id, id)
    ) STRICT;
    CREATE TABLE application_threads(
      tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL,
      id TEXT NOT NULL, environment_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      PRIMARY KEY(tenant_id, id),
      UNIQUE(tenant_id, owner_principal_id, id),
      FOREIGN KEY(tenant_id, owner_principal_id, environment_id, workspace_id)
        REFERENCES workspaces(tenant_id, owner_principal_id, environment_id, id)
    ) STRICT;
    INSERT INTO tenants VALUES ('tenant');
    INSERT INTO principals VALUES ('tenant', 'principal');
    INSERT INTO principals VALUES ('tenant', 'other-principal');
    INSERT INTO execution_environments(tenant_id, owner_principal_id, id) VALUES (
      'tenant', 'principal', '44444444-4444-4444-8444-444444444444'
    );
    INSERT INTO workspaces VALUES (
      'tenant', 'principal', '44444444-4444-4444-8444-444444444444',
      '33333333-3333-4333-8333-333333333333'
    );
    INSERT INTO application_threads VALUES (
      'tenant', 'principal', '22222222-2222-4222-8222-222222222222',
      '44444444-4444-4444-8444-444444444444',
      '33333333-3333-4333-8333-333333333333'
    );
  `);
  database.exec(terminalResourcesMigration.sql);
  database.exec(terminalEndCleanupPhaseMigration.sql);
  database.exec(terminalTerminationEffectMigration.sql);
  return database;
}
