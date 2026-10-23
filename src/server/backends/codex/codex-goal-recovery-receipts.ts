import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ConversationBinding } from "../contracts.js";
import { ProviderFeatureMutationRepository } from "../../db/repositories/provider-feature-mutation-repository.js";
import { CODEX_GOAL_FEATURE_REF, codexGoalObjectiveFingerprint } from "./codex-goal-feature.js";
import type { CodexGoalRecoveryEvidence } from "./codex-goal-recovery.js";

/** Durable admission for automatic Goal resumes; uncertain admission is never replayed. */
export class CodexGoalRecoveryReceipts {
  readonly #receipts: ProviderFeatureMutationRepository;
  readonly #now: () => number;
  constructor(readonly database: Database.Database, now: () => number = Date.now) {
    this.#receipts = new ProviderFeatureMutationRepository(database);
    this.#now = now;
  }

  begin(input: {
    readonly binding: ConversationBinding;
    readonly mutationId: string;
    readonly evidence: CodexGoalRecoveryEvidence;
    readonly mutationRevision: number;
    readonly now: number;
  }): { readonly outcome: "admitted" | "accepted" | "uncertain" | "rejected"; readonly finish?: (outcome: "accepted" | "uncertain" | "rejected") => boolean } {
    const { binding, evidence } = input;
    if (evidence.goal.threadId !== binding.backendConversationId) return { outcome: "rejected" };
    const scope = { tenantId: binding.tenantId, principalId: binding.ownerPrincipalId };
    const requestFingerprint = createHash("sha256").update(JSON.stringify([
      "automatic-goal-resume", binding.tenantId, binding.ownerPrincipalId, binding.applicationThreadId,
      binding.backendInstanceId, binding.connectionProfileId, binding.executionEnvironmentId, binding.backendConversationId,
      binding.createdAt, evidence.turnId, evidence.goal.threadId, evidence.goal.createdAt, evidence.goal.objective, evidence.goal.tokenBudget,
    ])).digest("hex");
    const previous = this.#receipts.find(scope, input.mutationId);
    if (previous) {
      if (previous.applicationThreadId !== binding.applicationThreadId || previous.requestFingerprint !== requestFingerprint ||
          previous.featureId !== CODEX_GOAL_FEATURE_REF.featureId || previous.schemaVersion !== CODEX_GOAL_FEATURE_REF.schemaVersion ||
          previous.actionId !== "resume" || previous.forceResetAt !== null) return { outcome: "rejected" };
      return { outcome: previous.state === "abandoned" || previous.result?.outcome === "rejected" ? "rejected" :
        previous.state === "accepted" ? "accepted" : "uncertain" };
    }
    const target = this.database.prepare(`SELECT revision FROM application_threads
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ? AND backend_instance_id = ?
        AND connection_profile_id = ? AND backing_state = 'bound'`).get(
      scope.tenantId, scope.principalId, binding.applicationThreadId, binding.backendInstanceId, binding.connectionProfileId,
    ) as { revision: number } | undefined;
    if (!target) return { outcome: "rejected" };
    this.database.transaction(() => {
      this.#receipts.prepare(scope, {
        applicationThreadId: binding.applicationThreadId, mutationId: input.mutationId,
        ...CODEX_GOAL_FEATURE_REF, actionId: "resume", requestFingerprint,
        expectedThreadRevision: target.revision, expectedMutationRevision: input.mutationRevision,
        desiredPostcondition: { kind: "resume", status: "active", objectiveFingerprint: codexGoalObjectiveFingerprint(evidence.goal.objective) }, now: input.now,
      });
      // A crash after this commit cannot cause a second native write.
      this.#receipts.markUncertain(scope, input.mutationId, { requestFingerprint, result: { automaticRetry: true }, now: input.now });
    })();
    return { outcome: "admitted", finish: outcome => {
      const now = this.#now();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("codex_goal_recovery_timestamp_invalid");
      const result = this.database.prepare(`UPDATE provider_feature_mutation_receipts
        SET state = ?, result_json = ?, updated_at = max(updated_at, ?)
        WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ? AND mutation_id = ?
          AND feature_id = ? AND schema_version = ? AND action_id = 'resume' AND request_fingerprint = ?
          AND state = 'uncertain' AND force_reset_at IS NULL
          AND json_extract(result_json, '$.outcome') IS NULL`).run(
        outcome === "accepted" ? "accepted" : "uncertain", JSON.stringify({ automaticRetry: true, outcome }), now,
        scope.tenantId, scope.principalId, binding.applicationThreadId, input.mutationId,
        CODEX_GOAL_FEATURE_REF.featureId, CODEX_GOAL_FEATURE_REF.schemaVersion, requestFingerprint,
      );
      return result.changes === 1;
    } };
  }
}
