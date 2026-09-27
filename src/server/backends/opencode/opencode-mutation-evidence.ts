import type { RequestScope } from "../../identity/identity-provider.js";
import { snapshotBoundedJson } from "../../provider-protocol/json/bounded-json-snapshot.js";
import { OpenCodeNativeProtocolError } from "./opencode-native-api.js";
import { openCodeOperationFingerprint } from "./opencode-input-evidence.js";
import type { OpenCodeThreadRepository } from "./opencode-thread-repository.js";

/** Immutable native action/response intent, scoped by an existing private receipt. */
export class OpenCodeMutationEvidenceRepository {
  constructor(readonly operations: OpenCodeThreadRepository) {}
  prepare(scope: RequestScope, threadId: string, operationId: string, kind: "action" | "interaction", payload: unknown): void {
    this.operations.requireOperation(scope, threadId, operationId, kind);
    const value = snapshotBoundedJson(payload, { maximumDepth: 32, maximumObjectProperties: 10_000, maximumArrayItems: 10_000,
      maximumTotalNodes: 100_000, maximumStringBytes: 1_048_576, maximumEncodedBytes: 1_048_576 });
    const previous = this.find(scope, threadId, operationId, kind);
    if (previous !== undefined) {
      if (openCodeOperationFingerprint(previous) !== openCodeOperationFingerprint(value)) throw new OpenCodeNativeProtocolError();
      return;
    }
    this.operations.database.prepare(`INSERT INTO opencode_mutation_evidence
      (tenant_id,owner_principal_id,application_operation_id,operation_kind,payload_json) VALUES (?,?,?,?,?)`)
      .run(scope.tenantId, scope.principalId, operationId, kind, JSON.stringify(value));
  }
  find(scope: RequestScope, threadId: string, operationId: string, kind: "action" | "interaction"): unknown {
    this.operations.requireOperation(scope, threadId, operationId, kind);
    const row = this.operations.database.prepare(`SELECT payload_json AS payload FROM opencode_mutation_evidence
      WHERE tenant_id=? AND owner_principal_id=? AND application_operation_id=? AND operation_kind=?`)
      .get(scope.tenantId, scope.principalId, operationId, kind) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
}
