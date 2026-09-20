import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/** Keep cancellation truthful before Pi publishes and persists the response. */
class PiCancellationStream extends AssistantMessageEventStream {
  readonly #result: Promise<AssistantMessage>;

  constructor(readonly source: AssistantMessageEventStream, signal?: AbortSignal) {
    super();
    // Capture cancellation when the native result arrives, not when a later
    // consumer reads it. An abort after a genuine failure must not rewrite it.
    this.#result = source.result().then((message) =>
      message.stopReason === "error" && signal?.aborted
        ? { ...message, stopReason: "aborted" }
        : message,
    );
  }

  override result(): Promise<AssistantMessage> {
    return this.#result;
  }

  override async *[Symbol.asyncIterator]() {
    for await (const event of this.source) {
      if (event.type === "error") {
        const message = await this.#result;
        if (message.stopReason === "aborted") {
          yield { ...event, reason: "aborted" as const, error: message };
          continue;
        }
      }
      yield event;
    }
  }
}

export function piCancellationStream(
  stream: AgentSession["agent"]["streamFunction"],
): AgentSession["agent"]["streamFunction"] {
  return async (model, context, options) =>
    new PiCancellationStream(await stream(model, context, options), options?.signal);
}
