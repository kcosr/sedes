import type { ErrorObject } from "ajv/dist/2020.js";
import {
  nativeAgentToolName,
  type AgentToolCatalogSummary,
  type AgentToolDescription,
  type SedesToolError,
  type SedesToolInvocationResult,
  type ToolEffects,
} from "../../server/agent-tools/contracts/agent-tool-contracts.js";
import { AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS } from "../../server/agent-tools/contracts/agent-tool-transport-limits.js";
import { deterministicJson } from "../../server/canonical-json.js";
import type { CanonicalAgentToolRootSchema } from "../../server/agent-tools/schema/canonical-json-schema.js";
import {
  sedesMcpVersionAtLeast,
  type SedesMcpProtocolVersion,
} from "./mcp-protocol.js";

/**
 * Pure projection from Sedes agent-tool contracts to MCP tool definitions
 * and results. It holds no transport, credential, or policy state, so any
 * MCP transport can reuse it; `sedes mcp` over stdio is the only one today.
 */

export const SEDES_MCP_GATEWAY_NAMES = Object.freeze({
  catalog: "sedes_catalog",
  read: "sedes_read",
  act: "sedes_act",
} as const);

export interface SedesMcpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface SedesMcpTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: SedesMcpToolAnnotations;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface SedesMcpCallToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: true;
}

/** Sedes's own side-effect-free read: the only effects the read lane admits. */
export function isSideEffectFreeRead(effects: ToolEffects): boolean {
  return (
    effects.application === "read" &&
    effects.modelUsage === "none" &&
    effects.external === "none"
  );
}

function reachesOpenWorld(effects: ToolEffects): boolean {
  return (
    effects.modelUsage === "agent_execution" ||
    effects.external === "durable_side_effect"
  );
}

/**
 * Hints come only from declared effects. Clients such as Codex auto-approve
 * read-only tools and ask before destructive or open-world ones.
 */
export function sedesMcpToolAnnotations(
  effects: ToolEffects,
): Omit<SedesMcpToolAnnotations, "title"> {
  if (isSideEffectFreeRead(effects)) {
    return { readOnlyHint: true, openWorldHint: false };
  }
  return {
    readOnlyHint: false,
    destructiveHint: effects.application === "destructive",
    openWorldHint: reachesOpenWorld(effects),
  };
}

/**
 * MCP defaults tool schemas to JSON Schema 2020-12, and the canonical subset
 * uses only dialect-neutral keywords, so the explicit dialect is dropped for
 * clients that reject `$schema` inside function parameters.
 */
function withoutDialect(
  schema: CanonicalAgentToolRootSchema,
): Readonly<Record<string, unknown>> {
  const { $schema: _dialect, ...rest } = schema;
  return rest;
}

function versionedTool(
  version: SedesMcpProtocolVersion,
  tool: {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
    readonly annotations: Omit<SedesMcpToolAnnotations, "title">;
    readonly meta?: Readonly<Record<string, unknown>>;
  },
): SedesMcpTool {
  const current = sedesMcpVersionAtLeast(version, "2025-06-18");
  return Object.freeze({
    name: tool.name,
    ...(current ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(current && tool.outputSchema
      ? { outputSchema: tool.outputSchema }
      : {}),
    ...(sedesMcpVersionAtLeast(version, "2025-03-26")
      ? { annotations: { title: tool.title, ...tool.annotations } }
      : {}),
    ...(current && tool.meta ? { _meta: tool.meta } : {}),
  });
}

/** One MCP tool per canonical operation, named like its Pi native tool. */
export function projectSedesMcpTool(
  description: AgentToolDescription,
  version: SedesMcpProtocolVersion,
): SedesMcpTool {
  return versionedTool(version, {
    name: nativeAgentToolName(description.id),
    title: description.label,
    description: description.description,
    inputSchema: withoutDialect(description.inputSchema),
    outputSchema: withoutDialect(description.outputSchema),
    annotations: sedesMcpToolAnnotations(description.effects),
    meta: {
      "sedes/toolId": description.id,
      "sedes/schemaVersion": description.schemaVersion,
    },
  });
}

const gatewayCatalogInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["list", "describe"],
      description:
        "list returns compact summaries; describe returns complete contracts for toolIds.",
    },
    toolIds: {
      type: "array",
      minItems: 1,
      maxItems: AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 128 },
      description: `Required with describe: 1-${AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS} IDs from the current list.`,
    },
  },
});

const gatewayEnvelopeInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["toolId", "schemaVersion", "input"],
  properties: {
    toolId: { type: "string", minLength: 1, maxLength: 128 },
    schemaVersion: { type: "integer", minimum: 1, maximum: 1_000_000 },
    input: { type: "object" },
  },
});

const catalogDescription = [
  "Discover the current policy-filtered Sedes operation catalog: list it first, then describe up to 16 selected operation IDs before invoking them.",
  "Treat each described tool ID, schema version, effects, and input schema as authoritative.",
  "Invoke exactly one described side-effect-free read through sedes_read, or exactly one described write, destructive, model-usage, or external-side-effect operation through sedes_act.",
].join(" ");

const laneGuideline =
  "First use sedes_catalog to list the current catalog and describe the selected operation. Do not guess a tool ID, schema version, input field, or remembered contract.";

/**
 * The three stable progressive gateways. A lane is offered only when the
 * current catalog has an operation for it, as in Pi native presentation.
 */
export function sedesMcpGatewayTools(
  summaries: readonly AgentToolCatalogSummary[],
  version: SedesMcpProtocolVersion,
): readonly SedesMcpTool[] {
  if (summaries.length === 0) return Object.freeze([]);
  const reads = summaries.filter(({ effects }) => isSideEffectFreeRead(effects));
  const actions = summaries.filter(
    ({ effects }) => !isSideEffectFreeRead(effects),
  );
  const tools = [
    versionedTool(version, {
      name: SEDES_MCP_GATEWAY_NAMES.catalog,
      title: "Sedes tool catalog",
      description: catalogDescription,
      inputSchema: gatewayCatalogInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    }),
  ];
  if (reads.length > 0) {
    tools.push(
      versionedTool(version, {
        name: SEDES_MCP_GATEWAY_NAMES.read,
        title: "Run Sedes read",
        description: `Invoke exactly one side-effect-free Sedes read from the current catalog using its exact described tool ID, schema version, and input schema. ${laneGuideline} Use this lane only when the described effects are application=read, modelUsage=none, and external=none.`,
        inputSchema: gatewayEnvelopeInputSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      }),
    );
  }
  if (actions.length > 0) {
    tools.push(
      versionedTool(version, {
        name: SEDES_MCP_GATEWAY_NAMES.act,
        title: "Run Sedes action",
        description: `Invoke exactly one Sedes write, destructive, model-usage, or external-side-effect operation from the current catalog using its exact described tool ID, schema version, and input schema. ${laneGuideline} Use this lane when any described effect can change application state, use a model, or produce an external side effect.`,
        inputSchema: gatewayEnvelopeInputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: actions.some(
            ({ effects }) => effects.application === "destructive",
          ),
          openWorldHint: actions.some(({ effects }) =>
            reachesOpenWorld(effects),
          ),
        },
      }),
    );
  }
  return Object.freeze(tools);
}

/** Catalog summaries without the CLI command path, which MCP never uses. */
export function sedesMcpCatalogSummaries(
  summaries: readonly AgentToolCatalogSummary[],
): readonly Omit<AgentToolCatalogSummary, "cli">[] {
  return Object.freeze(
    summaries.map(({ cli: _cli, ...summary }) => Object.freeze(summary)),
  );
}

export function sedesMcpJsonResult(
  value: unknown,
  version: SedesMcpProtocolVersion,
): SedesMcpCallToolResult {
  const structured =
    sedesMcpVersionAtLeast(version, "2025-06-18") &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value);
  return Object.freeze({
    content: [{ type: "text" as const, text: deterministicJson(value) }],
    ...(structured
      ? { structuredContent: value as Readonly<Record<string, unknown>> }
      : {}),
  });
}

/**
 * A tool-level failure the model can read and act on. Codes are canonical
 * Sedes error codes or the CLI transport codes such as `transport_error`.
 */
export function sedesMcpToolError(error: {
  readonly code: SedesToolError["code"] | (string & {});
  readonly message: string;
  readonly retryable: boolean;
}): SedesMcpCallToolResult {
  return Object.freeze({
    content: [
      {
        type: "text" as const,
        text: deterministicJson({
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
          },
        }),
      },
    ],
    isError: true as const,
  });
}

/** Maps one canonical invocation result without exposing its envelope. */
export function sedesMcpInvocationResult(
  result: SedesToolInvocationResult<unknown>,
  version: SedesMcpProtocolVersion,
): SedesMcpCallToolResult {
  switch (result.state) {
    case "completed":
      return sedesMcpJsonResult(result.output, version);
    case "accepted":
    case "running":
    case "waiting_for_input":
    case "cancel_requested":
      return sedesMcpJsonResult(
        {
          state: result.state,
          operationId: result.operationId,
          ...(result.retryAfterMilliseconds === undefined
            ? {}
            : { retryAfterMilliseconds: result.retryAfterMilliseconds }),
        },
        version,
      );
    case "failed":
    case "uncertain":
    case "cancelled":
      return sedesMcpToolError(result.error);
  }
}

const MAXIMUM_REPORTED_SCHEMA_ERRORS = 8;

/** A bounded, model-actionable summary of canonical input schema errors. */
export function sedesMcpInputSchemaError(
  errors: readonly ErrorObject[],
): SedesMcpCallToolResult {
  const details = errors
    .slice(0, MAXIMUM_REPORTED_SCHEMA_ERRORS)
    .map(
      ({ instancePath, message }) =>
        `${instancePath || "/"} ${message ?? "is invalid"}`.slice(0, 200),
    );
  return sedesMcpToolError({
    code: "invalid_input",
    message:
      details.length > 0
        ? `The tool input does not match its current schema: ${details.join("; ")}.`
        : "The tool input does not match its current schema.",
    retryable: false,
  });
}
