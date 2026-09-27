import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMessageInfo } from "@opencode/client";
import { OpenCodeHttpClient, OPENCODE_MAXIMUM_RESPONSE_BYTES } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeNativeApi, OpenCodeNativeReadLimitError, OPENCODE_NATIVE_EVENT_BUFFER_BYTES, parseOpenCodeNativeMessage, type OpenCodeNativeObservation } from "../../src/server/backends/opencode/opencode-native-api.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";

const clients: OpenCodeHttpClient[] = [];
const observations: OpenCodeNativeObservation[] = [];
afterEach(async () => { for (const observation of observations.splice(0)) await observation.close(); for (const client of clients.splice(0)) client.close(); });
const message = (index: number): SessionMessageInfo => ({ id: `msg_${String(index).padStart(5, "0")}`, type: "synthetic", time: { created: index }, text: `message ${index}` });
function setup(input: Parameters<typeof createOpenCodeApiFixture>[0] = {}) {
  const fixture = createOpenCodeApiFixture(input);
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture-only-canary", fetch: fixture.fetch });
  clients.push(client);
  return { fixture, client, api: new OpenCodeNativeApi(client) };
}
function renameEvent(index = 1) {
  return { id: `evt_${index}`, type: "session.renamed", created: index,
    durable: { aggregateID: "ses_fixture", seq: index, version: 1 }, data: { sessionID: "ses_fixture", title: `title${index}` } };
}
function observe(api: OpenCodeNativeApi, input: Parameters<OpenCodeNativeApi["observe"]>[0] = {}) {
  const observation = api.observe(input); observations.push(observation); return observation;
}

describe("OpenCode validated native reads", () => {
  it("uses the official encoded schema for every message variant and rejects unknown/excess fields", () => {
    const base = { id: "msg_1", time: { created: 1 } };
    const values = [
      { ...base, type: "agent-switched", agent: "build" },
      { ...base, type: "model-switched", model: { providerID: "probe", id: "probe" } },
      { ...base, type: "location-switched", location: { directory: "/fixture" } },
      { ...base, type: "user", text: "hello" }, { ...base, type: "synthetic", text: "system input" },
      { ...base, type: "system", text: "system update" }, { ...base, type: "skill", skill: "skill_probe", name: "probe", text: "instruction" },
      { ...base, type: "shell", shellID: "sh_probe", command: "true", status: "running" },
      { ...base, type: "assistant", agent: "build", model: { providerID: "probe", id: "probe" }, content: [
        { type: "text", text: "observed" }, { type: "reasoning", text: "observed reasoning" },
        { type: "tool", id: "call_1", name: "read", time: { created: 1 }, state: { status: "running", input: {}, metadata: {} } },
      ] },
      { ...base, type: "compaction", status: "running", reason: "manual", summary: "", recent: "" },
      { ...base, type: "idle", outcome: "interrupted" },
    ];
    for (const value of values) expect(parseOpenCodeNativeMessage(value)).toMatchObject(value);
    for (const value of [{ ...base, type: "future" }, { ...base, type: "idle", outcome: "unknown" },
      { ...base, type: "synthetic", text: "valid", unrelated: true }, { ...base, type: "synthetic", text: 42 }]) {
      expect(() => parseOpenCodeNativeMessage(value)).toThrow("opencode_native_protocol_invalid");
    }
  });
  it("retains full metadata byte accounting and exact native ascending pagination including the final empty page", async () => {
    const { fixture, api } = setup({ messages: Array.from({ length: 205 }, (_, index) => message(index)) });
    fixture.messages[0]!.metadata = { producer: { fullValue: "retained metadata" } };
    const first = await api.getHistoryPage(fixture.sessionID, { order: "asc" });
    expect(first.data).toHaveLength(50); expect(first.data[0]).toEqual(fixture.messages[0]);
    expect(fixture.requests[0]!.query.get("limit")).toBe("50");
    expect(first.decodedBytes).toBe(Buffer.byteLength(JSON.stringify({ data: first.data, cursor: first.cursor })));
    const second = await api.getHistoryPage(fixture.sessionID, { cursor: first.cursor.next!, limit: 200 });
    expect(second.data).toEqual(fixture.messages.slice(50));
    expect(fixture.requests[1]!.query.has("order")).toBe(false);
    expect(second.cursor.next).toBeDefined();
    const last = await api.getHistoryPage(fixture.sessionID, { cursor: second.cursor.next! });
    expect(last).toMatchObject({ data: [], cursor: {} });
    expect(last.decodedBytes).toBe(Buffer.byteLength(JSON.stringify({ data: [], cursor: { previous: null, next: null } })));
    await expect(api.getMessage(fixture.sessionID, fixture.messages[204]!.id)).resolves.toEqual(fixture.messages[204]);
  });
  it("preserves stale-cursor empty native evidence for acquisition continuity checks", async () => {
    const { fixture, api } = setup({ messages: [message(1)] });
    const foreign = Buffer.from(JSON.stringify({ id: "msg_foreign", order: "asc", direction: "next" })).toString("base64url");
    await expect(api.getHistoryPage(fixture.sessionID, { cursor: foreign })).resolves.toMatchObject({ data: [], cursor: {} });
    await expect(api.getMessage(fixture.sessionID, "msg_foreign")).rejects.toThrow("opencode_native_not_found");
    await expect(api.getHistoryPage(fixture.sessionID, { cursor: "malformed" })).rejects.toThrow("opencode_native_cursor_invalid");
  });
  it("keeps descending order when previous traverses toward newer messages", async () => {
    const { fixture, api } = setup({ messages: Array.from({ length: 6 }, (_, index) => message(index)) });
    const newest = await api.getHistoryPage(fixture.sessionID, { order: "desc", limit: 2 });
    const older = await api.getHistoryPage(fixture.sessionID, { cursor: newest.cursor.next!, limit: 2 });
    const forward = await api.getHistoryPage(fixture.sessionID, { cursor: older.cursor.previous!, limit: 2 });
    expect(newest.data.map(value => value.id)).toEqual(["msg_00005", "msg_00004"]);
    expect(older.data.map(value => value.id)).toEqual(["msg_00003", "msg_00002"]);
    expect(forward.data).toEqual(newest.data);
  });
  it("normalizes only nullable wire cursors and preserves the official optional-field contract", async () => {
    const { fixture, api } = setup();
    await expect(api.getHistoryPage(fixture.sessionID)).resolves.toMatchObject({ data: [], cursor: {} });
    const session = await api.getSession(fixture.sessionID);
    expect(session.time.idle).toBeUndefined();
    fixture.setResponse(`/api/session/${fixture.sessionID}`, 200, { data: { ...fixture.session, time: { ...fixture.session.time, idle: null } } });
    await expect(api.getSession(fixture.sessionID)).rejects.toThrow("opencode_native_protocol_invalid");
    // Public location.previous is actually nullable in the published JSON
    // codec. Keep that typed native null; do not silently normalize all fields.
    expect(parseOpenCodeNativeMessage({ id: "msg_move", type: "location-switched", time: { created: 1 }, location: { directory: "/fixture" }, previous: null }))
      .toMatchObject({ previous: null });
  });
  it("rejects malformed input and duplicate/native-overfull pages without sending invalid requests", async () => {
    const { fixture, api } = setup();
    for (const options of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { cursor: "next", order: "asc" as const }]) {
      await expect(api.getHistoryPage(fixture.sessionID, options)).rejects.toThrow("opencode_native_read_input_invalid");
    }
    expect(fixture.requests).toHaveLength(0);
    fixture.setResponse(`/api/session/${fixture.sessionID}/message`, 200, { data: [message(1), message(1)], cursor: {} });
    await expect(api.getHistoryPage(fixture.sessionID)).rejects.toThrow("opencode_native_protocol_invalid");
    fixture.setResponse(`/api/session/${fixture.sessionID}/message`, 200, { data: [message(1), message(2)], cursor: {} });
    await expect(api.getHistoryPage(fixture.sessionID, { limit: 1 })).rejects.toThrow("opencode_native_protocol_invalid");
  });
  it("fences wrong-session reads and interaction/inbox attribution", async () => {
    const { fixture, api } = setup();
    await expect(api.getSession(fixture.sessionID)).resolves.toEqual(fixture.session);
    fixture.setResponse(`/api/session/${fixture.sessionID}`, 200, { data: { ...fixture.session, id: "ses_foreign" } });
    await expect(api.getSession(fixture.sessionID)).rejects.toThrow("opencode_native_protocol_invalid");
    fixture.setResponse(`/api/session/${fixture.sessionID}/inbox`, 200, { data: [{ id: "msg_pending", sessionID: "ses_foreign", time: { created: 1 }, type: "synthetic", payload: { text: "input" }, delivery: "steer" }] });
    await expect(api.getPending(fixture.sessionID)).rejects.toThrow("opencode_native_protocol_invalid");
    fixture.setResponse(`/api/session/${fixture.sessionID}/permission`, 200, { data: [{ id: "per_request", sessionID: "ses_foreign", action: "read", resources: ["/fixture"] }] });
    await expect(api.getInteractions(fixture.sessionID)).rejects.toThrow("opencode_native_protocol_invalid");
  });
  it("reports only pinned observable activity, including child activity and attributed shells", async () => {
    const { fixture, api } = setup();
    fixture.sessions.push({ ...fixture.session, id: "ses_child", parentID: fixture.sessionID });
    fixture.setResponse("/api/session/active", 200, { data: { ses_child: { type: "running" }, ses_unrelated: { type: "running" } } });
    const shell = { id: "sh_1", status: "running", command: "sleep 1", cwd: fixture.directory, shell: "/bin/sh", file: "/fixture/output", metadata: { sessionID: fixture.sessionID }, time: { started: 1 } };
    fixture.setResponse("/api/shell", 200, { location: { directory: fixture.directory }, data: [shell, { ...shell, id: "sh_2", metadata: { sessionID: "ses_unrelated" } }] });
    await expect(api.getActivity(fixture.sessionID, fixture.directory)).resolves.toMatchObject({ active: false, activeChildren: ["ses_child"], children: [{ id: "ses_child" }], shells: [shell] });
    await expect(api.getPending(fixture.sessionID)).resolves.toEqual([]);
    await expect(api.getInteractions(fixture.sessionID)).resolves.toEqual({ permissions: [], forms: [] });
  });
  it("bounds response overflow as a nonretryable read limit instead of transport failure", async () => {
    const { fixture, api } = setup();
    expect(OPENCODE_MAXIMUM_RESPONSE_BYTES).toBe(32 * 1024 * 1024);
    fixture.setResponse(`/api/session/${fixture.sessionID}/message`, 200, { data: [{ ...message(1), text: "x".repeat(OPENCODE_MAXIMUM_RESPONSE_BYTES + 1) }], cursor: {} });
    await expect(api.getHistoryPage(fixture.sessionID)).rejects.toMatchObject({ code: "opencode_native_read_limit", limit: "response_bytes", retryable: false });
    expect(new OpenCodeNativeReadLimitError("response_bytes").message).not.toContain("x".repeat(64));
  });
  it("allows exact Stop acknowledgment while a history request is stalled and aborts only that read", async () => {
    const { fixture, api } = setup();
    const gate = fixture.hold(`/api/session/${fixture.sessionID}/message`);
    const abort = new AbortController();
    const read = api.getHistoryPage(fixture.sessionID, { signal: abort.signal });
    const rejected = expect(read).rejects.toThrow("opencode_request_aborted");
    await gate.entered;
    await expect(api.interruptSession(fixture.sessionID)).resolves.toEqual({ interrupted: true });
    abort.abort(); await rejected; gate.release();
    await expect(api.getSession(fixture.sessionID)).resolves.toMatchObject({ id: fixture.sessionID });
  });
});

describe("OpenCode SSE-first observation", () => {
  it("waits for connected before snapshots and buffers intervening events in order", async () => {
    const { fixture, api } = setup({ autoConnect: false });
    const observation = observe(api);
    await Promise.resolve(); await Promise.resolve();
    let ready = false; void observation.ready.then(() => { ready = true; });
    await Promise.resolve(); expect(ready).toBe(false);
    fixture.connected(); await observation.ready;
    fixture.send(renameEvent(1)); fixture.send(renameEvent(2));
    await observation.wait(); await api.getHistoryPage(fixture.sessionID);
    const received = observation.drain();
    expect(received.map(value => value.event.id)).toEqual(["evt_1", "evt_2"]);
    expect(received[0]!.decodedBytes).toBe(Buffer.byteLength(JSON.stringify(renameEvent(1))));
    expect(fixture.requests.map(value => value.pathname)).toEqual(["/api/event", `/api/session/${fixture.sessionID}/message`]);
  });
  it.each(["missing-connected", "unknown-event", "invalid-json", "excess-field"])("invalidates malformed stream evidence: %s", async kind => {
    const { fixture, api } = setup({ autoConnect: kind !== "missing-connected" });
    const observation = observe(api);
    if (kind !== "missing-connected") await observation.ready;
    else { await Promise.resolve(); await Promise.resolve(); }
    if (kind === "invalid-json") fixture.sendRaw("data: {not-json}\n\n");
    else fixture.send(kind === "unknown-event" ? { id: "evt_1", type: "future", data: {} } : kind === "excess-field" ? { ...renameEvent(), unexpected: true } : renameEvent());
    await expect(observation.ended).resolves.toMatchObject({ reason: "malformed" });
    expect(() => observation.drain()).toThrow();
  });
  it("validates before filtering and treats clean EOF as invalidation without automatic replay", async () => {
    const { fixture, api } = setup();
    const observation = observe(api, { include: () => false });
    await observation.ready; fixture.send({ ...renameEvent(), unexpected: true });
    await expect(observation.ended).resolves.toMatchObject({ reason: "malformed" });
    const second = observe(api); await second.ready;
    fixture.disconnect();
    await expect(second.ended).resolves.toMatchObject({ reason: "disconnected" });
    expect(fixture.requests.filter(value => value.pathname === "/api/event")).toHaveLength(2);
  });
  it("fails bounded event accumulation without presenting the queued prefix as synchronized", async () => {
    const { fixture, api } = setup(); const observation = observe(api); await observation.ready;
    for (let index = 0; index < 4_097; index += 1) fixture.send(renameEvent(index + 1));
    await expect(observation.ended).resolves.toMatchObject({ reason: "overflow" });
    expect(() => observation.drain()).toThrow("opencode_event_overflow");
  });
  it("bounds total decoded event bytes independently of the record count", async () => {
    const { fixture, api } = setup(); const observation = observe(api); await observation.ready;
    expect(OPENCODE_NATIVE_EVENT_BUFFER_BYTES).toBe(32 * 1024 * 1024);
    const event = { id: "evt_large", type: "session.text.delta", created: 1,
      data: { sessionID: fixture.sessionID, assistantMessageID: "msg_assistant", ordinal: 0, delta: "x".repeat(12 * 1024 * 1024) } };
    fixture.send(event); await observation.wait(); // Each frame fits; three undrained frames exceed 32 MiB.
    fixture.send({ ...event, id: "evt_larger" });
    fixture.send({ ...event, id: "evt_overflow" });
    await expect(observation.ended).resolves.toMatchObject({ reason: "overflow" });
    expect(() => observation.drain()).toThrow("opencode_event_overflow");
  });
  it("invalidates for resnapshot when two supported maximum-image events exceed the queued-byte budget", async () => {
    const { fixture, api } = setup(); const observation = observe(api); await observation.ready;
    const event = { id: "evt_image", type: "session.inbox.enqueued", created: 1,
      durable: { aggregateID: fixture.sessionID, seq: 0, version: 1 }, data: { sessionID: fixture.sessionID, inboxID: "msg_image",
        item: { type: "user", delivery: "queue", payload: { text: "image", files: [{ data: Buffer.alloc(16 * 1_024 * 1_024).toString("base64"),
          mime: "image/png", source: { type: "inline" } }] } } } };
    fixture.send(event); await observation.wait(); // One ~22.4 MB image frame is supported.
    fixture.send({ ...event, id: "evt_image_two", durable: { ...event.durable, seq: 1 } });
    await expect(observation.ended).resolves.toMatchObject({ reason: "overflow" });
    expect(() => observation.drain()).toThrow("opencode_event_overflow");
    const replacement = observe(api); await replacement.ready;
    await expect(api.getHistoryPage(fixture.sessionID)).resolves.toMatchObject({ data: [] });
    expect(fixture.requests.filter(request => request.pathname === "/api/event")).toHaveLength(2);
  });
  it("bounds readiness even if response headers arrive but no connected frame follows", async () => {
    vi.useFakeTimers();
    try {
      const { api } = setup({ autoConnect: false }); const observation = observe(api);
      const ready = expect(observation.ready).rejects.toThrow("opencode_event_ready_timeout");
      await vi.advanceTimersByTimeAsync(30_000);
      await ready;
      await expect(observation.ended).resolves.toMatchObject({ reason: "failed", error: { code: "opencode_event_ready_timeout" } });
      await observation.close();
    } finally { vi.useRealTimers(); }
  });
  it("distinguishes caller cancellation from disconnect and releases waiting consumers", async () => {
    const { api } = setup(); const abort = new AbortController();
    const observation = observe(api, { signal: abort.signal }); await observation.ready;
    const waiting = expect(observation.wait()).rejects.toThrow("opencode_event_aborted");
    abort.abort(); await waiting;
    await expect(observation.ended).resolves.toMatchObject({ reason: "aborted" });
  });
});
