import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeNativeApi, type OpenCodeNativeEvent } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OpenCodeNativeLogError, OpenCodeNativeMutationDeliveryError, OpenCodeNativeMutationInputError,
  OpenCodeNativeProtocolError, OpenCodeNativeReadLimitError, OPENCODE_NATIVE_RESULT_BYTES,
  encodeOpenCodeNativeFailure, decodeOpenCodeNativeFailure, parseOpenCodeReadOutput,
  parseOpenCodeMutationOutput } from "../../src/server/backends/opencode/opencode-native-codecs.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";
import { createOpenCodeNativePortFixture, openCodeTestMutationControl } from "../helpers/opencode-native-port-fixture.js";

const clients: OpenCodeHttpClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function setup(framed: boolean) {
  const fixture = createOpenCodeApiFixture({ messages: [{ id: "msg_fixture", type: "synthetic", text: "x".repeat(70_000), time: { created: 1 } }] });
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch: fixture.fetch });
  clients.push(client);
  return { fixture, client, port: createOpenCodeNativePortFixture(client, { framed, directory: fixture.directory, sessionID: fixture.sessionID }) };
}

describe.each([false, true])("OpenCode native port (JSON framed=%s)", framed => {
  it("returns the same bounded DTOs and retains one mutation receipt across a repeat", async () => {
    const { fixture, port } = setup(framed);
    const sessionID = fixture.sessionID;
    await expect(port.read("getSession", { sessionID })).resolves.toEqual(fixture.session);
    const page = await port.read("getHistoryPage", { sessionID, order: "asc" });
    expect(page.data).toEqual(fixture.messages);
    expect(page.decodedBytes).toBeGreaterThan(65_536);
    const control = openCodeTestMutationControl("interrupt");
    await expect(port.mutate("interruptSession", { sessionID }, control)).resolves.toEqual({ interrupted: true });
    await expect(port.mutate("interruptSession", { sessionID }, control)).resolves.toEqual({ interrupted: true });
    expect(fixture.requests.filter(request => request.pathname.endsWith("/interrupt"))).toHaveLength(1);
    await expect(port.outcome("interruptSession", control.identity)).resolves.toEqual({ status: "completed", result: { interrupted: true } });
    await port.acknowledgeMutation("interruptSession", control.identity);
    await expect(port.mutate("interruptSession", { sessionID }, control)).rejects.toMatchObject({ delivery: "sent_outcome_unknown", code: "opencode_mutation_acknowledged" });
  });

  it("rejects changed identity input, foreign scope and accessors before native dispatch", async () => {
    const { fixture, port } = setup(framed), control = openCodeTestMutationControl("interrupt");
    await port.mutate("interruptSession", { sessionID: fixture.sessionID }, control);
    await expect(port.mutate("interruptSession", { sessionID: fixture.sessionID }, { ...control, deadlineAt: control.deadlineAt + 1 })).rejects.toMatchObject({ delivery: "not_sent", code: "opencode_mutation_identity_conflict" });
    await expect(port.read("getSession", { sessionID: "ses_other" })).rejects.toMatchObject({ code: "opencode_request_authority_mismatch" });
    await expect(port.mutate("interruptSession", { sessionID: "ses_other" }, openCodeTestMutationControl("foreign")))
      .rejects.toMatchObject({ delivery: "not_sent", code: "opencode_request_authority_mismatch" });
    await expect(port.read("listModels", { directory: "C:\\workspace" })).rejects.toMatchObject({ code: "opencode_native_read_input_invalid" });
    const getter = vi.fn(() => fixture.sessionID), input = {};
    Object.defineProperty(input, "sessionID", { get: getter, enumerable: true });
    await expect(port.read("getSession", input as never)).rejects.toMatchObject({ code: "opencode_native_read_input_invalid" });
    await expect(port.mutate("interruptSession", input as never, control)).rejects.toBeInstanceOf(OpenCodeNativeMutationInputError);
    expect(getter).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(1);
  });

  it("keeps interrupt dispatch independent of a stalled native history read", async () => {
    const { fixture, port } = setup(framed), hold = fixture.hold(`/api/session/${"ses_fixture"}/message`);
    const reading = port.read("getHistoryPage", { sessionID: fixture.sessionID });
    try {
      await hold.entered;
      await expect(port.mutate("interruptSession", { sessionID: fixture.sessionID }, openCodeTestMutationControl("interrupt"))).resolves.toEqual({ interrupted: true });
    } finally { hold.release(); await reading; }
  });

  it("preserves attributed eager observations and exposes explicit sequence acknowledgment", async () => {
    const { fixture, port } = setup(framed), include = vi.fn(() => false);
    const observation = new OpenCodeNativeApi(port).observe({ include });
    try {
      await observation.ready;
      fixture.send({ id: "evt_synthetic", type: "session.synthetic", created: 1,
        durable: { aggregateID: fixture.sessionID, seq: 1, version: 1 }, data: { sessionID: fixture.sessionID, text: "evidence" } });
      await vi.waitFor(() => expect(include).toHaveBeenCalledOnce());
      const [, record] = include.mock.calls[0] as unknown as [unknown, { sequence: number; continuity: string }];
      expect(record).toMatchObject({ sequence: 1, continuity: observation.boundary!.continuity });
      expect(observation.drain()).toEqual([]);
      await observation.acknowledge(record.sequence);
      await expect(observation.acknowledge(record.sequence + 1)).rejects.toMatchObject({ code: "opencode_request_authority_mismatch" });
    } finally { await observation.close(); }
  });

  it("routes nested form ownership for the root, known children and global notices without foreign session forms", async () => {
    const { fixture, port } = setup(framed);
    fixture.sessions.push({ ...fixture.session, id: "ses_child", parentID: fixture.sessionID });
    await port.read("getActivity", { sessionID: fixture.sessionID, directory: fixture.directory });
    const received: string[] = [];
    const observation = new OpenCodeNativeApi(port).observe({ include: (event: OpenCodeNativeEvent) => {
      if (event.type === "form.created") received.push(event.data.form.id);
      return false;
    } });
    try {
      await observation.ready;
      for (const [id, sessionID] of [["root", fixture.sessionID], ["child", "ses_child"], ["foreign", "ses_foreign"], ["global", "global"]]) {
        fixture.send({ id: `evt_${id}`, type: "form.created", created: 1,
          data: { form: { id: `frm_${id}`, sessionID, title: "Question", fields: [{ key: "answer", type: "string" }] } } });
      }
      await vi.waitFor(() => expect(received).toEqual(["frm_root", "frm_child", "frm_global"]));
      expect(observation.failure).toBeUndefined();
    } finally { await observation.close(); }
  });
});

it("permits a finite log aggregate larger than a native page while bounding each event", () => {
  const text = "x".repeat(17 * 1_024 * 1_024);
  const events = [0, 1].map(seq => ({ id: `evt_${seq}`, created: 1, type: "session.synthetic",
    durable: { aggregateID: "ses_fixture", seq, version: 1 }, data: { sessionID: "ses_fixture", text } }));
  const result = parseOpenCodeReadOutput("readLog", { sessionID: "ses_fixture" }, {
    sessionID: "ses_fixture", watermark: 1, events, sequenceGaps: [], records: 3,
    decodedBytes: Buffer.byteLength(JSON.stringify(events)) + 100,
  });
  expect(result.events).toHaveLength(2);
  expect(result.decodedBytes).toBeGreaterThan(OPENCODE_NATIVE_RESULT_BYTES);
});

it("round-trips classified failures without exception text or credential material", () => {
  const failures = [new OpenCodeNativeReadLimitError("response_bytes"), new OpenCodeNativeLogError("time"),
    new OpenCodeNativeProtocolError(), new OpenCodeNativeMutationInputError(),
    new OpenCodeNativeMutationDeliveryError("not_sent", "opencode_mutation_retention_full"),
    new OpenCodeNativeMutationDeliveryError("sent_outcome_unknown", "opencode_request_failed")];
  for (const error of failures) {
    const decoded = decodeOpenCodeNativeFailure(JSON.parse(JSON.stringify(encodeOpenCodeNativeFailure(error, false))));
    expect(decoded.constructor).toBe(error.constructor);
    expect(decoded).toMatchObject({ code: error.code });
    if ("delivery" in error) expect(decoded).toMatchObject({ delivery: error.delivery });
  }
  expect(encodeOpenCodeNativeFailure(new Error("private credential value"), true)).toEqual({ kind: "mutation_unknown", delivery: "sent_outcome_unknown", code: "opencode_request_failed" });
  expect(decodeOpenCodeNativeFailure({ kind: "runtime", code: "arbitrary private value" })).toBeInstanceOf(OpenCodeNativeProtocolError);
});

it("uses explicit JSON-safe empty values and validates result scope and aggregate bounds", () => {
  expect(parseOpenCodeReadOutput("getDefaultModel", { directory: "/workspace" }, null)).toBeNull();
  expect(parseOpenCodeMutationOutput("cancelInput", { sessionID: "ses_fixture", inboxID: "msg_fixture" }, { ok: true })).toEqual({ ok: true });
  expect(() => parseOpenCodeMutationOutput("cancelInput", { sessionID: "ses_fixture", inboxID: "msg_fixture" }, {})).toThrow(OpenCodeNativeProtocolError);
  expect(parseOpenCodeReadOutput("readLog", { sessionID: "ses_fixture" }, { sessionID: "ses_fixture", watermark: null, events: [], sequenceGaps: [], records: 1, decodedBytes: 50 })).toMatchObject({ watermark: null });
  expect(() => parseOpenCodeReadOutput("getMessage", { sessionID: "ses_fixture", messageID: "msg_expected" }, { id: "msg_other", type: "synthetic", text: "foreign", time: { created: 1 } })).toThrow(OpenCodeNativeProtocolError);
  expect(() => parseOpenCodeReadOutput("getMessage", { sessionID: "ses_fixture", messageID: "msg_fixture" }, { id: "msg_fixture", type: "synthetic", text: "x".repeat(OPENCODE_NATIVE_RESULT_BYTES), time: { created: 1 } })).toThrow(OpenCodeNativeReadLimitError);
});
