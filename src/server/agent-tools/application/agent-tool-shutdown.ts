import type { StartupResourceStack } from "../../runtime/startup-resource-stack.js";

/**
 * Register coupled automation tool cleanup in the required LIFO order, so
 * dispatcher work is aborted and settled before canonical execution drains.
 */
export function deferAgentToolAutomationShutdown(
  resources: StartupResourceStack,
  input: {
    readonly closeCanonical: () => void | Promise<void>;
    readonly disposeDispatcher: () => void | Promise<void>;
  },
): void {
  resources.defer("canonical agent tool executions", input.closeCanonical, {
    mode: "ownership_critical",
  });
  resources.defer("automation dispatcher", input.disposeDispatcher, {
    mode: "ownership_critical",
  });
}
