import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "@opencode/client";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeNativeMutations, OpenCodeNativeMutationInputError } from "../../src/server/backends/opencode/opencode-native-mutations.js";

const clients: OpenCodeHttpClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
const session = { id: "ses_owned", projectID: "prj_local", title: "Local", location: { directory: "/workspace" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } };
const admission = { id: "msg_reserved", sessionID: "ses_owned", type: "user", delivery: "queue",
  payload: { text: "prepared by hook", metadata: { native: true } }, time: { created: 2 } };
const model: ModelInfo = { providerID: "provider/slash", id: "model", modelID: "routed-model", name: "Model", status: "active", enabled: true,
  capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], time: { released: 1 }, cost: [], limit: { context: 100, output: 10 } };
function fixture(status = 204, body?: unknown) {
  const requests: { path: string; method: string; query: URLSearchParams; body: unknown }[] = [];
  let nextStatus = status, nextBody = body;
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${Buffer.from("opencode:fixture").toString("base64")}`);
    requests.push({ path: url.pathname, method: init?.method ?? "GET", query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(nextStatus === 204 ? null : JSON.stringify(nextBody), { status: nextStatus, headers: { "content-type": "application/json" } });
  });
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch }); clients.push(client);
  return { api: new OpenCodeNativeMutations(client), client, requests, fetch,
    respond(status: number, body?: unknown) { nextStatus = status; nextBody = body; } };
}
describe("OpenCode typed native mutation boundary", () => {
  it("reserves exact create identity and workspace and validates its official response", async () => {
    const { api, requests, respond } = fixture(200, { data: session });
    await expect(api.createSession({ id: session.id, location: session.location, title: "Local", model: { providerID: "provider", id: "model" } })).resolves.toEqual(session);
    expect(requests[0]).toMatchObject({ path: "/api/session", method: "POST", body: { id: session.id, location: session.location } });
    respond(200, { data: { ...session, id: "ses_other" } });
    await expect(api.createSession({ id: session.id, location: session.location })).rejects.toThrow("opencode_native_protocol_invalid");
    respond(200, { data: { ...session, location: { directory: "/other" } } });
    await expect(api.createSession({ id: session.id, location: session.location })).rejects.toThrow("opencode_native_protocol_invalid");
  });
  it("retains required input ID, delivery and resume while allowing native prompt preparation", async () => {
    const { api, requests } = fixture(200, { data: admission });
    await expect(api.prompt({ sessionID: session.id, id: admission.id, text: "original", delivery: "queue", resume: true })).resolves.toEqual(admission);
    expect(requests[0]).toMatchObject({ path: "/api/session/ses_owned/prompt", method: "POST", body: {
      id: "msg_reserved", text: "original", delivery: "queue", resume: true } });
  });
  it.each([
    { ...admission, id: "msg_foreign" }, { ...admission, sessionID: "ses_foreign" },
    { ...admission, extra: true }, { ...admission, payload: { text: 2 } },
  ])("rejects malformed or mismatched admission after dispatch", async result => {
    const { api, requests } = fixture(200, { data: result });
    await expect(api.prompt({ sessionID: session.id, id: admission.id, text: "original", delivery: "queue", resume: true })).rejects.toThrow("opencode_native_protocol_invalid");
    expect(requests).toHaveLength(1);
  });
  it("rejects unsupported or malformed input before any native request", async () => {
    const { api, requests } = fixture();
    const malformed: Parameters<OpenCodeNativeMutations["prompt"]>[0][] = [
      { sessionID: "ses_owned", id: "msg_id", text: "x", delivery: "queue" } as never,
      { sessionID: "ses_owned", id: "msg_id/path", text: "x", delivery: "queue", resume: true },
      { sessionID: "ses_owned", id: "msg_id", text: "x", delivery: "queue", resume: true, extra: true } as never,
      { sessionID: "ses_owned", id: "msg_id", text: "x", delivery: "queue", resume: true, metadata: { bad: Infinity } },
    ];
    for (const input of malformed) await expect(api.prompt(input)).rejects.toBeInstanceOf(OpenCodeNativeMutationInputError);
    await expect(api.createSession({ id: "ses_owned", location: { directory: "relative" } })).rejects.toBeInstanceOf(OpenCodeNativeMutationInputError);
    await expect(api.renameSession("ses_owned", " ")).rejects.toBeInstanceOf(OpenCodeNativeMutationInputError);
    await expect(api.replyPermission({ sessionID: "ses_owned", requestID: "per_id", decision: "always" } as never)).rejects.toBeInstanceOf(OpenCodeNativeMutationInputError);
    await expect(api.replyPermission({ sessionID: "ses_owned", requestID: "per_id", decision: "reject", message: "changes rejection semantics" } as never)).rejects.toBeInstanceOf(OpenCodeNativeMutationInputError);
    expect(requests).toHaveLength(0);
  });
  it("takes immutable JSON inputs without executing accessors or toJSON", async () => {
    const { api, requests } = fixture(); const getter = vi.fn(() => "side effect");
    const input = { sessionID: "ses_owned", id: "msg_id", delivery: "queue", resume: true };
    Object.defineProperty(input, "text", { enumerable: true, get: getter });
    await expect(api.prompt(input as never)).rejects.toBeInstanceOf(OpenCodeNativeMutationInputError);
    expect(getter).not.toHaveBeenCalled(); expect(requests).toHaveLength(0);
  });
  it("treats exact 204 cancel/model/rename responses only as acknowledgments", async () => {
    const { api, requests } = fixture();
    await api.cancelInput({ sessionID: "ses_owned", inboxID: "msg_reserved" });
    await api.setModel({ sessionID: "ses_owned", model: { providerID: "provider", id: "model", variant: "high" } });
    await api.renameSession("ses_owned", "New title");
    expect(requests.map(({ path, method }) => [path, method])).toEqual([
      ["/api/session/ses_owned/inbox/msg_reserved", "DELETE"], ["/api/session/ses_owned/model", "POST"], ["/api/session/ses_owned", "PATCH"],
    ]);
  });
  it("never classifies generic 404, malformed errors or transport loss as non-acceptance", async () => {
    const { api, respond, fetch } = fixture(404, { _tag: "SessionNotFoundError", sessionID: "ses_foreign", message: "private" });
    await expect(api.cancelInput({ sessionID: "ses_owned", inboxID: "msg_reserved" })).rejects.toMatchObject({ code: "opencode_request_failed" });
    respond(400, { _tag: "UnknownError", message: "private" });
    await expect(api.cancelInput({ sessionID: "ses_owned", inboxID: "msg_reserved" })).rejects.toMatchObject({ code: "opencode_request_failed" });
    fetch.mockRejectedValueOnce(new Error("transport private detail"));
    await expect(api.cancelInput({ sessionID: "ses_owned", inboxID: "msg_reserved" })).rejects.toMatchObject({ code: "opencode_request_failed" });
  });
  it("validates scoped catalogs and normalizes the official null default", async () => {
    const { api, requests, respond } = fixture(200, { location: session.location, data: [model] });
    await expect(api.listModels("/workspace")).resolves.toEqual([model]);
    expect(requests[0]!.query.get("location[directory]")).toBe("/workspace");
    respond(200, { location: session.location, data: model });
    await expect(api.getDefaultModel("/workspace")).resolves.toEqual(model);
    respond(200, { location: session.location, data: null });
    await expect(api.getDefaultModel("/workspace")).resolves.toBeUndefined();
    respond(200, { location: { directory: "/other" }, data: [model] });
    await expect(api.listModels("/workspace")).rejects.toThrow("opencode_native_protocol_invalid");
    respond(200, { location: session.location, data: [model, model] });
    await expect(api.listModels("/workspace")).rejects.toThrow("opencode_native_protocol_invalid");
  });
  it("reads and replies to exact attributed permission and form requests", async () => {
    const permission = { id: "per_owned", sessionID: "ses_owned", action: "read", resources: ["/workspace"] };
    const { api, requests, respond } = fixture(200, { data: permission });
    await expect(api.getPermission({ sessionID: "ses_owned", requestID: "per_owned" })).resolves.toEqual(permission);
    respond(204); await api.replyPermission({ sessionID: "ses_owned", requestID: "per_owned", decision: "reject" });
    expect(requests.at(-1)).toMatchObject({ body: { decision: "reject" } });
    const form = { id: "frm_owned", sessionID: "ses_owned", title: "Question", fields: [{ key: "name", type: "string" }], state: { status: "pending" } };
    respond(200, { data: form });
    await expect(api.getForm({ sessionID: "ses_owned", formID: "frm_owned" })).resolves.toEqual(form);
    respond(200, { data: { ...form, sessionID: "global" } });
    await expect(api.getForm({ sessionID: "ses_owned", formID: "frm_owned" })).rejects.toThrow("opencode_native_protocol_invalid");
    respond(204); await api.replyForm({ sessionID: "ses_owned", formID: "frm_owned", answer: { name: "A" } });
    await api.cancelForm({ sessionID: "ses_owned", formID: "frm_owned" });
    expect(requests.at(-2)).toMatchObject({ path: "/api/session/ses_owned/form/frm_owned/reply", body: { answer: { name: "A" } } });
    expect(requests.at(-1)).toMatchObject({ path: "/api/session/ses_owned/form/frm_owned", method: "DELETE" });
  });
});
