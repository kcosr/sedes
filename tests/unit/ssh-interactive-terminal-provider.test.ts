import { interactiveTerminalV2Operations } from "../../src/internal/sidecar-protocol/interactive-terminal-v2.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SidecarOperationError } from "../../src/internal/sidecar-protocol/operation-registry.js";
import { SidecarProtocolDeliveryError } from "../../src/internal/sidecar-protocol/contracts.js";
import type { InteractiveTerminalExit } from "../../src/server/execution/interactive-terminal.js";
import { SshInteractiveTerminalProvider } from "../../src/server/execution/ssh-interactive-terminal-provider.js";
import type { SidecarRuntimeOwner } from "../../src/server/sidecar/sidecar-runtime.js";
import type { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";
import { terminalHostFixture, terminalTestScope as scope } from "../helpers/persistent-terminal-fixture.js";

describe("SshInteractiveTerminalProvider", () => {
  it("requires negotiated terminal support for availability and denies missing-capability effects", async () => {
    const fixture = createFixture({ terminalSupported: false });
    expect(fixture.provider.availability(scope, "remote")).toBe("unavailable");
    await expect(fixture.provider.openTerminal(openRequest())).rejects.toThrow("sidecar_unavailable");
    expect(fixture.host.openTerminal).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledOnce();
    await expect(fixture.provider.recoverTerminal(openRequest())).rejects.toThrow("sidecar_unavailable");
    expect(fixture.releaseRecovery).toHaveBeenCalledOnce();
    fixture.setTerminalSupported(true);
    expect(fixture.provider.availability(scope, "remote")).toBe("available");
    fixture.disconnect();
    expect(fixture.provider.availability(scope, "remote")).toBe("unavailable");
  });

  it("keeps disabled terminals unavailable for ordinary work but recovers retained history under a scoped temporary grant", async () => {
    const fixture = createFixture({ enabled: false });
    const retained = await fixture.host.create();
    const request = { ...retained.request, scope, environmentId: "remote" };
    expect(fixture.provider.availability(scope, "remote")).toBe("unavailable");
    await expect(fixture.provider.openTerminal(request)).rejects.toThrow("sidecar_unavailable");
    await expect(fixture.provider.attachTerminal(request)).rejects.toThrow("sidecar_unavailable");
    expect(fixture.acquireOperation).not.toHaveBeenCalled();
    expect(fixture.host.openTerminal).toHaveBeenCalledTimes(1);
    retained.process.output("final output retained after disable\r\n");
    retained.process.exit();
    fixture.setRevision(4);
    await expect(fixture.provider.recoverTerminal({ ...request, scope: { ...scope, tenantId: "other" } })).rejects.toThrow("sidecar_unavailable");
    await expect(fixture.provider.recoverTerminal({ ...request, scope: { ...scope, principalId: "other" } })).rejects.toThrow("sidecar_unavailable");
    await expect(fixture.provider.recoverTerminal({ ...request, environmentId: "other" })).rejects.toThrow("sidecar_unavailable");
    expect(fixture.acquireRecovery).not.toHaveBeenCalled();
    const remote = await fixture.provider.recoverTerminal(request);
    expect(fixture.acquireRecovery).toHaveBeenCalledWith(scope, "remote", expect.any(AbortSignal), [{ capabilityId: "interactive_terminal", majorVersion: 2 }]);
    const restored: string[] = [];
    await remote.persistent!.start({ restore: async ({ bytes }) => { restored.push(Buffer.from(bytes).toString()); }, resize: async () => undefined, unavailable() {} });
    expect(restored.join("")).toContain("final output retained after disable");
    await remote.persistent!.acknowledgeFinal();
    expect(fixture.host.host.snapshot().blockers).toEqual([]);
    await remote.persistent!.detach();
    expect(fixture.releaseRecovery).toHaveBeenCalledTimes(1);
    expect(fixture.acquireOperation).not.toHaveBeenCalled();
  });

  it("uses the shared sidecar for creation and reattachment without another SSH PTY", async () => {
    const fixture = createFixture();
    const request = openRequest();
    const remote = await fixture.provider.openTerminal(request);
    const restored: string[] = [];
    const output: string[] = [];
    remote.onOutput((bytes) => output.push(Buffer.from(bytes).toString()));
    await remote.persistent!.start({
      restore: async ({ bytes }) => { restored.push(Buffer.from(bytes).toString()); },
      resize: async () => undefined, unavailable: () => undefined,
    });
    fixture.host.processes[0]!.output("before detach\r\n");
    await vi.waitFor(() => expect(output.join("")).toContain("before detach"));
    await remote.persistent!.detach();
    fixture.host.processes[0]!.output("no main process\r\n");
    expect(fixture.host.processes[0]!.terminate).not.toHaveBeenCalled();
    const resumed = await fixture.provider.attachTerminal(request);
    await resumed.persistent!.start({
      restore: async ({ bytes }) => { restored.push(Buffer.from(bytes).toString()); },
      resize: async () => undefined, unavailable: () => undefined,
    });
    expect(restored.at(-1)).toContain("before detach");
    expect(restored.at(-1)).toContain("no main process");
    expect(fixture.host.openTerminal).toHaveBeenCalledTimes(1);
    await resumed.persistent!.detach();
    await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledTimes(fixture.acquireOperation.mock.calls.length));
    fixture.host.processes[0]!.exit();
  });

  it("keeps delivering TUI redraws and input across keyboard-sized resizes without restoring history", async () => {
    const fixture = createFixture();
    const remote = await fixture.provider.openTerminal(openRequest());
    const restore = vi.fn(async () => undefined);
    const unavailable = vi.fn();
    const events: string[] = [];
    const pty = fixture.host.processes[0]!;
    remote.onOutput(bytes => events.push(Buffer.from(bytes).toString()));
    await remote.persistent!.start({
      restore, unavailable,
      resize: async ({ rows }) => { events.push(`resize:${rows}`); },
    });
    pty.resize.mockImplementation(async ({ rows }: { rows: number }) => {
      pty.output(`\u001b[H\u001b[2J\u001b[3JTUI:${rows}`);
    });
    try {
      for (const rows of [12, 24, 12, 24]) {
        await remote.resize({ rows, columns: 80 });
        await vi.waitFor(() => expect(events.at(-1)).toBe(`\u001b[H\u001b[2J\u001b[3JTUI:${rows}`));
        expect(events.at(-2)).toBe(`resize:${rows}`);
        expect(await remote.write(Buffer.from("typed"))).toEqual({ outcome: "sent" });
      }
      expect(restore).toHaveBeenCalledOnce();
      expect(unavailable).not.toHaveBeenCalled();
      expect(pty.writes.map(bytes => Buffer.from(bytes).toString())).toEqual(Array(4).fill("typed"));
    } finally {
      await remote.persistent!.detach();
      pty.exit();
    }
  });

  it("does not invent an exit on carrier loss, resynchronizes screen state, and does not replay an uncertain input", async () => {
    const fixture = createFixture();
    const request = openRequest();
    const remote = await fixture.provider.openTerminal(request);
    const restored: string[] = [];
    const exits: InteractiveTerminalExit[] = [];
    const unavailable = vi.fn();
    remote.onExit((exit) => exits.push(exit));
    await remote.persistent!.start({ restore: async ({ bytes }) => { restored.push(Buffer.from(bytes).toString()); }, resize: async () => undefined, unavailable });
    fixture.disconnect();
    fixture.host.processes[0]!.output("offline output\r\n");
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalled());
    expect(await remote.write(Buffer.from("do not replay"))).toMatchObject({ outcome: "not_sent" });
    expect(exits).toEqual([]);
    expect(fixture.host.processes[0]!.terminate).not.toHaveBeenCalled();
    fixture.reconnect();
    await vi.waitFor(() => expect(restored.at(-1)).toContain("offline output"), { timeout: 2500 });
    expect(fixture.host.processes[0]!.writes).toHaveLength(0);
    expect(await remote.write(Buffer.from("new input"))).toEqual({ outcome: "sent" });
    expect(fixture.host.processes[0]!.writes.map((bytes) => Buffer.from(bytes).toString())).toEqual(["new input"]);
    await remote.persistent!.detach();
    fixture.host.processes[0]!.exit();
  });

  it("reports lost continuity when a reachable replacement host no longer owns the exact incarnation", async () => {
    const fixture = createFixture();
    const remote = await fixture.provider.openTerminal(openRequest());
    const exits: InteractiveTerminalExit[] = [];
    remote.onExit(exit => exits.push(exit));
    await remote.persistent!.start({ restore: async () => undefined, resize: async () => undefined, unavailable() {} });
    fixture.loseIncarnation();
    await vi.waitFor(() => expect(exits).toEqual([{ disposition: "interrupted", exitCode: null, signal: null,
      diagnosticCode: "execution_host_continuity_lost", cleanupConfirmed: false }]));
    expect(fixture.host.processes[0]!.terminate).not.toHaveBeenCalled();
    await remote.persistent!.detach();
    fixture.host.processes[0]!.exit();
  });

  it("keeps viewers attached after an admission rejection and reuses the unconsumed control sequence", async () => {
    const fixture = createFixture();
    const remote = await fixture.provider.openTerminal(openRequest());
    const unavailable = vi.fn();
    await remote.persistent!.start({ restore: async () => undefined, resize: async () => undefined, unavailable });
    fixture.rejectControl("sidecar_configuration_pending");
    expect(await remote.write(Buffer.from("rejected"))).toEqual({ outcome: "not_sent", diagnosticCode: "sidecar_configuration_pending" });
    fixture.rejectControl("sidecar_configuration_pending");
    await expect(remote.resize({ rows: 30, columns: 90 })).rejects.toThrow("sidecar_configuration_pending");
    expect(unavailable).not.toHaveBeenCalled();
    expect(await remote.write(Buffer.from("accepted"))).toEqual({ outcome: "sent" });
    expect(fixture.host.processes[0]!.writes.map(bytes => Buffer.from(bytes).toString())).toEqual(["accepted"]);
    await remote.persistent!.detach();
    fixture.host.processes[0]!.exit();
  });

  it.each(["input", "resize"] as const)("reattaches and resets control sequencing after a %s sequence gap", async (operation) => {
    const fixture = createFixture();
    const remote = await fixture.provider.openTerminal(openRequest());
    const unavailable = vi.fn();
    const restore = vi.fn(async () => undefined);
    await remote.persistent!.start({ restore, resize: async () => undefined, unavailable });
    fixture.rejectControl("terminal_control_sequence_gap");
    if (operation === "input") {
      expect(await remote.write(Buffer.from("rejected"))).toEqual({ outcome: "not_sent", diagnosticCode: "terminal_control_sequence_gap" });
    } else {
      await expect(remote.resize({ rows: 30, columns: 90 })).rejects.toThrow("terminal_control_sequence_gap");
    }
    expect(unavailable).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
    expect(await remote.write(Buffer.from("accepted"))).toEqual({ outcome: "sent" });
    await expect(remote.resize({ rows: 31, columns: 91 })).resolves.toBeUndefined();
    expect(fixture.host.processes[0]!.writes.map(bytes => Buffer.from(bytes).toString())).toEqual(["accepted"]);
    expect(fixture.host.processes[0]!.resize).toHaveBeenLastCalledWith(expect.objectContaining({ rows: 31, columns: 91, controlSeq: 2 }));
    expect(fixture.host.openTerminal).toHaveBeenCalledTimes(1);
    await remote.persistent!.detach();
    fixture.host.processes[0]!.exit();
  });

  it("preserves uncertain delivery when a control fails after host admission", async () => {
    const fixture = createFixture();
    const remote = await fixture.provider.openTerminal(openRequest());
    const unavailable = vi.fn();
    await remote.persistent!.start({ restore: async () => undefined, resize: async () => undefined, unavailable });
    fixture.host.processes[0]!.write.mockRejectedValueOnce(new SidecarOperationError("provider_write_failed"));
    expect(await remote.write(Buffer.from("uncertain"))).toMatchObject({ outcome: "sent_outcome_unknown" });
    expect(unavailable).toHaveBeenCalled();
    await remote.persistent!.detach();
    fixture.host.processes[0]!.exit();
  });

  it("separates scope/revision admission from query-only recovery of an existing incarnation", async () => {
    const fixture = createFixture();
    const request = openRequest();
    await expect(fixture.provider.openTerminal({ ...request, scope: { ...scope, principalId: "other" } })).rejects.toThrow("sidecar_unavailable");
    await expect(fixture.provider.attachTerminal({ ...request, environmentId: "wrong" })).rejects.toThrow("sidecar_unavailable");
    fixture.setRevision(4);
    await expect(fixture.provider.openTerminal(request)).rejects.toThrow("sidecar_unavailable");
    await expect(fixture.provider.attachTerminal(request)).rejects.toThrow("terminal_incarnation_unknown");
    expect(fixture.host.openTerminal).not.toHaveBeenCalled();
  });

  it("recovers an applied creation with a lost acknowledgment by attaching the exact ID", async () => {
    const fixture = createFixture();
    fixture.loseCreateResult();
    const remote = await fixture.provider.openTerminal(openRequest());
    expect(fixture.host.openTerminal).toHaveBeenCalledTimes(1);
    await remote.persistent!.detach();
    fixture.host.processes[0]!.exit();
  });

  it("holds one recovery-only lease through snapshot and final acknowledgment", async () => {
    const fixture = createFixture();
    const request = openRequest();
    const initial = await fixture.provider.openTerminal(request);
    await initial.persistent!.detach();
    fixture.host.processes[0]!.output("completed while detached\r\n");
    fixture.host.processes[0]!.exit();
    fixture.setRevision(4);
    const operationCount = fixture.acquireOperation.mock.calls.length;
    const recovered = await fixture.provider.recoverTerminal(request);
    const restored: string[] = [];
    await recovered.persistent!.start({ restore: async ({ bytes }) => { restored.push(Buffer.from(bytes).toString()); }, resize: async () => undefined, unavailable: () => undefined });
    expect(restored.join("")).toContain("completed while detached");
    expect(fixture.releaseRecovery).not.toHaveBeenCalled();
    await recovered.persistent!.acknowledgeFinal();
    expect(fixture.host.host.snapshot().blockers).toEqual([]);
    expect(fixture.releaseRecovery).not.toHaveBeenCalled();
    await recovered.persistent!.detach();
    expect(fixture.releaseRecovery).toHaveBeenCalledTimes(1);
    expect(fixture.acquireRecovery).toHaveBeenCalledTimes(1);
    expect(fixture.acquireOperation).toHaveBeenCalledTimes(operationCount);
    expect(fixture.host.openTerminal).toHaveBeenCalledTimes(1);
  });
});

function openRequest() {
  return { scope, environmentId: "remote", terminalId: randomUUID(), incarnationId: randomUUID(), initialCwd: "/workspace", rows: 24, columns: 80 };
}

function createFixture(options: { readonly enabled?: boolean; readonly terminalSupported?: boolean } = {}) {
  let terminalSupported = options.terminalSupported ?? true;
  const capabilities = () => terminalSupported ? [{ capabilityId: "interactive_terminal", majorVersion: 2, operations: interactiveTerminalV2Operations.map(operation => operation.operation) }] : [];
  const host = terminalHostFixture();
  let caller = host.caller;
  let connected = true;
  let revision = 3;
  let loseCreate = false;
  let rejectControl: string | undefined;
  let loseIncarnation = false;
  const release = vi.fn();
  const acquireOperation = vi.fn(async () => {
    if (!connected) throw new SidecarProtocolDeliveryError("disconnected", "not_sent");
    return { session: { negotiatedCapabilities: capabilities(), call: async (definition: Parameters<typeof caller.call>[0], request: unknown) => {
      if (loseIncarnation && definition.operation === "terminal.read") throw new SidecarOperationError("terminal_incarnation_unknown");
      if (rejectControl && ["terminal.input", "terminal.resize"].includes(definition.operation)) {
        const code = rejectControl; rejectControl = undefined; throw new SidecarOperationError(code);
      }
      const result = await caller.call(definition, request);
      if (definition.operation === "terminal.create" && loseCreate) { loseCreate = false; throw new SidecarProtocolDeliveryError("lost_response", "sent_outcome_unknown"); }
      return result;
    } }, release, carrierGeneration: 1 };
  });
  const releaseRecovery = vi.fn();
  const acquireRecovery = vi.fn(async () => ({ session: { negotiatedCapabilities: capabilities(), call: caller.call }, release: releaseRecovery, carrierGeneration: 1 }));
  const provider = new SshInteractiveTerminalProvider({ scope, environmentId: "remote", enabled: options.enabled ?? true, configurationRevision: 3,
    activeConfigurationRevision: () => revision,
    runtime: { canAcquireCapability: () => connected && terminalSupported, get negotiatedCapabilities() { return connected ? capabilities() : []; }, acquireOperation, acquireRecovery } as unknown as SidecarRuntimeOwner<SidecarClientSession>,
  });
  return { host, provider, release, acquireOperation, acquireRecovery, releaseRecovery,
    setTerminalSupported(value: boolean) { terminalSupported = value; },
    setRevision(value: number) { revision = value; },
    loseCreateResult() { loseCreate = true; },
    rejectControl(code: string) { rejectControl = code; },
    loseIncarnation() { loseIncarnation = true; },
    disconnect() { connected = false; host.disconnect(); },
    reconnect() { caller = host.connect(); connected = true; },
  };
}
