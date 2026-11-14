import {
  backendAccountUsagesSchema,
  MAXIMUM_BACKEND_ACCOUNT_USAGES,
  type NormalizedBackendAccountUsage,
} from "../../shared/protocol/account-usage.js";
import type { BackendModuleRuntime } from "../backends/module.js";
import type { RequestScope } from "../identity/identity-provider.js";

export interface AccountUsageReader {
  read(scope: RequestScope): readonly NormalizedBackendAccountUsage[];
}

export const NO_ACCOUNT_USAGES: AccountUsageReader = Object.freeze({ read: () => [] });

type AccountUsageRuntime = Pick<BackendModuleRuntime, "scope" | "instance" | "accountUsage">;
type Source = { runtime: AccountUsageRuntime; environmentId: string };

/** Exact-principal projection of backend-owned caches. Reading never polls. */
export class CompositeAccountUsageReader implements AccountUsageReader {
  #sources: Source[] = [];
  readonly #listeners = new Set<() => void>();
  #releases: (() => void)[] = [];

  constructor(readonly input: {
    scope: RequestScope;
    runtimes: ReadonlyMap<string, AccountUsageRuntime>;
    environmentId: (backendInstanceId: string) => string | undefined;
  }) {
    this.replaceRuntimes(input.scope, input.runtimes);
  }

  replaceRuntimes(scope: RequestScope, runtimes: ReadonlyMap<string, AccountUsageRuntime>): void {
    this.#requireScope(scope);
    if (runtimes.size > MAXIMUM_BACKEND_ACCOUNT_USAGES) throw new Error("too_many_account_usage_sources");
    const next = [...runtimes.values()].map(runtime => {
      this.#requireScope(runtime.scope);
      if (runtime.instance.tenantId !== scope.tenantId) throw new Error("account_usage_scope_mismatch");
      const environmentId = this.input.environmentId(runtime.instance.id);
      if (!environmentId) throw new Error("account_usage_environment_missing");
      return { runtime, environmentId };
    }).sort((a, b) => a.runtime.instance.id.localeCompare(b.runtime.instance.id));
    if (next.length === this.#sources.length && next.every((source, index) =>
      source.runtime === this.#sources[index]?.runtime && source.environmentId === this.#sources[index]?.environmentId)) return;
    for (const release of this.#releases) release();
    this.#sources = next;
    this.#releases = this.#listeners.size ? this.#subscribeSources() : [];
    this.#notify();
  }

  read(scope: RequestScope): readonly NormalizedBackendAccountUsage[] {
    this.#requireScope(scope);
    return backendAccountUsagesSchema.parse(this.#sources.flatMap(({ runtime, environmentId }) => {
      const usage = runtime.accountUsage.supported ? runtime.accountUsage.snapshot() : null;
      return usage ? [{ ...usage, backendInstanceId: runtime.instance.id, executionEnvironmentId: environmentId }] : [];
    }));
  }

  subscribe(scope: RequestScope, listener: () => void): () => void {
    this.#requireScope(scope);
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) this.#releases = this.#subscribeSources();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size) return;
      for (const release of this.#releases) release();
      this.#releases = [];
    };
  }

  #subscribeSources(): (() => void)[] {
    return this.#sources.map(({ runtime }) => runtime.accountUsage.subscribe(() => this.#notify()));
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  #requireScope(scope: RequestScope): void {
    if (scope.tenantId !== this.input.scope.tenantId || scope.principalId !== this.input.scope.principalId) {
      throw new Error("account_usage_scope_mismatch");
    }
  }
}
