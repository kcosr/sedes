import {
  BackendError,
  type ConversationBinding,
  type ConversationHandle,
  type ConversationHistoryReader,
} from "../backends/contracts.js";

/**
 * Feeds passive native history into the ordinary normalized projector. It has
 * no execution owner, live projection, interactions, or mutation authority.
 */
export function historyConversationHandle(
  binding: ConversationBinding,
  reader: ConversationHistoryReader,
): ConversationHandle {
  const listeners = new Set<Parameters<ConversationHandle["subscribe"]>[0]>();
  const read = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (!signal?.aborted && error instanceof BackendError && error.retryable) {
        // Retrying a failed immutable cut must acquire a fresh reader. In
        // particular, a provider generation or transport cannot be repaired
        // inside the reader that captured it. Caller cancellation alone does
        // not invalidate the retained cut.
        for (const listener of listeners) {
          listener({ type: "resnapshot_required", reason: "provider_handle_closed" });
        }
      }
      throw error;
    }
  };
  const refuse = async (): Promise<never> => {
    throw new BackendError({
      category: "invalid_state",
      retryable: false,
      crossedSubmissionBoundary: false,
      backendCode: "conversation_history_read_only",
      safeMessage: "Archived conversation history is read-only. Restore the thread before starting work.",
    });
  };
  return {
    binding,
    automaticEviction: "client_detach",
    async establishProjection(input) {
      input.signal.throwIfAborted();
      const projection = await read(() => reader.readSnapshot(input), input.signal);
      input.signal.throwIfAborted();
      return { ...projection, handleSequence: 0, subscribeFromNext: () => () => {} };
    },
    history: (input) => read(() => reader.history(input), input.signal),
    locateTurn: (input) => read(() => reader.locateTurn(input), input.signal),
    async backendCapabilities() {
      const capabilities = await read(() => reader.backendCapabilities());
      return {
        ...capabilities,
        actions: [],
        deliveryModes: [],
        steerTarget: null,
        composerAttachments: { fileStaging: false, nativeImage: false },
        nonblockingQuestions: false,
        interactionKinds: [],
        branching: { availability: "unavailable", reason: { text: "Archived threads cannot be forked." } },
      };
    },
    usage: () => read(() => reader.usage()),
    captureSubmissionRetryAnchor: refuse,
    submit: refuse,
    steer: refuse,
    interrupt: refuse,
    reconcileInterrupt: refuse,
    perform: refuse,
    reconcileAction: refuse,
    respond: refuse,
    reconcileInteractionResponse: refuse,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async close() {
      listeners.clear();
      await reader.close();
    },
  };
}
