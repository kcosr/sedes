import { useCallback, useEffect, useRef } from "react";

/**
 * Reveal requests: "show Tasks, switch to a view that contains this task,
 * and expand it" (the transcript task card's Open task, a composer chip).
 *
 * Integration adapter: these names and semantics mirror the reveal API of
 * the version 2 store in `app/tasks-panel-store.ts` (track H), whose
 * `revealTask` also opens Tasks. When integrating, import `useTaskReveal`
 * (and `revealTask` in tests) from the store and delete this file.
 */

export interface TasksRevealRequest {
  readonly taskId: string;
  /** Distinguishes repeated reveals of one task. */
  readonly sequence: number;
}

let revealSequence = 0;
let pendingReveal: TasksRevealRequest | undefined;
const revealListeners = new Set<(request: TasksRevealRequest) => void>();

/**
 * The request stays pending until the content consumes it, so content that
 * mounts because of this reveal still receives it.
 */
export function revealTask(taskId: string): void {
  revealSequence += 1;
  const request: TasksRevealRequest = { taskId, sequence: revealSequence };
  pendingReveal = request;
  for (const listener of [...revealListeners]) listener(request);
}

function subscribeReveal(
  listener: (request: TasksRevealRequest) => void,
): () => void {
  revealListeners.add(listener);
  return () => {
    revealListeners.delete(listener);
  };
}

function consumeReveal(sequence: number): void {
  if (pendingReveal?.sequence === sequence) pendingReveal = undefined;
}

/**
 * For the Tasks content: calls `onReveal` with the pending request on mount
 * and with every later one, consuming each after the call.
 */
export function useTaskReveal(
  onReveal: (request: TasksRevealRequest) => void,
): void {
  const handler = useRef(onReveal);
  handler.current = onReveal;
  const handle = useCallback((request: TasksRevealRequest) => {
    consumeReveal(request.sequence);
    handler.current(request);
  }, []);
  useEffect(() => {
    if (pendingReveal) handle(pendingReveal);
    return subscribeReveal(handle);
  }, [handle]);
}
