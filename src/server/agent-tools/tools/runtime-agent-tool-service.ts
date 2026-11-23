import { z } from "zod";
import {
  configurationLifecycleImpactRequestSchema, configurationLifecycleRequestSchema,
  type ConfigurationLifecycleImpact,
} from "../../../shared/protocol/configuration-admin.js";
import type { ConfigurationAdminService } from "../../configuration-admin/configuration-admin-service.js";
import { DomainError } from "../../domain/errors.js";
import type { ExecutionManagementAccess } from "../application/execution-management-access.js";
import type { TrustedToolInvocationContext } from "../contracts/agent-tool-contracts.js";
import { presentExecutionRuntime } from "../execution/execution-runtime-presentation.js";

export const runtimeAgentActions = ["connect", "disconnect", "start", "stop", "restart", "upgrade"] as const;
export const runtimeAgentActionSchema = z.enum(runtimeAgentActions);
export const runtimeImpactInputSchema = configurationLifecycleImpactRequestSchema.extend({ action: runtimeAgentActionSchema });
export const runtimeLifecycleInputSchema = configurationLifecycleRequestSchema.omit({ action: true });
export const runtimeOperationInputSchema = z.strictObject({ mutationId: z.string().uuid() });
export type RuntimeManagementOperation = "runtime.impact" | `runtime.${typeof runtimeAgentActions[number]}` | "runtime.operation.get";
export type RuntimeManagementResult = ConfigurationLifecycleImpact | {
  mutationId: string;
  state: "pending" | "applied" | "rejected" | "unavailable" | "unknown";
  runtime: ReturnType<typeof presentExecutionRuntime>;
};
export interface RuntimeManagementService {
  execute(context: TrustedToolInvocationContext, operation: RuntimeManagementOperation, input: unknown): Promise<RuntimeManagementResult>;
}

/** Thread-agent adapter over the existing lifecycle service. The lazy reference
 * preserves production composition order and is never evaluated at construction. */
export class RuntimeAgentToolService implements RuntimeManagementService {
  constructor(readonly configuration: () => ConfigurationAdminService, readonly access: ExecutionManagementAccess) {}

  async execute(context: TrustedToolInvocationContext, operation: RuntimeManagementOperation, value: unknown): Promise<RuntimeManagementResult> {
    const scope = this.access.assertCaller(context, operation);
    const service = this.configuration();
    if (operation === "runtime.impact") {
      const input = runtimeImpactInputSchema.parse(value);
      const authorize = () => {
        this.access.revalidate(context, operation, input);
      };
      authorize();
      return service.impact(scope, input, authorize);
    }
    if (operation === "runtime.operation.get") {
      const input = runtimeOperationInputSchema.parse(value);
      const authorize = () => {
        this.access.revalidate(context, operation, input);
        // Read-only receipt identity lookup must precede the service operation:
        // lifecycleReceipt can settle or recover an external command.
        const resource = service.repository.lifecycleReceiptResource(scope, input.mutationId);
        if (!resource) throw new DomainError("not_found", "The lifecycle receipt was not found.");
        this.access.retained(context, [{ kind: resource.resourceKind, id: resource.resourceId, environmentId: resource.environmentId }]);
        this.access.sourceRuntimeAction(context, resource.resourceKind, resource.resourceId);
      };
      authorize();
      const result = await service.lifecycleReceipt(scope, input.mutationId, authorize);
      return { ...result, runtime: presentExecutionRuntime(result.runtime) };
    }
    const action = runtimeAgentActionSchema.parse(operation.slice("runtime.".length));
    const input = runtimeLifecycleInputSchema.parse(value);
    const authorize = () => {
      this.access.revalidate(context, operation, input);
      this.access.sourceRuntimeAction(context, input.resourceKind, input.resourceId);
    };
    authorize();
    const result = await service.lifecycle(scope, { ...input, action }, authorize);
    return { ...result, runtime: presentExecutionRuntime(result.runtime) };
  }
}
