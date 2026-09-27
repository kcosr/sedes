import { createOpenCodeNativePortFixture } from "../helpers/opencode-native-port-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { readOpenCodeNativeLog } from "../../src/server/backends/opencode/opencode-native-log.js";

const clients: OpenCodeHttpClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function event(seq: number, data: Record<string, unknown> = {}) {
  return { id: `evt_${seq}`, created: 1, type: "session.inbox.delivered", durable: { aggregateID: "ses_owned", seq, version: 1 },
    data: { sessionID: "ses_owned", inboxID: `msg_${seq}`, ...data } };
}
const synced = (seq?: number) => ({ type: "log.synced", aggregateID: "ses_owned", ...(seq === undefined ? {} : { seq }) });
function fixture(frames: unknown[], close = true) {
  const requests: URL[] = [];
  let cancelled = false;
  const fetch = vi.fn(async (value: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    requests.push(new URL(String(value)));
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).has("authorization")).toBe(true);
    let abort: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        abort = () => controller.error(new DOMException("Aborted", "AbortError"));
        init?.signal?.addEventListener("abort", abort, { once: true });
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
        if (close) { init?.signal?.removeEventListener("abort", abort); controller.close(); }
      },
      cancel() { cancelled = true; if (abort) init?.signal?.removeEventListener("abort", abort); },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch }); clients.push(client);
  return { client: createOpenCodeNativePortFixture(client), requests, fetch, get cancelled() { return cancelled; } };
}
describe("OpenCode finite native log cuts", () => {
  it("validates the official encoded SSE schema and exact contiguous aggregate cut", async () => {
    const { client, requests } = fixture([event(0), event(1), synced(1)]);
    const cut = await readOpenCodeNativeLog(client, { sessionID: "ses_owned" });
    expect(cut).toMatchObject({ sessionID: "ses_owned", watermark: 1, events: [event(0), event(1)], sequenceGaps: [], records: 3 });
    expect(cut.decodedBytes).toBe([event(0), event(1), synced(1)].reduce((total, frame) => total + Buffer.byteLength(JSON.stringify(frame)), 0));
    expect(requests[0]!.pathname).toBe("/api/experimental/session/ses_owned/log");
    expect(requests[0]!.searchParams.get("follow")).toBe("false");
    expect(requests[0]!.searchParams.has("after")).toBe(false);
  });
  it("reports watermark-only stock CLI logs as missing coordinates, never an empty history proof", async () => {
    const { client } = fixture([synced(15)]);
    await expect(readOpenCodeNativeLog(client, { sessionID: "ses_owned" })).resolves.toMatchObject({ watermark: 15, events: [], sequenceGaps: [{ after: -1, through: 15 }] });
  });
  it("tracks internal and trailing gaps and respects an exclusive after cursor", async () => {
    const { client, requests } = fixture([event(5), event(7), synced(9)]);
    const cut = await readOpenCodeNativeLog(client, { sessionID: "ses_owned", after: 3 });
    expect(cut.sequenceGaps).toEqual([{ after: 3, through: 4 }, { after: 5, through: 6 }, { after: 7, through: 9 }]);
    expect(requests[0]!.searchParams.get("after")).toBe("3");
  });
  it("accepts an empty watermark and a fully drained exclusive cursor without inventing a gap", async () => {
    await expect(readOpenCodeNativeLog(fixture([synced()]).client, { sessionID: "ses_owned" })).resolves.toMatchObject({ watermark: undefined, sequenceGaps: [], events: [] });
    await expect(readOpenCodeNativeLog(fixture([synced(8)]).client, { sessionID: "ses_owned", after: 8 })).resolves.toMatchObject({ watermark: 8, sequenceGaps: [] });
  });
  it.each([
    [event(0), event(0), synced(0)], [event(1), event(0), synced(1)], [event(1), synced(0)],
    [event(0), synced(0), event(1)], [synced(0), synced(0)], [event(0), synced()],
    [{ ...event(0), durable: { aggregateID: "ses_foreign", seq: 0, version: 1 } }, synced(0)],
    [event(0, { sessionID: "ses_foreign" }), synced(0)], [{ ...synced(0), aggregateID: "ses_foreign" }],
    [event(0), { ...event(1), id: "evt_0" }, synced(1)],
  ])("rejects invalid ordering, scope, watermark or duplicated identity: %j", async (...frames) => {
    await expect(readOpenCodeNativeLog(fixture(frames).client, { sessionID: "ses_owned" })).rejects.toThrow("opencode_native_log_invalid");
  });
  it.each([[event(0)], []])("requires the synced marker and finite EOF: %j", async (...frames) => {
    await expect(readOpenCodeNativeLog(fixture(frames).client, { sessionID: "ses_owned" })).rejects.toThrow("opencode_native_log_incomplete");
  });
  it("rejects unknown event shapes and unsafe sequences before they become evidence", async () => {
    await expect(readOpenCodeNativeLog(fixture([{ ...event(0), extra: true }, synced(0)]).client, { sessionID: "ses_owned" })).rejects.toThrow("opencode_native_protocol_invalid");
    await expect(readOpenCodeNativeLog(fixture([event(Number.MAX_SAFE_INTEGER + 1), synced(Number.MAX_SAFE_INTEGER + 1)]).client, { sessionID: "ses_owned" })).rejects.toThrow("opencode_native_protocol_invalid");
  });
  it("bounds finite acquisition bytes and frame count independently", async () => {
    await expect(readOpenCodeNativeLog(fixture([event(0), synced(0)]).client, { sessionID: "ses_owned", limits: { records: 1 } })).rejects.toThrow("opencode_native_log_records");
    await expect(readOpenCodeNativeLog(fixture([event(0), synced(0)]).client, { sessionID: "ses_owned", limits: { decodedBytes: 1 } })).rejects.toThrow("opencode_native_log_bytes");
  });
  it("honors caller cancellation and the original shortened deadline while waiting for EOF", async () => {
    const timed = fixture([synced(0)], false);
    await expect(readOpenCodeNativeLog(timed.client, { sessionID: "ses_owned", deadlineAt: Date.now() + 25 })).rejects.toThrow("opencode_native_log_time");
    const abort = new AbortController(); const cancelled = fixture([], false);
    const reading = readOpenCodeNativeLog(cancelled.client, { sessionID: "ses_owned", signal: abort.signal });
    const assertion = expect(reading).rejects.toThrow("opencode_native_log_cancelled");
    await vi.waitFor(() => expect(cancelled.requests).toHaveLength(1)); abort.abort(); await assertion;
  });
  it("rejects invalid IDs, cursors and limits without issuing requests", async () => {
    const { client, requests } = fixture([]);
    for (const input of [{ sessionID: "ses_bad/path" }, { sessionID: "ses_owned", after: -1 },
      { sessionID: "ses_owned", limits: { records: 100_001 } }]) {
      await expect(readOpenCodeNativeLog(client, input)).rejects.toThrow("opencode_native_log_input");
    }
    expect(requests).toHaveLength(0);
  });
});
