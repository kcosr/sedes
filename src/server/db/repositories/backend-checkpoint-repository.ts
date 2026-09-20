import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

type BackendCheckpointRecordCommon = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly id: string;
  readonly applicationThreadId: string;
  readonly backendInstanceId: string;
  readonly kind: "conversation_leaf";
  readonly opaqueReference: string;
  readonly createdAt: number;
};

export type BackendCheckpointRecord = BackendCheckpointRecordCommon &
  (
    | {
        readonly applicationTurnId: string | null;
        readonly boundaryKind: "completed_turn_inclusive";
      }
    | {
        readonly applicationTurnId: null;
        readonly boundaryKind: "provider_snapshot_at_acceptance";
      }
  );

/**
 * Backend-neutral durable checkpoint references. Backends produce and consume
 * the opaque reference; this repository owns application identity and lineage.
 */
export class BackendCheckpointRepository {
  constructor(readonly database: Database.Database) {}

  create(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly id?: string;
      readonly applicationTurnId: string;
      readonly opaqueReference: string;
      readonly now: number;
    },
  ): BackendCheckpointRecord & {
    readonly applicationTurnId: string;
    readonly boundaryKind: "completed_turn_inclusive";
  } {
    const target = this.database
      .prepare(
        `
          SELECT backend_instance_id AS backendInstanceId
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      { readonly backendInstanceId: string } | undefined;
    if (!target)
      throw new DomainError("not_found", "The thread was not found.");
    const id = input.id ?? randomUUID();
    if (input.id) {
      const replay = this.#find(scope, input.id);
      if (replay) {
        if (
          replay.applicationThreadId !== applicationThreadId ||
          replay.backendInstanceId !== target.backendInstanceId ||
          replay.applicationTurnId !== input.applicationTurnId ||
          replay.boundaryKind !== "completed_turn_inclusive" ||
          replay.kind !== "conversation_leaf" ||
          replay.opaqueReference !== input.opaqueReference
        ) {
          throw new DomainError(
            "conflict",
            "The checkpoint ID is already used by a different reference.",
          );
        }
        return {
          ...replay,
          boundaryKind: "completed_turn_inclusive",
          applicationTurnId: input.applicationTurnId,
        };
      }
    }
    this.database
      .prepare(
        `
          INSERT INTO backend_checkpoints(
            tenant_id, owner_principal_id, id, application_thread_id,
            backend_instance_id, application_turn_id, boundary_kind,
            kind, opaque_reference, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, 'completed_turn_inclusive',
            'conversation_leaf', ?, ?)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        id,
        applicationThreadId,
        target.backendInstanceId,
        input.applicationTurnId,
        input.opaqueReference,
        input.now,
      );
    const created = this.get(scope, id);
    if (
      created.boundaryKind !== "completed_turn_inclusive" ||
      created.applicationTurnId === null
    ) {
      throw new DomainError("conflict", "The checkpoint boundary is corrupt.");
    }
    return {
      ...created,
      boundaryKind: "completed_turn_inclusive",
      applicationTurnId: created.applicationTurnId,
    };
  }

  createProviderSnapshot(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly id?: string;
      readonly opaqueReference: string;
      readonly now: number;
    },
  ): BackendCheckpointRecord & {
    readonly applicationTurnId: null;
    readonly boundaryKind: "provider_snapshot_at_acceptance";
  } {
    const target = this.#getTarget(scope, applicationThreadId);
    const id = input.id ?? randomUUID();
    if (input.id) {
      const replay = this.#find(scope, input.id);
      if (replay) {
        if (
          replay.applicationThreadId !== applicationThreadId ||
          replay.backendInstanceId !== target.backendInstanceId ||
          replay.applicationTurnId !== null ||
          replay.boundaryKind !== "provider_snapshot_at_acceptance" ||
          replay.kind !== "conversation_leaf" ||
          replay.opaqueReference !== input.opaqueReference
        ) {
          throw new DomainError(
            "conflict",
            "The checkpoint ID is already used by a different reference.",
          );
        }
        return replay;
      }
    }
    this.database
      .prepare(
        `
          INSERT INTO backend_checkpoints(
            tenant_id, owner_principal_id, id, application_thread_id,
            backend_instance_id, application_turn_id, boundary_kind,
            kind, opaque_reference, created_at
          )
          VALUES (?, ?, ?, ?, ?, NULL, 'provider_snapshot_at_acceptance',
            'conversation_leaf', ?, ?)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        id,
        applicationThreadId,
        target.backendInstanceId,
        input.opaqueReference,
        input.now,
      );
    const created = this.get(scope, id);
    if (created.boundaryKind !== "provider_snapshot_at_acceptance") {
      throw new DomainError("conflict", "The checkpoint boundary is corrupt.");
    }
    return created;
  }

  get(scope: RequestScope, id: string): BackendCheckpointRecord {
    const row = this.#find(scope, id);
    if (!row)
      throw new DomainError("not_found", "The checkpoint was not found.");
    return row;
  }

  find(scope: RequestScope, id: string): BackendCheckpointRecord | undefined {
    return this.#find(scope, id);
  }

  #find(scope: RequestScope, id: string): BackendCheckpointRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT tenant_id AS tenantId,
            owner_principal_id AS ownerPrincipalId,
            id,
            application_thread_id AS applicationThreadId,
            backend_instance_id AS backendInstanceId,
            application_turn_id AS applicationTurnId,
            boundary_kind AS boundaryKind,
            kind,
            opaque_reference AS opaqueReference,
            created_at AS createdAt
          FROM backend_checkpoints
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, id) as
      | (BackendCheckpointRecordCommon & {
          readonly applicationTurnId: string | null;
          readonly boundaryKind: string;
        })
      | undefined;
    if (!row) return undefined;
    if (
      row.kind !== "conversation_leaf" ||
      (row.boundaryKind !== "completed_turn_inclusive" &&
        (row.boundaryKind !== "provider_snapshot_at_acceptance" ||
          row.applicationTurnId !== null))
    ) {
      throw new DomainError("conflict", "The checkpoint boundary is corrupt.");
    }
    return row as BackendCheckpointRecord;
  }

  #getTarget(
    scope: RequestScope,
    applicationThreadId: string,
  ): { readonly backendInstanceId: string } {
    const target = this.database
      .prepare(
        `
          SELECT backend_instance_id AS backendInstanceId
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      | { readonly backendInstanceId: string }
      | undefined;
    if (!target)
      throw new DomainError("not_found", "The thread was not found.");
    return target;
  }
}
