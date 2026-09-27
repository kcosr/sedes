import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormDetail, FormInfo, PermissionRequest } from "@opencode/client";
import type { InteractionResponseInput } from "../../src/server/backends/contracts.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeInteractions } from "../../src/server/backends/opencode/opencode-interactions.js";
import { OpenCodeMutationEvidenceRepository } from "../../src/server/backends/opencode/opencode-mutation-evidence.js";
import { parseOpenCodeNativeEvent } from "../../src/server/backends/opencode/opencode-native-api.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const permission = (id = "per_owned"): PermissionRequest => ({ id, sessionID: "ses_fixture", action: "write", resources: ["/fixture/workspace/file"] });
const form = (id = "frm_owned"): FormDetail => ({ id, sessionID: "ses_fixture", title: "Name", fields: [{ key: "name", type: "string", required: true }], state: { status: "pending" } });
function fixture() {
  const wire = createOpenCodeApiFixture(); const permissions = new Map<string, PermissionRequest>(); const forms = new Map<string, FormDetail>();
  const requests: { path: string; method: string; body?: any }[] = [];
  let lose = false; let settle = true; let beforeEffect: (() => void) | undefined;
  let held: { path: string; wait: Promise<void>; entered(): void } | undefined;
  const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture-only-canary", fetch: async (value, init) => {
    const url = new URL(String(value)); const method = init?.method ?? "GET";
    if (!url.pathname.includes("/permission") && !url.pathname.includes("/form")) return wire.fetch(value, init);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ path: url.pathname, method, ...(body === undefined ? {} : { body }) });
    if (held?.path === url.pathname) { const wait = held; wait.entered(); await wait.wait; init?.signal?.throwIfAborted(); }
    const pieces = url.pathname.split("/"); const id = pieces[5]; const permissionRoute = pieces[4] === "permission";
    if (!id) return json(permissionRoute ? [...permissions.values()] : [...forms.values()].filter(item => item.state.status === "pending").map(({ state: _state, ...request }) => request));
    const item = permissionRoute ? permissions.get(id) : forms.get(id);
    if (!item) return new Response(JSON.stringify({ _tag: permissionRoute ? "PermissionNotFoundError" : "FormNotFoundError", sessionID: "ses_fixture",
      ...(permissionRoute ? { requestID: id } : { formID: id }), message: "missing" }), { status: 404, headers: { "content-type": "application/json" } });
    if (method === "GET") return json(item);
    beforeEffect?.();
    if (settle) {
      if (permissionRoute) { if (body.decision === "reject") permissions.clear(); else permissions.delete(id); }
      else (item as FormDetail).state = method === "DELETE" ? { status: "cancelled" } : { status: "answered", answer: body.answer };
    }
    if (lose) throw new Error("fixture response lost");
    return new Response(null, { status: 204 });
  } });
  const native = createOpenCodeConversationFixture({ native: { client, sessionID: wire.sessionID, directory: wire.directory } });
  const lease = native.runtime.acquire(); const lifetime = new AbortController(); const events = vi.fn();
  const controllers: OpenCodeInteractions[] = [];
  const create = (generation = "runtime-binding-generation") => {
    const controller = new OpenCodeInteractions(native.context, native.target, native.runtime, lease, lifetime.signal, generation, events);
    controllers.push(controller); return controller;
  };
  const controller = create();
  const effects = () => requests.filter(request => request.method !== "GET");
  const response = (kind: "permission" | "form", operationId = "response"): InteractionResponseInput => {
    const gate = controller.snapshotInteractions().find(item => item.kind === (kind === "permission" ? "decision" : "form"))!;
    return kind === "permission" ? { applicationOperationId: operationId, interactionId: gate.backendInteractionId, kind: "decision", selectedActionId: "allow_once" }
      : { applicationOperationId: operationId, interactionId: gate.backendInteractionId, kind: "form", answers: [{ fieldId: "field_0", value: "Ada" }] };
  };
  cleanups.push(async () => { lifetime.abort(); controllers.forEach(controller => controller.close()); lease.release(); await native.dispose(); });
  return { ...native, wire, permissions, forms, requests, effects, lease, lifetime, events, controller, create, response,
    lose: (value = true) => { lose = value; }, settle: (value: boolean) => { settle = value; }, beforeEffect: (callback: () => void) => { beforeEffect = callback; },
    hold: (path: string) => { let entered!: () => void; let release!: () => void; const observed = new Promise<void>(resolve => { entered = resolve; });
      held = { path, entered, wait: new Promise<void>(resolve => { release = resolve; }) }; return { entered: observed, release: () => { held = undefined; release(); } }; },
    receipt: (id = "response") => native.repository.readOperation(scope, threadID, id, "interaction") };
}

describe("OpenCode exact interaction controller", () => {
  it("maps pending gates with stable identity and openedAt, then resolves external settlements without receipts", async () => {
    const f = fixture(); f.permissions.set("per_owned", permission()); f.forms.set("frm_owned", form());
    await f.controller.refresh(); const before = f.controller.snapshotInteractions(); await f.controller.refresh();
    expect(f.controller.snapshotInteractions()).toEqual(before);
    expect(f.events.mock.calls.filter(([event]) => event.type === "interaction_opened")).toHaveLength(2);
    f.permissions.clear(); await f.controller.refresh();
    expect(f.controller.snapshotInteractions()).toHaveLength(1);
    expect(f.events).toHaveBeenCalledWith({ type: "interaction_resolved", backendInteractionId: before.find(item => item.kind === "decision")!.backendInteractionId });
    expect(f.receipt()).toBeUndefined(); expect(f.effects()).toHaveLength(0);
  });

  it("persists immutable native intent before a once reply and accepts exact 204 only once", async () => {
    const f = fixture(); f.permissions.set("per_owned", permission()); await f.controller.refresh(); const response = f.response("permission");
    f.beforeEffect(() => {
      expect(f.receipt()).toMatchObject({ disposition: "dispatched", operationKind: "interaction", nativeInputId: "permission:per_owned" });
      const intent = new OpenCodeMutationEvidenceRepository(f.repository).find(scope, threadID, "response", "interaction");
      expect(intent).toMatchObject({ source: "permission", nativeId: "per_owned", nativeResponse: { kind: "permission_reply", input: { decision: "once" } } });
    });
    await f.controller.respond(response); await f.controller.respond(response);
    expect(f.effects()).toEqual([{ path: "/api/session/ses_fixture/permission/per_owned/reply", method: "POST", body: { decision: "once" } }]);
    expect(await f.controller.reconcileInteractionResponse(response)).toEqual({ outcome: "accepted" });
  });

  it("explicit deny-and-stop sends native reject without message and refreshes the same-session cascade", async () => {
    const f = fixture(); f.permissions.set("per_owned", permission()); f.permissions.set("per_second", permission("per_second"));
    await f.controller.refresh(); const input = { ...f.response("permission"), selectedActionId: "deny_and_stop" } as InteractionResponseInput;
    await f.controller.respond(input); await f.controller.refresh();
    expect(f.effects()).toHaveLength(1); expect(f.effects()[0]!.body).toEqual({ decision: "reject" });
    expect(f.controller.snapshotInteractions()).toEqual([]);
    expect(f.database.prepare("SELECT count(*) AS count FROM opencode_operation_receipts WHERE operation_kind='interaction'").get()).toEqual({ count: 1 });
  });

  it("refuses automatic permission cancellation with a bounded notice before reserving or dispatching anything", async () => {
    const f = fixture(); f.permissions.set("per_owned", permission()); await f.controller.refresh();
    const input = { ...f.response("permission"), kind: "cancel" } as Record<string, unknown>; delete input.selectedActionId;
    await expect(f.controller.respond(input as InteractionResponseInput)).rejects.toMatchObject({ backendCode: "opencode_permission_cancel_unsupported", crossedSubmissionBoundary: false });
    expect(f.effects()).toHaveLength(0); expect(f.receipt()).toBeUndefined(); expect(f.controller.snapshotInteractions()).toHaveLength(1);
    expect(f.events.mock.calls.some(([event]) => event.type === "notice" && event.notice.message.text.includes("remains pending"))).toBe(true);
  });

  it.each(["answer", "cancel"])("reconciles a lost form %s only from exact terminal native state without repeating it", async mode => {
    const f = fixture(); f.forms.set("frm_owned", form()); await f.controller.refresh(); const original = f.response("form");
    const input: InteractionResponseInput = mode === "answer" ? original : { applicationOperationId: "response", interactionId: original.interactionId, kind: "cancel" };
    f.lose(); await expect(f.controller.respond(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(f.receipt()).toMatchObject({ disposition: "unknown" });
    expect(await f.controller.reconcileInteractionResponse(input)).toEqual({ outcome: "accepted" });
    await f.controller.respond(input); expect(f.effects()).toHaveLength(1);
  });

  it("does not infer lost permission response acceptance from disappearance", async () => {
    const f = fixture(); f.permissions.set("per_owned", permission()); await f.controller.refresh(); const input = f.response("permission");
    f.lose(); await expect(f.controller.respond(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(f.permissions.size).toBe(0); expect(await f.controller.reconcileInteractionResponse(input)).toEqual({ outcome: "unknown" });
    await expect(f.controller.respond(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true }); expect(f.effects()).toHaveLength(1);
  });

  it.each(["different_answer", "changed_request", "gone", "pending"])("leaves lost form response unknown for %s", async mode => {
    const f = fixture(); f.forms.set("frm_owned", form()); await f.controller.refresh(); const input = f.response("form");
    f.lose(); await expect(f.controller.respond(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    if (mode === "different_answer") f.forms.get("frm_owned")!.state = { status: "answered", answer: { name: "Else" } };
    if (mode === "changed_request") f.forms.set("frm_owned", { ...form(), title: "Different", state: { status: "answered", answer: { name: "Ada" } } });
    if (mode === "gone") f.forms.clear();
    if (mode === "pending") f.forms.get("frm_owned")!.state = { status: "pending" };
    expect(await f.controller.reconcileInteractionResponse(input)).toEqual({ outcome: "unknown" }); expect(f.effects()).toHaveLength(1);
  });

  it("rechecks native request fingerprint before effect and rejects invalid or wrong interaction responses", async () => {
    const f = fixture(); f.forms.set("frm_owned", form()); await f.controller.refresh(); const input = f.response("form");
    f.forms.set("frm_owned", { ...form(), fields: [{ key: "other", type: "string" }] });
    await expect(f.controller.respond(input)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    await expect(f.controller.respond({ ...input, interactionId: "foreign" })).rejects.toThrow();
    await expect(f.controller.respond({ ...input, kind: "decision", selectedActionId: "allow_once" } as never)).rejects.toThrow();
    expect(f.effects()).toHaveLength(0); expect(f.receipt()).toBeUndefined();
  });

  it("rejects changed response payload even while the first exact request read is in flight", async () => {
    const f = fixture(); f.forms.set("frm_owned", form()); await f.controller.refresh(); const input = f.response("form");
    const held = f.hold("/api/session/ses_fixture/form/frm_owned"); const sending = f.controller.respond(input); await held.entered;
    await expect(f.controller.respond({ ...input, answers: [{ fieldId: "field_0", value: "Changed" }] } as InteractionResponseInput)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    held.release(); await sending; expect(f.effects()).toHaveLength(1);
    await expect(f.controller.respond({ ...input, answers: [{ fieldId: "field_0", value: "Changed" }] } as InteractionResponseInput)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
  });

  it("recovers a dispatched form receipt after reattachment and fences old normalized response IDs from new generations", async () => {
    const f = fixture(); f.forms.set("frm_owned", form()); await f.controller.refresh(); const input = f.response("form");
    f.lose(); await expect(f.controller.respond(input)).rejects.toThrow(); f.controller.close();
    const next = f.create("new-runtime-generation");
    expect(await next.reconcileInteractionResponse(input)).toEqual({ outcome: "accepted" });
    f.forms.set("frm_new", form("frm_new")); await next.refresh();
    await expect(next.respond({ ...input, applicationOperationId: "new-operation" })).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.effects()).toHaveLength(1);
  });

  it("automatically cancels only an unsupported owned form once, retaining unknown after response loss and restart", async () => {
    const f = fixture(); f.forms.set("frm_owned", { ...form(), fields: [{ key: "value", type: "string", pattern: "^x$" }] });
    f.lose(); f.settle(false); await f.controller.refresh();
    await vi.waitFor(() => expect(f.effects()).toHaveLength(1));
    await vi.waitFor(() => expect(f.database.prepare("SELECT disposition FROM opencode_operation_receipts WHERE operation_kind='interaction'").get()).toEqual({ disposition: "unknown" }));
    await f.controller.refresh(); f.controller.close(); const next = f.create("new-generation"); await next.refresh();
    expect(f.effects()).toHaveLength(1); expect(f.effects()[0]).toMatchObject({ method: "DELETE", path: "/api/session/ses_fixture/form/frm_owned" });
    expect(next.snapshotInteractions()).toEqual([]); expect(f.events.mock.calls.some(([event]) => event.type === "notice")).toBe(true);
  });

  it("does not answer or cancel global forms or foreign-session permissions", async () => {
    const f = fixture(); const global: FormInfo = { ...form(), sessionID: "global" }; delete (global as Partial<FormDetail>).state;
    f.controller.observe(parseOpenCodeNativeEvent({ id: "evt_global", created: 1, type: "form.created", data: { form: global } }));
    await f.controller.refresh({ forms: [global], permissions: [{ ...permission(), sessionID: "ses_foreign" }] });
    expect(f.controller.snapshotInteractions()).toEqual([]); expect(f.effects()).toHaveLength(0);
    expect(f.events.mock.calls.filter(([event]) => event.type === "notice").length).toBeGreaterThan(0);
  });

  it("observes nested form ownership and refreshes independently of transcript hydration", async () => {
    const f = fixture(); const detail = form(); f.forms.set(detail.id, detail); const { state: _state, ...request } = detail;
    f.controller.observe(parseOpenCodeNativeEvent({ id: "evt_form", created: 1, type: "form.created", data: { form: request } }));
    await vi.waitFor(() => expect(f.controller.snapshotInteractions()).toHaveLength(1));
    expect(f.requests.some(request => request.path.endsWith("/form"))).toBe(true);
    expect(f.wire.requests.some(request => request.pathname.endsWith("/message"))).toBe(false);
  });

  it("aborts lifetime while validation is waiting without dispatching a delayed response", async () => {
    const f = fixture(); f.forms.set("frm_owned", form()); await f.controller.refresh(); const input = f.response("form");
    const held = f.hold("/api/session/ses_fixture/form/frm_owned"); const sending = f.controller.respond(input); const rejected = expect(sending).rejects.toThrow();
    await held.entered; f.lifetime.abort(); held.release(); await rejected;
    expect(f.effects()).toHaveLength(0); expect(f.receipt()).toBeUndefined();
  });

  it("rechecks live runtime identity after the native request read before reserving or dispatching", async () => {
    const f = fixture(); f.forms.set("frm_owned", form()); await f.controller.refresh(); const input = f.response("form");
    const held = f.hold("/api/session/ses_fixture/form/frm_owned");
    const sending = f.controller.respond(input); const rejected = expect(sending).rejects.toThrow("identity changed");
    await held.entered; vi.spyOn(f.runtime, "assertCurrent").mockRejectedValue(new Error("identity changed")); held.release(); await rejected;
    expect(f.effects()).toHaveLength(0); expect(f.receipt()).toBeUndefined();
  });

  it("keeps the outcome unknown when runtime identity changes before the response acknowledgement is admitted", async () => {
    const f = fixture(); f.forms.set("frm_owned", form()); await f.controller.refresh(); const input = f.response("form");
    f.beforeEffect(() => { vi.spyOn(f.runtime, "assertCurrent").mockRejectedValue(new Error("identity changed")); });
    await expect(f.controller.respond(input)).rejects.toMatchObject({ backendCode: "opencode_interaction_response_unknown", crossedSubmissionBoundary: true });
    expect(f.effects()).toHaveLength(1); expect(f.receipt()).toMatchObject({ disposition: "unknown" });
    expect(await f.controller.reconcileInteractionResponse(input)).toEqual({ outcome: "unknown" });
  });
});
