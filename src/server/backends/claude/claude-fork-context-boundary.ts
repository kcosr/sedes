import { createHmac, timingSafeEqual } from "node:crypto";
import type { HistoricalForkContextBoundary } from "../fork-context-boundary.js";

const PREFIX = "sedes-claude-fork-boundary:v1:";
const DOMAIN = "sedes.claude-fork-boundary.v1";
const LEGACY_PREFIX = "harness-claude-fork-boundary:v1:";
const LEGACY_DOMAIN = "harness.claude-fork-boundary.v1";
const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TAG_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface ClaudeForkBoundaryAuthentication {
  readonly installationKey: Uint8Array;
  readonly tenantId: string;
  readonly principalId: string;
  readonly backendInstanceId: string;
}

export function copyClaudeForkBoundaryKey(key: Uint8Array): Uint8Array {
  if (key.byteLength !== 32) {
    throw new Error("claude_fork_context_boundary_key_invalid");
  }
  return new Uint8Array(key);
}

export function claudeForkContextBoundaryText(
  applicationOperationId: string,
  boundary: HistoricalForkContextBoundary,
  authentication: ClaudeForkBoundaryAuthentication,
): string {
  if (!OPERATION_ID_PATTERN.test(applicationOperationId)) {
    throw new Error("claude_fork_context_boundary_operation_invalid");
  }
  const encodedOperationId = Buffer.from(
    applicationOperationId,
    "utf8",
  ).toString("base64url");
  return `${PREFIX}${encodedOperationId}:${boundaryTag(
    applicationOperationId,
    boundary,
    authentication,
  )}\n${boundary.content}`;
}

export function inspectClaudeForkContextBoundary(
  value: unknown,
  boundary: HistoricalForkContextBoundary,
  authentication: ClaudeForkBoundaryAuthentication,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const format = value.startsWith(PREFIX)
    ? { prefix: PREFIX, domain: DOMAIN }
    : value.startsWith(LEGACY_PREFIX)
      ? { prefix: LEGACY_PREFIX, domain: LEGACY_DOMAIN }
      : undefined;
  if (!format) return undefined;
  const newline = value.indexOf("\n");
  if (newline < 0 || value.slice(newline + 1) !== boundary.content) {
    return undefined;
  }
  const fields = value.slice(format.prefix.length, newline).split(":");
  if (
    fields.length !== 2 ||
    !fields[0] ||
    !fields[1] ||
    !TAG_PATTERN.test(fields[1])
  ) {
    return undefined;
  }
  let operationId: string;
  try {
    operationId = Buffer.from(fields[0], "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    return undefined;
  }
  const received = Buffer.from(fields[1], "base64url");
  const expected = Buffer.from(
    boundaryTag(operationId, boundary, authentication, format.domain),
    "base64url",
  );
  return received.byteLength === expected.byteLength &&
    timingSafeEqual(received, expected)
    ? operationId
    : undefined;
}

function boundaryTag(
  operationId: string,
  boundary: HistoricalForkContextBoundary,
  authentication: ClaudeForkBoundaryAuthentication,
  domain = DOMAIN,
): string {
  const hmac = createHmac("sha256", authentication.installationKey);
  for (const value of [
    domain,
    authentication.tenantId,
    authentication.principalId,
    authentication.backendInstanceId,
    operationId,
    String(boundary.version),
    boundary.content,
  ]) {
    hmac.update(String(Buffer.byteLength(value, "utf8"))).update(":");
    hmac.update(value).update("\0");
  }
  return hmac.digest("base64url");
}
