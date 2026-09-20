import { deterministicJson } from "../../canonical-json.js";
import type {
  CanonicalAgentToolRootSchema,
  CanonicalAgentToolSchema,
} from "./canonical-json-schema.js";

export type CanonicalCliOptionRepresentation = "value" | "json" | "file";

export interface CanonicalCliOptionSpec {
  readonly name: string;
  readonly path: readonly string[];
  readonly schema: CanonicalAgentToolSchema;
  readonly representation: CanonicalCliOptionRepresentation;
  readonly repeatable: boolean;
  readonly arraySchema?: Extract<
    CanonicalAgentToolSchema,
    { readonly type: "array" }
  >;
}

const reservedOptionNames = new Set(["help", "input-file", "json"]);

export function canonicalCliOptionSpecs(
  schema: CanonicalAgentToolRootSchema,
): readonly CanonicalCliOptionSpec[] {
  const specs = new Map<string, CanonicalCliOptionSpec>();
  for (const [property, child] of Object.entries(schema.properties)) {
    collectSpecs(specs, [property], child);
  }
  return [...specs.values()];
}

function collectSpecs(
  specs: Map<string, CanonicalCliOptionSpec>,
  path: readonly string[],
  schema: CanonicalAgentToolSchema,
): void {
  const objectMembers = objectSchemas(schema);
  if (objectMembers) {
    addSpec(specs, path, schema, "json", false, "json");
    const properties = new Map<string, CanonicalAgentToolSchema[]>();
    for (const object of objectMembers) {
      for (const [name, child] of Object.entries(object.properties)) {
        const existing = properties.get(name) ?? [];
        existing.push(child);
        properties.set(name, existing);
      }
    }
    for (const [name, members] of properties) {
      collectSpecs(specs, [...path, name], unionOf(members));
    }
    return;
  }
  if ("anyOf" in schema) {
    if (isPrimitive(schema)) {
      addSpec(specs, path, schema, "value", false);
      addSpec(specs, path, schema, "json", false, "json");
      if (acceptsString(schema)) {
        addSpec(specs, path, schema, "file", false, "file");
      }
    } else {
      addSpec(specs, path, schema, "json", false, "json");
    }
    return;
  }
  if (schema.type === "array" && isPrimitive(schema.items)) {
    addSpec(specs, path, schema.items, "value", true, undefined, schema);
    if (acceptsString(schema.items)) {
      addSpec(specs, path, schema.items, "file", true, "file", schema);
    }
    return;
  }
  if (schema.type === "array") {
    addSpec(specs, path, schema, "json", false, "json");
    return;
  }
  addSpec(specs, path, schema, "value", false);
  if (acceptsString(schema)) {
    addSpec(specs, path, schema, "file", false, "file");
  }
}

function addSpec(
  specs: Map<string, CanonicalCliOptionSpec>,
  path: readonly string[],
  schema: CanonicalAgentToolSchema,
  representation: CanonicalCliOptionRepresentation,
  repeatable: boolean,
  suffix?: string,
  arraySchema?: Extract<CanonicalAgentToolSchema, { readonly type: "array" }>,
): void {
  const base = path.map(kebab).join("-");
  const name = suffix ? `${base}-${suffix}` : base;
  if (reservedOptionNames.has(name)) {
    throw new Error(`agent_tool_cli_input_option_reserved:${name}`);
  }
  if (specs.has(name)) {
    throw new Error(`agent_tool_cli_input_option_ambiguous:${name}`);
  }
  specs.set(name, {
    name,
    path,
    schema,
    representation,
    repeatable,
    ...(arraySchema ? { arraySchema } : {}),
  });
}

function objectSchemas(
  schema: CanonicalAgentToolSchema,
): readonly Extract<CanonicalAgentToolSchema, { readonly type: "object" }>[] | undefined {
  if ("anyOf" in schema) {
    return schema.anyOf.every(
      (member) => !("anyOf" in member) && member.type === "object",
    )
      ? (schema.anyOf as readonly Extract<
          CanonicalAgentToolSchema,
          { readonly type: "object" }
        >[])
      : undefined;
  }
  return schema.type === "object" ? [schema] : undefined;
}

function unionOf(
  schemas: readonly CanonicalAgentToolSchema[],
): CanonicalAgentToolSchema {
  const unique = [
    ...new Map(schemas.map((schema) => [deterministicJson(schema), schema])).values(),
  ];
  return unique.length === 1 ? unique[0]! : { anyOf: unique };
}

function isPrimitive(schema: CanonicalAgentToolSchema): boolean {
  if ("anyOf" in schema) return schema.anyOf.every(isPrimitive);
  return ["string", "integer", "number", "boolean", "null"].includes(
    schema.type,
  );
}

function acceptsString(schema: CanonicalAgentToolSchema): boolean {
  return "anyOf" in schema
    ? schema.anyOf.some(acceptsString)
    : schema.type === "string";
}

function kebab(value: string): string {
  return value
    .replaceAll("_", "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}
