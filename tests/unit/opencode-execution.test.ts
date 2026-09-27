import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { ModelInfo, SessionInboxUser } from "@opencode/client";
import type { RegisteredBackendActionInput, SteerTurnInput, SubmitTurnInput } from "../../src/server/backends/contracts.js";
import { OpenCodeActions } from "../../src/server/backends/opencode/opencode-actions.js";
import { OpenCodeCliEnvironment } from "../../src/server/backends/opencode/opencode-cli-environment.js";
import { OpenCodeExecutionEnvironment } from "../../src/server/backends/opencode/opencode-execution-environment.js";
import { OpenCodeDelivery, OPENCODE_MAXIMUM_SERIALIZED_PROMPT_BYTES } from "../../src/server/backends/opencode/opencode-delivery.js";
import { OpenCodeExecutionSettings } from "../../src/server/backends/opencode/opencode-execution-settings.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeInputObserver } from "../../src/server/backends/opencode/opencode-input-observer.js";
import { OpenCodeInputEvidenceRepository } from "../../src/server/backends/opencode/opencode-input-evidence.js";
import { openCodeOperationFingerprint } from "../../src/server/backends/opencode/opencode-input-evidence.js";
import { OpenCodeMutationEvidenceRepository } from "../../src/server/backends/opencode/opencode-mutation-evidence.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";
import { mapOpenCodeConversationError } from "../../src/server/backends/opencode/opencode-conversation-error.js";
import { DomainError } from "../../src/server/domain/errors.js";
import { qualifiedOpenCodeModelId, type OpenCodeSelection } from "../../src/server/backends/opencode/opencode-model-selection.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const modelA = { providerID: "provider", id: "model-a" };
const modelB = { providerID: "provider", id: "model-b" };
const nativeModel = (selection: OpenCodeSelection): ModelInfo => ({ ...selection, modelID: `routed-${selection.id}`,
  package: "fixture:package", name: selection.id, enabled: true, status: "active", capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [], time: { released: 0 }, cost: [], limit: { context: 100, output: 10 } });

function fixture(input: { desired?: OpenCodeSelection | null; native?: OpenCodeSelection } = {}) {
  const wire = createOpenCodeApiFixture(); wire.session.model = input.native ?? modelA;
  const calls: { path: string; method: string; body?: any }[] = [];
  const state = {
    models: [nativeModel(modelA), nativeModel(modelB)], modelUpdate: true, dropModelAck: false, dropRenameAck: false,
    admission: true, consume: true, dropPromptAck: false, preparedText: undefined as string | undefined,
    pending: [] as SessionInboxUser[], postGate: undefined as Promise<void> | undefined,
  };
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch: async (value, init) => {
    const url = new URL(String(value)), path = url.pathname, method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (path === "/api/model") return json({ location: { directory: wire.directory }, data: state.models });
    if (path === "/api/model/default") return json({ location: { directory: wire.directory }, data: state.models[0] });
    if (path === `/api/session/${wire.sessionID}/model` && method === "POST") {
      if (state.modelUpdate) wire.session.model = body.model;
      if (state.dropModelAck) throw new Error("lost model acknowledgment");
      return new Response(null, { status: 204 });
    }
    if (path === `/api/session/${wire.sessionID}` && method === "PATCH") {
      wire.session.title = body.title;
      if (state.dropRenameAck) throw new Error("lost rename acknowledgment");
      return new Response(null, { status: 204 });
    }
    if (path === `/api/session/${wire.sessionID}/prompt` && method === "POST") {
      const text = state.preparedText ?? body.text;
      const skills = body.skills?.map((skill: { id: string }) => ({ id: skill.id, name: "Manual skill", text: "private prepared skill source" }));
      const files = body.files?.map((file: { uri: string; name?: string }) => ({
        mime: file.uri.slice(5, file.uri.indexOf(";")), data: file.uri.slice(file.uri.indexOf(",") + 1),
        ...(file.name ? { name: file.name } : {}), source: { type: "inline" as const },
      }));
      const admitted: SessionInboxUser = { id: body.id, sessionID: wire.sessionID, type: "user",
        payload: { text, ...(skills ? { skills } : {}), ...(files ? { files } : {}) }, delivery: body.delivery, time: { created: 10 } };
      if (state.admission) state.pending.push(admitted);
      if (state.consume) { state.pending = state.pending.filter(item => item.id !== body.id);
        wire.messages.push({ id: body.id, type: "user", text, ...(skills ? { skills } : {}), ...(files ? { files } : {}), time: { created: 10 } }); }
      if (state.postGate) await state.postGate;
      if (state.dropPromptAck) throw new Error("lost prompt acknowledgment");
      return json({ data: admitted });
    }
    if (path === `/api/session/${wire.sessionID}/inbox`) return json({ data: state.pending });
    return wire.fetch(value, init);
  } });
  const base = createOpenCodeConversationFixture({ native: { client, sessionID: wire.sessionID, directory: wire.directory } });
  if (input.desired !== null) base.context.settings.updateDesired(scope, threadID, {
    expectedRevision: 0, desired: input.desired ?? modelA, now: 1,
  });
  const attach = { ...base.target, onSubmissionObserved: vi.fn() };
  const lease = base.runtime.acquire(), lifetime = new AbortController();
  const settings = new OpenCodeExecutionSettings(base.context, attach, base.runtime, client, "execution-generation", lifetime.signal);
  const observer = new OpenCodeInputObserver(base.context, attach, base.runtime, lease, lifetime.signal);
  const actions = new OpenCodeActions(base.context, attach, settings);
  const delivery = new OpenCodeDelivery(base.context, attach, settings, observer);
  const evidence = new OpenCodeInputEvidenceRepository(base.repository);
  const submit = (operationId = "submit-operation", text = "Original input"): SubmitTurnInput => ({
    applicationOperationId: operationId, mutationId: operationId, reconciliationToken: operationId,
    source: { kind: "user" }, text, contextExcerpts: [], attachments: [], taskContexts: [],
  });
  const steer = (operationId = "steer-operation"): SteerTurnInput => ({ ...submit(operationId), target: { kind: "conversation" } });
  const action = (operationId = "model-operation", selection = modelA): RegisteredBackendActionInput => ({
    action: "set_model", applicationOperationId: operationId, provider: base.context.connection.id, modelId: qualifiedOpenCodeModelId(selection),
  });
  const posts = (suffix: string) => calls.filter(call => call.method === "POST" && call.path.endsWith(suffix));
  cleanup.push(async () => { lifetime.abort(); observer.close(); lease.release(); await base.dispose(); });
  return { ...base, wire, client, attach, calls, state, settings, observer, actions, delivery, evidence, submit, steer, action, posts };
}

function withImages(input: SubmitTurnInput, count: number, imageBytes: number) {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const bytes = Buffer.concat([png, Buffer.alloc(imageBytes - png.length)]);
  const attachments = Array.from({ length: count }, (_, index) => ({ id: randomUUID(), kind: "image" as const,
    mediaType: "image/png" as const, fileName: `image-${index}.png`, byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), agentPath: `/private/staging/image-${index}.png` }));
  return { ...input, attachments, attachmentBytes: { read: vi.fn(async () => bytes) },
    attachmentEvidence: { resolve: () => attachments.map(({ agentPath: _path, ...fact }) => fact) } };
}

describe("OpenCode execution settings and explicit actions", () => {
  it("rejects an excessive combined image payload before reading bytes, reserving a send or posting", async () => {
    const f = fixture(); f.state.models[0]!.capabilities.input.push("image");
    const attachments = Array.from({ length: 2 }, (_, index) => ({ id: randomUUID(), kind: "image" as const,
      mediaType: "image/png" as const, fileName: `image-${index}.png`, byteSize: 9 * 1_024 * 1_024,
      sha256: "a".repeat(64), agentPath: `/private/staging/image-${index}.png` }));
    const read = vi.fn(async () => Buffer.alloc(0));
    const input = { ...f.submit("excessive-images"), attachments, attachmentBytes: { read },
      attachmentEvidence: { resolve: () => attachments.map(({ agentPath: _path, ...fact }) => fact) } };
    await expect(f.delivery.submit(input)).rejects.toMatchObject({ backendCode: "opencode_attachments_unavailable", crossedSubmissionBoundary: false });
    expect(read).not.toHaveBeenCalled(); expect(f.posts("/prompt")).toEqual([]);
    expect(f.repository.readOperation(scope, threadID, input.applicationOperationId, "submit")).toBeUndefined();
  });
  it("rejects 16 MiB of images plus maximally escaped 1 MiB text before observer, receipt or native send", async () => {
    const f = fixture(); f.state.models[0]!.capabilities.input.push("image");
    const input = withImages(f.submit("encoded-input-too-large", "\u0001".repeat(1_024 * 1_024)), 4, 4 * 1_024 * 1_024);
    const start = vi.spyOn(f.observer, "start");
    await expect(f.delivery.submit(input)).rejects.toMatchObject({ backendCode: "opencode_input_invalid",
      crossedSubmissionBoundary: false, safeMessage: expect.stringContaining("22 MiB") });
    expect(input.attachmentBytes.read).toHaveBeenCalledTimes(4);
    expect(start).not.toHaveBeenCalled(); expect(f.posts("/prompt")).toEqual([]);
    expect(f.repository.readOperation(scope, threadID, input.applicationOperationId, "submit")).toBeUndefined();
  });
  it("accepts an ordinary maximal image within the final encoded prompt bound", async () => {
    const f = fixture(); f.state.models[0]!.capabilities.input.push("image");
    const input = withImages(f.submit("maximal-image", "Inspect this image."), 1, 16 * 1_024 * 1_024);
    await expect(f.delivery.submit(input)).resolves.toMatchObject({ accepted: true });
    const posts = f.posts("/prompt"); expect(posts).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(posts[0]!.body))).toBeLessThan(OPENCODE_MAXIMUM_SERIALIZED_PROMPT_BYTES);
    expect(f.repository.readOperation(scope, threadID, input.applicationOperationId, "submit")).toMatchObject({ disposition: "accepted" });
    expect(f.wire.messages.at(-1)).toMatchObject({ type: "user", files: [{ mime: "image/png", source: { type: "inline" } }] });
  });
  it.each(["external", "imported"] as const)("keeps ordinary Send and Steer usable while withholding %s CLI authority", async kind => {
    const f = fixture(), issue = vi.fn(() => "must-not-issue"), resolve = vi.fn(async () => ({}));
    const ownership = kind === "external" ? "external" : "owned";
    vi.spyOn(f.repository, "hasCreatedRoot").mockReturnValue(kind === "external");
    const cli = new OpenCodeCliEnvironment({ ownership,
      availability: { availability: "available", endpoint: "http://127.0.0.1:4784", executableDirectory: "/fixture/bin", inheritedPath: "/bin" },
      sourceCapabilities: { issue }, tools: { readPolicy: () => ({ enabled: true, presentation: { surface: "cli", mode: "progressive" },
        accessBoundary: "thread", enabledToolIds: ["agent.context"] }) } });
    f.context.executionEnvironment = new OpenCodeExecutionEnvironment({ scope, ownership, readDefinitions: () => ({}), resolve, cli });
    await expect(f.delivery.submit(f.submit())).resolves.toMatchObject({ accepted: true });
    await expect(f.delivery.steer(f.steer())).resolves.toMatchObject({ status: "pending_materialization" });
    expect(f.posts("/prompt")).toHaveLength(2);
    expect(f.context.executionEnvironment.diagnostic(threadID)).toContain("messages and conversation controls remain available");
    expect(issue).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
    expect(f.runtime.installSessionEnvironment).not.toHaveBeenCalled();
  });
  it("reapplies desired A over recognized external B for ordinary input without changing desired revision", async () => {
    const f = fixture({ native: modelB });
    const before = f.context.settings.get(scope, threadID);
    await expect(f.settings.prepare("ordinary", "submit")).resolves.toMatchObject({ snapshot: { selection: modelA } });
    expect(f.posts("/model")).toHaveLength(1);
    expect(f.posts("/model")[0]!.body).toEqual({ model: modelA });
    expect(f.context.settings.get(scope, threadID)).toMatchObject({ desired: modelA, revision: before.revision,
      observed: { classification: "recognized", resolvedSelection: modelA }, observationState: "confirmed" });
    expect(f.calls.at(-1)).toMatchObject({ method: "GET", path: `/api/session/${f.wire.sessionID}` });
  });

  it("blocks steering on desired/native mismatch without changing native model", async () => {
    const f = fixture({ native: modelB });
    await expect(f.settings.prepare("steer", "steer")).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.posts("/model")).toEqual([]); expect(f.wire.session.model).toEqual(modelB);
  });

  it.each(["custom", "unavailable"] as const)("blocks ordinary %s state but allows explicit repair", async kind => {
    const f = fixture({ native: kind === "custom" ? { ...modelA, variant: "native-only" } : { providerID: "gone", id: "gone" } });
    await expect(f.settings.prepare("blocked", "submit")).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.posts("/model")).toEqual([]);
    await expect(f.actions.perform(f.action())).resolves.toEqual({ accepted: true });
    expect(f.wire.session.model).toEqual(modelA);
    await expect(f.settings.prepare("repaired", "submit")).resolves.toMatchObject({ snapshot: { selection: modelA } });
  });

  it("leaves imported null desired settings unset despite recognized native observation", async () => {
    const f = fixture({ desired: null });
    await expect(f.settings.prepare("import", "submit")).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.context.settings.get(scope, threadID)).toMatchObject({ desired: null, revision: 0,
      observed: { classification: "recognized", resolvedSelection: modelA } });
    expect(f.posts("/model")).toEqual([]);
  });

  it("rejects removed desired catalog entries without adopting the remaining model", async () => {
    const f = fixture({ native: modelB }); f.state.models = [nativeModel(modelB)];
    await expect(f.settings.prepare("removed", "submit")).rejects.toThrow();
    expect(f.posts("/model")).toEqual([]); expect(f.context.settings.get(scope, threadID).desired).toEqual(modelA);
  });

  it("proves exact native no-op actions by GET and returns accepted replay without another POST", async () => {
    const f = fixture(); const action = f.action();
    await expect(f.actions.perform(action)).resolves.toEqual({ accepted: true });
    const post = f.calls.findIndex(call => call.method === "POST");
    expect(f.calls[post + 1]).toMatchObject({ path: `/api/session/${f.wire.sessionID}`, method: "GET" });
    const count = f.calls.length;
    await expect(f.actions.perform(action)).resolves.toEqual({ accepted: true });
    expect(f.calls).toHaveLength(count); expect(f.posts("/model")).toHaveLength(1);
    await expect(f.actions.perform({ ...action, modelId: qualifiedOpenCodeModelId(modelB) } as RegisteredBackendActionInput))
      .rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.posts("/model")).toHaveLength(1);
  });

  it.each(["no-change", "lost-ack"] as const)("reconciles a %s model action through exact GET with no replay", async failure => {
    const f = fixture({ native: modelB });
    f.state.modelUpdate = failure !== "no-change"; f.state.dropModelAck = failure === "lost-ack";
    await expect(f.actions.perform(f.action())).rejects.toMatchObject({ crossedSubmissionBoundary: true, category: "submission_unknown" });
    if (failure === "no-change") {
      await expect(f.actions.reconcile(f.action())).resolves.toEqual({ outcome: "unknown" });
      f.wire.session.model = modelA;
    }
    await expect(f.actions.reconcile(f.action())).resolves.toEqual({ outcome: "accepted" });
    await expect(f.actions.perform(f.action())).resolves.toEqual({ accepted: true });
    expect(f.posts("/model")).toHaveLength(1);
  });

  it.each(["runtime", "revision"] as const)("records an action refused by the final %s check as not applied", async failure => {
    const f = fixture({ native: modelB }); const action = f.action();
    const assertCurrent = f.settings.assertCurrent.bind(f.settings);
    vi.spyOn(f.settings, "assertCurrent").mockImplementation(async signal => {
      await assertCurrent(signal);
      if (f.repository.readOperation(scope, threadID, action.applicationOperationId, "action")?.disposition === "prepared") {
        if (failure === "runtime") throw new OpenCodeRuntimeError("opencode_request_failed");
        const current = f.context.settings.get(scope, threadID);
        f.context.settings.updateDesired(scope, threadID, { expectedRevision: current.revision, desired: modelB, now: Date.now() });
      }
    });
    await expect(f.actions.perform(action)).rejects.toMatchObject({ crossedSubmissionBoundary: false,
      category: failure === "runtime" ? "unavailable" : "invalid_state" });
    expect(f.repository.readOperation(scope, threadID, action.applicationOperationId, "action")?.disposition).toBe("not_applied");
    await expect(f.actions.reconcile(action)).resolves.toEqual({ outcome: "not_applied" });
    await expect(f.actions.perform(action)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.posts("/model")).toHaveLength(0);
  });

  it("rejects a prepared action whose model was removed before dispatch without creating uncertainty", async () => {
    const f = fixture({ native: modelB }); const action = f.action(); const binding = f.attach.binding;
    f.repository.reserveOperation(scope, { applicationThreadId: threadID, connectionProfileId: binding.connectionProfileId,
      executionEnvironmentId: binding.executionEnvironmentId, nativeSessionId: binding.backendConversationId,
      applicationOperationId: action.applicationOperationId, operationKind: "action", nativeInputId: null,
      requestFingerprint: openCodeOperationFingerprint(action), requestSource: null, deadlineAt: null }, Date.now());
    new OpenCodeMutationEvidenceRepository(f.repository).prepare(scope, threadID, action.applicationOperationId, "action", { kind: "model", selection: modelA });
    f.state.models = [nativeModel(modelB)];
    await expect(f.actions.perform(action)).rejects.toMatchObject({ category: "invalid_state", crossedSubmissionBoundary: false });
    await expect(f.actions.reconcile(action)).resolves.toEqual({ outcome: "not_applied" });
    expect(f.posts("/model")).toHaveLength(0);
  });

  it("records native request validation failure as not applied even after claiming the action", async () => {
    const f = fixture(); const action: RegisteredBackendActionInput = { action: "rename", applicationOperationId: "oversized-rename", title: "é".repeat(10_000) };
    await expect(f.actions.perform(action)).rejects.toMatchObject({ category: "invalid_state", crossedSubmissionBoundary: false });
    await expect(f.actions.reconcile(action)).resolves.toEqual({ outcome: "not_applied" });
    expect(f.calls.filter(call => call.method === "PATCH")).toHaveLength(0);
  });

  it("preserves another caller's accepted action when a prepared caller loses the dispatch claim", async () => {
    const f = fixture({ native: modelB }); const action = f.action();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    const assertCurrent = f.settings.assertCurrent.bind(f.settings);
    vi.spyOn(f.settings, "assertCurrent").mockImplementation(async signal => {
      await assertCurrent(signal);
      if (!waiting && f.repository.readOperation(scope, threadID, action.applicationOperationId, "action")?.disposition === "prepared") {
        waiting = true; await held;
      }
    });
    const original = f.actions.perform(action);
    await vi.waitFor(() => expect(waiting).toBe(true));
    await expect(f.actions.perform(action)).resolves.toEqual({ accepted: true });
    release(); await expect(original).resolves.toEqual({ accepted: true });
    expect(f.repository.readOperation(scope, threadID, action.applicationOperationId, "action")?.disposition).toBe("accepted");
    expect(f.posts("/model")).toHaveLength(1);
  });

  it("reconciles the exact applied model after catalog removal without repeating or reauthorizing work", async () => {
    const f = fixture({ native: modelB }); const action = f.action(); f.state.dropModelAck = true;
    await expect(f.actions.perform(action)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    const read = vi.spyOn(f.context.catalog, "read").mockRejectedValue(new Error("catalog no longer available"));
    await expect(f.actions.reconcile(action)).resolves.toEqual({ outcome: "accepted" });
    expect(read).not.toHaveBeenCalled(); expect(f.posts("/model")).toHaveLength(1);
  });

  it("reconciles rename independently of model catalog availability and retains location fencing", async () => {
    const f = fixture(); const action: RegisteredBackendActionInput = { action: "rename", applicationOperationId: "rename", title: "Renamed" };
    f.state.dropRenameAck = true;
    await expect(f.actions.perform(action)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    const read = vi.spyOn(f.context.catalog, "read").mockRejectedValue(new Error("catalog no longer available"));
    f.wire.session.location = { directory: "/foreign" };
    await expect(f.actions.reconcile(action)).resolves.toEqual({ outcome: "unknown" });
    f.wire.session.location = { directory: f.wire.directory };
    await expect(f.actions.reconcile(action)).resolves.toEqual({ outcome: "accepted" });
    expect(read).not.toHaveBeenCalled(); expect(f.calls.filter(call => call.method === "PATCH")).toHaveLength(1);
  });

  it.each(["invalid_transition", "conflict"] as const)("preserves actionable %s settings errors", code => {
    const message = "The selected OpenCode model or reasoning effort is unavailable.";
    expect(mapOpenCodeConversationError(new DomainError(code, message))).toMatchObject({ category: "invalid_state",
      crossedSubmissionBoundary: false, safeMessage: message });
  });

  it("fences stale runtime, wrong scope and desired changes during native readback", async () => {
    const f = fixture({ native: modelB });
    const wrong = new OpenCodeExecutionSettings(f.context, { ...f.attach, scope: { ...scope, principalId: "other" } }, f.runtime, f.client, "wrong", f.settings.lifetime);
    await expect(wrong.prepare("wrong", "submit")).rejects.toThrow(); expect(f.calls).toEqual([]);
    const original = vi.mocked(f.runtime.assertCurrent).getMockImplementation()!;
    vi.mocked(f.runtime.assertCurrent).mockImplementation(async signal => {
      await original(signal);
      if (f.posts("/model").length && f.context.settings.get(scope, threadID).revision === 1) {
        f.context.settings.updateDesired(scope, threadID, { expectedRevision: 1, desired: modelB, now: Date.now() });
      }
    });
    await expect(f.settings.prepare("raced", "submit")).rejects.toThrow();
    expect(f.context.settings.get(scope, threadID).desired).toEqual(modelB);
    expect(f.posts("/model")).toHaveLength(1);
  });
});

describe("OpenCode settings observation fencing", () => {
  it("allows Submit's second preparation to finish while its model-selected event refreshes settings", async () => {
    const f = fixture({ native: modelB }); const handle = await f.driver.attach(f.attach); cleanup.push(() => handle.close());
    await handle.establishProjection({ signal: new AbortController().signal });
    const read = f.context.catalog.read.bind(f.context.catalog); let reads = 0;
    vi.spyOn(f.context.catalog, "read").mockImplementation(async input => {
      const number = ++reads; const result = await read(input);
      if (number === 2) {
        expect(f.posts("/model")).toHaveLength(1);
        f.wire.send({ id: "evt_submit_model_selected", created: 1, type: "session.model.selected",
          data: { sessionID: f.wire.sessionID, model: modelA }, durable: { aggregateID: f.wire.sessionID, seq: 1, version: 1 } });
        await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
      }
      return result;
    });
    await expect(handle.submit(f.submit("submit-event-race"))).resolves.toMatchObject({ accepted: true, completionCorrelation: "submit-event-race" });
    expect(f.posts("/model")).toHaveLength(1); expect(f.posts("/prompt")).toHaveLength(1);
    expect(f.context.settings.get(scope, threadID)).toMatchObject({ desired: modelA, observationState: "confirmed" });
  });

  it.each(["action", "steer"] as const)("does not let background model observation reject a valid %s read", async operation => {
    const f = fixture(); const handle = await f.driver.attach(f.attach); cleanup.push(() => handle.close());
    await handle.establishProjection({ signal: new AbortController().signal });
    const read = f.context.catalog.read.bind(f.context.catalog); let reads = 0;
    vi.spyOn(f.context.catalog, "read").mockImplementation(async input => {
      const number = ++reads; const result = await read(input);
      if (number === 1) {
        f.wire.send({ id: `evt_${operation}_model_selected`, created: 1, type: "session.model.selected",
          data: { sessionID: f.wire.sessionID, model: modelA }, durable: { aggregateID: f.wire.sessionID, seq: 1, version: 1 } });
        await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
      }
      return result;
    });
    if (operation === "action") {
      await expect(handle.perform(f.action("action-event-race", modelB))).resolves.toEqual({ accepted: true });
      expect(f.posts("/model")).toHaveLength(1);
    } else {
      await expect(handle.steer(f.steer("steer-event-race"))).resolves.toMatchObject({ status: "pending_materialization", completionCorrelation: "steer-event-race" });
      expect(f.repository.readOperation(scope, threadID, "steer-event-race", "steer")?.disposition).toBe("accepted");
      expect(f.posts("/model")).toHaveLength(0); expect(f.posts("/prompt")).toHaveLength(1);
    }
  });

  it.each(["action", "submit", "steer"] as const)("fences an in-flight %s when its handle closes during catalog preparation", async operation => {
    const f = fixture(); const handle = await f.driver.attach(f.attach); cleanup.push(() => handle.close());
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const read = f.context.catalog.read.bind(f.context.catalog);
    let entered = false;
    vi.spyOn(f.context.catalog, "read").mockImplementationOnce(async input => {
      const result = await read(input); entered = true; await held; return result;
    });
    const pending = (operation === "action" ? handle.perform(f.action("closed-action", modelB))
      : operation === "submit" ? handle.submit(f.submit("closed-submit")) : handle.steer(f.steer("closed-steer"))).catch(error => error);
    await vi.waitFor(() => expect(entered).toBe(true));
    await handle.close(); release();
    expect(await pending).toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.posts("/model")).toHaveLength(0); expect(f.posts("/prompt")).toHaveLength(0);
    expect(f.client.lifetime.aborted).toBe(false);
  });

  it("checks the handle lifetime synchronously immediately before claiming prompt dispatch", async () => {
    const f = fixture(); const handle = await f.driver.attach(f.attach); cleanup.push(() => handle.close());
    const track = OpenCodeInputObserver.prototype.track;
    let tracked = 0;
    vi.spyOn(OpenCodeInputObserver.prototype, "track").mockImplementation(function (this: OpenCodeInputObserver, evidence) {
      track.call(this, evidence);
      if (++tracked === 2) void handle.close();
    });
    await expect(handle.submit(f.submit("close-before-dispatch"))).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(tracked).toBe(2); expect(f.posts("/prompt")).toHaveLength(0);
    expect(f.repository.readOperation(scope, threadID, "close-before-dispatch", "submit")?.disposition).toBe("prepared");
    expect(f.client.lifetime.aborted).toBe(false);
  });

  it("retries a desired revision race without clearing a confirmed native selection", async () => {
    const f = fixture(); const handle = await f.driver.attach(f.attach); cleanup.push(() => handle.close());
    await handle.backendCapabilities();
    const read = f.context.catalog.read.bind(f.context.catalog);
    const catalog = vi.spyOn(f.context.catalog, "read").mockImplementationOnce(async input => {
      const result = await read(input);
      const current = f.context.settings.get(scope, threadID);
      f.context.settings.updateDesired(scope, threadID, { expectedRevision: current.revision, desired: modelB, now: Date.now() });
      return result;
    });
    await handle.backendCapabilities();
    expect(catalog).toHaveBeenCalledTimes(2);
    expect(f.context.settings.get(scope, threadID)).toMatchObject({ desired: modelB,
      observationState: "confirmed", observed: { resolvedSelection: modelA } });
  });

  it.each(["failure", "success"] as const)("does not let an older %s replace a newer observation", async outcome => {
    const f = fixture(); const handle = await f.driver.attach(f.attach); cleanup.push(() => handle.close());
    await handle.backendCapabilities();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const read = f.context.catalog.read.bind(f.context.catalog);
    let entered = false;
    vi.spyOn(f.context.catalog, "read").mockImplementationOnce(async input => {
      const result = await read(input); entered = true; await held;
      if (outcome === "failure") throw new Error("old catalog request failed");
      return result;
    });
    const old = handle.backendCapabilities();
    await vi.waitFor(() => expect(entered).toBe(true));
    f.wire.session.model = modelB;
    await handle.backendCapabilities();
    release(); await old;
    expect(f.context.settings.get(scope, threadID)).toMatchObject({ observationState: "confirmed", observed: { resolvedSelection: modelB } });
  });

  it("does not let a closed handle invalidate its replacement's confirmed observation", async () => {
    const f = fixture(); const first = await f.driver.attach(f.attach); cleanup.push(() => first.close());
    await first.backendCapabilities();
    const originalGeneration = f.context.settings.get(scope, threadID).observationGeneration;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const read = f.context.catalog.read.bind(f.context.catalog);
    let entered = false;
    vi.spyOn(f.context.catalog, "read").mockImplementationOnce(async input => {
      const result = await read(input); entered = true; await held; return result;
    });
    const old = first.backendCapabilities();
    await vi.waitFor(() => expect(entered).toBe(true));
    await first.close();
    const replacement = await f.driver.attach(f.attach); cleanup.push(() => replacement.close());
    await replacement.backendCapabilities();
    const generation = f.context.settings.get(scope, threadID).observationGeneration;
    expect(generation).not.toBe(originalGeneration);
    release(); await old;
    expect(f.context.settings.get(scope, threadID)).toMatchObject({ observationGeneration: generation,
      observationState: "confirmed", observed: { resolvedSelection: modelA } });
  });
});

describe("OpenCode exact input delivery", () => {
  it("attaches a fresh manual skill to the ordinary exact input while preserving text and skips catalog on dispatched replay", async () => {
    const f = fixture();
    f.wire.setResponse("/api/skill", 200, { location: { directory: f.wire.directory }, data: [{ id: "manual", name: "Manual skill",
      autoinvoke: false, path: "/private/skill/SKILL.md", content: "private prepared skill source" }] });
    const selectedSkillId = (await f.context.skills.read({ connection: f.context.connection, workspace: f.attach.workspace })).skills[0]!.id;
    const input = { ...f.submit("skill-input", "Ordinary authenticated text"), selectedSkillId };
    await expect(f.delivery.submit(input)).resolves.toMatchObject({ accepted: true });
    expect(f.posts("/prompt")).toHaveLength(1);
    expect(f.posts("/prompt")[0]!.body).toMatchObject({ text: "Ordinary authenticated text", skills: [{ id: "manual" }] });
    expect(f.posts("/prompt")[0]!.body).not.toHaveProperty("content");
    f.wire.setResponse("/api/skill", 503, {});
    await expect(f.delivery.submit(input)).resolves.toMatchObject({ accepted: true });
    expect(f.posts("/prompt")).toHaveLength(1);
    await expect(f.delivery.submit({ ...input, selectedSkillId: undefined })).rejects.toMatchObject({ category: "submission_unknown" });
    expect(f.posts("/prompt")).toHaveLength(1);
  });

  it("sends original wire text once but accepts exact native hook-prepared consumption", async () => {
    const f = fixture(); f.state.preparedText = "Prepared by native hook";
    await expect(f.delivery.submit(f.submit())).resolves.toMatchObject({ accepted: true, completionCorrelation: "submit-operation" });
    expect(f.posts("/prompt")[0]!.body).toMatchObject({ text: "Original input", delivery: "queue", resume: true });
    expect(f.evidence.get(scope, threadID, "submit-operation", "submit")).toMatchObject({ payloadConflict: false });
    expect(f.attach.onSubmissionObserved).toHaveBeenCalledWith({ backendCorrelation: "submit-operation" });
    await expect(f.delivery.submit(f.submit())).resolves.toMatchObject({ accepted: true });
    await expect(f.delivery.submit(f.submit("submit-operation", "Changed text"))).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(f.posts("/prompt")).toHaveLength(1);
  });

  it("does not accept admission alone and keeps late consumption recoverable after the one-second wait", async () => {
    const f = fixture(); f.state.consume = false;
    const started = Date.now();
    await expect(f.delivery.submit(f.submit())).rejects.toMatchObject({ category: "submission_unknown", crossedSubmissionBoundary: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    const evidence = f.evidence.get(scope, threadID, "submit-operation", "submit");
    expect(evidence.receipt.disposition).toBe("accepted"); expect(evidence.consumedFingerprint).toBeNull();
    expect(f.attach.onSubmissionObserved).not.toHaveBeenCalled();
    const admitted = f.state.pending[0]!;
    f.state.pending = []; f.wire.messages.push({ id: admitted.id, type: "user", text: admitted.payload.text, time: { created: 11 } });
    await expect(f.observer.reconcile("submit-operation", "submit")).resolves.toEqual({ status: "accepted" });
    await expect(f.delivery.submit(f.submit())).resolves.toMatchObject({ accepted: true });
    expect(f.posts("/prompt")).toHaveLength(1);
  });

  it("recovers a lost prompt ACK from exact consumed input without a second POST", async () => {
    const f = fixture(); f.state.dropPromptAck = true;
    await expect(f.delivery.submit(f.submit())).resolves.toMatchObject({ accepted: true });
    expect(f.posts("/prompt")).toHaveLength(1);
    await expect(f.delivery.submit(f.submit())).resolves.toMatchObject({ accepted: true });
    expect(f.posts("/prompt")).toHaveLength(1);
  });

  it("continues exact observation and withdrawal checks while a prompt ACK is held", async () => {
    const f = fixture(); let release!: () => void;
    f.state.postGate = new Promise<void>(resolve => { release = resolve; });
    const first = f.delivery.submit(f.submit());
    await vi.waitFor(() => expect(f.posts("/prompt")).toHaveLength(1));
    await vi.waitFor(() => expect(f.attach.onSubmissionObserved).toHaveBeenCalledWith({ backendCorrelation: "submit-operation" }));
    await expect(f.observer.withdrawPending(new AbortController().signal, Date.now() + 1_000)).resolves.toBeUndefined();
    await expect(f.delivery.submit(f.submit())).resolves.toMatchObject({ accepted: true });
    expect(f.posts("/prompt")).toHaveLength(1);
    release(); await expect(first).resolves.toMatchObject({ accepted: true });
  });

  it("upgrades a stale pre-dispatch failure after another caller sends the same operation", async () => {
    const f = fixture(); const originalPrepare = f.settings.prepare.bind(f.settings);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const atFinalRead = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(f.settings, "prepare").mockImplementation(originalPrepare)
      .mockImplementationOnce(originalPrepare)
      .mockImplementationOnce(async () => { entered(); await held; throw new Error("stale final catalog read failed"); });
    const first = f.delivery.submit(f.submit()).catch(error => error);
    await atFinalRead;
    await expect(f.delivery.submit(f.submit())).resolves.toMatchObject({ accepted: true });
    release();
    expect(await first).toMatchObject({ category: "submission_unknown", crossedSubmissionBoundary: true, retryable: false });
    expect(f.repository.requireOperation(scope, threadID, "submit-operation", "submit").disposition).toBe("accepted");
    expect(f.posts("/prompt")).toHaveLength(1);
  });

  it("admits several conversation steers without inventing native turn IDs", async () => {
    const f = fixture(); f.state.consume = false;
    for (const id of ["steer-one", "steer-two"]) {
      await expect(f.delivery.steer(f.steer(id))).resolves.toEqual({ status: "pending_materialization",
        reconciliationToken: id, completionCorrelation: id });
    }
    expect(f.posts("/prompt").map(call => call.body.delivery)).toEqual(["steer", "steer"]);
    expect(new Set(f.posts("/prompt").map(call => call.body.id)).size).toBe(2);
    expect(f.attach.onSubmissionObserved).not.toHaveBeenCalled();
    await expect(f.delivery.steer({ ...f.steer("invalid-target"), target: { kind: "turn", turnId: "native-turn" } }))
      .rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.posts("/prompt")).toHaveLength(2);
  });

  it("rejects unsupported input and absent desired selection before any prompt effect", async () => {
    const f = fixture({ desired: null });
    await expect(f.delivery.submit(f.submit())).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    await expect(f.delivery.submit({ ...f.submit("unsupported"), selectedSkillId: "native-skill" })).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.posts("/prompt")).toEqual([]);
  });
});
