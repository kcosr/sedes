import { createOpenCodeNativePortFixture, openCodeTestMutationControl } from "../helpers/opencode-native-port-fixture.js";
import { expect, it, vi } from "vitest";
import type { BackendConversationEvent, DriverInteraction } from "../../src/shared/protocol/backend.js";
import type { ConversationHandle, SubmitTurnInput } from "../../src/server/backends/contracts.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeInputEvidenceRepository } from "../../src/server/backends/opencode/opencode-input-evidence.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OpenCodeNativeMutations } from "../../src/server/backends/opencode/opencode-native-mutations.js";
import { qualifiedOpenCodeModelId } from "../../src/server/backends/opencode/opencode-model-selection.js";
import { boundedOpenCodeProcessFile } from "../../src/server/backends/opencode/opencode-native-identity.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";
import { RUN_REAL_OPENCODE, startOpencodeNativeFixture } from "../support/opencode-native-fixture.js";
import { startOpencodeModelFixture } from "../support/opencode-model-fixture.js";

it.runIf(RUN_REAL_OPENCODE)("qualifies production handle input, steering, Stop, actions and exact native interaction responses", async () => {
  const model = await startOpencodeModelFixture();
  let native: Awaited<ReturnType<typeof startOpencodeNativeFixture>> | undefined;
  let current: ReturnType<typeof createOpenCodeConversationFixture> | undefined;
  let client: OpenCodeHttpClient | undefined; let handle: ConversationHandle | undefined;
  const holds: ReturnType<typeof model.holdNextStream>[] = [];
  const calls: { path: string; method: string }[] = [];
  const events: BackendConversationEvent[] = []; const consumed = vi.fn();
  let dropPromptAck = true;
  const submit = (id: string, text: string): SubmitTurnInput => ({ applicationOperationId: id, mutationId: id,
    reconciliationToken: id, source: { kind: "user" }, text, contextExcerpts: [], taskContexts: [], attachments: [] });
  const pendingInteraction = (kind: DriverInteraction["kind"], title?: string) => {
    const resolved = new Set(events.filter(event => event.type === "interaction_resolved").map(event => event.backendInteractionId));
    return events.filter(event => event.type === "interaction_opened").map(event => event.interaction)
      .find(interaction => interaction.kind === kind && !resolved.has(interaction.backendInteractionId) && (!title || interaction.title.text.includes(title)));
  };
  try {
    native = await startOpencodeNativeFixture({ config: model.config });
    const environment = (await boundedOpenCodeProcessFile(`/proc/${native.pid}/environ`, 1_048_576)).toString("utf8");
    const password = environment.split("\0").find(entry => entry.startsWith("OPENCODE_PASSWORD="))?.slice("OPENCODE_PASSWORD=".length);
    if (!password) throw new Error("isolated native credential unavailable");
    client = new OpenCodeHttpClient({ endpoint: native.url, password, fetch: async (value, init) => {
      const url = new URL(String(value)); const method = init?.method ?? "GET"; calls.push({ path: url.pathname, method });
      const response = await fetch(value, init);
      if (dropPromptAck && method === "POST" && url.pathname.endsWith("/prompt")) {
        dropPromptAck = false; await response.arrayBuffer(); throw new Error("qualification dropped the exact native prompt acknowledgement");
      }
      return response;
    } });
    const port = createOpenCodeNativePortFixture(client, { directory: native.workspace, sessionID: "ses_execution_handle" });
    const api = new OpenCodeNativeApi(port); const mutations = new OpenCodeNativeMutations(port);
    const session = await mutations.createSession({ id: "ses_execution_handle", title: "Execution handle qualification",
      location: { directory: native.workspace }, model: { providerID: "probe", id: "probe-model" },
      permissions: [{ action: "qualification", resource: "*", effect: "ask" }] }, openCodeTestMutationControl("create"));
    await vi.waitFor(async () => expect((await mutations.listModels(native!.workspace)).some(item => item.id === "probe-model")).toBe(true), { timeout: 20_000, interval: 25 });
    current = createOpenCodeConversationFixture({ native: { client, sessionID: session.id, directory: native.workspace } });
    current.context.settings.updateDesired(scope, threadID, { expectedRevision: 0, desired: { providerID: "probe", id: "probe-model" }, now: Date.now() });
    handle = await current.driver.attach({ ...current.target, onSubmissionObserved: consumed });
    handle.subscribe(event => events.push(event));
    await handle.establishProjection({ signal: new AbortController().signal });
    expect(await handle.backendCapabilities()).toMatchObject({ deliveryModes: ["submit", "steer"], steerTarget: "conversation" });

    const held = model.holdNextStream("held production handle prompt"); holds.push(held);
    const first = submit("native-handle-first", "held production handle prompt");
    await expect(handle.submit(first)).resolves.toMatchObject({ accepted: true, reconciliationToken: first.applicationOperationId });
    await held.started;
    await vi.waitFor(() => expect(consumed).toHaveBeenCalledWith({ backendCorrelation: first.applicationOperationId }), { timeout: 10_000, interval: 25 });
    // The model remains held: native consumption, not its final response, is the acceptance boundary.
    await expect(handle.submit(first)).resolves.toMatchObject({ accepted: true });
    expect(calls.filter(call => call.path.endsWith("/prompt") && call.method === "POST")).toHaveLength(1);
    const evidence = new OpenCodeInputEvidenceRepository(current.repository);
    expect(evidence.get(scope, threadID, first.applicationOperationId, "submit").consumedFingerprint).not.toBeNull();

    for (const id of ["native-handle-steer-one", "native-handle-steer-two"]) {
      await expect(handle.steer({ ...submit(id, id), target: { kind: "conversation" } })).resolves.toMatchObject({ status: "pending_materialization" });
    }
    expect((await api.getPending(session.id)).filter(item => item.type === "user")).toHaveLength(2);
    const stop = { applicationOperationId: "native-handle-stop", deadlineAt: Date.now() + 30_000 };
    await handle.interrupt(stop); await expect(handle.reconcileInterrupt(stop)).resolves.toEqual({ outcome: "accepted" });
    held.release();
    await vi.waitFor(async () => {
      expect(await api.getPending(session.id)).toEqual([]);
      for (const id of ["native-handle-steer-one", "native-handle-steer-two"]) {
        expect(evidence.get(scope, threadID, id, "steer").withdrawalKind).toBe("cancelled");
      }
    }, { timeout: 15_000, interval: 25 });
    for (const id of ["native-handle-steer-one", "native-handle-steer-two"]) {
      expect(await current.driver.reconcileSubmission({ ...current.target, applicationOperationId: id, reconciliationToken: id,
        steerTarget: { kind: "conversation" } })).toMatchObject({ status: "not_accepted", retryable: false });
    }
    const interrupts = calls.filter(call => call.path.endsWith("/interrupt") && call.method === "POST").length;
    await handle.interrupt(stop); expect(calls.filter(call => call.path.endsWith("/interrupt") && call.method === "POST")).toHaveLength(interrupts);

    const rename = { applicationOperationId: "native-handle-rename", action: "rename" as const, title: "Renamed by production handle" };
    await expect(handle.perform(rename)).resolves.toEqual({ accepted: true }); await expect(handle.reconcileAction(rename)).resolves.toEqual({ outcome: "accepted" });
    expect((await api.getSession(session.id)).title).toBe(rename.title);
    await handle.perform({ applicationOperationId: "native-handle-model", action: "set_model", provider: current.context.connection.id,
      modelId: qualifiedOpenCodeModelId({ providerID: "probe", id: "second-model" }) });
    expect((await api.getSession(session.id)).model).toEqual({ providerID: "probe", id: "second-model", variant: "default" });

    const permission = await native.api("POST", `/api/session/${session.id}/permission`, { action: "qualification", resources: ["handle"] });
    expect(permission.status).toBe(200);
    await vi.waitFor(() => expect(pendingInteraction("decision")).toBeDefined(), { timeout: 10_000, interval: 25 });
    const permissionGate = pendingInteraction("decision")!;
    await expect(handle.respond({ applicationOperationId: "native-handle-permission-cancel", interactionId: permissionGate.backendInteractionId, kind: "cancel" }))
      .rejects.toMatchObject({ backendCode: "opencode_permission_cancel_unsupported", crossedSubmissionBoundary: false });
    expect((await api.getInteractions(session.id)).permissions).toHaveLength(1);
    const answerPermission = { applicationOperationId: "native-handle-permission", interactionId: permissionGate.backendInteractionId,
      kind: "decision" as const, selectedActionId: "allow_once" };
    await handle.respond(answerPermission); await expect(handle.reconcileInteractionResponse(answerPermission)).resolves.toEqual({ outcome: "accepted" });
    expect((await api.getInteractions(session.id)).permissions).toEqual([]);

    const question = await native.api("POST", `/api/session/${session.id}/form`, { title: "Handle native question", fields: [{ key: "name", type: "string", required: true }] });
    expect(question.status).toBe(200);
    await vi.waitFor(() => expect(pendingInteraction("form", "Handle native question")).toBeDefined(), { timeout: 10_000, interval: 25 });
    const answerForm = { applicationOperationId: "native-handle-form", interactionId: pendingInteraction("form", "Handle native question")!.backendInteractionId,
      kind: "form" as const, answers: [{ fieldId: "field_0", value: "Ada" }] };
    await handle.respond(answerForm); await expect(handle.reconcileInteractionResponse(answerForm)).resolves.toEqual({ outcome: "accepted" });
    expect(await mutations.getForm({ sessionID: session.id, formID: question.body.data.id })).toMatchObject({ state: { status: "answered", answer: { name: "Ada" } } });
    const unsupported = await native.api("POST", `/api/session/${session.id}/form`, { title: "Unsupported exact form", fields: [{ key: "value", type: "string", pattern: "^x$" }] });
    expect(unsupported.status).toBe(200);
    await vi.waitFor(async () => expect(await mutations.getForm({ sessionID: session.id, formID: unsupported.body.data.id }))
      .toMatchObject({ state: { status: "cancelled" } }), { timeout: 10_000, interval: 25 });
    expect(events.some(event => event.type === "notice" && event.notice.message.text.includes("cannot represent"))).toBe(true);

    // Admission and exact receipt recovery survive a closed presentation. No prompt is replayed.
    await handle.close(); handle = undefined;
    expect(await current.driver.reconcileSubmission({ ...current.target, applicationOperationId: first.applicationOperationId,
      reconciliationToken: first.applicationOperationId })).toEqual({ status: "accepted" });
    expect(calls.filter(call => call.path.endsWith("/prompt") && call.method === "POST")).toHaveLength(3);
    expect(model.requestCount).toBe(1);
  } finally {
    holds.forEach(hold => hold.release()); await handle?.close();
    try { await current?.dispose(); } finally {
      client?.close(); try { await native?.stop(); } finally { await model.stop(); }
    }
  }
}, 90_000);
