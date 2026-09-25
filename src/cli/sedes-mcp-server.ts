import { randomUUID } from "node:crypto";
import {
  nativeAgentToolName,
  type AgentToolCatalogSummary,
  type AgentToolDescription,
} from "../server/agent-tools/contracts/agent-tool-contracts.js";
import { AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS } from "../server/agent-tools/contracts/agent-tool-transport-limits.js";
import { compileCanonicalAgentToolSchema } from "../server/agent-tools/schema/canonical-json-schema.js";
import { deterministicJson } from "../server/canonical-json.js";
import { SedesToolApiError, type SedesToolClient } from "./sedes-tool-client.js";
import {
  callToolParamsSchema,
  cancelledNotificationParamsSchema,
  classifyJsonRpcMessage,
  initializeParamsSchema,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  JSON_RPC_SERVER_BUSY,
  jsonRpcError,
  jsonRpcResult,
  listToolsParamsSchema,
  negotiateSedesMcpProtocolVersion,
  SEDES_MCP_MAXIMUM_BATCH_MESSAGES,
  SEDES_MCP_MAXIMUM_CONCURRENT_REQUESTS,
  sedesMcpVersionAtLeast,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type SedesMcpProtocolVersion,
} from "../internal/agent-tool-mcp/mcp-protocol.js";
import {
  isSideEffectFreeRead,
  projectSedesMcpTool,
  SEDES_MCP_GATEWAY_NAMES,
  sedesMcpCatalogSummaries,
  sedesMcpGatewayTools,
  sedesMcpInputSchemaError,
  sedesMcpInvocationResult,
  sedesMcpJsonResult,
  sedesMcpToolError,
  type SedesMcpCallToolResult,
} from "../internal/agent-tool-mcp/mcp-tool-projection.js";

export type SedesMcpPresentationMode = "progressive" | "individual";

export interface SedesMcpServerOptions {
  readonly client: SedesToolClient;
  readonly mode: SedesMcpPresentationMode;
  readonly serverVersion: string;
  /** Writes one complete JSON-RPC message or batch; resolves once accepted. */
  readonly send: (message: unknown) => Promise<void>;
  readonly requestId?: () => string;
}

type JsonRpcReply = ReturnType<typeof jsonRpcResult> | ReturnType<typeof jsonRpcError>;

class SedesMcpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const instructions: Readonly<Record<SedesMcpPresentationMode, string>> = {
  individual:
    "Sedes application tools for this thread. Each tool is one canonical Sedes operation; the thread's current Sedes tool policy decides which are available and is checked again on every call.",
  progressive:
    "Sedes application tools for this thread. Call sedes_catalog with action=list, describe the operations you need, then invoke exactly one through sedes_read (side-effect-free reads) or sedes_act (everything else). The thread's current Sedes tool policy is checked on every call.",
};

/**
 * A transport-neutral, tools-only MCP server over the thread's existing
 * agent-tool client. Every list and call reads the live server catalog; the
 * server keeps no tool state of its own.
 */
export class SedesMcpServer {
  readonly #options: SedesMcpServerOptions;
  #protocolVersion: SedesMcpProtocolVersion | undefined;
  #closed = false;
  readonly #inFlight = new Map<string, AbortController>();
  readonly #cancelled = new Set<string>();
  readonly #tasks = new Set<Promise<void>>();

  constructor(options: SedesMcpServerOptions) {
    this.#options = options;
  }

  /** Accepts one inbound line; `null` marks a line that was not UTF-8. */
  receive(line: string | null): void {
    if (this.#closed) return;
    let value: unknown;
    try {
      if (line === null) throw new Error("sedes_mcp_line_not_utf8");
      value = JSON.parse(line);
    } catch {
      this.#track(
        this.#options.send(
          jsonRpcError(null, JSON_RPC_PARSE_ERROR, "Parse error"),
        ),
      );
      return;
    }
    if (Array.isArray(value)) {
      this.#track(this.#batch(value));
      return;
    }
    const reply = this.#dispatch(value);
    if (reply) {
      this.#track(
        reply.then(async (message) => {
          if (message) await this.#options.send(message);
        }),
      );
    }
  }

  /** Aborts outstanding calls and waits for their tasks to settle. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#inFlight.values()) {
      controller.abort(new Error("sedes_mcp_server_closed"));
    }
    while (this.#tasks.size > 0) {
      await Promise.allSettled([...this.#tasks]);
    }
  }

  #track(task: Promise<void>): void {
    const tracked = task.catch(() => undefined).finally(() => {
      this.#tasks.delete(tracked);
    });
    this.#tasks.add(tracked);
  }

  async #batch(values: readonly unknown[]): Promise<void> {
    if (values.length === 0 || values.length > SEDES_MCP_MAXIMUM_BATCH_MESSAGES) {
      await this.#options.send(
        jsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Invalid batch"),
      );
      return;
    }
    const replies = await Promise.all(
      values.map((value) => this.#dispatch(value) ?? Promise.resolve(undefined)),
    );
    const messages = replies.filter(
      (reply): reply is JsonRpcReply => reply !== undefined,
    );
    if (messages.length > 0) await this.#options.send(messages);
  }

  /** Returns a pending reply for requests and undefined for notifications. */
  #dispatch(value: unknown): Promise<JsonRpcReply | undefined> | undefined {
    const inbound = classifyJsonRpcMessage(value);
    switch (inbound.kind) {
      case "notification":
        this.#notification(inbound.message);
        return undefined;
      case "response":
        return undefined;
      case "invalid":
        return Promise.resolve(
          jsonRpcError(inbound.id, JSON_RPC_INVALID_REQUEST, "Invalid request"),
        );
      case "request":
        return this.#request(inbound.message);
    }
  }

  #notification(message: JsonRpcNotification): void {
    if (message.method !== "notifications/cancelled") return;
    const parsed = cancelledNotificationParamsSchema.safeParse(message.params);
    if (!parsed.success) return;
    const key = requestKey(parsed.data.requestId);
    const controller = this.#inFlight.get(key);
    if (!controller) return;
    this.#cancelled.add(key);
    controller.abort(new Error("sedes_mcp_request_cancelled"));
  }

  async #request(message: JsonRpcRequest): Promise<JsonRpcReply | undefined> {
    const key = requestKey(message.id);
    if (this.#inFlight.has(key)) {
      return jsonRpcError(
        message.id,
        JSON_RPC_INVALID_REQUEST,
        "The request ID is already in flight.",
      );
    }
    if (this.#inFlight.size >= SEDES_MCP_MAXIMUM_CONCURRENT_REQUESTS) {
      return jsonRpcError(
        message.id,
        JSON_RPC_SERVER_BUSY,
        "Too many concurrent requests.",
      );
    }
    const controller = new AbortController();
    this.#inFlight.set(key, controller);
    try {
      const result = await this.#method(message, controller.signal);
      return this.#cancelled.has(key) ? undefined : jsonRpcResult(message.id, result);
    } catch (error) {
      if (this.#cancelled.has(key) || this.#closed) return undefined;
      if (error instanceof SedesMcpProtocolError) {
        return jsonRpcError(message.id, error.code, error.message);
      }
      return jsonRpcError(
        message.id,
        JSON_RPC_INTERNAL_ERROR,
        "The Sedes MCP request failed.",
      );
    } finally {
      this.#inFlight.delete(key);
      this.#cancelled.delete(key);
    }
  }

  async #method(message: JsonRpcRequest, signal: AbortSignal): Promise<unknown> {
    if (message.method === "ping") return {};
    if (message.method === "initialize") return this.#initialize(message);
    const version = this.#protocolVersion;
    if (!version) {
      throw new SedesMcpProtocolError(
        JSON_RPC_INVALID_REQUEST,
        "The server is not initialized.",
      );
    }
    switch (message.method) {
      case "tools/list":
        return this.#listTools(message, version, signal);
      case "tools/call":
        return this.#callTool(message, version, signal);
      default:
        throw new SedesMcpProtocolError(
          JSON_RPC_METHOD_NOT_FOUND,
          "Method not found",
        );
    }
  }

  #initialize(message: JsonRpcRequest) {
    if (this.#protocolVersion) {
      throw new SedesMcpProtocolError(
        JSON_RPC_INVALID_REQUEST,
        "The server is already initialized.",
      );
    }
    const params = initializeParamsSchema.safeParse(message.params);
    if (!params.success) {
      throw new SedesMcpProtocolError(
        JSON_RPC_INVALID_PARAMS,
        "Invalid initialize parameters.",
      );
    }
    const version = negotiateSedesMcpProtocolVersion(params.data.protocolVersion);
    this.#protocolVersion = version;
    return {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "sedes",
        ...(sedesMcpVersionAtLeast(version, "2025-06-18")
          ? { title: "Sedes" }
          : {}),
        version: this.#options.serverVersion,
      },
      instructions: instructions[this.#options.mode],
    };
  }

  async #listTools(
    message: JsonRpcRequest,
    version: SedesMcpProtocolVersion,
    signal: AbortSignal,
  ) {
    const params = listToolsParamsSchema.safeParse(message.params);
    if (!params.success || params.data?.cursor !== undefined) {
      throw new SedesMcpProtocolError(
        JSON_RPC_INVALID_PARAMS,
        "Invalid tools/list parameters.",
      );
    }
    // A grant removed between list and describe fails the atomic describe;
    // one fresh listing settles that race.
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { tools: summaries } =
          await this.#options.client.listTools(signal);
        if (this.#options.mode === "progressive") {
          return { tools: sedesMcpGatewayTools(summaries, version) };
        }
        const descriptions = await this.#describeAll(summaries, signal);
        return {
          tools: descriptions.map((description) =>
            projectSedesMcpTool(description, version),
          ),
        };
      } catch (error) {
        if (!(error instanceof SedesToolApiError)) throw error;
        if (error.code === "not_found" && attempt < 2) continue;
        throw new SedesMcpProtocolError(
          JSON_RPC_INTERNAL_ERROR,
          `Sedes tools are unavailable (${error.code}).`,
        );
      }
    }
  }

  async #describeAll(
    summaries: readonly AgentToolCatalogSummary[],
    signal: AbortSignal,
  ): Promise<readonly AgentToolDescription[]> {
    const descriptions: AgentToolDescription[] = [];
    for (
      let offset = 0;
      offset < summaries.length;
      offset += AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS
    ) {
      const ids = summaries
        .slice(offset, offset + AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS)
        .map(({ id }) => id);
      descriptions.push(
        ...(await this.#options.client.describeTools(ids, signal)).tools,
      );
    }
    return descriptions;
  }

  async #callTool(
    message: JsonRpcRequest,
    version: SedesMcpProtocolVersion,
    signal: AbortSignal,
  ): Promise<SedesMcpCallToolResult> {
    const params = callToolParamsSchema.safeParse(message.params);
    if (!params.success) {
      throw new SedesMcpProtocolError(
        JSON_RPC_INVALID_PARAMS,
        "Invalid tools/call parameters.",
      );
    }
    const name = params.data.name;
    const input = params.data.arguments ?? {};
    try {
      if (this.#options.mode === "progressive") {
        switch (name) {
          case SEDES_MCP_GATEWAY_NAMES.catalog:
            return await this.#catalogGateway(input, version, signal);
          case SEDES_MCP_GATEWAY_NAMES.read:
            return await this.#laneGateway("read", input, version, signal);
          case SEDES_MCP_GATEWAY_NAMES.act:
            return await this.#laneGateway("act", input, version, signal);
          default:
            throw unknownTool();
        }
      }
      const { tools: summaries } = await this.#options.client.listTools(signal);
      const summary = summaries.find(({ id }) => nativeAgentToolName(id) === name);
      if (!summary) throw unknownTool();
      const [description] = (
        await this.#options.client.describeTools([summary.id], signal)
      ).tools;
      return await this.#invoke(description!, input, version, signal);
    } catch (error) {
      if (error instanceof SedesMcpProtocolError) throw error;
      if (error instanceof SedesToolApiError) {
        return sedesMcpToolError(error);
      }
      if (signal.aborted) throw error;
      return sedesMcpToolError({
        code: "internal_error",
        message: "The Sedes tool call failed.",
        retryable: false,
      });
    }
  }

  async #catalogGateway(
    input: Readonly<Record<string, unknown>>,
    version: SedesMcpProtocolVersion,
    signal: AbortSignal,
  ): Promise<SedesMcpCallToolResult> {
    const keys = Object.keys(input).sort().join(",");
    if (input.action === "list" && keys === "action") {
      const { tools } = await this.#options.client.listTools(signal);
      return sedesMcpJsonResult({ tools: sedesMcpCatalogSummaries(tools) }, version);
    }
    const toolIds = input.toolIds;
    if (
      input.action !== "describe" ||
      keys !== "action,toolIds" ||
      !Array.isArray(toolIds) ||
      toolIds.length < 1 ||
      toolIds.length > AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS ||
      new Set(toolIds).size !== toolIds.length ||
      !toolIds.every(
        (toolId) =>
          typeof toolId === "string" && toolId.length >= 1 && toolId.length <= 128,
      )
    ) {
      return invalidGatewayInput(
        "Use {\"action\":\"list\"} or {\"action\":\"describe\",\"toolIds\":[...]} with 1-16 unique IDs.",
      );
    }
    const { tools } = await this.#options.client.describeTools(
      toolIds as string[],
      signal,
    );
    return sedesMcpJsonResult({ tools }, version);
  }

  async #laneGateway(
    lane: "read" | "act",
    input: Readonly<Record<string, unknown>>,
    version: SedesMcpProtocolVersion,
    signal: AbortSignal,
  ): Promise<SedesMcpCallToolResult> {
    const { toolId, schemaVersion, input: toolInput } = input;
    if (
      Object.keys(input).sort().join(",") !== "input,schemaVersion,toolId" ||
      typeof toolId !== "string" ||
      toolId.length < 1 ||
      toolId.length > 128 ||
      !Number.isSafeInteger(schemaVersion) ||
      typeof toolInput !== "object" ||
      toolInput === null ||
      Array.isArray(toolInput)
    ) {
      return invalidGatewayInput(
        "Provide exactly toolId, schemaVersion, and an input object from a current description.",
      );
    }
    const [description] = (
      await this.#options.client.describeTools([toolId], signal)
    ).tools;
    if (!description || description.schemaVersion !== schemaVersion) {
      return sedesMcpToolError({
        code: "not_found",
        message: "The requested Sedes tool version is unavailable; describe it again.",
        retryable: false,
      });
    }
    if ((lane === "read") !== isSideEffectFreeRead(description.effects)) {
      return sedesMcpToolError({
        code: "invalid_input",
        message:
          lane === "read"
            ? "This operation has side effects; invoke it through sedes_act."
            : "This operation is a side-effect-free read; invoke it through sedes_read.",
        retryable: false,
      });
    }
    return this.#invoke(
      description,
      toolInput as Readonly<Record<string, unknown>>,
      version,
      signal,
    );
  }

  async #invoke(
    description: AgentToolDescription,
    input: Readonly<Record<string, unknown>>,
    version: SedesMcpProtocolVersion,
    signal: AbortSignal,
  ): Promise<SedesMcpCallToolResult> {
    const validator = compileCanonicalAgentToolSchema(description.inputSchema);
    if (!validator.check(input)) {
      return sedesMcpInputSchemaError(validator.errors());
    }
    if (
      Buffer.byteLength(deterministicJson(input), "utf8") >
      description.execution.maximumInputBytes
    ) {
      return sedesMcpToolError({
        code: "invalid_input",
        message: `The serialized tool input exceeds the ${description.execution.maximumInputBytes}-byte limit.`,
        retryable: false,
      });
    }
    const result = await this.#options.client.invoke(
      {
        toolId: description.id,
        schemaVersion: description.schemaVersion,
        requestId: (this.#options.requestId ?? randomUUID)(),
        input,
      },
      signal,
    );
    return sedesMcpInvocationResult(result, version);
  }
}

function requestKey(id: JsonRpcId): string {
  return typeof id === "string" ? `s:${id}` : `n:${id}`;
}

function unknownTool(): SedesMcpProtocolError {
  return new SedesMcpProtocolError(JSON_RPC_INVALID_PARAMS, "Unknown tool.");
}

function invalidGatewayInput(message: string): SedesMcpCallToolResult {
  return sedesMcpToolError({ code: "invalid_input", message, retryable: false });
}
