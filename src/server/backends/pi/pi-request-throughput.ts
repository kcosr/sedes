import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { RequestThroughput } from "../turn-throughput.js";

/** Capture at the provider boundary, before extensions or consumers delay delivery. */
class PiMeasuredStream extends AssistantMessageEventStream {
  readonly #result: Promise<AssistantMessage>;

  constructor(readonly source: AssistantMessageEventStream, record: (message: AssistantMessage) => void) {
    super();
    this.#result = source.result().then((message) => {
      record(message);
      return message;
    });
  }

  override result(): Promise<AssistantMessage> {
    return this.#result;
  }

  override async *[Symbol.asyncIterator]() {
    yield* this.source;
  }
}

/** Exact result identity prevents auxiliary requests from entering a main turn. */
export class PiRequestThroughput {
  readonly #results = new WeakMap<AssistantMessage, RequestThroughput>();

  constructor(readonly clock: () => number = () => performance.now()) {}

  wrap(stream: AgentSession["agent"]["streamFunction"]): AgentSession["agent"]["streamFunction"] {
    return async (model, context, options) => {
      const started = this.clock();
      const source = await stream(model, context, options);
      return new PiMeasuredStream(source, (message) => {
        const requestDurationMs = this.clock() - started;
        if (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") return;
        const outputTokens = message.usage?.output;
        if (!Number.isSafeInteger(outputTokens) || outputTokens < 0 ||
          !Number.isFinite(requestDurationMs) || requestDurationMs <= 0 || requestDurationMs > Number.MAX_SAFE_INTEGER) return;
        // Snapshot before an SDK extension can mutate this message in place.
        this.#results.set(message, { outputTokens, requestDurationMs });
      });
    };
  }

  take(message: AssistantMessage): RequestThroughput | undefined {
    const result = this.#results.get(message);
    this.#results.delete(message);
    return result;
  }
}
