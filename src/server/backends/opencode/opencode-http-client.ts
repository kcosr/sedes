import { ClientError, OpenCode, type OpenCodeClient, type ServerInfo, type OpenCodeEvent } from "@opencode/client";
import { isIP } from "node:net";
import { z } from "zod";
import { admitOpenCodeRelease, OpenCodeRuntimeError } from "./opencode-release.js";
import { readOpenCodeSse } from "./opencode-sse.js";

export const OPENCODE_MAXIMUM_RESPONSE_BYTES = 32 * 1_024 * 1_024;
const infoSchema = z.object({
  version: z.string().max(64), pid: z.number().int().positive(),
  urls: z.array(z.string().max(2_048)).max(128), paths: z.object({ tmp: z.string().max(4_096) }).strict(),
}).strict();

function boundedFailure(error: unknown): OpenCodeRuntimeError | undefined {
  // The generated client wraps response read failures. Preserve our bounded
  // diagnostic without retaining its body, cause chain, or native error text.
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof OpenCodeRuntimeError) return current;
    if (!(current instanceof ClientError)) return undefined;
    current = current.cause;
  }
  return undefined;
}

/** A declared local HTTP authority; URL parser normalization cannot admit DNS or shorthand IPv4. */
export function openCodeEndpoint(value: string): string {
  const match = /^http:\/\/(\[::1\]|[0-9.]+):([0-9]{1,5})\/?$/u.exec(value);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new OpenCodeRuntimeError("opencode_endpoint_invalid");
  const host = match[1]!;
  if (host !== "[::1]" && (isIP(host) !== 4 || !host.startsWith("127."))) throw new OpenCodeRuntimeError("opencode_endpoint_invalid");
  return `http://${host}:${Number(match[2])}`;
}

export class OpenCodeHttpClient {
  readonly endpoint: string;
  readonly #client: OpenCodeClient;
  readonly #lifetime = new AbortController();
  readonly #password: string;
  readonly #fetch: typeof fetch;
  readonly #requestMilliseconds: number;

  constructor(input: { readonly endpoint: string; readonly password: string; readonly fetch?: typeof fetch; readonly requestMilliseconds?: number }) {
    this.endpoint = openCodeEndpoint(input.endpoint);
    if (!input.password || input.password.length > 4_096 || /[\r\n\0]/u.test(input.password)) throw new OpenCodeRuntimeError("opencode_authentication_invalid");
    this.#password = input.password;
    this.#fetch = input.fetch ?? globalThis.fetch;
    this.#requestMilliseconds = input.requestMilliseconds ?? 30_000;
    if (!Number.isSafeInteger(this.#requestMilliseconds) || this.#requestMilliseconds <= 0 || this.#requestMilliseconds > 30_000) {
      throw new OpenCodeRuntimeError("opencode_request_deadline_invalid");
    }
    this.#client = OpenCode.make({ baseUrl: this.endpoint, fetch: (value, init) => this.#boundedFetch(value, init) });
  }

  get lifetime(): AbortSignal { return this.#lifetime.signal; }
  close(): void { this.#lifetime.abort(); }

  /** The generated client remains private; every response needs an operation-specific validator. */
  async call<T>(operation: (client: OpenCodeClient, signal: AbortSignal) => Promise<unknown>,
    validate: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    const budget = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(this.#requestMilliseconds), ...(signal ? [signal] : [])]);
    if (budget.aborted) throw new OpenCodeRuntimeError("opencode_request_aborted");
    try {
      const value = await operation(this.#client, budget);
      budget.throwIfAborted();
      return validate(value);
    } catch (error) {
      const bounded = boundedFailure(error);
      if (bounded) throw bounded;
      throw new OpenCodeRuntimeError(budget.aborted ? "opencode_request_aborted" : "opencode_request_failed");
    }
  }

  async info(signal?: AbortSignal): Promise<ServerInfo> {
    return this.call((client, budget) => client.server.info({ signal: budget }), value => {
      const info = infoSchema.parse(value);
      admitOpenCodeRelease(info.version);
      return info;
    }, signal);
  }

  /** Reject an unauthenticated deployment instead of inferring protection from a successful request. */
  async requireAuthentication(): Promise<void> {
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(this.#requestMilliseconds)]);
    try {
      const response = await this.#fetch(`${this.endpoint}/api/info`, { redirect: "error", signal });
      await response.body?.cancel();
      if (response.status !== 401) throw new OpenCodeRuntimeError("opencode_authentication_required");
    } catch (error) {
      if (error instanceof OpenCodeRuntimeError) throw error;
      throw new OpenCodeRuntimeError("opencode_authentication_probe_failed");
    }
  }

  /** No automatic reconnect or event replay claim. Consumers reacquire native truth after EOF. */
  events(validate: (value: unknown) => OpenCodeEvent, signal?: AbortSignal): AsyncIterable<OpenCodeEvent> {
    return this.stream({ kind: "events" }, validate, signal);
  }

  /** Only the two pinned SSE routes bypass the SDK's hardcoded 16 MiB frame
   * limit. Each observer owns its connection and finite-cut/lifetime budget. */
  async *stream<T>(input: { readonly kind: "events" } | { readonly kind: "log"; readonly sessionID: string; readonly after?: number },
    validate: (value: unknown) => T, signal?: AbortSignal): AsyncIterable<T> {
    const lifetime = AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])]);
    try {
      if (lifetime.aborted) return;
      let route: string;
      if (input.kind === "events") route = "/api/event";
      else if (input.kind === "log" && /^ses_[^\x00-\x20/\\]{1,252}$/u.test(input.sessionID) &&
          (input.after === undefined || Number.isSafeInteger(input.after) && input.after >= 0)) {
        const query = new URLSearchParams({ follow: "false", ...(input.after === undefined ? {} : { after: String(input.after) }) });
        route = `/api/experimental/session/${encodeURIComponent(input.sessionID)}/log?${query}`;
      } else throw new OpenCodeRuntimeError("opencode_request_authority_mismatch");
      const response = await this.#boundedFetch(`${this.endpoint}${route}`, {
        method: "GET", headers: { accept: "text/event-stream" }, signal: lifetime,
      });
      if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0]?.trim() !== "text/event-stream" || !response.body) {
        await response.body?.cancel();
        throw new OpenCodeRuntimeError("opencode_event_stream_failed");
      }
      for await (const value of readOpenCodeSse(response.body, lifetime, OPENCODE_MAXIMUM_RESPONSE_BYTES)) {
        if (lifetime.aborted) return;
        yield validate(value);
      }
    } catch (error) {
      if (!lifetime.aborted) {
        const bounded = boundedFailure(error);
        if (bounded) throw bounded;
        throw new OpenCodeRuntimeError("opencode_event_stream_failed");
      }
    }
  }

  async #boundedFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== new URL(this.endpoint).origin || !url.pathname.startsWith("/api/") || url.username || url.password) {
      throw new OpenCodeRuntimeError("opencode_request_authority_mismatch");
    }
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Basic ${Buffer.from(`opencode:${this.#password}`).toString("base64")}`);
    const headersDeadline = new AbortController();
    const timer = setTimeout(() => headersDeadline.abort(), this.#requestMilliseconds);
    const lifetime = AbortSignal.any([this.#lifetime.signal, headersDeadline.signal, ...(init?.signal ? [init.signal] : [])]);
    let response: Response;
    try { response = await this.#fetch(url, { ...init, headers, redirect: "error", signal: lifetime }); }
    finally { clearTimeout(timer); }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new OpenCodeRuntimeError("opencode_redirect_rejected");
    }
    if (!response.body) return response;
    const eventStream = response.headers.get("content-type")?.split(";")[0]?.trim() === "text/event-stream";
    const reader = response.body.getReader();
    let bytes = 0;
    let lineBytes = 0;
    // The SSE reader bounds complete frames; this additionally bounds an
    // unterminated wire line before passing it to any response consumer.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { controller.close(); reader.releaseLock(); return; }
          if (lifetime.aborted) throw new OpenCodeRuntimeError("opencode_request_aborted");
          if (eventStream) {
            for (const value of next.value) { lineBytes = value === 10 || value === 13 ? 0 : lineBytes + 1; if (lineBytes > OPENCODE_MAXIMUM_RESPONSE_BYTES) throw new OpenCodeRuntimeError("opencode_response_too_large"); }
          } else {
            bytes += next.value.byteLength;
            if (bytes > OPENCODE_MAXIMUM_RESPONSE_BYTES) throw new OpenCodeRuntimeError("opencode_response_too_large");
          }
          controller.enqueue(next.value);
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
          controller.error(error instanceof OpenCodeRuntimeError ? error : new OpenCodeRuntimeError("opencode_response_read_failed"));
        }
      },
      cancel: async () => { await reader.cancel().catch(() => undefined); reader.releaseLock(); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}
