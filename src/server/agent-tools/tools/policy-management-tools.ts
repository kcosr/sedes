import { Type, type TProperties } from "typebox";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import { AGENT_TOOL_JSON_SCHEMA_DIALECT, normalizeCanonicalAgentToolSchema } from "../schema/canonical-json-schema.js";
import { identifierSchema, isoDateSchema, sharedAdapters } from "./management-tool-schemas.js";
import { agentToolPresentationToolSchema as presentation, agentToolResourceScopeToolSchema as resourceScope, toolPolicySelectionToolSchema as selection } from "./saved-agent-tool-schemas.js";
import type { PolicyManagementAgentToolService } from "./policy-management-agent-tool-service.js";

const object = (properties: TProperties) => Type.Object(properties, { additionalProperties: false, maxProperties: Object.keys(properties).length });
const root = (properties: TProperties, minProperties?: number) => normalizeCanonicalAgentToolSchema({ ...object(properties), ...(minProperties === undefined ? {} : { minProperties }), $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT });
const enumeration = (values: readonly string[]) => Type.String({ enum: values, maxLength: Math.max(...values.map(value => value.length)) });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const name = Type.String({ minLength: 1, maxLength: 160 });
const targetId = Type.String({ minLength: 1, maxLength: 160 });
const toolIds = Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 512, uniqueItems: true });
const definition = { name, enabledToolIds: toolIds, resourceScope };
const policySet = object({ ...definition, id: identifierSchema, revision, createdAt: isoDateSchema, updatedAt: isoDateSchema });
const policyReference = object({ id: identifierSchema, revision });
const appliedPolicy = object({ id: identifierSchema, name, revision });
const presentationOptions = Type.Array(object({ surface: enumeration(["native", "cli"]), modes: Type.Array(enumeration(["individual", "progressive"]), { minItems: 1, maxItems: 2, uniqueItems: true }) }), { minItems: 1, maxItems: 2 });
const target = Type.Union([
  object({ kind: enumeration(["account"]) }),
  object({ kind: enumeration(["environment"]), executionEnvironmentId: targetId }),
  object({ kind: enumeration(["backend"]), backendId: targetId }),
]);
const setting = { target, selection, revision };
const cursor = Type.String({ minLength: 1, maxLength: 4096 });
const templateCursor = Type.String({ minLength: 1, maxLength: 2048 });
const pageSize = Type.Integer({ minimum: 1, maximum: 100 });
const text = Type.String({ maxLength: 4096 });
const effects = object({ application: enumeration(["read", "write", "destructive"]), modelUsage: enumeration(["none", "agent_execution"]), external: enumeration(["none", "durable_side_effect"]) });
const descriptor = object({ id: Type.String({ minLength: 1, maxLength: 128 }), label: text, description: Type.Optional(text), order: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), effects, available: Type.Boolean(), unavailableReason: Type.Optional(text) });
const group = object({ id: Type.String({ minLength: 1, maxLength: 128 }), label: text, description: text, order: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), tools: Type.Array(descriptor, { minItems: 1, maxItems: 512 }) });
const snapshot = {
  threadId: identifierSchema, enabled: Type.Boolean(), enabledToolIds: toolIds,
  resourceScope, presentation, presentationOptions, revision,
  policySet: Type.Union([appliedPolicy, Type.Null()]),
};
const template = object({
  id: identifierSchema, name, workspaceId: identifierSchema, targetId, agentId: identifierSchema,
  executionWorkspace: Type.Union([
    object({ kind: enumeration(["direct"]) }),
    object({ kind: enumeration(["isolated"]), workspaceAccess: enumeration(["writable_clone", "read_only"]), networkProfile: enumeration(["isolated", "execution_host"]) }),
  ]),
  toolPolicySelection: selection, toolPresentation: Type.Optional(presentation),
  capturedAgentName: name, capturedWorkspaceName: Type.String({ minLength: 1, maxLength: 240 }),
  capturedTargetName: Type.String({ minLength: 1, maxLength: 120 }), revision,
  createdAt: isoDateSchema, updatedAt: isoDateSchema,
});

const schemas = {
  "tool_policy.options": { input: root({}), output: root({ groups: Type.Array(group, { maxItems: 64 }) }) },
  "tool_policy.list": { input: root({ cursor: Type.Optional(cursor), pageSize: Type.Optional(pageSize) }), output: root({ items: Type.Array(policySet, { maxItems: 100 }), nextCursor: Type.Optional(cursor) }) },
  "tool_policy.get": { input: root({ policySetId: identifierSchema }), output: root({ policySet }) },
  "tool_policy.create": { input: root(definition), output: root({ policySet }) },
  "tool_policy.update": { input: root({ policySetId: identifierSchema, expectedRevision: revision, ...definition }), output: root({ policySet }) },
  "tool_policy.remove": { input: root({ policySetId: identifierSchema, expectedRevision: revision }), output: root({ deleted: Type.Boolean() }) },
  "tool_policy.defaults.get": { input: root({ target }), output: root({ setting: object(setting) }) },
  "tool_policy.defaults.update": { input: root({ target, selection, expectedRevision: revision }), output: root({ setting: object(setting) }) },
  "tool_policy.preview": {
    input: root({ targetId, agentId: Type.Optional(identifierSchema), agentSelection: Type.Optional(selection), threadSelection: Type.Optional(selection) }),
    output: root({ enabled: Type.Boolean(), enabledToolIds: toolIds, resourceScope, source: enumeration(["default", "account", "environment", "backend", "agent", "thread"]), policySet: Type.Optional(appliedPolicy), presentationOptions, defaultPresentation: presentation }),
  },
  "thread.tool_settings.get": { input: root({ threadId: identifierSchema }), output: root(snapshot) },
  "thread.tool_settings.update": {
    input: root({ threadId: identifierSchema, mutationId: identifierSchema, expectedPolicyRevision: revision, enabled: Type.Boolean(), enabledToolIds: toolIds, resourceScope, presentation, policySet: Type.Optional(Type.Union([policyReference, Type.Null()])) }),
    output: root({ mutationId: identifierSchema, ...snapshot }),
  },
  "thread_template.list": { input: root({ cursor: Type.Optional(templateCursor), pageSize: Type.Optional(pageSize) }), output: root({ items: Type.Array(template, { maxItems: 100 }), nextCursor: Type.Optional(templateCursor) }) },
  "thread_template.get": { input: root({ templateId: identifierSchema }), output: root({ template }) },
  "thread_template.update": { input: root({ templateId: identifierSchema, expectedRevision: revision, toolPolicySelection: Type.Optional(selection), toolPresentation: Type.Optional(Type.Union([presentation, Type.Null()])) }, 3), output: root({ template }) },
} as const;

export type PolicyManagementToolId = keyof typeof schemas;

export function createPolicyManagementToolDefinitions(service: Pick<PolicyManagementAgentToolService, "execute">): AgentToolDefinition[] {
  return (Object.keys(schemas) as PolicyManagementToolId[]).map(id => {
    const manifest = CANONICAL_AGENT_TOOL_MANIFEST[id];
    const writes = manifest.effects.application !== "read";
    const nativeName = `sedes_${id.replaceAll(".", "_")}`;
    return {
      ...manifest, inputSchema: schemas[id].input, outputSchema: schemas[id].output,
      requiredCapabilities: [],
      execution: {
        form: "inline", adapterWaitCeilingMilliseconds: sharedAdapters,
        supportsCancellation: true, idempotency: "not_applicable", progress: "none",
        maximumInputBytes: 128 * 1024, maximumOutputBytes: 1024 * 1024,
        concurrencyClass: id.replaceAll(".", "_"), uncertainExternalOutcome: writes,
      },
      exposure: { adapters: ["pi_sdk", "pi_rpc", "mcp", "http", "cli"] },
      adapters: { pi: { name: nativeName, label: manifest.catalog.label }, mcp: { name: nativeName }, http: { invocation: "inline" }, cli: { command: id } },
      execute: (input, context) => service.execute(id, input, context),
    };
  });
}
