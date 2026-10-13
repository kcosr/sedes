import type { BackendCreationProvenanceRepairAdapter } from "../creation-provenance-repair.js";
import { parseCodexBindingDetail } from "./codex-binding-codec.js";

/** Codex binds its verified native identity before first input can be abandoned. */
export const codexCreationProvenanceRepair: BackendCreationProvenanceRepairAdapter = {
  collectVerifiedEvidence(input) {
    const { database, scope, applicationThreadId } = input;
    const attempt = database.prepare(`SELECT * FROM conversation_creation_attempts
      WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=? AND attempt_id=?`)
      .get(scope.tenantId, scope.principalId, applicationThreadId, input.attemptId) as Record<string, unknown> | undefined;
    const detail = database.prepare(`SELECT * FROM codex_binding_details
      WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=?`)
      .get(scope.tenantId, scope.principalId, applicationThreadId) as Record<string, unknown> | undefined;
    try {
      if (!attempt || typeof attempt.provisional_opaque_binding_detail !== "string") return undefined;
      const created = parseCodexBindingDetail(attempt.provisional_opaque_binding_detail);
      const bound = detail === undefined ? created : parseCodexBindingDetail(String(detail.opaque_binding_detail));
      if (created.threadId !== input.backendConversationId || bound.threadId !== created.threadId || bound.sessionId !== created.sessionId) return undefined;
      if (detail && (detail.backend_instance_id !== input.backendInstanceId || detail.connection_profile_id !== input.connectionProfileId
        || detail.execution_environment_id !== input.executionEnvironmentId)) return undefined;
      return JSON.stringify({ attempt, detail: detail ?? null });
    } catch { return undefined; }
  },
};
