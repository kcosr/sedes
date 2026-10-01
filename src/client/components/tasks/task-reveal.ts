/**
 * Reveal requests: "open Tasks, switch to a view that contains this task,
 * and expand it" (the transcript task card's Open task, a composer chip).
 *
 * Integration shim: `revealTask` and `subscribeReveal` belong to the
 * viewer-local `app/tasks-panel-store.ts` (track H), whose `revealTask` also
 * opens Tasks. The content consumes them through this module; re-export the
 * store's pair from here (or import the store directly) when integrating.
 *
 * A reveal requested while no content is subscribed (Tasks was closed and
 * is opening) stays pending and is delivered to the next subscriber, so
 * the content that mounts still expands the task.
 */

type RevealListener = (taskId: string) => void;

const listeners = new Set<RevealListener>();
let pending: string | undefined;

export function revealTask(taskId: string): void {
  if (listeners.size === 0) {
    pending = taskId;
    return;
  }
  for (const listener of [...listeners]) listener(taskId);
}

export function subscribeReveal(listener: RevealListener): () => void {
  listeners.add(listener);
  if (pending !== undefined) {
    const taskId = pending;
    pending = undefined;
    listener(taskId);
  }
  return () => {
    listeners.delete(listener);
  };
}
