/** Keep callback delivery ahead of captures while isolating all obligations. */
export async function performCompletionFollowUp(input: {
  readonly deliverCallbacks: () => void | Promise<unknown>;
  readonly publishCompletion: () => void | Promise<unknown>;
  readonly recoverThread: () => void | Promise<unknown>;
  readonly wakeThread: () => void | Promise<unknown>;
}): Promise<void> {
  const failures: unknown[] = [];
  for (const obligation of [
    input.deliverCallbacks,
    input.publishCompletion,
    input.recoverThread,
    input.wakeThread,
  ]) {
    try {
      await obligation();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Authoritative completion follow-up did not finish cleanly.",
    );
  }
}
