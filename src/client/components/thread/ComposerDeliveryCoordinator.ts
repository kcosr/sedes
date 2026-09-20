import type { NormalizedDraft } from "../../../shared/index.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";

export interface RetainedComposerRollbackRestoration {
  readonly operationId: string;
  readonly before: NormalizedDraft;
  readonly after: NormalizedDraft;
}

export interface RetainedComposerDeliveryState {
  readonly draft: NormalizedDraft;
  /** Exact server draft base against which the retained visible draft was edited. */
  readonly authoritativeBase: NormalizedDraft;
  /** Exact local mutation echo expected while an HTTP response is still pending. */
  readonly expectedEcho?: NormalizedDraft;
  readonly dirty: boolean;
  readonly rollbackRestorations: readonly RetainedComposerRollbackRestoration[];
}

/**
 * Composer handoff state has the same lifetime as its retained thread store.
 * It is intentionally neither normalized authority nor durable browser state.
 */
const retainedByThreadStore = new WeakMap<
  ThreadClientStore,
  RetainedComposerDeliveryState
>();

export function getRetainedComposerDeliveryState(
  store: ThreadClientStore,
): RetainedComposerDeliveryState | undefined {
  return retainedByThreadStore.get(store);
}

export function setRetainedComposerDeliveryState(
  store: ThreadClientStore,
  state: RetainedComposerDeliveryState,
): void {
  retainedByThreadStore.set(store, state);
}

export function clearRetainedComposerDeliveryState(
  store: ThreadClientStore,
): void {
  retainedByThreadStore.delete(store);
}
