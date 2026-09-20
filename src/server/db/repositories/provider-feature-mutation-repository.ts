import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export type ProviderFeatureMutationState =
  | "prepared"
  | "accepted"
  | "uncertain"
  | "abandoned";

export interface ProviderFeatureMutationReceiptRecord {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly mutationId: string;
  readonly featureId: string;
  readonly schemaVersion: number;
  readonly actionId: string;
  readonly requestFingerprint: string;
  readonly expectedThreadRevision: number;
  readonly expectedFeatureRevision: number;
  readonly state: ProviderFeatureMutationState;
  readonly desiredPostcondition: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly forceResetAt: number | null;
}

type ReceiptRow = Omit<
  ProviderFeatureMutationReceiptRecord,
  "desiredPostcondition" | "result"
> & {
  readonly desiredPostconditionJson: string;
  readonly resultJson: string | null;
};

const columns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  application_thread_id AS applicationThreadId,
  mutation_id AS mutationId,
  feature_id AS featureId,
  schema_version AS schemaVersion,
  action_id AS actionId,
  request_fingerprint AS requestFingerprint,
  expected_thread_revision AS expectedThreadRevision,
  expected_feature_revision AS expectedFeatureRevision,
  state,
  desired_postcondition_json AS desiredPostconditionJson,
  result_json AS resultJson,
  created_at AS createdAt,
  updated_at AS updatedAt,
  force_reset_at AS forceResetAt
`;

export class ProviderFeatureMutationRepository {
  constructor(readonly database: Database.Database) {}

  find(
    scope: RequestScope,
    mutationId: string,
  ): ProviderFeatureMutationReceiptRecord | undefined {
    const row = this.database.prepare(`
      SELECT ${columns}
      FROM provider_feature_mutation_receipts
      WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?
    `).get(scope.tenantId, scope.principalId, mutationId) as
      | ReceiptRow
      | undefined;
    return row ? parseReceipt(row) : undefined;
  }

  prepare(
    scope: RequestScope,
    input: {
      readonly applicationThreadId: string;
      readonly mutationId: string;
      readonly featureId: string;
      readonly schemaVersion: number;
      readonly actionId: string;
      readonly requestFingerprint: string;
      readonly expectedThreadRevision: number;
      readonly expectedFeatureRevision: number;
      readonly desiredPostcondition: Readonly<Record<string, unknown>>;
      readonly now: number;
    },
  ): ProviderFeatureMutationReceiptRecord {
    assertIdentity(input.applicationThreadId, "thread");
    assertIdentity(input.mutationId, "mutation");
    assertIdentity(input.featureId, "feature");
    assertIdentity(input.actionId, "action");
    assertPositive(input.schemaVersion, "schema_version");
    assertRevision(input.expectedThreadRevision, "thread_revision");
    assertRevision(input.expectedFeatureRevision, "feature_revision");
    assertFingerprint(input.requestFingerprint);
    const desiredJson = encodeObject(input.desiredPostcondition);
    assertNow(input.now);
    const existing = this.find(scope, input.mutationId);
    if (existing) {
      if (
        existing.applicationThreadId !== input.applicationThreadId ||
        existing.featureId !== input.featureId ||
        existing.schemaVersion !== input.schemaVersion ||
        existing.actionId !== input.actionId ||
        existing.requestFingerprint !== input.requestFingerprint ||
        existing.expectedThreadRevision !== input.expectedThreadRevision ||
        existing.expectedFeatureRevision !== input.expectedFeatureRevision ||
        JSON.stringify(existing.desiredPostcondition) !== desiredJson
      ) {
        throw receiptConflict();
      }
      return existing;
    }
    try {
      this.database.prepare(`
        INSERT INTO provider_feature_mutation_receipts(
          tenant_id, owner_principal_id, application_thread_id, mutation_id,
          feature_id, schema_version, action_id, request_fingerprint,
          expected_thread_revision, expected_feature_revision, state,
          desired_postcondition_json, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, NULL, ?, ?)
      `).run(
        scope.tenantId,
        scope.principalId,
        input.applicationThreadId,
        input.mutationId,
        input.featureId,
        input.schemaVersion,
        input.actionId,
        input.requestFingerprint,
        input.expectedThreadRevision,
        input.expectedFeatureRevision,
        desiredJson,
        input.now,
        input.now,
      );
    } catch (error) {
      if (this.find(scope, input.mutationId)) throw receiptConflict();
      throw error;
    }
    return this.find(scope, input.mutationId)!;
  }

  accept(
    scope: RequestScope,
    mutationId: string,
    input: {
      readonly requestFingerprint: string;
      readonly result: Readonly<Record<string, unknown>>;
      readonly now: number;
    },
  ): ProviderFeatureMutationReceiptRecord {
    return this.#finish(scope, mutationId, {
      ...input,
      state: "accepted",
    });
  }

  markUncertain(
    scope: RequestScope,
    mutationId: string,
    input: {
      readonly requestFingerprint: string;
      readonly result: Readonly<Record<string, unknown>>;
      readonly now: number;
    },
  ): ProviderFeatureMutationReceiptRecord {
    return this.#finish(scope, mutationId, {
      ...input,
      state: "uncertain",
    });
  }

  #finish(
    scope: RequestScope,
    mutationId: string,
    input: {
      readonly requestFingerprint: string;
      readonly result: Readonly<Record<string, unknown>>;
      readonly state: "accepted" | "uncertain";
      readonly now: number;
    },
  ): ProviderFeatureMutationReceiptRecord {
    assertFingerprint(input.requestFingerprint);
    const resultJson = encodeObject(input.result);
    assertNow(input.now);
    const existing = this.find(scope, mutationId);
    if (!existing) {
      throw new DomainError("not_found", "The provider feature receipt was not found.");
    }
    if (existing.requestFingerprint !== input.requestFingerprint) {
      throw receiptConflict();
    }
    if (existing.state === input.state) {
      if (JSON.stringify(existing.result) !== resultJson) throw receiptConflict();
      return existing;
    }
    // Terminal accepted cannot change. Only prepared receipts may finish to
    // accepted or uncertain after a durable external effect boundary.
    if (existing.state !== "prepared") {
      throw receiptConflict();
    }
    const result = this.database.prepare(`
      UPDATE provider_feature_mutation_receipts
      SET state = ?, result_json = ?, updated_at = max(updated_at, ?)
      WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?
        AND request_fingerprint = ? AND state = ?
    `).run(
      input.state,
      resultJson,
      input.now,
      scope.tenantId,
      scope.principalId,
      mutationId,
      input.requestFingerprint,
      existing.state,
    );
    if (result.changes !== 1) throw receiptConflict();
    return this.find(scope, mutationId)!;
  }
}

function parseReceipt(row: ReceiptRow): ProviderFeatureMutationReceiptRecord {
  return {
    tenantId: row.tenantId,
    ownerPrincipalId: row.ownerPrincipalId,
    applicationThreadId: row.applicationThreadId,
    mutationId: row.mutationId,
    featureId: row.featureId,
    schemaVersion: row.schemaVersion,
    actionId: row.actionId,
    requestFingerprint: row.requestFingerprint,
    expectedThreadRevision: row.expectedThreadRevision,
    expectedFeatureRevision: row.expectedFeatureRevision,
    state: row.forceResetAt === null ? row.state : "abandoned",
    desiredPostcondition: decodeObject(row.desiredPostconditionJson),
    result: row.resultJson === null ? null : decodeObject(row.resultJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    forceResetAt: row.forceResetAt,
  };
}

function encodeObject(value: Readonly<Record<string, unknown>>): string {
  if (!isPlainObject(value)) throw new Error("provider_feature_json_invalid");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 8_192) {
    throw new Error("provider_feature_json_too_large");
  }
  return encoded;
}

function decodeObject(value: string): Readonly<Record<string, unknown>> {
  const decoded: unknown = JSON.parse(value);
  if (!isPlainObject(decoded)) throw new Error("provider_feature_receipt_invalid");
  return decoded;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertIdentity(value: string, label: string): void {
  if (value.length < 1 || value.length > 128) {
    throw new Error(`provider_feature_${label}_id_invalid`);
  }
}

function assertFingerprint(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("provider_feature_request_fingerprint_invalid");
  }
}

function assertRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`provider_feature_${label}_invalid`);
  }
}

function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`provider_feature_${label}_invalid`);
  }
}

function assertNow(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("provider_feature_timestamp_invalid");
  }
}

function receiptConflict(): DomainError {
  return new DomainError(
    "conflict",
    "The provider feature mutation ID is already used by another request.",
  );
}
