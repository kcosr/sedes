import { createHash } from "node:crypto";

// Permanent persisted fingerprint format identifier. Changing it would make
// unchanged installation configuration appear modified after a product rename.
const CONFIGURATION_FINGERPRINT_DOMAIN = "harness-module-configuration-v1\n";

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("Configuration contains a non-finite number.");
      }
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) {
        throw new Error("Configuration contains a cycle.");
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value
            .map((entry) => canonicalJson(entry, ancestors))
            .join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new Error("Configuration contains a non-JSON object.");
        }
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`,
          )
          .join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new Error("Configuration contains a non-JSON value.");
  }
}

/**
 * Produces a stable digest for already validated, non-secret provider
 * configuration. Object member order is irrelevant; array order remains
 * significant because JSON arrays are ordered.
 *
 * Resolved credentials and other secret values must never be passed here. A
 * provider may fingerprint secret-reference metadata, but never the resolved
 * secret.
 */
export function configurationFingerprint(value: unknown): string {
  const canonical = canonicalJson(value, new Set());
  return createHash("sha256")
    .update(CONFIGURATION_FINGERPRINT_DOMAIN)
    .update(canonical)
    .digest("hex");
}

export const ABSENT_MODULE_CONFIGURATION_FINGERPRINT =
  configurationFingerprint(null);
