import { createHmac, timingSafeEqual } from "node:crypto";

const SEDES_PROMPT_ID_PREFIX = "sedes-grok:";
const PROMPT_ID_PREFIX = `${SEDES_PROMPT_ID_PREFIX}v1:`;
const PROVENANCE_DOMAIN = "sedes.grok-submission.provenance.v1";
const RECONCILIATION_DOMAIN = "sedes.grok-submission.reconciliation.v1";
const LEGACY_PROMPT_ID_FAMILY_PREFIX = "harness-grok:";
const LEGACY_PROMPT_ID_PREFIX = `${LEGACY_PROMPT_ID_FAMILY_PREFIX}v1:`;
const LEGACY_PROVENANCE_DOMAIN = "harness.grok-submission.provenance.v1";
const LEGACY_RECONCILIATION_DOMAIN =
  "harness.grok-submission.reconciliation.v1";
const TAG_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAXIMUM_OPERATION_ID_BYTES = 160;
const MAXIMUM_RECONCILIATION_TOKEN_BYTES = 4_096;
const MAXIMUM_SCOPE_FIELD_BYTES = 4_096;
const MAXIMUM_PROMPT_ID_BYTES = 1_024;
export interface GrokSubmissionCorrelationScope {
  readonly installationKey: Uint8Array;
  readonly tenantId: string;
  readonly principalId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly nativeNamespaceKey: string;
  readonly canonicalWorkspacePath: string;
  readonly sessionId: string;
}

export type GrokSubmissionCorrelationInspection =
  | { readonly type: "non_sedes" }
  | { readonly type: "malformed" }
  | { readonly type: "forged" }
  | {
      readonly type: "authenticated";
      readonly applicationOperationId: string;
    };

export function copyGrokSubmissionCorrelationKey(key: Uint8Array): Uint8Array {
  if (key.byteLength !== 32) {
    throw new Error("grok_submission_correlation_key_invalid");
  }
  return new Uint8Array(key);
}

/**
 * Creates the one provider-native prompt identity admitted for Sedes
 * submissions. The reconciliation token is authenticated but not disclosed.
 */
export function grokSubmissionPromptId(
  input: GrokSubmissionCorrelationScope & {
    readonly applicationOperationId: string;
    readonly reconciliationToken: string;
  },
): string {
  return submissionPromptId(input, {
    prefix: PROMPT_ID_PREFIX,
    provenanceDomain: PROVENANCE_DOMAIN,
    reconciliationDomain: RECONCILIATION_DOMAIN,
  });
}

/**
 * Exact prompt identities admitted only while reading or reconciling durable
 * provider history. The first candidate is the current identity; the second is
 * the pre-rename identity. Callers must never use this compatibility surface to
 * submit a new prompt.
 */
export function grokSubmissionPromptIdReadCandidates(
  input: GrokSubmissionCorrelationScope & {
    readonly applicationOperationId: string;
    readonly reconciliationToken: string;
  },
): readonly [current: string, legacy: string] {
  return Object.freeze([
    grokSubmissionPromptId(input),
    submissionPromptId(input, {
      prefix: LEGACY_PROMPT_ID_PREFIX,
      provenanceDomain: LEGACY_PROVENANCE_DOMAIN,
      reconciliationDomain: LEGACY_RECONCILIATION_DOMAIN,
    }),
  ]);
}

function submissionPromptId(
  input: GrokSubmissionCorrelationScope & {
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
  const reconciliationToken = canonicalReconciliationToken(
    input.reconciliationToken,
  );
  const scopeFields = correlationScopeFields(input, operationId);
  const reconciliationTag = hmacTag(
    input.installationKey,
    family.reconciliationDomain,
    [...scopeFields, reconciliationToken],
  );
  const provenanceTag = hmacTag(
    input.installationKey,
    family.provenanceDomain,
    [...scopeFields, reconciliationTag],
  );
  const encodedOperationId = Buffer.from(operationId, "utf8").toString(
    "base64url",
  );
  const promptId = `${family.prefix}${encodedOperationId}:${provenanceTag}:${reconciliationTag}`;
  if (Buffer.byteLength(promptId, "utf8") > MAXIMUM_PROMPT_ID_BYTES) {
    throw new Error("grok_submission_prompt_id_invalid");
  }
  return promptId;
}

/**
 * Authenticates application ownership from durable native prompt evidence.
 * The reconciliation token is intentionally unnecessary for read projection;
 * exact reconciliation recomputes the complete prompt identity instead.
 */
export function inspectGrokSubmissionPromptId(
  promptId: string,
  scope?: GrokSubmissionCorrelationScope,
): GrokSubmissionCorrelationInspection {
  let prefix: string;
  let provenanceDomain: string;
  if (promptId.startsWith(SEDES_PROMPT_ID_PREFIX)) {
    if (!promptId.startsWith(PROMPT_ID_PREFIX)) return { type: "malformed" };
    prefix = PROMPT_ID_PREFIX;
    provenanceDomain = PROVENANCE_DOMAIN;
  } else if (promptId.startsWith(LEGACY_PROMPT_ID_FAMILY_PREFIX)) {
    if (!promptId.startsWith(LEGACY_PROMPT_ID_PREFIX)) {
      return { type: "malformed" };
    }
    prefix = LEGACY_PROMPT_ID_PREFIX;
    provenanceDomain = LEGACY_PROVENANCE_DOMAIN;
  } else {
    return { type: "non_sedes" };
  }
  if (Buffer.byteLength(promptId, "utf8") > MAXIMUM_PROMPT_ID_BYTES) {
    return { type: "malformed" };
  }
  const fields = promptId.slice(prefix.length).split(":");
  if (
    fields.length !== 3 ||
    !fields[0] ||
    !TAG_PATTERN.test(fields[1]!) ||
    !TAG_PATTERN.test(fields[2]!)
  ) {
    return { type: "malformed" };
  }
  const operationId = decodeOperationId(fields[0]);
  const provenanceTag = decodeTag(fields[1]!);
  const reconciliationTag = decodeTag(fields[2]!);
  if (!operationId || !provenanceTag || !reconciliationTag) {
    return { type: "malformed" };
  }
  if (!scope) return { type: "forged" };
  let expected: Buffer;
  try {
    expected = hmacDigest(scope.installationKey, provenanceDomain, [
      ...correlationScopeFields(scope, operationId),
      fields[2]!,
    ]);
  } catch {
    return { type: "forged" };
  }
  return provenanceTag.byteLength === expected.byteLength &&
    timingSafeEqual(provenanceTag, expected)
    ? { type: "authenticated", applicationOperationId: operationId }
    : { type: "forged" };
}

/** Exact expected-operation/token check used by submission reconciliation. */
export function matchesGrokSubmissionPromptId(
  promptId: string,
  input: GrokSubmissionCorrelationScope & {
    readonly applicationOperationId: string;
    readonly reconciliationToken: string;
  },
): boolean {
  let expected: readonly string[];
  try {
    expected = grokSubmissionPromptIdReadCandidates(input);
  } catch {
    return false;
  }
  const receivedBytes = Buffer.from(promptId, "utf8");
  return expected.some((candidate) => {
    const expectedBytes = Buffer.from(candidate, "utf8");
    return (
      receivedBytes.byteLength === expectedBytes.byteLength &&
      timingSafeEqual(receivedBytes, expectedBytes)
    );
  });
}

function canonicalOperationId(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_OPERATION_ID_BYTES
  ) {
    throw new Error("grok_submission_operation_id_invalid");
  }
  return value;
}

function canonicalReconciliationToken(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_RECONCILIATION_TOKEN_BYTES
  ) {
    throw new Error("grok_submission_reconciliation_token_invalid");
  }
  return value;
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

function decodeTag(encoded: string): Buffer | undefined {
  const decoded = Buffer.from(encoded, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === encoded
    ? decoded
    : undefined;
}

function correlationScopeFields(
  scope: GrokSubmissionCorrelationScope,
  operationId: string,
): readonly string[] {
  return [
    canonicalScopeField(scope.tenantId),
    canonicalScopeField(scope.principalId),
    canonicalScopeField(scope.backendInstanceId),
    canonicalScopeField(scope.connectionProfileId),
    canonicalScopeField(scope.executionEnvironmentId),
    canonicalScopeField(scope.nativeNamespaceKey),
    canonicalScopeField(scope.canonicalWorkspacePath),
    canonicalScopeField(scope.sessionId),
    operationId,
  ];
}

function canonicalScopeField(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_SCOPE_FIELD_BYTES
  ) {
    throw new Error("grok_submission_correlation_scope_invalid");
  }
  return value;
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
  const hmac = createHmac("sha256", copyGrokSubmissionCorrelationKey(key));
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
