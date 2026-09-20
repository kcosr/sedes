import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { AutomationExecutionPolicy } from "../../runtime/automation-execution-policy.js";

export class GrokAutomationExecutionPolicy implements AutomationExecutionPolicy {
  assertCanAutomate(_scope: RequestScope, _applicationThreadId: string): never {
    throw new DomainError(
      "invalid_transition",
      "Grok automation is not supported by this backend profile.",
    );
  }
}
