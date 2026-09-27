import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BackendAgentToolRequestError } from "../../agent-tools/adapters/backend-facade.js";
import { isBoundedAgentToolJson } from "../../../internal/agent-tool-cli-protocol/contracts.js";
import type { AgentToolCatalogSummary } from "../../agent-tools/contracts/agent-tool-contracts.js";
import { OPENCODE_MCP_CREDENTIAL, OPENCODE_MCP_ENDPOINT, OPENCODE_MCP_HEARTBEAT_MS,
  OPENCODE_MCP_MAXIMUM_BYTES, OPENCODE_MCP_STARTUP_MS, opencodeMcpRequest, type OpenCodeMcpRequest } from "../../../internal/opencode-mcp/contracts.js";

interface ChannelInput {
  readonly catalog: readonly AgentToolCatalogSummary[];
  readonly invoke: (request: OpenCodeMcpRequest, signal: AbortSignal) => Promise<unknown>;
}
interface Stream { readonly id: string; readonly response: ServerResponse; readonly controller: AbortController; readonly heartbeat: ReturnType<typeof setInterval>; }
export interface OpenCodeMcpChannel {
  readonly environment: Readonly<Record<string, string>>;
  readonly revoked: boolean;
  readonly revokedAt: number | undefined;
  readonly connected: boolean;
  revoke(): void;
}
interface ChannelState { readonly credential: string; readonly input: ChannelInput; revoked: boolean; revokedAt?: number;
  stream?: Stream; expiration?: ReturnType<typeof setTimeout>; calls: number; }

/** Loopback-only provider-private audience. Native session IDs are routing, never credentials. */
export class OpenCodeMcpIngress {
  readonly #channels = new Map<string, ChannelState>();
  #server?: Server;
  #opening?: Promise<string>;
  #endpoint?: string;
  #closed = false;

  async admit(input: ChannelInput): Promise<OpenCodeMcpChannel> {
    if (this.#closed || this.#channels.size >= 64 || input.catalog.length > 256) throw new Error("opencode_mcp_admission_limit");
    const endpoint = await this.#start();
    if (this.#closed || this.#channels.size >= 64) throw new Error("opencode_mcp_admission_limit");
    const credential = randomBytes(32).toString("base64url");
    const state: ChannelState = { credential, input, revoked: false, calls: 0 };
    this.#channels.set(credential, state); this.#expire(state);
    return { environment: Object.freeze({ [OPENCODE_MCP_ENDPOINT]: endpoint, [OPENCODE_MCP_CREDENTIAL]: credential }),
      get revoked() { return state.revoked; },
      get revokedAt() { return state.revokedAt; },
      get connected() { return !!state.stream && !state.stream.controller.signal.aborted && !state.revoked; }, revoke: () => this.#revoke(state) };
  }
  async close(): Promise<void> {
    this.#closed = true; for (const channel of this.#channels.values()) this.#revoke(channel);
    await this.#opening?.catch(() => undefined);
    const server = this.#server; if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  #start(): Promise<string> {
    if (this.#endpoint) return Promise.resolve(this.#endpoint);
    return this.#opening ??= new Promise<string>((resolve, reject) => {
      const server = this.#server = createServer({ maxHeaderSize: 8_192, requestTimeout: 10_000, headersTimeout: 10_000 },
        (req, res) => { void this.#handle(req, res).catch(() => { if (!res.headersSent) reply(res, 503, unavailable()); else res.destroy(); }); });
      server.maxConnections = 128;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        const endpoint = `http://127.0.0.1:${address.port}`;
        this.#endpoint = endpoint; resolve(endpoint);
      });
    });
  }
  #expire(state: ChannelState): void {
    clearTimeout(state.expiration);
    state.expiration = setTimeout(() => this.#revoke(state), OPENCODE_MCP_STARTUP_MS);
    state.expiration.unref();
  }
  #revoke(state: ChannelState): void {
    if (state.revoked) return;
    state.revoked = true; state.revokedAt = Date.now(); clearTimeout(state.expiration); this.#endStream(state);
    this.#channels.delete(state.credential);
  }
  #endStream(state: ChannelState): void {
    const stream = state.stream; if (!stream) return;
    state.stream = undefined; stream.controller.abort(); clearInterval(stream.heartbeat); stream.response.end();
  }
  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.#closed || req.headers.host !== this.#endpoint?.slice(7) || req.headers.origin !== undefined ||
        req.headers["sec-fetch-site"] !== undefined || (req.socket.remoteAddress !== "127.0.0.1")) {
      reply(res, 403, unavailable()); return;
    }
    const auth = req.headers.authorization;
    const credential = typeof auth === "string" && /^Bearer [A-Za-z0-9_-]{43}$/u.test(auth) ? auth.slice(7) : "";
    const state = this.#channels.get(credential);
    if (!state || state.revoked || !timingSafeEqual(Buffer.from(credential), Buffer.from(state.credential))) {
      reply(res, 401, unavailable()); return;
    }
    if (req.url === "/lifetime" && req.method === "GET") {
      if (req.headers["transfer-encoding"] || req.headers["content-length"] && req.headers["content-length"] !== "0") { reply(res, 400, unavailable()); return; }
      this.#endStream(state); clearTimeout(state.expiration);
      const id = randomUUID(); const controller = new AbortController();
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      res.write(`${JSON.stringify({ streamID: id, catalog: state.input.catalog })}\n`);
      const heartbeat = setInterval(() => {
        if (!res.write("{}\n")) res.destroy();
      }, OPENCODE_MCP_HEARTBEAT_MS); heartbeat.unref();
      const stream: Stream = { id, controller, response: res, heartbeat }; state.stream = stream;
      res.once("close", () => {
        controller.abort(); clearInterval(heartbeat);
        if (state.stream === stream) { state.stream = undefined; if (!state.revoked) this.#expire(state); }
      });
      return;
    }
    const stream = state.stream;
    if (req.url !== "/tools" || req.method !== "POST" || req.headers["content-type"] !== "application/json" ||
        !stream || stream.controller.signal.aborted || req.headers["x-sedes-stream"] !== stream.id) {
      reply(res, 403, unavailable()); return;
    }
    if (state.calls >= 32) { reply(res, 429, unavailable()); return; }
    state.calls++;
    const caller = new AbortController();
    const onClose = () => { if (!res.writableEnded) caller.abort(); };
    res.once("close", onClose);
    const signal = AbortSignal.any([caller.signal, stream.controller.signal]);
    try {
      const request = opencodeMcpRequest.parse(await readBody(req, signal));
      signal.throwIfAborted();
      if (state.stream !== stream || state.revoked) throw new Error("opencode_mcp_stream_stale");
      const result = await state.input.invoke(request, signal);
      signal.throwIfAborted();
      reply(res, 200, result);
    } catch (error) {
      if (!res.destroyed) reply(res, error instanceof BackendAgentToolRequestError ? 403 : 503,
        error instanceof BackendAgentToolRequestError ? error.toolError : unavailable());
    } finally { state.calls--; res.removeListener("close", onClose); }
  }
}
function unavailable() { return { code: "unavailable", message: "Sedes OpenCode tools are unavailable.", retryable: false }; }
function reply(response: ServerResponse, status: number, value: unknown): void {
  let body = JSON.stringify(value);
  if (Buffer.byteLength(body) > OPENCODE_MCP_MAXIMUM_BYTES || !isBoundedAgentToolJson(value)) {
    status = 503; body = JSON.stringify(unavailable());
  }
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(body);
}
async function readBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  const abort = () => request.destroy(); signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const value of request) { signal.throwIfAborted(); const chunk = Buffer.from(value); bytes += chunk.length;
      if (bytes > OPENCODE_MCP_MAXIMUM_BYTES) throw new Error("opencode_mcp_request_limit"); chunks.push(chunk); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isBoundedAgentToolJson(value)) throw new Error("opencode_mcp_request_limit"); return value;
  } finally { signal.removeEventListener("abort", abort); }
}
