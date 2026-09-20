interface PendingActivityDetailExpansion {
  readonly threadId: string;
  readonly firstItemId: string;
  readonly requestedAt: number;
}

const pendingExpansionLifetimeMilliseconds = 5 * 60_000;
let pendingExpansion: PendingActivityDetailExpansion | undefined;

export function requestActivityDetailExpansion(
  threadId: string,
  firstItemId: string,
): void {
  pendingExpansion = { threadId, firstItemId, requestedAt: Date.now() };
}

export function hasPendingActivityDetailExpansion(
  threadId: string,
  firstItemId: string,
): boolean {
  if (
    pendingExpansion &&
    Date.now() - pendingExpansion.requestedAt >
      pendingExpansionLifetimeMilliseconds
  ) {
    pendingExpansion = undefined;
  }
  return (
    pendingExpansion !== undefined &&
    pendingExpansion.threadId === threadId &&
    pendingExpansion.firstItemId === firstItemId
  );
}

export function consumeActivityDetailExpansion(
  threadId: string,
  firstItemId: string,
): boolean {
  if (!hasPendingActivityDetailExpansion(threadId, firstItemId)) return false;
  pendingExpansion = undefined;
  return true;
}

export function clearPendingActivityDetailExpansion(): void {
  pendingExpansion = undefined;
}
