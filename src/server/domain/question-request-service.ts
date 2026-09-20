import type { SteerTarget } from "../../shared/protocol/conversation.js";
import {
  respondToQuestionResultSchema,
  type RespondToQuestionResult,
} from "../../shared/protocol/api.js";
import { projectQueuedInputSummaries } from "../conversations/queued-input-projection.js";
import {
  questionRequestsResultSchema,
  respondToQuestionRequestSchema,
  dismissQuestionRequestSchema,
  type NonblockingQuestionsPayload,
  type RespondToQuestionRequest,
  type DismissQuestionRequest,
  type QuestionRequest,
  type QuestionRequestsResult,
  type QuestionStatusesResult,
} from "../../shared/protocol/questions.js";
import type { QuestionRequestRepository } from "../db/repositories/question-request-repository.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { QueuedInputRepository } from "../db/repositories/queued-input-repository.js";
import type { QueuedInputDispatcher } from "../conversations/queued-input-dispatcher.js";
import type { QueuedInputConversationGateway } from "../conversations/queued-input-conversation-gateway.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { DomainError } from "./errors.js";

/** Principal-owned nonblocking questions. Resolution and ordinary input admission
 * share a transaction; replies never read or modify the browser composer. */
export class QuestionRequestService {
  constructor(
    readonly input: {
      repository: QuestionRequestRepository;
      inventory: InventoryRepository;
      queue: QueuedInputRepository;
      gateway: Pick<QueuedInputConversationGateway, "withConversation">;
      dispatch: Pick<QueuedInputDispatcher, "dispatchAdmitted">;
      publish(
        scope: RequestScope,
        threadId: string,
        result: QuestionRequestsResult,
      ): void;
      onOpened(scope: RequestScope, request: QuestionRequest): void;
    },
  ) {
    if (
      input.repository.database !== input.queue.database ||
      input.queue.database !== input.inventory.database
    ) {
      throw new Error("question_request_database_mismatch");
    }
  }

  list(scope: RequestScope, threadId: string): QuestionRequestsResult {
    return questionRequestsResultSchema.parse(
      this.input.repository.list(scope, threadId),
    );
  }

  statuses(scope: RequestScope, threadId: string, sourceItemIds: string[]): QuestionStatusesResult {
    return this.input.repository.statuses(scope, threadId, sourceItemIds);
  }

  remember(scope: RequestScope, threadId: string, sourceItemId: string): void {
    this.input.repository.remember(scope, threadId, sourceItemId, Date.now());
  }

  observe(
    scope: RequestScope,
    threadId: string,
    sourceItemId: string,
    payload: NonblockingQuestionsPayload,
  ): void {
    const request = this.input.repository.admit(
      scope,
      threadId,
      sourceItemId,
      payload,
      Date.now(),
    );
    if (!request) return;
    this.#publish(scope, threadId);
    try {
      this.input.onOpened(scope, request);
    } catch {
      // Notification delivery never changes admission.
    }
  }

  dismiss(
    scope: RequestScope,
    threadId: string,
    id: string,
    input: DismissQuestionRequest,
  ): QuestionRequestsResult {
    const { revision } = dismissQuestionRequestSchema.parse(input);
    const pending = this.input.repository.get(scope, threadId, id);
    if (
      pending &&
      !this.input.repository.dismiss(scope, threadId, id, revision)
    ) {
      throw new DomainError(
        "conflict",
        "This question changed. Refresh and try again.",
      );
    }
    return this.#publish(scope, threadId);
  }

  async respond(
    scope: RequestScope,
    threadId: string,
    id: string,
    input: RespondToQuestionRequest,
  ): Promise<RespondToQuestionResult> {
    const { revision, answers } = respondToQuestionRequestSchema.parse(input);
    const orderedAnswers = [...answers].sort(
      (a, b) => a.questionIndex - b.questionIndex,
    );
    const mutationId = `question:${id}:${revision}`;
    const validateAdmission = (
      inventory = this.input.inventory.getThread(scope, threadId),
    ) => {
      const request = this.input.repository.get(scope, threadId, id);
      if (!request || request.revision !== revision) {
        throw new DomainError("conflict", "This question is no longer open.");
      }
      const resolvedAnswers = orderedAnswers.map(
        ({ questionIndex, answer }) => {
          const question = request.questions.find(
            ({ index }) => index === questionIndex,
          );
          if (!question) {
            throw new DomainError(
              "conflict",
              "This question is no longer open.",
            );
          }
          return { questionIndex, question: question.title, answer };
        },
      );
      const inputOrigin = {
        kind: "question_response" as const,
        requestId: request.id,
        sourceItemId: request.sourceItemId,
        answers: resolvedAnswers,
      };
      const text =
        "User responded to a question:\n" +
        resolvedAnswers
          .map(
            ({ question, answer }) =>
              `Question: ${question}\nAnswer: ${answer}`,
          )
          .join("\n\n");
      // Match the durable queued_inputs.text UTF-8 byte constraint, including
      // authoritative question titles and the response labels.
      if (Buffer.byteLength(text, "utf8") > 64 * 1_024) {
        throw new DomainError(
          "invalid_transition",
          "The combined reply is too large. Send fewer answers at a time.",
        );
      }
      if (
        inventory.thread.availability !== "available" ||
        inventory.inventory.inventoryState === "archived" ||
        inventory.inventory.inventoryState === "snoozed"
      ) {
        throw new DomainError(
          "invalid_transition",
          "The thread must be available and active to send a response.",
        );
      }
      return { text, inputOrigin };
    };
    // Resolve against the same backend-neutral steerability predicate as normal
    // composer delivery. Acquisition never changes the durable admission boundary.
    let plan: {
      resolvedDeliveryMode: "submit" | "queue" | "steer";
      resolvedSteerTarget?: SteerTarget;
    } = { resolvedDeliveryMode: "queue" };
    if (!this.input.queue.findByMutationId(scope, threadId, mutationId)) {
      // Reject invalid input before attaching a runtime. The transaction below
      // repeats these checks after the asynchronous delivery planning boundary.
      validateAdmission();
      try {
        await this.input.gateway.withConversation(
          scope,
          threadId,
          async (conversation) => {
            const target = await conversation.steerTarget?.();
            if (target) {
              plan = {
                resolvedDeliveryMode: "steer",
                resolvedSteerTarget: target,
              };
            } else if (conversation.authoritativelySettled) {
              plan = { resolvedDeliveryMode: "submit" };
            }
          },
        );
      } catch {
        // Durable queue recovery can retry a temporarily unavailable runtime.
      }
    }
    const admitted = this.input.repository.database.transaction(() => {
      const inventory = this.input.inventory.getThread(scope, threadId);
      const replay = this.input.queue.findByMutationId(
        scope,
        threadId,
        mutationId,
      );
      if (replay) {
        if (
          replay.inputOrigin?.kind !== "question_response" ||
          JSON.stringify(
            replay.inputOrigin.answers.map(({ questionIndex, answer }) => ({
              questionIndex,
              answer,
            })),
          ) !== JSON.stringify(orderedAnswers)
        ) {
          throw new DomainError(
            "conflict",
            "This question already has a different response.",
          );
        }
        return replay;
      }
      const { text, inputOrigin } = validateAdmission(inventory);
      if (
        plan.resolvedDeliveryMode === "steer" &&
        projectQueuedInputSummaries(
          this.input.queue.list(scope, threadId),
        ).some(
          (item) =>
            item.state === "failed" ||
            (item.resolvedDeliveryMode !== "steer" &&
              item.deliveryMode !== "steer"),
        )
      ) {
        // Preserve the same queue ordering that normal composer steering honors.
        plan = { resolvedDeliveryMode: "queue" };
      }
      const queued = this.input.queue.enqueue(scope, threadId, {
        mutationId,
        text,
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "question_response",
          ...plan,
          inputOrigin,
          expectedThreadRevision: inventory.thread.revision,
        },
        now: Date.now(),
      });
      if (
        !this.input.repository.resolveAnswers(
          scope,
          threadId,
          id,
          revision,
          orderedAnswers.map(({ questionIndex }) => questionIndex),
        )
      ) {
        throw new DomainError("conflict", "This question is no longer open.");
      }
      return queued.item;
    })();
    const snapshot = this.#publish(scope, threadId);
    // Capture the authoritative admission before asynchronous dispatch can change
    // its state. Replayed terminal inputs must not reappear as pending in clients.
    const queuedInput =
      projectQueuedInputSummaries(this.input.queue.list(scope, threadId)).find(
        (item) => item.id === admitted.id,
      ) ?? null;
    const result = respondToQuestionResultSchema.parse({
      ...snapshot,
      deliveryOperationId:
        queuedInput?.deliveryOperationId ??
        admitted.reconciliationToken ??
        admitted.mutationId,
      queuedInput,
      deliveryState:
        queuedInput !== null
          ? "pending"
          : admitted.state === "accepted"
            ? "accepted"
            : admitted.state === "failed"
              ? "failed"
              : "cancelled",
    });
    // Input admission is already authoritative. Dispatch failure is handled by
    // queue recovery and cannot turn an accepted response into an HTTP failure.
    void this.input.dispatch
      .dispatchAdmitted(scope, threadId)
      .catch(() => undefined);
    return result;
  }

  #publish(scope: RequestScope, threadId: string): QuestionRequestsResult {
    const result = this.list(scope, threadId);
    try {
      this.input.publish(scope, threadId, result);
    } catch {
      // Reconnect reloads durable state.
    }
    return result;
  }
}
