import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import type { z } from "zod";
import {
  SEDES_AGENT_TOOL_CSRF_ROUTE,
  SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER,
  SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
  agentToolCatalogResponseSchema,
  agentToolCsrfResponseSchema,
  agentToolDescriptionsResponseSchema,
  agentToolHttpErrorResponseSchema,
  agentToolInvocationResultSchema,
  agentToolTransportLimits,
  createAgentToolInvocationRequestSchema,
  createAgentToolDescriptionsRequestSchema,
  type CreateAgentToolInvocationRequest,
} from "../server/agent-tools/http/agent-tool-http-contracts.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
  SedesToolApiError,
  type SedesAgentToolCallerCredential,
  type SedesToolClient,
} from "./sedes-tool-client.js";

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared &&
    (/^(?:0|[1-9][0-9]*)$/.test(declared) === false ||
      Number(declared) > agentToolTransportLimits.maximumResponseBytes)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new SedesToolApiError(
      "invalid_response",
      "Sedes returned an oversized response.",
      false,
      response.status,
    );
  }
  if (!response.body) {
    throw new SedesToolApiError(
      "invalid_response",
      "Sedes returned an empty response.",
      false,
      response.status,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > agentToolTransportLimits.maximumResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SedesToolApiError(
        "invalid_response",
        "Sedes returned an oversized response.",
        false,
        response.status,
      );
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } catch {
    throw new SedesToolApiError(
      "invalid_response",
      "Sedes returned invalid JSON.",
      false,
      response.status,
    );
  }
}

export class SedesToolHttpClient implements SedesToolClient {
  #csrfToken = "";

  constructor(
    readonly baseUrl: URL,
    readonly credential: SedesAgentToolCallerCredential,
    readonly fetch: typeof globalThis.fetch = globalThis.fetch,
    readonly requestTimeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
  ) {}

  listTools(signal?: AbortSignal) {
    return this.#request(
      "/api/agent-tools",
      { signal },
      agentToolCatalogResponseSchema,
      true,
    );
  }

  async describeTools(toolIds: readonly string[], signal?: AbortSignal) {
    const body = createAgentToolDescriptionsRequestSchema.parse({ toolIds });
    const response = await this.#request(
      "/api/agent-tool-descriptions",
      {
        method: "POST",
        body: JSON.stringify(body),
        signal,
        headers: { "Content-Type": "application/json" },
      },
      agentToolDescriptionsResponseSchema,
      true,
    );
    if (
      response.tools.length !== body.toolIds.length ||
      response.tools.some((tool, index) => tool.id !== body.toolIds[index])
    ) {
      throw new SedesToolApiError(
        "invalid_response",
        "Sedes returned descriptions in an unexpected order.",
        false,
      );
    }
    return response;
  }

  async invoke(
    request: CreateAgentToolInvocationRequest,
    signal?: AbortSignal,
  ) {
    const body = createAgentToolInvocationRequestSchema.parse(request);
    if (!this.#csrfToken) await this.#acquireCsrfToken(signal);
    try {
      return await this.#invokeRequest(
        "/api/agent-tool-invocations",
        {
          method: "POST",
          body: JSON.stringify(body),
          signal,
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": this.#csrfToken,
          },
        },
        agentToolInvocationResultSchema,
        true,
      );
    } catch (error) {
      if (
        error instanceof SedesToolApiError &&
        error.status === 403 &&
        error.code === "csrf_token_invalid"
      ) {
        await this.#acquireCsrfToken(signal, true);
        return this.#invokeRequest(
          "/api/agent-tool-invocations",
          {
            method: "POST",
            body: JSON.stringify(body),
            signal,
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": this.#csrfToken,
            },
          },
          agentToolInvocationResultSchema,
          true,
        );
      }
      throw error;
    }
  }

  async #acquireCsrfToken(
    signal?: AbortSignal,
    refresh = false,
  ): Promise<void> {
    if (refresh) this.#csrfToken = "";
    const result = await this.#request(
      SEDES_AGENT_TOOL_CSRF_ROUTE,
      { signal },
      agentToolCsrfResponseSchema,
      false,
    );
    this.#csrfToken = result.csrfToken;
  }

  async #request<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
    sourceAssociated: boolean,
    requestTimeoutMilliseconds = this.requestTimeoutMilliseconds,
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error("sedes_tool_request_timeout")),
      requestTimeoutMilliseconds,
    );
    const requestSignal = init.signal
      ? AbortSignal.any([init.signal, timeout.signal])
      : timeout.signal;
    try {
      const response = await this.fetch(new URL(path, this.baseUrl), {
        redirect: "error",
        ...init,
        signal: requestSignal,
        headers: {
          Accept: "application/json",
          ...(sourceAssociated ? callerCredentialHeader(this.credential) : {}),
          ...init.headers,
        },
      });
      const mediaType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim();
      if (mediaType !== "application/json") {
        await response.body?.cancel().catch(() => undefined);
        throw new SedesToolApiError(
          "invalid_response",
          "Sedes returned an unsupported content type.",
          false,
          response.status,
        );
      }
      const value = await readBoundedJson(response);
      if (!response.ok) {
        const parsed = agentToolHttpErrorResponseSchema.safeParse(value);
        if (!parsed.success) {
          throw new SedesToolApiError(
            "invalid_response",
            `Sedes returned HTTP ${response.status} with an invalid error.`,
            false,
            response.status,
          );
        }
        throw new SedesToolApiError(
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.retryable,
          response.status,
        );
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new SedesToolApiError(
          "invalid_response",
          "Sedes returned a response that did not match the expected contract.",
          false,
          response.status,
        );
      }
      return parsed.data;
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason;
      if (timeout.signal.aborted) {
        throw new SedesToolApiError(
          "timed_out",
          "The Sedes request timed out.",
          true,
        );
      }
      if (error instanceof SedesToolApiError) throw error;
      throw new SedesToolApiError(
        "transport_error",
        "The Sedes request failed.",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #invokeRequest<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
    sourceAssociated: boolean,
  ): Promise<T> {
    try {
      const requestInit = {
        ...init,
        headers: {
          Accept: "application/json",
          ...(sourceAssociated ? callerCredentialHeader(this.credential) : {}),
          ...init.headers,
        },
      };
      const url = new URL(path, this.baseUrl);
      const response =
        this.fetch === globalThis.fetch
          ? await requestViaNodeHttp(url, requestInit)
          : await this.fetch(url, { ...requestInit, redirect: "error" });
      const mediaType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim();
      if (mediaType !== "application/json") {
        throw new SedesToolApiError(
          "invalid_response",
          "Sedes returned an unsupported content type.",
          false,
          response.status,
        );
      }
      const value = await readBoundedJson(response);
      if (!response.ok) {
        const parsed = agentToolHttpErrorResponseSchema.safeParse(value);
        if (!parsed.success) {
          throw new SedesToolApiError(
            "invalid_response",
            `Sedes returned HTTP ${response.status} with an invalid error.`,
            false,
            response.status,
          );
        }
        throw new SedesToolApiError(
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.retryable,
          response.status,
        );
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new SedesToolApiError(
          "invalid_response",
          "Sedes returned a response that did not match the expected contract.",
          false,
          response.status,
        );
      }
      return parsed.data;
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason;
      if (error instanceof SedesToolApiError) throw error;
      if (error instanceof NodeHttpTransportError && error.deliveryStarted) {
        throw new SedesToolApiError(
          "uncertain_outcome",
          "The Sedes invocation outcome is unknown.",
          false,
        );
      }
      throw new SedesToolApiError(
        "transport_error",
        "The Sedes request failed.",
        true,
      );
    }
  }
}

function callerCredentialHeader(
  credential: SedesAgentToolCallerCredential,
): Record<string, string> {
  return credential.kind === "thread_source"
    ? { [SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER]: credential.value }
    : { [SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER]: credential.value };
}

class NodeHttpTransportError extends Error {
  constructor(
    readonly deliveryStarted: boolean,
    options: ErrorOptions,
  ) {
    super("The Sedes HTTP transport failed.", options);
    this.name = "NodeHttpTransportError";
  }
}

function requestViaNodeHttp(url: URL, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new Error("sedes_tool_protocol_invalid"));
      return;
    }
    const body =
      typeof init.body === "string" ? Buffer.from(init.body) : undefined;
    let socketConnected = false;
    let requestFinished = false;
    let deliveryStarted = false;
    const failTransport = (error: Error) =>
      reject(
        error instanceof SedesToolApiError
          ? error
          : new NodeHttpTransportError(deliveryStarted, { cause: error }),
      );
    const markDeliveryStarted = () => {
      if (socketConnected && requestFinished) deliveryStarted = true;
    };
    const request = (url.protocol === "https:" ? requestHttps : requestHttp)(
      url,
      {
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (incoming) => {
        deliveryStarted = true;
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > agentToolTransportLimits.maximumResponseBytes) {
            failTransport(
              new SedesToolApiError(
                "invalid_response",
                "Sedes returned an oversized response.",
                false,
                incoming.statusCode,
              ),
            );
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        incoming.once("error", failTransport);
        incoming.once("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode ?? 500,
              headers: new Headers(
                Object.entries(incoming.headers).flatMap(([name, value]) =>
                  value === undefined
                    ? []
                    : Array.isArray(value)
                      ? value.map((entry) => [name, entry] as const)
                      : [[name, value] as const],
                ),
              ),
            }),
          ),
        );
      },
    );
    request.once("socket", (socket) => {
      if (socket.connecting) {
        socket.once("connect", () => {
          socketConnected = true;
          markDeliveryStarted();
        });
      } else if (socket.remoteAddress !== undefined) {
        socketConnected = true;
        markDeliveryStarted();
      }
    });
    request.once("finish", () => {
      requestFinished = true;
      markDeliveryStarted();
    });
    request.once("error", failTransport);
    if (body) request.end(body);
    else request.end();
  });
}
