import { useMemo } from "react";
import type { DirectInputRequest, DirectInputReceipt, DirectInputReceiptLookup } from "../../../shared/protocol/thread-input.js";
import type { ThreadClientState, ThreadClientStore } from "../../stores/ThreadClientStore.js";

export type PageResponseRequest = Omit<DirectInputRequest, "origin" | "pageResponse" | "runningPolicy"> & {
  readonly pageResponse: { readonly pageId: string; readonly revision: number };
  readonly runningPolicy: { readonly mode: "queue" };
};

export interface PageResponseServices {
  readonly threadId: string;
  readonly unavailableReason?: string;
  readonly submit: (request: PageResponseRequest, signal?: AbortSignal) => Promise<DirectInputReceipt>;
  readonly readReceipt: (mutationId: string, signal?: AbortSignal) => Promise<DirectInputReceiptLookup>;
}

type ResponseThreadState = Pick<ThreadClientState, "snapshot" | "authoritative" | "connection">;

export function pageResponseUnavailableReason({ snapshot, authoritative, connection }: ResponseThreadState): string | undefined {
  if (!snapshot || !authoritative || connection !== "connected") return "Wait for the thread to reconnect.";
  if (snapshot.thread.backingState !== "bound") return "This thread is not bound to a conversation.";
  if (snapshot.recovery) return "Reconcile the uncertain input before sending another response.";
  const modes = snapshot.capabilities.deliveryModes.filter(({ id }) => id === "submit" || id === "queue");
  if (!modes.some(({ available }) => available))
    return modes.find(({ unavailableReason }) => unavailableReason)?.unavailableReason?.text ?? "Sending is unavailable for this thread.";
  return undefined;
}

export function usePageResponseServices(store: ThreadClientStore, state: ResponseThreadState): PageResponseServices {
  const unavailableReason = pageResponseUnavailableReason(state);
  return useMemo(() => ({
    threadId: store.threadId,
    unavailableReason,
    submit: (request: PageResponseRequest, signal?: AbortSignal) => store.submitPageResponse(request, signal),
    readReceipt: (mutationId: string, signal?: AbortSignal) => store.readPageResponseReceipt(mutationId, signal),
  }), [store, unavailableReason]);
}
