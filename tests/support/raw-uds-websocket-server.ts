import { createHash } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type RawWebSocketHandshakeMode = "accept" | "reject" | "stall";

export type RawWebSocketHandshakeDecision =
  | "accept"
  | "stall"
  | Readonly<{
      readonly statusCode: number;
      readonly statusText?: string;
    }>;

export type RawWebSocketHandshakeResponder = (
  request: string,
) => RawWebSocketHandshakeDecision;

export interface RawWebSocketFrame {
  readonly fin: boolean;
  readonly masked: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

export class RawUdsWebSocketServer {
  readonly socketPath: string;
  readonly requests: string[] = [];
  readonly connections: RawWebSocketConnection[] = [];
  readonly #handshakeMode: RawWebSocketHandshakeMode;
  readonly #partialHandshake: boolean;
  readonly #server: Server;

  constructor(input: {
    readonly socketPath: string;
    readonly handshakeMode?: RawWebSocketHandshakeMode;
    readonly partialHandshake?: boolean;
  }) {
    this.socketPath = input.socketPath;
    this.#handshakeMode = input.handshakeMode ?? "accept";
    this.#partialHandshake = input.partialHandshake ?? false;
    this.#server = createServer((socket) => {
      const connection = new RawWebSocketConnection({
        socket,
        handshakeMode: this.#handshakeMode,
        partialHandshake: this.#partialHandshake,
        onRequest: (request) => this.requests.push(request),
      });
      this.connections.push(connection);
    });
  }

  get listening(): boolean {
    return this.#server.listening;
  }

  get latestConnection(): RawWebSocketConnection {
    const connection = this.connections.at(-1);
    if (!connection) throw new Error("raw_websocket_connection_missing");
    return connection;
  }

  async listen(): Promise<void> {
    await rm(this.socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        this.#server.removeListener("listening", listening);
        reject(error);
      };
      const listening = () => {
        this.#server.removeListener("error", failed);
        resolve();
      };
      this.#server.once("error", failed);
      this.#server.once("listening", listening);
      this.#server.listen(this.socketPath);
    });
    await chmod(this.socketPath, 0o600);
  }

  async close(): Promise<void> {
    for (const connection of this.connections) connection.destroy();
    if (this.#server.listening) {
      await new Promise<void>((resolve) => {
        this.#server.close(() => resolve());
      });
    }
    await rm(this.socketPath, { force: true });
  }
}

/** TCP listener wrapper over the same raw RFC 6455 connection core as UDS. */
export class RawTcpWebSocketServer {
  readonly requests: string[] = [];
  readonly connections: RawWebSocketConnection[] = [];
  readonly #handshakeMode: RawWebSocketHandshakeMode;
  readonly #handshakeResponder: RawWebSocketHandshakeResponder | undefined;
  readonly #partialHandshake: boolean;
  readonly #server: Server;

  constructor(
    input: {
      readonly handshakeMode?: RawWebSocketHandshakeMode;
      readonly handshakeResponder?: RawWebSocketHandshakeResponder;
      readonly partialHandshake?: boolean;
    } = {},
  ) {
    this.#handshakeMode = input.handshakeMode ?? "accept";
    this.#handshakeResponder = input.handshakeResponder;
    this.#partialHandshake = input.partialHandshake ?? false;
    this.#server = createServer((socket) => {
      const connection = new RawWebSocketConnection({
        socket,
        handshakeMode: this.#handshakeMode,
        ...(this.#handshakeResponder
          ? { handshakeResponder: this.#handshakeResponder }
          : {}),
        partialHandshake: this.#partialHandshake,
        onRequest: (request) => this.requests.push(request),
      });
      this.connections.push(connection);
    });
  }

  get listening(): boolean {
    return this.#server.listening;
  }

  get port(): number {
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("raw_websocket_tcp_address_missing");
    }
    return (address as AddressInfo).port;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  get latestConnection(): RawWebSocketConnection {
    const connection = this.connections.at(-1);
    if (!connection) throw new Error("raw_websocket_connection_missing");
    return connection;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        this.#server.removeListener("listening", listening);
        reject(error);
      };
      const listening = () => {
        this.#server.removeListener("error", failed);
        resolve();
      };
      this.#server.once("error", failed);
      this.#server.once("listening", listening);
      this.#server.listen(0, "127.0.0.1");
    });
  }

  async close(): Promise<void> {
    for (const connection of this.connections) connection.destroy();
    if (!this.#server.listening) return;
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
  }
}

export class RawWebSocketConnection {
  readonly frames: RawWebSocketFrame[] = [];
  readonly requestReceived: Promise<string>;
  readonly upgraded: Promise<void>;
  readonly closed: Promise<void>;
  readonly #socket: Socket;
  readonly #handshakeMode: RawWebSocketHandshakeMode;
  readonly #handshakeResponder: RawWebSocketHandshakeResponder | undefined;
  readonly #partialHandshake: boolean;
  readonly #onRequest: (request: string) => void;
  readonly #resolveRequest: (request: string) => void;
  readonly #resolveUpgraded: () => void;
  #buffer = Buffer.alloc(0);
  #upgradeComplete = false;
  #requestSettled = false;
  #upgradedSettled = false;
  #closeReplySent = false;

  constructor(input: {
    readonly socket: Socket;
    readonly handshakeMode: RawWebSocketHandshakeMode;
    readonly handshakeResponder?: RawWebSocketHandshakeResponder;
    readonly partialHandshake: boolean;
    readonly onRequest: (request: string) => void;
  }) {
    this.#socket = input.socket;
    this.#handshakeMode = input.handshakeMode;
    this.#handshakeResponder = input.handshakeResponder;
    this.#partialHandshake = input.partialHandshake;
    this.#onRequest = input.onRequest;
    let resolveRequest!: (request: string) => void;
    this.requestReceived = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    this.#resolveRequest = resolveRequest;
    let resolveUpgraded!: () => void;
    this.upgraded = new Promise((resolve) => {
      resolveUpgraded = resolve;
    });
    this.#resolveUpgraded = resolveUpgraded;
    this.closed = new Promise((resolve) => {
      input.socket.once("close", resolve);
    });
    input.socket.on("error", () => undefined);
    input.socket.on("data", (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
      void this.#consume();
    });
  }

  async waitForFrame(
    predicate: (frame: RawWebSocketFrame) => boolean,
    timeoutMilliseconds = 1_000,
  ): Promise<RawWebSocketFrame> {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
      const frame = this.frames.find(predicate);
      if (frame) return frame;
      await delay(5);
    }
    throw new Error("raw_websocket_frame_timeout");
  }

  async sendText(
    text: string,
    input: { readonly partial?: boolean; readonly fin?: boolean } = {},
  ): Promise<void> {
    await this.sendFrame(0x1, Buffer.from(text, "utf8"), input);
  }

  async sendBinary(bytes: Uint8Array): Promise<void> {
    await this.sendFrame(0x2, Buffer.from(bytes));
  }

  async sendPing(
    bytes: Uint8Array,
    input: { readonly partial?: boolean } = {},
  ): Promise<void> {
    await this.sendFrame(0x9, Buffer.from(bytes), input);
  }

  async sendClose(code = 1000): Promise<void> {
    const payload = Buffer.allocUnsafe(2);
    payload.writeUInt16BE(code);
    this.#closeReplySent = true;
    await this.sendFrame(0x8, payload);
  }

  async sendFrame(
    opcode: number,
    payload: Buffer,
    input: { readonly partial?: boolean; readonly fin?: boolean } = {},
  ): Promise<void> {
    await this.upgraded;
    const frame = encodeServerFrame(opcode, payload, input.fin ?? true);
    await writeBytes(this.#socket, frame, input.partial ?? false);
  }

  destroy(): void {
    this.#socket.destroy();
  }

  async #consume(): Promise<void> {
    if (!this.#upgradeComplete) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const request = this.#buffer.subarray(0, headerEnd + 4).toString("ascii");
      this.#buffer = this.#buffer.subarray(headerEnd + 4);
      if (!this.#requestSettled) {
        this.#requestSettled = true;
        this.#onRequest(request);
        this.#resolveRequest(request);
      }
      const decision =
        this.#handshakeResponder?.(request) ??
        (this.#handshakeMode === "reject"
          ? { statusCode: 403, statusText: "Forbidden" }
          : this.#handshakeMode);
      if (decision === "stall") return;
      if (decision !== "accept") {
        const statusText =
          decision.statusText ?? statusTextFor(decision.statusCode);
        await writeBytes(
          this.#socket,
          Buffer.from(
            `HTTP/1.1 ${decision.statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
            "ascii",
          ),
          this.#partialHandshake,
        );
        this.#socket.end();
        return;
      }
      const key = requestHeader(request, "sec-websocket-key");
      if (!key) {
        this.#socket.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(`${key}${WEBSOCKET_GUID}`)
        .digest("base64");
      await writeBytes(
        this.#socket,
        Buffer.from(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
          "ascii",
        ),
        this.#partialHandshake,
      );
      this.#upgradeComplete = true;
      if (!this.#upgradedSettled) {
        this.#upgradedSettled = true;
        this.#resolveUpgraded();
      }
    }

    while (true) {
      const decoded = decodeClientFrame(this.#buffer);
      if (!decoded) return;
      this.#buffer = this.#buffer.subarray(decoded.bytesConsumed);
      this.frames.push(decoded.frame);
      if (decoded.frame.opcode === 0x8) {
        if (!this.#closeReplySent) {
          this.#closeReplySent = true;
          await writeBytes(
            this.#socket,
            encodeServerFrame(0x8, decoded.frame.payload, true),
            false,
          );
        }
        this.#socket.end();
      }
    }
  }
}

function statusTextFor(statusCode: number): string {
  switch (statusCode) {
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 429:
      return "Too Many Requests";
    case 503:
      return "Service Unavailable";
    default:
      return "Rejected";
  }
}

function requestHeader(request: string, name: string): string | undefined {
  const prefix = `${name.toLowerCase()}:`;
  for (const line of request.split("\r\n").slice(1)) {
    if (line.toLowerCase().startsWith(prefix)) {
      return line.slice(line.indexOf(":") + 1).trim();
    }
  }
  return undefined;
}

function encodeServerFrame(
  opcode: number,
  payload: Buffer,
  fin: boolean,
): Buffer {
  const first = (fin ? 0x80 : 0) | opcode;
  if (payload.byteLength < 126) {
    return Buffer.concat([Buffer.from([first, payload.byteLength]), payload]);
  }
  if (payload.byteLength <= 0xffff) {
    const header = Buffer.allocUnsafe(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(payload.byteLength, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.allocUnsafe(10);
  header[0] = first;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  return Buffer.concat([header, payload]);
}

function decodeClientFrame(
  buffer: Buffer,
):
  | { readonly frame: RawWebSocketFrame; readonly bytesConsumed: number }
  | undefined {
  if (buffer.byteLength < 2) return undefined;
  const first = buffer[0]!;
  const second = buffer[1]!;
  let offset = 2;
  let payloadLength = second & 0x7f;
  if (payloadLength === 126) {
    if (buffer.byteLength < offset + 2) return undefined;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.byteLength < offset + 8) return undefined;
    const extended = buffer.readBigUInt64BE(offset);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("raw_websocket_payload_too_large");
    }
    payloadLength = Number(extended);
    offset += 8;
  }
  const masked = (second & 0x80) !== 0;
  const maskBytes = masked ? 4 : 0;
  if (buffer.byteLength < offset + maskBytes + payloadLength) return undefined;
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += maskBytes;
  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  if (mask) {
    for (let index = 0; index < payload.byteLength; index += 1) {
      payload[index] = payload[index]! ^ mask[index % 4]!;
    }
  }
  return {
    frame: Object.freeze({
      fin: (first & 0x80) !== 0,
      masked,
      opcode: first & 0x0f,
      payload,
    }),
    bytesConsumed: offset + payloadLength,
  };
}

async function writeBytes(
  socket: Socket,
  bytes: Buffer,
  partial: boolean,
): Promise<void> {
  if (!partial) {
    await writeChunk(socket, bytes);
    return;
  }
  for (let offset = 0; offset < bytes.byteLength; offset += 1) {
    await writeChunk(socket, bytes.subarray(offset, offset + 1));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function writeChunk(socket: Socket, chunk: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
