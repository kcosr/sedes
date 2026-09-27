import { afterEach, describe, expect, it } from "vitest";
import type { SessionInboxCompaction } from "@opencode/client";
import { OpenCodeActions } from "../../src/server/backends/opencode/opencode-actions.js";
import { OpenCodeExecutionSettings } from "../../src/server/backends/opencode/opencode-execution-settings.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const wire = createOpenCodeApiFixture();
  const model = { providerID: "provider", id: "model-a" }; wire.session.model = model;
  const state = { pending: [] as SessionInboxCompaction[], ack: "exact" as "exact" | "lost" | "foreign", admit: true };
  const calls: { path: string; method: string; body: any }[] = [];
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch: async (value, init) => {
    const path = new URL(String(value)).pathname, method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    const nativeModel = { ...model, modelID: "model-a", package: "fixture", name: "A", enabled: true, status: "active",
      capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], time: { released: 0 }, cost: [], limit: { context: 100, output: 10 } };
    if (path === "/api/model") return json({ location: { directory: wire.directory }, data: [nativeModel] });
    if (path === "/api/model/default") return json({ location: { directory: wire.directory }, data: nativeModel });
    if (path.endsWith("/compact") && method === "POST") {
      const item: SessionInboxCompaction = { ...body, id: state.ack === "foreign" ? "msg_foreign" : body.id,
        sessionID: wire.sessionID, type: "compaction", payload: {}, time: { created: 2 } };
      if (state.admit) state.pending.push(item);
      if (state.ack === "lost") throw new Error("lost acknowledgment");
      return json({ data: item });
    }
    if (path.endsWith("/inbox") && method === "GET") return json({ data: state.pending });
    if (path.includes("/inbox/") && method === "DELETE") {
      state.pending = state.pending.filter(item => !path.endsWith(`/${item.id}`));
      return new Response(null, { status: 204 });
    }
    return wire.fetch(value, init);
  } });
  const base = createOpenCodeConversationFixture({ native: { client, sessionID: wire.sessionID, directory: wire.directory } });
  base.context.settings.updateDesired(scope, threadID, { expectedRevision: 0, desired: model, now: 1 });
  const lifetime = new AbortController();
  const settings = new OpenCodeExecutionSettings(base.context, base.target, base.runtime, client, "compact-generation", lifetime.signal);
  const actions = new OpenCodeActions(base.context, base.target, settings);
  const input = { action: "compact", applicationOperationId: "compact-operation" } as const;
  const posts = () => calls.filter(call => call.method === "POST");
  const receipt = () => base.repository.requireOperation(scope, threadID, input.applicationOperationId, "action");
  cleanup.push(async () => { lifetime.abort(); await base.dispose(); });
  return { ...base, wire, state, calls, actions, input, posts, receipt, lifetime };
}
describe("OpenCode manual compaction", () => {
  it("reserves exact native control and treats acknowledgment as admission without waiting for inference", async () => {
    const f = fixture();
    await expect(f.actions.perform(f.input)).resolves.toEqual({ accepted: true });
    expect(f.receipt()).toMatchObject({ disposition: "accepted", nativeInputId: f.state.pending[0]!.id });
    expect(f.posts()[0]!.body).toEqual({ id: f.receipt().nativeInputId, delivery: "steer" });
    await f.actions.perform(f.input); expect(f.posts()).toHaveLength(1);
  });
  it("rejects custom instructions and staged revert before native effects", async () => {
    const f = fixture();
    await expect(f.actions.perform({ ...f.input, instructions: "retain this" })).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    f.wire.session.revert = { messageID: "msg_previous" };
    await expect(f.actions.perform(f.input)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.posts()).toEqual([]); expect(f.receipt().disposition).toBe("not_applied");
  });
  it("does not coalesce or adopt a preexisting foreign compaction", async () => {
    const f = fixture(); f.state.pending.push({ id: "msg_foreign", sessionID: f.wire.sessionID, type: "compaction", payload: {}, delivery: "steer", time: { created: 1 } });
    await expect(f.actions.perform(f.input)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.posts()).toEqual([]);
  });
  it("keeps a raced foreign acknowledgment unknown and never repeats or cancels it", async () => {
    const f = fixture(); f.state.ack = "foreign";
    await expect(f.actions.perform(f.input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await expect(f.actions.reconcile(f.input)).resolves.toEqual({ outcome: "unknown" });
    await expect(f.actions.perform(f.input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await f.actions.withdrawPendingCompactions(new AbortController().signal, Date.now() + 1_000);
    expect(f.posts()).toHaveLength(1); expect(f.calls.filter(call => call.method === "DELETE")).toEqual([]);
  });
  it("recovers lost acknowledgment from exact pending control with no resend", async () => {
    const f = fixture(); f.state.ack = "lost";
    await expect(f.actions.perform(f.input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await expect(f.actions.reconcile(f.input)).resolves.toEqual({ outcome: "accepted" });
    expect(f.posts()).toHaveLength(1);
  });
  it.each(["running", "completed", "failed"] as const)("recovers exact %s native message as admission rather than success", async status => {
    const f = fixture(); f.state.ack = "lost";
    await expect(f.actions.perform(f.input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    f.state.pending = [];
    f.wire.messages.push({ id: f.receipt().nativeInputId!, type: "compaction", status, reason: "manual", time: { created: 2 },
      ...(status === "failed" ? { error: { type: "unknown", message: "Nothing to compact yet" } } : { summary: "", recent: "" }) } as never);
    await expect(f.actions.reconcile(f.input)).resolves.toEqual({ outcome: "accepted" });
    expect(f.posts()).toHaveLength(1);
  });
  it("does not infer nonacceptance from idle and absent control after lost acknowledgment", async () => {
    const f = fixture(); f.state.ack = "lost"; f.state.admit = false;
    await expect(f.actions.perform(f.input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await expect(f.actions.reconcile(f.input)).resolves.toEqual({ outcome: "unknown" });
    expect(f.posts()).toHaveLength(1);
  });
  it("withdraws only exact owned pending controls, preserving accepted admission and Stop deadline", async () => {
    const f = fixture(); await f.actions.perform(f.input);
    f.state.pending.push({ id: "msg_foreign", sessionID: f.wire.sessionID, type: "compaction", payload: {}, delivery: "queue", time: { created: 1 } });
    await f.actions.withdrawPendingCompactions(new AbortController().signal, Date.now() + 1_000);
    expect(f.calls.filter(call => call.method === "DELETE").map(call => call.path)).toEqual([`/api/session/${f.wire.sessionID}/inbox/${f.receipt().nativeInputId}`]);
    expect(f.receipt().disposition).toBe("accepted"); expect(f.state.pending.map(item => item.id)).toEqual(["msg_foreign"]);
    await expect(f.actions.withdrawPendingCompactions(new AbortController().signal, Date.now() - 1)).rejects.toThrow();
  });
});
