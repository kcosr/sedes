import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  compileCanonicalAgentToolSchema,
  normalizeCanonicalAgentToolSchema,
  type CanonicalAgentToolRootSchema,
} from "../../src/server/agent-tools/schema/canonical-json-schema.js";
import { deterministicJson } from "../../src/server/canonical-json.js";

const conformanceSchema = {
  $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
  type: "object",
  title: "Conformance input",
  description: "Exercises every value shape in the supported subset.",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 32,
    },
    limit: { type: "integer", minimum: 1, maximum: 10 },
    ratio: { type: "number", minimum: 0, maximum: 1 },
    exact: { type: "boolean" },
    tags: {
      type: "array",
      items: { type: "string", maxLength: 12 },
      minItems: 0,
      maxItems: 4,
      uniqueItems: true,
    },
    cursor: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 64 },
        { type: "null" },
      ],
    },
    options: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          maxLength: 8,
          enum: ["brief", "full"],
        },
      },
      required: ["mode"],
      additionalProperties: false,
      maxProperties: 1,
    },
  },
  required: ["options", "query", "limit", "exact", "tags", "cursor"],
  additionalProperties: false,
  maxProperties: 7,
} as const satisfies CanonicalAgentToolRootSchema;

const validCorpus = [
  {
    query: "alpha",
    limit: 3,
    ratio: 0.5,
    exact: true,
    tags: ["one", "two"],
    cursor: null,
    options: { mode: "brief" },
  },
  {
    query: "beta",
    limit: 10,
    exact: false,
    tags: [],
    cursor: "next",
    options: { mode: "full" },
  },
] as const;

const invalidCorpus = [
  { ...validCorpus[0], query: "x".repeat(33) },
  { ...validCorpus[0], limit: 11 },
  { ...validCorpus[0], tags: ["same", "same"] },
  { ...validCorpus[0], options: { mode: "unknown" } },
  { ...validCorpus[0], forgedIdentity: "thread-from-model" },
] as const;

describe("canonical agent-tool JSON Schema", () => {
  it("canonicalizes plain JSON without evaluating accessors or accepting cycles", () => {
    expect(deterministicJson({ zebra: 1, alpha: { beta: true } })).toBe(
      '{"alpha":{"beta":true},"zebra":1}',
    );
    const accessor = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => "must not run",
    });
    expect(() => deterministicJson(accessor)).toThrow(/accessor/);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => deterministicJson(cycle)).toThrow(/cycle/);
    expect(() => deterministicJson({ invalid: undefined })).toThrow(
      /unsupported_value/,
    );
    expect(() => deterministicJson({ invalid: Number.NaN })).toThrow(
      /non_finite/,
    );
  });

  it("validates the same corpus through Ajv 8.20 and TypeBox 1.3", () => {
    const harness = compileCanonicalAgentToolSchema(conformanceSchema);
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const ajvValidator = ajv.compile(harness.schema);
    const typeboxValidator = Compile(harness.schema as TSchema);

    for (const value of validCorpus) {
      expect(harness.check(value)).toBe(true);
      expect(ajvValidator(value)).toBe(true);
      expect(typeboxValidator.Check(value)).toBe(true);
    }
    for (const value of invalidCorpus) {
      expect(harness.check(value)).toBe(false);
      expect(ajvValidator(value)).toBe(false);
      expect(typeboxValidator.Check(value)).toBe(false);
    }
  });

  it("is accepted as one MCP 1.30 ToolSchema and one Pi TypeBox parameter schema", () => {
    const normalized = normalizeCanonicalAgentToolSchema(conformanceSchema);
    const parsed = ToolSchema.parse({
      name: "sedes_reference_check",
      description: "Runs the harmless Sedes conformance check.",
      inputSchema: normalized,
      outputSchema: {
        $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
        type: "object",
        properties: {
          status: {
            type: "string",
            maxLength: 2,
            enum: ["ok"],
          },
        },
        required: ["status"],
        additionalProperties: false,
        maxProperties: 1,
      },
    });
    const piParameters: ToolDefinition["parameters"] = normalized;

    expect(parsed.inputSchema).toEqual(normalized);
    expect(Compile(piParameters).Check(validCorpus[0])).toBe(true);
  });

  it("normalizes property keys and required sets deterministically", () => {
    const reordered = {
      ...conformanceSchema,
      properties: {
        options: conformanceSchema.properties.options,
        cursor: conformanceSchema.properties.cursor,
        tags: conformanceSchema.properties.tags,
        exact: conformanceSchema.properties.exact,
        ratio: conformanceSchema.properties.ratio,
        limit: conformanceSchema.properties.limit,
        query: conformanceSchema.properties.query,
      },
      required: ["tags", "query", "options", "limit", "exact", "cursor"],
    };

    expect(
      deterministicJson(normalizeCanonicalAgentToolSchema(reordered)),
    ).toBe(
      deterministicJson(normalizeCanonicalAgentToolSchema(conformanceSchema)),
    );
  });

  it.each([
    ["pattern", { type: "string", maxLength: 20, pattern: "^[a-z]+$" }],
    ["format", { type: "string", maxLength: 20, format: "uri" }],
    ["default", { type: "boolean", default: false }],
    ["const", { type: "string", maxLength: 4, const: "only" }],
    ["oneOf", { oneOf: [{ type: "null" }, { type: "boolean" }] }],
  ])("fails the proof gate for unsupported %s", (_keyword, propertySchema) => {
    expect(() =>
      normalizeCanonicalAgentToolSchema({
        $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
        type: "object",
        properties: { value: propertySchema },
        required: ["value"],
        additionalProperties: false,
        maxProperties: 1,
      }),
    ).toThrow(/unsupported|type_unsupported/);
  });

  it("requires closed objects and explicit collection, string, and numeric bounds", () => {
    const root = (propertySchema: unknown) => ({
      $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
      type: "object",
      properties: { value: propertySchema },
      required: ["value"],
      additionalProperties: false,
      maxProperties: 1,
    });

    expect(() =>
      normalizeCanonicalAgentToolSchema({
        ...root({ type: "boolean" }),
        additionalProperties: true,
      }),
    ).toThrow(/closed_object/);
    expect(() =>
      normalizeCanonicalAgentToolSchema(root({ type: "string" })),
    ).toThrow(/maxLength/);
    expect(() =>
      normalizeCanonicalAgentToolSchema(
        root({ type: "array", items: { type: "null" } }),
      ),
    ).toThrow(/maxItems/);
    expect(() =>
      normalizeCanonicalAgentToolSchema(root({ type: "integer" })),
    ).toThrow(/numeric_bounds/);
    expect(() =>
      normalizeCanonicalAgentToolSchema({
        $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
        anyOf: [{ type: "null" }, { type: "boolean" }],
      }),
    ).toThrow(/root_object/);
  });
});
