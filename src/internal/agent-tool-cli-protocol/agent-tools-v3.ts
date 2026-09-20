import { z } from "zod";
import type {
  AgentToolCatalogSummary,
  AgentToolDescription,
  SedesToolError,
  SedesToolInvocationResult,
} from "../../server/agent-tools/contracts/agent-tool-contracts.js";
import {
  agentToolCatalogResponseSchema,
  agentToolDescriptionsResponseSchema,
  agentToolInvocationResultSchema,
  agentToolCliErrorSchema,
  agentToolCliToolIdSchema,
  createAgentToolInvocationRequestSchema,
} from "./contracts.js";

export const AGENT_TOOL_CLI_PROTOCOL_VERSION = 3 as const;

const transportRequestIdSchema = z.uuid();
const sourceCapabilitySchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);
const toolIdsSchema = z
  .array(agentToolCliToolIdSchema)
  .min(1)
  .max(16)
  .superRefine((toolIds, context) => {
    if (new Set(toolIds).size !== toolIds.length) {
      context.addIssue({ code: "custom", message: "Tool IDs must be unique." });
    }
  });

export const agentToolCliOperationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("list") }),
  z.strictObject({ type: z.literal("describe"), toolIds: toolIdsSchema }),
  z.strictObject({
    type: z.literal("invoke"),
    request: createAgentToolInvocationRequestSchema,
  }),
]);

export const agentToolCliRequestSchema = z.strictObject({
  protocolVersion: z.literal(AGENT_TOOL_CLI_PROTOCOL_VERSION),
  requestId: transportRequestIdSchema,
  sourceCapability: sourceCapabilitySchema,
  operation: agentToolCliOperationSchema,
});

export const agentToolCliResultSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("list"),
    value: agentToolCatalogResponseSchema,
  }),
  z.strictObject({
    type: z.literal("describe"),
    value: agentToolDescriptionsResponseSchema,
  }),
  z.strictObject({
    type: z.literal("invoke"),
    value: agentToolInvocationResultSchema,
  }),
]);

const responseIdentitySchema = {
  protocolVersion: z.literal(AGENT_TOOL_CLI_PROTOCOL_VERSION),
  requestId: transportRequestIdSchema,
};

export const agentToolCliResponseSchema = z.union([
  z.strictObject({
    ...responseIdentitySchema,
    result: agentToolCliResultSchema,
  }),
  z.strictObject({ ...responseIdentitySchema, error: agentToolCliErrorSchema }),
]);

export type AgentToolCliOperation = z.infer<typeof agentToolCliOperationSchema>;
export type AgentToolCliRequest = z.infer<typeof agentToolCliRequestSchema>;
export type AgentToolCliResult =
  | Readonly<{
      readonly type: "list";
      readonly value: { readonly tools: readonly AgentToolCatalogSummary[] };
    }>
  | Readonly<{
      readonly type: "describe";
      readonly value: { readonly tools: readonly AgentToolDescription[] };
    }>
  | Readonly<{
      readonly type: "invoke";
      readonly value: SedesToolInvocationResult<unknown>;
    }>;
export type AgentToolCliResponse = z.infer<typeof agentToolCliResponseSchema>;
export type AgentToolCliError = SedesToolError;
