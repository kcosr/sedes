import { isPlainObject } from "./schema.js";

type JsonSchema = boolean | Record<string, unknown>;

interface ProjectionState {
  candidateOverflow: boolean;
  remainingVisits: number;
}

const MAXIMUM_PROJECTION_CANDIDATES = 64;
const MAXIMUM_PROJECTION_VISITS = 65_536;
const NEUTRAL_PROJECTION = Symbol("acp-neutral-projection");

/**
 * Projects one bounded JSON value onto the fields declared by an adopted ACP
 * schema definition. The existing closed validator remains the structural
 * authority; this projector only removes additive fields before that
 * validation and preserves schema-declared open record maps.
 */
export function projectAcpDefinition(
  value: unknown,
  schemaDocument: unknown,
  definition: string,
): readonly unknown[] {
  if (!isPlainObject(schemaDocument) || !isPlainObject(schemaDocument.$defs)) {
    return [];
  }
  const root = schemaDocument.$defs[definition];
  if (!isSchema(root)) return [];
  const state: ProjectionState = {
    candidateOverflow: false,
    remainingVisits: MAXIMUM_PROJECTION_VISITS,
  };
  const projected = deduplicate(
    projectCandidates(value, root, schemaDocument, state),
  );
  return state.candidateOverflow || state.remainingVisits < 0 ? [] : projected;
}

function projectCandidates(
  value: unknown,
  schema: JsonSchema,
  root: Record<string, unknown>,
  state: ProjectionState,
): readonly unknown[] {
  state.remainingVisits -= 1;
  if (state.remainingVisits < 0) return [];
  if (schema === false) return [];
  if (schema === true) return [value];

  const branches: JsonSchema[] = [];
  if (typeof schema.$ref === "string") {
    const resolved = resolveLocalReference(root, schema.$ref);
    if (!resolved) return [];
    branches.push(resolved);
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      if (!isSchema(branch)) return [];
      branches.push(branch);
    }
  }

  const hasComposition =
    branches.length > 0 ||
    Array.isArray(schema.oneOf) ||
    Array.isArray(schema.anyOf);
  let base =
    hasComposition && !hasDirectProjection(schema)
      ? [NEUTRAL_PROJECTION]
      : projectDirect(value, schema, root, state);
  if (base.length === 0) return [];
  for (const branch of branches) {
    const projectedBranch = projectCandidates(value, branch, root, state);
    base = combineCandidateSets(base, projectedBranch, state);
    if (base.length === 0) return [];
  }

  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (!alternatives) return base;

  const results: unknown[] = [];
  for (const alternative of selectAlternatives(value, alternatives)) {
    if (!isSchema(alternative)) return [];
    const candidates = projectCandidates(value, alternative, root, state);
    results.push(...combineCandidateSets(base, candidates, state));
    if (results.length >= MAXIMUM_PROJECTION_CANDIDATES) {
      state.candidateOverflow = true;
      break;
    }
  }
  return deduplicate(results);
}

function selectAlternatives(
  value: unknown,
  alternatives: readonly unknown[],
): readonly unknown[] {
  if (!isPlainObject(value)) return alternatives;
  const discriminatorKeys = new Set<string>();
  const branchConstants = alternatives.map((alternative) => {
    const constants = new Map<string, unknown>();
    if (!isPlainObject(alternative) || !isPlainObject(alternative.properties)) {
      return constants;
    }
    for (const [key, property] of Object.entries(alternative.properties)) {
      if (isPlainObject(property) && Object.hasOwn(property, "const")) {
        discriminatorKeys.add(key);
        constants.set(key, property.const);
      }
    }
    return constants;
  });
  if (discriminatorKeys.size === 0) return alternatives;

  let selected = alternatives.map((alternative, index) => ({
    alternative,
    constants: branchConstants[index] ?? new Map<string, unknown>(),
  }));
  for (const key of discriminatorKeys) {
    if (Object.hasOwn(value, key)) {
      selected = selected.filter(
        ({ constants }) =>
          constants.has(key) && sameJson(constants.get(key), value[key]),
      );
    } else {
      const defaults = selected.filter(({ constants }) => !constants.has(key));
      if (defaults.length > 0) selected = defaults;
    }
  }
  return selected.map(({ alternative }) => alternative);
}

function projectDirect(
  value: unknown,
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
  state: ProjectionState,
): readonly unknown[] {
  const objectShaped =
    schema.type === "object" ||
    isPlainObject(schema.properties) ||
    Object.hasOwn(schema, "additionalProperties");
  if (objectShaped) {
    if (!isPlainObject(value)) return [value];
    const properties = isPlainObject(schema.properties)
      ? schema.properties
      : {};
    const additional = schema.additionalProperties;
    let candidates: Record<string, unknown>[] = [emptyRecord()];
    for (const [key, child] of Object.entries(value)) {
      const propertySchema = properties[key];
      let projected: readonly unknown[];
      if (isSchema(propertySchema)) {
        projected = projectCandidates(child, propertySchema, root, state);
      } else if (additional === true) {
        const cloned = cloneOpenJson(child, state);
        projected = cloned === undefined ? [] : [cloned];
      } else if (isSchema(additional) && additional !== false) {
        projected = projectCandidates(child, additional, root, state);
      } else {
        continue;
      }
      if (projected.length === 0) return [];
      const next: Record<string, unknown>[] = [];
      for (const candidate of candidates) {
        for (const projectedChild of projected) {
          if (next.length >= MAXIMUM_PROJECTION_CANDIDATES) {
            state.candidateOverflow = true;
            break;
          }
          next.push(recordWith(candidate, key, projectedChild));
        }
      }
      candidates = next;
      if (candidates.length === 0) return [];
    }
    return candidates;
  }

  if (schema.type === "array" || Object.hasOwn(schema, "items")) {
    if (!Array.isArray(value)) return [value];
    if (!isSchema(schema.items)) return [value];
    let candidates: unknown[][] = [[]];
    for (const child of value) {
      const projected = projectCandidates(child, schema.items, root, state);
      if (projected.length === 0) return [];
      const next: unknown[][] = [];
      for (const candidate of candidates) {
        for (const projectedChild of projected) {
          if (next.length >= MAXIMUM_PROJECTION_CANDIDATES) {
            state.candidateOverflow = true;
            break;
          }
          next.push([...candidate, projectedChild]);
        }
      }
      candidates = next;
      if (candidates.length === 0) return [];
    }
    return candidates;
  }

  return [value];
}

function cloneOpenJson(value: unknown, state: ProjectionState): unknown {
  state.remainingVisits -= 1;
  if (state.remainingVisits < 0) return undefined;
  if (Array.isArray(value)) {
    return value.map((child) => cloneOpenJson(child, state));
  }
  if (isPlainObject(value)) {
    let result = emptyRecord();
    for (const [key, child] of Object.entries(value)) {
      result = recordWith(result, key, cloneOpenJson(child, state));
    }
    return result;
  }
  return value;
}

function combineCandidateSets(
  left: readonly unknown[],
  right: readonly unknown[],
  state: ProjectionState,
): unknown[] {
  const combined: unknown[] = [];
  for (const first of left) {
    for (const second of right) {
      const merged = mergeProjection(first, second);
      if (merged === undefined) continue;
      combined.push(merged);
      if (combined.length >= MAXIMUM_PROJECTION_CANDIDATES) {
        state.candidateOverflow = true;
        return deduplicate(combined);
      }
    }
  }
  return deduplicate(combined);
}

function mergeProjection(first: unknown, second: unknown): unknown | undefined {
  if (first === NEUTRAL_PROJECTION) return second;
  if (second === NEUTRAL_PROJECTION) return first;
  if (isPlainObject(first) && isPlainObject(second)) {
    let merged = copyRecord(first);
    for (const [key, value] of Object.entries(second)) {
      if (Object.hasOwn(merged, key)) {
        const existing = merged[key];
        if (isPlainObject(existing) && isPlainObject(value)) {
          const nested = mergeProjection(existing, value);
          if (nested === undefined) return undefined;
          merged = recordWith(merged, key, nested);
        } else if (!sameJson(existing, value)) {
          return undefined;
        }
      } else {
        merged = recordWith(merged, key, value);
      }
    }
    return merged;
  }
  return sameJson(first, second) ? first : undefined;
}

function resolveLocalReference(
  root: Record<string, unknown>,
  reference: string,
): JsonSchema | undefined {
  if (!reference.startsWith("#/")) return;
  let current: unknown = root;
  for (const encoded of reference.slice(2).split("/")) {
    if (!isPlainObject(current)) return;
    const token = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    current = current[token];
  }
  return isSchema(current) ? current : undefined;
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "boolean" || isPlainObject(value);
}

function hasDirectProjection(schema: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(schema, "type") ||
    Object.hasOwn(schema, "const") ||
    Object.hasOwn(schema, "enum") ||
    Object.hasOwn(schema, "not") ||
    Object.hasOwn(schema, "properties") ||
    Object.hasOwn(schema, "additionalProperties") ||
    Object.hasOwn(schema, "items")
  );
}

function deduplicate(values: readonly unknown[]): unknown[] {
  const results: unknown[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value === NEUTRAL_PROJECTION) continue;
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(value);
  }
  return results;
}

function sameJson(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function emptyRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function copyRecord(value: Record<string, unknown>): Record<string, unknown> {
  let result = emptyRecord();
  for (const [key, child] of Object.entries(value)) {
    result = recordWith(result, key, child);
  }
  return result;
}

function recordWith(
  value: Record<string, unknown>,
  key: string,
  child: unknown,
): Record<string, unknown> {
  const result = copyRecordWithoutRecursion(value);
  Object.defineProperty(result, key, {
    configurable: true,
    enumerable: true,
    value: child,
    writable: true,
  });
  return result;
}

function copyRecordWithoutRecursion(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result = emptyRecord();
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: child,
      writable: true,
    });
  }
  return result;
}
