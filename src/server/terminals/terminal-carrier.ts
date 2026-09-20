import type { AuthenticationAdmission } from "../authentication/authentication-admission.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  TERMINAL_WEBSOCKET_PATH,
  TERMINAL_WEBSOCKET_PROTOCOL,
  decodeTerminalBinaryFrame,
  encodeTerminalBinaryFrame,
  terminalClientFrameSchema,
  terminalServerFrameSchema,
  type CreateTerminalAdmissionRequest,
  type TerminalAdmission,
  type TerminalClientFrame,
  type TerminalServerFrame,
} from "../../shared/protocol/terminals.js";
import type { AppConfig } from "../config/config.js";
import type {
  IdentityProvider,
  RequestScope,
} from "../identity/identity-provider.js";
import type {
  ApplicationDrainController,
  LongLivedHttpConnectionRegistry,
} from "../runtime/application-shutdown.js";
import { validateWebSocketHostOrigin } from "../security/http-security.js";
import { TerminalService } from "./terminal-service.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ADMISSION_TTL_MILLISECONDS = 15_000;
const MAX_OUTSTANDING_ADMISSIONS = 1_024;
const MAX_FRAME_BYTES = 96 * 1024;
const MAX_BUFFERED_BYTES = 512 * 1024;
const MAX_PENDING_CLIENT_FRAMES = 32;
const MAX_PENDING_CLIENT_BYTES = 256 * 1024;

type AdmissionRecord = {
  readonly scope: RequestScope;
  readonly terminalId: string;
  readonly incarnationId: string;
  readonly attachmentId: string;
  readonly producerId: string;
  readonly requestedRole: "controller" | "observer";
  readonly restore: CreateTerminalAdmissionRequest["restore"];
  readonly expiresAtMilliseconds: number;
};

export class TerminalAdmissionTokens {
  readonly #service: TerminalService;
  readonly #records = new Map<string, AdmissionRecord>();

  constructor(service: TerminalService) {
    this.#service = service;
  }

  issue(input: {
    readonly scope: RequestScope;
    readonly terminalId: string;
    readonly producerId: string;
    readonly requestedRole: "controller" | "observer";
    readonly restore: CreateTerminalAdmissionRequest["restore"];
  }): TerminalAdmission {
    const terminal = this.#service.get(input.scope, input.terminalId);
    if (!terminal.incarnationId || terminal.lifecycle === "reserved") {
      throw new Error("terminal_admission_unavailable");
    }
    this.#prune();
    if (this.#records.size >= MAX_OUTSTANDING_ADMISSIONS) {
      throw new Error("terminal_admission_capacity_exceeded");
    }
    const token = randomBytes(32).toString("base64url");
    const attachmentId = randomUUID();
    const expiresAtMilliseconds = Date.now() + ADMISSION_TTL_MILLISECONDS;
    this.#records.set(digest(token), {
      scope: Object.freeze({ ...input.scope }),
      terminalId: input.terminalId,
      incarnationId: terminal.incarnationId,
      attachmentId,
      producerId: input.producerId,
      requestedRole: input.requestedRole,
      restore: input.restore,
      expiresAtMilliseconds,
    });
    return {
      token,
      expiresAt: new Date(expiresAtMilliseconds).toISOString(),
      terminalId: input.terminalId,
      incarnationId: terminal.incarnationId,
      attachmentId,
    };
  }

  consume(token: string, scope: RequestScope): AdmissionRecord {
    if (!TOKEN_PATTERN.test(token)) throw new Error("terminal_admission_invalid");
    const key = digest(token);
    const record = this.#records.get(key);
    this.#records.delete(key);
    if (
      !record ||
      record.expiresAtMilliseconds <= Date.now() ||
      record.scope.tenantId !== scope.tenantId ||
      record.scope.principalId !== scope.principalId
    ) {
      throw new Error("terminal_admission_invalid");
    }
    return record;
  }

  #prune(): void {
    const now = Date.now();
    for (const [key, record] of this.#records) {
      if (record.expiresAtMilliseconds <= now) this.#records.delete(key);
    }
  }
}

export function attachTerminalCarrier(
  server: Server,
  input: {
    readonly config: AppConfig;
    readonly identity: IdentityProvider<IncomingMessage>;
    readonly admissions: TerminalAdmissionTokens;
    readonly authentication?: AuthenticationAdmission;
    readonly service: TerminalService;
    readonly connections: LongLivedHttpConnectionRegistry;
    readonly drain?: ApplicationDrainController;
  },
): { close(): Promise<void> } {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    handleProtocols(protocols) {
      return protocols.has(TERMINAL_WEBSOCKET_PROTOCOL)
        ? TERMINAL_WEBSOCKET_PROTOCOL
        : false;
    },
  });
  let closing = false;
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url !== TERMINAL_WEBSOCKET_PATH) return;
    socket.pause();
    void authorize(request)
      .then(({ record, clientId }) => {
        if (closing) throw new Error("terminal_carrier_closing");
        sockets.handleUpgrade(request, socket, head, (webSocket) => {
          sockets.emit("connection", webSocket, request, record, clientId);
        });
        socket.resume();
      })
      .catch(() => reject(socket));
  };
  const authorize = async (request: IncomingMessage): Promise<{ readonly record: AdmissionRecord; readonly clientId?: string }> => {
    if (input.drain?.isDraining) throw new Error("terminal_application_draining");
    if (validateWebSocketHostOrigin(request, input.config)) {
      throw new Error("terminal_origin_invalid");
    }
    const token = requestedToken(request);
    const scope = await input.identity.resolve(request);
    const client = input.authentication?.required ? input.authentication.consumeTicket(token) : undefined;
    return { record: input.admissions.consume(token, scope), ...(client ? { clientId: client.id } : {}) };
  };
  sockets.on(
    "connection",
    (webSocket: WebSocket, _request: IncomingMessage, record: AdmissionRecord, clientId?: string) => {
      let closed = false;
      let session: Awaited<ReturnType<TerminalService["attach"]>> | undefined;
      let inbound = Promise.resolve();
      let pendingFrames = 0;
      let pendingBytes = 0;
      let queuedResize: {
        frame: TerminalClientFrame;
        byteLength: number;
      } | undefined;
      let pendingOutputAck:
        | Extract<TerminalClientFrame, { readonly type: "ack_output" }>
        | undefined;
      let outputAckQueued = false;
      let untrackAuthentication: () => void = () => undefined;
      const untrack = input.connections.trackOwnedConnection(webSocket, () =>
        webSocket.close(1001, "server_shutdown"),
      );
      const close = () => {
        if (closed) return;
        closed = true;
        untrack();
        untrackAuthentication();
        session?.close();
      };
      webSocket.once("close", close);
      webSocket.once("error", close);
      if (clientId) {
        untrackAuthentication = input.authentication!.trackClient(clientId, () => {
          close();
          webSocket.terminate();
        });
      }
      if (closed) return;
      const emit = (frame: TerminalServerFrame) => {
        if (closed || webSocket.readyState !== WebSocket.OPEN) return;
        if (webSocket.bufferedAmount > MAX_BUFFERED_BYTES) {
          webSocket.close(1013, "viewer_too_slow");
          return;
        }
        const validated = terminalServerFrameSchema.parse(frame);
        if (validated.type === "output") {
          const { data, ...header } = validated;
          webSocket.send(
            encodeTerminalBinaryFrame(
              "output",
              header,
              Buffer.from(data, "base64url"),
            ),
            { binary: true },
          );
        } else if (validated.type === "terminal_removed") {
          webSocket.send(JSON.stringify(validated), (error) => {
            if (closed) return;
            if (error) webSocket.terminate();
            else webSocket.close(1000, "terminal_removed");
          });
        } else {
          webSocket.send(JSON.stringify(validated));
        }
      };
      const sessionPromise = Promise.resolve()
        .then(() => {
          if (closed) throw new Error("terminal_viewer_closed");
          return input.service.attach({ ...record, emit });
        })
        .then((attached) => {
          if (closed) {
            attached.close();
            throw new Error("terminal_viewer_closed");
          }
          session = attached;
          return attached;
        })
        .catch((error) => {
          if (!closed && webSocket.readyState === WebSocket.OPEN) {
            webSocket.close(1008, "terminal_unavailable");
          }
          throw error;
        });
      void sessionPromise.catch(() => undefined);

      const closeForProtocolError = () => {
        if (!closed && webSocket.readyState === WebSocket.OPEN) {
          webSocket.close(1008, "protocol_error");
        }
      };

      const queueOutputAck = (
        frame: Extract<TerminalClientFrame, { readonly type: "ack_output" }>,
      ) => {
        if (
          !pendingOutputAck ||
          frame.appliedSeq > pendingOutputAck.appliedSeq
        ) {
          pendingOutputAck = frame;
        }
        if (outputAckQueued) return;
        outputAckQueued = true;
        let dispatched = false;
        inbound = inbound
          .then(async () => {
            if (closed) return;
            const attached = await sessionPromise;
            const ack = pendingOutputAck;
            pendingOutputAck = undefined;
            if (ack) {
              await attached.dispatch(ack);
              dispatched = true;
            }
          })
          .catch(() => {
            pendingOutputAck = undefined;
            closeForProtocolError();
          })
          .finally(() => {
            outputAckQueued = false;
            if (
              dispatched &&
              pendingOutputAck &&
              !closed &&
              webSocket.readyState === WebSocket.OPEN
            ) {
              queueOutputAck(pendingOutputAck);
            }
          });
      };

      webSocket.on("message", (data, isBinary) => {
        let parsed: TerminalClientFrame;
        let byteLength: number;
        try {
          const bytes = rawBytes(data);
          byteLength = bytes.byteLength;
          parsed = parseClientFrame(data, isBinary);
        } catch {
          closeForProtocolError();
          return;
        }
        if (parsed.type === "ack_output") {
          queueOutputAck(parsed);
          return;
        }
        // Keyboard animations can outpace a remote window-change round trip.
        // Replace only adjacent, undispatched sizes from the same controller;
        // input and authority changes must retain their position in the queue.
        if (
          parsed.type === "resize" && queuedResize?.frame.type === "resize" &&
          queuedResize.frame.terminalId === parsed.terminalId &&
          queuedResize.frame.incarnationId === parsed.incarnationId &&
          queuedResize.frame.controllerEpoch === parsed.controllerEpoch
        ) {
          const nextPendingBytes = pendingBytes - queuedResize.byteLength + byteLength;
          if (nextPendingBytes > MAX_PENDING_CLIENT_BYTES) {
            closeForProtocolError();
            return;
          }
          pendingBytes = nextPendingBytes;
          queuedResize.frame = parsed;
          queuedResize.byteLength = byteLength;
          return;
        }
        if (
          pendingFrames >= MAX_PENDING_CLIENT_FRAMES ||
          pendingBytes + byteLength > MAX_PENDING_CLIENT_BYTES
        ) {
          closeForProtocolError();
          return;
        }
        pendingFrames += 1;
        pendingBytes += byteLength;
        const queued = { frame: parsed, byteLength };
        queuedResize = parsed.type === "resize" ? queued : undefined;
        inbound = inbound
          .then(async () => {
            if (closed) return;
            const attached = await sessionPromise;
            if (queuedResize === queued) queuedResize = undefined;
            await attached.dispatch(queued.frame);
          })
          .catch(closeForProtocolError)
          .finally(() => {
            if (queuedResize === queued) queuedResize = undefined;
            pendingFrames -= 1;
            pendingBytes -= queued.byteLength;
          });
      });
    },
  );
  server.on("upgrade", onUpgrade);
  let closePromise: Promise<void> | undefined;
  return {
    close() {
      if (closePromise) return closePromise;
      closing = true;
      server.off("upgrade", onUpgrade);
      for (const client of sockets.clients) {
        client.close(1001, "server_shutdown");
        const force = setTimeout(() => {
          if (client.readyState !== WebSocket.CLOSED) client.terminate();
        }, 250);
        force.unref();
      }
      closePromise = new Promise<void>((resolve) => sockets.close(() => resolve()));
      return closePromise;
    },
  };
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function requestedToken(request: IncomingMessage): string {
  const protocols = (request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((entry) => entry.trim());
  if (
    protocols.length !== 2 ||
    protocols[0] !== TERMINAL_WEBSOCKET_PROTOCOL ||
    !TOKEN_PATTERN.test(protocols[1] ?? "")
  ) {
    throw new Error("terminal_admission_invalid");
  }
  return protocols[1]!;
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString();
}

function rawBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function parseClientFrame(data: RawData, isBinary: boolean): TerminalClientFrame {
  let parsed: unknown;
  if (isBinary) {
    const binary = decodeTerminalBinaryFrame(rawBytes(data));
    if (
      binary.kind !== "input" ||
      typeof binary.header !== "object" ||
      binary.header === null ||
      Array.isArray(binary.header)
    ) {
      throw new Error("terminal_protocol_error");
    }
    parsed = {
      ...binary.header,
      data: Buffer.from(binary.payload).toString("base64url"),
    };
  } else {
    parsed = JSON.parse(rawText(data));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { readonly type?: unknown }).type === "input"
    ) {
      throw new Error("terminal_input_must_be_binary");
    }
  }
  return terminalClientFrameSchema.parse(parsed);
}

function reject(socket: Duplex): void {
  if (!socket.destroyed) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  }
}
