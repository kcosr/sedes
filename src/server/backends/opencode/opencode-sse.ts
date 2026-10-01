import { OpenCodeRuntimeError } from "./opencode-release.js";

const noEvent = Symbol("no-event");

/** The pinned SDK hardcodes a 16 MiB decoded-buffer limit. Keep framing local
 * for the two admitted SSE routes; callers still validate official wire schemas.
 * Bounds apply to each actual UTF-8 frame, independently of fetch chunk size.
 */
export async function* readOpenCodeSse(body: ReadableStream<Uint8Array>, signal: AbortSignal,
  maximumBytes: number): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let line = Buffer.alloc(Math.min(8_192, maximumBytes));
  let lineBytes = 0, frameBytes = 0;
  let pendingCR = false, firstLine = true;
  let data: string[] = [];
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const addBytes = (size: number) => {
    frameBytes += size;
    if (frameBytes > maximumBytes) throw new OpenCodeRuntimeError("opencode_event_overflow");
  };
  const append = (value: Uint8Array, start: number, end: number) => {
    const count = end - start; if (!count) return;
    addBytes(count);
    const required = lineBytes + count;
    if (required > maximumBytes) throw new OpenCodeRuntimeError("opencode_event_overflow");
    if (required > line.length) {
      const grown = Buffer.alloc(Math.min(maximumBytes, Math.max(required, line.length * 2)));
      line.copy(grown, 0, 0, lineBytes); line = grown;
    }
    line.set(value.subarray(start, end), lineBytes); lineBytes = required;
  };
  const finishLine = (terminatorBytes: number): unknown | typeof noEvent => {
    addBytes(terminatorBytes);
    let text: string;
    try { text = decoder.decode(line.subarray(0, lineBytes)); }
    catch { throw new OpenCodeRuntimeError("opencode_event_malformed"); }
    lineBytes = 0;
    if (firstLine) { firstLine = false; if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); }
    if (text !== "") {
      if (text === "data") data.push("");
      else if (text.startsWith("data:")) data.push(text[5] === " " ? text.slice(6) : text.slice(5));
      return noEvent; // Comments and optional id/event/retry fields grant no replay authority.
    }
    const payload = data.join("\n"); data = []; frameBytes = 0;
    if (line.length > 65_536) line = Buffer.alloc(Math.min(8_192, maximumBytes));
    if (!payload) return noEvent;
    try { return JSON.parse(payload); }
    catch { throw new OpenCodeRuntimeError("opencode_event_malformed"); }
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      let start = 0;
      for (let index = 0; index < next.value.length; index++) {
        const byte = next.value[index]!;
        if (pendingCR) {
          pendingCR = false;
          const event = finishLine(byte === 10 ? 2 : 1);
          if (event !== noEvent) { signal.throwIfAborted(); yield event; }
          if (byte === 10) { start = index + 1; continue; }
        }
        if (byte === 13) { append(next.value, start, index); start = index + 1; pendingCR = true; }
        else if (byte === 10) {
          append(next.value, start, index); start = index + 1;
          const event = finishLine(1);
          if (event !== noEvent) { signal.throwIfAborted(); yield event; }
        }
      }
      append(next.value, start, next.value.length);
    }
    // Match the pinned SDK's finite EOF behavior: complete JSON in a trailing
    // frame can be read, but truncated JSON/UTF-8 cannot become positive proof.
    if (pendingCR || lineBytes) {
      const event = finishLine(pendingCR ? 1 : 0);
      if (event !== noEvent) { signal.throwIfAborted(); yield event; }
    }
    if (data.length) {
      const event = finishLine(0);
      if (event !== noEvent) { signal.throwIfAborted(); yield event; }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
