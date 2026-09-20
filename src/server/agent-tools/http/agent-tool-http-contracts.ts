import { z } from "zod";
import type {
  AgentToolCatalogSummary,
  AgentToolContractArtifact,
  AgentToolDescription,
  SedesToolInvocationResult,
} from "../contracts/agent-tool-contracts.js";
import {
  AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS,
  AGENT_TOOL_MAXIMUM_HTTP_TOOL_OUTPUT_BYTES,
  AGENT_TOOL_MAXIMUM_RESPONSE_BYTES,
} from "../contracts/agent-tool-transport-limits.js";
import { normalizeCanonicalAgentToolSchema } from "../schema/canonical-json-schema.js";
import { agentToolCliErrorSchema } from "../../../internal/agent-tool-cli-protocol/contracts.js";
export {
  agentToolCatalogResponseSchema,
  agentToolCatalogSummarySchema,
  agentToolDescriptionSchema,
  agentToolDescriptionsResponseSchema,
  agentToolInvocationResultSchema,
  createAgentToolDescriptionsRequestSchema,
  createAgentToolInvocationRequestSchema,
} from "../../../internal/agent-tool-cli-protocol/contracts.js";
export type {
  CreateAgentToolDescriptionsRequest,
  CreateAgentToolInvocationRequest,
} from "../../../internal/agent-tool-cli-protocol/contracts.js";

export const SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER =
  "X-Sedes-Agent-Tool-Source-Capability" as const;
export const SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER =
  "X-Sedes-Agent-Tool-Client-Credential" as const;
export const SEDES_AGENT_TOOL_CSRF_ROUTE = "/api/agent-tool-csrf" as const;

export const agentToolTransportLimits = Object.freeze({
  maximumCatalogTools: 256,
  maximumResponseBytes: AGENT_TOOL_MAXIMUM_RESPONSE_BYTES,
  maximumJsonDepth: 16,
  maximumJsonNodes: 8_192,
});

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const toolIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const adapterSchema = z.enum(["pi_sdk", "mcp", "http", "cli"]);

function isCanonicalRootSchema(value: unknown): boolean {
  try {
    normalizeCanonicalAgentToolSchema(value);
    return true;
  } catch {
    return false;
  }
}

export function isBoundedAgentToolJson(value: unknown): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (
      nodes > agentToolTransportLimits.maximumJsonNodes ||
      current.depth > agentToolTransportLimits.maximumJsonDepth
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
      if (current.value.length > 65_536) return false;
      continue;
    }
    if (typeof current.value !== "object") return false;
    if (Array.isArray(current.value)) {
      if (current.value.length > 1_024) return false;
      for (const child of current.value) {
        pending.push({ value: child, depth: current.depth + 1 });
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
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return true;
}

const canonicalRootSchema = z.custom(
  isCanonicalRootSchema,
  "A canonical agent-tool JSON Schema is required.",
);
const boundedJsonSchema = z.custom(
  isBoundedAgentToolJson,
  "A bounded JSON value is required.",
);

const agentToolContractArtifactBaseSchema = z.strictObject({
  artifactVersion: z.literal(2),
  id: toolIdSchema,
  schemaVersion: z.number().int().positive().max(1_000_000),
  description: z.string().min(1).max(2_000),
  inputSchema: canonicalRootSchema,
  outputSchema: canonicalRootSchema,
  requiredCapabilities: z.array(toolIdSchema).max(64),
  callerEligibility: z
    .array(z.enum(["thread_agent", "principal_client"]))
    .min(1)
    .max(2),
  effects: z.strictObject({
    application: z.enum(["read", "write", "destructive"]),
    modelUsage: z.enum(["none", "agent_execution"]),
    external: z.enum(["none", "durable_side_effect"]),
  }),
  execution: z.strictObject({
    form: z.enum(["inline", "operation", "hybrid"]),
    adapterWaitCeilingMilliseconds: z.partialRecord(
      adapterSchema,
      z
        .number()
        .int()
        .positive()
        .max(10 * 60_000),
    ),
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
    concurrencyClass: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/),
    uncertainExternalOutcome: z.boolean(),
  }),
  exposure: z.strictObject({ adapters: z.array(adapterSchema).min(1).max(5) }),
  catalog: z.strictObject({
    groupId: z.enum([
      "context",
      "files",
      "threads",
      "agents",
      "tasks",
      "automations",
    ]),
    label: z.string().min(1).max(120),
    order: z.number().int().nonnegative().max(10_000),
  }),
  deployment: z.strictObject({ eligible: z.boolean() }),
  adapters: z.strictObject({
    pi: z
      .strictObject({
        name: z.string().min(1).max(128),
        label: z.string().min(1).max(120),
        promptSnippet: z.string().min(1).max(500).optional(),
        promptGuidelines: z
          .array(z.string().min(1).max(500))
          .max(32)
          .optional(),
      })
      .optional(),
    http: z.strictObject({ invocation: z.literal("inline") }).optional(),
    mcp: z
      .strictObject({
        name: z.string().min(1).max(128),
        title: z.string().min(1).max(120).optional(),
      })
      .optional(),
    cli: z
      .strictObject({
        command: z.string().min(1).max(128),
      })
      .optional(),
  }),
});

export const agentToolContractArtifactSchema: z.ZodType<AgentToolContractArtifact> =
  agentToolContractArtifactBaseSchema.superRefine((artifact, context) => {
    if (
      artifact.exposure.adapters.includes("http") &&
      artifact.execution.maximumOutputBytes >
        AGENT_TOOL_MAXIMUM_HTTP_TOOL_OUTPUT_BYTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["execution", "maximumOutputBytes"],
        message:
          "HTTP tool output plus invocation envelope exceeds the transport limit.",
      });
    }
  }) as z.ZodType<AgentToolContractArtifact>;

export const agentToolCsrfResponseSchema = z.strictObject({
  csrfToken: z.string().min(1).max(256),
});
export const agentToolHttpErrorResponseSchema = z.strictObject({
  error: agentToolCliErrorSchema.extend({
    code: z.union([
      agentToolCliErrorSchema.shape.code,
      z.enum([
        "bad_request",
        "application_draining",
        "csrf_token_invalid",
        "host_not_allowed",
        "origin_not_allowed",
        "forwarded_origin_not_allowed",
      ]),
    ]),
  }),
});
