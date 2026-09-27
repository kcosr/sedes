import Database from "better-sqlite3";
import type { ModelInfo } from "@opencode/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConnectionProfile } from "../../src/server/backends/contracts.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { OpenCodeModelCatalog, reviewedOpenCodeEffort } from "../../src/server/backends/opencode/opencode-model-catalog.js";
import { classifyObserved, decodeOpenCodeModelId, decodeOpenCodeModelSetting, encodeOpenCodeModelSetting, qualifiedOpenCodeModelId, resolveOpenCodeDefaults, resolveOpenCodeSelection, toEffective } from "../../src/server/backends/opencode/opencode-model-selection.js";
import { OpenCodeThreadSettingsRepository } from "../../src/server/backends/opencode/opencode-thread-settings-repository.js";
import { OpenCodeThreadRepository } from "../../src/server/backends/opencode/opencode-thread-repository.js";
import { OpenCodeBackendThreadPersistenceAdapter } from "../../src/server/backends/opencode/opencode-backend-thread-persistence-adapter.js";
import { OpenCodeThreadPresentationProvider } from "../../src/server/backends/opencode/opencode-thread-presentation-provider.js";
import { OpenCodeThreadActionPersistence } from "../../src/server/backends/opencode/opencode-thread-action-persistence.js";
import { OpenCodeSavedAgentBackendAdapter } from "../../src/server/backends/opencode/opencode-saved-agent-adapter.js";
import { OpenCodeAutomationExecutionPolicy } from "../../src/server/backends/opencode/opencode-automation-execution-policy.js";
import { ConversationCreationTransaction } from "../../src/server/backends/saved-agent-adapter.js";
import { openCodeNativeEvidenceMigration } from "../../src/server/db/migrations/121-opencode-native-evidence.js";
import { openCodeExecutionSettingsMigration } from "../../src/server/db/migrations/123-opencode-execution-settings.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const backendInstanceId = "opencode-backend";
const connection: AgentConnectionProfile = { ...scope, ownerPrincipalId: scope.principalId, id: "connection", templateId: "template", kind: "opencode_http",
  backendInstanceId, executionEnvironmentId: "local", label: "OpenCode", enabled: true, configurationRevision: 1 };
const workspace: ValidatedWorkspace = { canonicalPath: "/workspace", authorityRevision: 1,
  summary: { id: "workspace", environmentId: "local", displayName: "Workspace", displayPath: "/workspace", availability: "available", trustState: "trusted", revision: 0 } };
const modelPolicy = compileBackendModelPolicy({ type: "catalog" }, "provider_model_effort");
const defaults = { model: { type: "catalogDefault" }, variant: { type: "modelDefault" } } as const;
const target = { backendInstanceId, connectionProfileId: connection.id, executionEnvironmentId: connection.executionEnvironmentId };
const selection = { providerID: "provider", id: "native-model" };
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function nativeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return { ...selection, modelID: "upstream-routing-model", name: "Native model", package: "@opencode/ai/providers/openai-compatible",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, variants: [{ id: "low", settings: { reasoningEffort: "low" } }, { id: "high", settings: { reasoningEffort: "high" } }],
    time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 100_000, output: 16_000 }, ...overrides };
}
async function catalog(models: ModelInfo[] = [nativeModel()], defaultModel: ModelInfo | undefined = models[0]) {
  return new OpenCodeModelCatalog({ modelPolicy, readNative: async () => ({ models, ...(defaultModel ? { defaultModel } : {}) }) }).read({ connection, workspace });
}
function fixture() {
  const database = new Database(":memory:"); databases.push(database); database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE agent_backend_instances (tenant_id TEXT,id TEXT,kind TEXT,PRIMARY KEY(tenant_id,id));
    CREATE TABLE agent_connection_profiles (tenant_id TEXT,owner_principal_id TEXT,id TEXT,kind TEXT,backend_instance_id TEXT,execution_environment_id TEXT,PRIMARY KEY(tenant_id,owner_principal_id,id));
    CREATE TABLE workspaces (tenant_id TEXT,owner_principal_id TEXT,id TEXT,canonical_path TEXT,PRIMARY KEY(tenant_id,owner_principal_id,id));
    CREATE TABLE application_threads (tenant_id TEXT,owner_principal_id TEXT,id TEXT,backend_instance_id TEXT,connection_profile_id TEXT,environment_id TEXT,workspace_id TEXT,backing_state TEXT,revision INTEGER,updated_at INTEGER,title TEXT,
      PRIMARY KEY(tenant_id,owner_principal_id,id),UNIQUE(tenant_id,owner_principal_id,id,backend_instance_id,connection_profile_id,environment_id));
    CREATE TABLE conversation_bindings (tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,backend_instance_id TEXT,connection_profile_id TEXT,execution_environment_id TEXT,backend_conversation_id TEXT,
      UNIQUE(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,connection_profile_id,execution_environment_id));
    CREATE TABLE conversation_creation_attempts (tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,attempt_id TEXT,mutation_id TEXT,phase TEXT,retry_anchor TEXT,force_reset_at INTEGER);
    CREATE TABLE principal_generations (tenant_id TEXT,principal_id TEXT,inventory_generation INTEGER);
    INSERT INTO agent_backend_instances VALUES ('tenant','opencode-backend','opencode');
    INSERT INTO agent_connection_profiles VALUES ('tenant','principal','connection','opencode_http','opencode-backend','local');
    INSERT INTO workspaces VALUES ('tenant','principal','workspace','/workspace');
    INSERT INTO application_threads VALUES ('tenant','principal','thread','opencode-backend','connection','local','workspace','unbound',0,0,'Thread');
    INSERT INTO application_threads VALUES ('tenant','principal','other','opencode-backend','connection','local','workspace','unbound',0,0,'Other');
    INSERT INTO principal_generations VALUES ('tenant','principal',0);
  `);
  database.exec(openCodeNativeEvidenceMigration.sql); database.exec(openCodeExecutionSettingsMigration.sql);
  const settings = new OpenCodeThreadSettingsRepository({ database, scope, backendInstanceId });
  const repository = new OpenCodeThreadRepository({ database, scope, backendInstanceId, nativeNamespaceKey: "namespace" });
  const resolveConnectionDefaults = () => defaults;
  const persistence = new OpenCodeBackendThreadPersistenceAdapter({ repository, settings, scope, backendInstanceId, modelPolicy, resolveConnectionDefaults, now: () => 1 });
  const saved = new OpenCodeSavedAgentBackendAdapter({ persistence, settings, modelPolicy, resolveConnectionDefaults });
  const actions = new OpenCodeThreadActionPersistence({ database, settings, scope, backendInstanceId, modelPolicy });
  const presentation = new OpenCodeThreadPresentationProvider({ scope, backendInstanceId, settings, modelPolicy });
  return { database, settings, repository, persistence, saved, actions, presentation };
}

describe("OpenCode native model catalog", () => {
  it("uses exact provider/id pairs, not the upstream routing model or slash concatenation", async () => {
    const ref = { providerID: "provider/日本", id: "model/#other" };
    expect(decodeOpenCodeModelId(qualifiedOpenCodeModelId(ref))).toEqual(ref);
    expect(qualifiedOpenCodeModelId({ providerID: "a/b", id: "c" })).not.toBe(qualifiedOpenCodeModelId({ providerID: "a", id: "b/c" }));
    const read = await catalog();
    expect(decodeOpenCodeModelId(read.catalog.models[0]!.id)).toEqual(selection);
    expect(read.catalog.models[0]).toMatchObject({ provider: connection.id, isDefault: true, inputModalities: ["text", "image"], supportedReasoningEfforts: ["default", "low", "high"] });
  });
  it("rejects noncanonical and oversized model IDs and connection setting tokens", () => {
    const id = qualifiedOpenCodeModelId(selection); const token = encodeOpenCodeModelSetting(connection.id, id);
    expect(decodeOpenCodeModelSetting(token)).toEqual({ connectionId: connection.id, modelId: id });
    for (const invalid of [id + "=", "ocm_" + Buffer.from('[ "provider", "native-model" ]').toString("base64url"), "ocm_%%%", qualifiedOpenCodeModelId({ providerID: "x", id: "y" }) + "\n"]) expect(() => decodeOpenCodeModelId(invalid)).toThrow();
    for (const invalid of [token + "=", token + "\n", "ocms_%%%", "ocms_" + Buffer.from('["connection","plain"]')]) expect(() => decodeOpenCodeModelSetting(invalid)).toThrow();
    expect(() => qualifiedOpenCodeModelId({ providerID: "x".repeat(240), id: "model" })).toThrow();
    expect(() => qualifiedOpenCodeModelId({ providerID: "bad\ud800", id: "model" })).toThrow();
  });
  it("excludes disabled/missing-package/non-text models and retains deprecated models", async () => {
    const read = await catalog([nativeModel({ id: "off", enabled: false }), nativeModel({ id: "missing", package: undefined }),
      nativeModel({ id: "images", capabilities: { tools: false, input: ["image"], output: ["image"] } }), nativeModel({ status: "deprecated" })]);
    expect(read.catalog.models).toHaveLength(1); expect(read.catalog.models[0]!.label).toContain("deprecated");
    expect(read.catalog.models[0]!.isDefault).toBeUndefined(); expect(read.catalog.notices).toHaveLength(1);
    expect(() => resolveOpenCodeDefaults({ connection, catalog: read.catalog, defaults, modelPolicy })).toThrow();
  });
  it("does not invent a catalog default or replace an unavailable fixed selection", async () => {
    const read = await new OpenCodeModelCatalog({ modelPolicy, readNative: async () => ({ models: [nativeModel()] }) }).read({ connection, workspace });
    expect(() => resolveOpenCodeDefaults({ connection, catalog: read.catalog, defaults, modelPolicy })).toThrow();
    expect(() => resolveOpenCodeDefaults({ connection, catalog: read.catalog, modelPolicy, defaults: { model: { type: "fixed", modelId: qualifiedOpenCodeModelId({ providerID: "removed", id: "removed" }) }, variant: defaults.variant } })).toThrow();
  });
  it("recognizes only exact reviewed package/overlay combinations and raw-body compatibility", () => {
    const model = nativeModel(); const low = model.variants[0]!;
    expect(reviewedOpenCodeEffort(model, low)).toBe(true);
    for (const variant of [{ ...low, settings: { reasoningEffort: "high" } }, { ...low, settings: { ...low.settings, temperature: 0 } },
      { ...low, body: { extra: true } }, { ...low, headers: { special: "x" } }]) expect(reviewedOpenCodeEffort(model, variant)).toBe(false);
    expect(reviewedOpenCodeEffort({ ...model, package: "custom-package" }, low)).toBe(false);
    expect(reviewedOpenCodeEffort({ ...model, body: { reasoning_effort: "high" } }, low)).toBe(false);
    const responses = { ...model, package: "@opencode/ai/providers/openai" };
    const variant = { id: "low", settings: { reasoningEffort: "low", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] } };
    expect(reviewedOpenCodeEffort(responses, variant)).toBe(true);
    expect(reviewedOpenCodeEffort(responses, low)).toBe(false);
    expect(reviewedOpenCodeEffort({ ...responses, body: { reasoning: { effort: "high" } } }, variant)).toBe(false);
    expect(reviewedOpenCodeEffort({ ...responses, body: { include: [] } }, variant)).toBe(false);
  });
  it("classifies native custom/unavailable selections without inventing effort and omits default effective thinking", async () => {
    const read = await catalog();
    expect(classifyObserved({ selection: { ...selection, variant: "default" }, catalog: read })).toMatchObject({ classification: "recognized", resolvedSelection: selection });
    expect(classifyObserved({ selection: { ...selection, variant: "arbitrary" }, catalog: read })).toMatchObject({ classification: "external_custom", resolvedSelection: null });
    expect(classifyObserved({ selection: { ...selection, id: "removed" }, catalog: read })).toMatchObject({ classification: "unavailable" });
    expect(toEffective(selection, connection.id, read.catalog)).not.toHaveProperty("thinkingLevel");
    expect(toEffective({ ...selection, variant: "low" }, connection.id, read.catalog).thinkingLevel).toBe("low");
    expect(() => toEffective({ ...selection, variant: "arbitrary" }, connection.id, read.catalog)).toThrow();
    expect(() => resolveOpenCodeSelection({ connection, catalog: read.catalog, modelPolicy, modelId: qualifiedOpenCodeModelId(selection), variant: "arbitrary" })).toThrow();
  });
  it("reads a fresh location catalog each time and does not preserve stale membership", async () => {
    const readNative = vi.fn().mockResolvedValueOnce({ models: [nativeModel()] }).mockResolvedValueOnce({ models: [] });
    const service = new OpenCodeModelCatalog({ modelPolicy, readNative });
    expect((await service.read({ connection, workspace })).catalog.models).toHaveLength(1);
    expect((await service.read({ connection, workspace })).catalog.models).toHaveLength(0);
    expect(readNative).toHaveBeenNthCalledWith(2, workspace.canonicalPath, undefined);
  });
});

describe("OpenCode desired settings authority", () => {
  it("does not infer desired settings for imported native sessions", () => {
    const { settings, persistence, saved } = fixture();
    persistence.initializeThread(scope, "thread", connection);
    expect(settings.get(scope, "thread")).toMatchObject({ desired: null, revision: 0, observationState: "unknown" });
    expect(() => saved.captureThreadConfiguration({ scope, applicationThreadId: "thread", connection })).toThrow(/Choose complete/);
    const policy = new OpenCodeAutomationExecutionPolicy({ scope, backendInstanceId, settings, modelPolicy });
    expect(() => policy.assertCanAutomate(scope, "thread")).toThrow();
  });
  it("fences scope, target and desired revisions without bumping revisions for observations", async () => {
    const { settings } = fixture();
    settings.updateDesired(scope, "thread", { expectedRevision: 0, desired: selection, now: 1 });
    const observation = classifyObserved({ selection, catalog: await catalog() });
    expect(settings.beginObservation(scope, "thread", { expectedRevision: 1, generation: "runtime/session-1", now: 2 })).toBe(true);
    expect(settings.recordObserved(scope, "thread", { expectedRevision: 1, generation: "runtime/session-1", observed: observation, now: 3 })).toBe(true);
    expect(settings.get(scope, "thread")).toMatchObject({ revision: 1, observationState: "confirmed" });
    settings.updateDesired(scope, "thread", { expectedRevision: 1, desired: { ...selection, variant: "high" }, now: 4 });
    expect(settings.get(scope, "thread")).toMatchObject({ revision: 2, observed: { nativeSelection: selection } });
    expect(settings.recordObserved(scope, "thread", { expectedRevision: 1, generation: "runtime/session-1", observed: observation, now: 5 })).toBe(false);
    settings.beginObservation(scope, "thread", { expectedRevision: 2, generation: "runtime/session-2", now: 6 });
    expect(settings.recordObserved(scope, "thread", { expectedRevision: 2, generation: "runtime/session-1", observed: observation, now: 7 })).toBe(false);
    expect(settings.markUnknown(scope, "thread", { expectedRevision: 2, generation: "runtime/session-1", now: 7 })).toBe(false);
    expect(() => settings.get({ ...scope, principalId: "other" }, "thread")).toThrow();
    expect(() => settings.initialize(scope, "thread", { ...target, connectionProfileId: "other" }, selection, 1)).toThrow();
    expect(() => settings.updateDesired(scope, "thread", { expectedRevision: 1, desired: selection, now: 8 })).toThrow();
  });
  it("freezes create and first-submit snapshots separately and never adopts changed settings on replay", () => {
    const { settings } = fixture();
    settings.updateDesired(scope, "thread", { expectedRevision: 0, desired: selection, now: 1 });
    const create = settings.captureOperation(scope, { applicationThreadId: "thread", applicationOperationId: "first", operationKind: "create", now: 2 });
    const submit = settings.captureOperation(scope, { applicationThreadId: "thread", applicationOperationId: "first", operationKind: "submit", now: 2 });
    expect(create.operationKind).toBe("create"); expect(submit.operationKind).toBe("submit");
    settings.updateDesired(scope, "thread", { expectedRevision: 1, desired: { ...selection, variant: "high" }, now: 3 });
    expect(settings.captureOperation(scope, { applicationThreadId: "thread", applicationOperationId: "first", operationKind: "submit", now: 4 })).toEqual(submit);
    expect(() => settings.readOperation(scope, "other", "first", "submit")).toThrow();
    expect(() => settings.captureOperation(scope, { applicationThreadId: "thread", applicationOperationId: "first", operationKind: "submit", expectedRevision: 2, now: 4 })).toThrow();
  });
  it("keeps staged action and Saved Agent captures valid across native observation updates", async () => {
    const { database, settings, persistence, saved, actions } = fixture();
    persistence.initializeNewThread(scope, "thread", connection, (await catalog()).catalog);
    const capture = saved.captureThreadConfiguration({ scope, applicationThreadId: "thread", connection });
    expect(capture.overrides).toContainEqual({ id: "reasoning_effort", value: "default" });
    const current = settings.get(scope, "thread"); const observed = classifyObserved({ selection: { ...selection, variant: "low" }, catalog: await catalog() });
    settings.beginObservation(scope, "thread", { expectedRevision: current.revision, generation: "generation", now: 2 });
    settings.recordObserved(scope, "thread", { expectedRevision: current.revision, generation: "generation", observed, now: 3 });
    database.transaction(() => saved.assertThreadConfigurationCapture({ transaction: ConversationCreationTransaction.fromActiveDatabase(database), scope, applicationThreadId: "thread", connection, capture }))();
    actions.persistAccepted(scope, "thread", { mutationId: "action", expectedThreadRevision: 0, settingsGuard: { kind: "staged", expectedRevision: current.revision },
      operation: { action: "set_setting", settingId: "thinking_level", value: "high" }, now: 4 });
    expect(settings.get(scope, "thread").desired?.variant).toBe("high");
    expect(() => database.transaction(() => saved.assertThreadConfigurationCapture({ transaction: ConversationCreationTransaction.fromActiveDatabase(database), scope, applicationThreadId: "thread", connection, capture }))()).toThrow();
  });
  it("rejects wrong connection tokens and resets variant when selecting a model", () => {
    const { settings, actions } = fixture();
    settings.updateDesired(scope, "thread", { expectedRevision: 0, desired: { ...selection, variant: "low" }, now: 1 });
    const modelId = qualifiedOpenCodeModelId(selection);
    const operation = { action: "set_setting", settingId: "model", value: encodeOpenCodeModelSetting("other", modelId) } as const;
    expect(actions.driverAction(operation, "op")).toMatchObject({ action: "set_model", provider: "other", modelId });
    expect(() => actions.persistAccepted(scope, "thread", { mutationId: "op", expectedThreadRevision: 0, settingsGuard: { kind: "staged", expectedRevision: 1 }, operation, now: 2 })).toThrow();
    expect(settings.get(scope, "thread").revision).toBe(1);
    actions.persistAccepted(scope, "thread", { mutationId: "op2", expectedThreadRevision: 0, settingsGuard: { kind: "proven_applied" }, operation: { ...operation, value: encodeOpenCodeModelSetting(connection.id, modelId) }, now: 3 });
    expect(settings.get(scope, "thread").desired).toEqual(selection);
    expect(() => actions.driverAction({ action: "rename", title: " " }, "rename")).toThrow();
    expect(actions.driverAction({ action: "compact" }, "compact")).toEqual({ action: "compact", applicationOperationId: "compact" });
  });
  it("presents desired and effective selections independently with stable desired revision", async () => {
    const { database, settings, persistence, presentation } = fixture(); const read = await catalog();
    persistence.initializeNewThread(scope, "thread", connection, read.catalog);
    database.prepare("UPDATE application_threads SET backing_state='bound' WHERE id='thread'").run();
    const args = { scope, applicationThreadId: "thread", connection, workspace, catalog: read.catalog,
      backend: { id: backendInstanceId, tenantId: scope.tenantId, kind: "opencode" as const, label: "OpenCode", enabled: true, configurationRevision: 1, protocolRelease: "2.0.18" } };
    const before = await presentation.read(args); const revision = settings.get(scope, "thread").revision;
    settings.beginObservation(scope, "thread", { expectedRevision: revision, generation: "generation", now: 2 });
    settings.recordObserved(scope, "thread", { expectedRevision: revision, generation: "generation", observed: classifyObserved({ selection: { ...selection, variant: "low" }, catalog: read }), now: 3 });
    const after = await presentation.read(args);
    expect(after.settings.revision).toBe(before.settings.revision); expect(after.revision).not.toBe(before.revision);
    expect(after.settings.values.find(value => value.id === "thinking_level")).toMatchObject({ desiredValue: "default", effectiveValue: "low", applicationState: "pending_next_turn" });
    expect(after.nextTurnSettingIds).toEqual([]);
  });
  it("captures explicit default in Saved Agents and validates against a fresh target catalog", async () => {
    const { saved, persistence } = fixture(); const read = await catalog();
    persistence.initializeNewThread(scope, "thread", connection, read.catalog);
    const capture = saved.captureThreadConfiguration({ scope, applicationThreadId: "thread", connection });
    const context = { scope, connection, workspace, catalog: read.catalog };
    const prepared = saved.prepareResolutionContext(context);
    const resolved = saved.resolve({ ...context, prepared, overrides: capture });
    expect(resolved.value).toEqual(selection); expect(resolved.normalizedValues).toContainEqual({ id: "reasoning_effort", value: "default" });
    expect(saved.describeEditor({ ...context, prepared, overrides: capture }).fields).toHaveLength(2);
    expect(() => saved.resolve({ ...context, catalog: { ...read.catalog, models: [] }, prepared, overrides: capture })).toThrow();
    expect(() => saved.validateOverrides({ overrides: [{ id: "model", value: "native-name" }] })).toThrow();
    expect(() => saved.validateOverrides({ overrides: [{ id: "permission_mode", value: "always" }] })).toThrow();
  });
});
