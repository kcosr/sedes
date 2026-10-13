import { z } from "zod";
import type {
  AgentToolCatalogSummary,
  AgentToolDescription,
  SedesToolInvocationResult,
} from "../../server/agent-tools/contracts/agent-tool-contracts.js";
import type { CanonicalJsonValue } from "../../server/canonical-json.js";
import {
  AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS,
  AGENT_TOOL_MAXIMUM_RESPONSE_BYTES,
} from "../../server/agent-tools/contracts/agent-tool-transport-limits.js";
import { normalizeCanonicalAgentToolSchema } from "../../server/agent-tools/schema/canonical-json-schema.js";
import { agentToolModelContentsSchema } from "./model-content.js";
import { isWorkpadInputContentPath, workpadInputContentError, workpadToolContentSchema, workpadToolOutputSchema } from "./workpad-content.js";

export const agentToolCliTransportLimits = Object.freeze({
  maximumCatalogTools: 256,
  maximumResponseBytes: AGENT_TOOL_MAXIMUM_RESPONSE_BYTES,
  maximumJsonDepth: 16,
  maximumJsonNodes: 8_192,
});

export const agentToolCliIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
export const agentToolCliToolIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

export function isBoundedAgentToolJson(value: unknown, contentPath?: (path: readonly string[]) => boolean): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number; readonly path: readonly string[] }> = [
    { value, depth: 0, path: [] },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (
      nodes > agentToolCliTransportLimits.maximumJsonNodes ||
      current.depth > agentToolCliTransportLimits.maximumJsonDepth
    ) {
      return false;
    }
    if (
      current.value === null ||
      typeof current.value === "boolean" ||
      (typeof current.value === "number" && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (typeof current.value === "string") {
      if (contentPath?.(current.path)) {
        if (!workpadToolContentSchema.safeParse(current.value).success) return false;
      } else if (current.value.length > 65_536) return false;
      continue;
    }
    if (typeof current.value !== "object") return false;
    if (Array.isArray(current.value)) {
      if (current.value.length > 1_024) return false;
      for (let index = 0; index < current.value.length; index++) {
        pending.push({ value: current.value[index], depth: current.depth + 1, path: [...current.path, String(index)] });
      }
      continue;
    }
    if (
      Object.getPrototypeOf(current.value) !== Object.prototype ||
      Object.getOwnPropertySymbols(current.value).length > 0
    ) {
      return false;
    }
    const keys = Object.keys(current.value);
    if (keys.length > 256 || keys.some((key) => key.length > 256)) return false;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (!descriptor || !("value" in descriptor)) return false;
      pending.push({ value: descriptor.value, depth: current.depth + 1, path: [...current.path, key] });
    }
  }
  return true;
}

const canonicalRootSchema = z.custom((value) => {
  try {
    normalizeCanonicalAgentToolSchema(value);
    return true;
  } catch {
    return false;
  }
}, "A canonical agent-tool JSON Schema is required.");
export function isBoundedAgentToolOutput(value: unknown): boolean {
  if (isBoundedAgentToolJson(value)) return true;
  // Prove plain, bounded JSON before schema parsing can inspect properties.
  return isBoundedAgentToolJson(value,
    path => path.length === 2 && path[0] === "workpad" && path[1] === "content") &&
    workpadToolOutputSchema.safeParse(value).success;
}

const boundedJsonSchema = z.custom<CanonicalJsonValue>(
  value => isBoundedAgentToolJson(value),
  "A bounded JSON value is required.",
);
const boundedOutputJsonSchema = z.custom<CanonicalJsonValue>(
  isBoundedAgentToolOutput,
  "A bounded JSON value is required.",
);
const effectsSchema = z.strictObject({
  application: z.enum(["read", "write", "destructive"]),
  modelUsage: z.enum(["none", "agent_execution"]),
  external: z.enum(["none", "durable_side_effect"]),
});

export const agentToolCatalogSummarySchema: z.ZodType<AgentToolCatalogSummary> =
  z.strictObject({
    id: agentToolCliToolIdSchema,
    schemaVersion: z.number().int().positive().max(1_000_000),
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(2_000),
    group: z.strictObject({
      id: z.enum([
        "client",
      "context",
        "threads",
        "agents",
        "tasks",
        "workpads",
        "pages",
        "images",
        "automations",
        "research",
      ]),
      order: z.number().int().nonnegative().max(10_000),
    }),
    effects: effectsSchema,
    outputMediaTypes: z.tuple([z.literal("image/png")]).readonly().optional(),
    cli: z
      .strictObject({
        commandPath: z
          .array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/))
          .min(1)
          .max(4),
      })
      .optional(),
  });

export const agentToolDescriptionSchema: z.ZodType<AgentToolDescription> =
  z.strictObject({
    id: agentToolCliToolIdSchema,
    schemaVersion: z.number().int().positive().max(1_000_000),
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(2_000),
    inputSchema: canonicalRootSchema,
    outputSchema: canonicalRootSchema,
    outputMediaTypes: z.tuple([z.literal("image/png")]).readonly().optional(),
    effects: effectsSchema,
    execution: z.strictObject({
      form: z.enum(["inline", "operation", "hybrid"]),
      waitCeilingMilliseconds: z
        .number()
        .int()
        .positive()
        .max(10 * 60_000),
      supportsCancellation: z.boolean(),
      idempotency: z.enum(["required", "supported", "not_applicable"]),
      progress: z.enum(["none", "structured"]),
      maximumInputBytes: z
        .number()
        .int()
        .positive()
        .max(4 * 1_024 * 1_024),
      maximumOutputBytes: z
        .number()
        .int()
        .positive()
        .max(AGENT_TOOL_MAXIMUM_RESPONSE_BYTES),
      uncertainExternalOutcome: z.boolean(),
    }),
  }) as z.ZodType<AgentToolDescription>;

export const agentToolCatalogResponseSchema = z.strictObject({
  tools: z
    .array(agentToolCatalogSummarySchema)
    .max(agentToolCliTransportLimits.maximumCatalogTools)
    .readonly(),
});
export const createAgentToolDescriptionsRequestSchema = z.strictObject({
  toolIds: z
    .array(agentToolCliToolIdSchema)
    .min(1)
    .max(AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS)
    .superRefine((toolIds, context) => {
      if (new Set(toolIds).size !== toolIds.length) {
        context.addIssue({
          code: "custom",
          message: "Tool IDs must be unique.",
        });
      }
    }),
});
export const agentToolDescriptionsResponseSchema = z.strictObject({
  tools: z
    .array(agentToolDescriptionSchema)
    .min(1)
    .max(AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS)
    .readonly(),
});
export const createAgentToolInvocationRequestSchema = z.strictObject({
  toolId: agentToolCliToolIdSchema,
  schemaVersion: z.number().int().positive().max(1_000_000),
  requestId: agentToolCliIdentifierSchema,
  input: z.unknown(),
}).superRefine((request, context) => {
  const contentError = workpadInputContentError(request.toolId, request.input);
  if (contentError || !isBoundedAgentToolJson(request.input, path => isWorkpadInputContentPath(request.toolId, path))) {
    context.addIssue({ code: "custom", path: ["input"], message: contentError ?? "A bounded JSON value is required." });
  }
});
export const agentToolCliErrorSchema = z.strictObject({
  code: z.enum([
    "invalid_input",
    "unauthenticated",
    "permission_denied",
    "not_found",
    "conflict",
    "rate_limited",
    "unavailable",
    "timed_out",
    "cancelled",
    "uncertain_outcome",
    "internal_error",
  ]),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
  details: boundedJsonSchema.optional(),
});
export const agentToolInvocationResultSchema: z.ZodType<
  SedesToolInvocationResult<unknown>
> = z.discriminatedUnion("state", [
  z.strictObject({
    invocationId: agentToolCliIdentifierSchema,
    state: z.literal("completed"),
    output: boundedOutputJsonSchema,
    modelContent: agentToolModelContentsSchema.optional(),
  }),
  z.strictObject({
    invocationId: agentToolCliIdentifierSchema,
    state: z.enum([
      "accepted",
      "running",
      "waiting_for_input",
      "cancel_requested",
    ]),
    operationId: agentToolCliIdentifierSchema,
    retryAfterMilliseconds: z.number().int().positive().optional(),
  }),
  z.strictObject({
    invocationId: agentToolCliIdentifierSchema,
    state: z.enum(["failed", "uncertain", "cancelled"]),
    error: agentToolCliErrorSchema,
    operationId: agentToolCliIdentifierSchema.optional(),
  }),
]).superRefine((result, context) => {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > AGENT_TOOL_MAXIMUM_RESPONSE_BYTES) {
    context.addIssue({ code: "custom", message: "The tool response exceeds its transport limit." });
  }
}) as z.ZodType<SedesToolInvocationResult<unknown>>;

export type CreateAgentToolDescriptionsRequest = z.infer<
  typeof createAgentToolDescriptionsRequestSchema
>;
export type CreateAgentToolInvocationRequest = z.infer<
  typeof createAgentToolInvocationRequestSchema
>;
