import { z } from "zod";
import {
  agentToolCatalogSummarySchema,
  agentToolCliErrorSchema,
  agentToolCliIdentifierSchema,
  agentToolCliToolIdSchema,
  agentToolCliTransportLimits,
  agentToolDescriptionSchema,
  agentToolInvocationResultSchema,
  isBoundedAgentToolJson,
} from "../agent-tool-cli-protocol/index.js";
import { defineSidecarOperation } from "./operation-registry.js";

const sourceCapabilitySchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);
const sourceCapabilityRequestSchema = z.strictObject({
  sourceCapability: sourceCapabilitySchema,
});
const errorResultSchema = z.strictObject({
  outcome: z.literal("error"),
  error: agentToolCliErrorSchema,
});
const toolIdsSchema = z
  .array(agentToolCliToolIdSchema)
  .min(1)
  .max(16)
  .superRefine((toolIds, context) => {
    if (new Set(toolIds).size !== toolIds.length) {
      context.addIssue({ code: "custom", message: "Tool IDs must be unique." });
    }
  });
const boundedInputSchema = z.custom(
  isBoundedAgentToolJson,
  "A bounded JSON value is required.",
);

export const agentToolsCatalogOperation = defineSidecarOperation({
  capabilityId: "agent_tools_cli",
  majorVersion: 3,
  operation: "catalog.list",
  lane: "operation",
  maximumDeadlineMilliseconds: 30_000,
  requestSchema: sourceCapabilityRequestSchema,
  responseSchema: z.discriminatedUnion("outcome", [
    z.strictObject({
      outcome: z.literal("ok"),
      tools: z
        .array(agentToolCatalogSummarySchema)
        .max(agentToolCliTransportLimits.maximumCatalogTools)
        .readonly(),
    }),
    errorResultSchema,
  ]),
});

export const agentToolsDescribeOperation = defineSidecarOperation({
  capabilityId: "agent_tools_cli",
  majorVersion: 3,
  operation: "catalog.describe",
  lane: "operation",
  maximumDeadlineMilliseconds: 30_000,
  requestSchema: z.strictObject({
    sourceCapability: sourceCapabilitySchema,
    toolIds: toolIdsSchema,
  }),
  responseSchema: z.discriminatedUnion("outcome", [
    z.strictObject({
      outcome: z.literal("ok"),
      tools: z.array(agentToolDescriptionSchema).min(1).max(16).readonly(),
    }),
    errorResultSchema,
  ]),
});

export const agentToolsInvokeOperation = defineSidecarOperation({
  capabilityId: "agent_tools_cli",
  majorVersion: 3,
  operation: "tool.invoke",
  lane: "operation",
  maximumDeadlineMilliseconds: "caller_abort",
  requestSchema: z.strictObject({
    sourceCapability: sourceCapabilitySchema,
    toolId: agentToolCliToolIdSchema,
    schemaVersion: z.number().int().positive().max(1_000_000),
    requestId: agentToolCliIdentifierSchema,
    input: boundedInputSchema,
  }),
  responseSchema: z.discriminatedUnion("outcome", [
    z.strictObject({
      outcome: z.literal("ok"),
      result: agentToolInvocationResultSchema,
    }),
    errorResultSchema,
  ]),
});

export const agentToolsV3Operations = Object.freeze([
  agentToolsCatalogOperation,
  agentToolsDescribeOperation,
  agentToolsInvokeOperation,
]);
