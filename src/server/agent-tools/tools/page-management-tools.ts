import { Type, type TProperties } from "typebox";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import { AGENT_TOOL_JSON_SCHEMA_DIALECT, normalizeCanonicalAgentToolSchema } from "../schema/canonical-json-schema.js";
import { sharedAdapters } from "./management-tool-schemas.js";
import type { PageAgentToolService } from "./page-agent-tool-service.js";
import { PAGE_INLINE_MAX_CHARACTERS } from "../../../shared/protocol/pages.js";

const object = (properties: TProperties) => Type.Object(properties, { additionalProperties: false, maxProperties: Object.keys(properties).length });
const root = (properties: TProperties) => normalizeCanonicalAgentToolSchema({ ...object(properties), $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT });
const id = Type.String({ minLength: 1, maxLength: 128 });
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const integer = Type.Integer({ minimum: 0, maximum: 1_000_000 });
const viewport = object({ width: Type.Optional(Type.Integer({ minimum: 100, maximum: 4096 })), height: Type.Optional(Type.Integer({ minimum: 100, maximum: 8192 })) });
const path = Type.String({ minLength: 1, maxLength: 4096 });
const source = { path: Type.Optional(path), html: Type.Optional(Type.String({ minLength: 1, maxLength: PAGE_INLINE_MAX_CHARACTERS })) };
const descriptor = object({ pageId: id, threadId: id, revision, title: Type.String({ minLength: 1, maxLength: 240 }), viewport,
  createdAt: Type.String({ minLength: 1, maxLength: 32 }), sha256: Type.String({ minLength: 64, maxLength: 64 }),
  byteSize: Type.Integer({ minimum: 1, maximum: 16_777_216 }) });
const pagination = { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), cursor: Type.Optional(Type.String({ maxLength: 256 })) };
const pageOutput = root({ items: Type.Array(descriptor, { maxItems: 100 }), nextCursor: Type.Optional(Type.String({ maxLength: 256 })) });
const schemas = {
  publish: { input: root({ ...source, title: Type.String({ minLength: 1, maxLength: 240 }), pageId: Type.Optional(id), expectedRevision: Type.Optional(revision), viewport: Type.Optional(viewport) }), output: root({ page: descriptor, changed: Type.Boolean() }) },
  preview: { input: root({ ...source, viewport: Type.Optional(viewport) }), output: root({ width: integer, height: integer, contentWidth: integer, contentHeight: integer,
    console: Type.Array(object({ level: Type.String({ maxLength: 32 }), text: Type.String({ maxLength: 4096 }) }), { maxItems: 100 }),
    screenshot: object({ mimeType: Type.String({ enum: ["image/png"], maxLength: 9 }), width: integer, height: integer, byteSize: Type.Integer({ minimum: 1, maximum: 2_097_152 }) }) }) },
  list: { input: root(pagination), output: pageOutput },
  get: { input: root({ pageId: id, revision: Type.Optional(revision) }), output: root({ page: descriptor, sourcePath: Type.Optional(path), html: Type.Optional(Type.String({ minLength: 1, maxLength: PAGE_INLINE_MAX_CHARACTERS })) }) },
  revisions: { input: root({ pageId: id, ...pagination }), output: pageOutput },
};

export function createPageToolDefinitions(service: PageAgentToolService): readonly AgentToolDefinition[] {
  return (Object.keys(schemas) as (keyof typeof schemas)[]).map(operation => {
    const manifest = CANONICAL_AGENT_TOOL_MANIFEST[`page.${operation}`];
    return {
      ...manifest, inputSchema: schemas[operation].input, outputSchema: schemas[operation].output, requiredCapabilities: [],
      execution: { form: "inline", adapterWaitCeilingMilliseconds: sharedAdapters, supportsCancellation: true,
        idempotency: "not_applicable", progress: "none", maximumInputBytes: 512 * 1024, maximumOutputBytes: 4 * 1024 * 1024 - 4096,
        concurrencyClass: `page_${operation}`, uncertainExternalOutcome: operation === "publish" },
      exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
      adapters: { pi: { name: `sedes_page_${operation}`, label: manifest.catalog.label,
        promptSnippet: operation === "publish"
          ? "Publish one path or html with inline CSS/JS. Files capture local images; html needs data images. Update with pageId and expectedRevision; viewport optional. No network. For controls, use window.sedes?.onSubmit(() => string): return all answers synchronously as nonblank text, max 65,536 UTF-8 bytes. Optional registration lets downloads run without Sedes. Host Send captures once and sends or queues to this thread, never Steer. Unsent state is transient; tools cannot read it."
          : manifest.description },
        mcp: { name: `sedes_page_${operation}` }, http: { invocation: "inline" }, cli: { command: manifest.id } },
      execute: (input, context) => service.execute(operation, input, context),
    } satisfies AgentToolDefinition;
  });
}
