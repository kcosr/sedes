import type Database from "better-sqlite3";
import { BackendError } from "../contracts.js";
import path from "node:path";
import { normalizedAbsolutePath } from "../../../shared/absolute-path.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export interface PiSessionReservation {
  readonly applicationThreadId: string;
  readonly applicationOperationId: string;
  readonly sessionDirectory: string;
  readonly sessionId: string;
}

type Target = { backendInstanceId: string; environmentId: string; backendKind: "pi" | "pi_native"; environmentKind: string };
type Identity = { sessionDirectory: string; sessionId: string; sessionFile?: string };
type Prior = { applicationThreadId: string; backendInstanceId: string; sessionFile: string | null; sessionId: string; backendKind: string };
const conflict = () => new DomainError("conflict", "This native Pi conversation is already owned or reserved by another Sedes thread.");
const storageHost = (target: Pick<Target, "backendKind" | "environmentKind">) =>
  target.backendKind === "pi" || target.environmentKind === "local" ? "main" : "execution_environment";
const parentDirectory = (file: string) => file.startsWith("/") ? path.posix.dirname(file) : path.win32.dirname(file);

/** Durable physical-store claims shared by the SDK and native adapters.
 * No thread FK: an aborted fork's orphan must remain reserved after its child
 * application row is removed. Paths are canonicalized by the owning host.
 */
export class PiSessionClaims {
  constructor(readonly database: Database.Database) {}

  reserve(scope: RequestScope, input: PiSessionReservation): void {
    try {
      this.database.transaction(() => {
        const target = this.#threadTarget(scope, input.applicationThreadId);
        const attempt = this.database.prepare(`SELECT 1 FROM conversation_creation_attempts
          WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
            AND mutation_id = ? AND backend_creation_correlation = ?`).get(scope.tenantId,
          scope.principalId, input.applicationThreadId, input.applicationOperationId, input.sessionId);
        if (!attempt) throw new DomainError("conflict", "The Pi session reservation has no matching creation attempt.");
        this.#claim(scope, target, input.applicationThreadId, input, input.applicationOperationId);
      })();
    } catch (cause) {
      // This method runs before the driver invokes native publication.
      throw new BackendError({ category: cause instanceof DomainError ? "rejected" : "internal",
        retryable: false, crossedSubmissionBoundary: false, backendCode: "pi_session_claim_failed",
        safeMessage: cause instanceof DomainError ? cause.message : "Pi session ownership could not be reserved." }, { cause });
    }
  }

  claimBound(scope: RequestScope, applicationThreadId: string, input: { readonly sessionId: string; readonly sessionFile: string }): void {
    this.database.transaction(() => {
      const target = this.#threadTarget(scope, applicationThreadId);
      this.#claim(scope, target, applicationThreadId, { ...input, sessionDirectory: parentDirectory(input.sessionFile) });
    })();
  }

  isClaimed(scope: RequestScope, input: { readonly backendInstanceId: string; readonly executionEnvironmentId: string;
    readonly sessionId: string; readonly sessionFile: string }): boolean {
    const target = this.#target(scope, input.backendInstanceId, input.executionEnvironmentId);
    return this.#hasOtherClaim(scope, target, { ...input, sessionDirectory: parentDirectory(input.sessionFile) });
  }

  #target(scope: RequestScope, backendInstanceId: string, environmentId: string): Target {
    const target = this.database.prepare(`SELECT backend.id AS backendInstanceId, environment.id AS environmentId,
        backend.kind AS backendKind, environment.kind AS environmentKind
      FROM agent_backend_instances backend JOIN execution_environments environment ON environment.tenant_id = backend.tenant_id
      WHERE backend.tenant_id = ? AND backend.owner_principal_id = ? AND backend.id = ?
        AND backend.kind IN ('pi', 'pi_native') AND environment.owner_principal_id = backend.owner_principal_id AND environment.id = ?`).get(scope.tenantId,
      scope.principalId, backendInstanceId, environmentId) as Target | undefined;
    if (!target) throw new DomainError("not_found", "The Pi session target was not found.");
    return target;
  }

  #threadTarget(scope: RequestScope, applicationThreadId: string): Target {
    const thread = this.database.prepare(`SELECT backend_instance_id AS backendInstanceId, environment_id AS environmentId
      FROM application_threads WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
      .get(scope.tenantId, scope.principalId, applicationThreadId) as { backendInstanceId: string; environmentId: string } | undefined;
    if (!thread) throw new DomainError("not_found", "The Pi session thread was not found.");
    return this.#target(scope, thread.backendInstanceId, thread.environmentId);
  }

  #validate(identity: Identity): void {
    if (!normalizedAbsolutePath(identity.sessionDirectory) || identity.sessionDirectory.length > 8192 ||
        !identity.sessionId || identity.sessionId.length > 512 ||
        (identity.sessionFile !== undefined && (!normalizedAbsolutePath(identity.sessionFile) ||
          parentDirectory(identity.sessionFile) !== identity.sessionDirectory))) throw new DomainError("conflict", "The Pi native store identity is invalid.");
  }

  #hasOtherClaim(scope: RequestScope, target: Target, identity: Identity, owner?: string): boolean {
    this.#validate(identity);
    const claimed = this.database.prepare(`SELECT application_thread_id AS applicationThreadId FROM pi_session_claims
      WHERE tenant_id = ? AND owner_principal_id = ? AND execution_environment_id = ? AND storage_host = ?
        AND ((session_directory = ? AND native_session_id = ?) OR session_file = ?)
        AND application_thread_id <> ? LIMIT 1`).get(scope.tenantId, scope.principalId, target.environmentId,
      storageHost(target), identity.sessionDirectory, identity.sessionId, identity.sessionFile ?? null, owner ?? "");
    if (claimed) return true;
    // Existing SDK/native bindings and already identified creation attempts
    // predate claims. Compare their host-owned canonical paths, never config
    // spelling or main's interpretation of a remote home directory.
    const previous = this.database.prepare(`
      SELECT detail.application_thread_id AS applicationThreadId, detail.backend_instance_id AS backendInstanceId,
        detail.native_session_path AS sessionFile, binding.backend_conversation_id AS sessionId, 'pi' AS backendKind
      FROM pi_binding_details detail JOIN conversation_bindings binding USING
        (tenant_id, owner_principal_id, application_thread_id, backend_instance_id, execution_environment_id)
      WHERE detail.tenant_id = ? AND detail.owner_principal_id = ? AND detail.execution_environment_id = ?
        AND (binding.backend_conversation_id = ? OR detail.native_session_path = ?)
      UNION ALL
      SELECT detail.application_thread_id, detail.backend_instance_id, detail.native_session_path, binding.backend_conversation_id, 'pi_native'
      FROM pi_native_binding_details detail JOIN conversation_bindings binding USING
        (tenant_id, owner_principal_id, application_thread_id, backend_instance_id, execution_environment_id)
      WHERE detail.tenant_id = ? AND detail.owner_principal_id = ? AND detail.execution_environment_id = ?
        AND (binding.backend_conversation_id = ? OR detail.native_session_path = ?)
      UNION ALL
      SELECT attempt.application_thread_id, attempt.backend_instance_id,
        json_extract(attempt.provisional_opaque_binding_detail, '$.sessionFile'),
        coalesce(attempt.provisional_backend_conversation_id, attempt.backend_creation_correlation), backend.kind
      FROM conversation_creation_attempts attempt JOIN agent_backend_instances backend
        ON backend.tenant_id = attempt.tenant_id AND backend.id = attempt.backend_instance_id
      WHERE attempt.tenant_id = ? AND attempt.owner_principal_id = ? AND attempt.execution_environment_id = ?
        AND backend.kind IN ('pi', 'pi_native') AND json_valid(attempt.provisional_opaque_binding_detail)
        AND (attempt.backend_creation_correlation = ? OR attempt.provisional_backend_conversation_id = ?
          OR json_extract(attempt.provisional_opaque_binding_detail, '$.sessionFile') = ?)
      UNION ALL
      SELECT aborted.reserved_child_thread_id, aborted.reserved_backend_instance_id,
        coalesce(sdk.native_session_path, native.native_session_path), aborted.reserved_backend_conversation_id, backend.kind
      FROM aborted_thread_forks aborted
      JOIN application_threads source ON source.tenant_id = aborted.tenant_id
        AND source.owner_principal_id = aborted.owner_principal_id AND source.id = aborted.source_thread_id
      JOIN agent_backend_instances backend ON backend.tenant_id = aborted.tenant_id
        AND backend.owner_principal_id = aborted.owner_principal_id AND backend.id = aborted.reserved_backend_instance_id
      LEFT JOIN pi_binding_details sdk ON sdk.tenant_id = source.tenant_id
        AND sdk.owner_principal_id = source.owner_principal_id AND sdk.application_thread_id = source.id
      LEFT JOIN pi_native_binding_details native ON native.tenant_id = source.tenant_id
        AND native.owner_principal_id = source.owner_principal_id AND native.application_thread_id = source.id
      WHERE aborted.tenant_id = ? AND aborted.owner_principal_id = ? AND source.environment_id = ?
        AND backend.kind IN ('pi', 'pi_native') AND aborted.reserved_backend_conversation_id = ?
    `).all(scope.tenantId, scope.principalId, target.environmentId, identity.sessionId, identity.sessionFile ?? null,
      scope.tenantId, scope.principalId, target.environmentId, identity.sessionId, identity.sessionFile ?? null,
      scope.tenantId, scope.principalId, target.environmentId, identity.sessionId, identity.sessionId, identity.sessionFile ?? null,
      scope.tenantId, scope.principalId, target.environmentId, identity.sessionId) as Prior[];
    return previous.some(prior => prior.applicationThreadId !== owner && prior.sessionFile !== null &&
      storageHost({ backendKind: prior.backendKind as Target["backendKind"], environmentKind: target.environmentKind }) === storageHost(target) &&
      (prior.sessionFile === identity.sessionFile ||
        (prior.sessionId === identity.sessionId && parentDirectory(prior.sessionFile) === identity.sessionDirectory)));
  }

  #claim(scope: RequestScope, target: Target, owner: string, identity: Identity, operationId?: string): void {
    if (this.#hasOtherClaim(scope, target, identity, owner)) throw conflict();
    const args = [scope.tenantId, scope.principalId, target.environmentId, storageHost(target), identity.sessionDirectory, identity.sessionId];
    if (operationId !== undefined) {
      const reservation = this.database.prepare(`SELECT execution_environment_id AS environment, storage_host AS host,
          session_directory AS directory, native_session_id AS sessionId, backend_instance_id AS backend
        FROM pi_session_claims WHERE tenant_id = ? AND owner_principal_id = ?
          AND application_thread_id = ? AND creation_operation_id = ?`).get(scope.tenantId, scope.principalId,
        owner, operationId) as { environment: string; host: string; directory: string; sessionId: string; backend: string } | undefined;
      if (reservation && (reservation.environment !== target.environmentId || reservation.host !== storageHost(target) ||
          reservation.directory !== identity.sessionDirectory || reservation.sessionId !== identity.sessionId ||
          reservation.backend !== target.backendInstanceId)) throw conflict();
    }
    if (identity.sessionFile !== undefined) {
      const file = this.database.prepare(`SELECT session_directory AS directory, native_session_id AS sessionId
        FROM pi_session_claims WHERE tenant_id = ? AND owner_principal_id = ? AND execution_environment_id = ?
          AND storage_host = ? AND session_file = ?`).get(scope.tenantId, scope.principalId,
        target.environmentId, storageHost(target), identity.sessionFile) as { directory: string; sessionId: string } | undefined;
      if (file && (file.directory !== identity.sessionDirectory || file.sessionId !== identity.sessionId)) throw conflict();
    }
    const current = this.database.prepare(`SELECT application_thread_id AS owner, backend_instance_id AS backend,
        creation_operation_id AS operationId, session_file AS sessionFile FROM pi_session_claims
      WHERE tenant_id = ? AND owner_principal_id = ? AND execution_environment_id = ? AND storage_host = ?
        AND session_directory = ? AND native_session_id = ?`).get(...args) as
      { owner: string; backend: string; operationId: string | null; sessionFile: string | null } | undefined;
    if (current) {
      if (current.owner !== owner || current.backend !== target.backendInstanceId ||
          (operationId !== undefined && current.operationId !== null && current.operationId !== operationId) ||
          (identity.sessionFile !== undefined && current.sessionFile !== null && current.sessionFile !== identity.sessionFile)) throw conflict();
      this.database.prepare(`UPDATE pi_session_claims SET session_file = coalesce(session_file, ?),
          creation_operation_id = coalesce(creation_operation_id, ?)
        WHERE tenant_id = ? AND owner_principal_id = ? AND execution_environment_id = ? AND storage_host = ?
          AND session_directory = ? AND native_session_id = ?`).run(identity.sessionFile ?? null, operationId ?? null, ...args);
      return;
    }
    this.database.prepare(`INSERT INTO pi_session_claims (tenant_id, owner_principal_id, execution_environment_id,
      storage_host, session_directory, native_session_id, backend_instance_id, application_thread_id, creation_operation_id, session_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...args, target.backendInstanceId, owner, operationId ?? null, identity.sessionFile ?? null);
  }
}
