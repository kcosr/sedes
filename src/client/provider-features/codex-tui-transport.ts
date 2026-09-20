import { z } from "zod";
import type { ApiClient } from "../api/ApiClient.js";

const terminalServerFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ v: z.literal(1), type: z.literal("sync_started") }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal("ready"),
    columns: z.number().int().min(2).max(512),
    rows: z.number().int().positive().max(256),
  }),
  z
    .strictObject({
      v: z.literal(1),
      type: z.literal("exit"),
      exitCode: z.number().int().min(0).max(255).nullable(),
      signal: z.string().min(1).max(32).nullable(),
    })
    .refine(
      ({ exitCode, signal }) => exitCode === null || signal === null,
      "At most one terminal exit status may be present.",
    ),
  z.strictObject({ v: z.literal(1), type: z.literal("resync_required") }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal("error"),
    code: z.enum([
      "admission_invalid",
      "generation_changed",
      "protocol_error",
      "resync_failed",
      "viewer_too_slow",
      "terminal_unavailable",
    ]),
    message: z.string().min(1).max(1_024),
    retryable: z.boolean(),
  }),
]);

export type CodexTuiConnectionState =
  | "idle"
  | "authorizing"
  | "connecting"
  | "synchronizing"
  | "ready"
  | "reconnecting"
  | "exited"
  | "failed";

export interface CodexTuiTransportObserver {
  onState(state: CodexTuiConnectionState): void;
  onOutput(data: Uint8Array): void;
  onReady(size: { readonly cols: number; readonly rows: number }): void;
  onError(message: string): void;
  onExit(): void;
}

export interface CodexTuiTransport {
  connect(): void;
  /** Returns true only when the input was accepted by an open socket. */
  input(data: string): boolean;
  resize(cols: number, rows: number): void;
  requestRefit(cols: number, rows: number): void;
  close(): void;
}

export type CodexTuiTransportFactory = (
  observer: CodexTuiTransportObserver,
) => CodexTuiTransport;

export const MAXIMUM_CODEX_TUI_INPUT_BYTES = 64 * 1_024;
const RECONNECT_DELAY_MS = 750;
const MAXIMUM_RECONNECT_DELAY_MS = 8_000;
const MAXIMUM_RECONNECT_ATTEMPTS = 6;

export function browserCodexTuiTransportFactory(
  api: ApiClient,
  threadId: string,
  resourceGeneration: number,
): CodexTuiTransportFactory {
  return (observer) =>
    new BrowserCodexTuiTransport(api, threadId, resourceGeneration, observer);
}

class BrowserCodexTuiTransport implements CodexTuiTransport {
  readonly #api: ApiClient;
  readonly #threadId: string;
  readonly #resourceGeneration: number;
  readonly #observer: CodexTuiTransportObserver;
  #socket?: WebSocket;
  #closed = false;
  #reconnectAllowed = true;
  #reconnectAttempts = 0;
  #latestDimensions?: { readonly cols: number; readonly rows: number };
  #connectEpoch = 0;
  #reconnectTimer?: number;

  constructor(
    api: ApiClient,
    threadId: string,
    resourceGeneration: number,
    observer: CodexTuiTransportObserver,
  ) {
    this.#api = api;
    this.#threadId = threadId;
    this.#resourceGeneration = resourceGeneration;
    this.#observer = observer;
  }

  connect(): void {
    if (this.#closed || this.#socket) return;
    const epoch = ++this.#connectEpoch;
    this.#observer.onState("authorizing");
    void this.#api
      .createCodexTuiAdmission(this.#threadId)
      .then((admission) => {
        if (this.#closed || epoch !== this.#connectEpoch) return;
        if (admission.resourceGeneration !== this.#resourceGeneration) {
          throw new Error(
            "The managed TUI changed while this viewer connected.",
          );
        }
        if (Date.parse(admission.expiresAt) <= Date.now()) {
          throw new Error("The terminal admission expired before connection.");
        }
        this.#observer.onState("connecting");
        const socket = new WebSocket(this.#api.codexTuiWebSocketUrl(), [
          "sedes.codex-tui.v1",
          admission.token,
        ]);
        socket.binaryType = "arraybuffer";
        this.#socket = socket;
        socket.onopen = () => {
          if (socket !== this.#socket) return;
          if (this.#latestDimensions) {
            this.#send({
              v: 1,
              type: "request_refit",
              columns: this.#latestDimensions.cols,
              rows: this.#latestDimensions.rows,
            });
          } else {
            this.#send({ v: 1, type: "request_sync" });
          }
          this.#observer.onState("synchronizing");
        };
        socket.onmessage = (event) => void this.#handleMessage(event.data);
        socket.onerror = () => {
          if (socket === this.#socket) {
            this.#observer.onError(
              "The terminal connection encountered an error.",
            );
          }
        };
        socket.onclose = () => {
          if (socket !== this.#socket) return;
          this.#socket = undefined;
          if (!this.#closed) this.#scheduleReconnect();
        };
      })
      .catch((error: unknown) => {
        if (this.#closed || epoch !== this.#connectEpoch) return;
        this.#observer.onError(messageFrom(error));
        this.#scheduleReconnect();
      });
  }

  input(data: string): boolean {
    if (!data) return false;
    const bytes = new TextEncoder().encode(data);
    if (bytes.byteLength > MAXIMUM_CODEX_TUI_INPUT_BYTES) return false;
    return this.#send({
      v: 1,
      type: "input",
      data: encodeBase64Url(bytes),
    });
  }

  resize(cols: number, rows: number): void {
    if (!validColumns(cols) || !validRows(rows)) return;
    this.#latestDimensions = { cols, rows };
    this.#send({ v: 1, type: "resize", columns: cols, rows });
  }

  requestRefit(cols: number, rows: number): void {
    if (!validColumns(cols) || !validRows(rows)) return;
    this.#latestDimensions = { cols, rows };
    this.#send({ v: 1, type: "request_refit", columns: cols, rows });
  }

  close(): void {
    this.#closed = true;
    this.#connectEpoch += 1;
    if (this.#reconnectTimer !== undefined) {
      window.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(1000, "viewer_detached");
    this.#observer.onState("idle");
  }

  async #handleMessage(raw: unknown): Promise<void> {
    if (raw instanceof ArrayBuffer) {
      this.#observer.onOutput(new Uint8Array(raw));
      return;
    }
    if (raw instanceof Blob) {
      this.#observer.onOutput(new Uint8Array(await raw.arrayBuffer()));
      return;
    }
    if (typeof raw !== "string") {
      this.#failProtocol();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.#failProtocol();
      return;
    }
    const parsed = terminalServerFrameSchema.safeParse(value);
    if (!parsed.success) {
      this.#failProtocol();
      return;
    }
    const frame = parsed.data;
    switch (frame.type) {
      case "sync_started":
        this.#observer.onState("synchronizing");
        return;
      case "ready":
        this.#reconnectAttempts = 0;
        this.#observer.onState("ready");
        this.#observer.onReady({ cols: frame.columns, rows: frame.rows });
        return;
      case "resync_required":
        this.#observer.onState("synchronizing");
        this.#send({ v: 1, type: "request_sync" });
        return;
      case "error":
        this.#observer.onError(frame.message);
        this.#reconnectAllowed = frame.retryable;
        if (!frame.retryable) this.#observer.onState("failed");
        return;
      case "exit":
        this.#observer.onState("exited");
        this.#observer.onExit();
        this.#closed = true;
        this.#socket?.close(1000, "terminal_exited");
        this.#socket = undefined;
    }
  }

  #failProtocol(): void {
    this.#observer.onError("The terminal server sent an invalid frame.");
    this.#closed = true;
    this.#socket?.close(1002, "invalid_frame");
    this.#socket = undefined;
    this.#observer.onState("failed");
  }

  #scheduleReconnect(): void {
    if (
      this.#closed ||
      !this.#reconnectAllowed ||
      this.#reconnectTimer !== undefined
    )
      return;
    if (this.#reconnectAttempts >= MAXIMUM_RECONNECT_ATTEMPTS) {
      this.#reconnectAllowed = false;
      this.#observer.onError("The terminal could not reconnect.");
      this.#observer.onState("failed");
      return;
    }
    this.#observer.onState("reconnecting");
    const delay = Math.min(
      RECONNECT_DELAY_MS * 2 ** this.#reconnectAttempts,
      MAXIMUM_RECONNECT_DELAY_MS,
    );
    this.#reconnectAttempts += 1;
    this.#reconnectTimer = window.setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  #send(frame: Readonly<Record<string, unknown>>): boolean {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false;
    try {
      this.#socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }
}

function validColumns(value: number): boolean {
  return Number.isInteger(value) && value >= 2 && value <= 512;
}

function validRows(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 256;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function messageFrom(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The terminal could not connect.";
}
