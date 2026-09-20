import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { OutboundConnectionRegistry } from "../../src/server/outbound/outbound-connection-registry.js";
import { outboundHelloSchema, type OutboundHello, type OutboundRuntimeBootstrap } from "../../src/internal/outbound-protocol.js";
import type { HostPairing, HostRegistration } from "../../src/shared/protocol/host-pairing.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const other = { tenantId: "tenant", principalId: "other" };
const installation = { accountHome: "/Users/dev", nodeExecutable: "/opt/node", stateRoot: "/Users/dev/.local/state/sedes", environment: {}, executableDirectory: "/Users/dev/runtime/digest", executablePath: "/Users/dev/runtime/digest/sedes" };
const registries: OutboundConnectionRegistry[] = [];
afterEach(() => { for (const registry of registries.splice(0)) registry.close(); vi.useRealTimers(); });

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(data: string, _options: unknown, callback: (error?: Error) => void) { this.sent.push(JSON.parse(data)); callback(); }
  terminate() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  close() { this.terminate(); }
  pause() {}
  resume() {}
  get ws(): WebSocket { return this as unknown as WebSocket; }
}

function fixture(accepted = false) {
  const now = new Date().toISOString();
  const hello: OutboundHello = { type: "hello", protocolVersion: 1, connectorId: randomUUID(), registrationAttemptId: randomUUID(), metadata: { hostname: "mac", platform: "darwin", architecture: "arm64", account: "dev", connectorVersion: "test", nodeVersion: "24.18.0" } };
  const registration: HostRegistration = { id: randomUUID(), connectorId: hello.connectorId, registrationAttemptId: hello.registrationAttemptId, correlationCode: "ABCD-EF12", metadata: hello.metadata, state: accepted ? "accepted" : "pending", revision: 1, createdAt: now, updatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), pairingId: null };
  let pairing: HostPairing | undefined;
  let revision = 1;
  const assertScope = (actual: RequestScope) => { if (actual.tenantId !== scope.tenantId || actual.principalId !== scope.principalId) throw new Error("wrong_scope"); };
  const repository: ConstructorParameters<typeof OutboundConnectionRegistry>[0]["repository"] = {
    register(actual) { assertScope(actual); return registration; },
    getRegistration(actual) { assertScope(actual); return registration; },
    getPairing(actual, id) { assertScope(actual); if (!pairing || pairing.id !== id) throw new Error("missing_pairing"); return pairing; },
    pairingForConnector(actual, id) { if (actual.principalId !== scope.principalId || actual.tenantId !== scope.tenantId || id !== hello.connectorId) return undefined; return pairing; },
    pairingForEnvironment(actual, id) { if (actual.principalId !== scope.principalId || actual.tenantId !== scope.tenantId || id !== pairing?.executionEnvironmentId) return undefined; return pairing; },
    observe(actual, id) { assertScope(actual); if (!pairing || pairing.id !== id) throw new Error("missing_pairing"); return pairing; },
  };
  const registry = new OutboundConnectionRegistry({ repository, installationId: "installation", environmentRevision: () => String(revision), commandTimeoutMs: 1000, runtimeTimeoutMs: 1000 });
  registries.push(registry);
  function accept() {
    pairing = { id: randomUUID(), connectorId: hello.connectorId, executionEnvironmentId: randomUUID(), platform: "darwin", metadata: hello.metadata, state: "accepted", revision: 1, createdAt: now, updatedAt: now, lastSeenAt: now };
    Object.assign(registration, { state: "accepted", pairingId: pairing.id });
    return pairing;
  }
  if (accepted) accept();
  const socket = new Socket();
  registry.register(scope, hello, socket.ws);
  return {
    registry, socket, hello, accept, get pairing() { return pairing!; },
    revise() { revision += 1; },
    revoke() { pairing = { ...pairing!, state: "revoked", revision: pairing!.revision + 1 }; },
    expire() { Object.assign(registration, { state: "expired" }); },
    payload(): OutboundRuntimeBootstrap { return { scope: { ...scope, installationId: "installation", executionEnvironmentId: pairing!.executionEnvironmentId }, configuration: { environmentRevision: 1, operationsRevision: 1 }, expectedDigest: "a".repeat(64), expectedBuild: "test", agentToolEndpointKey: "a".repeat(24), startIfAbsent: true }; },
  };
}

describe("outbound connection authority", () => {
  it("keeps pending control presence separate from permission to execute", async () => {
    const f = fixture();
    expect(f.registry.presence(scope, f.hello.connectorId).connected).toBe(true);
    expect(f.socket.sent.at(-1)).toMatchObject({ type: "pairing", status: "pending", correlationCode: "ABCD-EF12" });
    await expect(f.registry.request(scope, randomUUID(), "management", {})).rejects.toThrow("outbound_pairing_not_accepted");
    const pairing = f.accept();
    f.registry.refresh(scope);
    expect(f.socket.sent.at(-1)).toMatchObject({ status: "accepted", scope: { ...scope, installationId: "installation", executionEnvironmentId: pairing.executionEnvironmentId } });
    expect(f.registry.isConnected(scope, pairing.executionEnvironmentId)).toBe(true);
    expect(f.registry.isConnected(other, pairing.executionEnvironmentId)).toBe(false);
  });

  it("rejects connector-selected authority and duplicate live installations", () => {
    const f = fixture(true);
    expect(() => outboundHelloSchema.parse({ ...f.hello, tenantId: "selected" })).toThrow();
    expect(() => f.registry.register(scope, f.hello, new Socket().ws)).toThrow("outbound_connector_already_connected");
    expect(f.registry.isConnected(scope, f.pairing.executionEnvironmentId)).toBe(true);
  });

  it("delivers registration expiry to a still-connected pending host", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.expire();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(f.socket.sent.at(-1)).toMatchObject({ type: "pairing", status: "expired" });
  });

  it("reconnects stable identities while fencing late old-close callbacks", () => {
    const f = fixture(true);
    f.registry.disconnect(scope, f.pairing.executionEnvironmentId);
    const replacement = new Socket();
    f.registry.register(scope, { ...f.hello, metadata: { ...f.hello.metadata, hostname: "renamed" }, binding: { pairingId: f.pairing.id, installationId: "installation" } }, replacement.ws);
    f.socket.emit("close");
    expect(f.registry.isConnected(scope, f.pairing.executionEnvironmentId)).toBe(true);
    expect(f.registry.presence(scope, f.hello.connectorId).generation).toBe(2);
  });

  it("denies a different server binding and delivers persisted revocation on reconnect", () => {
    const f = fixture(true);
    f.registry.disconnect(scope, f.pairing.executionEnvironmentId);
    expect(() => f.registry.register(scope, { ...f.hello, binding: { pairingId: f.pairing.id, installationId: "different" } }, new Socket().ws)).toThrow("outbound_installation_mismatch");
    f.revoke();
    const next = new Socket();
    f.registry.register(scope, { ...f.hello, binding: { pairingId: f.pairing.id, installationId: "installation" } }, next.ws);
    expect(next.sent.at(-1)).toMatchObject({ status: "revoked" });
    expect(f.registry.isConnected(scope, f.pairing.executionEnvironmentId)).toBe(false);
  });

  it("checks platform on accepted registration replay before the connector saved its binding", () => {
    const f = fixture(true);
    f.registry.disconnect(scope, f.pairing.executionEnvironmentId);
    expect(() => f.registry.register(scope, { ...f.hello, metadata: { ...f.hello.metadata, platform: "win32" } }, new Socket().ws)).toThrow("outbound_pairing_mismatch");
  });

  it("rejects in-flight management on control loss without replay", async () => {
    const f = fixture(true);
    const request = f.registry.request(scope, f.pairing.executionEnvironmentId, "management", { operation: "stop" });
    const rejected = expect(request).rejects.toThrow("outbound_control_disconnected");
    f.socket.terminate();
    await rejected;
    expect(f.socket.sent.filter(message => message.type === "command")).toHaveLength(1);
  });

  it("expires bounded commands and ignores their late results", async () => {
    vi.useFakeTimers();
    const f = fixture(true);
    const request = f.registry.request(scope, f.pairing.executionEnvironmentId, "install", {});
    const command = f.socket.sent.at(-1)!;
    const rejected = expect(request).rejects.toThrow("outbound_command_timeout");
    await vi.advanceTimersByTimeAsync(1001);
    await rejected;
    expect(f.socket.sent.at(-1)).toMatchObject({ type: "cancel", requestId: command.requestId });
    expect(() => f.registry.receive(scope, f.hello.connectorId, f.socket.ws, { type: "result", requestId: command.requestId as string, ok: true, result: {} })).not.toThrow();
  });

  it.each(["socket-first", "metadata-first"])("correlates one-use scoped runtime tickets in %s order", async order => {
    const f = fixture(true);
    const opening = f.registry.openRuntime(scope, f.pairing.executionEnvironmentId, f.payload());
    const token = f.socket.sent.at(-1)!.ticket as string;
    expect(() => f.registry.consumeRuntimeTicket(other, token)).toThrow("outbound_ticket_invalid");
    expect(() => f.registry.consumeRuntimeTicket(scope, token, randomUUID())).toThrow("outbound_ticket_invalid");
    const admit = f.registry.consumeRuntimeTicket(scope, token, f.hello.connectorId);
    expect(() => f.registry.consumeRuntimeTicket(scope, token)).toThrow("outbound_ticket_invalid");
    const remote = new Socket();
    const ready = () => f.registry.receive(scope, f.hello.connectorId, f.socket.ws, { type: "runtimeReady", ticket: token, ok: true, installation });
    if (order === "socket-first") { admit(remote.ws); ready(); } else { ready(); admit(remote.ws); }
    const stream = await opening;
    expect(stream.installation.executableDirectory).toBe(installation.executableDirectory);
    f.socket.terminate();
    await expect(stream.closed).resolves.toMatchObject({ reason: "outbound_control_disconnected" });
  });

  it("fences an established carrier while preserving management and excluding concurrent pending attaches", async () => {
    const f = fixture(true);
    const open = () => f.registry.openRuntime(scope, f.pairing.executionEnvironmentId, f.payload());
    const ready = (remote: Socket) => {
      const token = f.socket.sent.at(-1)!.ticket as string;
      f.registry.consumeRuntimeTicket(scope, token)(remote.ws);
      f.registry.receive(scope, f.hello.connectorId, f.socket.ws, { type: "runtimeReady", ticket: token, ok: true, installation });
    };
    const firstPending = open();
    const oldSocket = new Socket();
    ready(oldSocket);
    const first = await firstPending;
    const management = f.registry.request(scope, f.pairing.executionEnvironmentId, "management", {});
    const command = f.socket.sent.at(-1)!;
    const replacement = open();
    await expect(first.closed).resolves.toMatchObject({ reason: "outbound_runtime_replaced" });
    await expect(open()).rejects.toThrow("outbound_runtime_already_attached");
    const successorSocket = new Socket();
    ready(successorSocket);
    const successor = await replacement;
    oldSocket.emit("close");
    expect(successorSocket.readyState).toBe(WebSocket.OPEN);
    f.registry.receive(scope, f.hello.connectorId, f.socket.ws, { type: "result", requestId: command.requestId as string, ok: true, result: { observed: true } });
    await expect(management).resolves.toEqual({ observed: true });
    await successor.close("test_complete");
  });

  it("rechecks configuration revisions even before a refresh notification", async () => {
    const f = fixture(true);
    const opening = f.registry.openRuntime(scope, f.pairing.executionEnvironmentId, f.payload());
    const token = f.socket.sent.at(-1)!.ticket as string;
    const rejected = expect(opening).rejects.toThrow("outbound_configuration_changed");
    f.revise();
    expect(() => f.registry.consumeRuntimeTicket(scope, token)).toThrow("outbound_configuration_changed");
    expect(f.registry.isConnected(scope, f.pairing.executionEnvironmentId)).toBe(false);
    f.registry.refresh(scope);
    await rejected;
    expect(() => f.registry.consumeRuntimeTicket(scope, token)).toThrow("outbound_ticket_invalid");
  });

  it("revocation cancels pending runtime tickets and admission immediately", async () => {
    const f = fixture(true);
    const opening = f.registry.openRuntime(scope, f.pairing.executionEnvironmentId, f.payload());
    const token = f.socket.sent.at(-1)!.ticket as string;
    const rejected = expect(opening).rejects.toThrow("outbound_pairing_not_accepted");
    f.revoke();
    expect(f.registry.isConnected(scope, f.pairing.executionEnvironmentId)).toBe(false);
    f.registry.refresh(scope);
    await rejected;
    expect(() => f.registry.consumeRuntimeTicket(scope, token)).toThrow("outbound_ticket_invalid");
  });
});
