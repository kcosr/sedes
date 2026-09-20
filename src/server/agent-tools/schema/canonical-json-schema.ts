import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { deterministicJson } from "../../canonical-json.js";

export const AGENT_TOOL_JSON_SCHEMA_DIALECT =
  "https://json-schema.org/draft/2020-12/schema" as const;

export const AGENT_TOOL_SCHEMA_LIMITS = Object.freeze({
  maximumDepth: 8,
  maximumNodes: 256,
  maximumObjectProperties: 64,
  maximumArrayItems: 1_024,
  maximumStringLength: 262_144,
  maximumTitleBytes: 120,
  maximumDescriptionBytes: 2_000,
});

interface CanonicalSchemaMetadata {
  readonly title?: string;
  readonly description?: string;
}

export interface CanonicalObjectSchema extends CanonicalSchemaMetadata {
  readonly type: "object";
  readonly properties: Readonly<Record<string, CanonicalAgentToolSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
  readonly minProperties?: number;
  readonly maxProperties: number;
}

export interface CanonicalArraySchema extends CanonicalSchemaMetadata {
  readonly type: "array";
  readonly items: CanonicalAgentToolSchema;
  readonly minItems?: number;
  readonly maxItems: number;
  readonly uniqueItems?: boolean;
}

export interface CanonicalStringSchema extends CanonicalSchemaMetadata {
  readonly type: "string";
  readonly minLength?: number;
  readonly maxLength: number;
  readonly enum?: readonly string[];
}

export interface CanonicalIntegerSchema extends CanonicalSchemaMetadata {
  readonly type: "integer";
  readonly minimum: number;
  readonly maximum: number;
}

export interface CanonicalNumberSchema extends CanonicalSchemaMetadata {
  readonly type: "number";
  readonly minimum: number;
  readonly maximum: number;
}

export interface CanonicalBooleanSchema extends CanonicalSchemaMetadata {
  readonly type: "boolean";
}

export interface CanonicalNullSchema extends CanonicalSchemaMetadata {
  readonly type: "null";
}

export interface CanonicalUnionSchema extends CanonicalSchemaMetadata {
  readonly anyOf: readonly CanonicalAgentToolSchema[];
}

export type CanonicalAgentToolSchema =
  | CanonicalObjectSchema
  | CanonicalArraySchema
  | CanonicalStringSchema
  | CanonicalIntegerSchema
  | CanonicalNumberSchema
  | CanonicalBooleanSchema
  | CanonicalNullSchema
  | CanonicalUnionSchema;

export interface CanonicalAgentToolRootSchema extends CanonicalObjectSchema {
  readonly $schema: typeof AGENT_TOOL_JSON_SCHEMA_DIALECT;
}

export interface CanonicalSchemaValidator<T = unknown> {
  readonly schema: CanonicalAgentToolRootSchema;
  check(value: unknown): value is T;
  errors(): readonly ErrorObject[];
}

const metadataKeywords = new Set(["title", "description"]);
const keywordsByKind = Object.freeze({
  object: new Set([
    ...metadataKeywords,
    "type",
    "properties",
    "required",
    "additionalProperties",
    "minProperties",
    "maxProperties",
  ]),
  array: new Set([
    ...metadataKeywords,
    "type",
    "items",
    "minItems",
    "maxItems",
    "uniqueItems",
  ]),
  string: new Set([
    ...metadataKeywords,
    "type",
    "minLength",
    "maxLength",
    "enum",
  ]),
  integer: new Set([
    ...metadataKeywords,
    "type",
    "minimum",
    "maximum",
  ]),
  number: new Set([
    ...metadataKeywords,
    "type",
    "minimum",
    "maximum",
  ]),
  boolean: new Set([...metadataKeywords, "type"]),
  null: new Set([...metadataKeywords, "type"]),
  anyOf: new Set([...metadataKeywords, "anyOf"]),
});

function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor)) {
    throw new Error(`agent_tool_schema_accessor:${key}`);
  }
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertPlainObject(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`agent_tool_schema_object_required:${path}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`agent_tool_schema_plain_object_required:${path}`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`agent_tool_schema_symbol_key:${path}`);
  }
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(`agent_tool_schema_accessor:${path}.${key}`);
    }
  }
}

function assertBoundedText(
  value: unknown,
  path: string,
  maximumBytes: number,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    byteLength(value) > maximumBytes
  ) {
    throw new Error(`agent_tool_schema_text_invalid:${path}`);
  }
}

function assertOptionalMetadata(schema: Record<string, unknown>, path: string) {
  const title = own(schema, "title");
  if (title !== undefined) {
    assertBoundedText(
      title,
      `${path}.title`,
      AGENT_TOOL_SCHEMA_LIMITS.maximumTitleBytes,
    );
  }
  const description = own(schema, "description");
  if (description !== undefined) {
    assertBoundedText(
      description,
      `${path}.description`,
      AGENT_TOOL_SCHEMA_LIMITS.maximumDescriptionBytes,
    );
  }
}

function integer(value: unknown, path: string, minimum: number, maximum: number) {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`agent_tool_schema_integer_invalid:${path}`);
  }
  return value as number;
}

interface TraversalState {
  nodes: number;
  readonly ancestors: Set<object>;
}

function assertKeywords(
  schema: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  root: boolean,
): void {
  for (const key of Object.keys(schema)) {
    if (!allowed.has(key) && !(root && key === "$schema")) {
      throw new Error(`agent_tool_schema_keyword_unsupported:${path}.${key}`);
    }
  }
}

function validateNode(
  value: unknown,
  path: string,
  depth: number,
  state: TraversalState,
  root = false,
): CanonicalAgentToolSchema {
  assertPlainObject(value, path);
  if (state.ancestors.has(value)) {
    throw new Error(`agent_tool_schema_cycle:${path}`);
  }
  if (depth > AGENT_TOOL_SCHEMA_LIMITS.maximumDepth) {
    throw new Error(`agent_tool_schema_depth_exceeded:${path}`);
  }
  state.nodes += 1;
  if (state.nodes > AGENT_TOOL_SCHEMA_LIMITS.maximumNodes) {
    throw new Error("agent_tool_schema_nodes_exceeded");
  }
  state.ancestors.add(value);
  try {
    assertOptionalMetadata(value, path);
    const type = own(value, "type");
    const anyOf = own(value, "anyOf");
    if (anyOf !== undefined) {
      if (root) {
        throw new Error("agent_tool_schema_root_object_required");
      }
      if (type !== undefined) {
        throw new Error(`agent_tool_schema_union_type_conflict:${path}`);
      }
      assertKeywords(value, keywordsByKind.anyOf, path, root);
      if (!Array.isArray(anyOf) || anyOf.length < 2 || anyOf.length > 8) {
        throw new Error(`agent_tool_schema_union_invalid:${path}`);
      }
      const normalized = anyOf.map((member, index) =>
        validateNode(member, `${path}.anyOf[${index}]`, depth + 1, state),
      );
      if (new Set(normalized.map(deterministicJson)).size !== normalized.length) {
        throw new Error(`agent_tool_schema_union_duplicate:${path}`);
      }
      return {
        ...(own(value, "title") === undefined
          ? {}
          : { title: own(value, "title") as string }),
        ...(own(value, "description") === undefined
          ? {}
          : { description: own(value, "description") as string }),
        anyOf: normalized,
      };
    }
    if (type === "object") {
      assertKeywords(value, keywordsByKind.object, path, root);
      const properties = own(value, "properties");
      assertPlainObject(properties, `${path}.properties`);
      const propertyNames = Object.keys(properties).sort();
      if (
        propertyNames.length > AGENT_TOOL_SCHEMA_LIMITS.maximumObjectProperties
      ) {
        throw new Error(`agent_tool_schema_properties_exceeded:${path}`);
      }
      const additionalProperties = own(value, "additionalProperties");
      if (additionalProperties !== false) {
        throw new Error(`agent_tool_schema_closed_object_required:${path}`);
      }
      const maximum = integer(
        own(value, "maxProperties"),
        `${path}.maxProperties`,
        propertyNames.length,
        AGENT_TOOL_SCHEMA_LIMITS.maximumObjectProperties,
      );
      const minimumValue = own(value, "minProperties");
      const minimum =
        minimumValue === undefined
          ? undefined
          : integer(
              minimumValue,
              `${path}.minProperties`,
              0,
              Math.min(maximum, propertyNames.length),
            );
      const required = own(value, "required");
      if (required !== undefined && !Array.isArray(required)) {
        throw new Error(`agent_tool_schema_required_invalid:${path}`);
      }
      const normalizedRequired = (required ?? []).map((entry: unknown) => {
        if (typeof entry !== "string" || !propertyNames.includes(entry)) {
          throw new Error(`agent_tool_schema_required_invalid:${path}`);
        }
        return entry;
      });
      if (new Set(normalizedRequired).size !== normalizedRequired.length) {
        throw new Error(`agent_tool_schema_required_duplicate:${path}`);
      }
      const normalizedProperties: Record<string, CanonicalAgentToolSchema> = {};
      for (const propertyName of propertyNames) {
        if (
          propertyName.length === 0 ||
          byteLength(propertyName) > 128 ||
          propertyName === "__proto__" ||
          propertyName === "constructor" ||
          propertyName === "prototype"
        ) {
          throw new Error(
            `agent_tool_schema_property_name_invalid:${path}.${propertyName}`,
          );
        }
        normalizedProperties[propertyName] = validateNode(
          properties[propertyName],
          `${path}.properties.${propertyName}`,
          depth + 1,
          state,
        );
      }
      return {
        ...(root ? { $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT } : {}),
        ...(own(value, "title") === undefined
          ? {}
          : { title: own(value, "title") as string }),
        ...(own(value, "description") === undefined
          ? {}
          : { description: own(value, "description") as string }),
        type,
        properties: normalizedProperties,
        required: [...normalizedRequired].sort(),
        additionalProperties: false,
        ...(minimum === undefined ? {} : { minProperties: minimum }),
        maxProperties: maximum,
      };
    }
    if (root) {
      throw new Error("agent_tool_schema_root_object_required");
    }
    if (type === "array") {
      assertKeywords(value, keywordsByKind.array, path, false);
      const maximum = integer(
        own(value, "maxItems"),
        `${path}.maxItems`,
        0,
        AGENT_TOOL_SCHEMA_LIMITS.maximumArrayItems,
      );
      const minimumValue = own(value, "minItems");
      const minimum =
        minimumValue === undefined
          ? undefined
          : integer(minimumValue, `${path}.minItems`, 0, maximum);
      const uniqueItems = own(value, "uniqueItems");
      if (uniqueItems !== undefined && typeof uniqueItems !== "boolean") {
        throw new Error(`agent_tool_schema_unique_items_invalid:${path}`);
      }
      return {
        ...(own(value, "title") === undefined
          ? {}
          : { title: own(value, "title") as string }),
        ...(own(value, "description") === undefined
          ? {}
          : { description: own(value, "description") as string }),
        type,
        items: validateNode(
          own(value, "items"),
          `${path}.items`,
          depth + 1,
          state,
        ),
        ...(minimum === undefined ? {} : { minItems: minimum }),
        maxItems: maximum,
        ...(uniqueItems === undefined
          ? {}
          : { uniqueItems: uniqueItems as boolean }),
      };
    }
    if (type === "string") {
      assertKeywords(value, keywordsByKind.string, path, false);
      const maximum = integer(
        own(value, "maxLength"),
        `${path}.maxLength`,
        0,
        AGENT_TOOL_SCHEMA_LIMITS.maximumStringLength,
      );
      const minimumValue = own(value, "minLength");
      const minimum =
        minimumValue === undefined
          ? undefined
          : integer(minimumValue, `${path}.minLength`, 0, maximum);
      const enumValue = own(value, "enum");
      let normalizedEnum: string[] | undefined;
      if (enumValue !== undefined) {
        if (!Array.isArray(enumValue) || enumValue.length === 0) {
          throw new Error(`agent_tool_schema_enum_invalid:${path}`);
        }
        normalizedEnum = enumValue.map((entry) => {
          if (typeof entry !== "string" || entry.length > maximum) {
            throw new Error(`agent_tool_schema_enum_invalid:${path}`);
          }
          return entry;
        });
        if (new Set(normalizedEnum).size !== normalizedEnum.length) {
          throw new Error(`agent_tool_schema_enum_duplicate:${path}`);
        }
      }
      return {
        ...(own(value, "title") === undefined
          ? {}
          : { title: own(value, "title") as string }),
        ...(own(value, "description") === undefined
          ? {}
          : { description: own(value, "description") as string }),
        type,
        ...(minimum === undefined ? {} : { minLength: minimum }),
        maxLength: maximum,
        ...(normalizedEnum === undefined ? {} : { enum: normalizedEnum }),
      };
    }
    if (type === "integer" || type === "number") {
      assertKeywords(value, keywordsByKind[type], path, false);
      const minimum = own(value, "minimum");
      const maximum = own(value, "maximum");
      if (
        typeof minimum !== "number" ||
        typeof maximum !== "number" ||
        !Number.isFinite(minimum) ||
        !Number.isFinite(maximum) ||
        minimum > maximum ||
        (type === "integer" &&
          (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)))
      ) {
        throw new Error(`agent_tool_schema_numeric_bounds_invalid:${path}`);
      }
      return {
        ...(own(value, "title") === undefined
          ? {}
          : { title: own(value, "title") as string }),
        ...(own(value, "description") === undefined
          ? {}
          : { description: own(value, "description") as string }),
        type,
        minimum,
        maximum,
      };
    }
    if (type === "boolean" || type === "null") {
      assertKeywords(value, keywordsByKind[type], path, false);
      return {
        ...(own(value, "title") === undefined
          ? {}
          : { title: own(value, "title") as string }),
        ...(own(value, "description") === undefined
          ? {}
          : { description: own(value, "description") as string }),
        type,
      };
    }
    throw new Error(`agent_tool_schema_type_unsupported:${path}`);
  } finally {
    state.ancestors.delete(value);
  }
}

/**
 * Validates the deliberately narrow cross-adapter JSON Schema subset and
 * returns a detached, deterministically ordered schema artifact.
 */
export function normalizeCanonicalAgentToolSchema(
  schema: unknown,
): CanonicalAgentToolRootSchema {
  assertPlainObject(schema, "$schema");
  if (own(schema, "$schema") !== AGENT_TOOL_JSON_SCHEMA_DIALECT) {
    throw new Error("agent_tool_schema_dialect_invalid");
  }
  return validateNode(
    schema,
    "$schema",
    0,
    { nodes: 0, ancestors: new Set<object>() },
    true,
  ) as CanonicalAgentToolRootSchema;
}

export function compileCanonicalAgentToolSchema<T = unknown>(
  schema: unknown,
): CanonicalSchemaValidator<T> {
  const normalized = normalizeCanonicalAgentToolSchema(schema);
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });
  const validate: ValidateFunction<T> = ajv.compile(normalized);
  return {
    schema: normalized,
    check(value: unknown): value is T {
      return validate(value);
    },
    errors: () => Object.freeze([...(validate.errors ?? [])]),
  };
}
