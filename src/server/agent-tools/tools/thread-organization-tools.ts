import { Type, type TProperties } from "typebox";
import type {
  ThreadGroupCreateToolInput,
  ThreadSetGroupToolInput,
  ThreadSetPinnedToolInput,
} from "../application/agent-thread-inventory-control-service.js";
import type { AgentToolDefinition, TrustedToolInvocationContext } from "../contracts/agent-tool-contracts.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import { AGENT_TOOL_JSON_SCHEMA_DIALECT, normalizeCanonicalAgentToolSchema } from "../schema/canonical-json-schema.js";
import { identifierSchema, sharedAdapters, threadGroupIdToolSchema } from "./management-tool-schemas.js";
import type { AgentThreadControlToolServices } from "./thread-control-tools.js";

const optionalThreadId = Type.Optional(Type.String({
  ...identifierSchema,
  description: "Defaults to the calling thread or the Tool client's configured default thread.",
}));
const nullableGroupId = Type.Union([threadGroupIdToolSchema, Type.Null()], {
  description: "Existing Group UUID, or null for an ungrouped thread.",
});

function rootSchema(fields: TProperties) {
  return normalizeCanonicalAgentToolSchema(Type.Object(fields, {
    $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
    maxProperties: Object.keys(fields).length,
    additionalProperties: false,
  }));
}

function organizationContract(
  id: "thread.set_pinned" | "thread.set_group" | "thread_group.create",
  input: TProperties,
  output: TProperties,
  promptSnippet: string,
) {
  const manifest = CANONICAL_AGENT_TOOL_MANIFEST[id];
  const name = `sedes_${id.replace(".", "_")}`;
  return {
    ...manifest,
    inputSchema: rootSchema({ threadId: optionalThreadId, ...input }),
    outputSchema: rootSchema({ threadId: identifierSchema, ...output }),
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: sharedAdapters,
      supportsCancellation: false,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 8_192,
      maximumOutputBytes: 1_024,
      concurrencyClass: "thread_inventory_write",
      uncertainExternalOutcome: true,
    },
    exposure: { adapters: ["pi_sdk", "pi_rpc", "mcp", "http", "cli"] },
    adapters: {
      pi: { name, label: manifest.catalog.label, promptSnippet },
      mcp: { name },
      http: { invocation: "inline" },
      cli: { command: id },
    },
  } as const;
}

function mutationContext({ mutationId, environmentAuthority }: TrustedToolInvocationContext) {
  return { mutationId, environmentAuthority };
}

function scope({ tenantId, principalId }: TrustedToolInvocationContext) {
  return { tenantId, principalId };
}

export function createThreadSetPinnedToolDefinition(
  services: AgentThreadControlToolServices,
): AgentToolDefinition<ThreadSetPinnedToolInput, { threadId: string; pinned: boolean }> {
  const fields = { pinned: Type.Boolean() };
  return {
    ...organizationContract("thread.set_pinned", fields, fields, "Pin or unpin a Sedes thread."),
    execute(input, context) {
      return services.inventory.setPinned(scope(context), { ...input, ...mutationContext(context) });
    },
  };
}

export function createThreadSetGroupToolDefinition(
  services: AgentThreadControlToolServices,
): AgentToolDefinition<ThreadSetGroupToolInput, { threadId: string; groupId: string | null }> {
  const fields = { groupId: nullableGroupId };
  return {
    ...organizationContract("thread.set_group", fields, fields, "Move a Sedes thread into an existing Group or remove it from its Group."),
    execute(input, context) {
      return services.inventory.setGroup(scope(context), { ...input, ...mutationContext(context) });
    },
  };
}

export function createThreadGroupCreateToolDefinition(
  services: AgentThreadControlToolServices,
): AgentToolDefinition<ThreadGroupCreateToolInput, { threadId: string; groupId: string }> {
  return {
    ...organizationContract(
      "thread_group.create",
      { name: Type.String({ minLength: 1, maxLength: 120 }) },
      { groupId: threadGroupIdToolSchema },
      "Create a new Sedes Group with one founding thread.",
    ),
    execute(input, context) {
      return services.inventory.createGroup(scope(context), { ...input, ...mutationContext(context) });
    },
  };
}
