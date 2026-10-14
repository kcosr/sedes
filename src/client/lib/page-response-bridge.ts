import { PAGE_RESPONSE_MAX_BYTES } from "../../shared/protocol/pages.js";

export const PAGE_RESPONSE_CAPTURE_TIMEOUT_MS = 5_000;

const responseErrors: Readonly<Record<string, string>> = {
  not_registered: "This page has not registered a response.",
  producer_failed: "The page could not prepare its response.",
  invalid_response: "The page must return nonblank, synchronous text.",
  response_too_large: "The page response exceeds 65,536 UTF-8 bytes.",
};

/** Bound to one wrapper document. Only the host's explicit Send action calls
 * capture; messages from the document can announce readiness or answer it. */
export class PageResponseBridge {
  readonly #source: Window;
  readonly #channel: string;
  readonly #onReady: (ready: boolean) => void;
  #ready = false;
  #disposed = false;
  #pending:
    | {
        requestId: string;
        resolve: (text: string) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  constructor(options: {
    source: Window;
    channel: string;
    onReady: (ready: boolean) => void;
  }) {
    this.#source = options.source;
    this.#channel = options.channel;
    this.#onReady = options.onReady;
  }

  handleMessage(event: Pick<MessageEvent, "source" | "data">): void {
    if (this.#disposed || event.source !== this.#source) return;
    const data: unknown = event.data;
    if (!data || typeof data !== "object" || !("channel" in data) ||
        data.channel !== this.#channel || !("type" in data)) return;
    if (data.type === "sedes:page-error") {
      this.dispose();
      return;
    }
    if (data.type === "sedes:page-submit-ready") {
      if (!this.#ready) {
        this.#ready = true;
        this.#onReady(true);
      }
      return;
    }
    const pending = this.#pending;
    if (data.type !== "sedes:page-submit-response" || !pending ||
        !("requestId" in data) || data.requestId !== pending.requestId) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    if ("error" in data) {
      pending.reject(new Error(typeof data.error === "string"
        ? responseErrors[data.error] ?? "The page could not prepare its response."
        : "The page could not prepare its response."));
    } else if (!("text" in data) || typeof data.text !== "string" || !data.text.trim()) {
      pending.reject(new Error(responseErrors.invalid_response));
    } else if (data.text.length > PAGE_RESPONSE_MAX_BYTES ||
        new TextEncoder().encode(data.text).byteLength > PAGE_RESPONSE_MAX_BYTES) {
      pending.reject(new Error(responseErrors.response_too_large));
    } else {
      pending.resolve(data.text);
    }
  }

  capture(): Promise<string> {
    if (this.#disposed || !this.#ready)
      return Promise.reject(new Error("This page is not ready to send a response."));
    if (this.#pending)
      return Promise.reject(new Error("A page response is already being captured."));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.#pending = {
        requestId,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#pending = undefined;
          reject(new Error("The page did not respond. Try again."));
        }, PAGE_RESPONSE_CAPTURE_TIMEOUT_MS),
      };
      try {
        this.#source.postMessage({
          type: "sedes:page-submit-request",
          channel: this.#channel,
          requestId,
        }, "*");
      } catch {
        clearTimeout(this.#pending?.timer);
        this.#pending = undefined;
        reject(new Error("The page could not prepare its response."));
      }
    });
  }

  /** Call before changing the frame's document, channel, or selected revision. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#ready) {
      this.#ready = false;
      this.#onReady(false);
    }
    if (this.#pending) {
      clearTimeout(this.#pending.timer);
      this.#pending.reject(new Error("Page changed before its response was captured."));
      this.#pending = undefined;
    }
  }
}
