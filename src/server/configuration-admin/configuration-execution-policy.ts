import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { executionPolicyBytes, type ExecutionPolicySnapshot, type InstalledExecutionPolicy } from "../../internal/sidecar-protocol/execution-policy.js";
import type { ConfigurationDocument, ConfigurationEnvironment } from "../../shared/protocol/configuration-admin.js";
import { providerLaunchDigest } from "../backends/provider-launch-digest.js";
import { configurationFingerprint } from "../config/configuration-fingerprint.js";
import type { RequestScope } from "../identity/identity-provider.js";

type Subject = { readonly id: string; readonly generation: number };
const EMPTY: ExecutionPolicySnapshot = { roots: [], capabilities: [], backends: [] };

interface PolicyRow { revision: number; snapshot: string; digest: string; generation: number }
function policyRow(database: Database.Database, scope: RequestScope, id: string): PolicyRow | undefined {
  return database.prepare(`SELECT revision, snapshot_json AS snapshot, digest, last_generation AS generation
    FROM live_execution_policies WHERE tenant_id = ? AND owner_principal_id = ? AND environment_id = ?`)
    .get(scope.tenantId, scope.principalId, id) as PolicyRow | undefined;
}

// Authority reads occur on stream delivery and tool invocations. Read a small durable stamp on every admission,
// transferring and decoding the host snapshot only when the committed digest has changed.
const hostsByDatabase = new WeakMap<Database.Database, {
  readonly read: Database.Statement;
  readonly snapshots: Map<string, InstalledExecutionPolicy>;
}>();

export function executionPolicyRoots(database: Database.Database, scope: RequestScope, environmentId: string): ExecutionPolicySnapshot["roots"] {
  return hostExecutionPolicy(database, scope, environmentId)?.snapshot.roots ?? [];
}

export function hostExecutionPolicy(database: Database.Database, scope: RequestScope, environmentId: string): InstalledExecutionPolicy | undefined {
  let cache = hostsByDatabase.get(database);
  if (!cache) {
    cache = { snapshots: new Map(), read: database.prepare(`SELECT policy.revision, policy.digest,
      env.configuration_revision AS environmentRevision, env.operations_configuration_revision AS operationsRevision,
      CASE WHEN policy.digest = ? THEN NULL ELSE policy.snapshot_json END AS snapshot
      FROM live_execution_policies AS policy JOIN execution_environments AS env
        ON env.tenant_id = policy.tenant_id AND env.owner_principal_id = policy.owner_principal_id AND env.id = policy.environment_id
      WHERE policy.tenant_id = ? AND policy.owner_principal_id = ? AND policy.environment_id = ?`) };
    hostsByDatabase.set(database, cache);
  }
  const key = JSON.stringify([scope.tenantId, scope.principalId, environmentId]);
  const cached = cache.snapshots.get(key);
  const row = cache.read.get(cached?.digest ?? null, scope.tenantId, scope.principalId, environmentId) as {
    revision: number; digest: string; snapshot: string | null; environmentRevision: number; operationsRevision: number;
  } | undefined;
  if (!row) { cache.snapshots.delete(key); return undefined; }
  if (cached && row.snapshot === null && cached.revision === row.revision &&
      cached.configuration.environmentRevision === row.environmentRevision && cached.configuration.operationsRevision === row.operationsRevision) return cached;
  const snapshot = row.snapshot === null ? cached!.snapshot : freezePolicy(JSON.parse(row.snapshot) as ExecutionPolicySnapshot);
  const value = Object.freeze({ revision: row.revision, digest: row.digest, snapshot,
    configuration: Object.freeze({environmentRevision: row.environmentRevision, operationsRevision: row.operationsRevision}) });
  cache.snapshots.set(key, value);
  if (cache.snapshots.size > 64) cache.snapshots.delete(cache.snapshots.keys().next().value!);
  return value;
}

function freezePolicy(snapshot: ExecutionPolicySnapshot): ExecutionPolicySnapshot {
  for (const backend of snapshot.backends) {
    backend.targets.forEach(Object.freeze);
    Object.freeze(backend.targets);
    Object.freeze(backend);
  }
  snapshot.roots.forEach(Object.freeze);
  snapshot.capabilities.forEach(Object.freeze);
  Object.freeze(snapshot.roots);
  Object.freeze(snapshot.capabilities);
  Object.freeze(snapshot.backends);
  return Object.freeze(snapshot);
}

export function rootGrantId(scope: RequestScope, environmentId: string, path: string): string {
  return configurationFingerprint({ tenant: scope.tenantId, principal: scope.principalId, environment: environmentId, root: path });
}

function historicalGenerationFloor(database: Database.Database, scope: RequestScope, environmentId: string): number {
  const args = [scope.tenantId, scope.principalId, environmentId];
  const row = database.prepare(`SELECT COALESCE(MAX(n), 0) AS floor FROM (
    SELECT configuration_revision AS n FROM execution_environments WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
    UNION ALL SELECT MAX(environment_configuration_revision) FROM workspaces WHERE tenant_id = ? AND owner_principal_id = ? AND environment_id = ?
    UNION ALL SELECT MAX(environment_authority_revision) FROM attachment_materializations WHERE tenant_id = ? AND owner_principal_id = ? AND execution_environment_id = ?
  )`).get(...args, ...args, ...args) as { floor: number };
  return row.floor;
}

/** Generations are never reused, including across offline withdrawal/regrant and host removal. */
export function writeExecutionPolicy(database: Database.Database, scope: RequestScope, environmentId: string, document: ConfigurationDocument): ExecutionPolicySnapshot {
  if (!database.inTransaction) throw new Error("execution_policy_transaction_required");
  const previous = policyRow(database, scope, environmentId);
  const before = previous ? JSON.parse(previous.snapshot) as ExecutionPolicySnapshot : EMPTY;
  let generation = previous?.generation ?? historicalGenerationFloor(database, scope, environmentId);
  function subject(id: string, grants: readonly Subject[]): Subject {
    return { id, generation: grants.find(item => item.id === id)?.generation ?? ++generation };
  }
  const environment = document.executionEnvironments.find(item => item.id === environmentId);
  const roots = [...environment?.workspaceRoots ?? []].sort().map(path => {
    const id = rootGrantId(scope, environmentId, path);
    return { ...subject(id, before.roots), path };
  }).sort(compareIds);
  const capabilities = environment && environment.kind !== "local" && environment.operations.kind === "sidecar"
    ? [...environment.operations.enabledCapabilities].sort().map(id => subject(id, before.capabilities)) : [];
  const bindings = document.targets.filter(target => target.executionEnvironmentId === environmentId);
  const backends = document.backends.filter(backend => backend.enabled &&
    (backend.kind !== "grok_build" || environment?.kind === "local") && bindings.some(target => target.backendInstanceId === backend.id))
    .sort(compareIds).map(backend => {
      const incumbent = before.backends.find(item => item.id === backend.id);
      return { ...subject(backend.id, before.backends), kind: backend.kind, launchDigest: providerLaunchDigest(backend, environment?.environmentVariables?.startup),
        ...(backend.kind === "codex_app_server" ? { managedTuiDigest: configurationFingerprint(backend.moduleConfiguration.tuiExecutablePath ?? null) } : {}),
        targets: bindings.filter(target => target.enabled && target.backendInstanceId === backend.id).sort(compareIds)
          .map(target => subject(target.id, incumbent?.targets ?? [])) };
    });
  const snapshot = { roots, capabilities, backends } satisfies ExecutionPolicySnapshot;
  const bytes = executionPolicyBytes(snapshot);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (previous?.digest === digest) return snapshot;
  database.prepare(`INSERT INTO live_execution_policies
    (tenant_id, owner_principal_id, environment_id, revision, snapshot_json, digest, last_generation) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, owner_principal_id, environment_id) DO UPDATE SET revision = excluded.revision,
      snapshot_json = excluded.snapshot_json, digest = excluded.digest, last_generation = excluded.last_generation`)
    .run(scope.tenantId, scope.principalId, environmentId, (previous?.revision ?? 0) + 1, bytes.toString("utf8"), digest, generation);
  return snapshot;
}

export function compareIds(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function environmentFingerprints(environment: ConfigurationEnvironment, snapshot: ExecutionPolicySnapshot) {
  return { fingerprint: configurationFingerprint(snapshot.roots), operationsFingerprint: configurationFingerprint({
    backends: snapshot.backends, capabilities: snapshot.capabilities,
    isolation: environment.kind === "local" ? environment.workspaceIsolation : null,
  }) };
}
