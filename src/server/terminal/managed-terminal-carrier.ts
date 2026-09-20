import type { AuthenticationAdmission } from "../authentication/authentication-admission.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { RequestHandler } from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { threadRouteParametersSchema } from "../../shared/protocol/api.js";
import type { AppConfig } from "../config/config.js";
import { ApiError } from "../http/errors.js";
import type {
  IdentityProvider,
  RequestScope,
} from "../identity/identity-provider.js";
import type {
  ApplicationDrainController,
  LongLivedHttpConnectionRegistry,
} from "../runtime/application-shutdown.js";
import { validateWebSocketHostOrigin } from "../security/http-security.js";

export const MANAGED_TERMINAL_ADMISSION_ROUTE =
  "/api/threads/:threadId/provider-features/codex.tui/terminal-admission";
export const MANAGED_TERMINAL_WEBSOCKET_PATH = "/api/provider-feature-terminal";
export const MANAGED_TERMINAL_WEBSOCKET_PROTOCOL = "sedes.codex-tui.v1";

const DEFAULT_ADMISSION_TTL_MILLISECONDS = 15_000;
const DEFAULT_MAX_OUTSTANDING_ADMISSIONS = 1_024;
const DEFAULT_MAX_CLIENT_FRAME_BYTES = 96 * 1024;
const DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = 512 * 1024;
const MAX_PENDING_CLIENT_FRAMES = 32;
const MAX_PENDING_CLIENT_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
export const MANAGED_TERMINAL_MIN_COLUMNS = 2;
export const MANAGED_TERMINAL_MAX_COLUMNS = 512;
export const MANAGED_TERMINAL_MIN_ROWS = 1;
export const MANAGED_TERMINAL_MAX_ROWS = 256;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type ManagedTerminalCarrierErrorCode =
  | "admission_invalid"
  | "generation_changed"
  | "protocol_error"
  | "resync_failed"
  | "viewer_too_slow"
  | "terminal_unavailable";

export class ManagedTerminalCarrierError extends Error {
  constructor(
    readonly code: ManagedTerminalCarrierErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ManagedTerminalCarrierError";
  }
}

export type ManagedTerminalServerEvent =
  | { readonly type: "output"; readonly bytes: Uint8Array }
  | { readonly type: "sync_started" }
  | {
      readonly type: "ready";
      readonly columns: number;
      readonly rows: number;
    }
  | {
      readonly type: "exit";
      readonly exitCode: number | null;
      readonly signal: string | null;
    }
  | { readonly type: "resync_required" }
  | {
      readonly type: "error";
      readonly code: ManagedTerminalCarrierErrorCode;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface ManagedTerminalViewerSession {
  sendInput(bytes: Uint8Array): void | Promise<void>;
  resize(input: {
    readonly columns: number;
    readonly rows: number;
  }): void | Promise<void>;
  requestSync(): void | Promise<void>;
  requestRefit(input: {
    readonly columns: number;
    readonly rows: number;
  }): void | Promise<void>;
  close(): void | Promise<void>;
}

/**
 * Provider-neutral carrier adapter. The provider owns resource eligibility,
 * process lifecycle, the sole PTY reader, and fanout. The carrier owns only
 * browser admission and one authorized viewer transport.
 */
export interface ManagedTerminalResourceAuthority {
  authorizeAdmission(input: {
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
  }): Promise<{ readonly resourceGeneration: number }>;
  attachViewer(
    input: {
      readonly scope: RequestScope;
      readonly applicationThreadId: string;
      readonly resourceGeneration: number;
      readonly viewerId: string;
    },
    emit: (event: ManagedTerminalServerEvent) => void,
  ): Promise<ManagedTerminalViewerSession>;
}

interface AdmissionRecord {
  readonly scope: RequestScope;
  readonly applicationThreadId: string;
  readonly resourceGeneration: number;
  readonly viewerId: string;
  readonly expiresAtMilliseconds: number;
}

export interface ManagedTerminalAdmission {
  readonly token: string;
  readonly expiresAt: string;
  readonly resourceGeneration: number;
}

export class ManagedTerminalAdmissionTokens {
  readonly #authority: ManagedTerminalResourceAuthority;
  readonly #ttlMilliseconds: number;
  readonly #maxOutstanding: number;
  readonly #now: () => number;
  readonly #records = new Map<string, AdmissionRecord>();

  constructor(
    authority: ManagedTerminalResourceAuthority,
    input: {
      readonly ttlMilliseconds?: number;
      readonly maxOutstanding?: number;
      readonly now?: () => number;
    } = {},
  ) {
    this.#authority = authority;
    this.#ttlMilliseconds =
      input.ttlMilliseconds ?? DEFAULT_ADMISSION_TTL_MILLISECONDS;
    this.#maxOutstanding =
      input.maxOutstanding ?? DEFAULT_MAX_OUTSTANDING_ADMISSIONS;
    this.#now = input.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.#ttlMilliseconds) ||
      this.#ttlMilliseconds <= 0 ||
      !Number.isSafeInteger(this.#maxOutstanding) ||
      this.#maxOutstanding <= 0
    ) {
      throw new Error("managed_terminal_admission_configuration_invalid");
    }
  }

  async issue(input: {
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
  }): Promise<ManagedTerminalAdmission> {
    const { threadId: applicationThreadId } = threadRouteParametersSchema.parse(
      {
        threadId: input.applicationThreadId,
      },
    );
    const { resourceGeneration } = await this.#authority.authorizeAdmission({
      scope: input.scope,
      applicationThreadId,
    });
    assertGeneration(resourceGeneration);
    const now = this.#now();
    this.#prune(now);
    if (this.#records.size >= this.#maxOutstanding) {
      throw new ManagedTerminalCarrierError(
        "terminal_unavailable",
        "Too many terminal viewers are awaiting admission.",
        true,
      );
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAtMilliseconds = now + this.#ttlMilliseconds;
    this.#records.set(tokenDigest(token), {
      scope: Object.freeze({ ...input.scope }),
      applicationThreadId,
      resourceGeneration,
      viewerId: randomUUID(),
      expiresAtMilliseconds,
    });
    return {
      token,
      expiresAt: new Date(expiresAtMilliseconds).toISOString(),
      resourceGeneration,
    };
  }

  /** Consumes before attach so retries can never race into two viewers. */
  consume(token: string, scope: RequestScope): AdmissionRecord {
    if (!TOKEN_PATTERN.test(token)) throw invalidAdmission();
    const digest = tokenDigest(token);
    const record = this.#records.get(digest);
    this.#records.delete(digest);
    if (
      !record ||
      record.expiresAtMilliseconds <= this.#now() ||
      record.scope.tenantId !== scope.tenantId ||
      record.scope.principalId !== scope.principalId
    ) {
      throw invalidAdmission();
    }
    return record;
  }

  get size(): number {
    this.#prune(this.#now());
    return this.#records.size;
  }

  #prune(now: number): void {
    for (const [digest, record] of this.#records) {
      if (record.expiresAtMilliseconds <= now) this.#records.delete(digest);
    }
  }
}

export function createManagedTerminalAdmissionHandler(input: {
  readonly identity: IdentityProvider<Parameters<RequestHandler>[0]>;
  readonly admissions: ManagedTerminalAdmissionTokens;
  readonly authentication?: AuthenticationAdmission;
  readonly drain?: ApplicationDrainController;
}): RequestHandler {
  return async (request, response, next) => {
    try {
      if (input.drain?.isDraining) {
        throw new ApiError(
          503,
          "application_draining",
          "The application is shutting down.",
          true,
        );
      }
      const scope = await input.identity.resolve(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const client = input.authentication?.required ? input.authentication.clientForRequest(request) : undefined;
      if (input.authentication?.required && !client) {
        throw new ApiError(401, "unauthorized", "Pair this client before connecting.");
      }
      const admission = await input.admissions.issue({
        scope,
        applicationThreadId: threadId,
      });
      if (client) {
        input.authentication!.bindTicket(
          admission.token, client.id, Date.parse(admission.expiresAt),
        );
      }
      response.setHeader("Cache-Control", "no-store");
      response.status(201).json(admission);
    } catch (error) {
      if (error instanceof ManagedTerminalCarrierError) {
        const invalidTransition =
          error.code === "admission_invalid" ||
          error.code === "generation_changed";
        const safeMessage = invalidTransition
          ? "The managed terminal changed before admission completed."
          : "The managed terminal is unavailable.";
        next(
          new ApiError(
            error.code === "admission_invalid"
              ? 403
              : invalidTransition
                ? 409
                : 503,
            invalidTransition ? "invalid_transition" : "runtime_unavailable",
            safeMessage,
            error.retryable,
          ),
        );
        return;
      }
      next(error);
    }
  };
}

const inputFrameSchema = z
  .object({
    v: z.literal(1),
    type: z.literal("input"),
    data: z
      .string()
      .max(90_000)
      .regex(/^[A-Za-z0-9_-]*$/),
  })
  .strict();
const resizeFrameSchema = z
  .object({
    v: z.literal(1),
    type: z.literal("resize"),
    columns: z
      .number()
      .int()
      .min(MANAGED_TERMINAL_MIN_COLUMNS)
      .max(MANAGED_TERMINAL_MAX_COLUMNS),
    rows: z
      .number()
      .int()
      .min(MANAGED_TERMINAL_MIN_ROWS)
      .max(MANAGED_TERMINAL_MAX_ROWS),
  })
  .strict();
const requestSyncFrameSchema = z
  .object({ v: z.literal(1), type: z.literal("request_sync") })
  .strict();
const requestRefitFrameSchema = z
  .object({
    v: z.literal(1),
    type: z.literal("request_refit"),
    columns: z
      .number()
      .int()
      .min(MANAGED_TERMINAL_MIN_COLUMNS)
      .max(MANAGED_TERMINAL_MAX_COLUMNS),
    rows: z
      .number()
      .int()
      .min(MANAGED_TERMINAL_MIN_ROWS)
      .max(MANAGED_TERMINAL_MAX_ROWS),
  })
  .strict();
const clientFrameSchema = z.discriminatedUnion("type", [
  inputFrameSchema,
  resizeFrameSchema,
  requestSyncFrameSchema,
  requestRefitFrameSchema,
]);
type ClientFrame = z.infer<typeof clientFrameSchema>;

export interface ManagedTerminalCarrier {
  close(): Promise<void>;
}

export function attachManagedTerminalCarrier(
  server: Server,
  input: {
    readonly config: AppConfig;
    readonly identity: IdentityProvider<IncomingMessage>;
    readonly admissions: ManagedTerminalAdmissionTokens;
    readonly authentication?: AuthenticationAdmission;
    readonly authority: ManagedTerminalResourceAuthority;
    readonly connections: LongLivedHttpConnectionRegistry;
    readonly drain?: ApplicationDrainController;
    readonly maxClientFrameBytes?: number;
    readonly maxBufferedOutputBytes?: number;
  },
): ManagedTerminalCarrier {
  const maxClientFrameBytes =
    input.maxClientFrameBytes ?? DEFAULT_MAX_CLIENT_FRAME_BYTES;
  const maxBufferedOutputBytes =
    input.maxBufferedOutputBytes ?? DEFAULT_MAX_BUFFERED_OUTPUT_BYTES;
  if (
    !Number.isSafeInteger(maxClientFrameBytes) ||
    maxClientFrameBytes <= 0 ||
    !Number.isSafeInteger(maxBufferedOutputBytes) ||
    maxBufferedOutputBytes <= 0
  ) {
    throw new Error("managed_terminal_carrier_configuration_invalid");
  }
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: maxClientFrameBytes,
    perMessageDeflate: false,
    handleProtocols(protocols) {
      return protocols.has(MANAGED_TERMINAL_WEBSOCKET_PROTOCOL)
        ? MANAGED_TERMINAL_WEBSOCKET_PROTOCOL
        : false;
    },
  });

  let closing = false;
  const onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    if (request.url !== MANAGED_TERMINAL_WEBSOCKET_PATH) return;
    socket.pause();
    void authorizeUpgrade(request)
      .then(({ record, clientId }) => {
        if (closing) throw invalidAdmission();
        webSockets.handleUpgrade(request, socket, head, (webSocket) => {
          webSockets.emit("connection", webSocket, request, record, clientId);
        });
        socket.resume();
      })
      .catch(() => rejectUpgrade(socket));
  };

  const authorizeUpgrade = async (
    request: IncomingMessage,
  ): Promise<{ readonly record: AdmissionRecord; readonly clientId?: string }> => {
    if (input.drain?.isDraining) throw invalidAdmission();
    const securityRejection = validateWebSocketHostOrigin(
      request,
      input.config,
    );
    if (securityRejection) throw invalidAdmission();
    const token = requestedAdmissionToken(request);
    const scope = await input.identity.resolve(request);
    const client = input.authentication?.required ? input.authentication.consumeTicket(token) : undefined;
    return { record: input.admissions.consume(token, scope), ...(client ? { clientId: client.id } : {}) };
  };

  webSockets.on(
    "connection",
    (
      webSocket: WebSocket,
      _request: IncomingMessage,
      record: AdmissionRecord,
      clientId?: string,
    ) => {
      let session: ManagedTerminalViewerSession | undefined;
      let closed = false;
      let inbound = Promise.resolve();
      let acceptingClientFrames = true;
      let pendingClientFrames = 0;
      let pendingClientBytes = 0;
      let untrackAuthentication: () => void = () => undefined;
      let untrack: () => void = () => undefined;
      const closeSession = () => {
        if (closed) return;
        closed = true;
        untrack();
        untrackAuthentication();
        void Promise.resolve(session?.close()).catch(() => undefined);
      };
      webSocket.once("close", closeSession);
      webSocket.once("error", closeSession);
      untrack = input.connections.trackOwnedConnection(webSocket, () =>
        closeWebSocketBounded(webSocket),
      );
      if (clientId) {
        untrackAuthentication = input.authentication!.trackClient(clientId, () => {
          closeSession();
          webSocket.terminate();
        });
      }
      if (closed || webSocket.readyState !== WebSocket.OPEN) {
        closeSession();
        return;
      }

      const emit = (event: ManagedTerminalServerEvent) => {
        if (closed || webSocket.readyState !== WebSocket.OPEN) return;
        if (
          webSocket.bufferedAmount > maxBufferedOutputBytes ||
          (event.type === "output" &&
            event.bytes.byteLength > maxBufferedOutputBytes)
        ) {
          sendControl(webSocket, {
            v: 1,
            type: "error",
            code: "viewer_too_slow",
            message: "The terminal viewer fell behind.",
            retryable: true,
          });
          webSocket.close(1013, "viewer_too_slow");
          return;
        }
        if (event.type === "output") {
          webSocket.send(event.bytes, { binary: true });
          return;
        }
        sendControl(webSocket, serverControlFrame(event));
        if (event.type === "error") {
          acceptingClientFrames = false;
          webSocket.close(event.retryable ? 1013 : 1008, event.code);
        } else if (event.type === "exit") {
          acceptingClientFrames = false;
          webSocket.close(1000, "terminal_exit");
        }
      };

      const sessionPromise = input.authority
        .attachViewer(
          {
            scope: record.scope,
            applicationThreadId: record.applicationThreadId,
            resourceGeneration: record.resourceGeneration,
            viewerId: record.viewerId,
          },
          emit,
        )
        .then((attachedSession) => {
          if (closed) {
            void Promise.resolve(attachedSession.close()).catch(
              () => undefined,
            );
            return undefined;
          }
          session = attachedSession;
          return attachedSession;
        })
        .catch((error) => {
          if (closed) return undefined;
          const carrierError = asCarrierError(error);
          sendControl(webSocket, {
            v: 1,
            type: "error",
            code: carrierError.code,
            message: boundedTerminalMessage(carrierError.message),
            retryable: carrierError.retryable,
          });
          webSocket.close(1008, carrierError.code);
          return undefined;
        });
      // Install immediately: browsers may request synchronization as soon as
      // the WebSocket opens, before a remote resource finishes viewer attach.
      webSocket.on("message", (data, isBinary) => {
        if (!acceptingClientFrames) return;
        const frameBytes = rawDataByteLength(data);
        if (
          pendingClientFrames >= MAX_PENDING_CLIENT_FRAMES ||
          pendingClientBytes + frameBytes > MAX_PENDING_CLIENT_BYTES
        ) {
          acceptingClientFrames = false;
          sendControl(webSocket, {
            v: 1,
            type: "error",
            code: "protocol_error",
            message: "The terminal viewer sent input too quickly.",
            retryable: false,
          });
          webSocket.close(1008, "protocol_error");
          return;
        }
        pendingClientFrames += 1;
        pendingClientBytes += frameBytes;
        inbound = inbound
          .then(async () => {
            if (closed || webSocket.readyState !== WebSocket.OPEN) return;
            const attachedSession = await sessionPromise;
            if (closed || !attachedSession) return;
            await dispatchClientFrame(attachedSession, data, isBinary);
          })
          .catch((error) => {
            if (webSocket.readyState !== WebSocket.OPEN) return;
            acceptingClientFrames = false;
            const carrierError = asCarrierError(error);
            sendControl(webSocket, {
              v: 1,
              type: "error",
              code: carrierError.code,
              message: boundedTerminalMessage(carrierError.message),
              retryable: carrierError.retryable,
            });
            webSocket.close(1008, carrierError.code);
          })
          .finally(() => {
            pendingClientFrames -= 1;
            pendingClientBytes -= frameBytes;
          });
      });
    },
  );

  server.on("upgrade", onUpgrade);
  let closePromise: Promise<void> | undefined;
  return {
    close() {
      closePromise ??= new Promise<void>((resolve) => {
        closing = true;
        server.off("upgrade", onUpgrade);
        for (const client of webSockets.clients) {
          closeWebSocketBounded(client);
        }
        webSockets.close(() => resolve());
      });
      return closePromise;
    },
  };
}

async function dispatchClientFrame(
  session: ManagedTerminalViewerSession,
  data: RawData,
  isBinary: boolean,
): Promise<void> {
  if (isBinary) throw protocolError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    throw protocolError();
  }
  const result = clientFrameSchema.safeParse(parsed);
  if (!result.success) throw protocolError();
  const frame: ClientFrame = result.data;
  switch (frame.type) {
    case "input": {
      const bytes = decodeInput(frame.data);
      await session.sendInput(bytes);
      return;
    }
    case "resize":
      await session.resize({ columns: frame.columns, rows: frame.rows });
      return;
    case "request_sync":
      await session.requestSync();
      return;
    case "request_refit":
      await session.requestRefit({
        columns: frame.columns,
        rows: frame.rows,
      });
  }
}

function decodeInput(encoded: string): Uint8Array {
  if (!encoded || encoded.length % 4 === 1) throw protocolError();
  const bytes = Buffer.from(encoded, "base64url");
  if (
    bytes.byteLength > MAX_INPUT_BYTES ||
    bytes.toString("base64url") !== encoded
  ) {
    throw protocolError();
  }
  return bytes;
}

function serverControlFrame(
  event: Exclude<ManagedTerminalServerEvent, { readonly type: "output" }>,
): Record<string, unknown> {
  switch (event.type) {
    case "sync_started":
      return { v: 1, type: event.type };
    case "ready":
      return {
        v: 1,
        type: event.type,
        columns: event.columns,
        rows: event.rows,
      };
    case "exit":
      return {
        v: 1,
        type: event.type,
        exitCode: event.exitCode,
        signal: event.signal,
      };
    case "resync_required":
      return { v: 1, type: event.type };
    case "error":
      return {
        v: 1,
        ...event,
        message: boundedTerminalMessage(event.message),
      };
  }
}

function sendControl(webSocket: WebSocket, frame: object): void {
  if (webSocket.readyState !== WebSocket.OPEN) return;
  webSocket.send(JSON.stringify(frame), { binary: false });
}

function requestedAdmissionToken(request: IncomingMessage): string {
  const protocols = (request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((value) => value.trim());
  if (
    protocols.length !== 2 ||
    protocols[0] !== MANAGED_TERMINAL_WEBSOCKET_PROTOCOL ||
    !protocols[1] ||
    !TOKEN_PATTERN.test(protocols[1])
  ) {
    throw invalidAdmission();
  }
  return protocols[1];
}

function rejectUpgrade(socket: Duplex): void {
  if (!socket.destroyed) {
    socket.end(
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  }
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

function closeWebSocketBounded(webSocket: WebSocket): void {
  if (webSocket.readyState === WebSocket.CLOSED) return;
  webSocket.close(1001, "server_shutdown");
  const force = setTimeout(() => {
    if (webSocket.readyState !== WebSocket.CLOSED) webSocket.terminate();
  }, 250);
  force.unref();
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function assertGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("managed_terminal_resource_generation_invalid");
  }
}

function invalidAdmission(): ManagedTerminalCarrierError {
  return new ManagedTerminalCarrierError(
    "admission_invalid",
    "The terminal admission is invalid or expired.",
    true,
  );
}

function protocolError(): ManagedTerminalCarrierError {
  return new ManagedTerminalCarrierError(
    "protocol_error",
    "The terminal viewer sent an invalid frame.",
    false,
  );
}

function asCarrierError(error: unknown): ManagedTerminalCarrierError {
  return error instanceof ManagedTerminalCarrierError
    ? error
    : new ManagedTerminalCarrierError(
        "terminal_unavailable",
        "The managed terminal is unavailable.",
        true,
      );
}

function boundedTerminalMessage(message: string): string {
  const normalized = message.trim();
  return normalized
    ? normalized.slice(0, 1_024)
    : "The managed terminal is unavailable.";
}
