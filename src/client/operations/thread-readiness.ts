import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import {
  subscribeBlockingOperation,
  type OperationContext,
} from "./blocking-operation.js";

let registry: ThreadStoreRegistry | undefined;
export function setOperationThreadRegistry(
  value: ThreadStoreRegistry | undefined,
): void {
  registry = value;
}

/** Preload a created destination without navigating away from the source. */
export async function waitForOperationThreadReady(
  threadId: string,
  context: OperationContext,
): Promise<void> {
  if (!context.isActive()) return;
  const owner = registry;
  if (!owner) throw new Error("The thread connection is no longer available.");
  const store = owner.retain(threadId);
  try {
    await new Promise<void>((resolve, reject) => {
      let unsubscribeStore = () => {};
      let unsubscribeOperation = () => {};
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribeStore();
        unsubscribeOperation();
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (!context.isActive()) {
          finish();
          return;
        }
        const state = store.getSnapshot();
        if (state.status === "error")
          finish(
            new Error(state.error ?? "Could not load the created thread."),
          );
        else if (state.status === "ready" && state.snapshot) finish();
      };
      const timeout = setTimeout(
        () =>
          finish(
            new Error(
              "The thread was created, but loading it took too long. Retry to open it.",
            ),
          ),
        30_000,
      );
      unsubscribeStore = store.subscribe(check);
      unsubscribeOperation = subscribeBlockingOperation(check);
      check();
    });
  } finally {
    owner.release(threadId);
  }
}
