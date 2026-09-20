import { createHmac, timingSafeEqual } from "node:crypto";

const CLIENT_ID_PREFIX = "sedes:v3:";
const SEDES_CLIENT_ID_PREFIX = "sedes:";
const TAG_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAXIMUM_OPERATION_ID_BYTES = 160;
const MAXIMUM_RECONCILIATION_TOKEN_BYTES = 4_096;
const PROVENANCE_DOMAIN = "sedes.codex-submission.provenance.v1";
const RECONCILIATION_DOMAIN = "sedes.codex-submission.reconciliation.v1";
const FORK_MARKER_PREFIX = "sedes-fork:v1:";
const FORK_PROVENANCE_DOMAIN = "sedes.codex-fork.provenance.v1";
const FORK_BOUNDARY_MARKER_PREFIX = "sedes-fork-boundary:v1:";
const FORK_BOUNDARY_PROVENANCE_DOMAIN =
  "sedes.codex-fork-boundary.provenance.v1";

/**
 * Legacy pre-rename marker families, read-only allowance.
 *
 * Pre-cutover code (Harness, before the 2026-08-26 Sedes rename) persisted
 * these prefixes and HMAC domains into Codex native history: client
 * user-message IDs, fork creation markers, and fork-context boundary hook run
 * IDs. New code never emits them. The inspect functions verify them under
 * their legacy domains so pre-cutover threads keep operation provenance,
 * completion reconciliation, fork lineage, and boundary suppression. A
 * legacy-prefixed value that fails verification is still malformed or forged,
 * exactly as pre-cutover code classified it. Remove this allowance and its
 * tests once no pre-cutover Codex threads remain.
 */
const LEGACY_CLIENT_ID_FAMILY_PREFIX = "harness:";
const LEGACY_CLIENT_ID_PREFIX = "harness:v3:";
const LEGACY_PROVENANCE_DOMAIN = "harness.codex-submission.provenance.v1";
const LEGACY_FORK_MARKER_PREFIX = "harness-fork:v1:";
const LEGACY_FORK_PROVENANCE_DOMAIN = "harness.codex-fork.provenance.v1";
const LEGACY_FORK_BOUNDARY_MARKER_PREFIX = "harness-fork-boundary:v1:";
const LEGACY_FORK_BOUNDARY_PROVENANCE_DOMAIN =
  "harness.codex-fork-boundary.provenance.v1";

export interface CodexSubmissionCorrelationScope {
  readonly toolProvenanceKey: Uint8Array;
  readonly tenantId: string;
  readonly principalId: string;
  readonly backendInstanceId: string;
  readonly nativeThreadId: string;
  readonly correlationAncestorThreadIds: readonly string[];
}

export type CodexSubmissionCorrelationInspection =
  | { readonly type: "non_sedes" }
  | { readonly type: "malformed" }
  | { readonly type: "forged" }
  | {
      readonly type: "authenticated";
      readonly applicationOperationId: string;
    };

export function codexForkCreationMarker(
  input: CodexSubmissionCorrelationScope & {
    readonly applicationOperationId: string;
  },
): string {
  const operationId = canonicalOperationId(input.applicationOperationId);
  const encodedOperationId = Buffer.from(operationId, "utf8").toString(
    "base64url",
  );
  const provenanceTag = hmacTag(
    input.toolProvenanceKey,
    FORK_PROVENANCE_DOMAIN,
    correlationScopeFields(input, operationId),
  );
  return `${FORK_MARKER_PREFIX}${encodedOperationId}:${provenanceTag}`;
}

export function inspectCodexForkCreationMarker(
  value: string | null,
  scope: CodexSubmissionCorrelationScope,
): CodexSubmissionCorrelationInspection {
  let prefix: string;
  let domain: string;
  if (value?.startsWith(FORK_MARKER_PREFIX)) {
    prefix = FORK_MARKER_PREFIX;
    domain = FORK_PROVENANCE_DOMAIN;
  } else if (value?.startsWith(LEGACY_FORK_MARKER_PREFIX)) {
    prefix = LEGACY_FORK_MARKER_PREFIX;
    domain = LEGACY_FORK_PROVENANCE_DOMAIN;
  } else {
    return { type: "non_sedes" };
  }
  const fields = value.slice(prefix.length).split(":");
  if (fields.length !== 2 || !fields[0] || !TAG_PATTERN.test(fields[1]!)) {
    return { type: "malformed" };
  }
  const operationId = decodeOperationId(fields[0]);
  const receivedTag = decodeTag(fields[1]!);
  if (!operationId || !receivedTag) return { type: "malformed" };
  const expectedTag = hmacDigest(
    scope.toolProvenanceKey,
    domain,
    correlationScopeFields(scope, operationId),
  );
  if (
    receivedTag.byteLength !== expectedTag.byteLength ||
    !timingSafeEqual(receivedTag, expectedTag)
  ) {
    return { type: "forged" };
  }
  return { type: "authenticated", applicationOperationId: operationId };
}

export function codexForkContextBoundaryHookRunId(
  input: CodexSubmissionCorrelationScope & {
    readonly applicationOperationId: string;
  },
): string {
  const operationId = canonicalOperationId(input.applicationOperationId);
  const encodedOperationId = Buffer.from(operationId, "utf8").toString(
    "base64url",
  );
  const provenanceTag = hmacTag(
    input.toolProvenanceKey,
    FORK_BOUNDARY_PROVENANCE_DOMAIN,
    correlationScopeFields(input, operationId),
  );
  return `${FORK_BOUNDARY_MARKER_PREFIX}${encodedOperationId}:${provenanceTag}`;
}

export function inspectCodexForkContextBoundaryHookRunId(
  value: string,
  scope: CodexSubmissionCorrelationScope,
): CodexSubmissionCorrelationInspection {
  let prefix: string;
  let domain: string;
  if (value.startsWith(FORK_BOUNDARY_MARKER_PREFIX)) {
    prefix = FORK_BOUNDARY_MARKER_PREFIX;
    domain = FORK_BOUNDARY_PROVENANCE_DOMAIN;
  } else if (value.startsWith(LEGACY_FORK_BOUNDARY_MARKER_PREFIX)) {
    prefix = LEGACY_FORK_BOUNDARY_MARKER_PREFIX;
    domain = LEGACY_FORK_BOUNDARY_PROVENANCE_DOMAIN;
  } else {
    return { type: "non_sedes" };
  }
  const fields = value.slice(prefix.length).split(":");
  if (fields.length !== 2 || !fields[0] || !TAG_PATTERN.test(fields[1]!)) {
    return { type: "malformed" };
  }
  const operationId = decodeOperationId(fields[0]);
  const receivedTag = decodeTag(fields[1]!);
  if (!operationId || !receivedTag) return { type: "malformed" };
  for (const nativeThreadId of [
    scope.nativeThreadId,
    ...scope.correlationAncestorThreadIds,
  ]) {
    const expectedTag = hmacDigest(
      scope.toolProvenanceKey,
      domain,
      correlationScopeFields({ ...scope, nativeThreadId }, operationId),
    );
    if (
      receivedTag.byteLength === expectedTag.byteLength &&
      timingSafeEqual(receivedTag, expectedTag)
    ) {
      return { type: "authenticated", applicationOperationId: operationId };
    }
  }
  return { type: "forged" };
}

/**
 * Copies the installation-owned authentication key at every runtime ownership
 * boundary so a caller cannot rotate a live Codex correlation scope by
 * mutating a previously supplied Uint8Array.
 */
export function copyCodexSubmissionCorrelationKey(key: Uint8Array): Uint8Array {
  if (key.byteLength !== 32) {
    throw new Error("codex_submission_correlation_key_invalid");
  }
  return new Uint8Array(key);
}

/**
 * Codex persists this caller-owned identity on each native user message.
 *
 * The first tag authenticates the operation and its complete runtime/thread
 * scope, which allows a fresh projector to recover the application operation
 * without possessing its reconciliation token. The second tag also binds the
 * durable reconciliation token, so reconciliation still requires an exact
 * expected client ID.
 */
export function codexClientUserMessageId(
  input: CodexSubmissionCorrelationScope & {
    readonly applicationOperationId: string;
    readonly reconciliationToken: string;
  },
): string {
  return submissionClientUserMessageId(input, {
    prefix: CLIENT_ID_PREFIX,
    provenanceDomain: PROVENANCE_DOMAIN,
    reconciliationDomain: RECONCILIATION_DOMAIN,
  });
}

/**
 * Exact read candidates for reconciling submissions persisted on either side
 * of the product rename. The legacy value is computed only for comparison
 * with provider history; every submission emitter remains Sedes-only.
 */
export function codexSubmissionReconciliationClientUserMessageIds(
  input: CodexSubmissionCorrelationScope & {
    readonly applicationOperationId: string;
    readonly reconciliationToken: string;
  },
): readonly [current: string, legacy: string] {
  return [
    codexClientUserMessageId(input),
    submissionClientUserMessageId(input, {
      prefix: LEGACY_CLIENT_ID_PREFIX,
      provenanceDomain: LEGACY_PROVENANCE_DOMAIN,
      reconciliationDomain: "harness.codex-submission.reconciliation.v1",
    }),
  ];
}

function submissionClientUserMessageId(
  input: CodexSubmissionCorrelationScope & {
    readonly applicationOperationId: string;
    readonly reconciliationToken: string;
  },
  family: {
    readonly prefix: string;
    readonly provenanceDomain: string;
    readonly reconciliationDomain: string;
  },
): string {
  const operationId = canonicalOperationId(input.applicationOperationId);
  if (
    input.reconciliationToken.length === 0 ||
    Buffer.byteLength(input.reconciliationToken, "utf8") >
      MAXIMUM_RECONCILIATION_TOKEN_BYTES
  ) {
    throw new Error("invalid Codex reconciliation identity");
  }
  const encodedOperationId = Buffer.from(operationId, "utf8").toString(
    "base64url",
  );
  const scopeFields = correlationScopeFields(input, operationId);
  const reconciliationTag = hmacTag(
    input.toolProvenanceKey,
    family.reconciliationDomain,
    [...scopeFields, input.reconciliationToken],
  );
  const provenanceTag = hmacTag(
    input.toolProvenanceKey,
    family.provenanceDomain,
    [...scopeFields, reconciliationTag],
  );
  return `${family.prefix}${encodedOperationId}:${provenanceTag}:${reconciliationTag}`;
}

/**
 * Classifies provider-native IDs without treating malformed or forged
 * Sedes-prefixed data as an ordinary provider message.
 */
export function inspectCodexSubmissionCorrelation(
  clientUserMessageId: string | null,
  scope: CodexSubmissionCorrelationScope,
): CodexSubmissionCorrelationInspection {
  let prefix: string;
  let domain: string;
  if (clientUserMessageId?.startsWith(SEDES_CLIENT_ID_PREFIX)) {
    prefix = CLIENT_ID_PREFIX;
    domain = PROVENANCE_DOMAIN;
  } else if (clientUserMessageId?.startsWith(LEGACY_CLIENT_ID_FAMILY_PREFIX)) {
    if (!clientUserMessageId.startsWith(LEGACY_CLIENT_ID_PREFIX)) {
      return { type: "malformed" };
    }
    prefix = LEGACY_CLIENT_ID_PREFIX;
    domain = LEGACY_PROVENANCE_DOMAIN;
  } else {
    return { type: "non_sedes" };
  }
  const fields = clientUserMessageId.slice(prefix.length).split(":");
  if (
    fields.length !== 3 ||
    !fields[0] ||
    !TAG_PATTERN.test(fields[1]!) ||
    !TAG_PATTERN.test(fields[2]!)
  ) {
    return { type: "malformed" };
  }
  const operationId = decodeOperationId(fields[0]);
  const receivedTag = decodeTag(fields[1]!);
  const reconciliationTag = decodeTag(fields[2]!);
  if (!operationId || !receivedTag || !reconciliationTag) {
    return { type: "malformed" };
  }
  for (const nativeThreadId of [
    scope.nativeThreadId,
    ...scope.correlationAncestorThreadIds,
  ]) {
    const expectedTag = hmacDigest(scope.toolProvenanceKey, domain, [
      ...correlationScopeFields({ ...scope, nativeThreadId }, operationId),
      fields[2]!,
    ]);
    if (
      receivedTag.byteLength === expectedTag.byteLength &&
      timingSafeEqual(receivedTag, expectedTag)
    ) {
      return {
        type: "authenticated",
        applicationOperationId: operationId,
      };
    }
  }
  return { type: "forged" };
}

function decodeTag(encoded: string): Buffer | undefined {
  const decoded = Buffer.from(encoded, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === encoded
    ? decoded
    : undefined;
}

function canonicalOperationId(operationId: string): string {
  if (
    operationId.length === 0 ||
    Buffer.byteLength(operationId, "utf8") > MAXIMUM_OPERATION_ID_BYTES
  ) {
    throw new Error("invalid Codex application operation identity");
  }
  return operationId;
}

function decodeOperationId(encoded: string): string | undefined {
  try {
    const operationId = Buffer.from(encoded, "base64url").toString("utf8");
    return Buffer.from(operationId, "utf8").toString("base64url") === encoded
      ? canonicalOperationId(operationId)
      : undefined;
  } catch {
    return undefined;
  }
}

function correlationScopeFields(
  scope: CodexSubmissionCorrelationScope,
  operationId: string,
): readonly string[] {
  return [
    scope.tenantId,
    scope.principalId,
    scope.backendInstanceId,
    scope.nativeThreadId,
    operationId,
  ];
}

function hmacTag(
  key: Uint8Array,
  domain: string,
  fields: readonly string[],
): string {
  return hmacDigest(key, domain, fields).toString("base64url");
}

function hmacDigest(
  key: Uint8Array,
  domain: string,
  fields: readonly string[],
): Buffer {
  const copiedKey = copyCodexSubmissionCorrelationKey(key);
  const hmac = createHmac("sha256", copiedKey);
  appendField(hmac, domain);
  for (const field of fields) appendField(hmac, field);
  return hmac.digest();
}

function appendField(hmac: ReturnType<typeof createHmac>, value: string): void {
  const encoded = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(encoded.byteLength);
  hmac.update(length);
  hmac.update(encoded);
}
