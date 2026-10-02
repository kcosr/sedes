import {
  BackendError,
  type ConversationBinding,
  type ConversationHandle,
  type ConversationHistoryReader,
} from "../backends/contracts.js";

/**
 * Feeds passive native history into the ordinary normalized projector. It has
 * no execution owner, subscriptions, interactions, or mutation authority.
 */
export function historyConversationHandle(
  binding: ConversationBinding,
  reader: ConversationHistoryReader,
): ConversationHandle {
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
      const projection = await reader.readSnapshot(input);
      input.signal.throwIfAborted();
      return { ...projection, handleSequence: 0, subscribeFromNext: () => () => {} };
    },
    history: (input) => reader.history(input),
    locateTurn: (input) => reader.locateTurn(input),
    async backendCapabilities() {
      const capabilities = await reader.backendCapabilities();
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
    usage: () => reader.usage(),
    captureSubmissionRetryAnchor: refuse,
    submit: refuse,
    steer: refuse,
    interrupt: refuse,
    reconcileInterrupt: refuse,
    perform: refuse,
    reconcileAction: refuse,
    respond: refuse,
    reconcileInteractionResponse: refuse,
    subscribe: () => () => {},
    close: () => reader.close(),
  };
}
