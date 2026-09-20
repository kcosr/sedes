import {
  type FirstSendResult,
  ConversationLifecycleService,
} from "../conversations/conversation-lifecycle-service.js";
import { DomainError } from "../domain/errors.js";
import type { AutomationFirstInputLifecycle } from "./automation-conversation-gateway.js";

/** First-input automation remains the ordinary conversation lifecycle. */
export class ConversationLifecycleAutomationFirstInput implements AutomationFirstInputLifecycle {
  constructor(
    readonly lifecycle: Pick<
      ConversationLifecycleService,
      "hasFirstInputMutation" | "startAutomationFirstSend"
    >,
  ) {}

  hasMutation(
    scope: Parameters<AutomationFirstInputLifecycle["hasMutation"]>[0],
    mutationId: string,
  ): boolean {
    return this.lifecycle.hasFirstInputMutation(scope, mutationId);
  }

  async submit(
    input: Parameters<AutomationFirstInputLifecycle["submit"]>[0],
  ): ReturnType<AutomationFirstInputLifecycle["submit"]> {
    return firstInputResult(
      await this.lifecycle.startAutomationFirstSend(
        input.scope,
        input.applicationThreadId,
        {
          automationId: input.automationId,
          automationRunId: input.automationRunId,
          prompt: input.prompt,
          mutationId: input.mutationId,
          expectedThreadRevision: input.expectedThreadRevision,
        },
      ),
    );
  }
}

function firstInputResult(
  result: FirstSendResult,
):
  | { readonly status: "accepted" }
  | { readonly status: "uncertain"; readonly diagnostic: string } {
  if (result.status === "bound") return { status: "accepted" };
  if (result.status === "recovery_required") {
    return {
      status: "uncertain",
      diagnostic:
        result.attempt.diagnostic ??
        "Automation submission acceptance is uncertain.",
    };
  }
  throw new DomainError(
    "runtime_unavailable",
    result.attempt.diagnostic ??
      "The backend conversation could not be created.",
  );
}
