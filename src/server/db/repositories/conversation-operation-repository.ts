import { steerTargetSchema, type SteerTarget } from "../../../shared/protocol/conversation.js";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import {
  threadApplicationOperationSchema,
  type ThreadApplicationOperation,
} from "../../../shared/protocol/api.js";
import type { InteractionResponseInput } from "../../backends/contracts.js";
import {
  contextExcerptArraySchema,
  type ContextExcerpt,
} from "../../../shared/protocol/context-excerpts.js";
import {
  parseStoredContextExcerpts,
  sameContextExcerpts,
} from "../context-excerpts-json.js";
import { hasDeliverableComposerInput } from "../../../shared/protocol/conversation.js";
import { interactionResponseInputSchema } from "../../../shared/protocol/backend.js";
import type { ComposerAttachmentDescriptor } from "../../../shared/protocol/composer-attachments.js";
import type {
  ComposerTaskReference,
  MaterializedTaskContext,
} from "../../../shared/protocol/tasks.js";
import { ComposerAttachmentRepository } from "./composer-attachment-repository.js";
import { activateSettledThreadForAcceptedInput } from "./accepted-input-inventory.js";
import {
  assertMaterializedComposerBytes,
  materializeTaskReferences,
  parseStoredTaskContexts,
  parseStoredTaskReferences,
  sameTaskContexts,
  serializeTaskContexts,
  serializeTaskReferences,
} from "../composer-tasks-json.js";

type PerformOperation = Extract<
  ThreadApplicationOperation,
  { readonly kind: "perform" }
>;
type RespondOperation = Extract<
  ThreadApplicationOperation,
  { readonly kind: "respond" }
>;

type SteerOperationRecordBase = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly mutationId: string;
  readonly applicationOperationId: string;
  readonly reconciliationToken: string;
  readonly expectedThreadRevision: number;
  readonly selectedSkillId: string | null;
  readonly contextExcerpts: ContextExcerpt[];
  readonly attachments: ComposerAttachmentDescriptor[];
  readonly taskContexts: MaterializedTaskContext[];
  readonly target: SteerTarget | null;
  readonly state:
    "prepared" | "uncertain" | "pending_materialization" | "accepted" | "failed_unknown";
  readonly failureDiagnostic?: string;
  readonly createdAt: number;
};

export type DraftSteerOperationRecord = SteerOperationRecordBase & {
  readonly source: "draft";
  readonly expectedDraftRevision: number;
};

export type QueuedInputSteerOperationRecord = SteerOperationRecordBase & {
  readonly source: "queued_input";
  readonly queuedInputId: string;
  readonly priorQueueState: "pending" | "retry_wait";
  readonly priorNextAttemptAt: number | null;
  readonly priorDiagnostic: string | null;
};

export type SteerOperationRecord =
  DraftSteerOperationRecord | QueuedInputSteerOperationRecord;

export type InterruptOperationRecord = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly operationId: string;
  readonly applicationOperationId: string;
  readonly expectedActiveTurnId: string;
  readonly state: "prepared" | "uncertain" | "accepted";
  readonly createdAt: number;
};

export type BackendActionOperationRecord = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly mutationId: string;
  readonly applicationOperationId: string;
  readonly operationKind:
    "conversation_rename" | "conversation_compact" | "conversation_settings";
  readonly action: "rename" | "compact" | "set_setting";
  readonly expectedThreadRevision: number;
  readonly expectedSettingsRevision?: number;
  readonly operation: PerformOperation["operation"];
  readonly state: "prepared" | "uncertain" | "accepted";
  readonly createdAt: number;
};

export type InteractionResponseOperationRecord = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly operationId: string;
  readonly applicationOperationId: string;
  readonly interactionId: string;
  readonly response?: RespondOperation["response"];
  readonly backendResponse?: InteractionResponseInput;
  readonly state: "prepared" | "uncertain" | "accepted";
  readonly createdAt: number;
};

export type UncertainThreadOperationCategory =
  | "delivery"
  | "interrupt"
  | "compaction"
  | "rename"
  | "settings"
  | "creation"
  | "automation"
  | "other";

export type UncertainThreadOperationRecord = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly mutationId: string;
  readonly operationKind: string;
  readonly category: UncertainThreadOperationCategory;
  readonly diagnostic: string;
  readonly submissionMayHaveBeenAccepted: boolean;
  readonly createdAt: number;
};

type ReceiptRow = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly mutationId: string;
  readonly operationKind: string;
  readonly requestFingerprint: string;
  readonly resultCode: string;
  readonly resultJson: string;
  readonly taskContextsJson: string;
  readonly replayable: 0 | 1;
  readonly createdAt: number;
};

type SteerResultBase = {
  readonly version: 5;
  readonly applicationOperationId: string;
  readonly reconciliationToken: string;
  readonly expectedThreadRevision: number;
  readonly selectedSkillId: string | null;
  readonly contextExcerpts: ContextExcerpt[];
  readonly target: SteerTarget | null;
  readonly failureDiagnostic?: string;
};

type DraftSteerResult = SteerResultBase & {
  readonly source: "draft";
  readonly expectedDraftRevision: number;
};

type QueuedInputSteerResult = SteerResultBase & {
  readonly source: "queued_input";
  readonly queuedInputId: string;
  readonly priorQueueState: "pending" | "retry_wait";
  readonly priorNextAttemptAt: number | null;
  readonly priorDiagnostic: string | null;
};

type SteerResult = DraftSteerResult | QueuedInputSteerResult;

type InterruptResult = {
  readonly version: 1;
  readonly applicationOperationId: string;
  readonly expectedActiveTurnId: string;
};

type BackendActionResult = {
  readonly version: 1;
  readonly applicationOperationId: string;
  readonly action: "rename" | "compact" | "set_setting";
  readonly expectedThreadRevision: number;
  readonly expectedSettingsRevision?: number;
  readonly operation: PerformOperation["operation"];
};

type InteractionResponseResult = {
  readonly version: 1;
  readonly applicationOperationId: string;
  readonly interactionId: string;
  readonly response?: RespondOperation["response"];
  readonly backendResponse?: InteractionResponseInput;
};

const rowColumns = `
  tenant_id AS tenantId, principal_id AS principalId,
  thread_id AS threadId, mutation_id AS mutationId,
  operation_kind AS operationKind,
  request_fingerprint AS requestFingerprint,
  result_code AS resultCode, result_json AS resultJson,
  task_contexts_json AS taskContextsJson,
  replayable, created_at AS createdAt
`;

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertOperationNotAbandoned(
  row: ReceiptRow,
  operationKinds: ReadonlySet<string>,
  safeMessage: string,
): void {
  if (row.resultCode === "abandoned" && operationKinds.has(row.operationKind)) {
    throw new DomainError("conflict", safeMessage);
  }
}

const steerOperationKinds = new Set(["conversation_steer"]);
const interruptOperationKinds = new Set(["conversation_interrupt"]);
const backendActionOperationKinds = new Set([
  "conversation_rename",
  "conversation_compact",
  "conversation_settings",
]);
const interactionResponseOperationKinds = new Set([
  "conversation_interaction_response",
]);

function parseSteer(
  row: ReceiptRow,
  attachments: ComposerAttachmentDescriptor[],
): SteerOperationRecord {
  assertOperationNotAbandoned(
    row,
    steerOperationKinds,
    "The steering operation was explicitly abandoned.",
  );
  if (
    row.operationKind !== "conversation_steer" ||
    (row.resultCode !== "prepared" &&
      row.resultCode !== "uncertain" &&
      row.resultCode !== "pending_materialization" &&
      row.resultCode !== "failed_unknown" &&
      row.resultCode !== "accepted")
  ) {
    throw new DomainError(
      "conflict",
      "The steering operation receipt is corrupt.",
    );
  }
  let result: Partial<SteerResult> & Record<string, unknown>;
  try {
    result = JSON.parse(row.resultJson) as Partial<SteerResult> &
      Record<string, unknown>;
  } catch (error) {
    throw new DomainError(
      "conflict",
      "The steering operation receipt is corrupt.",
      false,
      { cause: error },
    );
  }
  if (
    typeof result !== "object" ||
    result === null ||
    result.version !== 5 ||
    (result.source !== "draft" && result.source !== "queued_input") ||
    typeof result.applicationOperationId !== "string" ||
    typeof result.reconciliationToken !== "string" ||
    !Number.isSafeInteger(result.expectedThreadRevision) ||
    (result.selectedSkillId !== null &&
      (typeof result.selectedSkillId !== "string" ||
        result.selectedSkillId.length < 1 ||
        result.selectedSkillId.length > 160)) ||
    (result.target !== null && !steerTargetSchema.safeParse(result.target).success) ||
    (row.resultCode !== "prepared" && result.target === null)
  ) {
    throw new DomainError(
      "conflict",
      "The steering operation receipt is corrupt.",
    );
  }
  const commonKeys = [
    "applicationOperationId",
    "contextExcerpts",
    "target",
    "expectedThreadRevision",
    "reconciliationToken",
    "selectedSkillId",
    "source",
    "version",
    ...(row.resultCode === "failed_unknown" ? ["failureDiagnostic"] : []),
  ];
  if (row.resultCode === "failed_unknown" &&
      (typeof result.failureDiagnostic !== "string" ||
        result.failureDiagnostic.length < 1 || result.failureDiagnostic.length > 500)) {
    throw new DomainError("conflict", "The steering operation receipt is corrupt.");
  }
  const sourceKeys =
    result.source === "draft"
      ? ["expectedDraftRevision"]
      : [
          "priorDiagnostic",
          "priorNextAttemptAt",
          "priorQueueState",
          "queuedInputId",
        ];
  if (
    Object.keys(result).sort().join("\0") !==
    [...commonKeys, ...sourceKeys].sort().join("\0")
  ) {
    throw new DomainError(
      "conflict",
      "The steering operation receipt is corrupt.",
    );
  }
  if (result.source === "draft") {
    if (!Number.isSafeInteger(result.expectedDraftRevision)) {
      throw new DomainError(
        "conflict",
        "The steering operation receipt is corrupt.",
      );
    }
  } else if (
    typeof result.queuedInputId !== "string" ||
    result.queuedInputId.length < 1 ||
    result.queuedInputId.length > 128 ||
    (result.priorQueueState !== "pending" &&
      result.priorQueueState !== "retry_wait") ||
    (result.priorNextAttemptAt !== null &&
      !Number.isSafeInteger(result.priorNextAttemptAt)) ||
    (result.priorQueueState === "pending" &&
      result.priorNextAttemptAt !== null) ||
    (result.priorQueueState === "retry_wait" &&
      !Number.isSafeInteger(result.priorNextAttemptAt)) ||
    (result.priorDiagnostic !== null &&
      (typeof result.priorDiagnostic !== "string" ||
        result.priorDiagnostic.length < 1 ||
        result.priorDiagnostic.length > 500))
  ) {
    throw new DomainError(
      "conflict",
      "The steering operation receipt is corrupt.",
    );
  }
  let contextExcerpts: ContextExcerpt[];
  try {
    contextExcerpts = contextExcerptArraySchema.parse(result.contextExcerpts);
  } catch (error) {
    throw new DomainError(
      "conflict",
      "The steering operation receipt is corrupt.",
      false,
      { cause: error },
    );
  }
  const common: SteerOperationRecordBase = {
    tenantId: row.tenantId,
    principalId: row.principalId,
    threadId: row.threadId,
    mutationId: row.mutationId,
    applicationOperationId: result.applicationOperationId as string,
    reconciliationToken: result.reconciliationToken as string,
    expectedThreadRevision: result.expectedThreadRevision!,
    selectedSkillId: result.selectedSkillId as string | null,
    contextExcerpts,
    attachments,
    taskContexts: parseStoredTaskContexts(row.taskContextsJson),
    target: result.target === null ? null : steerTargetSchema.parse(result.target),
    state: row.resultCode as SteerOperationRecordBase["state"],
    ...(row.resultCode === "failed_unknown" ? { failureDiagnostic: result.failureDiagnostic! } : {}),
    createdAt: row.createdAt,
  };
  if (result.source === "draft") {
    const draftResult = result as Partial<DraftSteerResult>;
    return {
      ...common,
      source: "draft",
      expectedDraftRevision: draftResult.expectedDraftRevision!,
    };
  }
  const queuedResult = result as Partial<QueuedInputSteerResult>;
  return {
    ...common,
    source: "queued_input",
    queuedInputId: queuedResult.queuedInputId!,
    priorQueueState: queuedResult.priorQueueState!,
    priorNextAttemptAt: queuedResult.priorNextAttemptAt!,
    priorDiagnostic: queuedResult.priorDiagnostic!,
  };
}

function parseInterrupt(row: ReceiptRow): InterruptOperationRecord {
  assertOperationNotAbandoned(
    row,
    interruptOperationKinds,
    "The interrupt operation was explicitly abandoned.",
  );
  if (
    row.operationKind !== "conversation_interrupt" ||
    (row.resultCode !== "prepared" &&
      row.resultCode !== "uncertain" &&
      row.resultCode !== "accepted")
  ) {
    throw new Error("conversation_interrupt_receipt_invalid");
  }
  const result = JSON.parse(row.resultJson) as Partial<InterruptResult>;
  if (
    result.version !== 1 ||
    typeof result.applicationOperationId !== "string" ||
    typeof result.expectedActiveTurnId !== "string" ||
    result.expectedActiveTurnId.length === 0
  ) {
    throw new Error("conversation_interrupt_receipt_payload_invalid");
  }
  return {
    tenantId: row.tenantId,
    principalId: row.principalId,
    threadId: row.threadId,
    operationId: row.mutationId,
    applicationOperationId: result.applicationOperationId,
    expectedActiveTurnId: result.expectedActiveTurnId,
    state: row.resultCode,
    createdAt: row.createdAt,
  };
}

function backendActionOperationKind(
  action: BackendActionResult["action"],
): BackendActionOperationRecord["operationKind"] {
  if (action === "rename") return "conversation_rename";
  if (action === "compact") return "conversation_compact";
  return "conversation_settings";
}

function parseBackendAction(row: ReceiptRow): BackendActionOperationRecord {
  assertOperationNotAbandoned(
    row,
    backendActionOperationKinds,
    "The backend action operation was explicitly abandoned.",
  );
  if (
    (row.operationKind !== "conversation_rename" &&
      row.operationKind !== "conversation_compact" &&
      row.operationKind !== "conversation_settings") ||
    (row.resultCode !== "prepared" &&
      row.resultCode !== "uncertain" &&
      row.resultCode !== "accepted")
  ) {
    throw new Error("conversation_backend_action_receipt_invalid");
  }
  const result = JSON.parse(row.resultJson) as Partial<BackendActionResult>;
  if (
    result.version !== 1 ||
    typeof result.applicationOperationId !== "string" ||
    (result.action !== "rename" &&
      result.action !== "compact" &&
      result.action !== "set_setting") ||
    !Number.isSafeInteger(result.expectedThreadRevision) ||
    (result.expectedSettingsRevision !== undefined &&
      !Number.isSafeInteger(result.expectedSettingsRevision)) ||
    backendActionOperationKind(result.action) !== row.operationKind ||
    typeof result.operation !== "object" ||
    result.operation === null
  ) {
    throw new Error("conversation_backend_action_receipt_payload_invalid");
  }
  const parsedOperation = threadApplicationOperationSchema.safeParse({
    kind: "perform",
    mutationId: "00000000-0000-0000-0000-000000000000",
    expectedThreadRevision: result.expectedThreadRevision,
    ...(result.expectedSettingsRevision === undefined
      ? {}
      : {
          expectedSettingsRevision: result.expectedSettingsRevision,
        }),
    operation: result.operation,
  });
  if (
    !parsedOperation.success ||
    parsedOperation.data.kind !== "perform" ||
    parsedOperation.data.operation.action !== result.action ||
    JSON.stringify(parsedOperation.data.operation) !==
      JSON.stringify(result.operation)
  ) {
    throw new Error("conversation_backend_action_operation_invalid");
  }
  return {
    tenantId: row.tenantId,
    principalId: row.principalId,
    threadId: row.threadId,
    mutationId: row.mutationId,
    applicationOperationId: result.applicationOperationId,
    operationKind: row.operationKind,
    action: result.action,
    expectedThreadRevision: result.expectedThreadRevision!,
    ...(result.expectedSettingsRevision === undefined
      ? {}
      : { expectedSettingsRevision: result.expectedSettingsRevision }),
    operation: parsedOperation.data.operation,
    state: row.resultCode,
    createdAt: row.createdAt,
  };
}

function parseInteractionResponse(
  row: ReceiptRow,
): InteractionResponseOperationRecord {
  assertOperationNotAbandoned(
    row,
    interactionResponseOperationKinds,
    "The interaction response operation was explicitly abandoned.",
  );
  if (
    row.operationKind !== "conversation_interaction_response" ||
    (row.resultCode !== "prepared" &&
      row.resultCode !== "uncertain" &&
      row.resultCode !== "accepted")
  ) {
    throw new Error("conversation_interaction_response_receipt_invalid");
  }
  const result = JSON.parse(
    row.resultJson,
  ) as Partial<InteractionResponseResult>;
  const expectedKeys =
    row.resultCode === "accepted"
      ? ["applicationOperationId", "interactionId", "version"]
      : [
          "applicationOperationId",
          "backendResponse",
          "interactionId",
          "response",
          "version",
        ];
  if (
    typeof result !== "object" ||
    result === null ||
    Object.keys(result).sort().join("\0") !== expectedKeys.join("\0") ||
    result.version !== 1 ||
    result.applicationOperationId !== row.mutationId ||
    typeof result.interactionId !== "string" ||
    (row.resultCode !== "accepted" &&
      (typeof result.response !== "object" ||
        result.response === null ||
        typeof result.backendResponse !== "object" ||
        result.backendResponse === null))
  ) {
    throw new Error(
      "conversation_interaction_response_receipt_payload_invalid",
    );
  }
  const parsedOperation = threadApplicationOperationSchema.safeParse({
    kind: "respond",
    operationId: result.applicationOperationId,
    interactionId: result.interactionId,
    response:
      row.resultCode === "accepted"
        ? { kind: "confirmation", confirmed: false }
        : result.response,
  });
  if (
    !parsedOperation.success ||
    parsedOperation.data.kind !== "respond" ||
    (row.resultCode !== "accepted" &&
      JSON.stringify(parsedOperation.data.response) !==
        JSON.stringify(result.response))
  ) {
    throw new Error("conversation_interaction_response_operation_invalid");
  }
  if (row.resultCode !== "accepted") {
    const backendResponse = result.backendResponse!;
    const parsedBackendResponse =
      interactionResponseInputSchema.safeParse(backendResponse);
    if (
      !parsedBackendResponse.success ||
      parsedBackendResponse.data.applicationOperationId !== row.mutationId ||
      JSON.stringify(parsedBackendResponse.data) !==
        JSON.stringify(backendResponse)
    ) {
      throw new Error(
        "conversation_interaction_response_backend_payload_invalid",
      );
    }
  }
  return {
    tenantId: row.tenantId,
    principalId: row.principalId,
    threadId: row.threadId,
    operationId: row.mutationId,
    applicationOperationId: result.applicationOperationId,
    interactionId: result.interactionId,
    ...(row.resultCode === "accepted"
      ? {}
      : {
          response: (
            parsedOperation as {
              success: true;
              data: RespondOperation;
            }
          ).data.response,
          backendResponse: structuredClone(result.backendResponse!),
        }),
    state: row.resultCode,
    createdAt: row.createdAt,
  };
}

function uncertainCategory(
  operationKind: string,
): UncertainThreadOperationCategory {
  switch (operationKind) {
    case "conversation_input":
    case "conversation_steer":
      return "delivery";
    case "automation_input":
      return "automation";
    case "conversation_interrupt":
      return "interrupt";
    case "conversation_compact":
      return "compaction";
    case "conversation_rename":
      return "rename";
    case "conversation_settings":
      return "settings";
    case "conversation_interaction_response":
      return "other";
    case "conversation_create_submit":
    case "automation_create_submit":
    case "creation_retry":
      return "creation";
    default:
      return "other";
  }
}

function parseUncertain(row: ReceiptRow): UncertainThreadOperationRecord {
  if (row.resultCode !== "uncertain") {
    throw new Error("uncertain_thread_operation_receipt_invalid");
  }
  let diagnostic = "A prior operation may already have been applied.";
  const result = JSON.parse(row.resultJson) as unknown;
  if (
    typeof result === "object" &&
    result !== null &&
    "diagnostic" in result &&
    typeof result.diagnostic === "string" &&
    result.diagnostic.trim().length > 0
  ) {
    diagnostic = result.diagnostic;
  }
  const category = uncertainCategory(row.operationKind);
  return {
    tenantId: row.tenantId,
    principalId: row.principalId,
    threadId: row.threadId,
    mutationId: row.mutationId,
    operationKind: row.operationKind,
    category,
    diagnostic,
    submissionMayHaveBeenAccepted:
      category === "delivery" ||
      category === "automation" ||
      category === "creation",
    createdAt: row.createdAt,
  };
}

export class ConversationOperationRepository {
  readonly #attachments: ComposerAttachmentRepository;

  constructor(readonly database: Database.Database) {
    this.#attachments = new ComposerAttachmentRepository(database);
  }

  prepareRecoverableInteractionResponse(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly operationId: string;
      readonly interactionId: string;
      readonly response: RespondOperation["response"];
      readonly backendResponse?: InteractionResponseInput;
      readonly now: number;
    },
  ): InteractionResponseOperationRecord {
    const requestFingerprint = fingerprint([
      "conversation_interaction_response",
      threadId,
      input.interactionId,
      input.response,
    ]);
    return this.database.transaction(() => {
      const existing = this.#findReceipt(scope, input.operationId);
      if (existing) {
        if (
          existing.threadId !== threadId ||
          existing.operationKind !== "conversation_interaction_response" ||
          existing.requestFingerprint !== requestFingerprint
        ) {
          throw new DomainError(
            "conflict",
            "The operation ID is already used by another operation.",
          );
        }
        return parseInteractionResponse(existing);
      }
      const result: InteractionResponseResult = {
        version: 1,
        applicationOperationId: input.operationId,
        interactionId: input.interactionId,
        response: input.response,
        backendResponse:
          input.backendResponse ??
          (() => {
            throw new Error(
              "conversation_interaction_response_backend_payload_required",
            );
          })(),
      };
      this.database
        .prepare(
          `
            INSERT INTO mutation_receipts(
              tenant_id, principal_id, thread_id, mutation_id,
              operation_kind, request_fingerprint, result_code, result_json,
              replayable, created_at
            )
            VALUES (
              ?, ?, ?, ?, 'conversation_interaction_response',
              ?, 'prepared', ?, 1, ?
            )
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          input.operationId,
          requestFingerprint,
          JSON.stringify(result),
          input.now,
        );
      return this.getInteractionResponse(scope, input.operationId);
    })();
  }

  getInteractionResponse(
    scope: RequestScope,
    operationId: string,
  ): InteractionResponseOperationRecord {
    const row = this.#findReceipt(scope, operationId);
    if (!row || row.operationKind !== "conversation_interaction_response") {
      throw new DomainError(
        "not_found",
        "The interaction response operation was not found.",
      );
    }
    return parseInteractionResponse(row);
  }

  findInteractionResponse(
    scope: RequestScope,
    operationId: string,
  ): InteractionResponseOperationRecord | undefined {
    const row = this.#findReceipt(scope, operationId);
    if (!row) return undefined;
    if (row.operationKind !== "conversation_interaction_response") {
      throw new DomainError(
        "conflict",
        "The operation ID is already used by another operation.",
      );
    }
    return parseInteractionResponse(row);
  }

  markInteractionResponseStarted(
    scope: RequestScope,
    operationId: string,
  ): InteractionResponseOperationRecord {
    this.database
      .prepare(
        `
          UPDATE mutation_receipts
          SET result_code = 'uncertain', replayable = 0
          WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
            AND operation_kind = 'conversation_interaction_response'
            AND result_code = 'prepared'
        `,
      )
      .run(scope.tenantId, scope.principalId, operationId);
    return this.getInteractionResponse(scope, operationId);
  }

  acceptInteractionResponse(
    scope: RequestScope,
    operationId: string,
  ): InteractionResponseOperationRecord {
    const current = this.getInteractionResponse(scope, operationId);
    this.database
      .prepare(
        `
          UPDATE mutation_receipts
          SET result_code = 'accepted', replayable = 1,
            result_json = ?
          WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
            AND operation_kind = 'conversation_interaction_response'
            AND result_code IN ('prepared', 'uncertain')
        `,
      )
      .run(
        JSON.stringify({
          version: 1,
          applicationOperationId: current.applicationOperationId,
          interactionId: current.interactionId,
        } satisfies InteractionResponseResult),
        scope.tenantId,
        scope.principalId,
        operationId,
      );
    return this.getInteractionResponse(scope, operationId);
  }

  acceptInteractionResponseIfUncertain(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly operationId: string;
      readonly interactionId: string;
      readonly response: RespondOperation["response"];
    },
  ): boolean {
    const requestFingerprint = fingerprint([
      "conversation_interaction_response",
      threadId,
      input.interactionId,
      input.response,
    ]);
    const result = this.database
      .prepare(
        `
          UPDATE mutation_receipts
          SET result_code = 'accepted', replayable = 1,
            result_json = ?
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            AND mutation_id = ?
            AND operation_kind = 'conversation_interaction_response'
            AND request_fingerprint = ? AND result_code = 'uncertain'
        `,
      )
      .run(
        JSON.stringify({
          version: 1,
          applicationOperationId: input.operationId,
          interactionId: input.interactionId,
        } satisfies InteractionResponseResult),
        scope.tenantId,
        scope.principalId,
        threadId,
        input.operationId,
        requestFingerprint,
      );
    return result.changes === 1;
  }

  rejectInteractionResponseProvenNotApplied(
    scope: RequestScope,
    operationId: string,
  ): void {
    this.database
      .prepare(
        `
          DELETE FROM mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
            AND operation_kind = 'conversation_interaction_response'
            AND result_code IN ('prepared', 'uncertain')
        `,
      )
      .run(scope.tenantId, scope.principalId, operationId);
  }

  listUncertainInteractionResponses(
    scope: RequestScope,
  ): InteractionResponseOperationRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT ${rowColumns}
            FROM mutation_receipts
            WHERE tenant_id = ? AND principal_id = ?
              AND operation_kind = 'conversation_interaction_response'
              AND result_code = 'uncertain'
            ORDER BY created_at, mutation_id
          `,
        )
        .all(scope.tenantId, scope.principalId) as ReceiptRow[]
    ).map(parseInteractionResponse);
  }

  prepareInterrupt(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly operationId: string;
      readonly expectedActiveTurnId: string;
      readonly now: number;
    },
  ): InterruptOperationRecord {
    const requestFingerprint = fingerprint([
      "conversation_interrupt",
      threadId,
    ]);
    return this.database.transaction(() => {
      const existing = this.#findReceipt(scope, input.operationId);
      if (existing) {
        if (
          existing.threadId !== threadId ||
          existing.operationKind !== "conversation_interrupt" ||
          existing.requestFingerprint !== requestFingerprint
        ) {
          throw new DomainError(
            "conflict",
            "The operation ID is already used by another operation.",
          );
        }
        return parseInterrupt(existing);
      }
      if (input.expectedActiveTurnId.length === 0) {
        throw new Error("conversation_interrupt_active_turn_required");
      }
      const result: InterruptResult = {
        version: 1,
        applicationOperationId: input.operationId,
        expectedActiveTurnId: input.expectedActiveTurnId,
      };
      this.database
        .prepare(
          `
            INSERT INTO mutation_receipts(
              tenant_id, principal_id, thread_id, mutation_id,
              operation_kind, request_fingerprint, result_code, result_json,
              replayable, created_at
            )
            VALUES (?, ?, ?, ?, 'conversation_interrupt', ?, 'prepared', ?, 1, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          input.operationId,
          requestFingerprint,
          JSON.stringify(result),
          input.now,
        );
      return this.getInterrupt(scope, input.operationId);
    })();
  }

  findInterrupt(
    scope: RequestScope,
    operationId: string,
  ): InterruptOperationRecord | undefined {
    const row = this.#findReceipt(scope, operationId);
    return row?.operationKind === "conversation_interrupt"
      ? parseInterrupt(row)
      : undefined;
  }

  getInterrupt(
    scope: RequestScope,
    operationId: string,
  ): InterruptOperationRecord {
    const record = this.findInterrupt(scope, operationId);
    if (!record) {
      throw new DomainError(
        "not_found",
        "The interrupt operation was not found.",
      );
    }
    return record;
  }

  markInterruptStarted(
    scope: RequestScope,
    operationId: string,
  ): InterruptOperationRecord {
    return this.database.transaction(() => {
      const current = this.getInterrupt(scope, operationId);
      if (current.state === "prepared") {
        this.database
          .prepare(
            `
              UPDATE mutation_receipts
              SET result_code = 'uncertain', replayable = 0
              WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
                AND operation_kind = 'conversation_interrupt'
                AND result_code = 'prepared'
            `,
          )
          .run(scope.tenantId, scope.principalId, operationId);
      }
      return this.getInterrupt(scope, operationId);
    })();
  }

  acceptInterrupt(
    scope: RequestScope,
    operationId: string,
  ): InterruptOperationRecord {
    return this.database.transaction(() => {
      const current = this.getInterrupt(scope, operationId);
      if (current.state !== "accepted") {
        this.database
          .prepare(
            `
              UPDATE mutation_receipts
              SET result_code = 'accepted', replayable = 1
              WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
                AND operation_kind = 'conversation_interrupt'
                AND result_code IN ('prepared', 'uncertain')
            `,
          )
          .run(scope.tenantId, scope.principalId, operationId);
      }
      return this.getInterrupt(scope, operationId);
    })();
  }

  rejectInterruptProvenNotApplied(
    scope: RequestScope,
    operationId: string,
  ): void {
    this.database.transaction(() => {
      const current = this.getInterrupt(scope, operationId);
      if (current.state === "accepted") {
        throw new DomainError(
          "conflict",
          "An accepted interrupt cannot be rejected.",
        );
      }
      this.database
        .prepare(
          `
            DELETE FROM mutation_receipts
            WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
              AND operation_kind = 'conversation_interrupt'
              AND result_code IN ('prepared', 'uncertain')
          `,
        )
        .run(scope.tenantId, scope.principalId, operationId);
    })();
  }

  prepareBackendAction(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly expectedSettingsRevision?: number;
      readonly operation: PerformOperation["operation"];
      readonly now: number;
    },
  ): BackendActionOperationRecord {
    if (input.operation.action === "perform_provider_feature") {
      throw new Error("provider_feature_requires_dedicated_receipt");
    }
    const operation = input.operation;
    const requestFingerprint = fingerprint([
      "conversation_backend_action",
      threadId,
      input.expectedThreadRevision,
      input.expectedSettingsRevision ?? null,
      operation,
    ]);
    const operationKind = backendActionOperationKind(operation.action);
    return this.database.transaction(() => {
      const existing = this.#findReceipt(scope, input.mutationId);
      if (existing) {
        if (
          existing.threadId !== threadId ||
          existing.operationKind !== operationKind ||
          existing.requestFingerprint !== requestFingerprint
        ) {
          throw new DomainError(
            "conflict",
            "The mutation ID is already used by another operation.",
          );
        }
        return parseBackendAction(existing);
      }
      const result: BackendActionResult = {
        version: 1,
        applicationOperationId: input.mutationId,
        action: operation.action,
        expectedThreadRevision: input.expectedThreadRevision,
        operation,
        ...(input.expectedSettingsRevision === undefined
          ? {}
          : {
              expectedSettingsRevision: input.expectedSettingsRevision,
            }),
      };
      this.database
        .prepare(
          `
            INSERT INTO mutation_receipts(
              tenant_id, principal_id, thread_id, mutation_id,
              operation_kind, request_fingerprint, result_code, result_json,
              replayable, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, 1, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          input.mutationId,
          operationKind,
          requestFingerprint,
          JSON.stringify(result),
          input.now,
        );
      return this.getBackendAction(scope, input.mutationId);
    })();
  }

  findBackendAction(
    scope: RequestScope,
    mutationId: string,
  ): BackendActionOperationRecord | undefined {
    const row = this.#findReceipt(scope, mutationId);
    return row &&
      (row.operationKind === "conversation_rename" ||
        row.operationKind === "conversation_compact" ||
        row.operationKind === "conversation_settings")
      ? parseBackendAction(row)
      : undefined;
  }

  getBackendAction(
    scope: RequestScope,
    mutationId: string,
  ): BackendActionOperationRecord {
    const record = this.findBackendAction(scope, mutationId);
    if (!record) {
      throw new DomainError(
        "not_found",
        "The backend action operation was not found.",
      );
    }
    return record;
  }

  markBackendActionStarted(
    scope: RequestScope,
    mutationId: string,
  ): BackendActionOperationRecord {
    return this.database.transaction(() => {
      const current = this.getBackendAction(scope, mutationId);
      if (current.state === "prepared") {
        this.database
          .prepare(
            `
              UPDATE mutation_receipts
              SET result_code = 'uncertain', replayable = 0
              WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
                AND operation_kind = ?
                AND result_code = 'prepared'
            `,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            mutationId,
            current.operationKind,
          );
      }
      return this.getBackendAction(scope, mutationId);
    })();
  }

  acceptBackendAction(
    scope: RequestScope,
    mutationId: string,
  ): BackendActionOperationRecord {
    return this.database.transaction(() => {
      const current = this.getBackendAction(scope, mutationId);
      if (current.state !== "accepted") {
        this.database
          .prepare(
            `
              UPDATE mutation_receipts
              SET result_code = 'accepted', replayable = 1
              WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
                AND operation_kind = ?
                AND result_code IN ('prepared', 'uncertain')
            `,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            mutationId,
            current.operationKind,
          );
      }
      return this.getBackendAction(scope, mutationId);
    })();
  }

  rejectBackendActionProvenNotApplied(
    scope: RequestScope,
    mutationId: string,
  ): void {
    this.database.transaction(() => {
      const current = this.getBackendAction(scope, mutationId);
      if (current.state === "accepted") {
        throw new DomainError(
          "conflict",
          "An accepted backend action cannot be rejected.",
        );
      }
      this.database
        .prepare(
          `
            DELETE FROM mutation_receipts
            WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
              AND operation_kind = ?
              AND result_code IN ('prepared', 'uncertain')
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          mutationId,
          current.operationKind,
        );
    })();
  }

  prepareSteer(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly mutationId: string;
      readonly text: string;
      readonly selectedSkillId?: string;
      readonly contextExcerpts: readonly ContextExcerpt[];
      readonly attachmentIds: readonly string[];
      readonly taskReferences: readonly ComposerTaskReference[];
      readonly expectedThreadRevision: number;
      readonly expectedDraftRevision: number;
      readonly now: number;
    },
  ): DraftSteerOperationRecord {
    const requestFingerprint = fingerprint([
      "conversation_steer",
      threadId,
      input.text,
      input.expectedThreadRevision,
      input.expectedDraftRevision,
      input.selectedSkillId ?? null,
      input.contextExcerpts,
      input.attachmentIds,
      input.taskReferences,
    ]);
    return this.database.transaction(() => {
      const existing = this.#findReceipt(scope, input.mutationId);
      if (existing) {
        if (
          existing.threadId !== threadId ||
          existing.operationKind !== "conversation_steer" ||
          existing.requestFingerprint !== requestFingerprint
        ) {
          throw new DomainError(
            "conflict",
            "The mutation ID is already used by another operation.",
          );
        }
        const replay = this.#parseSteer(scope, existing);
        if (replay.source !== "draft") {
          throw new DomainError(
            "conflict",
            "The mutation ID is already used by another operation.",
          );
        }
        return replay;
      }
      if (this.hasBlockingSteer(scope, threadId)) {
        throw new DomainError(
          "invalid_transition",
          "Wait for the previous steering input to appear before steering again.",
        );
      }
      const thread = this.database
        .prepare(
          `
            SELECT revision, backing_state AS backingState
            FROM application_threads
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .get(scope.tenantId, scope.principalId, threadId) as
        | { readonly revision: number; readonly backingState: string }
        | undefined;
      const draft = this.database
        .prepare(
          `
            SELECT text, selected_skill_id AS selectedSkillId,
              context_excerpts_json AS contextExcerptsJson,
              task_references_json AS taskReferencesJson, revision
            FROM thread_drafts
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          `,
        )
        .get(scope.tenantId, scope.principalId, threadId) as
        | {
            readonly text: string;
            readonly selectedSkillId: string | null;
            readonly contextExcerptsJson: string;
            readonly taskReferencesJson: string;
            readonly revision: number;
          }
        | undefined;
      if (!thread || !draft) {
        throw new DomainError("not_found", "The thread was not found.");
      }
      const storedContextExcerpts = parseStoredContextExcerpts(
        draft.contextExcerptsJson,
      );
      const storedTaskReferences = parseStoredTaskReferences(
        draft.taskReferencesJson,
      );
      if (
        thread.backingState !== "bound" ||
        thread.revision !== input.expectedThreadRevision
      ) {
        throw new DomainError(
          "conflict",
          "The thread changed before it could be steered.",
        );
      }
      if (
        draft.revision !== input.expectedDraftRevision ||
        draft.text !== input.text ||
        draft.selectedSkillId !== (input.selectedSkillId ?? null) ||
        !sameContextExcerpts(storedContextExcerpts, input.contextExcerpts) ||
        serializeTaskReferences(storedTaskReferences) !==
          serializeTaskReferences(input.taskReferences) ||
        this.#attachments
          .descriptorsForOwner(scope, { kind: "draft", threadId })
          .map(({ id }) => id)
          .join("\0") !== input.attachmentIds.join("\0") ||
        !hasDeliverableComposerInput({
          text: draft.text,
          selectedSkillId: draft.selectedSkillId,
          contextExcerpts: storedContextExcerpts,
          attachments: input.attachmentIds,
          taskReferences: storedTaskReferences,
        })
      ) {
        throw new DomainError(
          "draft_revision_conflict",
          "The composer changed or is empty.",
        );
      }
      const taskContexts = materializeTaskReferences(
        this.database,
        scope,
        input.taskReferences,
      );
      assertMaterializedComposerBytes({
        text: input.text,
        contextExcerpts: input.contextExcerpts,
        taskContexts,
      });
      const result: DraftSteerResult = {
        version: 5,
        source: "draft",
        applicationOperationId: input.mutationId,
        reconciliationToken: input.mutationId,
        expectedThreadRevision: input.expectedThreadRevision,
        expectedDraftRevision: input.expectedDraftRevision,
        selectedSkillId: input.selectedSkillId ?? null,
        contextExcerpts: contextExcerptArraySchema.parse(input.contextExcerpts),
        target: null,
      };
      this.#attachments.replaceOwnerLinks(
        scope,
        { kind: "operation", threadId, mutationId: input.mutationId },
        input.attachmentIds,
      );
      this.database
        .prepare(
          `
            INSERT INTO mutation_receipts(
              tenant_id, principal_id, thread_id, mutation_id,
              operation_kind, request_fingerprint, result_code, result_json,
              task_contexts_json, replayable, created_at
            )
            VALUES (?, ?, ?, ?, 'conversation_steer', ?, 'prepared', ?, ?, 1, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          input.mutationId,
          requestFingerprint,
          JSON.stringify(result),
          serializeTaskContexts(taskContexts),
          input.now,
        );
      const prepared = this.getSteer(scope, input.mutationId);
      if (prepared.source !== "draft") {
        throw new Error("draft_steer_receipt_source_mismatch");
      }
      return prepared;
    })();
  }

  prepareQueuedInputSteer(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly mutationId: string;
      readonly queuedInputId: string;
      readonly text: string;
      readonly selectedSkillId?: string;
      readonly contextExcerpts: readonly ContextExcerpt[];
      readonly attachmentIds: readonly string[];
      readonly taskContexts: readonly MaterializedTaskContext[];
      readonly expectedThreadRevision: number;
      readonly priorQueueState: "pending" | "retry_wait";
      readonly priorNextAttemptAt: number | null;
      readonly priorDiagnostic: string | null;
      readonly now: number;
    },
  ): QueuedInputSteerOperationRecord {
    if (
      (input.priorQueueState === "pending" &&
        input.priorNextAttemptAt !== null) ||
      (input.priorQueueState === "retry_wait" &&
        input.priorNextAttemptAt === null) ||
      !Number.isSafeInteger(input.expectedThreadRevision) ||
      input.expectedThreadRevision < 0 ||
      input.expectedThreadRevision === Number.MAX_SAFE_INTEGER
    ) {
      throw new DomainError(
        "conflict",
        "The queued-input Steer reservation boundary is invalid.",
      );
    }
    const requestFingerprint = fingerprint([
      "conversation_steer",
      "queued_input",
      threadId,
      input.queuedInputId,
      input.text,
      input.expectedThreadRevision,
      input.selectedSkillId ?? null,
      input.contextExcerpts,
      input.attachmentIds,
      input.taskContexts,
      input.priorQueueState,
      input.priorNextAttemptAt,
      input.priorDiagnostic,
    ]);
    return this.database.transaction(() => {
      const existing = this.#findReceipt(scope, input.mutationId);
      if (existing) {
        if (
          existing.threadId !== threadId ||
          existing.operationKind !== "conversation_steer" ||
          existing.requestFingerprint !== requestFingerprint
        ) {
          throw new DomainError(
            "conflict",
            "The mutation ID is already used by another operation.",
          );
        }
        const replay = this.#parseSteer(scope, existing);
        if (replay.source !== "queued_input") {
          throw new DomainError(
            "conflict",
            "The mutation ID is already used by another operation.",
          );
        }
        return replay;
      }
      if (this.hasBlockingSteer(scope, threadId)) {
        throw new DomainError(
          "invalid_transition",
          "Wait for the previous steering input to appear before steering again.",
        );
      }
      if (
        !hasDeliverableComposerInput({
          ...input,
          attachments: input.attachmentIds,
          taskContexts: input.taskContexts,
        }) ||
        input.queuedInputId.length < 1 ||
        input.queuedInputId.length > 128 ||
        (input.priorDiagnostic !== null &&
          (input.priorDiagnostic.length < 1 ||
            input.priorDiagnostic.length > 500))
      ) {
        throw new DomainError(
          "invalid_transition",
          "The queued-input Steer receipt is invalid.",
        );
      }
      const queued = this.database
        .prepare(
          `
            SELECT text, selected_skill_id AS selectedSkillId,
              context_excerpts_json AS contextExcerptsJson,
              task_contexts_json AS taskContextsJson
            FROM queued_inputs
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND id = ?
              AND state = 'dispatching' AND delivery_mode = 'steer'
              AND reconciliation_token = ? AND trigger_kind = 'user'
              AND EXISTS (
                SELECT 1 FROM application_threads AS thread
                WHERE thread.tenant_id = queued_inputs.tenant_id
                  AND thread.owner_principal_id = queued_inputs.owner_principal_id
                  AND thread.id = queued_inputs.application_thread_id
                  AND thread.backing_state = 'bound'
                  AND thread.revision = ?
              )
          `,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          threadId,
          input.queuedInputId,
          input.mutationId,
          input.expectedThreadRevision + 1,
        ) as
        | {
            readonly text: string;
            readonly selectedSkillId: string | null;
            readonly contextExcerptsJson: string;
            readonly taskContextsJson: string;
          }
        | undefined;
      if (
        !queued ||
        queued.text !== input.text ||
        queued.selectedSkillId !== (input.selectedSkillId ?? null) ||
        !sameContextExcerpts(
          parseStoredContextExcerpts(queued.contextExcerptsJson),
          input.contextExcerpts,
        ) ||
        !sameTaskContexts(
          parseStoredTaskContexts(queued.taskContextsJson),
          input.taskContexts,
        ) ||
        this.#attachments
          .descriptorsForOwner(scope, {
            kind: "queue",
            threadId,
            queuedInputId: input.queuedInputId,
          })
          .map(({ id }) => id)
          .join("\0") !== input.attachmentIds.join("\0")
      ) {
        throw new DomainError(
          "invalid_transition",
          "The queued input changed before its Steer receipt was prepared.",
        );
      }
      const result: QueuedInputSteerResult = {
        version: 5,
        source: "queued_input",
        applicationOperationId: input.mutationId,
        reconciliationToken: input.mutationId,
        expectedThreadRevision: input.expectedThreadRevision,
        selectedSkillId: input.selectedSkillId ?? null,
        contextExcerpts: contextExcerptArraySchema.parse(input.contextExcerpts),
        target: null,
        queuedInputId: input.queuedInputId,
        priorQueueState: input.priorQueueState,
        priorNextAttemptAt: input.priorNextAttemptAt,
        priorDiagnostic: input.priorDiagnostic,
      };
      this.#attachments.replaceOwnerLinks(
        scope,
        { kind: "operation", threadId, mutationId: input.mutationId },
        input.attachmentIds,
      );
      this.database
        .prepare(
          `
            INSERT INTO mutation_receipts(
              tenant_id, principal_id, thread_id, mutation_id,
              operation_kind, request_fingerprint, result_code, result_json,
              task_contexts_json, replayable, created_at
            )
            VALUES (?, ?, ?, ?, 'conversation_steer', ?, 'prepared', ?, ?, 1, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          input.mutationId,
          requestFingerprint,
          JSON.stringify(result),
          serializeTaskContexts(input.taskContexts),
          input.now,
        );
      const prepared = this.getSteer(scope, input.mutationId);
      if (prepared.source !== "queued_input") {
        throw new Error("queued_input_steer_receipt_source_mismatch");
      }
      return prepared;
    })();
  }

  markSteerSubmissionStarted(
    scope: RequestScope,
    mutationId: string,
    target: SteerTarget,
  ): SteerOperationRecord {
    if (!steerTargetSchema.safeParse(target).success) {
      throw new DomainError(
        "invalid_transition",
        "A steering operation requires an active turn.",
      );
    }
    return this.database.transaction(() => {
      const current = this.getSteer(scope, mutationId);
      if (current.state === "prepared") {
        const common: SteerResultBase = {
          version: 5,
          applicationOperationId: current.applicationOperationId,
          reconciliationToken: current.reconciliationToken,
          expectedThreadRevision: current.expectedThreadRevision,
          selectedSkillId: current.selectedSkillId,
          contextExcerpts: current.contextExcerpts,
          target,
        };
        const result: SteerResult =
          current.source === "draft"
            ? {
                ...common,
                source: "draft",
                expectedDraftRevision: current.expectedDraftRevision,
              }
            : {
                ...common,
                source: "queued_input",
                queuedInputId: current.queuedInputId,
                priorQueueState: current.priorQueueState,
                priorNextAttemptAt: current.priorNextAttemptAt,
                priorDiagnostic: current.priorDiagnostic,
              };
        this.database
          .prepare(
            `
              UPDATE mutation_receipts
              SET result_code = 'uncertain', result_json = ?, replayable = 0
              WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
                AND operation_kind = 'conversation_steer'
                AND result_code = 'prepared'
            `,
          )
          .run(
            JSON.stringify(result),
            scope.tenantId,
            scope.principalId,
            mutationId,
          );
      }
      const started = this.getSteer(scope, mutationId);
      if (JSON.stringify(started.target) !== JSON.stringify(target)) {
        throw new DomainError(
          "conflict",
          "The steering operation targets another active turn.",
        );
      }
      return started;
    })();
  }

  markSteerPendingMaterialization(
    scope: RequestScope,
    mutationId: string,
    now: number,
  ): SteerOperationRecord {
    return this.database.transaction(() => {
      const current = this.getSteer(scope, mutationId);
      if (current.state === "pending_materialization") return current;
      if (current.state !== "uncertain") {
        throw new DomainError(
          "invalid_transition",
          "The steering operation cannot await materialization from its current state.",
        );
      }
      const changed = this.database
        .prepare(
          `
            UPDATE mutation_receipts
            SET result_code = 'pending_materialization', replayable = 1
            WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
              AND operation_kind = 'conversation_steer'
              AND result_code = 'uncertain'
          `,
        )
        .run(scope.tenantId, scope.principalId, mutationId);
      if (changed.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The steering operation changed before materialization could be recorded.",
        );
      }
      if (current.source === "draft") {
        this.database
          .prepare(
            `
              UPDATE application_threads
              SET revision = revision + 1, updated_at = ?
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .run(now, scope.tenantId, scope.principalId, current.threadId);
      }
      return this.getSteer(scope, mutationId);
    })();
  }

  markSteerMaterializationUncertain(
    scope: RequestScope,
    mutationId: string,
    now: number,
  ): SteerOperationRecord {
    return this.database.transaction(() => {
      const current = this.getSteer(scope, mutationId);
      if (current.state === "uncertain") return current;
      if (current.state !== "pending_materialization") {
        throw new DomainError(
          "invalid_transition",
          "Only a pending steering operation can require materialization recovery.",
        );
      }
      this.database.prepare(`
        UPDATE mutation_receipts
        SET result_code = 'uncertain', replayable = 0
        WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
          AND operation_kind = 'conversation_steer'
          AND result_code = 'pending_materialization'
      `).run(scope.tenantId, scope.principalId, mutationId);
      if (current.source === "draft") {
        this.database.prepare(`
          UPDATE application_threads SET revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `).run(now, scope.tenantId, scope.principalId, current.threadId);
      }
      return this.getSteer(scope, mutationId);
    })();
  }

  failSteerUnknown(
    scope: RequestScope,
    mutationId: string,
    diagnostic: string,
    now: number,
  ): SteerOperationRecord {
    return this.database.transaction(() => {
      const current = this.getSteer(scope, mutationId);
      if (current.state === "failed_unknown") return current;
      if (current.target?.kind !== "conversation" ||
          (current.state !== "pending_materialization" && current.state !== "uncertain") ||
          diagnostic.length < 1 || diagnostic.length > 500) {
        throw new DomainError("invalid_transition", "This steering operation cannot close with an unknown outcome.");
      }
      this.database.prepare(`
        UPDATE mutation_receipts
        SET result_code = 'failed_unknown', replayable = 1,
          result_json = json_set(result_json, '$.failureDiagnostic', ?)
        WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
          AND operation_kind = 'conversation_steer'
          AND result_code IN ('pending_materialization', 'uncertain')
      `).run(diagnostic, scope.tenantId, scope.principalId, mutationId);
      if (current.source === "draft") {
        this.database.prepare(`
          UPDATE application_threads SET revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `).run(now, scope.tenantId, scope.principalId, current.threadId);
      }
      return this.getSteer(scope, mutationId);
    })();
  }

  acceptSteer(
    scope: RequestScope,
    mutationId: string,
    now: number,
  ): SteerOperationRecord {
    return this.database.transaction(() => {
      const current = this.getSteer(scope, mutationId);
      if (current.state === "accepted") return current;
      if (current.state === "failed_unknown" && !this.#canAcceptFailedSteer(scope, current)) {
        throw new DomainError("invalid_transition", "The steering operation was closed with an unknown outcome.");
      }
      this.database
        .prepare(
          `
            UPDATE mutation_receipts
            SET result_code = 'accepted', replayable = 1,
              result_json = json_remove(result_json, '$.failureDiagnostic')
            WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
              AND operation_kind = 'conversation_steer'
              AND result_code IN ('prepared', 'uncertain', 'pending_materialization', 'failed_unknown')
          `,
        )
        .run(scope.tenantId, scope.principalId, mutationId);
      if (current.source === "draft") {
        this.#attachments.replaceOwnerLinks(
          scope,
          { kind: "draft", threadId: current.threadId },
          [],
        );
        this.database
          .prepare(
            `
              UPDATE thread_drafts
              SET text = '', selected_skill_id = NULL,
                context_excerpts_json = '[]', task_references_json = '[]',
                updated_at = ?,
                revision = revision + 1
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
                AND revision = ?
            `,
          )
          .run(
            now,
            scope.tenantId,
            scope.principalId,
            current.threadId,
            current.expectedDraftRevision,
          );
        this.database
          .prepare(
            `
              UPDATE application_threads
              SET revision = revision + 1, last_activity_at = ?, updated_at = ?
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .run(now, now, scope.tenantId, scope.principalId, current.threadId);
      }
      activateSettledThreadForAcceptedInput(
        this.database,
        scope,
        current.threadId,
        now,
      );
      return this.getSteer(scope, mutationId);
    })();
  }

  rejectSteerBeforeAcceptance(scope: RequestScope, mutationId: string): void {
    this.database.transaction(() => {
      const current = this.getSteer(scope, mutationId);
      if (current.state === "accepted" || current.state === "failed_unknown") {
        throw new DomainError(
          "conflict",
          "A closed steering operation cannot be rejected.",
        );
      }
      this.database
        .prepare(
          `
            DELETE FROM mutation_receipts
            WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
              AND operation_kind = 'conversation_steer'
          `,
        )
        .run(scope.tenantId, scope.principalId, mutationId);
    })();
  }

  rejectPendingMaterializationSteer(
    scope: RequestScope,
    mutationId: string,
    now: number,
  ): void {
    this.database.transaction(() => {
      const current = this.getSteer(scope, mutationId);
      if (current.state !== "pending_materialization") {
        throw new DomainError(
          "invalid_transition",
          "Only a pending steering operation can be closed as not materialized.",
        );
      }
      const deleted = this.database
        .prepare(
          `
            DELETE FROM mutation_receipts
            WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
              AND operation_kind = 'conversation_steer'
              AND result_code = 'pending_materialization'
          `,
        )
        .run(scope.tenantId, scope.principalId, mutationId);
      if (deleted.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The pending steering operation changed during reconciliation.",
        );
      }
      if (current.source === "draft") {
        this.database
          .prepare(
            `
              UPDATE application_threads
              SET revision = revision + 1, updated_at = ?
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .run(now, scope.tenantId, scope.principalId, current.threadId);
      }
    })();
  }

  getSteer(scope: RequestScope, mutationId: string): SteerOperationRecord {
    const row = this.#findReceipt(scope, mutationId);
    if (!row || row.operationKind !== "conversation_steer") {
      throw new DomainError(
        "not_found",
        "The steering operation was not found.",
      );
    }
    return this.#parseSteer(scope, row);
  }

  findSteer(
    scope: RequestScope,
    mutationId: string,
  ): SteerOperationRecord | undefined {
    const row = this.#findReceipt(scope, mutationId);
    if (!row) return undefined;
    if (row.operationKind !== "conversation_steer") {
      throw new DomainError(
        "conflict",
        "The mutation ID is already used by another operation.",
      );
    }
    return this.#parseSteer(scope, row);
  }

  findUncertainSteer(
    scope: RequestScope,
    threadId: string,
  ): DraftSteerOperationRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${rowColumns}
          FROM mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            AND operation_kind = 'conversation_steer'
            AND result_code = 'uncertain'
          ORDER BY created_at DESC, mutation_id DESC
          LIMIT 1
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      ReceiptRow | undefined;
    if (!row) return undefined;
    const receipt = this.#parseSteer(scope, row);
    return receipt.source === "draft" ? receipt : undefined;
  }

  findPendingMaterializationSteer(
    scope: RequestScope,
    threadId: string,
  ): SteerOperationRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${rowColumns}
          FROM mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            AND operation_kind = 'conversation_steer'
            AND result_code = 'pending_materialization'
          ORDER BY created_at, mutation_id
          LIMIT 1
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      ReceiptRow | undefined;
    return row ? this.#parseSteer(scope, row) : undefined;
  }

  findAwaitingSteerSubmission(
    scope: RequestScope,
    threadId: string,
    applicationOperationId: string,
  ): SteerOperationRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${rowColumns}
          FROM mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            AND mutation_id = ?
            AND operation_kind = 'conversation_steer'
            AND result_code IN ('uncertain', 'pending_materialization', 'failed_unknown')
          LIMIT 1
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        threadId,
        applicationOperationId,
      ) as ReceiptRow | undefined;
    if (!row) return undefined;
    const receipt = this.#parseSteer(scope, row);
    if (receipt.state === "failed_unknown" && !this.#canAcceptFailedSteer(scope, receipt)) {
      return undefined;
    }
    return receipt.applicationOperationId === applicationOperationId
      ? receipt
      : undefined;
  }

  #canAcceptFailedSteer(scope: RequestScope, receipt: SteerOperationRecord): boolean {
    if (receipt.source !== "queued_input") return false;
    return this.database.prepare(`
      SELECT 1 FROM queued_inputs
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND id = ?
        AND state = 'failed' AND failure_acknowledged_at IS NULL
    `).get(scope.tenantId, scope.principalId, receipt.threadId, receipt.queuedInputId) !== undefined;
  }

  hasBlockingSteer(scope: RequestScope, threadId: string): boolean {
    const row = this.database
      .prepare(
        `
          SELECT 1
          FROM mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            AND operation_kind = 'conversation_steer'
            AND result_code IN (
              'prepared', 'uncertain', 'pending_materialization'
            )
          LIMIT 1
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId);
    return row !== undefined;
  }

  hasPendingMaterializationSteer(
    scope: RequestScope,
    threadId: string,
  ): boolean {
    return this.findPendingMaterializationSteer(scope, threadId) !== undefined;
  }

  listPendingMaterializationSteers(
    scope: RequestScope,
  ): SteerOperationRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT ${rowColumns}
            FROM mutation_receipts
            WHERE tenant_id = ? AND principal_id = ?
              AND operation_kind = 'conversation_steer'
              AND result_code = 'pending_materialization'
            ORDER BY created_at, mutation_id
          `,
        )
        .all(scope.tenantId, scope.principalId) as ReceiptRow[]
    ).map((row) => this.#parseSteer(scope, row));
  }

  hasBlockingThreadOperation(scope: RequestScope, threadId: string): boolean {
    return (
      this.findUncertainThreadOperation(scope, threadId) !== undefined ||
      this.hasBlockingSteer(scope, threadId)
    );
  }

  findUncertainThreadOperation(
    scope: RequestScope,
    threadId: string,
  ): UncertainThreadOperationRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${rowColumns}
          FROM mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            AND result_code = 'uncertain'
          ORDER BY created_at, mutation_id
          LIMIT 1
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      ReceiptRow | undefined;
    return row ? parseUncertain(row) : undefined;
  }

  hasUncertainThreadOperation(scope: RequestScope, threadId: string): boolean {
    return this.findUncertainThreadOperation(scope, threadId) !== undefined;
  }

  listUncertainSteers(scope: RequestScope): DraftSteerOperationRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT ${rowColumns}
            FROM mutation_receipts
            WHERE tenant_id = ? AND principal_id = ?
              AND operation_kind = 'conversation_steer'
              AND result_code = 'uncertain'
            ORDER BY created_at, mutation_id
          `,
        )
        .all(scope.tenantId, scope.principalId) as ReceiptRow[]
    )
      .map((row) => this.#parseSteer(scope, row))
      .filter(
        (receipt): receipt is DraftSteerOperationRecord =>
          receipt.source === "draft",
      );
  }

  listPreparedDraftSteers(scope: RequestScope): DraftSteerOperationRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT ${rowColumns}
            FROM mutation_receipts
            WHERE tenant_id = ? AND principal_id = ?
              AND operation_kind = 'conversation_steer'
              AND result_code = 'prepared'
            ORDER BY created_at, mutation_id
          `,
        )
        .all(scope.tenantId, scope.principalId) as ReceiptRow[]
    )
      .map((row) => this.#parseSteer(scope, row))
      .filter(
        (receipt): receipt is DraftSteerOperationRecord =>
          receipt.source === "draft",
      );
  }

  listUncertainInterrupts(scope: RequestScope): InterruptOperationRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT ${rowColumns}
            FROM mutation_receipts
            WHERE tenant_id = ? AND principal_id = ?
              AND operation_kind = 'conversation_interrupt'
              AND result_code = 'uncertain'
            ORDER BY created_at, mutation_id
          `,
        )
        .all(scope.tenantId, scope.principalId) as ReceiptRow[]
    ).map(parseInterrupt);
  }

  listUncertainBackendActions(
    scope: RequestScope,
  ): BackendActionOperationRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT ${rowColumns}
            FROM mutation_receipts
            WHERE tenant_id = ? AND principal_id = ?
              AND operation_kind IN (
                'conversation_rename',
                'conversation_compact',
                'conversation_settings'
              )
              AND result_code = 'uncertain'
            ORDER BY created_at, mutation_id
          `,
        )
        .all(scope.tenantId, scope.principalId) as ReceiptRow[]
    ).map(parseBackendAction);
  }

  #findReceipt(
    scope: RequestScope,
    mutationId: string,
  ): ReceiptRow | undefined {
    return this.database
      .prepare(
        `
          SELECT ${rowColumns}
          FROM mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      ReceiptRow | undefined;
  }

  #parseSteer(scope: RequestScope, row: ReceiptRow): SteerOperationRecord {
    return parseSteer(
      row,
      this.#attachments.descriptorsForOwner(scope, {
        kind: "operation",
        threadId: row.threadId,
        mutationId: row.mutationId,
      }),
    );
  }
}
