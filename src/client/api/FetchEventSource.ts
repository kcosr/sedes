import type { SedesServerEndpoint } from "../app/server-endpoint.js";
import { authenticatedFetch } from "../authentication/auth-transport.js";
import { MAXIMUM_SSE_EVENT_BYTES } from "../../shared/protocol/payload.js";

/** The EventSource subset used by normalized stream transports. */
export interface ClientEventSource {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
}

// UTF-8 uses at least one byte per code point, so this conservative character
// bound admits every server-valid frame without counting encoded bytes again.
const MAX_EVENT_CHARACTERS = MAXIMUM_SSE_EVENT_BYTES;
const DECODE_SLICE_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES_PER_TASK = 1024 * 1024;
const MAX_PARSE_MILLISECONDS_PER_TASK = 8;

/** SSE over fetch, allowing endpoint-scoped Authorization headers. */
export class FetchEventSource extends EventTarget implements ClientEventSource {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly #endpoint: SedesServerEndpoint;
  readonly #path: string;
  #abort = new AbortController();
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryMilliseconds = 1000;
  #lastEventId = "";

  constructor(endpoint: SedesServerEndpoint, path: string) {
    super();
    this.#endpoint = endpoint;
    this.#path = path;
    void this.#connect();
  }

  close(): void {
    this.readyState = 2;
    this.#abort.abort();
    clearTimeout(this.#retryTimer);
  }

  async #connect(): Promise<void> {
    if (this.readyState === 2) return;
    const headers = new Headers({ Accept: "text/event-stream" });
    if (this.#lastEventId) headers.set("Last-Event-ID", this.#lastEventId);
    let terminal = false;
    try {
      const response = await authenticatedFetch(this.#endpoint, this.#path, {
        headers,
        signal: this.#abort.signal,
        redirect: "error",
        cache: "no-store",
      });
      if (this.#abort.signal.aborted) {
        await response.body?.cancel();
        return;
      }
      terminal = response.status === 204 || response.status === 401 || response.status === 403;
      if (!response.ok || response.status === 204 || !response.body ||
          response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
        await response.body?.cancel();
        throw new Error("Event stream response is unavailable.");
      }
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      if (this.#abort.signal.aborted) {
        await response.body.cancel();
        return;
      }
      await this.#read(response.body);
    } catch {
      // Transport errors are deliberately opaque; credentials never enter errors.
    }
    if (this.#abort.signal.aborted) return;
    this.readyState = terminal ? 2 : 0;
    this.onerror?.(new Event("error"));
    if (this.readyState !== 2) {
      this.#retryTimer = setTimeout(() => void this.#connect(), this.#retryMilliseconds);
    }
  }

  async #read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let line = "";
    let skipLf = false;
    let eventType = "";
    let pendingEventId = this.#lastEventId;
    let data: string[] = [];
    let eventCharacters = 0;
    let bufferedBytes = 0;
    let parseMilliseconds = 0;
    const lineEnding = /[\r\n]/g;
    const supplementaryCharacter = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
    // One coalesced task per parsing burst both replenishes the budget after
    // network waits and supplies explicit replay yields, without timer nesting.
    const taskChannel = new MessageChannel();
    let taskPending = false;
    let resumeTask: (() => void) | undefined;
    const finishTask = () => {
      taskPending = false;
      bufferedBytes = 0;
      parseMilliseconds = 0;
      const resume = resumeTask;
      resumeTask = undefined;
      resume?.();
    };
    taskChannel.port1.onmessage = finishTask;
    const scheduleTask = () => {
      if (!taskPending && !this.#abort.signal.aborted) {
        taskPending = true;
        taskChannel.port2.postMessage(null);
      }
    };
    const yieldToTask = (): Promise<void> => new Promise((resolve) => {
      resumeTask = resolve;
      scheduleTask();
      if (this.#abort.signal.aborted) finishTask();
    });
    this.#abort.signal.addEventListener("abort", finishTask, { once: true });
    const consumeLine = () => {
      if (line === "") {
        this.#lastEventId = pendingEventId;
        if (data.length) {
          this.dispatchEvent(new MessageEvent(eventType || "message", {
            data: data.join("\n"),
            lastEventId: this.#lastEventId,
          }));
        }
        eventType = "";
        data = [];
        eventCharacters = 0;
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        switch (field) {
          case "data": data.push(value); break;
          case "event": eventType = value; break;
          case "id": if (!value.includes("\0")) pendingEventId = value; break;
          case "retry":
            if (/^\d+$/.test(value)) {
              this.#retryMilliseconds = Math.min(30_000, Math.max(250, Number(value)));
            }
            break;
        }
      }
      line = "";
    };
    const consumeText = async (text: string): Promise<void> => {
      let sliceStartedAt = performance.now();
      let position = 0;
      while (position < text.length) {
        if (this.#abort.signal.aborted) return;
        if (skipLf) {
          skipLf = false;
          if (text[position] === "\n") {
            position += 1;
            continue;
          }
        }
        lineEnding.lastIndex = position;
        const ending = lineEnding.exec(text);
        const end = ending?.index ?? text.length;
        const fragment = text.slice(position, end);
        let characters = fragment.length;
        // Preserve the original code-point limit without allocating one string
        // per character. TextDecoder never splits a surrogate pair across reads.
        supplementaryCharacter.lastIndex = 0;
        while (supplementaryCharacter.exec(fragment)) characters -= 1;
        eventCharacters += characters + (ending ? 1 : 0);
        if (eventCharacters > MAX_EVENT_CHARACTERS) throw new Error("Event stream frame too large.");
        line += fragment;
        if (ending) {
          consumeLine();
          skipLf = ending[0] === "\r";
        }
        position = ending ? end + 1 : end;
        if (this.#abort.signal.aborted) return;
        if (
          bufferedBytes >= MAX_BUFFERED_BYTES_PER_TASK ||
          parseMilliseconds + performance.now() - sliceStartedAt >= MAX_PARSE_MILLISECONDS_PER_TASK
        ) {
          // Reads of already buffered chunks only yield microtasks. Let input,
          // rendering and cancellation run while a large replay catches up.
          await yieldToTask();
          bufferedBytes = 0;
          parseMilliseconds = 0;
          sliceStartedAt = performance.now();
        }
      }
      parseMilliseconds += performance.now() - sliceStartedAt;
      scheduleTask();
    };
    try {
      while (!this.#abort.signal.aborted) {
        const next = await reader.read();
        if (next.done) {
          await consumeText(decoder.decode());
          break; // SSE discards an unterminated final event.
        }
        for (let offset = 0; offset < next.value.length; offset += DECODE_SLICE_BYTES) {
          if (this.#abort.signal.aborted) break;
          const bytes = next.value.subarray(offset, offset + DECODE_SLICE_BYTES);
          bufferedBytes += bytes.length;
          await consumeText(decoder.decode(bytes, { stream: true }));
        }
      }
    } finally {
      this.#abort.signal.removeEventListener("abort", finishTask);
      finishTask();
      taskChannel.port1.close();
      taskChannel.port2.close();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
