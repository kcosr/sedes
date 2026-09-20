import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  acceptHostRegistrationRequestSchema, acceptHostRegistrationResultSchema,
  changeHostPairingRequestSchema, changeHostPairingResultSchema,
  denyHostRegistrationRequestSchema, hostMetadataSchema, hostPairingListSchema,
  hostPairingSchema, hostRegistrationSchema, registerHostRequestSchema,
  type AcceptHostRegistrationRequest, type AcceptHostRegistrationResult,
  type ChangeHostPairingRequest, type ChangeHostPairingResult, type DenyHostRegistrationRequest,
  type HostMetadata, type HostPairing, type HostPairingList, type HostRegistration, type RegisterHostRequest,
} from "../../shared/protocol/host-pairing.js";
import type { ConfigurationDocument } from "../../shared/protocol/configuration-admin.js";
import { configurationFingerprint } from "../config/configuration-fingerprint.js";
import { ConfigurationRepository } from "../configuration-admin/configuration-repository.js";
import { validateConfigurationDocument } from "../configuration-admin/configuration-validation.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";

type RegistrationRow = {
  id: string; connectorId: string; registrationAttemptId: string; correlationCode: string; metadata: string;
  state: HostRegistration["state"]; revision: number; createdAt: number; updatedAt: number;
  lastSeenAt: number; expiresAt: number; pairingId: string | null;
};
type PairingRow = {
  id: string; connectorId: string; executionEnvironmentId: string; platform: HostPairing["platform"];
  metadata: string; state: HostPairing["state"]; revision: number; createdAt: number; updatedAt: number; lastSeenAt: number;
};
const registrationColumns = `id, connector_id AS connectorId, attempt_id AS registrationAttemptId,
  correlation_code AS correlationCode, metadata_json AS metadata, state, revision, created_at AS createdAt,
  updated_at AS updatedAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt, pairing_id AS pairingId`;
const pairingColumns = `id, connector_id AS connectorId, environment_id AS executionEnvironmentId, platform,
  metadata_json AS metadata, state, revision, created_at AS createdAt, updated_at AS updatedAt, last_seen_at AS lastSeenAt`;
const iso = (value: number) => new Date(value).toISOString();
function registration(row: RegistrationRow): HostRegistration {
  return hostRegistrationSchema.parse({ ...row, metadata: JSON.parse(row.metadata), createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt), lastSeenAt: iso(row.lastSeenAt), expiresAt: iso(row.expiresAt) });
}
function pairing(row: PairingRow): HostPairing {
  return hostPairingSchema.parse({ ...row, metadata: JSON.parse(row.metadata), createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt), lastSeenAt: iso(row.lastSeenAt) });
}

type Operation = "accept" | "deny" | "revoke" | "reapprove";
export interface HostPairingRepositoryOptions {
  readonly project: (scope: RequestScope, document: ConfigurationDocument) => void;
  readonly now?: () => number;
  readonly registrationTtlMs?: number;
  readonly maxRegistrations?: number;
}

/** Principal-scoped association state. No socket, caller authentication, or remote effects. */
export class HostPairingRepository {
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #maximum: number;
  constructor(readonly database: Database.Database, readonly configuration: ConfigurationRepository,
    readonly options: HostPairingRepositoryOptions) {
    if (configuration.database !== database) throw new Error("host_pairing_transaction_database_mismatch");
    this.#now = options.now ?? Date.now;
    this.#ttl = options.registrationTtlMs ?? 24 * 60 * 60 * 1000;
    this.#maximum = options.maxRegistrations ?? 256;
    if (!Number.isSafeInteger(this.#ttl) || this.#ttl < 1 || this.#ttl > 7 * 24 * 60 * 60 * 1000 ||
      !Number.isSafeInteger(this.#maximum) || this.#maximum < 1 || this.#maximum > 256) throw new Error("host_pairing_limits_invalid");
  }

  register(scope: RequestScope, value: RegisterHostRequest): HostRegistration {
    const input = registerHostRequestSchema.parse(value);
    return this.database.transaction(() => {
      this.configuration.assertPrincipal(scope);
      this.#expire(scope);
      const existing = this.database.prepare(`SELECT ${registrationColumns} FROM host_registration_requests
        WHERE tenant_id = ? AND owner_principal_id = ? AND connector_id = ? AND attempt_id = ?`)
        .get(scope.tenantId, scope.principalId, input.connectorId, input.registrationAttemptId) as RegistrationRow | undefined;
      if (existing) {
        // Decisions survive reply loss. Metadata cannot change an accepted platform/binding.
        if (existing.state !== "pending") return registration(existing);
        const changed = configurationFingerprint(JSON.parse(existing.metadata)) !== configurationFingerprint(input.metadata);
        this.database.prepare(`UPDATE host_registration_requests SET metadata_json = ?, last_seen_at = ?,
          revision = revision + ?, updated_at = CASE WHEN ? THEN ? ELSE updated_at END
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
          .run(JSON.stringify(input.metadata), this.#now(), Number(changed), Number(changed), this.#now(), scope.tenantId, scope.principalId, existing.id);
        return this.getRegistration(scope, existing.id);
      }
      if (this.pairingForConnector(scope, input.connectorId)) throw new DomainError("conflict", "This connector already has a pairing. Resume it or explicitly reapprove its retained binding.");
      const pending = this.database.prepare(`SELECT 1 FROM host_registration_requests WHERE tenant_id = ? AND owner_principal_id = ? AND connector_id = ? AND state = 'pending'`)
        .get(scope.tenantId, scope.principalId, input.connectorId);
      if (pending) throw new DomainError("conflict", "This connector already has a pending registration attempt.");
      this.#capacity(scope);
      const id = randomUUID();
      const code = randomBytes(4).toString("hex").toUpperCase();
      const now = this.#now();
      this.database.prepare(`INSERT INTO host_registration_requests
        (tenant_id, owner_principal_id, id, connector_id, attempt_id, correlation_code, metadata_json, state, revision, created_at, updated_at, last_seen_at, expires_at, pairing_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, NULL)`)
        .run(scope.tenantId, scope.principalId, id, input.connectorId, input.registrationAttemptId, `${code.slice(0, 4)}-${code.slice(4)}`,
          JSON.stringify(input.metadata), now, now, now, now + this.#ttl);
      return this.getRegistration(scope, id);
    })();
  }

  getRegistration(scope: RequestScope, id: string): HostRegistration {
    this.configuration.assertPrincipal(scope);
    this.#expire(scope);
    const row = this.database.prepare(`SELECT ${registrationColumns} FROM host_registration_requests WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
      .get(scope.tenantId, scope.principalId, id) as RegistrationRow | undefined;
    if (!row) throw new DomainError("not_found", "The host registration is unavailable in this scope.");
    return registration(row);
  }

  getPairing(scope: RequestScope, id: string): HostPairing {
    this.configuration.assertPrincipal(scope);
    const row = this.database.prepare(`SELECT ${pairingColumns} FROM host_pairings WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
      .get(scope.tenantId, scope.principalId, id) as PairingRow | undefined;
    if (!row) throw new DomainError("not_found", "The host pairing is unavailable in this scope.");
    return pairing(row);
  }

  pairingForConnector(scope: RequestScope, connectorId: string): HostPairing | undefined {
    return this.#findPairing(scope, "connector_id", connectorId);
  }
  pairingForEnvironment(scope: RequestScope, environmentId: string): HostPairing | undefined {
    return this.#findPairing(scope, "environment_id", environmentId);
  }
  #findPairing(scope: RequestScope, column: "connector_id" | "environment_id", value: string): HostPairing | undefined {
    this.configuration.assertPrincipal(scope);
    const row = this.database.prepare(`SELECT ${pairingColumns} FROM host_pairings WHERE tenant_id = ? AND owner_principal_id = ? AND ${column} = ?`)
      .get(scope.tenantId, scope.principalId, value) as PairingRow | undefined;
    return row ? pairing(row) : undefined;
  }

  observe(scope: RequestScope, pairingId: string, value: HostMetadata): HostPairing {
    const metadata = hostMetadataSchema.parse(value);
    return this.database.transaction(() => {
      const current = this.getPairing(scope, pairingId);
      if (current.state !== "accepted" || current.platform !== metadata.platform) throw new DomainError("conflict", "The current host pairing does not admit this platform.");
      this.database.prepare(`UPDATE host_pairings SET metadata_json = ?, last_seen_at = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
        .run(JSON.stringify(metadata), this.#now(), scope.tenantId, scope.principalId, pairingId);
      return this.getPairing(scope, pairingId);
    })();
  }

  list(scope: RequestScope): HostPairingList {
    this.configuration.assertPrincipal(scope);
    this.#expire(scope);
    const registrations = this.database.prepare(`SELECT ${registrationColumns} FROM host_registration_requests
      WHERE tenant_id = ? AND owner_principal_id = ? ORDER BY created_at DESC, id`).all(scope.tenantId, scope.principalId) as RegistrationRow[];
    const pairings = this.database.prepare(`SELECT ${pairingColumns} FROM host_pairings
      WHERE tenant_id = ? AND owner_principal_id = ? ORDER BY created_at DESC, id`).all(scope.tenantId, scope.principalId) as PairingRow[];
    // Durable observations never establish presence. The carrier overlays current sessions.
    return hostPairingListSchema.parse({ registrations: registrations.map(row => ({ ...registration(row), connected: false })),
      pairings: pairings.map(row => ({ ...pairing(row), connected: false })) });
  }

  accept(scope: RequestScope, value: AcceptHostRegistrationRequest): AcceptHostRegistrationResult {
    const input = acceptHostRegistrationRequestSchema.parse(value);
    return this.database.transaction(() => {
      const replay = this.#replay(scope, input.mutationId, "accept", input);
      if (replay) return acceptHostRegistrationResultSchema.parse(replay);
      const request = this.getRegistration(scope, input.registrationId);
      this.#pending(request, input.expectedRegistrationRevision);
      const current = this.configuration.get(scope);
      this.#configurationRevision(current.revision, input.expectedConfigurationRevision);
      const existing = this.pairingForConnector(scope, request.connectorId);
      if (existing) throw new DomainError("conflict", "This connector identity already belongs to a retained environment.");
      const environmentId = randomUUID();
      const pairingId = randomUUID();
      const now = this.#now();
      this.database.prepare(`INSERT INTO host_pairings
        (tenant_id, owner_principal_id, id, connector_id, environment_id, platform, metadata_json, state, revision, created_at, updated_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', 0, ?, ?, ?)`)
        .run(scope.tenantId, scope.principalId, pairingId, request.connectorId, environmentId, request.metadata.platform,
          JSON.stringify(request.metadata), now, now, Date.parse(request.lastSeenAt));
      const document = validateConfigurationDocument({ ...current.configuration, executionEnvironments: [...current.configuration.executionEnvironments,
        { id: environmentId, kind: "outbound", pairingId, platform: request.metadata.platform, label: input.label,
          workspaceRoots: input.workspaceRoots, operations: input.operations }] });
      const configuration = this.configuration.save(scope, { mutationId: input.mutationId, expectedRevision: input.expectedConfigurationRevision,
        configuration: document }, value => this.options.project(scope, value));
      this.database.prepare(`UPDATE host_registration_requests SET state = 'accepted', pairing_id = ?, revision = revision + 1, updated_at = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
        .run(pairingId, now, scope.tenantId, scope.principalId, request.id);
      const result = { registration: this.getRegistration(scope, request.id), pairing: this.getPairing(scope, pairingId), configuration };
      this.#receipt(scope, input.mutationId, "accept", input, result);
      return acceptHostRegistrationResultSchema.parse(result);
    })();
  }

  deny(scope: RequestScope, value: DenyHostRegistrationRequest): HostRegistration {
    const input = denyHostRegistrationRequestSchema.parse(value);
    return this.database.transaction(() => {
      const replay = this.#replay(scope, input.mutationId, "deny", input);
      if (replay) return hostRegistrationSchema.parse(replay);
      const request = this.getRegistration(scope, input.registrationId);
      this.#pending(request, input.expectedRegistrationRevision);
      this.database.prepare(`UPDATE host_registration_requests SET state = 'denied', revision = revision + 1, updated_at = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`).run(this.#now(), scope.tenantId, scope.principalId, request.id);
      const result = this.getRegistration(scope, request.id);
      this.#receipt(scope, input.mutationId, "deny", input, result);
      return result;
    })();
  }

  revoke(scope: RequestScope, value: ChangeHostPairingRequest): ChangeHostPairingResult { return this.#change(scope, value, "revoke"); }
  reapprove(scope: RequestScope, value: ChangeHostPairingRequest): ChangeHostPairingResult { return this.#change(scope, value, "reapprove"); }

  #change(scope: RequestScope, value: ChangeHostPairingRequest, operation: "revoke" | "reapprove"): ChangeHostPairingResult {
    const input = changeHostPairingRequestSchema.parse(value);
    return this.database.transaction(() => {
      const replay = this.#replay(scope, input.mutationId, operation, input);
      if (replay) return changeHostPairingResultSchema.parse(replay);
      const current = this.getPairing(scope, input.pairingId);
      if (current.revision !== input.expectedPairingRevision || current.revision >= Number.MAX_SAFE_INTEGER ||
        current.state !== (operation === "revoke" ? "accepted" : "revoked")) throw new DomainError("conflict", "The pairing state changed. Refresh before continuing.");
      const snapshot = this.configuration.get(scope);
      this.#configurationRevision(snapshot.revision, input.expectedConfigurationRevision);
      if (!snapshot.configuration.executionEnvironments.some(environment => environment.id === current.executionEnvironmentId &&
        environment.kind === "outbound" && environment.pairingId === current.id)) throw new DomainError("conflict", "The paired environment was removed. It cannot be silently recreated.");
      this.database.prepare(`UPDATE host_pairings SET state = ?, revision = revision + 1, updated_at = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
        .run(operation === "revoke" ? "revoked" : "accepted", this.#now(), scope.tenantId, scope.principalId, current.id);
      const saved = this.configuration.save(scope, { mutationId: input.mutationId, expectedRevision: input.expectedConfigurationRevision,
        configuration: snapshot.configuration }, value => this.options.project(scope, value));
      // Pairing admission has a new generation; workspace roots and grants do not.
      // Keep the owner's configuration authority usable after explicit reapproval.
      // Pairing/session fences revoke admission; this observation clears readiness.
      const runtime = this.configuration.runtime(scope, "environment", current.executionEnvironmentId);
      this.database.prepare(`UPDATE execution_configuration_runtime_state SET state_json = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND resource_kind = 'environment' AND resource_id = ?`)
        .run(JSON.stringify({ ...runtime, desiredRevision: saved.revision, effectiveRevision: null,
          preference: operation === "revoke" ? "disconnected" : "automatic", applyState: "unavailable",
          connectionState: "disconnected", lastError: operation === "revoke" ? "The host pairing was revoked." : "Waiting for the paired host to reconnect." }),
          scope.tenantId, scope.principalId, current.executionEnvironmentId);
      this.database.prepare(`UPDATE execution_environments SET availability = 'unavailable', diagnostic_code = ?,
        revision = revision + 1, updated_at = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
        .run(operation === "revoke" ? "host_pairing_revoked" : "outbound_host_disconnected", this.#now(), scope.tenantId, scope.principalId, current.executionEnvironmentId);
      const result = { pairing: this.getPairing(scope, current.id), configuration: this.configuration.get(scope) };
      this.#receipt(scope, input.mutationId, operation, input, result);
      return changeHostPairingResultSchema.parse(result);
    })();
  }

  #pending(request: HostRegistration, revision: number): void {
    if (request.state !== "pending" || request.revision !== revision || revision >= Number.MAX_SAFE_INTEGER) {
      throw new DomainError("conflict", "The host registration changed or expired. Refresh before deciding.");
    }
  }
  #configurationRevision(actual: number, expected: number): void {
    if (actual !== expected || expected >= Number.MAX_SAFE_INTEGER) throw new DomainError("conflict", "Configuration changed. Refresh before deciding.");
  }
  #expire(scope: RequestScope): void {
    this.database.prepare(`UPDATE host_registration_requests SET state = 'expired', revision = revision + 1, updated_at = ?
      WHERE tenant_id = ? AND owner_principal_id = ? AND state = 'pending' AND expires_at <= ?`)
      .run(this.#now(), scope.tenantId, scope.principalId, this.#now());
  }
  #capacity(scope: RequestScope): void {
    const row = this.database.prepare(`SELECT count(*) AS count FROM host_registration_requests WHERE tenant_id = ? AND owner_principal_id = ?`)
      .get(scope.tenantId, scope.principalId) as { count: number };
    const required = row.count - this.#maximum + 1;
    if (required <= 0) return;
    // Retain active requests and accepted binding recovery permanently. Terminal
    // history is bounded: an evicted connector attempt gets a new server request
    // ID and needs fresh approval. Old decisions cannot address that new request;
    // mutation receipts remain intact, including exact denial replay.
    const removed = this.database.prepare(`DELETE FROM host_registration_requests
      WHERE tenant_id = ? AND owner_principal_id = ? AND id IN (
        SELECT id FROM host_registration_requests
        WHERE tenant_id = ? AND owner_principal_id = ? AND state IN ('denied', 'expired')
        ORDER BY updated_at, created_at, id LIMIT ?
      )`).run(scope.tenantId, scope.principalId, scope.tenantId, scope.principalId, required);
    if (removed.changes < required) throw new DomainError("conflict", "Host registration capacity has been reached by pending or accepted requests.");
  }
  #replay(scope: RequestScope, mutationId: string, operation: Operation, request: unknown): unknown {
    this.configuration.assertPrincipal(scope);
    const row = this.database.prepare(`SELECT operation, request_fingerprint AS fingerprint, result_json AS result FROM host_pairing_receipts
      WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?`)
      .get(scope.tenantId, scope.principalId, mutationId) as { operation: string; fingerprint: string; result: string } | undefined;
    if (row && (row.operation !== operation || row.fingerprint !== configurationFingerprint(request))) throw new DomainError("conflict", "The pairing mutation ID was reused with different contents.");
    return row ? JSON.parse(row.result) : undefined;
  }
  #receipt(scope: RequestScope, mutationId: string, operation: Operation, request: unknown, result: unknown): void {
    const count = this.database.prepare(`SELECT count(*) AS count FROM host_pairing_receipts WHERE tenant_id = ? AND owner_principal_id = ?`)
      .get(scope.tenantId, scope.principalId) as { count: number };
    if (count.count >= 10_000) throw new DomainError("conflict", "Host pairing receipt capacity has been reached.");
    this.database.prepare(`INSERT INTO host_pairing_receipts (tenant_id, owner_principal_id, mutation_id, operation, request_fingerprint, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(scope.tenantId, scope.principalId, mutationId, operation, configurationFingerprint(request), JSON.stringify(result), this.#now());
  }
}
