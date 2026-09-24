import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { attachOutboundCarrier } from "../../src/server/outbound/outbound-carrier.js";
import type { OutboundConnectionRegistry } from "../../src/server/outbound/outbound-connection-registry.js";
import { OUTBOUND_CONTROL_PATH, OUTBOUND_CONTROL_PROTOCOL, OUTBOUND_RUNTIME_PATH, OUTBOUND_RUNTIME_PROTOCOL } from "../../src/internal/outbound-protocol.js";
import { validateNativeWebSocketHost, validateWebSocketHostOrigin } from "../../src/server/security/http-security.js";
import type { AppConfig } from "../../src/server/config/config.js";
import { DomainError } from "../../src/server/domain/errors.js";

const config: AppConfig = { authenticationRequired: true, experimentalUsageEnabled: false, host: "127.0.0.1", port: 4784, stateDirectory: "/tmp/sedes", allowedTailscaleHosts: ["sedes.example.ts.net"], packagedClientOrigins: [], conversationRetentionMilliseconds: 600_000, conversationRuntimeBudget: 8 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function request(headers: IncomingMessage["headers"], remoteAddress = "127.0.0.1"): IncomingMessage { return { headers, socket: { remoteAddress } } as IncomingMessage; }

async function serverFixture(authentication?: Parameters<typeof attachOutboundCarrier>[1]["authentication"]) {
  const server = createServer();
  const registry = { register: vi.fn(), receive: vi.fn(), close: vi.fn(), consumeRuntimeTicket: vi.fn(() => { throw new Error("invalid"); }) };
  const identity = { resolve: vi.fn(async () => ({ tenantId: "tenant", principalId: "principal" })) };
  const carrier = attachOutboundCarrier(server, { config, authentication, registry: registry as unknown as OutboundConnectionRegistry, identity, helloTimeoutMs: 50, heartbeatMs: 5000 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  cleanups.push(async () => { await carrier.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { base: `ws://127.0.0.1:${address.port}`, registry, identity };
}

describe("native outbound HTTP/WebSocket boundary", () => {
  it.each([
    [{ host: "127.0.0.1:4784" }, "127.0.0.1", undefined],
    [{ host: "localhost:4784" }, "127.0.0.1", undefined],
    [{ host: "127.0.0.1", "x-forwarded-host": "sedes.example.ts.net", "x-forwarded-proto": "https" }, "127.0.0.1", undefined],
    [{ host: "127.0.0.1", "x-forwarded-host": "sedes.example.ts.net", "x-forwarded-proto": "http" }, "127.0.0.1", undefined],
    [{ host: "127.0.0.1", "x-forwarded-host": "sedes.example.ts.net", "x-forwarded-proto": "https" }, "10.0.0.5", "forwarded_origin_not_allowed"],
    [{ host: "localhost.attacker.test" }, "127.0.0.1", "host_not_allowed"],
    [{ host: "127.0.0.1", origin: "http://127.0.0.1" }, "127.0.0.1", "origin_not_allowed"],
    [{ host: "127.0.0.1", "sec-fetch-mode": "websocket" }, "127.0.0.1", "origin_not_allowed"],
  ] as const)("preserves exact native Host and proxy authority for %j", (headers, remote, rejection) => {
    expect(validateNativeWebSocketHost(request(headers, remote), config)).toBe(rejection);
  });

  it("supports an explicitly configured LAN over HTTP without changing browser origin requirements", () => {
    const lan = { ...config, trustedLanHost: "192.168.1.24" };
    const native = request({ host: "192.168.1.24:4784" }, "192.168.1.50");
    expect(validateNativeWebSocketHost(native, lan)).toBeUndefined();
    expect(validateWebSocketHostOrigin(native, lan)).toBe("origin_not_allowed");
    expect(validateNativeWebSocketHost(request({ host: "192.168.1.25:4784" }), lan)).toBe("host_not_allowed");
  });

  it("admits a native hello over actual HTTP using the server-derived principal", async () => {
    const f = await serverFixture();
    const socket = new WebSocket(`${f.base}${OUTBOUND_CONTROL_PATH}`, OUTBOUND_CONTROL_PROTOCOL);
    await once(socket, "open");
    const hello = { type: "hello", protocolVersion: 1, connectorId: randomUUID(), registrationAttemptId: randomUUID(), metadata: { hostname: "mac", platform: "darwin", architecture: "arm64", account: "dev", connectorVersion: "test" } };
    socket.send(JSON.stringify(hello));
    await vi.waitFor(() => expect(f.registry.register).toHaveBeenCalledWith({ tenantId: "tenant", principalId: "principal" }, hello, expect.any(WebSocket)));
    socket.close();
    await once(socket, "close");
  });

  it("rejects browser agent upgrades before resolving identity", async () => {
    const f = await serverFixture();
    const socket = new WebSocket(`${f.base}${OUTBOUND_CONTROL_PATH}`, OUTBOUND_CONTROL_PROTOCOL, { origin: "http://127.0.0.1" });
    socket.on("error", () => {});
    const [, response] = await once(socket, "unexpected-response");
    expect(response.statusCode).toBe(403);
    response.resume();
    socket.terminate();
    expect(f.identity.resolve).not.toHaveBeenCalled();
  });

  it.each([
    [new DomainError("conflict", "A private repository detail"), "outbound_registration_conflict"],
    [new DomainError("not_found", "A private repository detail"), "outbound_pairing_unavailable"],
    [new DomainError("bad_request", "A private repository detail"), "outbound_registration_invalid"],
    [new Error("outbound_installation_mismatch"), "outbound_installation_mismatch"],
    [new Error("A private internal detail"), "outbound_server_error"],
  ])("preserves stable admission diagnostics without exposing internal details: %s", async (error, reason) => {
    const f = await serverFixture();
    f.registry.register.mockImplementation(() => { throw error; });
    const socket = new WebSocket(`${f.base}${OUTBOUND_CONTROL_PATH}`, OUTBOUND_CONTROL_PROTOCOL);
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, connectorId: randomUUID(), registrationAttemptId: randomUUID(),
      metadata: { hostname: "mac", platform: "darwin", architecture: "arm64", account: "dev", connectorVersion: "test" } }));
    const [code, diagnostic] = await closed;
    expect(code).toBe(1008);
    expect(diagnostic.toString()).toBe(reason);
  });

  it.each(['{', '{"type":"hello","protocolVersion":999}'])("rejects malformed client messages permanently before repository handling: %s", async bytes => {
    const f = await serverFixture();
    const socket = new WebSocket(`${f.base}${OUTBOUND_CONTROL_PATH}`, OUTBOUND_CONTROL_PROTOCOL);
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send(bytes);
    const [code, reason] = await closed;
    expect(code).toBe(1008);
    expect(reason.toString()).toBe("outbound_protocol_invalid");
    expect(f.registry.register).not.toHaveBeenCalled();
  });

  it("denies runtime sockets without a valid one-use ticket", async () => {
    const f = await serverFixture();
    const socket = new WebSocket(`${f.base}${OUTBOUND_RUNTIME_PATH}`, [OUTBOUND_RUNTIME_PROTOCOL, "a".repeat(43)]);
    socket.on("error", () => {});
    const [, response] = await once(socket, "unexpected-response");
    expect(response.statusCode).toBe(403);
    response.resume();
    socket.terminate();
    expect(f.registry.consumeRuntimeTicket).toHaveBeenCalledWith({ tenantId: "tenant", principalId: "principal" }, "a".repeat(43), undefined);
  });

  it("rejects missing credentials before identity resolution", async () => {
    const f = await serverFixture({ required: true, authenticateSidecar: () => { throw new Error("unauthorized"); }, trackClient: () => () => {} });
    const socket = new WebSocket(`${f.base}${OUTBOUND_CONTROL_PATH}`, OUTBOUND_CONTROL_PROTOCOL);
    socket.on("error", () => {});
    const [, response] = await once(socket, "unexpected-response");
    expect(response.statusCode).toBe(401);
    response.resume(); socket.terminate();
    expect(f.identity.resolve).not.toHaveBeenCalled();
  });

  it("binds hello to authenticated connector and closes live sockets on revocation", async () => {
    const connectorId = randomUUID();
    const closers = new Set<() => void>();
    const f = await serverFixture({ required: true, authenticateSidecar: () => ({ id: "client", connectorId }), trackClient: (_id, close) => { closers.add(close); return () => { closers.delete(close); }; } });
    const socket = new WebSocket(`${f.base}${OUTBOUND_CONTROL_PATH}`, OUTBOUND_CONTROL_PROTOCOL);
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, connectorId: randomUUID(), registrationAttemptId: randomUUID(), metadata: { hostname: "mac", platform: "darwin", architecture: "arm64", account: "dev", connectorVersion: "test" } }));
    expect((await closed)[1].toString()).toBe("outbound_authenticated_connector_mismatch");
    expect(f.registry.register).not.toHaveBeenCalled();
    const live = new WebSocket(`${f.base}${OUTBOUND_CONTROL_PATH}`, OUTBOUND_CONTROL_PROTOCOL);
    await once(live, "open");
    const revoked = once(live, "close");
    for (const close of closers) close();
    expect((await revoked)[1].toString()).toBe("outbound_authentication_required_repair");
    await vi.waitFor(() => expect(closers.size).toBe(0));
  });

  it("bypasses bearer admission only when disabled while retaining host registration and runtime ticket checks", async () => {
    const authenticateSidecar = vi.fn(() => { throw new Error("must not authenticate"); });
    const trackClient = vi.fn(() => () => {});
    const f = await serverFixture({ required: false, authenticateSidecar, trackClient });
    const socket = new WebSocket(`${f.base}${OUTBOUND_CONTROL_PATH}`, OUTBOUND_CONTROL_PROTOCOL, { headers: { Authorization: "Bearer stale" } });
    await once(socket, "open");
    const hello = { type: "hello", protocolVersion: 1, connectorId: randomUUID(), registrationAttemptId: randomUUID(), metadata: { hostname: "mac", platform: "darwin", architecture: "arm64", account: "dev", connectorVersion: "test" } };
    socket.send(JSON.stringify(hello));
    await vi.waitFor(() => expect(f.registry.register).toHaveBeenCalled());
    const runtime = new WebSocket(`${f.base}${OUTBOUND_RUNTIME_PATH}`, [OUTBOUND_RUNTIME_PROTOCOL, "a".repeat(43)]);
    runtime.on("error", () => {});
    const [, response] = await once(runtime, "unexpected-response");
    expect(response.statusCode).toBe(403);
    expect(f.registry.consumeRuntimeTicket).toHaveBeenCalledWith({ tenantId: "tenant", principalId: "principal" }, "a".repeat(43), undefined);
    response.resume(); runtime.terminate();
    expect(authenticateSidecar).not.toHaveBeenCalled();
    expect(trackClient).not.toHaveBeenCalled();
    socket.close(); await once(socket, "close");
  });

  it("closes silent pre-registration sockets at the hello deadline", async () => {
    const f = await serverFixture();
    const socket = new WebSocket(`${f.base}${OUTBOUND_CONTROL_PATH}`, OUTBOUND_CONTROL_PROTOCOL);
    await once(socket, "open");
    const [code, reason] = await once(socket, "close");
    expect(code).toBe(1008);
    expect(reason.toString()).toBe("outbound_hello_timeout");
    expect(f.registry.register).not.toHaveBeenCalled();
  });
});
