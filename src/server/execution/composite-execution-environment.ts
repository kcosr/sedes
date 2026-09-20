import type { RequestScope } from "../identity/identity-provider.js";
import type {
  ExecutionCommandRequest,
  ExecutionCommandResult,
  ExecutionDirectoryBrowseRequest,
  ExecutionEnvironmentLease,
  ExecutionEnvironmentLeaseRequest,
  ExecutionEnvironmentProvider,
  ExecutionScope,
  ValidatedWorkspace,
} from "./contracts.js";

export interface CompositeExecutionEnvironmentOptions {
  readonly scope: RequestScope;
  readonly environments: ReadonlyMap<string, ExecutionEnvironmentProvider>;
}

function sameScope(left: RequestScope, right: RequestScope): boolean {
  return (
    left.tenantId === right.tenantId && left.principalId === right.principalId
  );
}

/**
 * Principal-scoped exact-ID routing across backend-neutral execution
 * environments. Missing IDs and wrong-scope requests fail closed; there is no
 * default environment or local fallback.
 */
export class CompositeExecutionEnvironment
  implements ExecutionEnvironmentProvider
{
  readonly #scope: RequestScope;
  readonly #environments: Map<string, ExecutionEnvironmentProvider>;

  constructor(options: CompositeExecutionEnvironmentOptions) {
    if ([...options.environments.keys()].some((id) => id.length === 0)) {
      throw new Error("execution_environment_registry_id_invalid");
    }
    this.#scope = options.scope;
    this.#environments = new Map(options.environments);
  }

  /** Reconciliation must fence and retire users of the old provider first. */
  set(
    scope: RequestScope,
    environmentId: string,
    provider: ExecutionEnvironmentProvider,
  ): void {
    if (!sameScope(scope, this.#scope))
      throw new Error("execution_environment_unavailable");
    if (!environmentId)
      throw new Error("execution_environment_registry_id_invalid");
    this.#environments.set(environmentId, provider);
  }

  remove(scope: RequestScope, environmentId: string): void {
    if (!sameScope(scope, this.#scope))
      throw new Error("execution_environment_unavailable");
    this.#environments.delete(environmentId);
  }

  async listEnvironments(scope: ExecutionScope) {
    if (!sameScope(scope, this.#scope)) return [];
    const summaries = await Promise.all(
      [...this.#environments.entries()].map(
        async ([environmentId, provider]) => {
          const available = await provider.listEnvironments(scope);
          if (available.length !== 1 || available[0]?.id !== environmentId) {
            throw new Error("execution_environment_provider_contract_invalid");
          }
          return available[0];
        },
      ),
    );
    return Object.freeze(summaries);
  }

  directoryBrowsingAvailability(
    scope: ExecutionScope,
    environmentId: string,
  ): "available" | "unavailable" {
    try {
      return this.#provider(scope, environmentId).directoryBrowsingAvailability(
        scope,
        environmentId,
      );
    } catch {
      return "unavailable";
    }
  }

  async browseDirectories(
    scope: ExecutionScope,
    request: ExecutionDirectoryBrowseRequest,
  ) {
    const provider = this.#provider(scope, request.environmentId);
    const result = await provider.browseDirectories(scope, request);
    return result;
  }

  async validateWorkspace(
    scope: ExecutionScope,
    environmentId: string,
    candidatePath: string,
  ): Promise<ValidatedWorkspace> {
    const validated = await this.#provider(
      scope,
      environmentId,
    ).validateWorkspace(scope, environmentId, candidatePath);
    this.#assertWorkspaceEnvironment(validated, environmentId);
    return validated;
  }

  async revalidateWorkspace(
    scope: ExecutionScope,
    workspace: ValidatedWorkspace,
  ): Promise<ValidatedWorkspace> {
    const reopened = await this.#provider(
      scope,
      workspace.summary.environmentId,
    ).revalidateWorkspace(scope, workspace);
    this.#assertWorkspaceEnvironment(reopened, workspace.summary.environmentId);
    return reopened;
  }

  async acquireLease(
    scope: ExecutionScope,
    request: ExecutionEnvironmentLeaseRequest,
  ): Promise<ExecutionEnvironmentLease> {
    this.#assertWorkspaceEnvironment(request.workspace, request.environmentId);
    const lease = await this.#provider(
      scope,
      request.environmentId,
    ).acquireLease(scope, request);
    if (
      !sameScope(lease.scope, scope) ||
      lease.environment.id !== request.environmentId ||
      lease.workspace.summary.environmentId !== request.environmentId
    ) {
      await lease.release();
      throw new Error("execution_environment_provider_contract_invalid");
    }
    return lease;
  }

  async executeCommand(
    scope: ExecutionScope,
    request: ExecutionCommandRequest,
  ): Promise<ExecutionCommandResult> {
    this.#assertWorkspaceEnvironment(request.workspace, request.environmentId);
    return await this.#provider(scope, request.environmentId).executeCommand(
      scope,
      request,
    );
  }

  #provider(
    scope: ExecutionScope,
    environmentId: string,
  ): ExecutionEnvironmentProvider {
    if (!sameScope(scope, this.#scope)) {
      throw new Error("execution_environment_unavailable");
    }
    const provider = this.#environments.get(environmentId);
    if (!provider) throw new Error("execution_environment_unavailable");
    return provider;
  }

  #assertWorkspaceEnvironment(
    workspace: ValidatedWorkspace,
    environmentId: string,
  ): void {
    if (workspace.summary.environmentId !== environmentId) {
      throw new Error("execution_environment_provider_contract_invalid");
    }
  }
}
