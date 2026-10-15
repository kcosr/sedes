import type { SavedAgentApplicationService } from "../application/saved-agent-application-service.js";
import type { ConversationBindingRepository } from "../db/repositories/conversation-binding-repository.js";
import type { ConversationCreationRepository } from "../db/repositories/conversation-creation-repository.js";
import type { AutomationRepository } from "../db/repositories/automation-repository.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import { AutomationDeferredError } from "../domain/automation-deferred.js";
import { DomainError } from "../domain/errors.js";
import type { AutomationConversationDispatchInput } from "./automation-conversation-gateway.js";
import type { AutomationExecutionPolicy } from "./automation-execution-policy.js";

/** Selects a fork path only before this run has a durable result artifact. */
export class AutomationForkTargetResolver {
  constructor(readonly input: {
    readonly automations: AutomationRepository;
    readonly bindings: ConversationBindingRepository;
    readonly creation: ConversationCreationRepository;
    readonly inventory: InventoryRepository;
    readonly savedAgents: SavedAgentApplicationService;
    readonly policy: AutomationExecutionPolicy;
  }) {}

  async resolve(input: Extract<AutomationConversationDispatchInput, { runMode: "clone" }>): Promise<
    { readonly kind: "child"; readonly childThreadId: string } | { readonly kind: "native" }
  > {
    const run = this.input.automations.getRun(input.scope, input.automationId, input.automationRunId);
    if (run.anchorThreadId !== input.anchorThreadId || run.dispatchMutationId !== input.dispatchMutationId || run.runMode !== "clone" || run.forceResetAt !== null) {
      throw new DomainError("conflict", "The automation dispatch does not match its durable run.");
    }
    const identity = { automationId: input.automationId, automationRunId: input.automationRunId };
    if (run.childThreadId) {
      // A deleted/reset child is a visible failure, never permission to copy again.
      this.input.inventory.getThread(input.scope, run.childThreadId);
      return { kind: "child", childThreadId: run.childThreadId };
    }
    const copy = this.input.bindings.findThreadConfigurationCopyReceipt(input.scope, {
      sourceApplicationThreadId: input.anchorThreadId,
      title: "", // Automation copy identity deliberately excludes presentation.
      mutationId: input.dispatchMutationId,
      automation: identity,
    });
    if (copy) {
      this.input.inventory.getThread(input.scope, copy.applicationThreadId);
      this.input.automations.bindResultChild(input.scope, input.automationId, input.automationRunId, {
        childThreadId: copy.applicationThreadId, claimToken: input.claimToken, now: Date.now(),
      });
      return { kind: "child", childThreadId: copy.applicationThreadId };
    }
    const attempt = this.input.creation.findByMutationId(input.scope, input.dispatchMutationId);
    if (attempt) {
      if (attempt.creationKind !== "fork") throw new DomainError("conflict", "The automation result creation has lost its copy attribution.");
      return { kind: "native" };
    }
    const source = this.input.inventory.getThread(input.scope, input.anchorThreadId).thread;
    if (source.backingState === "bound") return { kind: "native" };
    if (source.backingState !== "unbound") {
      throw new AutomationDeferredError(source.backingState === "creating" ? "source_materializing" : "source_recovery", "The automation source is waiting for conversation creation to settle.");
    }
    const assertAdmission = () => {
      const current = this.input.automations.getRun(input.scope, input.automationId, input.automationRunId);
      if (current.state !== "dispatching" || current.claimToken !== input.claimToken || current.forceResetAt !== null) {
        throw new DomainError("conflict", "The automation dispatch no longer owns its claim.");
      }
      const anchor = this.input.inventory.getThread(input.scope, input.anchorThreadId);
      if (anchor.inventory.inventoryState === "archived") throw new DomainError("archived_thread", "The automation source is archived.");
      this.input.inventory.assertWorkspaceActive(input.scope, anchor.thread.workspaceId);
      this.input.policy.assertCanAutomate(input.scope, input.anchorThreadId);
    };
    assertAdmission();
    let child;
    try {
      child = await this.input.savedAgents.createAutomationForkFromDraft(input.scope, input.anchorThreadId, {
      mutationId: input.dispatchMutationId, title: `${source.title}${input.resultTitleSuffix}`,
    }, {
      ...identity,
      assertAdmission,
      bindResult: (childThreadId, now) => {
        assertAdmission();
        this.input.automations.bindResultChild(input.scope, input.automationId, input.automationRunId, {
          childThreadId, claimToken: input.claimToken, now,
        });
      },
    });
    } catch (error) {
      // No external effect occurs during settings capture or draft reservation.
      // A changed source configuration is safe to re-admit with a fresh capture.
      if (error instanceof DomainError && error.code === "conflict" &&
          !this.input.bindings.findThreadConfigurationCopyReceipt(input.scope, {
            sourceApplicationThreadId: input.anchorThreadId, title: "", mutationId: input.dispatchMutationId, automation: identity,
          })) {
        throw new AutomationDeferredError("source_materializing", error.message);
      }
      throw error;
    }
    return { kind: "child", childThreadId: child.threadId };
  }
}
