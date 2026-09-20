import type { RequestScope } from "../identity/identity-provider.js";
import {
  ExecutionAttachmentStagingUnavailableError,
  sameRequestScope,
  type ExecutionAttachmentMaterializationRequest,
  type ExecutionAttachmentReleaseRequest,
  type ExecutionAttachmentStager,
} from "./execution-attachment-stager.js";

/** Exact principal/environment routing with no local or first-provider fallback. */
export class CompositeExecutionAttachmentStager
  implements ExecutionAttachmentStager
{
  readonly #scope: RequestScope;
  readonly #providers: Map<string, ExecutionAttachmentStager>;

  constructor(input: {
    readonly scope: RequestScope;
    readonly providers: ReadonlyMap<string, ExecutionAttachmentStager>;
  }) {
    this.#scope = Object.freeze({ ...input.scope });
    this.#providers = new Map(input.providers);
  }

  /** Caller drains users and closes the replaced provider before publication. */
  set(
    scope: RequestScope,
    environmentId: string,
    provider: ExecutionAttachmentStager,
  ): void {
    if (!sameRequestScope(scope, this.#scope))
      throw new ExecutionAttachmentStagingUnavailableError();
    if (!environmentId)
      throw new Error("execution_environment_registry_id_invalid");
    this.#providers.set(environmentId, provider);
  }

  remove(scope: RequestScope, environmentId: string): void {
    if (!sameRequestScope(scope, this.#scope))
      throw new ExecutionAttachmentStagingUnavailableError();
    this.#providers.delete(environmentId);
  }

  supports(scope: RequestScope, environmentId: string): boolean {
    if (!sameRequestScope(scope, this.#scope)) return false;
    return (
      this.#providers.get(environmentId)?.supports(scope, environmentId) ??
      false
    );
  }

  async materialize(
    scope: RequestScope,
    request: ExecutionAttachmentMaterializationRequest,
  ) {
    return await this.#provider(
      scope,
      request.lease.environment.id,
    ).materialize(scope, request);
  }

  async release(
    scope: RequestScope,
    request: ExecutionAttachmentReleaseRequest,
  ) {
    return await this.#provider(scope, request.lease.environment.id).release(
      scope,
      request,
    );
  }

  async close(): Promise<void> {
    await Promise.all(
      [...new Set(this.#providers.values())].map((provider) =>
        provider.close(),
      ),
    );
  }

  #provider(
    scope: RequestScope,
    environmentId: string,
  ): ExecutionAttachmentStager {
    if (!sameRequestScope(scope, this.#scope)) {
      throw new ExecutionAttachmentStagingUnavailableError();
    }
    const provider = this.#providers.get(environmentId);
    if (!provider) throw new ExecutionAttachmentStagingUnavailableError();
    return provider;
  }
}
