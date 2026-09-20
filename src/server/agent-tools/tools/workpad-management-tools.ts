import { Type, type TProperties } from "typebox";
import { WORKPAD_CONTENT_MAX_CHARACTERS } from "../../../shared/protocol/workpads.js";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import { AGENT_TOOL_JSON_SCHEMA_DIALECT, normalizeCanonicalAgentToolSchema } from "../schema/canonical-json-schema.js";
import { identifierSchema, isoDateSchema, sharedAdapters, taskScopeSchema, taskTargetScopeSchema } from "./management-tool-schemas.js";
import type { WorkpadAgentToolService } from "./workpad-agent-tool-service.js";

const object = (properties: TProperties) => Type.Object(properties, { additionalProperties: false, maxProperties: Object.keys(properties).length });
const root = (properties: TProperties, minProperties?: number) => normalizeCanonicalAgentToolSchema({ ...object(properties), ...(minProperties === undefined ? {} : { minProperties }), $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const content = Type.String({ maxLength: WORKPAD_CONTENT_MAX_CHARACTERS });
const title = Type.String({ minLength: 1, maxLength: 240 });
const nullableId = Type.Union([identifierSchema, Type.Null()]);
const nullableDate = Type.Union([isoDateSchema, Type.Null()]);
const author = object({
  kind: Type.String({ enum: ["user", "agent", "tool_client"], maxLength: 11 }),
  threadId: nullableId, clientId: nullableId,
  name: Type.String({ maxLength: 4096 }), nameSnapshot: Type.String({ maxLength: 4096 }),
});
const summary = {
  id: identifierSchema, title, scope: taskScopeSchema, revision,
  archivedAt: nullableDate, createdAt: isoDateSchema, updatedAt: isoDateSchema, author,
};
const revisionSummary = { workpadId: identifierSchema, revision, title, scope: taskScopeSchema, archivedAt: nullableDate, author, createdAt: isoDateSchema };
const document = object({ ...summary, content });
const historical = object({ ...revisionSummary, content });
const cursor = Type.String({ minLength: 1, maxLength: 256 });
const limit = Type.Integer({ minimum: 1, maximum: 100 });
const edit = Type.Union([
  object({ kind: Type.String({ enum: ["replace"], maxLength: 7 }), content }),
  object({ kind: Type.String({ enum: ["append"], maxLength: 6 }), text: content }),
  object({ kind: Type.String({ enum: ["patch"], maxLength: 5 }), edits: Type.Array(object({ oldText: Type.String({ minLength: 1, maxLength: WORKPAD_CONTENT_MAX_CHARACTERS }), newText: content }), { minItems: 1, maxItems: 100 }) }),
]);
const schemas = {
  list: {
    input: root({ scope: taskTargetScopeSchema, scopeMode: Type.String({ enum: ["exact", "subtree"], maxLength: 7 }), query: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })), archived: Type.Optional(Type.Boolean()), limit: Type.Optional(limit), cursor: Type.Optional(cursor) }),
    output: root({ items: Type.Array(object(summary), { maxItems: 100 }), nextCursor: Type.Optional(cursor) }),
  },
  get: { input: root({ workpadId: identifierSchema, revision: Type.Optional(revision) }), output: root({ workpad: Type.Union([document, historical]) }) },
  revisions: { input: root({ workpadId: identifierSchema, limit: Type.Optional(limit), cursor: Type.Optional(cursor) }), output: root({ items: Type.Array(object(revisionSummary), { maxItems: 100 }), nextCursor: Type.Optional(cursor) }) },
  create: { input: root({ title, scope: taskTargetScopeSchema, content: Type.Optional(content) }), output: root({ workpad: document }) },
  update: { input: root({ workpadId: identifierSchema, expectedRevision: revision, title: Type.Optional(title), scope: Type.Optional(taskTargetScopeSchema), archived: Type.Optional(Type.Boolean()), edit: Type.Optional(edit) }, 3), output: root({ workpad: document }) },
};

/** The same canonical definitions power Pi native and every admitted CLI backend. */
export function createWorkpadToolDefinitions(service: WorkpadAgentToolService): readonly AgentToolDefinition[] {
  return (Object.keys(schemas) as (keyof typeof schemas)[]).map((operation) => {
    const manifest = CANONICAL_AGENT_TOOL_MANIFEST[`workpad.${operation}`];
    const write = operation === "create" || operation === "update";
    return {
      ...manifest,
      inputSchema: schemas[operation].input,
      outputSchema: schemas[operation].output,
      requiredCapabilities: [],
      execution: {
        form: "inline", adapterWaitCeilingMilliseconds: sharedAdapters, supportsCancellation: true,
        idempotency: "not_applicable", progress: "none", maximumInputBytes: write ? 2 * 1024 * 1024 : 8192,
        maximumOutputBytes: 4 * 1024 * 1024 - 4096, concurrencyClass: `workpad_${operation}_${write ? "write" : "read"}`,
        uncertainExternalOutcome: write,
      },
      exposure: { adapters: ["pi_sdk", "http", "cli"] },
      adapters: {
        pi: { name: `sedes_workpad_${operation}`, label: manifest.catalog.label, promptSnippet: manifest.description },
        http: { invocation: "inline" }, cli: { command: manifest.id },
      },
      async execute(input, context) { return service.execute(operation, input, context); },
    } satisfies AgentToolDefinition;
  });
}
