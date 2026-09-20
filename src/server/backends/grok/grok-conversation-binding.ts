export interface GrokConversationBindingDetail {
  readonly version: 1;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly canonicalWorkspacePath: string;
  readonly nativeNamespaceKey: string;
}

const KEYS = [
  "backendInstanceId",
  "canonicalWorkspacePath",
  "connectionProfileId",
  "executionEnvironmentId",
  "nativeNamespaceKey",
  "principalId",
  "sessionId",
  "tenantId",
  "version",
] as const;

export function serializeGrokConversationBindingDetail(
  input: GrokConversationBindingDetail,
): string {
  const detail = validate(input);
  const encoded = JSON.stringify(detail);
  if (Buffer.byteLength(encoded) > 16_384) invalid();
  return encoded;
}

export function parseGrokConversationBindingDetail(
  encoded: string,
): GrokConversationBindingDetail {
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    Buffer.byteLength(encoded) > 16_384 ||
    encoded.includes("\0")
  ) {
    invalid();
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    invalid();
  }
  return validate(value);
}

function validate(value: unknown): GrokConversationBindingDetail {
  if (!isRecord(value)) invalid();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== KEYS.length ||
    actualKeys.some((key, index) => key !== KEYS[index]) ||
    value.version !== 1 ||
    !bounded(value.sessionId, 1_024) ||
    !bounded(value.tenantId, 1_024) ||
    !bounded(value.principalId, 1_024) ||
    !bounded(value.backendInstanceId, 1_024) ||
    !bounded(value.connectionProfileId, 1_024) ||
    !bounded(value.executionEnvironmentId, 1_024) ||
    !bounded(value.canonicalWorkspacePath, 4_096) ||
    !bounded(value.nativeNamespaceKey, 1_024)
  ) {
    invalid();
  }
  return Object.freeze({
    version: 1,
    sessionId: value.sessionId,
    tenantId: value.tenantId,
    principalId: value.principalId,
    backendInstanceId: value.backendInstanceId,
    connectionProfileId: value.connectionProfileId,
    executionEnvironmentId: value.executionEnvironmentId,
    canonicalWorkspacePath: value.canonicalWorkspacePath,
    nativeNamespaceKey: value.nativeNamespaceKey,
  });
}

function bounded(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximumBytes &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(): never {
  throw new Error("grok_conversation_binding_invalid");
}
