import { vi } from "vitest";
import type { ModelInfo, SessionInboxUser } from "@opencode/client";
import type { RegisteredBackendActionInput, SteerTurnInput, SubmitTurnInput } from "../../src/server/backends/contracts.js";
import { openCodeRuntimeTarget } from "../../src/server/backends/opencode/opencode-conversation-context.js";
import { OpenCodeActions } from "../../src/server/backends/opencode/opencode-actions.js";
import { OpenCodeDelivery } from "../../src/server/backends/opencode/opencode-delivery.js";
import { OpenCodeExecutionSettings } from "../../src/server/backends/opencode/opencode-execution-settings.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeInputObserver } from "../../src/server/backends/opencode/opencode-input-observer.js";
import { OpenCodeInputEvidenceRepository } from "../../src/server/backends/opencode/opencode-input-evidence.js";
import { qualifiedOpenCodeModelId, type OpenCodeSelection } from "../../src/server/backends/opencode/opencode-model-selection.js";
import { createOpenCodeApiFixture } from "./opencode-api-fixture.js";
import { createOpenCodeConversationFixture, scope, threadID } from "./opencode-conversation-fixture.js";

export const modelA = { providerID: "provider", id: "model-a" };
export const modelB = { providerID: "provider", id: "model-b" };
export const nativeModel = (selection: OpenCodeSelection): ModelInfo => ({ ...selection, modelID: `routed-${selection.id}`,
  package: "fixture:package", name: selection.id, enabled: true, status: "active", capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [], time: { released: 0 }, cost: [], limit: { context: 100, output: 10 } });

export function createOpenCodeExecutionFixture(input: { desired?: OpenCodeSelection | null; native?: OpenCodeSelection } = {}) {
  const wire = createOpenCodeApiFixture(); wire.session.model = input.native ?? modelA;
  const calls: { path: string; method: string; body?: any }[] = [];
  const state = {
    models: [nativeModel(modelA), nativeModel(modelB)], modelUpdate: true, dropModelAck: false, dropRenameAck: false,
    admission: true, consume: true, dropPromptAck: false, preparedText: undefined as string | undefined,
    pendingReadFailures: 0, pending: [] as SessionInboxUser[], postGate: undefined as Promise<void> | undefined,
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
    if (path === `/api/session/${wire.sessionID}/inbox`) {
      if (state.pendingReadFailures > 0) { state.pendingReadFailures--; throw new Error("transient pending read"); }
      return json({ data: state.pending });
    }
    return wire.fetch(value, init);
  } });
  const base = createOpenCodeConversationFixture({ native: { client, sessionID: wire.sessionID, directory: wire.directory } });
  if (input.desired !== null) base.context.settings.updateDesired(scope, threadID, {
    expectedRevision: 0, desired: input.desired ?? modelA, now: 1,
  });
  const attach = { ...base.target, onSubmissionObserved: vi.fn() };
  const lease = base.runtime.acquire(openCodeRuntimeTarget(base.target)), lifetime = new AbortController();
  // Keep the production host methods while allowing observation of consumer ACK order.
  const settings = new OpenCodeExecutionSettings(base.context, attach, base.runtime, { ...lease.client }, "execution-generation", lifetime.signal);
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
  const dispose = async () => { lifetime.abort(); observer.close(); lease.release(); await base.dispose(); };
  return { ...base, wire, client, attach, calls, state, settings, observer, actions, delivery, evidence, submit, steer, action, posts, dispose };
}

