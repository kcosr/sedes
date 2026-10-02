import type { ConversationBackendDriver, ConversationReadResult, ReadConversationInput } from "../../src/server/backends/contracts.js";

/** Finite snapshot assertions still close the production reader they exercise. */
export async function readConversationHistory(
  driver: Pick<ConversationBackendDriver, "openHistory">,
  input: ReadConversationInput,
): Promise<ConversationReadResult> {
  const reader = await driver.openHistory(input);
  try {
    const { snapshot } = await reader.readSnapshot({ signal: new AbortController().signal });
    return { snapshot, usage: await reader.usage() };
  } finally { await reader.close(); }
}
