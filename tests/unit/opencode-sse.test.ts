import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeHttpClient, OPENCODE_MAXIMUM_RESPONSE_BYTES } from "../../src/server/backends/opencode/opencode-http-client.js";
import { parseOpenCodeNativeEvent } from "../../src/server/backends/opencode/opencode-native-api.js";
import { readOpenCodeSse } from "../../src/server/backends/opencode/opencode-sse.js";

const clients: OpenCodeHttpClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function source(chunks: readonly Uint8Array[], hold = false) {
  let index = 0; const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]!); else if (!hold) controller.close(); },
    cancel,
  });
  return { body, cancel };
}
async function collect(values: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = []; for await (const value of values) result.push(value); return result;
}
function transport(chunks: readonly Uint8Array[], options: { hold?: boolean; status?: number; type?: string } = {}) {
  const input = source(chunks, options.hold);
  const fetch = vi.fn(async () => new Response(input.body, { status: options.status ?? 200,
    headers: { "content-type": options.type ?? "text/event-stream" } }));
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "sse-test-only", fetch });
  clients.push(client); return { ...input, client, fetch };
}
const delta = (text: string) => ({ id: "evt_delta", type: "session.text.delta", created: 1,
  data: { sessionID: "ses_native", assistantMessageID: "msg_answer", ordinal: 0, delta: text } });
const frame = (value: unknown) => Buffer.from(`data: ${JSON.stringify(value)}\n\n`);

describe("OpenCode bounded SSE framing", () => {
  it("accepts a native image event above the SDK's former 16 MiB limit through official validation", async () => {
    const data = Buffer.alloc(16 * 1_024 * 1_024).toString("base64");
    const event = { id: "evt_image", type: "session.inbox.enqueued", created: 1,
      durable: { aggregateID: "ses_native", seq: 0, version: 1 }, data: { sessionID: "ses_native", inboxID: "msg_image",
        item: { type: "user", delivery: "queue", payload: { text: "image", files: [{ data, mime: "image/png", source: { type: "inline" } }] } } } };
    const wire = frame(event); expect(wire.length).toBeGreaterThan(16 * 1_024 * 1_024);
    const f = transport([wire]); let count = 0;
    for await (const result of f.client.events(parseOpenCodeNativeEvent)) {
      expect(result.type).toBe("session.inbox.enqueued"); count++;
      if (result.type === "session.inbox.enqueued" && result.data.item.type === "user") {
        expect(result.data.item.payload.files?.[0]?.data.length).toBe(data.length);
      }
    }
    expect(count).toBe(1); expect(f.body.locked).toBe(false);
  });
  it("splits several valid frames from one fetch chunk larger than 32 MiB", async () => {
    const size = 12 * 1_024 * 1_024, wire = frame(delta("x".repeat(size)));
    const f = transport([Buffer.concat([wire, wire, wire])]); let count = 0;
    for await (const value of f.client.events(parseOpenCodeNativeEvent)) {
      expect(value.type).toBe("session.text.delta");
      if (value.type === "session.text.delta") expect(value.data.delta.length).toBe(size);
      count++;
    }
    expect(count).toBe(3);
  });
  it("rejects a wire line above 32 MiB without retaining its text in the error", async () => {
    const f = transport([Buffer.from(`:${"x".repeat(OPENCODE_MAXIMUM_RESPONSE_BYTES + 1)}\n\n`)], { hold: true });
    await expect(collect(f.client.events(parseOpenCodeNativeEvent))).rejects.toMatchObject({ code: "opencode_response_too_large" });
    expect(f.cancel).toHaveBeenCalledOnce(); expect(f.body.locked).toBe(false);
  });
  it("counts all frame bytes, including comments and CRLF, across individually short lines", async () => {
    const f = source([Buffer.from(":keepalive\r\n:keepalive\r\n:keepalive\r\n\r\n")]);
    await expect(collect(readOpenCodeSse(f.body, new AbortController().signal, 32))).rejects.toMatchObject({ code: "opencode_event_overflow" });
    expect(f.body.locked).toBe(false);
  });
  it("handles split UTF-8, BOM, CRLF, bare CR/LF, multiline data and ignored optional fields", async () => {
    const wire = Buffer.from('\ufeff: keepalive\r\nid: ignored\revent: ignored\nretry: 1\r\ndata: {"text":\r\ndata: "🦊é"}\r\n\r\ndata:\n\ndata: {"next":true}\r\r');
    const f = source([...wire].map(byte => Uint8Array.of(byte)));
    await expect(collect(readOpenCodeSse(f.body, new AbortController().signal, 1_024))).resolves.toEqual([{ text: "🦊é" }, { next: true }]);
    expect(f.body.locked).toBe(false);
  });
  it.each([Buffer.from("data: {broken}\n\n"), Buffer.from('data: {"truncated":'),
    Buffer.from([100, 97, 116, 97, 58, 32, 34, 0xff, 34, 10, 10]),
    Buffer.from([100, 97, 116, 97, 58, 32, 34, 0xf0, 0x9f])])("rejects malformed JSON or UTF-8 without echoing payloads (%#)", async wire => {
    const f = source([wire]);
    await expect(collect(readOpenCodeSse(f.body, new AbortController().signal, 1_024))).rejects.toMatchObject({ code: "opencode_event_malformed" });
    expect(f.body.locked).toBe(false);
  });
  it("preserves finite EOF flush for a complete trailing JSON frame", async () => {
    const f = source([Buffer.from('data: {"complete":true}')]);
    await expect(collect(readOpenCodeSse(f.body, new AbortController().signal, 1_024))).resolves.toEqual([{ complete: true }]);
  });
  it.each([{ status: 401 }, { status: 404 }, { status: 200, type: "application/json" }])("rejects invalid stream response metadata %j", async options => {
    const f = transport([], { ...options, hold: true });
    await expect(collect(f.client.events(parseOpenCodeNativeEvent))).rejects.toMatchObject({ code: "opencode_event_stream_failed" });
    expect(f.cancel).toHaveBeenCalledOnce();
  });
  it("keeps authentication, redirect rejection and exact finite-log query authority", async () => {
    const f = transport([Buffer.from('data: {"ok":true}\n\n')]);
    await expect(collect(f.client.stream({ kind: "log", sessionID: "ses_exact", after: 0 }, value => value))).resolves.toEqual([{ ok: true }]);
    const [request, init] = f.fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(request.pathname).toBe("/api/experimental/session/ses_exact/log");
    expect([...request.searchParams.entries()]).toEqual([["follow", "false"], ["after", "0"]]);
    expect(init.redirect).toBe("error"); expect(init.signal).toBeDefined();
    expect(new Headers(init.headers).get("authorization")).toBe(`Basic ${Buffer.from("opencode:sse-test-only").toString("base64")}`);
    const redirected = transport([], { status: 302, hold: true });
    await expect(collect(redirected.client.events(parseOpenCodeNativeEvent))).rejects.toMatchObject({ code: "opencode_redirect_rejected" });
    expect(redirected.cancel).toHaveBeenCalledOnce();
    const invalid = transport([]);
    await expect(collect(invalid.client.stream({ kind: "log", sessionID: "ses_../../escape" }, value => value))).rejects.toMatchObject({ code: "opencode_request_authority_mismatch" });
    expect(invalid.fetch).not.toHaveBeenCalled();
  });
  it("cancels a pending read promptly on abort and removes its abort listener", async () => {
    const f = source([], true), controller = new AbortController();
    const iterator = readOpenCodeSse(f.body, controller.signal, 1_024);
    const pending = iterator.next(); const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejected;
    expect(f.cancel).toHaveBeenCalledOnce(); expect(f.body.locked).toBe(false);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
  it("cancels only the returning observer's HTTP body without an automatic reconnect", async () => {
    const f = transport([frame(delta("one")), frame(delta("two"))], { hold: true });
    const iterator = f.client.events(parseOpenCodeNativeEvent)[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false); await iterator.return?.();
    expect(f.cancel).toHaveBeenCalledOnce(); expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.body.locked).toBe(false);
    expect(f.client.lifetime.aborted).toBe(false);
  });
});
