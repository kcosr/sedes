export const DEFAULT_CONVERSATION_RETENTION_MILLISECONDS = 3_600_000;
export const MAXIMUM_CONVERSATION_RETENTION_MILLISECONDS = 2_147_483_647;

const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;

export function assertConversationRetentionMilliseconds(
  value: number,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_CONVERSATION_RETENTION_MILLISECONDS
  ) {
    throw new Error("conversation_retention_milliseconds_invalid");
  }
}

export function parseConversationRetentionMilliseconds(
  value: string | undefined,
): number {
  if (value === undefined) {
    return DEFAULT_CONVERSATION_RETENTION_MILLISECONDS;
  }
  if (!CANONICAL_UNSIGNED_DECIMAL.test(value)) {
    throw new Error(
      "SEDES_CONVERSATION_RETENTION_MILLISECONDS must be a canonical integer from 0 through 2147483647.",
    );
  }
  const parsed = Number(value);
  try {
    assertConversationRetentionMilliseconds(parsed);
  } catch {
    throw new Error(
      "SEDES_CONVERSATION_RETENTION_MILLISECONDS must be a canonical integer from 0 through 2147483647.",
    );
  }
  return parsed;
}
