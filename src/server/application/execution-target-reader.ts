import type { NormalizedExecutionTargetDescriptor } from "../../shared/protocol/application.js";
import { BACKEND_BRANDS } from "../backends/contracts.js";
import type { AgentBackendRegistry } from "../backends/registry.js";
import type { BackendConfigurationRepository } from "../db/repositories/backend-configuration-repository.js";
import type { ConnectionProfileRecord } from "../db/repositories/backend-configuration-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { boundDisplayText } from "../conversations/payload-policy.js";
import { DomainError } from "../domain/errors.js";
import type { EnvironmentOperations } from "../execution/environment-operations.js";

export type TargetEnvironmentAvailabilityDisposition =
  | "requires_available_environment"
  | "active_preflight";

export interface ExecutionTargetCatalog {
  readonly executionTargets: readonly NormalizedExecutionTargetDescriptor[];
  readonly defaultTargetId: string | null;
}

export interface ExecutionTargetReader {
  read(scope: RequestScope): Promise<ExecutionTargetCatalog>;
  requireSelectable(scope: RequestScope, targetId: string): Promise<void>;
  /** Server-only selection policy; absent test adapters conservatively require the environment channel. */
  environmentAvailabilityDisposition?(
    scope: RequestScope,
    targetId: string,
  ): TargetEnvironmentAvailabilityDisposition;
  /** Agent management distinguishes an owned but unavailable target from absence. */
  requireAgentSelectable?(
    scope: RequestScope,
    targetId: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

/**
 * Projects the complete principal-owned connection-profile catalog. Creation
 * support and live health affect availability, but unavailable targets remain
 * visible so durable thread identity never disappears from inventory.
 */
export class DatabaseExecutionTargetReader implements ExecutionTargetReader {
  readonly #health = new Map<
    string,
    { readonly available: boolean; readonly expiresAt: number }
  >();

  constructor(
    readonly input: {
      readonly configuration: BackendConfigurationRepository;
      readonly registry: AgentBackendRegistry;
      /** Static environment operation contributions; resolving them never starts a sidecar. */
      readonly environmentOperations?: ReadonlyMap<
        string,
        EnvironmentOperations
      >;
      defaultTargetTemplateId: string | null;
      /** Backend instances with a preflighted runtime and admitted network profiles. */
      readonly workspaceIsolationNetworkProfiles?: ReadonlyMap<
        string,
        readonly ("isolated" | "execution_host")[]
      >;
      readonly healthCacheMilliseconds?: number;
      readonly now?: () => number;
      readonly onHealthError?: (
        error: unknown,
        profile: ConnectionProfileRecord,
      ) => void;
    },
  ) {}

  /** Called after configuration/runtime reconciliation; scopes remain in cache keys. */
  invalidateHealth(): void {
    this.#health.clear();
    this.#healthGeneration++;
  }

  setDefaultTargetTemplateId(templateId: string | null): void {
    if (this.input.defaultTargetTemplateId === templateId) return;
    this.input.defaultTargetTemplateId = templateId;
    this.invalidateHealth();
  }

  #healthGeneration = 0;

  async read(scope: RequestScope): Promise<ExecutionTargetCatalog> {
    const executionTargets = (
      await Promise.all(
        this.input.configuration
          .listProfiles(scope)
          .map((profile) => this.#describe(scope, profile)),
      )
    ).sort(
      (left, right) =>
        left.backend.label.text.localeCompare(right.backend.label.text) ||
        left.label.text.localeCompare(right.label.text) ||
        left.id.localeCompare(right.id),
    );
    let defaultProfile: ConnectionProfileRecord | undefined;
    try {
      if (this.input.defaultTargetTemplateId !== null) {
        defaultProfile = this.input.configuration.getProfileByTemplate(
          scope,
          this.input.defaultTargetTemplateId,
        );
      }
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "not_found") {
        throw error;
      }
    }
    return {
      executionTargets,
      defaultTargetId:
        defaultProfile &&
        executionTargets.some(
          ({ id, available }) => id === defaultProfile.id && available,
        )
          ? defaultProfile.id
          : null,
    };
  }

  async requireSelectable(
    scope: RequestScope,
    targetId: string,
  ): Promise<void> {
    let profile: ConnectionProfileRecord;
    try {
      profile = this.input.configuration.getProfile(scope, targetId);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "not_found") {
        throw error;
      }
      throw this.#unavailable();
    }
    if (
      profile.enabled !== 1 ||
      !(await this.#describe(scope, profile, false)).available
    ) {
      throw this.#unavailable();
    }
  }

  environmentAvailabilityDisposition(
    scope: RequestScope,
    targetId: string,
  ): TargetEnvironmentAvailabilityDisposition {
    const profile = this.input.configuration.getProfile(scope, targetId);
    const backend = this.input.configuration.getBackend(
      scope,
      profile.backendInstanceId,
    );
    return this.#environmentDisposition(profile, backend.kind).availability;
  }

  async requireAgentSelectable(
    scope: RequestScope,
    targetId: string,
    signal = new AbortController().signal,
  ): Promise<void> {
    signal.throwIfAborted();
    let profile: ConnectionProfileRecord;
    try {
      profile = this.input.configuration.getProfile(scope, targetId);
    } catch (error) {
      if (error instanceof DomainError && error.code === "not_found") {
        throw new DomainError(
          "not_found",
          "The selected agent target was not found.",
        );
      }
      throw error;
    }
    if (
      profile.enabled !== 1 ||
      !(await this.#describe(scope, profile, false, signal)).available
    ) {
      throw new DomainError(
        "runtime_unavailable",
        "The selected agent target is not currently available for thread creation.",
        true,
      );
    }
  }

  async #describe(
    scope: RequestScope,
    profile: ConnectionProfileRecord,
    useHealthCache = true,
    signal?: AbortSignal,
  ): Promise<NormalizedExecutionTargetDescriptor> {
    const backend = this.input.configuration.getBackend(
      scope,
      profile.backendInstanceId,
    );
    const base = {
      id: profile.id,
      environmentId: profile.executionEnvironmentId,
      label: boundDisplayText(profile.label),
      backend: {
        label: boundDisplayText(backend.label),
        brand: BACKEND_BRANDS[backend.kind],
      },
      workspaceExecution: this.#workspaceExecution(profile, backend.kind),
    } as const;
    if (profile.enabled !== 1) {
      return {
        ...base,
        available: false,
        unavailableReason: boundDisplayText("This target is disabled."),
      };
    }
    if (backend.enabled !== 1) {
      return {
        ...base,
        available: false,
        unavailableReason: boundDisplayText("This backend is disabled."),
      };
    }
    const environmentDisposition = this.#environmentDisposition(
      profile,
      backend.kind,
    );
    if (!environmentDisposition.eligible) {
      return {
        ...base,
        available: false,
        unavailableReason: boundDisplayText(
          "This target is not configured for remote workspace operations.",
        ),
      };
    }
    const connection = {
      ...profile,
      enabled: true,
    } as const;
    let driver;
    try {
      if (!this.input.registry.supportsConversationCreation(connection)) {
        return {
          ...base,
          available: false,
          unavailableReason: boundDisplayText(
            "This target does not support thread creation.",
          ),
        };
      }
      driver = this.input.registry.driver(connection);
    } catch (error) {
      this.input.onHealthError?.(error, profile);
      return {
        ...base,
        available: false,
        unavailableReason: boundDisplayText(
          "This backend runtime is currently unavailable.",
        ),
      };
    }
    const cacheKey = [
      scope.tenantId,
      scope.principalId,
      backend.id,
      backend.configurationRevision,
      profile.id,
      profile.configurationRevision,
    ].join("\0");
    const generation = this.#healthGeneration;
    const now = this.input.now?.() ?? Date.now();
    const cached = this.#health.get(cacheKey);
    let available: boolean;
    if (useHealthCache && cached && cached.expiresAt > now) {
      available = cached.available;
    } else {
      try {
        const health = await driver.health();
        signal?.throwIfAborted();
        available = health.available;
      } catch (error) {
        signal?.throwIfAborted();
        this.input.onHealthError?.(error, profile);
        available = false;
      }
      if (useHealthCache && generation === this.#healthGeneration) {
        this.#health.set(cacheKey, {
          available,
          expiresAt: now + (this.input.healthCacheMilliseconds ?? 5_000),
        });
      }
    }
    if (generation !== this.#healthGeneration) available = false;
    return available
      ? { ...base, available: true }
      : {
          ...base,
          available: false,
          unavailableReason: boundDisplayText(
            "This target is currently unavailable.",
          ),
        };
  }

  #environmentDisposition(
    profile: ConnectionProfileRecord,
    backendKind: "pi" | "codex_app_server" | "claude_agent_sdk" | "grok_build",
  ):
    | Readonly<{
        eligible: true;
        availability: TargetEnvironmentAvailabilityDisposition;
      }>
    | Readonly<{
        eligible: false;
        availability: "requires_available_environment";
      }> {
    const operations = this.input.environmentOperations?.get(
      profile.executionEnvironmentId,
    );
    switch (backendKind) {
      case "pi": {
        if (!operations || operations.environmentKind === "local") {
          return {
            eligible: true,
            availability: "requires_available_environment",
          };
        }
        const supportsRemotePi =
          profile.kind === "pi_sdk" &&
          operations.environmentId === profile.executionEnvironmentId &&
          operations.workspaceTools.availability === "available" &&
          operations.workspaceTools.implementation === "sidecar" &&
          operations.workspaceContext.availability === "available" &&
          operations.workspaceContext.implementation === "sidecar";
        return supportsRemotePi
          ? { eligible: true, availability: "active_preflight" }
          : {
              eligible: false,
              availability: "requires_available_environment",
            };
      }
      case "codex_app_server":
      case "claude_agent_sdk":
      case "grok_build":
        // These compiled backends have no consumer for workspace operations.
        return {
          eligible: true,
          availability: "requires_available_environment",
        };
    }
  }

  #workspaceExecution(
    profile: ConnectionProfileRecord,
    backendKind: "pi" | "codex_app_server" | "claude_agent_sdk" | "grok_build",
  ): NormalizedExecutionTargetDescriptor["workspaceExecution"] {
    const operations = this.input.environmentOperations?.get(
      profile.executionEnvironmentId,
    );
    const isolatedNetworkProfiles =
      this.input.workspaceIsolationNetworkProfiles?.get(
        profile.backendInstanceId,
      );
    if (
      backendKind === "pi" &&
      profile.kind === "pi_sdk" &&
      operations?.environmentKind === "local" &&
      isolatedNetworkProfiles &&
      isolatedNetworkProfiles.length > 0
    ) {
      return {
        kind: "selectable",
        default: { kind: "direct" },
        isolatedNetworkProfiles: [...isolatedNetworkProfiles],
      };
    }
    return { kind: "direct_only" };
  }

  #unavailable(): DomainError {
    return new DomainError(
      "not_found",
      "The selected agent target is not available.",
    );
  }
}
