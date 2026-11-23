import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import { applyBackendNormalizationMigration, applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { ConfigurationProjection } from "../../src/server/configuration-admin/configuration-projection.js";
import { ConfigurationAdminService, type ConfigurationRuntimeAdapter } from "../../src/server/configuration-admin/configuration-admin-service.js";
import type { ConfigurationCommand } from "../../src/server/configuration-admin/configuration-command-receipt.js";
import { configurationDocumentSchema } from "../../src/shared/protocol/configuration-admin.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { ExecutionManagementAccess } from "../../src/server/agent-tools/application/execution-management-access.js";
import { AgentToolEnvironmentAuthorityResolver, type AgentToolEnvironmentAuthorityReader } from "../../src/server/agent-tools/environment/environment-authority.js";
import type { TrustedToolInvocationContext } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { RuntimeAgentToolService, type RuntimeManagementOperation } from "../../src/server/agent-tools/tools/runtime-agent-tool-service.js";
import { createRuntimeManagementToolDefinitions } from "../../src/server/agent-tools/tools/runtime-management-tools.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../../src/server/agent-tools/registry/canonical-agent-tool-manifest.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import type { ThreadAgentToolPolicyRecord } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";

const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const legacy = parseResolvedBackendConfiguration({ schemaVersion: 10,
  executionEnvironments: [{ id: environmentId, kind: "local", label: "Local" }],
  backends: [{ id: "pi-primary", kind: "pi", label: "Pi SDK", enabled: true, modelPolicy: { type: "catalog" } }],
  targets: [{ id: "local-primary", kind: "pi_sdk", label: "SDK", backendInstanceId: "pi-primary", executionEnvironmentId: environmentId, enabled: true }],
  defaultTargetId: "local-primary" });
const seeds = new Map<number, Buffer>();
const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function fixture(through = backendNormalizedMigrations.at(-1)!.version) {
  let seed = seeds.get(through);
  if (!seed) {
    const database = openOverlayDatabase(":memory:");
    applyBackendNormalizationMigration(database, { configuration: legacy, quiescentCutoverConfirmed: true, appliedAt: 100 });
    applyDatabaseMigrations(database, backendNormalizedMigrations.filter(migration => migration.version <= through));
    seed = database.serialize();
    seeds.set(through, seed);
    database.close();
  }
  const database = new Database(seed);
  database.pragma("foreign_keys = ON");
  databases.push(database);
  const scope = new SingleUserIdentityProvider(database).getScope();
  const repository = new ConfigurationRepository(database);
  const projection = new ConfigurationProjection(database, { pi: "0.86.0" });
  const document = configurationDocumentSchema.parse({
    executionEnvironments: [{ id: environmentId, kind: "local", label: "Local", workspaceRoots: ["/tmp"],
      workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } }],
    backends: legacy.backends.map(({ protocolRelease: _release, ...backend }) => backend),
    targets: legacy.targets, defaultTargetId: legacy.defaultTargetId, webSearch: null,
  });
  repository.initialize(scope, document, { sourceFingerprint: configurationFingerprint(document), sourceLabel: "test" }, () => {
    projection.adoptLegacyOwnership(scope); projection.project(scope, document);
  });
  const service = new ConfigurationAdminService(repository, { authorize() {}, projection });
  return { database, scope, repository, projection, service };
}
type Result = { revision: number; environmentId: string; changedSettings: string[] };
function command(): ConfigurationCommand<Result> {
  return { mutationId: randomUUID(), expectedRevision: 0,
    identity: { toolId: "environment.configure", sourceThreadId: randomUUID(), inputDigest: configurationFingerprint({ value: "literal-secret" }) },
    authorize: vi.fn(),
    build: vi.fn<ConfigurationCommand<Result>["build"]>(snapshot => ({
      configuration: { ...snapshot.configuration, executionEnvironments: snapshot.configuration.executionEnvironments.map(environment => ({ ...environment,
        environmentVariables: { execution: { TOKEN: { kind: "literal" as const, value: "literal-secret" } }, startup: {} } })) },
      scopeFacts: { environmentIds: [environmentId], crossEnvironment: false },
      present: result => ({ revision: result.revision, environmentId, changedSettings: ["execution.TOKEN"] }),
    })) };
}
function runtime(commitConfiguration: NonNullable<ConfigurationRuntimeAdapter["commitConfiguration"]>): ConfigurationRuntimeAdapter {
  return { commitConfiguration, observe: async () => [], reconcile: vi.fn(async () => {}),
    impact: async () => { throw new Error("not used"); }, execute: async () => { throw new Error("not used"); } };
}

describe("narrow configuration receipts", () => {
  it("migrates existing full-document receipts and enforces bounded atomic command metadata/result pairs", () => {
    const current = fixture(168);
    const snapshot = current.repository.get(current.scope);
    const request = { mutationId: randomUUID(), expectedRevision: 0, configuration: snapshot.configuration };
    current.database.prepare(`INSERT INTO execution_configuration_receipts
      (tenant_id,owner_principal_id,mutation_id,operation,request_fingerprint,request_json,result_json,created_at)
      VALUES (?,?,?,'save',?,?,?,0)`).run(current.scope.tenantId,current.scope.principalId,request.mutationId,
        configurationFingerprint(request),JSON.stringify(request),JSON.stringify(snapshot));
    applyDatabaseMigrations(current.database, backendNormalizedMigrations);
    expect(current.repository.replaySave(current.scope, request)).toEqual(snapshot);
    expect(current.repository.commandReceiptAuthority(current.scope, request.mutationId)).toBeUndefined();
    expect(() => current.database.prepare("UPDATE execution_configuration_receipts SET command_metadata_json='{}' WHERE mutation_id=?")
      .run(request.mutationId)).toThrow();
    expect(() => current.database.prepare("UPDATE execution_configuration_receipts SET command_metadata_json='{}',command_result_json=? WHERE mutation_id=?")
      .run(JSON.stringify("x".repeat(65_536)), request.mutationId)).toThrow();
    expect(current.repository.replaySave(current.scope, request)).toEqual(snapshot);
  });

  it("replays the original value-free result after a lost reply, intervening removal and restart, checking retained authority", async () => {
    const current = fixture();
    const request = command();
    const original = await current.service.saveCommand(current.scope, request);
    await current.service.save(current.scope, { mutationId: randomUUID(), expectedRevision: 1,
      configuration: { executionEnvironments: [], backends: [], targets: [], defaultTargetId: null, webSearch: null } });
    const restarted = new ConfigurationAdminService(new ConfigurationRepository(current.database), { authorize() {}, projection: current.projection });
    const build = vi.fn(() => { throw new Error("must not rebuild removed resource"); });
    expect(await restarted.saveCommand(current.scope, { ...request, build })).toEqual(original);
    expect(build).not.toHaveBeenCalled();
    expect(request.authorize).toHaveBeenLastCalledWith({ environmentIds: [environmentId], crossEnvironment: false });
    const row = current.database.prepare("SELECT command_metadata_json AS metadata, command_result_json AS result FROM execution_configuration_receipts WHERE mutation_id=?")
      .get(request.mutationId) as { metadata: string; result: string };
    expect(row.metadata + row.result).not.toContain("literal-secret");
    expect(current.repository.commandReceiptAuthority(current.scope, request.mutationId)).toEqual({ ...request.identity,
      scopeFacts: { environmentIds: [environmentId], crossEnvironment: false } });
    await expect(restarted.saveCommand(current.scope, { ...request, authorize() { throw new Error("permission revoked"); }, build })).rejects.toThrow("permission revoked");
  });

  it("rejects changed input, tool, caller and revision, and scopes receipts by principal", async () => {
    const current = fixture(); const request = command();
    await current.service.saveCommand(current.scope, request);
    for (const identity of [{ ...request.identity, inputDigest: "0".repeat(64) }, { ...request.identity, toolId: "backend.configure" }, { ...request.identity, sourceThreadId: randomUUID() }]) {
      await expect(current.service.saveCommand(current.scope, { ...request, identity })).rejects.toThrow("different contents");
    }
    await expect(current.service.saveCommand(current.scope, { ...request, expectedRevision: 1 })).rejects.toThrow("different contents");
    await expect(current.service.saveCommand({ ...current.scope, principalId: randomUUID() }, request)).rejects.toThrow("ownership");
    await expect(current.service.save(current.scope, { mutationId: request.mutationId, expectedRevision: 0,
      configuration: current.repository.get(current.scope).configuration })).rejects.toThrow();
  });

  it("coalesces concurrent identical commands before rebuilding or allocating identities", async () => {
    const current = fixture(); const request = command();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const adapter = runtime(async (_scope, _previous, _next, commit) => { await waiting; return commit(); });
    const service = new ConfigurationAdminService(current.repository, { authorize() {}, projection: current.projection, runtime: adapter });
    const first = service.saveCommand(current.scope, request);
    const second = service.saveCommand(current.scope, request);
    await Promise.resolve(); await Promise.resolve();
    expect(request.build).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toEqual(await second);
    expect(current.repository.get(current.scope).revision).toBe(1);
    expect(adapter.reconcile).toHaveBeenCalledTimes(1);
  });

  it("rechecks concurrent contenders inside the transaction and never projects the losing document", async () => {
    const current = fixture(); const request = command();
    const allocated: string[] = [];
    const creation: ConfigurationCommand<Result> = { ...request, build: snapshot => {
      const built = request.build(snapshot);
      const id = randomUUID(); allocated.push(id);
      built.configuration.backends.push({ id, kind: "pi", label: "Sibling", enabled: true, modelPolicy: { type: "catalog" } });
      built.configuration.targets.push({ id: `${id}-target`, kind: "pi_sdk", label: "Sibling connection", backendInstanceId: id, executionEnvironmentId: environmentId, enabled: true });
      return { ...built, present: committed => ({ revision: committed.revision, environmentId, changedSettings: [`backend:${id}`] }) };
    } };
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const adapter = runtime(async (_scope, _previous, _next, commit) => { await waiting; return commit(); });
    const delayed = new ConfigurationAdminService(current.repository, { authorize() {}, projection: current.projection, runtime: adapter });
    const contender = delayed.saveCommand(current.scope, creation);
    await Promise.resolve(); await Promise.resolve();
    const first = await current.service.saveCommand(current.scope, creation);
    release();
    expect(await contender).toEqual(first);
    expect(current.repository.get(current.scope).revision).toBe(1);
    expect(adapter.reconcile).not.toHaveBeenCalled();
    expect(allocated).toHaveLength(2);
    expect(current.database.prepare("SELECT resource_id FROM execution_configuration_identities WHERE resource_id=?").get(allocated[0])).toBeUndefined();
    expect(current.database.prepare("SELECT id FROM agent_backend_instances WHERE id=?").get(allocated[0])).toBeUndefined();
    expect(first.changedSettings).toEqual([`backend:${allocated[1]}`]);
  });

  it("rejects stale new commands before building and rolls back failed results and receipt overflow", async () => {
    const current = fixture(); const request = command();
    await current.service.saveCommand(current.scope, request);
    const stale = command();
    await expect(current.service.saveCommand(current.scope, stale)).rejects.toThrow("changed");
    expect(stale.build).not.toHaveBeenCalled();
    for (const present of [() => { throw new Error("projection failed"); }, () => ({ revision: 2, environmentId, changedSettings: ["x".repeat(70_000)] })]) {
      const failed = command();
      const allocatedBackend = randomUUID();
      const allocatedTarget = randomUUID();
      await expect(current.service.saveCommand(current.scope, { ...failed, expectedRevision: 1,
        build: snapshot => {
          const built = failed.build(snapshot);
          built.configuration.backends.push({ id: allocatedBackend, kind: "pi", label: "New sibling", enabled: true, modelPolicy: { type: "catalog" } });
          built.configuration.targets.push({ id: allocatedTarget, backendInstanceId: allocatedBackend, kind: "pi_sdk", label: "New connection", executionEnvironmentId: environmentId, enabled: true });
          return { ...built, present };
        } })).rejects.toThrow();
      expect(current.repository.get(current.scope).revision).toBe(1);
      expect(current.repository.commandReceiptAuthority(current.scope, failed.mutationId)).toBeUndefined();
      expect(current.database.prepare("SELECT resource_id FROM execution_configuration_identities WHERE resource_id IN (?,?)").all(allocatedBackend, allocatedTarget)).toEqual([]);
      expect(current.database.prepare("SELECT id FROM agent_backend_instances WHERE id=?").get(allocatedBackend)).toBeUndefined();
    }
  });

  it("rechecks authorization at transaction admission after an asynchronous wait", async () => {
    const current = fixture(); const request = command();
    let allowed = true;
    const service = new ConfigurationAdminService(current.repository, { authorize() {}, projection: current.projection,
      runtime: runtime(async (_scope, _previous, _next, commit) => { allowed = false; return commit(); }) });
    await expect(service.saveCommand(current.scope, { ...request, authorize() { if (!allowed) throw new Error("revoked at admission"); } })).rejects.toThrow("revoked at admission");
    expect(current.repository.get(current.scope).revision).toBe(0);
    expect(current.repository.commandReceiptAuthority(current.scope, request.mutationId)).toBeUndefined();
  });
});

function runtimeFixture() {
  const current = fixture();
  const observed = { ...current.repository.runtime(current.scope, "backend", "pi-primary"),
    incarnation: "provider-one", effectiveRevision: 0, applyState: "applied" as const, connectionState: "connected" as const,
    supportedActions: ["connect", "disconnect", "start", "stop", "restart", "upgrade"] as const,
    activeResources: 1,
  };
  current.repository.observe(current.scope, { ...observed, supportedActions: [...observed.supportedActions] });
  let sourceBackendId = "source-backend";
  const policy: ThreadAgentToolPolicyRecord = { tenantId: current.scope.tenantId, ownerPrincipalId: current.scope.principalId,
    applicationThreadId: "source", enabled: true, enabledToolIds: Object.keys(CANONICAL_AGENT_TOOL_MANIFEST).filter(id => id.startsWith("runtime.")),
    presentation: { surface: "cli", mode: "individual" }, resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false },
    revision: 1, updatedAt: 1, policySet: null };
  let enabled = true;
  const toolPolicies = { getDurable: () => ({ ...policy, enabled }) };
  const reader: AgentToolEnvironmentAuthorityReader = {
    resolveConfiguredEnvironment: (scope, id) => current.repository.get(scope).configuration.executionEnvironments.some(environment => environment.id === id) ? { id, environmentId: id } : undefined,
    resolveEnvironment: (_scope, id) => id === environmentId ? { id, environmentId: id } : undefined,
    resolveBackend: (scope, id) => { const target = current.repository.get(scope).configuration.targets.find(target => target.backendInstanceId === id); return target ? { id, environmentId: target.executionEnvironmentId } : undefined; },
    resolveRuntimeReceipt: (scope, id) => current.repository.lifecycleReceiptResource(scope, id),
    resolveConfigurationMutation: (scope, id) => current.repository.commandReceiptAuthority(scope, id),
    resolveThread: (_scope, id) => id === "source" ? { id, environmentId, workspaceId: "workspace", projectId: "project", backendInstanceId: sourceBackendId } : undefined,
    resolveTarget: () => undefined, resolveConfigurationTarget: () => undefined, resolveThreadTemplate: () => undefined,
    resolveWorkspace: () => undefined, resolveWorkspaceProject: () => "project", resolveAutomation: () => undefined,
    resolveThreadFamily: () => undefined, resolveSavedAgent: () => undefined, resolveTask: () => undefined,
    resolveWorkpad: () => undefined, resolveProject: () => undefined, listEnvironments: () => [{ id: environmentId, environmentId }],
  };
  const access = new ExecutionManagementAccess(reader, toolPolicies);
  const defaults = { kind: "thread_agent" as const, threadId: "source", workspaceId: "workspace", projectId: "project", environmentId };
  const policyIdentity = { ownerKind: "thread" as const, ownerId: "source", revision: 1 };
  const context = (operation: RuntimeManagementOperation, input: unknown): TrustedToolInvocationContext => ({
    ...current.scope, invocationId: randomUUID(), mutationId: randomUUID(), requestId: randomUUID(),
    subject: { kind: "thread_agent", sourceThreadId: "source", backendKind: "pi" }, defaults, policyIdentity,
    adapter: "cli", effectiveCapabilities: [], hasCapability: () => false, abortSignal: new AbortController().signal, reportProgress() {},
    environmentAuthority: { id: randomUUID(), callerKind: "thread_agent", defaults, policyIdentity,
      admittedEnvironmentIds: [environmentId], resourceScope: policy.resourceScope,
      ...new AgentToolEnvironmentAuthorityResolver(reader).resolve({ tool: CANONICAL_AGENT_TOOL_MANIFEST[operation], input,
        scope: current.scope, defaults, admittedEnvironmentIds: [environmentId], resourceScope: policy.resourceScope }) },
  });
  const execute = vi.fn<ConfigurationRuntimeAdapter["execute"]>(async (_scope, input) => ({ mutationId: input.request.mutationId, state: "applied",
    runtime: { ...input.runtime, effectiveRevision: input.runtime.desiredRevision, applyState: "applied", connectionState: "connected",
      lastError: "literal-secret diagnostic", effects: [{ component: "presentation", subjectId: "pi-primary", desiredRevision: input.runtime.desiredRevision,
        effectiveRevision: input.runtime.desiredRevision, state: "applied", detail: "literal-secret diagnostic" }] } }));
  const adapter: ConfigurationRuntimeAdapter = { observe: async () => [], reconcile: async () => {},
    impact: async (_scope, _request, runtime) => ({ runtime, fence: "work-fence", interruptions: ["One active turn"] }), execute };
  const admin = new ConfigurationAdminService(current.repository, { authorize() {}, projection: current.projection, runtime: adapter });
  const service = new RuntimeAgentToolService(() => admin, access);
  const input = () => ({ mutationId: randomUUID(), expectedRevision: current.repository.get(current.scope).revision,
    resourceKind: "backend" as const, resourceId: "pi-primary", expectedIncarnation: "provider-one", impactToken: null });
  return { ...current, admin, adapter, access, service, context, input, execute, reader,
    revoke: () => { enabled = false; }, sourceBackend: (id: string) => { sourceBackendId = id; } };
}

describe("runtime management tools", () => {
  it("registers closed thread-agent schemas and truthful lifecycle/receipt effects", () => {
    const current = runtimeFixture(); const registry = new AgentToolRegistry();
    const definitions = createRuntimeManagementToolDefinitions(current.service);
    for (const definition of definitions) {
      registry.register(definition);
      expect(definition.callerEligibility).toEqual(["thread_agent"]);
      expect(definition.inputSchema.additionalProperties).toBe(false);
    }
    expect(definitions.find(definition => definition.id === "runtime.operation.get")).toMatchObject({
      effects: { application: "write", modelUsage: "none", external: "durable_side_effect" }, execution: { uncertainExternalOutcome: true } });
    expect(definitions.find(definition => definition.id === "runtime.stop")).toMatchObject({
      effects: { application: "destructive", modelUsage: "none", external: "durable_side_effect" } });
  });

  it("keeps impact/incarnation fencing and replays a lost lifecycle reply after removal without executing again", async () => {
    const current = runtimeFixture();
    const request = current.input();
    await expect(current.service.execute(current.context("runtime.stop", request), "runtime.stop", request)).rejects.toThrow("impact confirmation");
    const impactRequest = { resourceKind: request.resourceKind, resourceId: request.resourceId, expectedRevision: 0, action: "stop" };
    const impact = await current.service.execute(current.context("runtime.impact", impactRequest), "runtime.impact", impactRequest);
    if (!("token" in impact)) throw new Error("impact expected");
    const fenced = { ...request, impactToken: impact.token };
    const wrongIncarnation = { ...fenced, expectedIncarnation: "stale" };
    await expect(current.service.execute(current.context("runtime.stop", wrongIncarnation), "runtime.stop", wrongIncarnation)).rejects.toThrow("stale");
    const result = await current.service.execute(current.context("runtime.stop", fenced), "runtime.stop", fenced);
    expect(JSON.stringify(result)).not.toContain("literal-secret");
    await current.admin.save(current.scope, { mutationId: randomUUID(), expectedRevision: 1,
      configuration: { executionEnvironments: [], backends: [], targets: [], defaultTargetId: null, webSearch: null } });
    expect(await current.service.execute(current.context("runtime.stop", fenced), "runtime.stop", fenced)).toEqual(result);
    expect(current.execute).toHaveBeenCalledTimes(1);
    const changed = { ...fenced, expectedRevision: 2 };
    await expect(current.service.execute(current.context("runtime.stop", changed), "runtime.stop", changed)).rejects.toThrow("different contents");
  });

  it("denies the source host/backend and Settings-only retirement before effects", async () => {
    const current = runtimeFixture();
    const sourceHost = { ...current.input(), resourceKind: "environment" as const, resourceId: environmentId };
    await expect(current.service.execute(current.context("runtime.disconnect", sourceHost), "runtime.disconnect", sourceHost)).rejects.toThrow("own tool invocation");
    current.sourceBackend("pi-primary");
    const request = current.input();
    await expect(current.service.execute(current.context("runtime.start", request), "runtime.start", request)).rejects.toThrow("own tool invocation");
    const sourceImpact = { resourceKind: "backend", resourceId: "pi-primary", expectedRevision: 0, action: "stop" };
    await expect(current.service.execute(current.context("runtime.impact", sourceImpact), "runtime.impact", sourceImpact))
      .resolves.toMatchObject({ resourceId: "pi-primary", interruptions: ["One active turn"] });
    const impact = { resourceKind: "backend", resourceId: "pi-primary", expectedRevision: 0, action: "confirm_retirement" };
    await expect(current.service.execute(current.context("runtime.impact", impact), "runtime.impact", impact)).rejects.toThrow();
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("authorizes retained receipt identity before recovery and does not turn lookup into execution", async () => {
    const current = runtimeFixture(); const input = current.input();
    const request = { ...input, action: "connect" as const };
    const admitted = current.repository.beginLifecycle(current.scope, request).result;
    const recover = vi.fn<NonNullable<ConfigurationRuntimeAdapter["recoverLifecycle"]>>(async () => ({ ...admitted, state: "applied",
      runtime: { ...admitted.runtime, applyState: "applied", effectiveRevision: admitted.runtime.desiredRevision } }));
    current.adapter.recoverLifecycle = recover;
    const lookup = { mutationId: input.mutationId };
    const context = current.context("runtime.operation.get", lookup);
    current.sourceBackend("pi-primary");
    await expect(current.service.execute(context, "runtime.operation.get", lookup)).rejects.toThrow("own tool invocation");
    expect(recover).not.toHaveBeenCalled();
    current.sourceBackend("source-backend");
    expect(await current.service.execute(context, "runtime.operation.get", lookup)).toMatchObject({ state: "applied" });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("rechecks permission after async service authorization and denies non-thread callers", async () => {
    const current = runtimeFixture(); const request = current.input(); const context = current.context("runtime.start", request);
    const admin = new ConfigurationAdminService(current.repository, { authorize: async () => { current.revoke(); },
      projection: current.projection, runtime: current.adapter });
    const service = new RuntimeAgentToolService(() => admin, current.access);
    await expect(service.execute(context, "runtime.start", request)).rejects.toMatchObject({ code: "permission_denied" });
    expect(current.repository.get(current.scope).revision).toBe(0);
    expect(current.execute).not.toHaveBeenCalled();
    await expect(service.execute({ ...context, subject: { kind: "principal_client", clientId: "client", credentialGeneration: 1 } },
      "runtime.start", request)).rejects.toMatchObject({ code: "permission_denied" });
  });
});
