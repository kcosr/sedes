import { assertOutboundPairingReferences } from "./configuration-outbound-pairing.js";
import type Database from "better-sqlite3";
import type { ConfigurationBackend, ConfigurationDocument } from "../../shared/protocol/configuration-admin.js";
import { configurationFingerprint } from "../config/configuration-fingerprint.js";
import { deriveConnectionProfileId } from "../db/connection-profile-id.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { configurationIdentities } from "./configuration-identities.js";

/** Existing identity tables are a projection, never a competing config source. */
export class ConfigurationProjection {
  constructor(readonly database: Database.Database,
    readonly protocolReleases: Readonly<Record<ConfigurationBackend["kind"], string>>,
    readonly now: () => number = Date.now) {}

  /** Must run inside ConfigurationRepository.initialize's import transaction. */
  adoptLegacyOwnership(scope: RequestScope): void {
    if (!this.database.inTransaction) throw new Error("configuration_import_transaction_required");
    const principals = this.database.prepare(`SELECT tenant_id AS tenantId, id AS principalId FROM principals WHERE kind = 'local_human'`).all() as RequestScope[];
    if (principals.length !== 1 || principals[0]?.tenantId !== scope.tenantId || principals[0]?.principalId !== scope.principalId) {
      throw new DomainError("conflict", "Legacy configuration ownership is ambiguous; exactly one matching local principal is required.");
    }
    const orphaned = this.database.prepare(`SELECT 1 FROM agent_backend_instances AS backend
      WHERE backend.owner_principal_id IS NULL AND (backend.tenant_id != ? OR EXISTS (
        SELECT 1 FROM agent_connection_profiles AS profile WHERE profile.tenant_id = backend.tenant_id
          AND profile.backend_instance_id = backend.id AND profile.owner_principal_id != ?
      ) OR EXISTS (SELECT 1 FROM application_threads AS thread WHERE thread.tenant_id = backend.tenant_id
          AND thread.backend_instance_id = backend.id AND thread.owner_principal_id != ?)) LIMIT 1`)
      .get(scope.tenantId, scope.principalId, scope.principalId);
    if (orphaned) throw new DomainError("conflict", "Legacy backend ownership is orphaned or ambiguous.");
    this.database.prepare(`UPDATE agent_backend_instances SET owner_principal_id = ?
      WHERE tenant_id = ? AND owner_principal_id IS NULL`).run(scope.principalId, scope.tenantId);
  }

  /** No provider I/O. Projection and desired definition commit together. */
  project(scope: RequestScope, document: ConfigurationDocument): void {
    if (!this.database.inTransaction) throw new Error("configuration_projection_transaction_required");
    for (const identity of configurationIdentities(document)) {
      const reserved = this.database.prepare(`SELECT identity_fingerprint AS fingerprint FROM execution_configuration_identities
        WHERE tenant_id = ? AND owner_principal_id = ? AND resource_kind = ? AND resource_id = ?`)
        .get(scope.tenantId, scope.principalId, identity.kind, identity.id) as { fingerprint: string } | undefined;
      if (reserved?.fingerprint !== identity.fingerprint) throw new DomainError("conflict", "Configuration projection requires a matching execution identity reservation.");
    }
    assertOutboundPairingReferences(this.database, scope, document);
    const now = this.now();
    for (const environment of document.executionEnvironments) {
      const fingerprint = configurationFingerprint(environment.kind === "local"
        ? { kind: environment.kind, workspaceRoots: environment.workspaceRoots }
        : environment.kind === "ssh" ? { kind: environment.kind, hostAlias: environment.hostAlias, workspaceRoots: environment.workspaceRoots }
        : { kind: environment.kind, pairingId: environment.pairingId, platform: environment.platform, workspaceRoots: environment.workspaceRoots });
      const operationsFingerprint = configurationFingerprint(environment.kind === "local"
        ? { kind: "local", workspaceIsolation: environment.workspaceIsolation }
        : environment.operations);
      const current = this.database.prepare(`SELECT kind, label, diagnostic_code AS diagnosticCode, configuration_fingerprint AS fingerprint,
        operations_configuration_fingerprint AS operationsFingerprint FROM execution_environments
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
        .get(scope.tenantId, scope.principalId, environment.id) as { kind: string; label: string; diagnosticCode: string | null; fingerprint: string; operationsFingerprint: string } | undefined;
      if (current) {
        if (current.kind !== environment.kind) throw new DomainError("conflict", "The environment kind is immutable.");
        const authorityChanged = current.fingerprint !== fingerprint;
        const operationsChanged = current.operationsFingerprint !== operationsFingerprint;
        const labelChanged = current.label !== environment.label;
        const requiresApply = authorityChanged || operationsChanged || current.diagnosticCode === "configuration_removed";
        if (requiresApply || labelChanged) this.database.prepare(`UPDATE execution_environments
          SET label = ?, configuration_fingerprint = ?, operations_configuration_fingerprint = ?,
            configuration_revision = configuration_revision + ?, operations_configuration_revision = operations_configuration_revision + ?,
            revision = revision + 1, availability = CASE WHEN ? THEN 'unavailable' ELSE availability END,
            diagnostic_code = CASE WHEN ? THEN 'configuration_apply_pending' ELSE diagnostic_code END, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
          .run(environment.label, fingerprint, operationsFingerprint, authorityChanged ? 1 : 0, operationsChanged ? 1 : 0,
            requiresApply ? 1 : 0, requiresApply ? 1 : 0,
            now, scope.tenantId, scope.principalId, environment.id);
      } else {
        this.database.prepare(`INSERT INTO execution_environments
          (tenant_id, owner_principal_id, id, kind, label, availability, diagnostic_code, revision,
            configuration_revision, configuration_fingerprint, operations_configuration_revision, operations_configuration_fingerprint, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'unavailable', 'configuration_apply_pending', 0, 0, ?, 0, ?, ?, ?)`)
          .run(scope.tenantId, scope.principalId, environment.id, environment.kind, environment.label, fingerprint, operationsFingerprint, now, now);
      }
    }
    for (const backend of document.backends) {
      const fingerprint = configurationFingerprint({ moduleConfiguration: "moduleConfiguration" in backend ? backend.moduleConfiguration : null, modelPolicy: backend.modelPolicy, startupEnvironmentVariables: backend.environmentVariables?.startup ?? {} });
      const release = this.protocolReleases[backend.kind];
      if (!release) throw new Error("configuration_compiled_backend_release_missing");
      const current = this.database.prepare(`SELECT owner_principal_id AS principalId, kind, label, enabled,
        configuration_fingerprint AS fingerprint, protocol_release AS release FROM agent_backend_instances WHERE tenant_id = ? AND id = ?`)
        .get(scope.tenantId, backend.id) as { principalId: string | null; kind: string; label: string; enabled: number; fingerprint: string; release: string } | undefined;
      if (current) {
        if (current.principalId !== scope.principalId) throw new DomainError("not_found", "The backend identity is unavailable in this scope.");
        if (current.kind !== backend.kind) throw new DomainError("conflict", "Backend kind is immutable.");
        if (current.label !== backend.label || current.enabled !== Number(backend.enabled) || current.fingerprint !== fingerprint || current.release !== release) {
          this.database.prepare(`UPDATE agent_backend_instances SET label = ?, enabled = ?, configuration_fingerprint = ?,
            protocol_release = ?, configuration_revision = configuration_revision + 1, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
            .run(backend.label, Number(backend.enabled), fingerprint, release, now, scope.tenantId, scope.principalId, backend.id);
        }
      } else this.database.prepare(`INSERT INTO agent_backend_instances
        (tenant_id, owner_principal_id, id, kind, label, enabled, configuration_revision, configuration_fingerprint, protocol_release, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
        .run(scope.tenantId, scope.principalId, backend.id, backend.kind, backend.label, Number(backend.enabled), fingerprint, release, now, now);
    }
    for (const target of document.targets) {
      const backend = document.backends.find(candidate => candidate.id === target.backendInstanceId);
      if (!backend) throw new DomainError("bad_request", "Target backend is missing.");
      const fingerprint = configurationFingerprint("moduleConfiguration" in target ? target.moduleConfiguration : null);
      const current = this.database.prepare(`SELECT id, backend_instance_id AS backendId, execution_environment_id AS environmentId,
        kind, label, enabled, configuration_fingerprint AS fingerprint FROM agent_connection_profiles
        WHERE tenant_id = ? AND owner_principal_id = ? AND template_id = ?`)
        .get(scope.tenantId, scope.principalId, target.id) as { id: string; backendId: string; environmentId: string; kind: string; label: string; enabled: number; fingerprint: string } | undefined;
      if (current) {
        if (current.backendId !== target.backendInstanceId || current.environmentId !== target.executionEnvironmentId || current.kind !== target.kind) throw new DomainError("conflict", "Target binding is immutable.");
        if (current.label !== target.label || current.enabled !== Number(target.enabled) || current.fingerprint !== fingerprint) this.database.prepare(`UPDATE agent_connection_profiles
          SET label = ?, enabled = ?, configuration_fingerprint = ?, configuration_revision = configuration_revision + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
          .run(target.label, Number(target.enabled), fingerprint, now, scope.tenantId, scope.principalId, current.id);
      } else this.database.prepare(`INSERT INTO agent_connection_profiles
        (tenant_id, owner_principal_id, id, template_id, backend_instance_id, backend_kind, execution_environment_id,
          kind, label, enabled, configuration_revision, configuration_fingerprint, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
        .run(scope.tenantId, scope.principalId, deriveConnectionProfileId(scope.tenantId, scope.principalId, target.id), target.id,
          target.backendInstanceId, backend.kind, target.executionEnvironmentId, target.kind, target.label, Number(target.enabled), fingerprint, now, now);
    }
    // Retain every old binding and native-history association. Removal disables
    // admission; it never deletes a row or reassigns its identity.
    const targets = new Set(document.targets.map(item => item.id));
    const oldTargets = this.database.prepare(`SELECT template_id AS id FROM agent_connection_profiles WHERE tenant_id = ? AND owner_principal_id = ? AND enabled = 1`).all(scope.tenantId, scope.principalId) as { id: string }[];
    for (const target of oldTargets) if (!targets.has(target.id)) this.database.prepare(`UPDATE agent_connection_profiles SET enabled = 0, configuration_revision = configuration_revision + 1, updated_at = ? WHERE tenant_id = ? AND owner_principal_id = ? AND template_id = ?`).run(now, scope.tenantId, scope.principalId, target.id);
    const backends = new Set(document.backends.map(item => item.id));
    const oldBackends = this.database.prepare(`SELECT id FROM agent_backend_instances WHERE tenant_id = ? AND owner_principal_id = ? AND enabled = 1`).all(scope.tenantId, scope.principalId) as { id: string }[];
    for (const backend of oldBackends) if (!backends.has(backend.id)) this.database.prepare(`UPDATE agent_backend_instances SET enabled = 0, configuration_revision = configuration_revision + 1, updated_at = ? WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`).run(now, scope.tenantId, scope.principalId, backend.id);
    const environments = new Set(document.executionEnvironments.map(item => item.id));
    const oldEnvironments = this.database.prepare(`SELECT id FROM execution_environments WHERE tenant_id = ? AND owner_principal_id = ?
      AND (availability != 'unavailable' OR diagnostic_code IS NOT 'configuration_removed')`).all(scope.tenantId, scope.principalId) as { id: string }[];
    for (const environment of oldEnvironments) if (!environments.has(environment.id)) this.database.prepare(`UPDATE execution_environments SET availability = 'unavailable', diagnostic_code = 'configuration_removed', revision = revision + 1, updated_at = ? WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`).run(now, scope.tenantId, scope.principalId, environment.id);
  }
}
