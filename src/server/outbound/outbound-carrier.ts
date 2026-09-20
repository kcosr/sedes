import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  OUTBOUND_CONTROL_MAX_BYTES, OUTBOUND_CONTROL_PATH, OUTBOUND_CONTROL_PROTOCOL,
  OUTBOUND_RUNTIME_CHUNK_BYTES, OUTBOUND_RUNTIME_PATH, OUTBOUND_RUNTIME_PROTOCOL,
  outboundClientMessageSchema, type OutboundClientMessage,
} from "../../internal/outbound-protocol.js";
import { rawBytes } from "../../internal/websocket-byte-stream.js";
import type { AppConfig } from "../config/config.js";
import { DomainError } from "../domain/errors.js";
import type { IdentityProvider, RequestScope } from "../identity/identity-provider.js";
import type { ApplicationDrainController, LongLivedHttpConnectionRegistry } from "../runtime/application-shutdown.js";
import { validateNativeWebSocketHost } from "../security/http-security.js";
import { OutboundConnectionRegistry } from "./outbound-connection-registry.js";

export interface OutboundAuthenticationAdmission {
  readonly required: boolean;
  authenticateSidecar(request: IncomingMessage): { id: string; connectorId?: string };
  trackClient(clientId: string, close: () => void): () => void;
}

/** Exact agent paths intentionally do not participate in browser WS admission. */
export function attachOutboundCarrier(server: Server, input: {
  config: AppConfig;
  authentication?: OutboundAuthenticationAdmission;
  identity: IdentityProvider<IncomingMessage>;
  registry: OutboundConnectionRegistry;
  connections?: LongLivedHttpConnectionRegistry;
  drain?: ApplicationDrainController;
  heartbeatMs?: number;
  helloTimeoutMs?: number;
}): { close(): Promise<void> } {
  const control = new WebSocketServer({ noServer: true, maxPayload: OUTBOUND_CONTROL_MAX_BYTES, perMessageDeflate: false, handleProtocols: () => OUTBOUND_CONTROL_PROTOCOL });
  const runtime = new WebSocketServer({ noServer: true, maxPayload: OUTBOUND_RUNTIME_CHUNK_BYTES, perMessageDeflate: false, handleProtocols: () => OUTBOUND_RUNTIME_PROTOCOL });
  const pending = new Set<Duplex>();
  let closing = false;
  const track = (socket: WebSocket, clientId?: string) => {
    const untrackAuth = clientId ? input.authentication?.trackClient(clientId, () => {
      socket.close(1008, "outbound_authentication_required_repair");
      const timer = setTimeout(() => socket.terminate(), 250);
      timer.unref();
    }) : undefined;
    socket.once("close", () => untrackAuth?.());
    const untrack = input.connections?.trackOwnedConnection(socket, () => socket.terminate());
    socket.once("close", () => untrack?.());
    socket.on("error", () => socket.terminate());
  };
  const connectControl = (socket: WebSocket, scope: RequestScope, actor?: { id: string; connectorId?: string }) => {
    track(socket, actor?.id);
    let connectorId: string | undefined;
    let alive = true;
    const helloTimer = setTimeout(() => {
      socket.close(1008, "outbound_hello_timeout");
      const force = setTimeout(() => socket.terminate(), 250);
      force.unref();
    }, input.helloTimeoutMs ?? 10_000);
    helloTimer.unref();
    socket.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive || socket.readyState !== WebSocket.OPEN) { socket.terminate(); return; }
      alive = false;
      socket.ping();
    }, input.heartbeatMs ?? 15_000);
    heartbeat.unref();
    socket.once("close", () => { clearInterval(heartbeat); clearTimeout(helloTimer); });
    socket.on("message", (data, binary) => {
      try {
        if (closing || input.drain?.isDraining) throw new Error("outbound_server_draining");
        if (binary) throw new Error("outbound_control_binary_invalid");
        let message: OutboundClientMessage;
        try { message = outboundClientMessageSchema.parse(JSON.parse(rawBytes(data).toString("utf8"))); }
        catch { throw new Error("outbound_protocol_invalid"); }
        if (!connectorId) {
          if (message.type !== "hello") throw new Error("outbound_hello_required");
          if (actor && message.connectorId !== actor.connectorId) throw new Error("outbound_authenticated_connector_mismatch");
          input.registry.register(scope, message, socket);
          connectorId = message.connectorId;
          clearTimeout(helloTimer);
        } else input.registry.receive(scope, connectorId, socket, message);
      } catch (cause) {
        const message = cause instanceof DomainError && cause.code === "conflict" ? "outbound_registration_conflict"
          : cause instanceof DomainError && cause.code === "not_found" ? "outbound_pairing_unavailable"
          : cause instanceof DomainError && cause.code === "bad_request" ? "outbound_registration_invalid"
          : cause instanceof Error && /^outbound_[a-z_]+$/u.test(cause.message) ? cause.message : "outbound_server_error";
        socket.close(1008, message.slice(0, 100));
        const timer = setTimeout(() => socket.terminate(), 250);
        timer.unref();
      }
    });
  };
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url !== OUTBOUND_CONTROL_PATH && request.url !== OUTBOUND_RUNTIME_PATH) return;
    if (closing || input.drain?.isDraining || pending.size >= 64 || control.clients.size >= 256 || validateNativeWebSocketHost(request, input.config)) { reject(socket); return; }
    const isControl = request.url === OUTBOUND_CONTROL_PATH;
    const protocols = (request.headers["sec-websocket-protocol"] ?? "").split(",").map((part) => part.trim());
    if (isControl ? protocols.length !== 1 || protocols[0] !== OUTBOUND_CONTROL_PROTOCOL : protocols.length !== 2 || protocols[0] !== OUTBOUND_RUNTIME_PROTOCOL || !/^[A-Za-z0-9_-]{43}$/u.test(protocols[1] ?? "")) { reject(socket); return; }
    let actor: { id: string; connectorId?: string } | undefined;
    try {
      actor = input.authentication?.required ? input.authentication.authenticateSidecar(request) : undefined;
      if (input.authentication?.required && !actor?.connectorId) throw new Error("outbound_authentication_required_repair");
    }
    catch { reject(socket, 401); return; }
    pending.add(socket);
    socket.pause();
    const timer = setTimeout(() => { pending.delete(socket); socket.destroy(); }, 10_000);
    timer.unref();
    void input.identity.resolve(request).then((scope) => {
      if (closing || socket.destroyed || input.drain?.isDraining) throw new Error("outbound_server_draining");
      // Revalidate after asynchronous identity resolution before consuming a ticket or upgrading.
      if (input.authentication?.required) input.authentication.authenticateSidecar(request);
      if (isControl) {
        control.handleUpgrade(request, socket, head, (webSocket) => {
          control.emit("connection", webSocket, request);
          connectControl(webSocket, scope, actor);
        });
      } else {
        const admit = input.registry.consumeRuntimeTicket(scope, protocols[1]!, actor?.connectorId);
        runtime.handleUpgrade(request, socket, head, (webSocket) => {
          runtime.emit("connection", webSocket, request);
          track(webSocket, actor?.id);
          admit(webSocket);
        });
      }
      socket.resume();
    }).catch(() => reject(socket)).finally(() => { clearTimeout(timer); pending.delete(socket); });
  };
  server.on("upgrade", onUpgrade);
  let closePromise: Promise<void> | undefined;
  return {
    close() {
      if (closePromise) return closePromise;
      closing = true;
      server.off("upgrade", onUpgrade);
      for (const socket of pending) socket.destroy();
      pending.clear();
      input.registry.close();
      for (const socket of [...control.clients, ...runtime.clients]) socket.terminate();
      closePromise = Promise.all([new Promise<void>((resolve) => control.close(() => resolve())), new Promise<void>((resolve) => runtime.close(() => resolve()))]).then(() => {});
      return closePromise;
    },
  };
}

function reject(socket: Duplex, status = 403): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Forbidden"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const timer = setTimeout(() => socket.destroy(), 250);
  timer.unref();
}
