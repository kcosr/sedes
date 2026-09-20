export interface AcpValueValidator<T> {
  (value: unknown): boolean;
  readonly errors?: readonly unknown[] | null;
}

import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../transport/framed-message-limits.js";

export interface AcpSemanticLimits {
  readonly maximumDepth: number;
  readonly maximumObjectProperties: number;
  readonly maximumArrayItems: number;
  readonly maximumStringBytes: number;
  readonly maximumTotalNodes: number;
}

export const DEFAULT_ACP_SEMANTIC_LIMITS: AcpSemanticLimits = Object.freeze({
  maximumDepth: 32,
  maximumObjectProperties: 256,
  // Standard ACP open-map values may carry bounded binary or terminal output
  // as JSON arrays. The encoded frame is the effective aggregate bound; route
  // schemas retain field meaning and independently bound consumed fields.
  maximumArrayItems: MAXIMUM_PROVIDER_FRAME_BYTES,
  // Standard ACP image blocks likewise carry base64 in one string.
  maximumStringBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
  maximumTotalNodes: MAXIMUM_PROVIDER_FRAME_BYTES,
});

export function validateAcpValue<T>(
  value: unknown,
  validator: AcpValueValidator<T>,
  limits: AcpSemanticLimits,
): value is T {
  return boundedJsonValue(value, limits) && validator(value);
}

function boundedJsonValue(root: unknown, limits: AcpSemanticLimits): boolean {
  let nodes = 0;
  const visit = (value: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > limits.maximumTotalNodes || depth > limits.maximumDepth) {
      return false;
    }
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") {
      return (
        Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
      );
    }
    if (typeof value === "string") {
      return Buffer.byteLength(value, "utf8") <= limits.maximumStringBytes;
    }
    if (Array.isArray(value)) {
      if (value.length > limits.maximumArrayItems) return false;
      for (const child of value) {
        if (!visit(child, depth + 1)) return false;
      }
      return true;
    }
    if (!isPlainObject(value)) return false;
    const entries = Object.entries(value);
    if (entries.length > limits.maximumObjectProperties) return false;
    for (const [key, child] of entries) {
      if (Buffer.byteLength(key, "utf8") > limits.maximumStringBytes) {
        return false;
      }
      if (!visit(child, depth + 1)) return false;
    }
    return true;
  };
  return visit(root, 0);
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
