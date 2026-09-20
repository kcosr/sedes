import type { ClassifiedAssistantResult } from "../../shared/protocol/completion-result.js";
import type { NotificationEventPayload } from "../../shared/protocol/notification.js";
import type { BackendInteraction } from "../../shared/protocol/conversation.js";
import type {
  InventoryPrincipalStateRecord,
  InventoryRepository,
} from "../db/repositories/inventory-repository.js";
import type { SubmissionCompletionObservationRecord } from "../db/repositories/submission-completion-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { AutomationRunLifecycleObserver } from "./automation-service.js";

/** Passive, post-commit consumers of Sedes-owned lifecycle state. */
export class NotificationLifecycleObserver {
  constructor(
    readonly inventory: InventoryRepository,
    readonly emit: (
      scope: RequestScope,
      payload: NotificationEventPayload,
      eventKey: string,
      assistantResult?: ClassifiedAssistantResult,
    ) => void,
  ) {}

  interactionOpened(
    scope: RequestScope,
    interaction: BackendInteraction,
  ): void {
    try {
      const context = this.#context(scope, interaction.threadId);
      const approval =
        interaction.kind === "decision" || interaction.kind === "confirmation";
      this.emit(
        scope,
        {
          event: approval ? "approval.requested" : "input.requested",
          occurredAt: interaction.openedAt,
          title: approval ? "Approval requested" : "Input requested",
          message: context.thread.title,
          ...context,
          interaction: { id: interaction.id, kind: interaction.kind },
        },
        JSON.stringify(["interaction", interaction.threadId, interaction.id]),
      );
    } catch {
      // Never export prompt contents, or affect the pending interaction.
    }
  }

  questionOpened(
    scope: RequestScope,
    request: {
      readonly id: string;
      readonly threadId: string;
      readonly questionCount: number;
      readonly createdAt: string;
    },
  ): void {
    try {
      const context = this.#context(scope, request.threadId);
      this.emit(
        scope,
        {
          event: "question.requested",
          occurredAt: request.createdAt,
          title: "Nonblocking questions",
          message: context.thread.title,
          ...context,
          question: { id: request.id, questionCount: request.questionCount },
        },
        JSON.stringify(["question", request.threadId, request.id]),
      );
    } catch {
      // Passive notifications never export question contents or affect the inbox.
    }
  }

  completion(
    scope: RequestScope,
    observation: SubmissionCompletionObservationRecord,
  ): void {
    if (
      observation.tenantId !== scope.tenantId ||
      observation.ownerPrincipalId !== scope.principalId ||
      observation.applicationTurnId === null ||
      observation.completionOutcome === null ||
      observation.assistantResult === null ||
      observation.completionObservedAt === null
    )
      return;
    try {
      const context = this.#context(scope, observation.applicationThreadId);
      const outcome = observation.completionOutcome;
      this.emit(
        scope,
        {
          event: `turn.${outcome}`,
          occurredAt: new Date(observation.completionObservedAt).toISOString(),
          title:
            outcome === "completed"
              ? "Agent finished"
              : outcome === "failed"
                ? "Agent turn failed"
                : "Agent turn interrupted",
          message: context.thread.title,
          ...context,
          turn: { id: observation.applicationTurnId, outcome },
        },
        JSON.stringify([
          "turn",
          observation.applicationThreadId,
          observation.applicationTurnId,
        ]),
        observation.classifiedResult ?? undefined,
      );
    } catch {
      // Notifications are best effort and must never disrupt conversation work.
    }
  }

  deadlineWake(
    scope: RequestScope,
    state: InventoryPrincipalStateRecord,
  ): void {
    if (
      state.tenantId !== scope.tenantId ||
      state.principalId !== scope.principalId ||
      state.wakeReason !== "deadline" ||
      state.wokeAt === null
    )
      return;
    try {
      const context = this.#context(scope, state.threadId);
      this.emit(
        scope,
        {
          event: "thread.woke",
          occurredAt: new Date(state.wokeAt).toISOString(),
          title: "Snoozed thread woke",
          message: state.wakeReminderText ?? context.thread.title,
          ...context,
          wake: {
            reason: "deadline",
            ...(state.wakeReminderText === null
              ? {}
              : { reminderText: state.wakeReminderText }),
          },
        },
        JSON.stringify([
          "wake",
          state.threadId,
          state.wokeAt,
          state.inventoryRevision,
        ]),
      );
    } catch {
      // A failed observer never prevents the inventory transition/publication.
    }
  }

  automation(
    scope: RequestScope,
    input: Parameters<AutomationRunLifecycleObserver>[1],
  ): void {
    const { event, run, definition } = input;
    if (
      run.tenantId !== scope.tenantId ||
      run.ownerPrincipalId !== scope.principalId ||
      definition.tenantId !== scope.tenantId ||
      definition.ownerPrincipalId !== scope.principalId ||
      definition.id !== run.automationId
    )
      return;
    // Automation run completion currently means backend acceptance. acceptedAt
    // is queue admission (and is null for immediate first-input acceptance).
    const occurredAt = run.finishedAt;
    if (occurredAt === null) return;
    try {
      const context = this.#context(
        scope,
        run.childThreadId ?? run.anchorThreadId,
      );
      this.emit(
        scope,
        {
          event,
          occurredAt: new Date(occurredAt).toISOString(),
          title:
            event === "automation.started"
              ? "Automation started"
              : "Automation failed",
          message: definition.name,
          ...context,
          automation: {
            id: definition.id,
            name: definition.name,
            runId: run.id,
            trigger: run.occurrenceKind,
            ...(event === "automation.failed"
              ? {
                  stage:
                    run.precheckStatus === "failed" ? "precheck" : "dispatch",
                  // Raw provider diagnostics and precheck output are deliberately
                  // excluded from the script payload.
                  diagnostic:
                    run.precheckStatus === "failed"
                      ? "Automation pre-check failed."
                      : "Automation could not start.",
                }
              : {}),
          },
        },
        JSON.stringify(["automation", run.id, event]),
      );
    } catch {
      // Passive script failures have no effect on automation state.
    }
  }

  #context(scope: RequestScope, threadId: string) {
    const { thread } = this.inventory.getThread(scope, threadId);
    const workspace = this.inventory.getWorkspace(scope, thread.workspaceId);
    return {
      thread: { id: thread.id, title: thread.title },
      workspace: { id: workspace.id, name: workspace.displayName },
    };
  }
}
