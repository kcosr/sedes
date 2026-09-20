import {
  decodeInitializeResponse,
  decodePromptRequest,
  decodeSessionNotification,
  decodeSetSessionConfigOptionRequest,
} from "../../src/server/provider-protocol/bindings/acp-v1/generated/1.3.0/projectors.js";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_METHODS,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type SetSessionConfigOptionRequest,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  ACP_AGENT_NOTIFICATIONS,
  ACP_AGENT_REQUESTS,
  ACP_CLIENT_NOTIFICATIONS,
  ACP_CLIENT_REQUESTS,
  ACP_STABLE_V1_AGENT_DESCRIPTORS,
  ACP_STABLE_V1_REVERSE_DESCRIPTORS,
  ACP_RESERVED_V1_ROUTES,
  ACP_UNSTABLE_V1_AGENT_DESCRIPTORS,
  ACP_UNSTABLE_V1_AGENT_REQUESTS,
  SEDES_ACP_MAXIMUM_TERMINAL_OUTPUT_BYTES,
  SEDES_ACP_MAXIMUM_TEXT_FILE_LINES,
} from "../../src/server/provider-protocol/bindings/acp-v1/descriptors.js";
import {
  validateAgentCapabilities,
  validateSessionNotification,
  validateSetSessionConfigOptionRequest,
} from "../../src/server/provider-protocol/bindings/acp-v1/generated/1.3.0/validators.js";
import {
  DEFAULT_ACP_SEMANTIC_LIMITS,
  validateAcpValue,
} from "../../src/server/provider-protocol/bindings/acp-v1/schema.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../src/server/provider-protocol/transport/framed-message-limits.js";

type JsonSchema = Record<string, unknown>;
type ClosureClassification =
  | "closed_leaf"
  | "closed_composition_owner"
  | "open_mixin"
  | "open_extension_map";
type ClosureOverlay = {
  readonly adoptedDefinitions: readonly string[];
  readonly reviewedOpenRecordAllowlist: Readonly<
    Record<string, { readonly valueSchema: string; readonly rationale: string }>
  >;
  readonly classifications: Readonly<Record<string, ClosureClassification>>;
};
type GeneratedManifest = {
  readonly definitions: readonly string[];
  readonly semanticDispositions: {
    readonly reachableIgnoredFormatPointers: number;
    readonly reviewedPropertyPointers: number;
    readonly selectorCandidates: Readonly<Record<string, number>>;
    readonly driftChecked: boolean;
  };
  readonly closureOverlay: {
    readonly reachableObjectPointers: number;
    readonly fenceOperations: readonly {
      readonly pointer: string;
      readonly keyword: "additionalProperties" | "unevaluatedProperties";
      readonly value: false;
    }[];
    readonly proofInventory: {
      readonly closedMutationPointers: readonly string[];
      readonly openMapMutationPointers: readonly string[];
      readonly unionBranchPointers: readonly string[];
    };
  };
  readonly validatorArchitecture: {
    readonly exportedValidators: number;
    readonly oneValidatorPerAdoptedDefinition: boolean;
    readonly fallbackValidator: boolean;
  };
  readonly projectorArchitecture: {
    readonly exportedDecoders: number;
    readonly oneDecoderPerAdoptedDefinition: boolean;
    readonly preservesOnlyReviewedOpenMaps: boolean;
    readonly fallbackProjector: boolean;
  };
};
type SemanticDispositions = {
  readonly ignoredFormatPointers: readonly {
    readonly pointer: string;
    readonly format: string;
    readonly disposition: string;
    readonly refinement: string;
    readonly test: string;
  }[];
  readonly pointerInventories: readonly {
    readonly id: string;
    readonly selector: string;
    readonly pointers: readonly string[];
    readonly disposition: string;
    readonly refinement: string;
    readonly test: string;
  }[];
  readonly crossFieldObligations: readonly {
    readonly id: string;
    readonly pointers: readonly string[];
    readonly routes?: Readonly<Record<string, readonly string[]>>;
    readonly disposition: string;
    readonly refinement: string;
    readonly test: string;
  }[];
};

const require = createRequire(import.meta.url);
const officialSchema = JSON.parse(
  readFileSync(
    require.resolve("@agentclientprotocol/sdk/schema/schema.json"),
    "utf8",
  ),
) as JsonSchema & { $id?: string; $defs: Record<string, JsonSchema> };
const generatedDirectory = new URL(
  "../../src/server/provider-protocol/bindings/acp-v1/generated/1.3.0/",
  import.meta.url,
);
const closedSchema = JSON.parse(
  readFileSync(new URL("closed-schema.json", generatedDirectory), "utf8"),
) as JsonSchema & { $id?: string; $defs: Record<string, JsonSchema> };
const closureOverlay = JSON.parse(
  readFileSync(new URL("closure-overlay.json", generatedDirectory), "utf8"),
) as ClosureOverlay;
const generatedManifest = JSON.parse(
  readFileSync(new URL("manifest.json", generatedDirectory), "utf8"),
) as GeneratedManifest;
const generatedValidatorSource = readFileSync(
  new URL("validators.ts", generatedDirectory),
  "utf8",
);
const generatedProjectorSource = readFileSync(
  new URL("projectors.ts", generatedDirectory),
  "utf8",
);
const semanticDispositions = JSON.parse(
  readFileSync(
    new URL(
      "../../src/server/provider-protocol/bindings/acp-v1/semantic-dispositions.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as SemanticDispositions;
officialSchema.$id = "urn:test:official-acp-v1";
closedSchema.$id = "urn:test:closed-acp-v1";
const officialAjv = new Ajv2020({
  strict: false,
  validateFormats: false,
  coerceTypes: false,
  useDefaults: false,
});
officialAjv.addSchema(officialSchema);
const closedAjv = new Ajv2020({
  strict: false,
  validateFormats: false,
  coerceTypes: false,
  useDefaults: false,
});
closedAjv.addSchema(closedSchema);

function officialValidator(definition: string): (value: unknown) => boolean {
  const validator = officialAjv.getSchema(
    `${officialSchema.$id}#/$defs/${definition}`,
  );
  if (!validator)
    throw new Error(`Missing official ACP definition ${definition}`);
  return validator;
}

function pointerValidator(
  ajv: Ajv2020,
  schemaId: string,
  pointer: string,
): (value: unknown) => boolean {
  const validator = ajv.compile({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: `${schemaId}#${pointer}`,
  });
  return validator;
}

function resolveSchemaPointer(
  document: JsonSchema,
  pointer: string,
): JsonSchema {
  let value: unknown = document;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    value = (value as Record<string, unknown>)[key];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Schema pointer does not resolve to an object: ${pointer}`);
  }
  return value as JsonSchema;
}

function minimalSchemaValue(
  schema: JsonSchema,
  document: { readonly $defs: Record<string, JsonSchema> },
  depth = 0,
): unknown {
  if (depth > 64) throw new Error("ACP test schema recursion exceeded");
  if (Object.hasOwn(schema, "const")) return structuredClone(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return structuredClone(schema.enum[0]);
  }
  if (typeof schema.$ref === "string") {
    const match = /^#\/\$defs\/(.+)$/u.exec(schema.$ref);
    if (!match) throw new Error(`Unsupported ACP test ref ${schema.$ref}`);
    return minimalSchemaValue(document.$defs[match[1]!]!, document, depth + 1);
  }

  let composed: unknown;
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const members = schema[keyword];
    if (Array.isArray(members) && members.length > 0) {
      composed = minimalSchemaValue(
        members[0] as JsonSchema,
        document,
        depth + 1,
      );
      break;
    }
  }
  if (Array.isArray(schema.allOf)) {
    composed = schema.allOf.reduce<unknown>((result, member) => {
      const next = minimalSchemaValue(
        member as JsonSchema,
        document,
        depth + 1,
      );
      return mergeSchemaValues(result, next);
    }, composed);
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (
    types.includes("object") ||
    schema.properties != null ||
    (composed != null &&
      typeof composed === "object" &&
      !Array.isArray(composed))
  ) {
    const value =
      composed != null &&
      typeof composed === "object" &&
      !Array.isArray(composed)
        ? { ...(composed as Record<string, unknown>) }
        : {};
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required ?? []) as string[]) {
      value[key] = minimalSchemaValue(properties[key]!, document, depth + 1);
    }
    return value;
  }
  if (types.includes("array")) return [];
  if (types.includes("string")) return "x";
  if (types.includes("integer") || types.includes("number")) return 0;
  if (types.includes("boolean")) return true;
  if (types.includes("null")) return null;
  return composed ?? null;
}

function mergeSchemaValues(left: unknown, right: unknown): unknown {
  if (
    left != null &&
    right != null &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    return { ...left, ...right };
  }
  return right ?? left;
}

function collectReachableObjectsForTest(
  document: { readonly $defs: Record<string, JsonSchema> },
  roots: readonly string[],
): Map<string, JsonSchema> {
  const result = new Map<string, JsonSchema>();
  const visitedDefinitions = new Set<string>();
  const visit = (value: unknown, pointer: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${pointer}/${index}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const schema = value as JsonSchema;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
      types.includes("object") ||
      schema.properties != null ||
      schema.additionalProperties != null
    ) {
      result.set(pointer, schema);
    }
    if (typeof schema.$ref === "string") {
      const match = /^#\/\$defs\/(.+)$/u.exec(schema.$ref);
      const definitionName = match?.[1];
      if (definitionName && !visitedDefinitions.has(definitionName)) {
        visitedDefinitions.add(definitionName);
        visit(document.$defs[definitionName], `/$defs/${definitionName}`);
      }
    }
    for (const [key, child] of Object.entries(schema)) {
      visit(
        child,
        `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      );
    }
  };
  for (const root of roots) {
    if (visitedDefinitions.has(root)) continue;
    visitedDefinitions.add(root);
    visit(document.$defs[root], `/$defs/${root}`);
  }
  return result;
}

function collectReachableFormatsForTest(
  document: { readonly $defs: Record<string, JsonSchema> },
  roots: readonly string[],
): Array<{ readonly pointer: string; readonly format: string }> {
  const result = new Map<string, string>();
  const visitedDefinitions = new Set<string>();
  const visit = (value: unknown, pointer: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${pointer}/${index}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const schema = value as JsonSchema;
    if (typeof schema.format === "string") result.set(pointer, schema.format);
    if (typeof schema.$ref === "string") {
      const match = /^#\/\$defs\/(.+)$/u.exec(schema.$ref);
      if (match && !visitedDefinitions.has(match[1]!)) {
        visitedDefinitions.add(match[1]!);
        visit(document.$defs[match[1]!]!, `/$defs/${match[1]!}`);
      }
    }
    for (const [key, child] of Object.entries(schema)) {
      if (key !== "$ref") visit(child, `${pointer}/${key}`);
    }
  };
  for (const root of roots) {
    if (visitedDefinitions.has(root)) continue;
    visitedDefinitions.add(root);
    visit(document.$defs[root]!, `/$defs/${root}`);
  }
  return [...result.entries()]
    .map(([pointer, format]) => ({ pointer, format }))
    .sort((left, right) => left.pointer.localeCompare(right.pointer));
}

type ReachableProperty = {
  readonly key: string;
  readonly schema: JsonSchema;
  readonly description: string;
};

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function collectReachablePropertiesForTest(
  schema: typeof officialSchema,
  definitions: readonly string[],
): ReadonlyMap<string, ReachableProperty> {
  const properties = new Map<string, ReachableProperty>();
  const visitedDefinitions = new Set<string>();
  const visit = (value: unknown, pointer: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${pointer}/${index}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as JsonSchema;
    if (typeof record.$ref === "string") {
      const match = /^#\/\$defs\/(.+)$/u.exec(record.$ref);
      const definition = match?.[1];
      if (definition && !visitedDefinitions.has(definition)) {
        visitedDefinitions.add(definition);
        visit(schema.$defs[definition], `/$defs/${escapePointer(definition)}`);
      }
    }
    if (record.properties && typeof record.properties === "object") {
      for (const [key, child] of Object.entries(
        record.properties as Record<string, JsonSchema>,
      )) {
        const childPointer = `${pointer}/properties/${escapePointer(key)}`;
        properties.set(childPointer, {
          key,
          schema: child,
          description:
            typeof child.description === "string" ? child.description : "",
        });
        visit(child, childPointer);
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== "$ref" && key !== "properties") {
        visit(child, `${pointer}/${escapePointer(key)}`);
      }
    }
  };
  for (const definition of definitions) {
    if (visitedDefinitions.has(definition)) continue;
    visitedDefinitions.add(definition);
    visit(schema.$defs[definition], `/$defs/${escapePointer(definition)}`);
  }
  return properties;
}

function schemaAllowsTypeForTest(
  schema: typeof officialSchema,
  value: JsonSchema,
  type: string,
  visitedDefinitions = new Set<string>(),
): boolean {
  if (
    value.type === type ||
    (Array.isArray(value.type) && value.type.includes(type))
  ) {
    return true;
  }
  if (typeof value.$ref === "string") {
    const match = /^#\/\$defs\/(.+)$/u.exec(value.$ref);
    const definition = match?.[1];
    if (definition && !visitedDefinitions.has(definition)) {
      const referenced = schema.$defs[definition];
      if (!referenced)
        throw new Error(`missing schema definition ${definition}`);
      const nextVisited = new Set(visitedDefinitions);
      nextVisited.add(definition);
      return schemaAllowsTypeForTest(schema, referenced, type, nextVisited);
    }
  }
  return ["allOf", "anyOf", "oneOf"].some((keyword) => {
    const members = value[keyword];
    return (
      Array.isArray(members) &&
      members.some((member) =>
        schemaAllowsTypeForTest(
          schema,
          member as JsonSchema,
          type,
          visitedDefinitions,
        ),
      )
    );
  });
}

function schemaReferencesIdentifierForTest(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(schemaReferencesIdentifierForTest);
  }
  if (!value || typeof value !== "object") return false;
  const record = value as JsonSchema;
  if (
    typeof record.$ref === "string" &&
    /^#\/\$defs\/[^/]*Id$/u.test(record.$ref)
  ) {
    return true;
  }
  return Object.values(record).some(schemaReferencesIdentifierForTest);
}

function collectSemanticPointerCandidatesForTest(
  schema: typeof officialSchema,
  definitions: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const selectors = new Map<string, string[]>([
    ["portable_absolute_paths", []],
    ["uri_link_url_strings", []],
    ["timestamps", []],
    ["cursors", []],
    ["identifier_references", []],
    ["lookup_names", []],
    ["ordered_arrays", []],
  ]);
  for (const [pointer, property] of collectReachablePropertiesForTest(
    schema,
    definitions,
  )) {
    if (/absolute/iu.test(property.description)) {
      selectors.get("portable_absolute_paths")?.push(pointer);
    }
    if (
      ["uri", "link", "url"].includes(property.key) &&
      schemaAllowsTypeForTest(schema, property.schema, "string")
    ) {
      selectors.get("uri_link_url_strings")?.push(pointer);
    }
    if (["updatedAt", "lastModified"].includes(property.key)) {
      selectors.get("timestamps")?.push(pointer);
    }
    if (["cursor", "nextCursor"].includes(property.key)) {
      selectors.get("cursors")?.push(pointer);
    }
    if (
      /\b(?:ID|identifier)\b/iu.test(property.description) ||
      schemaReferencesIdentifierForTest(property.schema)
    ) {
      selectors.get("identifier_references")?.push(pointer);
    }
    if (
      property.key === "name" &&
      /(?:environment variable name|name of the environment variable|command name)/iu.test(
        property.description,
      )
    ) {
      selectors.get("lookup_names")?.push(pointer);
    }
    if (schemaAllowsTypeForTest(schema, property.schema, "array")) {
      selectors.get("ordered_arrays")?.push(pointer);
    }
  }
  return new Map(
    [...selectors.entries()].map(([selector, pointers]) => [
      selector,
      [...new Set(pointers)].sort(),
    ]),
  );
}

function collectReachableUnionBranchesForTest(
  document: { readonly $defs: Record<string, JsonSchema> },
  roots: readonly string[],
): string[] {
  const branches = new Set<string>();
  const visitedDefinitions = new Set<string>();
  const visit = (value: unknown, pointer: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${pointer}/${index}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const schema = value as JsonSchema;
    if (typeof schema.$ref === "string") {
      const match = /^#\/\$defs\/(.+)$/u.exec(schema.$ref);
      const definitionName = match?.[1];
      if (definitionName && !visitedDefinitions.has(definitionName)) {
        visitedDefinitions.add(definitionName);
        visit(document.$defs[definitionName], `/$defs/${definitionName}`);
      }
    }
    for (const keyword of ["oneOf", "anyOf"] as const) {
      const members = schema[keyword];
      if (!Array.isArray(members)) continue;
      members.forEach((_member, index) =>
        branches.add(`${pointer}/${keyword}/${index}`),
      );
    }
    for (const [key, child] of Object.entries(schema)) {
      visit(
        child,
        `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      );
    }
  };
  for (const root of roots) {
    if (visitedDefinitions.has(root)) continue;
    visitedDefinitions.add(root);
    visit(document.$defs[root], `/$defs/${root}`);
  }
  return [...branches].sort();
}

describe("generated stable ACP V1 bindings", () => {
  it("projects additive fields recursively while preserving reviewed open maps", () => {
    const meta = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(meta, "__proto__", {
      enumerable: true,
      value: { retained: true },
    });
    meta.vendor = { arbitrary: [true, { nested: "kept" }] };
    const decoded = decodeInitializeResponse({
      protocolVersion: 1,
      rootAddition: "discard",
      agentCapabilities: {
        loadSession: true,
        nestedAddition: "discard",
        promptCapabilities: {
          image: true,
          throughRefAddition: "discard",
        },
      },
      authMethods: [
        {
          type: "terminal",
          id: "terminal",
          name: "Terminal",
          unionAddition: "discard",
          env: { TOKEN_NAME: "value" },
          _meta: meta,
        },
      ],
    }) as Record<string, unknown>;

    expect(decoded).toEqual({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
      },
      authMethods: [
        {
          type: "terminal",
          id: "terminal",
          name: "Terminal",
          env: { TOKEN_NAME: "value" },
          _meta: {
            ["__proto__"]: { retained: true },
            vendor: { arbitrary: [true, { nested: "kept" }] },
          },
        },
      ],
    });
    const capabilities = decoded.agentCapabilities as Record<string, unknown>;
    const authMethod = (decoded.authMethods as Record<string, unknown>[])[0];
    expect(Object.getPrototypeOf(decoded)).toBeNull();
    expect(Object.getPrototypeOf(capabilities)).toBeNull();
    expect(Object.getPrototypeOf(authMethod)).toBeNull();
    expect(Object.getPrototypeOf(authMethod?._meta)).toBeNull();
    expect(
      Object.getOwnPropertyDescriptor(
        authMethod?._meta as Record<string, unknown>,
        "__proto__",
      )?.value,
    ).toEqual({ retained: true });
  });

  it("projects array members and discriminated unions without accepting invalid known fields", () => {
    expect(
      decodePromptRequest({
        sessionId: "session",
        prompt: [
          {
            type: "text",
            text: "hello",
            arrayMemberAddition: "discard",
            annotations: { priority: 1, nestedAddition: "discard" },
          },
        ],
        topAddition: "discard",
      }),
    ).toEqual({
      sessionId: "session",
      prompt: [{ type: "text", text: "hello", annotations: { priority: 1 } }],
    });
    expect(
      decodeSetSessionConfigOptionRequest({
        sessionId: "session",
        configId: "thinking",
        type: "boolean",
        value: true,
        composedAddition: "discard",
      }),
    ).toEqual({
      sessionId: "session",
      configId: "thinking",
      type: "boolean",
      value: true,
    });
    expect(
      decodeSessionNotification({
        sessionId: "session",
        update: { sessionUpdate: "agent_message_chunk", content: 42 },
      }),
    ).toBeUndefined();
    expect(
      decodePromptRequest({
        sessionId: "session",
        prompt: [{ type: "future_kind", text: "hello" }],
      }),
    ).toBeUndefined();
  });

  it("classifies every reachable object and applies only reviewed closure fences", () => {
    const reachableObjects = collectReachableObjectsForTest(
      officialSchema,
      closureOverlay.adoptedDefinitions,
    );
    expect(Object.keys(closureOverlay.classifications).sort()).toEqual(
      [...reachableObjects.keys()].sort(),
    );
    expect(reachableObjects.size).toBe(
      generatedManifest.closureOverlay.reachableObjectPointers,
    );
    expect(reachableObjects.size).toBe(314);
    const openMapPointers = Object.entries(closureOverlay.classifications)
      .filter(([, classification]) => classification === "open_extension_map")
      .map(([pointer]) => pointer);
    expect(
      openMapPointers.filter((pointer) =>
        pointer.endsWith("/properties/_meta"),
      ),
    ).toHaveLength(138);
    expect(
      openMapPointers.filter(
        (pointer) => !pointer.endsWith("/properties/_meta"),
      ),
    ).toEqual(Object.keys(closureOverlay.reviewedOpenRecordAllowlist));

    const reverted = structuredClone(closedSchema);
    delete reverted.$id;
    const untouchedOfficial = structuredClone(officialSchema);
    delete untouchedOfficial.$id;
    for (const operation of generatedManifest.closureOverlay.fenceOperations) {
      expect(operation.value).toBe(false);
      delete resolveSchemaPointer(reverted, operation.pointer)[
        operation.keyword
      ];
    }
    expect(reverted).toEqual(untouchedOfficial);
  });

  it("accepts every reachable union branch under both official and closed schemas", () => {
    const branches = collectReachableUnionBranchesForTest(
      officialSchema,
      closureOverlay.adoptedDefinitions,
    );
    expect(
      generatedManifest.closureOverlay.proofInventory.unionBranchPointers,
    ).toEqual(branches);
    expect(branches.length).toBeGreaterThan(0);
    for (const pointer of branches) {
      const value = minimalSchemaValue(
        resolveSchemaPointer(officialSchema, pointer),
        officialSchema,
      );
      expect(
        pointerValidator(officialAjv, officialSchema.$id!, pointer)(value),
        `official ${pointer}`,
      ).toBe(true);
      expect(
        pointerValidator(closedAjv, closedSchema.$id!, pointer)(value),
        `closed ${pointer}`,
      ).toBe(true);
    }
  });

  it("exercises every closed pointer with an official-valid rejected sentinel", () => {
    const closedEntries = Object.entries(closureOverlay.classifications).filter(
      ([, classification]) => classification.startsWith("closed_"),
    );
    expect(
      generatedManifest.closureOverlay.proofInventory.closedMutationPointers,
    ).toEqual(closedEntries.map(([pointer]) => pointer).sort());
    expect(
      closedEntries.filter(
        ([, classification]) => classification === "closed_leaf",
      ),
    ).toHaveLength(109);
    expect(
      closedEntries.filter(
        ([, classification]) => classification === "closed_composition_owner",
      ),
    ).toHaveLength(32);

    for (const [pointer] of closedEntries) {
      const schema = resolveSchemaPointer(officialSchema, pointer);
      const value = minimalSchemaValue(schema, officialSchema);
      const mutated = {
        ...(value as Record<string, unknown>),
        __sedesUnknownSentinel: true,
      };
      const official = pointerValidator(
        officialAjv,
        officialSchema.$id!,
        pointer,
      );
      const closed = pointerValidator(closedAjv, closedSchema.$id!, pointer);
      expect(official(value), `official base ${pointer}`).toBe(true);
      expect(closed(value), `closed base ${pointer}`).toBe(true);
      expect(official(mutated), `official sentinel ${pointer}`).toBe(true);
      expect(closed(mutated), `closed sentinel ${pointer}`).toBe(false);
      if (closed(value) || closed(mutated)) {
        expect(
          official(closed(value) ? value : mutated),
          `subset ${pointer}`,
        ).toBe(true);
      }
    }
  });

  it("keeps every declared extension map open with typed sentinels and bounded values", () => {
    const openMaps = Object.entries(closureOverlay.classifications).filter(
      ([, classification]) => classification === "open_extension_map",
    );
    expect(
      generatedManifest.closureOverlay.proofInventory.openMapMutationPointers,
    ).toEqual(openMaps.map(([pointer]) => pointer).sort());
    expect(openMaps).toHaveLength(139);
    for (const [pointer] of openMaps) {
      const schema = resolveSchemaPointer(officialSchema, pointer);
      const additional = schema.additionalProperties;
      const sentinel =
        additional && typeof additional === "object"
          ? minimalSchemaValue(additional as JsonSchema, officialSchema)
          : true;
      const value = { __sedesOpenSentinel: sentinel };
      expect(
        pointerValidator(officialAjv, officialSchema.$id!, pointer)(value),
        `official open ${pointer}`,
      ).toBe(true);
      expect(
        pointerValidator(closedAjv, closedSchema.$id!, pointer)(value),
        `closed open ${pointer}`,
      ).toBe(true);
    }

    const bounded = {
      _meta: { vendor: "far-too-large" },
    } satisfies AgentCapabilities;
    expect(validateAgentCapabilities(bounded)).toBe(true);
    expect(
      validateAcpValue(bounded, validateAgentCapabilities, {
        ...DEFAULT_ACP_SEMANTIC_LIMITS,
        maximumStringBytes: 4,
      }),
    ).toBe(false);
  });

  it("admits frame-bounded ACP array representations beyond the former item and node ceilings", () => {
    const representation = Array.from({ length: 16_385 }, () => 0);
    const accept = (_value: unknown): _value is unknown => true;

    expect(DEFAULT_ACP_SEMANTIC_LIMITS).toMatchObject({
      maximumArrayItems: MAXIMUM_PROVIDER_FRAME_BYTES,
      maximumTotalNodes: MAXIMUM_PROVIDER_FRAME_BYTES,
    });
    expect(
      validateAcpValue(representation, accept, DEFAULT_ACP_SEMANTIC_LIMITS),
    ).toBe(true);
  });

  it("emits exactly one standalone validator per adopted definition and no fallback", () => {
    const exportedValidators = [
      ...generatedValidatorSource.matchAll(
        /export const validate[A-Za-z0-9]+\s*=/gu,
      ),
    ];
    expect(exportedValidators).toHaveLength(
      generatedManifest.definitions.length,
    );
    expect(generatedManifest.validatorArchitecture).toEqual({
      exportedValidators: generatedManifest.definitions.length,
      oneValidatorPerAdoptedDefinition: true,
      fallbackValidator: false,
    });
    expect(generatedValidatorSource).not.toMatch(
      /export const (?:validate)?fallback|validateFallback/iu,
    );
  });

  it("emits exactly one projecting decoder per adopted definition and no fallback", () => {
    const exportedDecoders = [
      ...generatedProjectorSource.matchAll(
        /export function decode[A-Za-z0-9]+\(/gu,
      ),
    ];
    expect(exportedDecoders).toHaveLength(generatedManifest.definitions.length);
    expect(generatedManifest.projectorArchitecture).toMatchObject({
      exportedDecoders: generatedManifest.definitions.length,
      oneDecoderPerAdoptedDefinition: true,
      preservesOnlyReviewedOpenMaps: true,
      fallbackProjector: false,
    });
    expect(generatedProjectorSource).not.toMatch(
      /export function (?:decode)?fallback|decodeFallback/iu,
    );
  });

  it("drift-checks every ignored format and reviewed semantic disposition", () => {
    const reachable = collectReachableFormatsForTest(
      officialSchema,
      generatedManifest.definitions,
    );
    const reviewed = semanticDispositions.ignoredFormatPointers
      .map(({ pointer, format }) => ({ pointer, format }))
      .sort((left, right) => left.pointer.localeCompare(right.pointer));
    expect(reviewed).toEqual(reachable);
    expect(generatedManifest.semanticDispositions).toMatchObject({
      reachableIgnoredFormatPointers: reachable.length,
      driftChecked: true,
    });
    const candidatePointers = collectSemanticPointerCandidatesForTest(
      officialSchema,
      generatedManifest.definitions,
    );
    const reviewedPointers = new Map<string, string[]>();
    for (const inventory of semanticDispositions.pointerInventories) {
      const pointers = reviewedPointers.get(inventory.selector) ?? [];
      pointers.push(...inventory.pointers);
      reviewedPointers.set(inventory.selector, pointers);
    }
    expect([...reviewedPointers.keys()].sort()).toEqual(
      [...candidatePointers.keys()].sort(),
    );
    for (const [selector, candidates] of candidatePointers) {
      expect(reviewedPointers.get(selector)?.sort()).toEqual(candidates);
      expect(
        generatedManifest.semanticDispositions.selectorCandidates,
      ).toHaveProperty(selector, candidates.length);
    }
    expect(
      generatedManifest.semanticDispositions.reviewedPropertyPointers,
    ).toBe(
      new Set(
        semanticDispositions.pointerInventories.flatMap(
          (inventory) => inventory.pointers,
        ),
      ).size,
    );
    const capabilityDisposition =
      semanticDispositions.crossFieldObligations.find(
        (entry) => entry.id === "capability_negotiation",
      );
    const standardDescriptors = [
      ...ACP_STABLE_V1_AGENT_DESCRIPTORS,
      ...ACP_UNSTABLE_V1_AGENT_DESCRIPTORS,
      ...ACP_STABLE_V1_REVERSE_DESCRIPTORS,
    ];
    const descriptorCapabilityRoutes = Object.fromEntries(
      standardDescriptors
        .filter((descriptor) => descriptor.capabilityEvidence != null)
        .map((descriptor): readonly [string, readonly string[]] => [
          `${descriptor.direction}/${descriptor.kind}/${descriptor.method}`,
          descriptor.capabilityEvidence ?? [],
        ])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    expect(capabilityDisposition?.routes).toEqual(descriptorCapabilityRoutes);
    expect(capabilityDisposition?.pointers).toEqual(
      [
        ...new Set(
          Object.values(descriptorCapabilityRoutes).flatMap(
            (pointers) => pointers,
          ),
        ),
      ].sort(),
    );
    const baselineCapabilityHooks = standardDescriptors
      .filter((descriptor) => {
        if (descriptor.capabilityEvidence != null) return false;
        if (descriptor.kind === "notification") {
          return (
            descriptor.outboundCapability != null ||
            descriptor.reverseCapability != null
          );
        }
        return (
          descriptor.outboundCapability != null ||
          descriptor.outboundAuthMethodId != null ||
          descriptor.reverseCapability != null ||
          descriptor.validateResponseForCapabilities != null
        );
      })
      .map(
        (descriptor) =>
          `${descriptor.direction}/${descriptor.kind}/${descriptor.method}`,
      )
      .sort();
    expect(baselineCapabilityHooks).toEqual([
      "agent_to_client/request/session/request_permission",
      "client_to_agent/notification/session/cancel",
      "client_to_agent/request/session/set_mode",
    ]);
    for (const entry of [
      ...semanticDispositions.ignoredFormatPointers,
      ...semanticDispositions.pointerInventories,
      ...semanticDispositions.crossFieldObligations,
    ]) {
      expect(entry.disposition).toMatch(
        /^(?:binding_refinement|backend_authority|non_evidentiary)$/u,
      );
      expect(entry.refinement.length).toBeGreaterThan(15);
      expect(entry.test.length).toBeGreaterThan(7);
    }
  });

  it("publishes a complete, disjoint standard method inventory from SDK constants", () => {
    const stableMethods = ACP_STABLE_V1_AGENT_DESCRIPTORS.map(
      (descriptor) => descriptor.method,
    );
    expect(new Set(stableMethods).size).toBe(stableMethods.length);
    expect(new Set(stableMethods)).toEqual(
      new Set([
        AGENT_METHODS.initialize,
        AGENT_METHODS.authenticate,
        AGENT_METHODS.logout,
        AGENT_METHODS.session_new,
        AGENT_METHODS.session_load,
        AGENT_METHODS.session_list,
        AGENT_METHODS.session_delete,
        AGENT_METHODS.session_resume,
        AGENT_METHODS.session_close,
        AGENT_METHODS.session_set_mode,
        AGENT_METHODS.session_set_config_option,
        AGENT_METHODS.session_prompt,
        AGENT_METHODS.session_cancel,
      ]),
    );
    expect(ACP_UNSTABLE_V1_AGENT_DESCRIPTORS).toHaveLength(1);
    expect(ACP_UNSTABLE_V1_AGENT_REQUESTS.forkSession).toMatchObject({
      method: AGENT_METHODS.session_fork,
      stability: "unstable-v1",
      requiredProfile: "acp-v1-unstable",
    });
    expect(stableMethods).not.toContain(AGENT_METHODS.session_fork);

    const routeKeys = ACP_RESERVED_V1_ROUTES.map(
      ({ direction, kind, method }) => `${direction}:${kind}:${method}`,
    );
    expect(new Set(routeKeys).size).toBe(routeKeys.length);
    expect(
      new Set(
        ACP_RESERVED_V1_ROUTES.filter(
          (route) => route.direction === "client_to_agent",
        ).map((route) => route.method),
      ),
    ).toEqual(new Set(Object.values(AGENT_METHODS)));
    expect(
      new Set(
        ACP_RESERVED_V1_ROUTES.filter(
          (route) => route.direction === "agent_to_client",
        ).map((route) => route.method),
      ),
    ).toEqual(new Set(Object.values(CLIENT_METHODS)));
    expect(
      new Set(
        ACP_RESERVED_V1_ROUTES.filter(
          (route) => route.direction === "protocol",
        ).map((route) => route.method),
      ),
    ).toEqual(new Set(Object.values(PROTOCOL_METHODS)));
    expect(
      ACP_RESERVED_V1_ROUTES.filter(
        (route) => route.disposition === "reserved-disabled",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("accepts exact public SDK request and response shapes and rejects unknown envelope keys", () => {
    const cases = [
      [
        ACP_AGENT_REQUESTS.initialize,
        "Initialize",
        { protocolVersion: PROTOCOL_VERSION },
        { protocolVersion: PROTOCOL_VERSION },
      ],
      [
        ACP_AGENT_REQUESTS.authenticate,
        "Authenticate",
        { methodId: "browser" },
        {},
      ],
      [ACP_AGENT_REQUESTS.logout, "Logout", {}, {}],
      [
        ACP_AGENT_REQUESTS.newSession,
        "NewSession",
        { cwd: "/repo", mcpServers: [] },
        { sessionId: "new" },
      ],
      [
        ACP_AGENT_REQUESTS.loadSession,
        "LoadSession",
        { cwd: "/repo", mcpServers: [], sessionId: "old" },
        {},
      ],
      [ACP_AGENT_REQUESTS.listSessions, "ListSessions", {}, { sessions: [] }],
      [
        ACP_AGENT_REQUESTS.deleteSession,
        "DeleteSession",
        { sessionId: "old" },
        {},
      ],
      [
        ACP_AGENT_REQUESTS.resumeSession,
        "ResumeSession",
        { sessionId: "old", cwd: "/repo" },
        {},
      ],
      [
        ACP_AGENT_REQUESTS.closeSession,
        "CloseSession",
        { sessionId: "old" },
        {},
      ],
      [
        ACP_AGENT_REQUESTS.setSessionMode,
        "SetSessionMode",
        { sessionId: "old", modeId: "code" },
        {},
      ],
      [
        ACP_AGENT_REQUESTS.setSessionConfigOption,
        "SetSessionConfigOption",
        { sessionId: "old", configId: "model", value: "model-a" },
        { configOptions: [] },
      ],
      [
        ACP_AGENT_REQUESTS.prompt,
        "Prompt",
        { sessionId: "old", prompt: [{ type: "text", text: "hello" }] },
        { stopReason: "end_turn" },
      ],
      [
        ACP_UNSTABLE_V1_AGENT_REQUESTS.forkSession,
        "ForkSession",
        { sessionId: "old", cwd: "/repo" },
        { sessionId: "fork" },
      ],
    ] as const;

    for (const [descriptor, definitionPrefix, request, response] of cases) {
      const validateRequest = descriptor.validateRequest as (
        value: unknown,
      ) => boolean;
      const validateResponse = descriptor.validateResponse as (
        value: unknown,
      ) => boolean;
      expect(officialValidator(`${definitionPrefix}Request`)(request)).toBe(
        true,
      );
      expect(officialValidator(`${definitionPrefix}Response`)(response)).toBe(
        true,
      );
      expect(validateRequest(request), descriptor.method).toBe(true);
      expect(validateResponse(response), descriptor.method).toBe(true);
      expect(
        descriptor.decodeRequest({ ...request, unknownEnvelopeKey: true }),
        `${descriptor.method} request decoder`,
      ).toEqual(request);
      expect(
        descriptor.decodeResponse({ ...response, unknownEnvelopeKey: true }),
        `${descriptor.method} response decoder`,
      ).toEqual(response);
      expect(
        validateRequest({ ...request, unknownEnvelopeKey: true }),
        `${descriptor.method} request`,
      ).toBe(false);
      expect(
        validateResponse({ ...response, unknownEnvelopeKey: true }),
        `${descriptor.method} response`,
      ).toBe(false);
    }
  });

  it("closes composed config variants without rejecting their inherited fields", () => {
    const valueId = {
      sessionId: "session",
      configId: "model",
      value: "model-a",
    } satisfies SetSessionConfigOptionRequest;
    const boolean = {
      sessionId: "session",
      configId: "thinking",
      type: "boolean",
      value: true,
    } satisfies SetSessionConfigOptionRequest;

    expect(validateSetSessionConfigOptionRequest(valueId)).toBe(true);
    expect(validateSetSessionConfigOptionRequest(boolean)).toBe(true);
    expect(
      validateSetSessionConfigOptionRequest({ ...valueId, extra: true }),
    ).toBe(false);
    expect(
      validateSetSessionConfigOptionRequest({ ...boolean, extra: true }),
    ).toBe(false);
  });

  it("closes nested capabilities and session notification unions while preserving _meta", () => {
    const capabilities = {
      loadSession: true,
      promptCapabilities: { image: true, _meta: { vendor: "ok" } },
      sessionCapabilities: { list: {}, close: {} },
      _meta: { vendor: { arbitrary: true } },
    } satisfies AgentCapabilities;
    const notification = {
      sessionId: "session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
      _meta: { vendor: "ok" },
    } satisfies SessionNotification;

    expect(validateAgentCapabilities(capabilities)).toBe(true);
    expect(validateSessionNotification(notification)).toBe(true);
    expect(
      validateAgentCapabilities({
        ...capabilities,
        promptCapabilities: { image: true, unknownNestedKey: true },
      }),
    ).toBe(false);
    expect(
      validateSessionNotification({
        ...notification,
        update: { ...notification.update, unknownNestedKey: true },
      }),
    ).toBe(false);
  });

  it("enforces outbound agent capabilities from the published request payload", () => {
    expect(ACP_AGENT_REQUESTS.loadSession.operation).toBe("mutation");
    expect(
      ACP_AGENT_REQUESTS.loadSession.outboundCapability?.(
        { loadSession: true },
        { sessionId: "s", cwd: "/repo", mcpServers: [] },
        {},
      ),
    ).toBe(true);
    expect(
      ACP_AGENT_REQUESTS.loadSession.outboundCapability?.(
        {},
        { sessionId: "s", cwd: "/repo", mcpServers: [] },
        {},
      ),
    ).toBe(false);
    expect(
      ACP_AGENT_REQUESTS.prompt.outboundCapability?.(
        { promptCapabilities: { image: true } },
        {
          sessionId: "s",
          prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
        },
        {},
      ),
    ).toBe(true);
    expect(
      ACP_AGENT_REQUESTS.prompt.outboundCapability?.(
        {},
        {
          sessionId: "s",
          prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
        },
        {},
      ),
    ).toBe(false);
  });

  it("publishes capability-aware validation for every config-catalog ingress", () => {
    const booleanCatalog = [
      {
        id: "enabled",
        name: "Enabled",
        type: "boolean",
        currentValue: true,
      },
    ];
    const catalogDescriptors = [
      ACP_AGENT_REQUESTS.newSession,
      ACP_AGENT_REQUESTS.loadSession,
      ACP_AGENT_REQUESTS.resumeSession,
      ACP_AGENT_REQUESTS.setSessionConfigOption,
      ACP_UNSTABLE_V1_AGENT_REQUESTS.forkSession,
    ] as const;
    for (const descriptor of catalogDescriptors) {
      const validate = descriptor.validateResponseForCapabilities as
        | ((
            response: unknown,
            client: Record<string, unknown>,
            agent: Record<string, unknown>,
          ) => boolean)
        | undefined;
      expect(validate).toBeTypeOf("function");
      expect(validate?.({ configOptions: booleanCatalog }, {}, {})).toBe(false);
      expect(
        validate?.(
          { configOptions: booleanCatalog },
          { session: { configOptions: { boolean: {} } } },
          {},
        ),
      ).toBe(true);
    }
    expect(
      ACP_AGENT_REQUESTS.setSessionConfigOption.outboundCapability?.(
        {},
        {
          sessionId: "session",
          configId: "enabled",
          type: "boolean",
          value: true,
        },
        {},
      ),
    ).toBe(false);
    expect(
      ACP_AGENT_REQUESTS.listSessions.validateResponseForCapabilities?.(
        {
          sessions: [
            {
              sessionId: "session",
              cwd: "/workspace",
              additionalDirectories: ["/extra"],
            },
          ],
        },
        {},
        { sessionCapabilities: { list: {} } },
      ),
    ).toBe(false);
  });

  it("adds contextual permission, notification ordering, and filesystem/terminal semantics", () => {
    const permissionRequest = {
      sessionId: "s",
      toolCall: { toolCallId: "tool" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" as const },
      ],
    };
    expect(
      ACP_CLIENT_REQUESTS.requestPermission.validateResponse({
        outcome: { outcome: "cancelled" },
      }),
    ).toBe(true);
    expect(
      ACP_CLIENT_REQUESTS.requestPermission.validateResponse({
        outcome: { outcome: "selected", optionId: "allow" },
      }),
    ).toBe(true);
    expect(
      ACP_CLIENT_REQUESTS.requestPermission.validateResponse({
        outcome: { outcome: "cancelled", unknownNestedKey: true },
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_REQUESTS.requestPermission.validateResponse({
        outcome: {
          outcome: "selected",
          optionId: "allow",
          unknownNestedKey: true,
        },
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_REQUESTS.requestPermission.validateResponseForRequest?.(
        { outcome: { outcome: "selected", optionId: "allow" } },
        permissionRequest,
      ),
    ).toBe(true);
    expect(
      ACP_CLIENT_REQUESTS.requestPermission.validateResponseForRequest?.(
        { outcome: { outcome: "selected", optionId: "other" } },
        permissionRequest,
      ),
    ).toBe(false);
    expect(
      ACP_CLIENT_NOTIFICATIONS.sessionUpdate.notificationOrderingKey?.({
        sessionId: "s",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      }),
    ).toBe("s");
    expect(
      ACP_AGENT_NOTIFICATIONS.cancelSession.notificationOrderingKey?.({
        sessionId: "s",
      }),
    ).toBe("s");
    expect(
      ACP_AGENT_NOTIFICATIONS.cancelSession.validateParams({
        sessionId: "s",
        extra: true,
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_REQUESTS.readTextFile.validateRequest({
        sessionId: "s",
        path: "/tmp/file",
        line: 1,
        limit: SEDES_ACP_MAXIMUM_TEXT_FILE_LINES,
      }),
    ).toBe(true);
    for (const value of [0, -1, 1.5, 0x1_0000_0000]) {
      expect(
        ACP_CLIENT_REQUESTS.readTextFile.validateRequest({
          sessionId: "s",
          path: "/tmp/file",
          line: value,
        }),
      ).toBe(false);
    }
    expect(
      ACP_CLIENT_REQUESTS.readTextFile.validateRequest({
        sessionId: "s",
        path: "/tmp/file",
        limit: SEDES_ACP_MAXIMUM_TEXT_FILE_LINES + 1,
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_REQUESTS.writeTextFile.validateRequest({
        sessionId: "s",
        path: "relative.txt",
        content: "x",
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_REQUESTS.createTerminal.validateRequest({
        sessionId: "s",
        command: "true",
        cwd: "/tmp",
        outputByteLimit: SEDES_ACP_MAXIMUM_TERMINAL_OUTPUT_BYTES,
      }),
    ).toBe(true);
    expect(
      ACP_CLIENT_REQUESTS.createTerminal.validateRequest({
        sessionId: "s",
        command: "",
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_REQUESTS.createTerminal.validateRequest({
        sessionId: "s",
        command: "true",
        env: [
          { name: "TOKEN", value: "a" },
          { name: "TOKEN", value: "b" },
        ],
      }),
    ).toBe(false);
    for (const outputByteLimit of [
      -1,
      1.5,
      SEDES_ACP_MAXIMUM_TERMINAL_OUTPUT_BYTES + 1,
    ]) {
      expect(
        ACP_CLIENT_REQUESTS.createTerminal.validateRequest({
          sessionId: "s",
          command: "true",
          outputByteLimit,
        }),
      ).toBe(false);
    }
    expect(
      ACP_CLIENT_REQUESTS.waitForTerminalExit.validateResponse({
        exitCode: 0xffff_ffff,
      }),
    ).toBe(true);
    expect(
      ACP_CLIENT_REQUESTS.waitForTerminalExit.validateResponse({
        exitCode: null,
        signal: "SIGTERM",
      }),
    ).toBe(true);
    expect(
      ACP_CLIENT_REQUESTS.waitForTerminalExit.validateResponse({
        exitCode: null,
      }),
    ).toBe(false);
    for (const exitCode of [-1, 1.5, 0x1_0000_0000]) {
      expect(
        ACP_CLIENT_REQUESTS.waitForTerminalExit.validateResponse({ exitCode }),
      ).toBe(false);
    }
  });

  it("enforces every adopted path and ignored integer-format refinement", () => {
    expect(
      ACP_AGENT_REQUESTS.newSession.validateRequest({
        cwd: "C:\\repo",
        additionalDirectories: ["\\\\server\\share"],
        mcpServers: [
          { name: "stdio", command: "C:\\bin\\mcp.exe", args: [], env: [] },
        ],
      }),
    ).toBe(true);
    expect(
      ACP_AGENT_REQUESTS.newSession.validateRequest({
        cwd: "/repo",
        mcpServers: [
          {
            name: "http",
            type: "http",
            url: "https://example.test/mcp",
            headers: [],
          },
          {
            name: "acp",
            type: "acp",
            serverId: "server-1",
          },
        ],
      }),
    ).toBe(true);
    expect(
      ACP_AGENT_REQUESTS.newSession.validateRequest({
        cwd: "/repo",
        mcpServers: [
          { name: "http", type: "http", url: "file:///tmp/mcp", headers: [] },
        ],
      }),
    ).toBe(false);
    expect(
      ACP_AGENT_REQUESTS.newSession.validateRequest({
        cwd: "/repo",
        mcpServers: [
          {
            name: "stdio",
            command: "/bin/mcp",
            args: [],
            env: [
              { name: "TOKEN", value: "a" },
              { name: "TOKEN", value: "b" },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(
      ACP_AGENT_REQUESTS.newSession.validateRequest({
        cwd: "relative",
        mcpServers: [],
      }),
    ).toBe(false);
    expect(
      ACP_AGENT_REQUESTS.loadSession.validateRequest({
        sessionId: "s",
        cwd: "/repo",
        additionalDirectories: ["relative"],
        mcpServers: [],
      }),
    ).toBe(false);
    expect(
      ACP_AGENT_REQUESTS.resumeSession.validateRequest({
        sessionId: "s",
        cwd: "/repo",
        mcpServers: [{ name: "stdio", command: "relative", args: [], env: [] }],
      }),
    ).toBe(false);
    expect(
      ACP_UNSTABLE_V1_AGENT_REQUESTS.forkSession.validateRequest({
        sessionId: "s",
        cwd: "relative",
      }),
    ).toBe(false);
    expect(
      ACP_AGENT_REQUESTS.listSessions.validateRequest({ cwd: "relative" }),
    ).toBe(false);
    expect(
      ACP_AGENT_REQUESTS.listSessions.validateResponse({
        sessions: [{ sessionId: "s", cwd: "relative" }],
      }),
    ).toBe(false);

    const permissionOption = {
      optionId: "same",
      name: "Allow",
      kind: "allow_once" as const,
    };
    const duplicatePermission = {
      sessionId: "s",
      toolCall: { toolCallId: "tool" },
      options: [permissionOption, { ...permissionOption, name: "Other" }],
    };
    expect(
      ACP_CLIENT_REQUESTS.requestPermission.validateRequest(
        duplicatePermission,
      ),
    ).toBe(false);

    expect(
      ACP_CLIENT_REQUESTS.readTextFile.validateRequest({
        sessionId: "s",
        path: "/tmp/file",
        limit: 0,
      }),
    ).toBe(true);
    expect(
      ACP_CLIENT_REQUESTS.requestPermission.validateRequest({
        ...duplicatePermission,
        options: [],
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_REQUESTS.requestPermission.validateRequest({
        ...duplicatePermission,
        options: [permissionOption],
        toolCall: {
          toolCallId: "tool",
          content: [{ type: "terminal", terminalId: "" }],
        },
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_REQUESTS.requestPermission.validateRequest({
        ...duplicatePermission,
        options: [permissionOption],
        toolCall: {
          toolCallId: "tool",
          locations: [{ path: "relative/path.ts", line: 12 }],
        },
      }),
    ).toBe(true);
    expect(
      ACP_CLIENT_REQUESTS.requestPermission.validateRequest({
        ...duplicatePermission,
        options: [permissionOption],
        toolCall: {
          toolCallId: "tool",
          locations: [{ path: "relative/path.ts", line: 0x1_0000_0000 }],
        },
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_REQUESTS.requestPermission.validateRequest({
        ...duplicatePermission,
        options: [permissionOption],
        toolCall: {
          toolCallId: "tool",
          content: [{ type: "diff", path: "relative", newText: "x" }],
        },
      }),
    ).toBe(true);

    expect(
      ACP_AGENT_REQUESTS.prompt.validateRequest({
        sessionId: "s",
        prompt: [
          { type: "resource_link", name: "r", uri: "file:///r", size: -1 },
        ],
      }),
    ).toBe(false);
    expect(
      ACP_AGENT_REQUESTS.prompt.validateResponse({
        stopReason: "end_turn",
        usage: {
          totalTokens: Number.MAX_SAFE_INTEGER + 1,
          inputTokens: 1,
          outputTokens: 1,
        },
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_NOTIFICATIONS.sessionUpdate.validateParams({
        sessionId: "s",
        update: {
          sessionUpdate: "usage_update",
          used: Number.MAX_SAFE_INTEGER + 1,
          size: 1,
        },
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_REQUESTS.terminalOutput.validateResponse({
        output: "",
        truncated: false,
        exitStatus: { exitCode: 0x1_0000_0000, signal: null },
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_REQUESTS.terminalOutput.validateResponse({
        output: "",
        truncated: false,
        exitStatus: { exitCode: 0, signal: "SIGTERM" },
      }),
    ).toBe(false);
    expect(ACP_CLIENT_REQUESTS.waitForTerminalExit.validateResponse({})).toBe(
      false,
    );
    expect(
      ACP_CLIENT_REQUESTS.waitForTerminalExit.validateResponse({
        exitCode: null,
        signal: "",
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_NOTIFICATIONS.sessionUpdate.validateParams({
        sessionId: "s",
        update: {
          sessionUpdate: "usage_update",
          used: 2,
          size: 1,
          cost: { amount: 1, currency: "usd" },
        },
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_NOTIFICATIONS.sessionUpdate.validateParams({
        sessionId: "s",
        update: {
          sessionUpdate: "usage_update",
          used: 1,
          size: 2,
          cost: { amount: 1, currency: "USD" },
        },
      }),
    ).toBe(true);
  });

  it("keeps declared open maps non-evidentiary", () => {
    const hostileLookingMeta = {
      path: "relative",
      used: -1,
      currentModeId: "not-a-catalog-member",
    };
    expect(
      ACP_AGENT_REQUESTS.prompt.validateRequest({
        sessionId: "session",
        prompt: [
          {
            type: "text",
            text: "hello",
            _meta: hostileLookingMeta,
          },
        ],
        _meta: hostileLookingMeta,
      }),
    ).toBe(true);
    expect(
      ACP_AGENT_REQUESTS.initialize.validateResponse({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [
          {
            id: "terminal-auth",
            name: "Terminal",
            type: "terminal",
            env: { id: "", sessionId: "", path: "relative" },
          },
        ],
      }),
    ).toBe(true);
    expect(
      ACP_AGENT_REQUESTS.initialize.validateResponse({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [
          {
            id: "env-auth",
            name: "Environment",
            type: "env_var",
            vars: [
              { name: "TOKEN", label: "First" },
              { name: "TOKEN", label: "Second" },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  it("validates catalogs, timestamps, and cross-request references", () => {
    const catalog = [
      {
        id: "model",
        name: "Model",
        type: "select" as const,
        currentValue: "a",
        options: [
          { value: "a", name: "A" },
          { value: "b", name: "B" },
        ],
      },
    ];
    expect(
      ACP_AGENT_REQUESTS.setSessionConfigOption.validateResponse({
        configOptions: catalog,
      }),
    ).toBe(true);
    expect(
      ACP_AGENT_REQUESTS.newSession.validateResponse({
        sessionId: "",
      }),
    ).toBe(false);
    expect(
      ACP_AGENT_REQUESTS.setSessionMode.validateRequest({
        sessionId: "session",
        modeId: "",
      }),
    ).toBe(false);
    expect(
      ACP_AGENT_NOTIFICATIONS.cancelSession.validateParams({ sessionId: "" }),
    ).toBe(false);
    expect(
      ACP_CLIENT_REQUESTS.createTerminal.validateResponse({ terminalId: "" }),
    ).toBe(false);
    expect(
      ACP_CLIENT_NOTIFICATIONS.sessionUpdate.validateParams({
        sessionId: "session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "",
          content: { type: "text", text: "chunk" },
        },
      }),
    ).toBe(false);
    expect(
      ACP_CLIENT_NOTIFICATIONS.sessionUpdate.validateParams({
        sessionId: "session",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "same", description: "a" },
            { name: "same", description: "b" },
          ],
        },
      }),
    ).toBe(false);
    expect(
      ACP_AGENT_REQUESTS.setSessionConfigOption.validateResponseForRequest?.(
        { configOptions: catalog },
        { sessionId: "s", configId: "model", value: "a" },
      ),
    ).toBe(true);
    expect(
      ACP_AGENT_REQUESTS.setSessionConfigOption.validateResponseForRequest?.(
        { configOptions: catalog },
        { sessionId: "s", configId: "model", value: "b" },
      ),
    ).toBe(false);
    expect(
      ACP_AGENT_REQUESTS.listSessions.validateResponse({
        sessions: [
          { sessionId: "a", cwd: "/repo", updatedAt: "2024-02-29T23:59:59Z" },
        ],
      }),
    ).toBe(true);
    for (const updatedAt of [
      "2021-02-29T00:00:00Z",
      "2024-02-30T00:00:00Z",
      "2024-01-01T24:00:00Z",
    ]) {
      expect(
        ACP_AGENT_REQUESTS.listSessions.validateResponse({
          sessions: [{ sessionId: "a", cwd: "/repo", updatedAt }],
        }),
      ).toBe(false);
    }
    expect(
      ACP_AGENT_REQUESTS.listSessions.validateResponseForRequest?.(
        { sessions: [{ sessionId: "a", cwd: "/other" }] },
        { cwd: "/repo" },
      ),
    ).toBe(false);
    expect(
      ACP_AGENT_REQUESTS.initialize.validateResponseForRequest?.(
        {
          protocolVersion: 1,
          agentCapabilities: { positionEncoding: "utf-8" },
        },
        {
          protocolVersion: 1,
          clientCapabilities: { positionEncodings: ["utf-8", "utf-16"] },
        },
      ),
    ).toBe(true);
    expect(
      ACP_AGENT_REQUESTS.initialize.validateResponseForRequest?.(
        {
          protocolVersion: 1,
          agentCapabilities: { positionEncoding: "utf-32" },
        },
        {
          protocolVersion: 1,
          clientCapabilities: { positionEncodings: ["utf-8"] },
        },
      ),
    ).toBe(false);
  });
});
