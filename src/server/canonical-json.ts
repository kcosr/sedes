export type CanonicalJsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function assertJsonContainer(value: object, path: string): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`canonical_json_non_plain_object:${path}`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`canonical_json_symbol_key:${path}`);
  }
}

function canonicalize(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`canonical_json_non_finite_number:${path}`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new Error(`canonical_json_unsupported_value:${path}`);
  }
  if (ancestors.has(value)) {
    throw new Error(`canonical_json_cycle:${path}`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        canonicalize(item, `${path}[${index}]`, ancestors),
      );
    }
    assertJsonContainer(value, path);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new Error(`canonical_json_accessor:${path}.${key}`);
      }
      result[key] = canonicalize(
        descriptor.value,
        `${path}.${key}`,
        ancestors,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Produces JSON whose object keys are recursively ordered. Array order is
 * preserved because it is part of the contract for enums, unions, and data.
 * Non-JSON values, accessors, class instances, symbols, and cycles fail closed.
 */
export function deterministicJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, "$", new Set<object>()));
}

export function deterministicJsonArtifact(value: unknown): string {
  return `${deterministicJson(value)}\n`;
}
