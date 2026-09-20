/**
 * Ordinary operational failures retain their underlying causes. Bound both
 * traversal and output; never inspect arbitrary exception properties/payloads.
 */
export function reportBackgroundError(label: string) {
  return (error: unknown): void => {
    const pending: unknown[] = [error];
    const seen = new Set<unknown>();
    let written = 0;
    while (pending.length > 0 && written < 16) {
      const current = pending.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      process.stderr.write(`${boundedLine(label)} ${written++ === 0 ? "failed" : "cause"}: ${errorMessage(current)}\n`);
      if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
      if (current instanceof AggregateError) {
        for (const cause of current.errors.slice(0, Math.max(0, 16 - written - pending.length))) pending.push(cause);
      }
    }
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return boundedLine(error.message);
  if (typeof error === "string" && error.length > 0) return boundedLine(error);
  return "unknown error";
}

function boundedLine(value: string): string {
  return value.slice(0, 2048).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}
