import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ConversationBinding } from "./contracts.js";
import { PrincipalApplicationPreferenceRepository } from "../db/repositories/principal-application-preference-repository.js";
import { prepareCached } from "../db/prepared-statements.js";

export const MODEL_FAILURE_RETRY_DELAY_MS = 10_000;

/** Account policy and per-thread allowance for a new automatic follow-up. */
export interface ModelFailureRetryPolicy {
  enabled(): boolean;
  /** Consumes the one allowance durably before scheduling any provider work. */
  claim(failedTurnId: string): boolean;
  /** Newly observed successful model response, never replayed history. */
  reset(successIdentity: string): void;
  /** Returns true only for a newly accepted non-retry input. */
  resetForInput(sequence: number): boolean;
}

export function createModelFailureRetryPolicy(
  database: Database.Database,
  binding: ConversationBinding,
): ModelFailureRetryPolicy {
  const scope = { tenantId: binding.tenantId, principalId: binding.ownerPrincipalId };
  const keys = [binding.tenantId, binding.ownerPrincipalId, binding.applicationThreadId] as const;
  const fingerprint = createHash("sha256").update(JSON.stringify([
    binding.backendInstanceId, binding.connectionProfileId,
    binding.executionEnvironmentId, binding.backendConversationId, binding.createdAt,
  ])).digest("hex");
  const preferences = new PrincipalApplicationPreferenceRepository(database);
  const current = () => prepareCached(database, `
    SELECT 1 FROM conversation_bindings AS binding
    JOIN application_threads AS thread
      ON thread.tenant_id = binding.tenant_id
      AND thread.owner_principal_id = binding.owner_principal_id
      AND thread.id = binding.application_thread_id
    JOIN thread_principal_state AS state
      ON state.tenant_id = binding.tenant_id
      AND state.principal_id = binding.owner_principal_id
      AND state.thread_id = binding.application_thread_id
    WHERE binding.tenant_id = ? AND binding.owner_principal_id = ?
      AND binding.application_thread_id = ? AND binding.backend_instance_id = ?
      AND binding.connection_profile_id = ? AND binding.execution_environment_id = ?
      AND binding.backend_conversation_id = ? AND binding.created_at = ?
      AND thread.backing_state IN ('creating', 'bound') AND thread.availability = 'available'
      AND state.inventory_state NOT IN ('archived', 'snoozed')
  `).get(...keys, binding.backendInstanceId, binding.connectionProfileId,
    binding.executionEnvironmentId, binding.backendConversationId, Date.parse(binding.createdAt)) !== undefined;

  const enabled = () => current() && preferences.read(scope).autoRetryModelFailures;
  const acceptedInputSequence = () => (prepareCached(database, `
    SELECT coalesce(max(sequence), 0) AS sequence FROM queued_inputs
    WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
      AND accepted_at IS NOT NULL
  `).get(...keys) as { sequence: number }).sequence;
  return {
    enabled,
    claim: database.transaction((failedTurnId: string) => {
      if (!failedTurnId || !enabled()) return false;
      const result = prepareCached(database, `
        INSERT INTO model_failure_retry_state (
          tenant_id, owner_principal_id, application_thread_id,
          binding_fingerprint, retry_used, last_failure_identity, last_success_identity, last_input_sequence
        ) VALUES (?, ?, ?, ?, 1, ?, NULL, ?)
        ON CONFLICT (tenant_id, owner_principal_id, application_thread_id)
        DO UPDATE SET binding_fingerprint = excluded.binding_fingerprint,
          retry_used = 1, last_failure_identity = excluded.last_failure_identity,
          last_input_sequence = max(model_failure_retry_state.last_input_sequence, excluded.last_input_sequence),
          last_success_identity = CASE
            WHEN model_failure_retry_state.binding_fingerprint = excluded.binding_fingerprint
              THEN model_failure_retry_state.last_success_identity ELSE NULL END
        WHERE model_failure_retry_state.binding_fingerprint <> excluded.binding_fingerprint
          OR (model_failure_retry_state.retry_used = 0
            AND model_failure_retry_state.last_failure_identity IS NOT excluded.last_failure_identity)
      `).run(...keys, fingerprint, failedTurnId, acceptedInputSequence());
      return result.changes === 1;
    }),
    reset: database.transaction((successIdentity: string) => {
      if (!successIdentity || !current()) return;
      prepareCached(database, `
        INSERT INTO model_failure_retry_state (
          tenant_id, owner_principal_id, application_thread_id,
          binding_fingerprint, retry_used, last_failure_identity, last_success_identity, last_input_sequence
        ) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)
        ON CONFLICT (tenant_id, owner_principal_id, application_thread_id)
        DO UPDATE SET binding_fingerprint = excluded.binding_fingerprint,
          retry_used = 0, last_success_identity = excluded.last_success_identity,
          last_failure_identity = CASE
            WHEN model_failure_retry_state.binding_fingerprint = excluded.binding_fingerprint
              THEN model_failure_retry_state.last_failure_identity ELSE NULL END
        WHERE model_failure_retry_state.binding_fingerprint <> excluded.binding_fingerprint
          OR model_failure_retry_state.last_success_identity IS NOT excluded.last_success_identity
      `).run(...keys, fingerprint, successIdentity, acceptedInputSequence());
    }),
    resetForInput: database.transaction((sequence: number) => {
      if (!Number.isSafeInteger(sequence) || sequence <= 0 || !current()) return false;
      const result = prepareCached(database, `
        INSERT INTO model_failure_retry_state (
          tenant_id, owner_principal_id, application_thread_id,
          binding_fingerprint, retry_used, last_failure_identity, last_success_identity, last_input_sequence
        ) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)
        ON CONFLICT (tenant_id, owner_principal_id, application_thread_id)
        DO UPDATE SET binding_fingerprint = excluded.binding_fingerprint,
          retry_used = 0, last_input_sequence = excluded.last_input_sequence,
          last_failure_identity = CASE
            WHEN model_failure_retry_state.binding_fingerprint = excluded.binding_fingerprint
              THEN model_failure_retry_state.last_failure_identity ELSE NULL END,
          last_success_identity = CASE
            WHEN model_failure_retry_state.binding_fingerprint = excluded.binding_fingerprint
              THEN model_failure_retry_state.last_success_identity ELSE NULL END
        WHERE model_failure_retry_state.binding_fingerprint <> excluded.binding_fingerprint
          OR model_failure_retry_state.last_input_sequence < excluded.last_input_sequence
      `).run(...keys, fingerprint, sequence);
      return result.changes === 1;
    }),
  };
}
