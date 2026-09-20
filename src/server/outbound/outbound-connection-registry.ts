import { createHash, randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  OUTBOUND_CONTROL_MAX_BYTES,
  outboundRuntimeBootstrapSchema,
  outboundServerMessageSchema,
  type OutboundClientMessage,
  type OutboundHello,
  type OutboundInstallation,
  type OutboundRuntimeBootstrap,
  type OutboundServerMessage,
} from "../../internal/outbound-protocol.js";
import { createWebSocketByteStream } from "../../internal/websocket-byte-stream.js";
import type { SidecarByteStream } from "../../internal/sidecar-protocol/contracts.js";
import type { SidecarServiceScope } from "../../internal/sidecar-protocol/service-management-v1.js";
import type { HostPairingRepository } from "../host-pairing/host-pairing-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";

export interface OutboundPresence {
  readonly connected: boolean;
  readonly generation?: number;
  readonly lastSeenAt?: string;
}
export interface OutboundConnectionEvent extends OutboundPresence {
  readonly scope: RequestScope;
  readonly connectorId: string;
  readonly environmentId?: string;
}
export interface OutboundRuntimeByteStream extends SidecarByteStream {
  readonly installation: OutboundInstallation;
}
/** Failed carrier observation or delivery; remote application refusals never use
 * this type and mutations still require receipt recovery before any retry. */
export class OutboundCarrierError extends Error {
  constructor(readonly diagnosticCode: string) {
    super(diagnosticCode);
    this.name = "OutboundCarrierError";
  }
}
type Deferred<T> = { resolve(value: T): void; reject(error: Error): void };
type PendingCommand = Deferred<unknown> & { timer: NodeJS.Timeout; cleanup(): void };
type Session = {
  scope: RequestScope;
  hello: OutboundHello;
  socket: WebSocket;
  generation: number;
  registrationId?: string;
  pairingId?: string;
  pairingRevision?: number;
  environmentId?: string;
  environmentRevision?: string;
  commands: Map<string, PendingCommand>;
  runtime?: SidecarByteStream;
  pendingRuntime?: RuntimeTicket;
  registrationExpiry?: NodeJS.Timeout;
};
type RuntimeTicket = Deferred<OutboundRuntimeByteStream> & {
  token: string;
  key: string;
  session: Session;
  pairingId: string;
  pairingRevision: number;
  environmentRevision: string;
  expiresAt: number;
  consumed: boolean;
  stream?: SidecarByteStream;
  installation?: OutboundInstallation;
  timer: NodeJS.Timeout;
  cleanup(): void;
};

/** Principal-scoped live authority. Pairing IDs correlate installations; they
 * are deliberately separate from the application's future authentication. */
export class OutboundConnectionRegistry {
  readonly #sessions = new Map<string, Session>();
  readonly #tickets = new Map<string, RuntimeTicket>();
  readonly #listeners = new Set<(event: OutboundConnectionEvent) => void>();
  readonly #lastSeen = new Map<string, string>();
  #generation = 0;
  #closed = false;
  constructor(readonly options: {
    repository: Pick<HostPairingRepository, "register" | "getRegistration" | "getPairing" | "pairingForConnector" | "pairingForEnvironment" | "observe">;
    installationId: string;
    /** Undefined denies removed or currently unavailable configuration. */
    environmentRevision(scope: RequestScope, environmentId: string): string | undefined;
    commandTimeoutMs?: number;
    runtimeTimeoutMs?: number;
  }) {}

  subscribe(listener: (event: OutboundConnectionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  presence(scope: RequestScope, connectorId: string): OutboundPresence {
    const key = sessionKey(scope, connectorId);
    const session = this.#sessions.get(key);
    return {
      connected: session?.socket.readyState === WebSocket.OPEN,
      ...(session ? { generation: session.generation } : {}),
      ...(this.#lastSeen.has(key) ? { lastSeenAt: this.#lastSeen.get(key)! } : {}),
    };
  }

  isConnected(scope: RequestScope, environmentId: string): boolean {
    try { this.#authorizedSession(scope, environmentId); return true; } catch { return false; }
  }

  /** Called exactly once after the bounded initial hello. */
  register(scope: RequestScope, hello: OutboundHello, socket: WebSocket): void {
    if (this.#closed) throw new Error("outbound_registry_closed");
    const key = sessionKey(scope, hello.connectorId);
    if (this.#sessions.has(key)) throw new Error("outbound_connector_already_connected");
    if (this.#sessions.size >= 256) throw new Error("outbound_connection_capacity");
    let registrationId: string | undefined;
    let pairingId: string | undefined;
    if (hello.binding) {
      if (hello.binding.installationId !== this.options.installationId) throw new Error("outbound_installation_mismatch");
      const pairing = this.options.repository.getPairing(scope, hello.binding.pairingId);
      if (pairing.connectorId !== hello.connectorId) throw new Error("outbound_pairing_mismatch");
      pairingId = pairing.id;
    } else {
      const registration = this.options.repository.register(scope, {
        connectorId: hello.connectorId,
        registrationAttemptId: hello.registrationAttemptId,
        metadata: hello.metadata,
      });
      registrationId = registration.id;
      pairingId = registration.pairingId ?? undefined;
    }
    if (pairingId) {
      const pairing = this.options.repository.getPairing(scope, pairingId);
      if (pairing.connectorId !== hello.connectorId || pairing.platform !== hello.metadata.platform) throw new Error("outbound_pairing_mismatch");
      if (pairing.state === "accepted") this.options.repository.observe(scope, pairing.id, hello.metadata);
    }
    const session: Session = {
      scope: Object.freeze({ ...scope }), hello, socket,
      generation: ++this.#generation, commands: new Map(),
      registrationId, pairingId,
    };
    this.#sessions.set(key, session);
    socket.once("close", () => this.#remove(session, "outbound_control_disconnected"));
    socket.once("error", () => this.#remove(session, "outbound_control_error"));
    this.#publishPairing(session);
    this.#emit(session, true);
  }

  receive(scope: RequestScope, connectorId: string, socket: WebSocket, message: OutboundClientMessage): void {
    const session = this.#sessions.get(sessionKey(scope, connectorId));
    if (!session || session.socket !== socket) throw new Error("outbound_control_generation_stale");
    if (message.type === "hello") throw new Error("outbound_hello_repeated");
    this.#assertCurrent(session);
    if (message.type === "result") {
      const command = session.commands.get(message.requestId);
      if (!command) return; // A cancelled/expired command may settle late; never replay it.
      session.commands.delete(message.requestId);
      command.cleanup();
      if (message.ok) command.resolve(message.result);
      else command.reject(new Error(message.error ?? "outbound_command_failed"));
      return;
    }
    const ticket = session.pendingRuntime;
    if (!ticket || ticket.key !== digest(message.ticket)) return;
    this.#assertTicket(ticket);
    if (!message.ok || !message.installation) {
      this.#failTicket(ticket, new Error(message.error ?? "outbound_runtime_attach_failed"));
      return;
    }
    ticket.installation = message.installation;
    this.#settleTicket(ticket);
  }

  async request(scope: RequestScope, environmentId: string, operation: "install" | "management", payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const session = this.#authorizedSession(scope, environmentId);
    if (signal?.aborted) throw new Error("outbound_request_aborted");
    if (session.commands.size >= 16) throw new Error("outbound_command_capacity");
    const requestId = randomUUID();
    return await new Promise<unknown>((resolve, reject) => {
      const fail = (reason: string) => {
        if (!session.commands.delete(requestId)) return;
        cleanup();
        try { this.#send(session, { type: "cancel", requestId }); } catch { /* Session loss already fences new work. */ }
        reject(connectionFailure(reason));
      };
      const abort = () => fail("outbound_request_aborted");
      const timer = setTimeout(() => fail("outbound_command_timeout"), this.options.commandTimeoutMs ?? 120_000);
      timer.unref();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      session.commands.set(requestId, { resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.#send(session, { type: "command", requestId, operation, payload }); }
      catch (cause) { fail(cause instanceof Error ? cause.message : "outbound_command_failed"); }
    });
  }

  async openRuntime(scope: RequestScope, environmentId: string, input: OutboundRuntimeBootstrap, signal?: AbortSignal): Promise<OutboundRuntimeByteStream> {
    const payload = outboundRuntimeBootstrapSchema.parse(input);
    const session = this.#authorizedSession(scope, environmentId);
    const expected = this.#serviceScope(session);
    if (Object.keys(expected).some((key) => expected[key as keyof SidecarServiceScope] !== payload.scope[key as keyof SidecarServiceScope])) throw new Error("outbound_runtime_scope_mismatch");
    if (signal?.aborted) throw new Error("outbound_request_aborted");
    if (session.pendingRuntime) throw new Error("outbound_runtime_already_attached");
    // The daemon has one controller. Replace an established recovery/normal
    // carrier before issuing its successor, preserving independent management.
    const previous = session.runtime;
    session.runtime = undefined;
    void previous?.close("outbound_runtime_replaced");
    const token = randomBytes(32).toString("base64url");
    return await new Promise<OutboundRuntimeByteStream>((resolve, reject) => {
      const abort = () => this.#failTicket(ticket, new Error("outbound_request_aborted"));
      const timeoutMs = this.options.runtimeTimeoutMs ?? 120_000;
      const timer = setTimeout(() => this.#failTicket(ticket, new OutboundCarrierError("outbound_runtime_timeout")), timeoutMs);
      timer.unref();
      const ticket: RuntimeTicket = {
        token, key: digest(token), session, pairingId: session.pairingId!, pairingRevision: session.pairingRevision!,
        environmentRevision: session.environmentRevision!, expiresAt: Date.now() + timeoutMs,
        consumed: false, resolve, reject, timer,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); },
      };
      session.pendingRuntime = ticket;
      this.#tickets.set(ticket.key, ticket);
      signal?.addEventListener("abort", abort, { once: true });
      try { this.#send(session, { type: "attach", ticket: token, payload }); }
      catch (cause) { this.#failTicket(ticket, cause instanceof Error ? cause : new Error("outbound_attach_failed")); }
    });
  }

  /** Consume before upgrade. A bad scope cannot consume another scope's ticket. */
  consumeRuntimeTicket(scope: RequestScope, token: string, authenticatedConnectorId?: string): (socket: WebSocket) => void {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error("outbound_ticket_invalid");
    const ticket = this.#tickets.get(digest(token));
    if (!ticket || ticket.consumed || !sameScope(scope, ticket.session.scope) || (authenticatedConnectorId !== undefined && authenticatedConnectorId !== ticket.session.hello.connectorId)) throw new Error("outbound_ticket_invalid");
    this.#assertTicket(ticket);
    ticket.consumed = true;
    // Recheck after async identity/HTTP upgrade boundaries, before accepting bytes.
    return (socket) => {
        try {
          this.#assertTicket(ticket);
          ticket.stream = createWebSocketByteStream(socket);
          void ticket.stream.closed.then(() => {
            if (ticket.session.pendingRuntime === ticket) this.#failTicket(ticket, new OutboundCarrierError("outbound_runtime_closed"));
          });
          this.#settleTicket(ticket);
        } catch (cause) {
          socket.terminate();
          this.#failTicket(ticket, cause instanceof Error ? cause : new Error("outbound_ticket_invalid"));
        }
    };
  }

  /** Pairing/configuration commits must call this before scheduling runtime work. */
  refresh(scope: RequestScope): void {
    for (const session of this.#sessions.values()) {
      if (!sameScope(scope, session.scope)) continue;
      try {
        const oldRevision = session.environmentRevision;
        const oldPairingRevision = session.pairingRevision;
        this.#publishPairing(session);
        if (oldRevision !== session.environmentRevision || oldPairingRevision !== session.pairingRevision) this.#fenceRuntime(session, "outbound_configuration_changed");
        this.#emit(session, true);
      } catch { this.#remove(session, "outbound_pairing_unavailable"); session.socket.terminate(); }
    }
  }

  disconnect(scope: RequestScope, environmentId: string): void {
    const pairing = this.options.repository.pairingForEnvironment(scope, environmentId);
    if (!pairing) return;
    const session = this.#sessions.get(sessionKey(scope, pairing.connectorId));
    if (session) { this.#remove(session, "outbound_disconnected"); session.socket.terminate(); }
  }

  close(): void {
    this.#closed = true;
    for (const session of [...this.#sessions.values()]) {
      this.#remove(session, "outbound_server_shutdown");
      session.socket.terminate();
    }
    this.#listeners.clear();
  }

  #publishPairing(session: Session): void {
    clearTimeout(session.registrationExpiry);
    session.registrationExpiry = undefined;
    const registration = session.registrationId ? this.options.repository.getRegistration(session.scope, session.registrationId) : undefined;
    session.pairingId = session.pairingId ?? registration?.pairingId ?? undefined;
    const pairing = session.pairingId ? this.options.repository.getPairing(session.scope, session.pairingId) : undefined;
    session.environmentId = pairing?.executionEnvironmentId;
    session.pairingRevision = pairing?.revision;
    session.environmentRevision = pairing?.state === "accepted" ? this.options.environmentRevision(session.scope, pairing.executionEnvironmentId) : undefined;
    const status = pairing?.state ?? registration?.state;
    if (!status) throw new Error("outbound_pairing_missing");
    if (status !== "accepted") this.#fenceRuntime(session, "outbound_pairing_not_accepted");
    this.#send(session, {
      type: "pairing", status, generation: session.generation,
      ...(registration ? { registrationId: registration.id, correlationCode: registration.correlationCode } : {}),
      ...(pairing ? { pairingId: pairing.id, scope: this.#serviceScope(session) } : {}),
    });
    if (registration?.state === "pending") {
      const delay = Math.max(1, Date.parse(registration.expiresAt) - Date.now());
      session.registrationExpiry = setTimeout(() => {
        if (this.#sessions.get(sessionKey(session.scope, session.hello.connectorId)) !== session) return;
        try { this.#publishPairing(session); }
        catch { this.#remove(session, "outbound_pairing_unavailable"); session.socket.terminate(); }
      }, delay);
      session.registrationExpiry.unref();
    }
  }

  #serviceScope(session: Session): SidecarServiceScope {
    if (!session.environmentId) throw new Error("outbound_environment_unpaired");
    return { installationId: this.options.installationId, ...session.scope, executionEnvironmentId: session.environmentId };
  }

  #authorizedSession(scope: RequestScope, environmentId: string): Session {
    const pairing = this.options.repository.pairingForEnvironment(scope, environmentId);
    if (!pairing || pairing.state !== "accepted") throw new Error("outbound_pairing_not_accepted");
    const session = this.#sessions.get(sessionKey(scope, pairing.connectorId));
    if (!session || session.environmentId !== environmentId) throw new OutboundCarrierError("outbound_connector_offline");
    this.#assertCurrent(session);
    return session;
  }

  #assertCurrent(session: Session): void {
    if (this.#closed || this.#sessions.get(sessionKey(session.scope, session.hello.connectorId)) !== session || session.socket.readyState !== WebSocket.OPEN) throw new OutboundCarrierError("outbound_connector_offline");
    const pairing = session.pairingId ? this.options.repository.getPairing(session.scope, session.pairingId) : undefined;
    if (!pairing || pairing.state !== "accepted" || pairing.revision !== session.pairingRevision || pairing.connectorId !== session.hello.connectorId) throw new Error("outbound_pairing_not_accepted");
    const revision = this.options.environmentRevision(session.scope, pairing.executionEnvironmentId);
    if (revision === undefined || revision !== session.environmentRevision) throw new Error("outbound_configuration_changed");
  }

  #assertTicket(ticket: RuntimeTicket): void {
    this.#assertCurrent(ticket.session);
    if (ticket.expiresAt <= Date.now() || ticket.session.pendingRuntime !== ticket || ticket.session.pairingId !== ticket.pairingId || ticket.session.pairingRevision !== ticket.pairingRevision || ticket.session.environmentRevision !== ticket.environmentRevision) throw new Error("outbound_ticket_invalid");
  }

  #settleTicket(ticket: RuntimeTicket): void {
    if (!ticket.stream || !ticket.installation) return;
    this.#assertTicket(ticket);
    ticket.cleanup();
    this.#tickets.delete(ticket.key);
    ticket.session.pendingRuntime = undefined;
    const stream = ticket.stream;
    ticket.session.runtime = stream;
    void stream.closed.then(() => { if (ticket.session.runtime === stream) ticket.session.runtime = undefined; });
    ticket.resolve({ ...stream, installation: ticket.installation });
  }

  #failTicket(ticket: RuntimeTicket, error: Error): void {
    if (ticket.session.pendingRuntime !== ticket) return;
    ticket.cleanup();
    this.#tickets.delete(ticket.key);
    ticket.session.pendingRuntime = undefined;
    try { this.#send(ticket.session, { type: "cancelAttach", ticket: ticket.token }); } catch { /* Closing control fences the connector's generation. */ }
    void ticket.stream?.close(error.message);
    ticket.reject(error);
  }

  #fenceRuntime(session: Session, reason: string): void {
    if (session.pendingRuntime) this.#failTicket(session.pendingRuntime, connectionFailure(reason));
    const stream = session.runtime;
    session.runtime = undefined;
    void stream?.close(reason);
    for (const [id, command] of session.commands) {
      command.cleanup();
      command.reject(connectionFailure(reason));
      try { this.#send(session, { type: "cancel", requestId: id }); } catch { /* Closing generation. */ }
    }
    session.commands.clear();
  }

  #remove(session: Session, reason: string): void {
    if (this.#sessions.get(sessionKey(session.scope, session.hello.connectorId)) !== session) return;
    this.#sessions.delete(sessionKey(session.scope, session.hello.connectorId));
    clearTimeout(session.registrationExpiry);
    this.#fenceRuntime(session, reason);
    this.#emit(session, false);
  }

  #send(session: Session, message: OutboundServerMessage): void {
    const bytes = JSON.stringify(outboundServerMessageSchema.parse(message));
    if (session.socket.readyState !== WebSocket.OPEN || Buffer.byteLength(bytes) > OUTBOUND_CONTROL_MAX_BYTES || session.socket.bufferedAmount > OUTBOUND_CONTROL_MAX_BYTES * 2) throw new OutboundCarrierError("outbound_control_write_unavailable");
    session.socket.send(bytes, { compress: false }, (error) => { if (error) { this.#remove(session, "outbound_control_write_failed"); session.socket.terminate(); } });
  }

  #emit(session: Session, connected: boolean): void {
    const lastSeenAt = new Date().toISOString();
    this.#lastSeen.set(sessionKey(session.scope, session.hello.connectorId), lastSeenAt);
    // Bound diagnostic observations after disconnected installations accumulate.
    if (this.#lastSeen.size > 1024) this.#lastSeen.delete(this.#lastSeen.keys().next().value!);
    const event = { scope: session.scope, connectorId: session.hello.connectorId, environmentId: session.environmentId, connected, generation: session.generation, lastSeenAt };
    for (const listener of this.#listeners) { try { listener(event); } catch { /* Observers cannot break admission. */ } }
  }
}

function sameScope(a: RequestScope, b: RequestScope): boolean { return a.tenantId === b.tenantId && a.principalId === b.principalId; }
function sessionKey(scope: RequestScope, connectorId: string): string { return JSON.stringify([scope.tenantId, scope.principalId, connectorId]); }
function digest(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function connectionFailure(reason: string): Error {
  return new Set(["outbound_control_disconnected", "outbound_control_error", "outbound_control_write_failed", "outbound_control_write_unavailable", "outbound_command_timeout", "outbound_runtime_timeout", "outbound_disconnected", "outbound_server_shutdown"]).has(reason)
    ? new OutboundCarrierError(reason) : new Error(reason);
}
