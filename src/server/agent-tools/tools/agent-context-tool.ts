import { Type } from "typebox";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";
import type { AgentSourceContext } from "./agent-tool-readers.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";

const manifest = CANONICAL_AGENT_TOOL_MANIFEST["agent.context"];
export const agentContextToolId = manifest.id;
export const agentContextToolSchemaVersion = manifest.schemaVersion;
export const piAgentContextToolName = "sedes_agent_context";

export type AgentContextInput = Readonly<Record<never, never>>;
export type AgentContextResult = AgentSourceContext;

export const agentContextToolDefinition: AgentToolDefinition<
  AgentContextInput,
  AgentContextResult
> = {
  ...manifest,
  inputSchema: normalizeCanonicalAgentToolSchema(
    Type.Object(
      {},
      {
        $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
        additionalProperties: false,
        maxProperties: 0,
      },
    ),
  ),
  outputSchema: normalizeCanonicalAgentToolSchema(
    Type.Object(
      {
        threadId: Type.String({ minLength: 1, maxLength: 128 }),
        workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
        backend: Type.String({
          maxLength: 32,
          enum: ["pi", "codex_app_server", "claude_agent_sdk", "grok_build"],
        }),
      },
      {
        $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
        additionalProperties: false,
        maxProperties: 3,
      },
    ),
  ),
  requiredCapabilities: [],
  execution: {
    form: "inline",
    adapterWaitCeilingMilliseconds: {
      pi_sdk: 30_000,
      http: 30_000,
      cli: 30_000,
    },
    supportsCancellation: true,
    idempotency: "not_applicable",
    progress: "none",
    maximumInputBytes: 1_024,
    maximumOutputBytes: 1_024,
    concurrencyClass: "agent_context_read",
    uncertainExternalOutcome: false,
  },
  exposure: { adapters: ["pi_sdk", "http", "cli"] },
  adapters: {
    pi: {
      name: piAgentContextToolName,
      label: "Sedes agent context",
      promptSnippet: "Inspect this agent's Sedes source context.",
    },
    http: { invocation: "inline" },
    cli: { command: agentContextToolId },
  },
  async execute(_input, context) {
    if (
      context.defaults.kind !== "thread_agent" ||
      context.subject.kind !== "thread_agent"
    ) {
      throw new Error("agent_source_context_unavailable");
    }
    return {
      threadId: context.defaults.threadId,
      workspaceId: context.defaults.workspaceId,
      backend: context.subject.backendKind,
    };
  },
};
