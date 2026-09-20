import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { SidecarOperationRegistry, type SidecarOperationDefinition } from "../../src/internal/sidecar-protocol/operation-registry.js";
import type { InteractiveTerminalExit, InteractiveTerminalProcess } from "../../src/server/execution/interactive-terminal.js";
import { PersistentTerminalHost, type TerminalResourceParticipant } from "../../src/server/sidecar/persistent-terminal-host.js";
import type { TerminalSidecarCaller } from "../../src/server/execution/ssh-interactive-terminal-provider.js";
import { terminalPrepareOperation, terminalCreateOperation } from "../../src/internal/sidecar-protocol/interactive-terminal-v2.js";

export const terminalTestScope = { tenantId: "tenant", principalId: "principal" };
export class FakePersistentPty implements InteractiveTerminalProcess {
  readonly outputs = new Set<(bytes: Uint8Array) => void>();
  readonly exits = new Set<(exit: InteractiveTerminalExit) => void>();
  readonly writes: Uint8Array[] = [];
  readonly pauseOutput = vi.fn();
  readonly resumeOutput = vi.fn();
  readonly resize = vi.fn(async (_size: { readonly rows: number; readonly columns: number }) => undefined);
  readonly terminate = vi.fn(async () => { this.exit({ disposition: "interrupted", exitCode: null, signal: "SIGKILL", cleanupConfirmed: true }); });
  readonly write = vi.fn(async (bytes: Uint8Array) => { this.writes.push(Uint8Array.from(bytes)); return { outcome: "sent" as const }; });
  onOutput(listener: (bytes: Uint8Array) => void): () => void { this.outputs.add(listener); return () => this.outputs.delete(listener); }
  onExit(listener: (exit: InteractiveTerminalExit) => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }
  output(value: string | Uint8Array): void { for (const listener of this.outputs) listener(typeof value === "string" ? Buffer.from(value) : value); }
  exit(exit: InteractiveTerminalExit = { disposition: "exited", exitCode: 0, signal: null, cleanupConfirmed: true }): void { for (const listener of this.exits) listener(exit); }
}

export function terminalHostFixture(options: { maximumTerminals?: number; maximumSuffixBytes?: number } = {}) {
  const processes: FakePersistentPty[] = [];
  const resources = new Map<string, TerminalResourceParticipant>();
  const openTerminal = vi.fn(async () => { const process = new FakePersistentPty(); processes.push(process); return process; });
  const host = new PersistentTerminalHost({
    scope: terminalTestScope, environmentId: "remote", openTerminal,
    registerResource(resource) { resources.set(resource.resourceId, resource); return () => { resources.delete(resource.resourceId); }; },
    ...options,
  });
  let epoch = 1;
  let admissionOpen = true;
  function connect(): TerminalSidecarCaller {
    const capturedEpoch = ++epoch;
    const registry = new SidecarOperationRegistry();
    const assertController = () => { if (capturedEpoch !== epoch) throw new Error("stale_service_controller"); };
    host.registerOperations(registry, {
      assertController,
      assertAdmission: () => { assertController(); if (!admissionOpen) throw new Error("service_draining"); },
    });
    return registryCaller(registry);
  }
  const caller = connect();
  return { host, caller, connect, resources, processes, openTerminal,
    disconnect() { epoch += 1; host.onDetach(); },
    drain() { admissionOpen = false; },
    async create() {
      const identity = { terminalId: randomUUID(), incarnationId: randomUUID() };
      const request = { ...identity, initialCwd: "/workspace", rows: 24, columns: 80 };
      const ticket = await caller.call(terminalPrepareOperation, request);
      await caller.call(terminalCreateOperation, ticket);
      return { identity, request, ticket, process: processes.at(-1)! };
    },
  };
}

export function registryCaller(registry: SidecarOperationRegistry): TerminalSidecarCaller {
  return {
    async call<Request, Response>(definition: SidecarOperationDefinition<Request, Response>, request: Request): Promise<Response> {
      const operation = registry.resolve(definition);
      if (!operation) throw new Error("test_operation_not_registered");
      const result = await operation.handler(definition.requestSchema.parse(request), { requestId: randomUUID(), signal: new AbortController().signal });
      return definition.responseSchema.parse(result);
    },
  };
}
