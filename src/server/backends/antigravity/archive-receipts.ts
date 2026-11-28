import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { prepareCached } from "../../db/prepared-statements.js";
import { ConversationCreationRepository } from "../../db/repositories/conversation-creation-repository.js";
import { ConversationOperationRepository } from "../../db/repositories/conversation-operation-repository.js";
import { DEFAULT_QUEUE_RETRY_POLICY, QueuedInputRepository } from "../../db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../db/repositories/submission-completion-repository.js";
import type { PrepareConversationArchiveInput } from "../contracts.js";
import type { AntigravityArchiveOperation, AntigravityOutcome, AntigravitySetup } from "./port.js";
import type { AntigravityActionPersistence } from "./action-persistence.js";
import { antigravityConfigOption, antigravityConfigValue } from "./catalog.js";
import { decodeAntigravityModelSetting } from "./model-selection.js";

const notDelivered = "Antigravity confirmed that this input was not delivered.";
type ReceiptInput = Pick<PrepareConversationArchiveInput, "scope" | "binding" | "opaqueBindingDetail">;
type TerminalOutcome = Exclude<AntigravityOutcome, { status: "pending" }>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class AntigravityArchiveReceipts {
  readonly #operations: ConversationOperationRepository;
  readonly #completions: SubmissionCompletionRepository;
  readonly #creations: ConversationCreationRepository;
  readonly #queue: QueuedInputRepository;
  constructor(readonly database: Database.Database, readonly settings: AntigravityActionPersistence) {
    this.#operations = new ConversationOperationRepository(database);
    this.#completions = new SubmissionCompletionRepository(database);
    this.#creations = new ConversationCreationRepository(database);
    this.#queue = new QueuedInputRepository(database);
  }

  creationBound(input: ReceiptInput, operationId: string): boolean {
    const record = this.#creations.findByMutationId(input.scope, operationId);
    const binding = input.binding;
    return record?.phase === "bound" && record.applicationThreadId === binding.applicationThreadId &&
      record.backendInstanceId === binding.backendInstanceId && record.connectionProfileId === binding.connectionProfileId &&
      record.executionEnvironmentId === binding.executionEnvironmentId && record.provisionalBackendConversationId === binding.backendConversationId;
  }

  apply(input: ReceiptInput, owner: string, operation: AntigravityArchiveOperation, outcome: TerminalOutcome, terminalTurn: boolean, setup: AntigravitySetup): boolean {
    const { scope, binding } = input;
    const threadId = binding.applicationThreadId;
    // Acknowledgement can lose its reply after a proven rejection deleted
    // the original uncertain application receipt. Commit that disposition in
    // the same transaction so replay never depends on the now absent row.
    const key = `antigravity_archive:${digest([threadId, owner, operation.operationId])}`;
    const fingerprint = digest([input.opaqueBindingDetail, operation.operationId, operation.kind, operation.commandFingerprint,
      outcome.status, outcome.status === "failed" ? outcome.failure : [
        outcome.cancelledAtNativeRevision, (outcome.result as { stopReason?: unknown } | null)?.stopReason === "cancelled",
      ]]);
    return this.database.transaction(() => {
      const prior = prepareCached(this.database, `SELECT thread_id, request_fingerprint, operation_kind FROM mutation_receipts
        WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?`).get(scope.tenantId, scope.principalId, key) as
          { thread_id: string; request_fingerprint: string; operation_kind: string } | undefined;
      if (prior) return prior.thread_id === threadId && prior.operation_kind === "antigravity_archive_receipt" && prior.request_fingerprint === fingerprint;
      if (!this.#applyDisposition(input, operation, outcome, terminalTurn, setup)) return false;
      prepareCached(this.database, `INSERT INTO mutation_receipts(tenant_id, principal_id, thread_id, mutation_id, operation_kind,
        request_fingerprint, result_code, result_json, replayable, created_at) VALUES(?, ?, ?, ?, 'antigravity_archive_receipt', ?, 'applied', '{}', 0, ?)`)
        .run(scope.tenantId, scope.principalId, threadId, key, fingerprint, Date.now());
      return true;
    }).immediate();
  }

  #applyDisposition(input: ReceiptInput, operation: AntigravityArchiveOperation, outcome: TerminalOutcome, terminalTurn: boolean, setup: AntigravitySetup): boolean {
    const { scope, binding } = input;
    const threadId = binding.applicationThreadId, id = operation.operationId;
    if (this.#operations.isOperationAbandoned(scope, threadId, id)) return true;
    if (outcome.status === "failed" && outcome.failure.delivery === "sent_outcome_unknown") return false;
    if (operation.kind === "prompt" || operation.kind === "steer") {
      if (terminalTurn) {
        const completed = this.#completions.find(scope, threadId, id);
        return outcome.status === "completed" && completed?.backendCorrelation === id && completed.completionOutcome !== null;
      }
      // A cancelled ACP callback can precede native materialization. Only the
      // host's exact cancellation-drain proof plus this fresh history admits rejection.
      if (outcome.status === "completed" && (!outcome.cancelledAtNativeRevision ||
          (outcome.result as { stopReason?: unknown } | null)?.stopReason !== "cancelled")) return false;
      if (operation.kind === "steer") {
        const steer = this.#operations.findSteer(scope, id);
        if (!steer || steer.threadId !== threadId || steer.applicationOperationId !== id ||
            (steer.state !== "uncertain" && steer.state !== "pending_materialization")) return false;
        if (steer.source === "queued_input") {
          this.#operations.rejectSteerBeforeAcceptance(scope, id);
          this.#queue.failSteerNotSent(scope, threadId, steer.queuedInputId, { steerOperationId: id,
            expectedState: steer.state === "pending_materialization" ? "dispatching" : "uncertain", diagnostic: notDelivered, now: Date.now() });
        } else if (steer.state === "pending_materialization") this.#operations.rejectPendingMaterializationSteer(scope, id, Date.now());
        else this.#operations.rejectSteerBeforeAcceptance(scope, id);
        return true;
      }
      const queued = this.#queue.findByMutationId(scope, threadId, id);
      if (!queued) return false;
      if (queued.state === "failed" && queued.failureReason === "not_sent") return true;
      if (queued.deliveryMode !== "submit" || (queued.state !== "dispatching" && queued.state !== "uncertain")) return false;
      const retryable = outcome.status === "failed" && outcome.failure.delivery === "not_sent";
      this.#queue.handleCleanFailure(scope, threadId, queued.id, { expectedState: queued.state, retryable,
        diagnostic: notDelivered, ...(!retryable ? { failureReason: "not_sent" as const } : {}),
        now: Date.now(), retryPolicy: DEFAULT_QUEUE_RETRY_POLICY });
      return true;
    }
    if (operation.kind === "cancel") {
      if (operation.commandFingerprint !== digest({ type: "cancel" })) return false;
      const record = this.#operations.findInterrupt(scope, id);
      if (record?.threadId !== threadId || record.applicationOperationId !== id) return false;
      if (record.state === "accepted") return outcome.status === "completed";
      if (record.state !== "uncertain") return false;
      if (outcome.status === "completed") this.#operations.acceptInterrupt(scope, id);
      else this.#operations.rejectInterruptProvenNotApplied(scope, id);
      return true;
    }
    if (operation.kind === "permission") {
      const record = this.#operations.findInteractionResponse(scope, id);
      if (record?.threadId !== threadId || record.applicationOperationId !== id) return false;
      if (record.state === "accepted") return outcome.status === "completed";
      const response = record.backendResponse;
      if (record.state !== "uncertain" || !response) return false;
      const option = response.kind === "decision" ? response.selectedActionId : response.kind === "choice" &&
        response.selectedOptionIds.length === 1 ? response.selectedOptionIds[0] : undefined;
      if (response.kind !== "cancel" && !option) return false;
      const command = { type: "permission", requestId: response.interactionId, response: {
        outcome: response.kind === "cancel" ? { outcome: "cancelled" } : { outcome: "selected", optionId: option } } };
      if (digest(command) !== operation.commandFingerprint) return false;
      if (outcome.status === "completed") this.#operations.acceptInteractionResponse(scope, id);
      else this.#operations.rejectInteractionResponseProvenNotApplied(scope, id);
      return true;
    }
    if (outcome.status === "completed" && !operation.setterConfirmed) return false;
    // Submission-time configuration has no application action receipt. The
    // host records its origin and checks the exact requested native value.
    if (operation.sessionConfiguration) return true;
    const record = this.#operations.findBackendAction(scope, id);
    if (record?.threadId !== threadId || record.applicationOperationId !== id || record.action !== "set_setting") return false;
    if (record.state === "accepted") return outcome.status === "completed";
    if (record.state === "uncertain" && outcome.status === "failed") {
      this.#operations.rejectBackendActionProvenNotApplied(scope, id); return true;
    }
    if (record.state !== "uncertain" || outcome.status !== "completed" || operation.kind !== "set_config" ||
        record.operation.action !== "set_setting" || !record.operation.value || record.expectedSettingsRevision === undefined) return false;
    const setting = record.operation;
    let category: "model" | "thought_level", value: string;
    if (setting.settingId === "model") {
      const [connectionId, modelId, effort] = decodeAntigravityModelSetting(setting.value!);
      if (connectionId !== binding.connectionProfileId || (effort !== null && antigravityConfigValue(setup, "thought_level") !== effort)) return false;
      category = "model"; value = modelId;
    } else if (setting.settingId === "thinking_level") {
      category = "thought_level"; value = setting.value!;
    } else return false;
    const option = antigravityConfigOption(setup, category);
    if (!option || antigravityConfigValue(setup, category) !== value ||
        operation.commandFingerprint !== digest({ type: "set_config", origin: "thread_action", configId: option.id, value })) return false;
    this.settings.persistAccepted(scope, threadId, { mutationId: id, expectedThreadRevision: record.expectedThreadRevision,
      operation: setting, settingsGuard: { kind: "staged", expectedRevision: record.expectedSettingsRevision }, now: Date.now() });
    return this.#operations.acceptBackendAction(scope, id).state === "accepted";
  }
}
