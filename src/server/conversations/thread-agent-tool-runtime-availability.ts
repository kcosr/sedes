import type {
  AgentToolPresentation,
  ThreadAgentToolRuntimeAvailability,
} from "../../shared/protocol/conversation.js";
import type { BackendModuleRuntime } from "../backends/module.js";
import { ConversationBindingRepository } from "../db/repositories/conversation-binding-repository.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import { environmentAdmitsForegroundOperation } from "../domain/environment-operational-state.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ThreadExecutionWorkspaceReader } from "./database-thread-application-readers.js";
import { boundDisplayText } from "./payload-policy.js";

export interface ThreadAgentToolRuntimeAvailabilityReader {
  read(
    scope: RequestScope,
    applicationThreadId: string,
    presentation: AgentToolPresentation,
  ): ThreadAgentToolRuntimeAvailability;
}

/** Projects current eligibility without attaching to a provider or changing saved policy. */
export class DatabaseThreadAgentToolRuntimeAvailabilityReader
  implements ThreadAgentToolRuntimeAvailabilityReader
{
  readonly #bindings: ConversationBindingRepository;
  constructor(readonly input: {
    readonly inventory: InventoryRepository;
    readonly runtimes: ReadonlyMap<string, BackendModuleRuntime>;
    readonly executionWorkspaces: ThreadExecutionWorkspaceReader;
  }) {
    this.#bindings = new ConversationBindingRepository(input.inventory.database);
  }

  read(
    scope: RequestScope,
    applicationThreadId: string,
    presentation: AgentToolPresentation,
  ): ThreadAgentToolRuntimeAvailability {
    const { thread, inventory } = this.input.inventory.getThread(
      scope,
      applicationThreadId,
    );
    if (inventory.inventoryState === "archived") {
      return {
        availability: "unavailable",
        reason: boundDisplayText("This thread is archived. Restore it to use Sedes tools."),
      };
    }
    const environment = this.input.inventory.getEnvironment(
      scope,
      thread.environmentId,
    );
    const workspace = this.input.inventory.getWorkspace(scope, thread.workspaceId);
    const unavailable = (reason: string): ThreadAgentToolRuntimeAvailability => ({
      availability: "unavailable",
      reason: boundDisplayText(reason),
    });
    if (
      thread.availability !== "available" ||
      workspace.availability !== "available" ||
      !environmentAdmitsForegroundOperation(environment)
    ) {
      return unavailable("This thread's execution environment or workspace is unavailable. Restore it in Settings to use Sedes tools.");
    }
    const target = this.input.inventory.database.prepare(`
      SELECT 1 FROM agent_connection_profiles AS profile
      JOIN agent_backend_instances AS backend
        ON backend.tenant_id = profile.tenant_id AND backend.id = profile.backend_instance_id
      WHERE profile.tenant_id = ? AND profile.owner_principal_id = ? AND profile.id = ?
        AND profile.backend_instance_id = ? AND profile.execution_environment_id = ?
        AND profile.enabled = 1 AND backend.enabled = 1
    `).get(scope.tenantId, scope.principalId, thread.connectionProfileId, thread.backendInstanceId, thread.environmentId);
    if (!target) return unavailable("This thread's backend or connection is disabled. Restore it in Settings to use Sedes tools.");
    const runtime = this.input.runtimes.get(thread.backendInstanceId);
    if (
      !runtime ||
      runtime.scope.tenantId !== scope.tenantId ||
      runtime.scope.principalId !== scope.principalId ||
      runtime.instance.tenantId !== scope.tenantId ||
      runtime.instance.id !== thread.backendInstanceId ||
      !runtime.instance.enabled ||
      !runtime.agentToolRuntimeAvailability
    ) {
      return unavailable("The backend is unavailable. Connect it in Settings to check Sedes tool access.");
    }
    const binding = this.#bindings.getBinding(scope, applicationThreadId);
    const result = runtime.agentToolRuntimeAvailability({
      scope,
      applicationThreadId,
      presentation,
      ...(binding ? { backendConversationId: binding.backendConversationId } : {}),
      isolatedWorkspace:
        this.input.executionWorkspaces.read(scope, applicationThreadId).kind ===
        "isolated",
    });
    return result.availability === "available" ? result : unavailable(result.reason);
  }
}
