import { connectAgentToolCliNamedPipe } from "../internal/agent-tool-cli-protocol/named-pipe-tls.js";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  AGENT_TOOL_CLI_PROTOCOL_VERSION,
  AgentToolCliFrameDecoder,
  agentToolCliRequestSchema,
  agentToolCliResponseSchema,
  encodeAgentToolCliFrame,
  type AgentToolCliOperation,
  type AgentToolCliResult,
} from "../internal/agent-tool-cli-protocol/index.js";
import type { CreateAgentToolInvocationRequest } from "../server/agent-tools/http/agent-tool-http-contracts.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
  SedesToolApiError,
  type SedesToolClient,
} from "./sedes-tool-client.js";

export type SedesToolLocalSocketConnector = (socketPath: string) => Socket;

export class SedesToolLocalClient implements SedesToolClient {
  constructor(
    readonly socketPath: string,
    readonly sourceCapability: string,
    readonly connect: SedesToolLocalSocketConnector = (value) =>
      createConnection({ path: value }),
    readonly requestId: () => string = randomUUID,
    readonly requestTimeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
    readonly pipeCapability?: string,
  ) {}

  async listTools(signal?: AbortSignal) {
    const result = await this.#request(
      { type: "list" },
      signal,
      this.requestTimeoutMilliseconds,
    );
    if (result.type !== "list") throw unexpectedResult();
    return result.value;
  }

  async describeTools(toolIds: readonly string[], signal?: AbortSignal) {
    const result = await this.#request(
      { type: "describe", toolIds: [...toolIds] },
      signal,
      this.requestTimeoutMilliseconds,
    );
    if (result.type !== "describe") throw unexpectedResult();
    if (
      result.value.tools.length !== toolIds.length ||
      result.value.tools.some((tool, index) => tool.id !== toolIds[index])
    ) {
      throw new SedesToolApiError(
        "invalid_response",
        "Sedes returned descriptions in an unexpected order.",
        false,
      );
    }
    return result.value;
  }

  async invoke(
    request: CreateAgentToolInvocationRequest,
    signal?: AbortSignal,
  ) {
    const result = await this.#request({ type: "invoke", request }, signal);
    if (result.type !== "invoke") throw unexpectedResult();
    return result.value;
  }

  async #request(
    operation: AgentToolCliOperation,
    signal: AbortSignal | undefined,
    finiteTimeoutMilliseconds?: number,
  ): Promise<AgentToolCliResult> {
    if (
      operation.type !== "invoke" &&
      !validFiniteTimeout(finiteTimeoutMilliseconds)
    ) {
      throw new SedesToolApiError(
        "invalid_input",
        "The Sedes request timeout is invalid.",
        false,
      );
    }
    const requestId = this.requestId();
    const request = agentToolCliRequestSchema.parse({
      protocolVersion: AGENT_TOOL_CLI_PROTOCOL_VERSION,
      requestId,
      sourceCapability: this.sourceCapability,
      operation,
    });
    const frame = encodeAgentToolCliFrame(request);
    if (signal?.aborted) throw signal.reason;

    return await new Promise<AgentToolCliResult>((resolve, reject) => {
      const decoder = new AgentToolCliFrameDecoder();
      const socket = this.pipeCapability
        ? connectAgentToolCliNamedPipe(
            this.socketPath,
            this.pipeCapability,
            this.connect,
          )
        : this.connect(this.socketPath);
      let settled = false;
      let deliveryStarted = false;
      const mutating = operation.type === "invoke";
      const timer =
        operation.type === "invoke"
          ? undefined
          : setTimeout(() => {
              fail(
                new SedesToolApiError(
                  "timed_out",
                  "The Sedes request timed out.",
                  true,
                ),
              );
            }, finiteTimeoutMilliseconds);
      timer?.unref();

      const admissionTimer = this.pipeCapability
        ? setTimeout(() => fail(transportFailure()), 10_000)
        : undefined;
      admissionTimer?.unref();
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (admissionTimer) clearTimeout(admissionTimer);
        signal?.removeEventListener("abort", onAbort);
        socket.removeAllListeners();
        if (!socket.destroyed) socket.destroy();
      };
      const finish = (result: AgentToolCliResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const transportFailure = () =>
        deliveryStarted && mutating
          ? uncertainTransportError(
              "The Sedes invocation outcome is unknown.",
            )
          : new SedesToolApiError(
              "transport_error",
              "The Sedes request failed.",
              true,
            );
      const onAbort = () =>
        fail(
          deliveryStarted && mutating
            ? uncertainTransportError(
                "The Sedes invocation outcome is unknown.",
              )
            : signal?.reason,
        );
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once(this.pipeCapability ? "secureConnect" : "connect", () => {
        if (admissionTimer) clearTimeout(admissionTimer);
        deliveryStarted = true;
        socket.write(frame, (error) => {
          if (error) fail(transportFailure());
        });
      });
      socket.on("data", (chunk: Buffer) => {
        if (settled) return;
        try {
          const decoded = decoder.push(chunk);
          if (decoded === undefined) return;
          const parsed = agentToolCliResponseSchema.safeParse(decoded);
          if (!parsed.success || parsed.data.requestId !== requestId) {
            fail(invalidResponse());
            return;
          }
          if ("error" in parsed.data) {
            fail(
              new SedesToolApiError(
                parsed.data.error.code,
                parsed.data.error.message,
                parsed.data.error.retryable,
              ),
            );
            return;
          }
          finish(parsed.data.result as AgentToolCliResult);
        } catch {
          fail(invalidResponse());
        }
      });
      socket.once("error", () => fail(transportFailure()));
      socket.once("end", () => fail(transportFailure()));
      socket.once("close", () => fail(transportFailure()));
      if (signal?.aborted) onAbort();
    });
  }
}

function validFiniteTimeout(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value! > 0 && value! <= 30_000;
}

function invalidResponse(): SedesToolApiError {
  return new SedesToolApiError(
    "invalid_response",
    "Sedes returned a response that did not match the expected contract.",
    false,
  );
}

function unexpectedResult(): SedesToolApiError {
  return new SedesToolApiError(
    "invalid_response",
    "Sedes returned a response for an unexpected operation.",
    false,
  );
}

function uncertainTransportError(message: string): SedesToolApiError {
  return new SedesToolApiError("uncertain_outcome", message, false);
}
