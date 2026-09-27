import { z } from "zod";
import { createAgentToolInvocationRequestSchema, agentToolCatalogSummarySchema } from "../agent-tool-cli-protocol/contracts.js";

export const OPENCODE_MCP_ENDPOINT = "SEDES_OPENCODE_MCP_ENDPOINT";
export const OPENCODE_MCP_CREDENTIAL = "SEDES_OPENCODE_MCP_CREDENTIAL";
export const OPENCODE_MCP_HEARTBEAT_MS = 500;
export const OPENCODE_MCP_WATCHDOG_MS = 3_000;
export const OPENCODE_MCP_STARTUP_MS = 10_000;
export const OPENCODE_MCP_MAXIMUM_BYTES = 1_048_576;
export const opencodeMcpSession = z.string().max(160).regex(/^ses_[A-Za-z0-9_-]+$/u);
export const opencodeMcpCredential = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const opencodeMcpStream = z.string().uuid();
export const opencodeMcpRequest = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list"), sessionID: opencodeMcpSession }).strict(),
  z.object({ operation: z.literal("describe"), sessionID: opencodeMcpSession,
    toolIds: z.array(z.string().min(1).max(128)).min(1).max(16) }).strict(),
  z.object({ operation: z.literal("invoke"), sessionID: opencodeMcpSession,
    request: createAgentToolInvocationRequestSchema }).strict(),
]);
export type OpenCodeMcpRequest = z.infer<typeof opencodeMcpRequest>;
export const opencodeMcpHello = z.object({ streamID: opencodeMcpStream,
  catalog: z.array(agentToolCatalogSummarySchema).max(256) }).strict();
export function opencodeMcpEndpoint(value: string | undefined): string {
  if (!value || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(value) || new URL(value).port === "") {
    throw new Error("opencode_mcp_environment_invalid");
  }
  return value;
}
