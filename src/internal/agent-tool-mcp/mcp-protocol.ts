import { z } from "zod";
import { AGENT_TOOL_MAXIMUM_RESPONSE_BYTES } from "../../server/agent-tools/contracts/agent-tool-transport-limits.js";

/**
 * The tools-only subset of the Model Context Protocol served by `sedes mcp`.
 * It is deliberately small and strict: stdio framing, lifecycle, ping, tool
 * listing, tool calls, and cancellation. Newest first; the first entry is
 * offered when a client requests an unsupported version.
 */
export const SEDES_MCP_PROTOCOL_VERSIONS = Object.freeze([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const);
export type SedesMcpProtocolVersion =
  (typeof SEDES_MCP_PROTOCOL_VERSIONS)[number];

/** Tool inputs are bounded at 4 MiB; the rest is JSON-RPC envelope. */
export const SEDES_MCP_MAXIMUM_INBOUND_LINE_BYTES =
  AGENT_TOOL_MAXIMUM_RESPONSE_BYTES + 64 * 1_024;
export const SEDES_MCP_MAXIMUM_CONCURRENT_REQUESTS = 16;
export const SEDES_MCP_MAXIMUM_BATCH_MESSAGES = 32;

export const JSON_RPC_PARSE_ERROR = -32_700;
export const JSON_RPC_INVALID_REQUEST = -32_600;
export const JSON_RPC_METHOD_NOT_FOUND = -32_601;
export const JSON_RPC_INVALID_PARAMS = -32_602;
export const JSON_RPC_INTERNAL_ERROR = -32_603;
/** Implementation-defined server error: too many requests in flight. */
export const JSON_RPC_SERVER_BUSY = -32_000;

export type JsonRpcId = string | number;

const jsonRpcIdSchema = z.union([
  z.string().min(1).max(256),
  z.number().int().safe(),
]);

const paramsSchema = z.record(z.string(), z.unknown());

export const jsonRpcRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: jsonRpcIdSchema,
  method: z.string().min(1).max(256),
  params: paramsSchema.optional(),
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

export const jsonRpcNotificationSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1).max(256),
  params: paramsSchema.optional(),
});
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;

/** Responses to server-initiated requests. The server sends none, so they are ignored. */
const jsonRpcResponseSchema = z.union([
  z.strictObject({
    jsonrpc: z.literal("2.0"),
    id: jsonRpcIdSchema,
    result: z.unknown(),
  }),
  z.strictObject({
    jsonrpc: z.literal("2.0"),
    id: jsonRpcIdSchema.nullable(),
    error: z.unknown(),
  }),
]);

export type InboundJsonRpcMessage =
  | { readonly kind: "request"; readonly message: JsonRpcRequest }
  | { readonly kind: "notification"; readonly message: JsonRpcNotification }
  | { readonly kind: "response" }
  | { readonly kind: "invalid"; readonly id: JsonRpcId | null };

export function classifyJsonRpcMessage(value: unknown): InboundJsonRpcMessage {
  const request = jsonRpcRequestSchema.safeParse(value);
  if (request.success) return { kind: "request", message: request.data };
  const notification = jsonRpcNotificationSchema.safeParse(value);
  if (notification.success) {
    return { kind: "notification", message: notification.data };
  }
  if (jsonRpcResponseSchema.safeParse(value).success) {
    return { kind: "response" };
  }
  const id =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? jsonRpcIdSchema.safeParse((value as { id?: unknown }).id)
      : undefined;
  return { kind: "invalid", id: id?.success ? id.data : null };
}

export const initializeParamsSchema = z.object({
  protocolVersion: z.string().min(1).max(64),
  capabilities: z.record(z.string(), z.unknown()),
  clientInfo: z.object({
    name: z.string().max(256),
    version: z.string().max(256),
  }),
});

export const listToolsParamsSchema = z
  .object({
    cursor: z.string().max(1_024).optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .optional();

export const callToolParamsSchema = z.object({
  name: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

export const cancelledNotificationParamsSchema = z.object({
  requestId: jsonRpcIdSchema,
  reason: z.string().max(4_096).optional(),
});

export function negotiateSedesMcpProtocolVersion(
  requested: string,
): SedesMcpProtocolVersion {
  return (
    SEDES_MCP_PROTOCOL_VERSIONS.find((version) => version === requested) ??
    SEDES_MCP_PROTOCOL_VERSIONS[0]
  );
}

/** ISO dates order lexically, so version features compare as strings. */
export function sedesMcpVersionAtLeast(
  version: SedesMcpProtocolVersion,
  minimum: SedesMcpProtocolVersion,
): boolean {
  return version >= minimum;
}

export function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

export function jsonRpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

/**
 * Splits newline-delimited JSON-RPC from a byte stream. Each line is one
 * complete UTF-8 JSON value; a trailing carriage return is tolerated. A line
 * that is not valid UTF-8 is returned as `null` so it can be answered with a
 * parse error without losing its neighbours. An oversized line is fatal.
 */
export class SedesMcpLineDecoder {
  #pending: Buffer[] = [];
  #pendingBytes = 0;

  push(chunk: Uint8Array): readonly (string | null)[] {
    const lines: (string | null)[] = [];
    let buffer = Buffer.from(chunk);
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      const head = buffer.subarray(0, newline);
      this.#assertBounded(head.byteLength);
      lines.push(this.#decode(Buffer.concat([...this.#pending, head])));
      this.#pending = [];
      this.#pendingBytes = 0;
      buffer = buffer.subarray(newline + 1);
    }
    if (buffer.byteLength > 0) {
      this.#assertBounded(buffer.byteLength);
      this.#pending.push(Buffer.from(buffer));
      this.#pendingBytes += buffer.byteLength;
    }
    return lines.filter((line) => line === null || line.trim().length > 0);
  }

  #assertBounded(additionalBytes: number): void {
    if (
      this.#pendingBytes + additionalBytes >
      SEDES_MCP_MAXIMUM_INBOUND_LINE_BYTES
    ) {
      throw new Error("sedes_mcp_message_too_large");
    }
  }

  #decode(line: Buffer): string | null {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch {
      return null;
    }
    return text.endsWith("\r") ? text.slice(0, -1) : text;
  }
}
