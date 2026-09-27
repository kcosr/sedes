import { createOpenCodeNativePortFixture } from "../helpers/opencode-native-port-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, SessionInfo } from "@opencode/client";
import type { CreateConversationInput } from "../../src/server/backends/contracts.js";
import { OpenCodeConversationBackendDriver } from "../../src/server/backends/opencode/opencode-conversation-driver.js";
import { OpenCodeBackendDriverFactory } from "../../src/server/backends/opencode/opencode-driver-factory.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeModelCatalog } from "../../src/server/backends/opencode/opencode-model-catalog.js";
import { createOpenCodeConversationFixture, scope } from "../support/opencode-conversation-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function fixture() {
  const base = createOpenCodeConversationFixture();
  const nativeModel: ModelInfo = { providerID: "provider", id: "model", modelID: "routed", name: "Model", package: "fixture:package", enabled: true,
    status: "active", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], time: { released: 0 }, cost: [], limit: { context: 100, output: 10 } };
  const { database, context, runtime } = base;
  const applicationThreadId = "creation-thread", operationId = "non-uuid-operation", sessionID = "ses_reserved";
  const workspace = base.target.workspace;
  database.prepare(`INSERT INTO application_threads(tenant_id,owner_principal_id,id,backend_instance_id,connection_profile_id,environment_id,workspace_id,backing_state)
    VALUES (?,?,?,?,?,?,?,'creating')`).run(scope.tenantId, scope.principalId, applicationThreadId, context.instance.id, context.connection.id,
      context.connection.executionEnvironmentId, workspace.summary.id);
  context.settings.initialize(scope, applicationThreadId, { backendInstanceId: context.instance.id, connectionProfileId: context.connection.id,
    executionEnvironmentId: context.connection.executionEnvironmentId }, { providerID: nativeModel.providerID, id: nativeModel.id }, 1);
  database.exec(`CREATE TABLE IF NOT EXISTS conversation_creation_attempts (tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,
    backend_instance_id TEXT,connection_profile_id TEXT,execution_environment_id TEXT,mutation_id TEXT,phase TEXT,
    backend_creation_correlation TEXT,provisional_backend_conversation_id TEXT,provisional_opaque_binding_detail TEXT,
    source_kind TEXT,source_automation_id TEXT,source_automation_run_id TEXT,creation_kind TEXT,force_reset_at INTEGER)`);
  database.prepare(`INSERT INTO conversation_creation_attempts(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,
    connection_profile_id,execution_environment_id,mutation_id,phase,backend_creation_correlation,source_kind,creation_kind)
    VALUES (?,?,?,?,?,?,?,'external_call_started',?,'composer','first_input')`).run(scope.tenantId, scope.principalId, applicationThreadId,
      context.instance.id, context.connection.id, context.connection.executionEnvironmentId, operationId, sessionID);
  const calls: { method: string; path: string; body?: any }[] = [];
  const state: { native?: SessionInfo; pending?: SessionInfo; drop?: boolean; defer?: boolean; mismatch?: "marker" | "model" | "id" | "workspace";
    getResponse?: { status: number; body: unknown } } = {};
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch: async (value, init) => {
    const path = new URL(String(value)).pathname; const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (method === "POST") {
      expect(path).toBe("/api/session");
      const session: SessionInfo = { ...base.wire.session, id: body.id, model: body.model, location: body.location, metadata: body.metadata, title: body.title };
      if (state.mismatch === "marker") session.metadata = {};
      if (state.mismatch === "model") session.model = { providerID: "foreign", id: "foreign" };
      if (state.mismatch === "id") session.id = "ses_foreign";
      if (state.mismatch === "workspace") session.location = { directory: "/other" };
      if (state.defer) state.pending = session; else state.native = session;
      if (state.drop || state.defer) throw new Error("simulated lost response with private detail");
      return json(200, { data: session });
    }
    expect(path).toBe(`/api/session/${sessionID}`);
    if (state.getResponse) return json(state.getResponse.status, state.getResponse.body);
    return state.native ? json(200, { data: state.native }) : json(404, { _tag: "SessionNotFoundError", sessionID, message: "missing" });
  } });
  const originalAcquire = vi.mocked(runtime.acquire).getMockImplementation()!;
  vi.mocked(runtime.acquire).mockImplementation(target => ({ ...originalAcquire(target), client: createOpenCodeNativePortFixture(client, { directory: target.directory, sessionID }) }));
  const readNative = vi.fn(async () => ({ models: nativeModel.enabled ? [nativeModel] : [], defaultModel: nativeModel }));
  const catalog = new OpenCodeModelCatalog({ readNative, modelPolicy: context.modelPolicy });
  const getRuntime = vi.fn(async () => runtime);
  const creationContext = { ...context, catalog, runtime: getRuntime };
  const driver = new OpenCodeConversationBackendDriver(creationContext);
  const input: CreateConversationInput = { scope, applicationThreadId, applicationOperationId: operationId, source: { kind: "user" },
    workspace, requestedBackendConversationId: sessionID, title: "Created" };
  cleanup.push(async () => { client.close(); await base.dispose(); });
  return { ...base, driver, input, calls, state, nativeModel, readNative, getRuntime, creationContext,
    receipt: () => context.repository.readOperation(scope, applicationThreadId, operationId, "create") };
}

describe("OpenCode reserved native conversation creation", () => {
  it("reserves a bounded native ID and enables the required factory path", () => {
    const current = fixture(); const factory = new OpenCodeBackendDriverFactory({ ...current.creationContext, connections: [current.context.connection] });
    expect(factory.supportsConversationCreation).toBe(true);
    expect(factory.creationIdentity).toMatchObject({ assignment: "application", createReplay: "idempotent", bindBeforeFirstSubmission: false });
    const first = factory.creationIdentity.reserveBackendConversationId("seed".repeat(32));
    expect(first).toMatch(/^ses_[a-f0-9]{64}$/u); expect(first).toHaveLength(68);
    expect(factory.creationIdentity.reserveBackendConversationId("seed".repeat(32))).toBe(first);
    expect(factory.creationIdentity.reserveBackendConversationId("other")).not.toBe(first);
    expect(() => factory.creationIdentity.reserveBackendConversationId("")).toThrow();
  });
  it("creates exactly once with scoped private evidence and returns its accepted replay without native calls", async () => {
    const current = fixture(); const result = await current.driver.create(current.input);
    expect(result.backendConversationId).toBe(current.input.requestedBackendConversationId);
    expect(result.reconciliationToken).toMatch(/^oc_create_[a-f0-9]{64}$/u);
    expect(JSON.parse(result.opaqueBindingDetail)).toMatchObject({ sessionId: current.input.requestedBackendConversationId, tenantId: scope.tenantId,
      principalId: scope.principalId, canonicalWorkspacePath: current.input.workspace.canonicalPath });
    expect(current.receipt()).toMatchObject({ disposition: "accepted", operationKind: "create", requestSource: { kind: "user" } });
    expect(current.calls.map(call => call.method)).toEqual(["GET", "POST"]);
    expect(current.calls[1]!.body).toMatchObject({ model: { providerID: "provider", id: "model" }, metadata: { sedes_create: { version: 1 } } });
    const reads = current.readNative.mock.calls.length;
    await expect(current.driver.create(current.input)).resolves.toEqual(result);
    expect(current.calls).toHaveLength(2); expect(current.readNative).toHaveBeenCalledTimes(reads);
    expect(current.runtime.snapshot().references).toBe(0);
  });
  it("recovers lost ACK through exact native GET with no second POST", async () => {
    const current = fixture(); current.state.drop = true;
    await expect(current.driver.create(current.input)).resolves.toMatchObject({ backendConversationId: "ses_reserved" });
    expect(current.calls.map(call => call.method)).toEqual(["GET", "POST", "GET"]);
    expect(current.receipt()?.disposition).toBe("accepted"); expect(current.runtime.snapshot().references).toBe(0);
  });
  it("cannot classify a stale prepared preflight as non-acceptance after another caller dispatches", async () => {
    const current = fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    current.readNative.mockImplementationOnce(async () => ({ models: [current.nativeModel], defaultModel: current.nativeModel }))
      .mockImplementationOnce(async () => { await held; return { models: [current.nativeModel], defaultModel: current.nativeModel }; });
    const first = current.driver.create(current.input);
    const second = current.driver.create(current.input);
    const secondResult = second.catch(error => error);
    await first; release();
    expect(await secondResult).toMatchObject({ crossedSubmissionBoundary: true, category: "submission_unknown" });
    expect(current.receipt()?.disposition).toBe("accepted");
    expect(current.calls.filter(call => call.method === "POST")).toHaveLength(1);
    await expect(current.driver.create(current.input)).resolves.toMatchObject({ backendConversationId: "ses_reserved" });
  });
  it("keeps delayed native admission unknown across absent reads and later recovers without replay", async () => {
    const current = fixture(); current.state.defer = true;
    await expect(current.driver.create(current.input)).rejects.toMatchObject({ crossedSubmissionBoundary: true, category: "submission_unknown" });
    expect(current.receipt()?.disposition).toBe("unknown");
    await expect(current.driver.create(current.input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(current.calls.filter(call => call.method === "POST")).toHaveLength(1);
    current.state.native = current.state.pending;
    await expect(current.driver.create(current.input)).resolves.toMatchObject({ backendConversationId: "ses_reserved" });
    expect(current.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
  it.each(["marker", "id", "workspace"] as const)("never accepts mismatched %s evidence after dispatch", async mismatch => {
    const current = fixture(); current.state.mismatch = mismatch;
    await expect(current.driver.create(current.input)).rejects.toMatchObject({ crossedSubmissionBoundary: true, retryable: false, backendCode: "opencode_create_unknown" });
    expect(current.receipt()?.disposition).toBe("unknown");
    await expect(current.driver.create(current.input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(current.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
  it("recovers exact creation evidence after another client changes the model", async () => {
    const current = fixture(); current.state.defer = true;
    await expect(current.driver.create(current.input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    current.state.native = { ...current.state.pending!, model: { providerID: "foreign", id: "foreign" } };
    current.readNative.mockRejectedValue(new Error("catalog was removed"));
    await expect(current.driver.create(current.input)).resolves.toMatchObject({ backendConversationId: "ses_reserved" });
    expect(current.receipt()?.disposition).toBe("accepted");
    expect(current.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
  it("does not accept a wrong initial model ACK but recovers the separately proved creation", async () => {
    const current = fixture(); current.state.mismatch = "model";
    await expect(current.driver.create(current.input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await expect(current.driver.create(current.input)).resolves.toMatchObject({ backendConversationId: "ses_reserved" });
    expect(current.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
  it("does not discover/adopt preexisting native sessions or accept generic absence", async () => {
    const current = fixture(); current.state.native = { ...current.wire.session, id: "ses_reserved" };
    await expect(current.driver.create(current.input)).rejects.toMatchObject({ crossedSubmissionBoundary: false, category: "rejected" });
    expect(current.calls.every(call => call.method === "GET")).toBe(true);
    current.state.native = undefined; current.state.getResponse = { status: 404, body: { error: "missing" } };
    await expect(current.driver.create(current.input)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(current.calls.every(call => call.method === "GET")).toBe(true);
  });
  it("rejects wrong scope/source/reservation/workspace before catalog or runtime acquisition", async () => {
    const current = fixture();
    for (const change of [{ scope: { ...scope, principalId: "foreign" } }, { source: { kind: "automation", automationId: "a", automationRunId: "r" } as const },
      { requestedBackendConversationId: "ses_other" }, { workspace: { ...current.input.workspace, canonicalPath: "/foreign" } }, { creationCorrelation: "forbidden" }]) {
      await expect(current.driver.create({ ...current.input, ...change })).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    }
    expect(current.readNative).not.toHaveBeenCalled(); expect(current.getRuntime).not.toHaveBeenCalled(); expect(current.calls).toHaveLength(0);
  });
  it("rejects prepared/abandoned attempts, missing desired settings and unavailable catalog before POST", async () => {
    const current = fixture();
    current.database.prepare("UPDATE conversation_creation_attempts SET phase='prepared'").run();
    await expect(current.driver.create(current.input)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    current.database.prepare("UPDATE conversation_creation_attempts SET phase='external_call_started',force_reset_at=1").run();
    await expect(current.driver.create(current.input)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    current.database.prepare("UPDATE conversation_creation_attempts SET force_reset_at=NULL").run();
    current.database.prepare("UPDATE opencode_thread_settings SET desired_selection_json=NULL WHERE application_thread_id=?").run(current.input.applicationThreadId);
    await expect(current.driver.create(current.input)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    current.context.settings.updateDesired(scope, current.input.applicationThreadId, { expectedRevision: 0, desired: { providerID: "provider", id: "model" }, now: 2 });
    current.nativeModel.enabled = false;
    await expect(current.driver.create(current.input)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(current.calls).toHaveLength(0);
  });
  it("rejects changed retries without clearing an existing uncertain effect", async () => {
    const current = fixture(); current.state.defer = true;
    await expect(current.driver.create(current.input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await expect(current.driver.create({ ...current.input, title: "changed" })).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await expect(current.driver.create({ ...current.input, source: { kind: "automation", automationId: "other", automationRunId: "run" } })).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(current.receipt()?.disposition).toBe("unknown"); expect(current.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
  it("rechecks native runtime identity and application creation authority after a request", async () => {
    const current = fixture();
    vi.mocked(current.runtime.assertCurrent).mockImplementation(async () => {
      if (current.calls.some(call => call.method === "POST")) current.database.prepare("UPDATE conversation_creation_attempts SET force_reset_at=1").run();
    });
    await expect(current.driver.create(current.input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(current.receipt()?.disposition).toBe("unknown"); expect(current.runtime.snapshot().references).toBe(0);
  });
});
