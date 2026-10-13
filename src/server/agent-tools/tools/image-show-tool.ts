import { Type } from "typebox";
import { MAXIMUM_OUTPUT_IMAGE_BYTES } from "../../../shared/output-artifact-limits.js";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import { AGENT_TOOL_JSON_SCHEMA_DIALECT, normalizeCanonicalAgentToolSchema } from "../schema/canonical-json-schema.js";
import { sharedAdapters } from "./management-tool-schemas.js";
import type { ImageShowAgentToolService } from "./image-show-agent-tool-service.js";

const object = (properties: Parameters<typeof Type.Object>[0]) => Type.Object(properties, { additionalProperties: false, maxProperties: Object.keys(properties).length });
const text = (maximum: number) => object({
  text: Type.String({ maxLength: maximum }),
  truncation: Type.Optional(object({
    truncated: Type.Boolean(),
    originalBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    retainedBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    reason: Type.String({ enum: ["byte_limit", "depth_limit", "entry_limit", "binary_omitted"], maxLength: 14 }),
  })),
});

export function createImageShowToolDefinition(service: ImageShowAgentToolService): AgentToolDefinition {
  const manifest = CANONICAL_AGENT_TOOL_MANIFEST["image.show"];
  return {
    ...manifest,
    inputSchema: normalizeCanonicalAgentToolSchema({
      ...object({
        path: Type.String({ minLength: 1, maxLength: 4096, description: "Absolute image path in the source thread's execution environment." }),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 240, description: "Optional image title shown in chat." })),
      }),
      $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
    }),
    outputSchema: normalizeCanonicalAgentToolSchema({
      ...object({ image: object({
        representation: Type.String({ enum: ["artifact"], maxLength: 8 }),
        artifactId: Type.String({ minLength: 36, maxLength: 36 }),
        mimeType: Type.String({ enum: ["image/png", "image/jpeg", "image/gif", "image/webp"], maxLength: 10 }),
        byteSize: Type.Integer({ minimum: 1, maximum: MAXIMUM_OUTPUT_IMAGE_BYTES }),
        sha256: Type.String({ minLength: 64, maxLength: 64 }),
        fileName: Type.Optional(text(255)),
        alt: Type.Optional(text(240)),
      }) }),
      $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
    }),
    requiredCapabilities: [],
    execution: {
      form: "inline", adapterWaitCeilingMilliseconds: sharedAdapters,
      supportsCancellation: true, idempotency: "supported", progress: "none",
      maximumInputBytes: 32 * 1024, maximumOutputBytes: 8 * 1024,
      concurrencyClass: "image_show", uncertainExternalOutcome: true,
    },
    exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
    adapters: {
      pi: { name: "sedes_image_show", label: manifest.catalog.label, promptSnippet: manifest.description },
      mcp: { name: "sedes_image_show", title: manifest.catalog.label },
      http: { invocation: "inline" }, cli: { command: "image.show" },
    },
    execute: (input, context) => service.execute(input, context),
  };
}
