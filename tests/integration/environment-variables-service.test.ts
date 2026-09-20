import { validateConfigurationDocument } from "../../src/server/configuration-admin/configuration-validation.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { EnvironmentVariablesService } from "../../src/server/environment-variables/environment-variables-service.js";
import { SavedAgentRepository } from "../../src/server/db/repositories/saved-agent-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ThreadTemplateRepository } from "../../src/server/db/repositories/thread-template-repository.js";
import { effectiveEnvironmentVariables, environmentVariableOverridesSchema, mergeEnvironmentVariableOverrides } from "../../src/shared/protocol/environment-variables.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const literal = (value: string) => ({ kind: "literal" as const, value });
function fixture() {
  const { database, scope } = savedAgentDatabase();
  cleanups.push(() => database.close());
  const configuration = new ConfigurationRepository(database);
  const variables = new EnvironmentVariablesService(database, configuration);
  const agents = new SavedAgentRepository(database);
  const inventory = new InventoryRepository(database);
  const bindings = new ConversationBindingRepository(database);
  const current = configuration.get(scope);
  const environmentId = current.configuration.executionEnvironments[0]!.id;
  const targetId = (database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string }).id;
  const workspace = inventory.upsertWorkspace(scope, { environmentId, canonicalPath: "/tmp/environment-vars", displayName: "Variables", available: true, trustState: "trusted", environmentConfigurationRevision: 0, now: 100 });
  const thread = () => bindings.createUnboundThread(scope, { workspaceId: workspace.id, connectionProfileId: targetId, title: "Variables", now: 100 }).id;
  const save = (edit: (doc: typeof current.configuration) => void) => {
    const latest = configuration.get(scope);
    const doc = structuredClone(latest.configuration);
    edit(doc);
    return configuration.save(scope, { mutationId: randomUUID(), expectedRevision: latest.revision, configuration: doc });
  };
  return { database, scope, configuration, variables, agents, targetId, thread, save, workspace };
}

describe("scoped environment variables", () => {
  it("merges precedence while distinguishing unset, empty and references, with portable key equivalence", () => {
    const value = mergeEnvironmentVariableOverrides({ A: literal("env"), B: literal("env") }, { A: literal("backend") }, { A: { kind: "unset" } }, { A: literal(""), b: { kind: "secret", source: { kind: "environment", name: "HOST_TOKEN" } } });
    expect(value).toEqual({ A: literal(""), b: { kind: "secret", source: { kind: "environment", name: "HOST_TOKEN" } } });
    expect(mergeEnvironmentVariableOverrides({ A: literal("base") }, { A: { kind: "unset" } })).toEqual({ A: { kind: "unset" } });
  });

  it("rejects authority and loader names, malformed text, duplicates and oversized maps", () => {
    for (const name of ["SEDES_TOOL_ACCESS_TOKEN", "sedes_private", "HOME", "codex_home", "NODE_OPTIONS", "LD_PRELOAD", "BASH_ENV", "bad-key"]) {
      expect(environmentVariableOverridesSchema.safeParse({ [name]: literal("x") }).success).toBe(false);
    }
    expect(environmentVariableOverridesSchema.safeParse({ A: literal("x"), a: literal("y") }).success).toBe(false);
    expect(environmentVariableOverridesSchema.safeParse({ A: literal("\0") }).success).toBe(false);
    expect(environmentVariableOverridesSchema.safeParse({ A: literal("\ud800") }).success).toBe(false);
    expect(environmentVariableOverridesSchema.safeParse({ A: literal("😀") }).success).toBe(true);
    expect(environmentVariableOverridesSchema.safeParse(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`V${i}`, literal("")]))).success).toBe(false);
    expect(environmentVariableOverridesSchema.safeParse({ A: { kind: "secret", source: { kind: "environment", name: "SEDES_TOOL_ACCESS_TOKEN" } } }).success).toBe(false);
  });

  it("captures four layers durably and keeps snapshots after defaults and agents change", () => {
    const f = fixture();
    f.save(doc => {
      doc.executionEnvironments[0]!.environmentVariables = { execution: { A: literal("env"), SHARED: literal("env") }, startup: { BOOT: literal("boot") } };
      doc.backends[0]!.environmentVariables = { execution: { SHARED: literal("backend") }, startup: {} };
    });
    const agent = f.agents.create(f.scope, { name: "Agent", description: "", backendTypeId: "pi", backendOverridesSchemaVersion: 1, backendOverrides: [], sedesTools: null, environmentVariables: { SHARED: literal("agent"), TOKEN: { kind: "secret", source: { kind: "protected_file", path: "/private/token" } } }, now: 100 });
    const preview = f.variables.preview(f.scope, f.targetId, agent.id);
    expect(preview.startup.supported).toBe(false);
    const prepared = f.variables.prepare(f.scope, f.targetId, { agentId: agent.id, expectedRevision: preview.revision, overrides: { SHARED: literal("thread"), A: { kind: "unset" } } });
    const threadId = f.thread();
    f.database.transaction(() => f.variables.initialize(f.scope, threadId, prepared))();
    f.save(doc => { doc.executionEnvironments[0]!.environmentVariables!.execution = { A: literal("new") }; });
    f.agents.update(f.scope, agent.id, { expectedRevision: 0, environmentVariables: {}, now: 200 });
    const snapshot = f.variables.get(f.scope, threadId);
    expect(snapshot).toEqual(prepared.snapshot);
    expect(f.variables.effective(f.scope, threadId)).toEqual({ A: { kind: "unset" }, SHARED: literal("thread"), TOKEN: { kind: "secret", source: { kind: "protected_file", path: "/private/token" } } });
    expect(JSON.stringify(snapshot)).not.toContain("BOOT");
    expect(() => f.variables.get({ ...f.scope, principalId: randomUUID() }, threadId)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => f.variables.preview({ ...f.scope, principalId: randomUUID() }, f.targetId, agent.id)).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("rejects stale preview and transaction fences without modifying the thread", () => {
    const f = fixture();
    const prepared = f.variables.prepare(f.scope, f.targetId, { overrides: { A: literal("draft") } });
    const threadId = f.thread();
    f.save(doc => { doc.backends[0]!.environmentVariables = { execution: { A: literal("changed") }, startup: {} }; });
    expect(() => f.variables.prepare(f.scope, f.targetId, { expectedRevision: { configurationRevision: 0 } })).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(() => f.database.transaction(() => f.variables.initialize(f.scope, threadId, prepared))()).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(f.variables.effective(f.scope, threadId)).toEqual({});
  });

  it("rejects Saved Agent revision drift and unsupported provider startup overrides", () => {
    const f = fixture();
    const agent = f.agents.create(f.scope, { name: "Agent", description: "", backendTypeId: "pi", backendOverridesSchemaVersion: 1, backendOverrides: [], sedesTools: null, environmentVariables: { A: literal("agent") }, now: 100 });
    const prepared = f.variables.prepare(f.scope, f.targetId, { agentId: agent.id });
    f.agents.update(f.scope, agent.id, { expectedRevision: 0, environmentVariables: { A: literal("updated") }, now: 200 });
    expect(() => prepared.assertCurrent()).toThrow(expect.objectContaining({ code: "conflict" }));
    const document = structuredClone(f.configuration.get(f.scope).configuration);
    document.backends[0]!.environmentVariables = { execution: {}, startup: { A: literal("unsupported") } };
    expect(() => validateConfigurationDocument(document)).toThrow(expect.objectContaining({ code: "bad_request" }));
    document.backends[0]!.environmentVariables = { execution: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`B${i}`, literal("value")])), startup: {} };
    document.executionEnvironments[0]!.environmentVariables = { execution: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`E${i}`, literal("value")])), startup: {} };
    expect(() => validateConfigurationDocument(document)).toThrow("Too many environment variables");
  });

  it("forks source snapshots and replaces only the thread layer", () => {
    const f = fixture();
    f.save(doc => { doc.backends[0]!.environmentVariables = { execution: { A: literal("backend") }, startup: {} }; });
    const source = f.thread();
    const prepared = f.variables.prepare(f.scope, f.targetId, { overrides: { A: literal("source") } });
    f.database.transaction(() => f.variables.initialize(f.scope, source, prepared))();
    const child = f.thread();
    f.database.transaction(() => f.variables.copy(f.scope, source, child, {}))();
    expect(f.variables.effective(f.scope, source)).toEqual({ A: literal("source") });
    expect(f.variables.effective(f.scope, child)).toEqual({ A: literal("backend") });
    expect(f.variables.forkRequestFingerprint(f.scope, source, {})).not.toBe(
      f.variables.forkRequestFingerprint(f.scope, source, { A: { kind: "unset" } }),
    );
    const copy = f.thread();
    f.database.transaction(() => f.variables.copy(f.scope, source, copy))();
    expect(f.variables.get(f.scope, copy)).toEqual(f.variables.get(f.scope, source));
  });

  it("keeps template overrides through rename and allows explicit reset", () => {
    const f = fixture();
    const repository = new ThreadTemplateRepository(f.database);
    const selection = { workspaceId: f.workspace.id, targetId: f.targetId, executionWorkspace: { kind: "direct" as const }, agentId: randomUUID(), capturedAgentName: "Agent", capturedWorkspaceName: "Workspace", capturedTargetName: "Target", environmentVariables: { A: literal("template") } };
    const created = repository.create(f.scope, { name: "Template", selection, assertReferences() {}, now: 100 });
    expect(created.environmentVariables).toEqual(selection.environmentVariables);
    const reset = repository.update(f.scope, created.id, { expectedRevision: 0, name: "Renamed", selection: { ...selection, environmentVariables: {} }, assertReferences() {}, now: 200 });
    expect(reset.environmentVariables).toEqual({});
    expect(effectiveEnvironmentVariables({ version: 1, layers: { environment: {}, backend: {}, agent: {}, thread: created.environmentVariables! } })).toEqual(selection.environmentVariables);
  });
});
