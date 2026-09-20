import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchEventSource } from "../../src/client/api/FetchEventSource.js";
import { authenticatedFetch } from "../../src/client/authentication/auth-transport.js";
import { assertBoundedSseFrame } from "../../src/server/events/sse-frame.js";
import { MAXIMUM_SSE_EVENT_BYTES } from "../../src/shared/protocol/payload.js";

vi.mock("../../src/client/authentication/auth-transport.js", () => ({ authenticatedFetch: vi.fn() }));
const endpoint = { baseUrl: "https://sedes.example" };
const sources: FetchEventSource[] = [];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function source() {
  const result = new FetchEventSource(endpoint, "/api/application/events");
  sources.push(result);
  return result;
}
function response(parts: Uint8Array[]) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}
// Give MessageChannel tasks the same controllable task queue as timers. The
// production parser never uses nested timers to yield its buffered replay.
const taskChannels: { port1: { close: ReturnType<typeof vi.fn> }; port2: { close: ReturnType<typeof vi.fn> } }[] = [];
beforeEach(() => {
  vi.stubGlobal("MessageChannel", class {
    timer: ReturnType<typeof setTimeout> | undefined;
    port1 = {
      onmessage: undefined as (() => void) | undefined,
      close: vi.fn(() => clearTimeout(this.timer)),
    };
    port2 = {
      postMessage: () => { this.timer = setTimeout(() => this.port1.onmessage?.(), 0); },
      close: vi.fn(() => clearTimeout(this.timer)),
    };
    constructor() { taskChannels.push(this); }
  });
});
afterEach(() => { sources.splice(0).forEach((item) => item.close()); taskChannels.splice(0); vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("authenticated fetch SSE", () => {
  it("replenishes parsing budgets across network tasks without delaying the next frame", async () => {
    vi.useFakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new ReadableStream({
      start(value) { controller = value; },
    }), { headers: { "Content-Type": "text/event-stream" } }));
    const stream = source();
    const received: string[] = [];
    stream.addEventListener("message", event => {
      received.push((event as MessageEvent).data);
      if (received.length <= 2) clock += 5;
      else stream.close();
    });
    controller.enqueue(new TextEncoder().encode("data: first\n\n"));
    await flush();
    expect(received).toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(1);
    controller.enqueue(new TextEncoder().encode("data: second\n\ndata: third\n\n"));
    await flush();
    expect(received).toEqual(["first", "second", "third"]);
    expect(taskChannels[0]?.port1.close).toHaveBeenCalledOnce();
    expect(taskChannels[0]?.port2.close).toHaveBeenCalledOnce();
  });
  it("parses byte-split UTF-8, CRLF, multiline data and named events", async () => {
    const bytes = new TextEncoder().encode(": keepalive\r\nid: cursor-1\r\nevent: application\r\ndata: café\r\ndata: two\r\n\r\ndata: unfinished");
    vi.mocked(authenticatedFetch).mockResolvedValue(response([...bytes].map((byte) => Uint8Array.of(byte))));
    const messages: MessageEvent[] = [];
    source().addEventListener("application", (event) => messages.push(event as MessageEvent));
    for (let i = 0; i < bytes.length; i++) await flush();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toBe("café\ntwo");
    expect(messages[0]?.lastEventId).toBe("cursor-1");
    expect(authenticatedFetch).toHaveBeenCalledWith(endpoint, "/api/application/events", expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  });

  it("reconnects using Last-Event-ID and bounded server retry delay", async () => {
    vi.useFakeTimers();
    vi.mocked(authenticatedFetch).mockImplementation(async () => response([new TextEncoder().encode("id: cursor-2\nretry: 700\ndata: first\n\n")]));
    source();
    await flush();
    await vi.advanceTimersByTimeAsync(699);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    const headers = new Headers(vi.mocked(authenticatedFetch).mock.calls[1]?.[2]?.headers);
    expect(headers.get("Last-Event-ID")).toBe("cursor-2");
  });

  it("does not advance the reconnect cursor past an incomplete frame", async () => {
    vi.useFakeTimers();
    vi.mocked(authenticatedFetch).mockImplementation(async () => response([new TextEncoder().encode("id: complete\ndata: first\n\nid: incomplete\ndata: truncated")]));
    source();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    const headers = new Headers(vi.mocked(authenticatedFetch).mock.calls[1]?.[2]?.headers);
    expect(headers.get("Last-Event-ID")).toBe("complete");
  });

  it("stops dispatching the current chunk when an event listener closes it", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(response([new TextEncoder().encode("data: first\n\ndata: second\n\n")]));
    const stream = source();
    const events: string[] = [];
    stream.addEventListener("message", (event) => {
      events.push((event as MessageEvent).data);
      stream.close();
    });
    await flush();
    expect(events).toEqual(["first"]);
    expect(stream.readyState).toBe(2);
  });

  it.each([204, 401, 403])("stops retrying on HTTP %s", async (status) => {
    vi.useFakeTimers();
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(null, { status }));
    const stream = source();
    const onerror = vi.fn();
    stream.onerror = onerror;
    await flush();
    expect(stream.readyState).toBe(2);
    expect(onerror).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(authenticatedFetch).toHaveBeenCalledOnce();
  });

  it("cancels pending fetch and emits no errors after close", async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(authenticatedFetch).mockReturnValue(new Promise((done) => { resolve = done; }));
    const stream = source();
    stream.onerror = vi.fn();
    stream.close();
    expect(vi.mocked(authenticatedFetch).mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    resolve(response([]));
    await flush();
    expect(stream.onerror).not.toHaveBeenCalled();
    expect(stream.readyState).toBe(2);
  });

  it.each([1, 2, 3, 7, 65_536])("preserves mixed line endings, Unicode and field semantics with %s-byte chunks", async (chunkSize) => {
    const bytes = new TextEncoder().encode(
      ": ignored\rid: first\r\nevent: application\ndata: café 😀\rdata:\r\ndata: next\r\n\r\n" +
      "id: invalid\0id\ndata: keeps-id\n\nid:\ndata: clears-id\n\ndata: unfinished",
    );
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += chunkSize) parts.push(bytes.subarray(offset, offset + chunkSize));
    vi.mocked(authenticatedFetch).mockResolvedValue(response(parts));
    const stream = source();
    const messages: { type: string; data: string; id: string }[] = [];
    const receive = (event: Event) => {
      const message = event as MessageEvent;
      messages.push({ type: message.type, data: message.data, id: message.lastEventId });
    };
    stream.addEventListener("application", receive);
    stream.addEventListener("message", receive);
    await new Promise<void>((resolve) => { stream.onerror = () => { stream.close(); resolve(); }; });
    expect(messages).toEqual([
      { type: "application", data: "café 😀\n\nnext", id: "first" },
      { type: "message", data: "keeps-id", id: "first" },
      { type: "message", data: "clears-id", id: "" },
    ]);
  });

  it.each(["\r\n", "\r", "\n"])("parses %j at an internal decode boundary", async (ending) => {
    // Put the line terminator at byte 65,535, inside one oversized reader chunk.
    const data = "x".repeat(65_535 - "data: ".length);
    vi.mocked(authenticatedFetch).mockResolvedValue(response([
      new TextEncoder().encode(`data: ${data}${ending}${ending}data: 😀${ending}${ending}`),
    ]));
    const stream = source();
    const messages: string[] = [];
    await new Promise<void>((resolve) => {
      stream.addEventListener("message", (event) => {
        messages.push((event as MessageEvent).data);
        if (messages.length === 2) { stream.close(); resolve(); }
      });
    });
    expect(messages).toEqual([data, "😀"]);
  });

  it("yields to tasks during a large buffered replay and preserves event order", async () => {
    vi.useFakeTimers();
    const expected = Array.from({ length: 256 }, (_, index) => `event-${index}`);
    const bytes = new TextEncoder().encode(expected.map((id) => `id: ${id}\ndata: ${"x".repeat(8192)}\n\n`).join(""));
    vi.mocked(authenticatedFetch).mockResolvedValue(response([bytes]));
    const received: string[] = [];
    let receivedAtTask: number | undefined;
    setTimeout(() => { receivedAtTask = received.length; }, 0);
    const stream = source();
    stream.addEventListener("message", (event) => {
      received.push((event as MessageEvent).lastEventId);
      if (received.length === expected.length) stream.close();
    });
    for (let index = 0; index < 20; index++) await flush();
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThan(expected.length);
    expect(receivedAtTask).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(receivedAtTask).toBeGreaterThan(0);
    expect(receivedAtTask).toBeLessThan(expected.length);
    expect(received).toEqual(expected);
  });

  it("yields after expensive event handlers even for small buffered input", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.mocked(authenticatedFetch).mockResolvedValue(response([
      new TextEncoder().encode("data: first\n\ndata: second\n\n"),
    ]));
    const stream = source();
    const received: string[] = [];
    stream.addEventListener("message", (event) => {
      received.push((event as MessageEvent).data);
      if (received.length === 1) vi.advanceTimersByTime(9);
      else stream.close();
    });
    await flush();
    expect(received).toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toEqual(["first", "second"]);
  });

  it("cancels a buffered replay while yielding without dispatching its remainder or retrying", async () => {
    vi.useFakeTimers();
    const bytes = new TextEncoder().encode(`data: ${"x".repeat(8192)}\n\n`.repeat(256));
    const cancel = vi.fn();
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes); },
      cancel,
    }), { headers: { "Content-Type": "text/event-stream" } }));
    const stream = source();
    const receive = vi.fn();
    stream.addEventListener("message", receive);
    stream.onerror = vi.fn();
    setTimeout(() => stream.close(), 0);
    for (let index = 0; index < 20; index++) await flush();
    const delivered = receive.mock.calls.length;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(256);
    await vi.advanceTimersByTimeAsync(2000);
    expect(receive).toHaveBeenCalledTimes(delivered);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.onerror).not.toHaveBeenCalled();
    expect(authenticatedFetch).toHaveBeenCalledOnce();
    expect(stream.readyState).toBe(2);
  });

  it("dispatches a server-valid ASCII frame larger than the former 32 MiB ceiling", async () => {
    vi.useFakeTimers();
    const text = "x".repeat(32 * 1024 * 1024);
    const frame = assertBoundedSseFrame(`event: thread\ndata: ${text}\n\n`);
    expect(Buffer.byteLength(frame, "utf8")).toBeGreaterThan(32 * 1024 * 1024);
    vi.mocked(authenticatedFetch).mockResolvedValue(response([new TextEncoder().encode(frame)]));
    const stream = source();
    const receive = vi.fn((_event: Event) => stream.close());
    stream.addEventListener("thread", receive);
    stream.onerror = vi.fn();
    await vi.advanceTimersByTimeAsync(100);
    expect(receive).toHaveBeenCalledOnce();
    expect((receive.mock.calls[0]?.[0] as MessageEvent).data).toBe(text);
    expect(stream.onerror).not.toHaveBeenCalled();
    expect(authenticatedFetch).toHaveBeenCalledOnce();
  });

  it.each([0, 1])("enforces the code-point frame limit with %s excess characters", async (excess) => {
    vi.useFakeTimers();
    const maximum = MAXIMUM_SSE_EVENT_BYTES;
    const text = "x".repeat(maximum - "data: \n\n".length - 1 + excess) + "😀";
    vi.mocked(authenticatedFetch).mockResolvedValue(response([new TextEncoder().encode(`data: ${text}\n\n`)]));
    const stream = source();
    const receive = vi.fn(() => stream.close());
    const error = vi.fn();
    stream.addEventListener("message", receive);
    stream.onerror = error;
    await vi.advanceTimersByTimeAsync(100);
    expect(receive).toHaveBeenCalledTimes(excess === 0 ? 1 : 0);
    expect(error).toHaveBeenCalledTimes(excess === 0 ? 0 : 1);
    stream.close();
  });
});
