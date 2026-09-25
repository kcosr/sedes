import { Type } from "typebox";
import { DomainError } from "../../domain/errors.js";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";
import type {
  AgentToolApplicationReader,
  ThreadStatusResult,
} from "./agent-tool-readers.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";

const manifest = CANONICAL_AGENT_TOOL_MANIFEST["thread.status"];
export const threadStatusToolId = manifest.id;
export const threadStatusToolSchemaVersion = manifest.schemaVersion;
export const piThreadStatusToolName = "sedes_thread_status";

export interface ThreadStatusInput {
  readonly threadId: string;
}

export const threadStatusToolContract = {
  ...manifest,
  inputSchema: normalizeCanonicalAgentToolSchema(
    Type.Object(
      { threadId: Type.String({ minLength: 1, maxLength: 128 }) },
      {
        $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
        additionalProperties: false,
        maxProperties: 1,
      },
    ),
  ),
  outputSchema: normalizeCanonicalAgentToolSchema(
    Type.Object(
      {
        threadId: Type.String({ minLength: 1, maxLength: 128 }),
        backend: Type.String({
          maxLength: 32,
          enum: ["pi", "codex_app_server", "claude_agent_sdk", "grok_build"],
        }),
        lifecycle: Type.String({
          maxLength: 8,
          enum: ["active", "snoozed", "settled", "archived"],
        }),
        activity: Type.String({
          maxLength: 17,
          enum: ["idle", "running", "waiting_for_input"],
        }),
      },
      {
        $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
        additionalProperties: false,
        maxProperties: 4,
      },
    ),
  ),
  requiredCapabilities: [],
  execution: {
    form: "inline",
    adapterWaitCeilingMilliseconds: {
      pi_sdk: 30_000,
      mcp: 30_000,
      http: 30_000,
      cli: 30_000,
    },
    supportsCancellation: true,
    idempotency: "not_applicable",
    progress: "none",
    maximumInputBytes: 1_024,
    maximumOutputBytes: 1_024,
    concurrencyClass: "thread_status_read",
    uncertainExternalOutcome: false,
  },
  exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
  adapters: {
    pi: {
      name: piThreadStatusToolName,
      label: "Sedes thread status",
      promptSnippet: "Read bounded status for a Sedes thread.",
    },
    mcp: { name: piThreadStatusToolName },
    http: { invocation: "inline" },
    cli: { command: threadStatusToolId },
  },
} as const satisfies Omit<
  AgentToolDefinition<ThreadStatusInput, ThreadStatusResult>,
  "execute" | "reconstructCompleted"
>;

export function createThreadStatusToolDefinition(
  reader: AgentToolApplicationReader,
): AgentToolDefinition<ThreadStatusInput, ThreadStatusResult> {
  return {
    ...threadStatusToolContract,
    async execute(input, context) {
      const result = await reader.readThreadStatus(
        { tenantId: context.tenantId, principalId: context.principalId },
        input.threadId,
        context.environmentAuthority,
        context.abortSignal,
      );
      if (!result) {
        throw new DomainError("not_found", "The thread was not found.");
      }
      return result;
    },
  };
}
