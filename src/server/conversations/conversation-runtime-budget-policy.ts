export const DEFAULT_CONVERSATION_RUNTIME_BUDGET = 32;
export const MINIMUM_CONVERSATION_RUNTIME_BUDGET = 2;
export const MAXIMUM_CONVERSATION_RUNTIME_BUDGET = 64;

const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;

export function assertConversationRuntimeBudget(
  value: number,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    value < MINIMUM_CONVERSATION_RUNTIME_BUDGET ||
    value > MAXIMUM_CONVERSATION_RUNTIME_BUDGET
  ) {
    throw new Error("conversation_runtime_budget_invalid");
  }
}

export function parseConversationRuntimeBudget(
  value: string | undefined,
): number {
  if (value === undefined) return DEFAULT_CONVERSATION_RUNTIME_BUDGET;
  if (!CANONICAL_UNSIGNED_DECIMAL.test(value)) {
    throw new Error(
      "SEDES_CONVERSATION_RUNTIME_BUDGET must be a canonical integer from 2 through 64.",
    );
  }
  const parsed = Number(value);
  try {
    assertConversationRuntimeBudget(parsed);
  } catch {
    throw new Error(
      "SEDES_CONVERSATION_RUNTIME_BUDGET must be a canonical integer from 2 through 64.",
    );
  }
  return parsed;
}
