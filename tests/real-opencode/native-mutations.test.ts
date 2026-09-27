import { expect, it, vi } from "vitest";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeNativeApi, type OpenCodeNativeObservation } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OpenCodeNativeMutations } from "../../src/server/backends/opencode/opencode-native-mutations.js";
import { readOpenCodeNativeLog } from "../../src/server/backends/opencode/opencode-native-log.js";
import { boundedOpenCodeProcessFile } from "../../src/server/backends/opencode/opencode-native-identity.js";
import { RUN_REAL_OPENCODE, startOpencodeNativeFixture } from "../support/opencode-native-fixture.js";
import { startOpencodeModelFixture } from "../support/opencode-model-fixture.js";

it.runIf(RUN_REAL_OPENCODE)("qualifies native mutations, prepared admission, forms and stock nonpersistent log through production codecs", async () => {
  const model = await startOpencodeModelFixture();
  const native = await startOpencodeNativeFixture({ config: model.config }).catch(async error => { await model.stop(); throw error; });
  let client: OpenCodeHttpClient | undefined;
  let observation: OpenCodeNativeObservation | undefined;
  try {
    const environment = (await boundedOpenCodeProcessFile(`/proc/${native.pid}/environ`, 1_048_576)).toString("utf8");
    const password = environment.split("\0").find(entry => entry.startsWith("OPENCODE_PASSWORD="))?.slice("OPENCODE_PASSWORD=".length);
    if (!password) throw new Error("isolated native credential unavailable");
    client = new OpenCodeHttpClient({ endpoint: native.url, password });
    const api = new OpenCodeNativeApi(client);
    const mutations = new OpenCodeNativeMutations(client);
    observation = api.observe(); await observation.ready;
    const session = await mutations.createSession({ id: "ses_mutations", title: "Native effects", location: { directory: native.workspace }, model: { providerID: "probe", id: "probe-model" },
      permissions: [{ action: "qualification", resource: "*", effect: "ask" }] });
    expect(session.id).toBe("ses_mutations");
    // Native model catalog reads may precede initial provider plugin settlement.
    await vi.waitFor(async () => expect((await mutations.listModels(native.workspace)).some(value => value.providerID === "probe" && value.id === "probe-model")).toBe(true), { timeout: 20_000, interval: 25 });
    await expect(mutations.getDefaultModel(native.workspace)).resolves.toMatchObject({ providerID: "probe", id: "probe-model" });
    await mutations.setModel({ sessionID: session.id, model: { providerID: "probe", id: "second-model" } });
    await expect(api.getSession(session.id)).resolves.toMatchObject({ model: { providerID: "probe", id: "second-model" } });
    await mutations.renameSession(session.id, "Renamed native effects");
    await expect(api.getSession(session.id)).resolves.toMatchObject({ title: "Renamed native effects" });

    const permissionRoute = `/api/session/${session.id}/permission`;
    const firstPermission = await native.api("POST", permissionRoute, { action: "qualification", resources: ["first"] });
    expect(firstPermission).toMatchObject({ status: 200, body: { data: { effect: "ask" } } });
    const permissionID: string = firstPermission.body.data.id;
    await expect(mutations.getPermission({ sessionID: session.id, requestID: permissionID })).resolves.toMatchObject({ id: permissionID, action: "qualification" });
    await mutations.replyPermission({ sessionID: session.id, requestID: permissionID, decision: "once" });
    const secondPermission = await native.api("POST", permissionRoute, { action: "qualification", resources: ["second"] });
    const cascadingPermission = await native.api("POST", permissionRoute, { action: "qualification", resources: ["third"] });
    expect(secondPermission.status).toBe(200); expect(cascadingPermission.status).toBe(200);
    await mutations.replyPermission({ sessionID: session.id, requestID: secondPermission.body.data.id, decision: "reject" });
    await expect(api.getInteractions(session.id)).resolves.toEqual({ permissions: [], forms: [] });

    const parked = await mutations.prompt({ sessionID: session.id, id: "msg_cancelled", text: "parked", delivery: "queue", resume: false });
    expect(parked).toMatchObject({ id: "msg_cancelled", sessionID: session.id, type: "user", payload: { text: "parked" } });
    await mutations.cancelInput({ sessionID: session.id, inboxID: parked.id });
    expect(model.requestCount).toBe(0);
    await expect(api.getPending(session.id)).resolves.toEqual([]);
    await mutations.prompt({ sessionID: session.id, id: "msg_consumed", text: "baseline", delivery: "queue", resume: true });
    await vi.waitFor(async () => expect((await api.getHistoryPage(session.id, { order: "desc", limit: 1 })).data[0]?.type).toBe("idle"), { timeout: 20_000, interval: 25 });
    await expect(api.getMessage(session.id, "msg_consumed")).resolves.toMatchObject({ type: "user", text: "baseline" });

    const form = await native.api("POST", `/api/session/${session.id}/form`, { title: "Native question", fields: [{ key: "answer", type: "string" }] });
    expect(form.status).toBe(200);
    const formID: string = form.body.data.id;
    await expect(mutations.getForm({ sessionID: session.id, formID })).resolves.toMatchObject({ state: { status: "pending" } });
    await mutations.replyForm({ sessionID: session.id, formID, answer: { answer: "confirmed" } });
    await expect(mutations.getForm({ sessionID: session.id, formID })).resolves.toMatchObject({ state: { status: "answered", answer: { answer: "confirmed" } } });
    const toCancel = await native.api("POST", `/api/session/${session.id}/form`, { title: "Cancel question", fields: [{ key: "answer", type: "string" }] });
    expect(toCancel.status).toBe(200);
    await mutations.cancelForm({ sessionID: session.id, formID: toCancel.body.data.id });
    await expect(mutations.getForm({ sessionID: session.id, formID: toCancel.body.data.id })).resolves.toMatchObject({ state: { status: "cancelled" } });

    await mutations.prompt({ sessionID: session.id, id: "msg_erased", text: "never consumed", delivery: "queue", resume: false });
    expect((await native.api("POST", `/api/session/${session.id}/revert/stage`, { messageID: "msg_consumed", files: false })).status).toBe(200);
    expect((await native.api("POST", `/api/session/${session.id}/revert/commit`)).status).toBe(204);
    await expect(api.getPending(session.id)).resolves.toEqual([]);
    await expect(api.getMessage(session.id, "msg_erased")).rejects.toThrow("opencode_native_not_found");
    await expect(api.getMessage(session.id, "msg_consumed")).rejects.toThrow("opencode_native_not_found");
    await mutations.cancelInput({ sessionID: session.id, inboxID: "msg_erased" }); // exact no-op acknowledgment
    const events = observation.drain().map(value => value.event);
    expect(events.some(event => event.type === "session.inbox.cancelled" && event.data.inboxID === "msg_cancelled")).toBe(true);
    expect(events.some(event => event.type === "session.inbox.delivered" && event.data.inboxID === "msg_consumed")).toBe(true);
    expect(events.some(event => event.type === "session.inbox.delivered" && event.data.inboxID === "msg_erased")).toBe(false);
    expect(events.some(event => event.type === "session.inbox.cancelled" && event.data.inboxID === "msg_erased")).toBe(false);
    expect(events.some(event => event.type === "session.revert.committed" && event.data.to === "msg_consumed")).toBe(true);
    const cut = await readOpenCodeNativeLog(client, { sessionID: session.id });
    expect(cut.watermark).toBeGreaterThan(0);
    expect(cut.events).toEqual([]);
    expect(cut.sequenceGaps).toEqual([{ after: -1, through: cut.watermark }]);
    const afterZero = await readOpenCodeNativeLog(client, { sessionID: session.id, after: 0 });
    expect(afterZero).toMatchObject({ watermark: cut.watermark, events: [], sequenceGaps: [{ after: 0, through: cut.watermark }] });
    expect(model.requestCount).toBe(1);
  } finally {
    await observation?.close(); client?.close();
    try { await native.stop(); } finally { await model.stop(); }
  }
});
