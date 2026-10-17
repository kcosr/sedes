import type { AgentToolExecutionAuthorityLease } from "../../events/thread-runtime-coordinator.js";
import type { ClientControlToolService } from "../tools/client-control-tools.js";
import type { TrustedClientTurn } from "../contracts/agent-tool-contracts.js";
import type {
  BackendAgentToolFacade,
  BackendAgentToolInvocationInput,
  BackendAgentToolPolicy,
  TrustedAgentToolSource,
} from "../adapters/backend-facade.js";
import {
  agentToolPresentationPermitsAdapter,
  BackendAgentToolRequestError,
} from "../adapters/backend-facade.js";
import {
  assertAgentToolDescriptionIds,
  CanonicalAgentToolRequestError,
} from "../invocation/canonical-inline-agent-tool-service.js";
import type { CanonicalInlineAgentToolService } from "../invocation/canonical-inline-agent-tool-service.js";
import type { ThreadAgentToolPolicyRepository } from "../../db/repositories/thread-agent-tool-policy-repository.js";
import {
  AgentToolEnvironmentAuthorityResolver,
  createTrustedEnvironmentAuthorityGrant,
  type ResolvedEnvironmentAuthority,
} from "../environment/environment-authority.js";
import type { TrustedAgentToolCallerDefaults } from "../contracts/agent-tool-contracts.js";
import { DomainError } from "../../domain/errors.js";

export interface AgentToolSourceRevalidator {
  resolveInScope(
    scope: TrustedAgentToolSource["scope"],
    sourceThreadId: string,
    signal: AbortSignal,
  ): TrustedAgentToolSource;
}

/** Provider-neutral facade over canonical tools and the live thread policy. */
export class SourceScopedAgentToolService implements BackendAgentToolFacade {
  constructor(
    readonly canonical: CanonicalInlineAgentToolService,
    readonly policies: ThreadAgentToolPolicyRepository,
    readonly environmentAuthority: AgentToolEnvironmentAuthorityResolver,
    readonly sources: AgentToolSourceRevalidator,
    readonly executionAuthority: {
      acquireAgentToolExecutionAuthority(scope: TrustedAgentToolSource["scope"], sourceThreadId: string): Promise<AgentToolExecutionAuthorityLease>;
    },
    readonly clientControls?: ClientControlToolService,
  ) {}

  eligibleCatalog(
    adapter: Parameters<BackendAgentToolFacade["eligibleCatalog"]>[0],
  ) {
    return this.canonical.catalog(adapter, "thread_agent");
  }

  catalogSummaries(
    source: TrustedAgentToolSource,
    adapter: Parameters<BackendAgentToolFacade["catalogSummaries"]>[1],
  ) {
    const policy = this.readPolicy(source);
    if (!this.#permitsDiscovery(policy, source, adapter)) {
      return Object.freeze([]);
    }
    const enabled = new Set(policy.enabledToolIds);
    return Object.freeze(
      this.canonical
        .catalogSummaries(adapter, "thread_agent")
        .filter((tool) => enabled.has(tool.id)),
    );
  }

  describeMany(
    source: TrustedAgentToolSource,
    adapter: Parameters<BackendAgentToolFacade["describeMany"]>[1],
    toolIds: readonly string[],
  ) {
    try {
      assertAgentToolDescriptionIds(toolIds);
    } catch (error) {
      if (error instanceof CanonicalAgentToolRequestError) {
        throw new BackendAgentToolRequestError({
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        });
      }
      throw error;
    }
    const policy = this.readPolicy(source);
    if (!this.#permitsDiscovery(policy, source, adapter)) {
      throw this.#unavailable();
    }
    const enabled = new Set(policy.enabledToolIds);
    if (toolIds.some((toolId) => !enabled.has(toolId))) {
      throw this.#unavailable();
    }
    try {
      return this.canonical.describeMany(adapter, "thread_agent", toolIds);
    } catch (error) {
      if (error instanceof CanonicalAgentToolRequestError) {
        throw new BackendAgentToolRequestError({
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        });
      }
      throw error;
    }
  }

  readPolicy(source: TrustedAgentToolSource): BackendAgentToolPolicy {
    const policy = this.policies.get(source.scope, source.sourceThreadId);
    return Object.freeze({
      enabled: policy.enabled,
      presentation: policy.presentation,
      resourceScope: policy.resourceScope,
      enabledToolIds: policy.enabledToolIds,
    });
  }

  async invoke<Output = unknown>(input: BackendAgentToolInvocationInput) {
    let executionAuthority: AgentToolExecutionAuthorityLease | undefined;
    let sourceAuthority: Awaited<ReturnType<NonNullable<BackendAgentToolInvocationInput["accessDecisionAuthority"]>["acquire"]>> | undefined;
    try {
      const source = this.#resolveSource(input.source, input.signal);
      let admitted = this.#admit(input, source);
      let clientTurn: TrustedClientTurn | undefined;
      if (input.request.toolId.startsWith("client.")) {
        if (!this.clientControls) throw this.#unavailable();
        // Admission binds the normalized turn before any asynchronous provider
        // check. A later turn can invalidate this call, never become its source.
        clientTurn = this.clientControls.capture(source.scope, source.sourceThreadId);
      }
      executionAuthority = await this.executionAuthority.acquireAgentToolExecutionAuthority(source.scope, source.sourceThreadId);
      const executionSignal = AbortSignal.any([input.signal, executionAuthority.signal]);
      executionSignal.throwIfAborted();
      if (!executionAuthority.isCurrent()) throw new CanonicalAgentToolRequestError("cancelled", "The source thread runtime changed.");
      const refreshedSource = this.#resolveSource(input.source, executionSignal);
      admitted = this.#admit(input, refreshedSource);
      if (clientTurn) {
        sourceAuthority = await input.accessDecisionAuthority?.acquire(executionSignal);
        if (sourceAuthority && !sourceAuthority.isCurrent()) throw this.#unavailable();
        admitted = this.#admit(input, this.#resolveSource(input.source, executionSignal));
      }
      return await this.#execute<Output>(
        input,
        source,
        admitted.defaults,
        admitted.policy.revision,
        admitted.resolved,
        admitted.policy.resourceScope,
        sourceAuthority ? AbortSignal.any([executionSignal, sourceAuthority.signal]) : executionSignal,
        clientTurn,
      );
    } catch (error) {
      if (
        (input.signal.aborted || executionAuthority?.signal.aborted || sourceAuthority?.signal.aborted) &&
        !(error instanceof CanonicalAgentToolRequestError)
      ) {
        throw new BackendAgentToolRequestError({
          code: "cancelled",
          message: "The tool invocation was cancelled.",
          retryable: false,
        });
      }
      if (error instanceof CanonicalAgentToolRequestError) {
        throw new BackendAgentToolRequestError({
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        });
      }
      if (error instanceof DomainError) {
        throw new BackendAgentToolRequestError({
          code:
            error.code === "runtime_unavailable"
              ? "unavailable"
              : "internal_error",
          message:
            input.request.toolId.startsWith("client.")
              ? "The originating turn is no longer available for client controls."
              : error.code === "runtime_unavailable"
              ? "The thread is unavailable right now."
              : "The resource access request could not be completed.",
          retryable: error.code === "runtime_unavailable" && error.retryable,
        });
      }
      throw error;
    } finally {
      try {
        sourceAuthority?.release();
      } finally {
        executionAuthority?.release();
      }
    }
  }

  #resolveSource(
    attached: TrustedAgentToolSource,
    signal: AbortSignal,
  ): TrustedAgentToolSource {
    const source = this.sources.resolveInScope(
      attached.scope,
      attached.sourceThreadId,
      signal,
    );
    if (!sameSource(source, attached)) {
      throw new CanonicalAgentToolRequestError(
        "permission_denied",
        "The agent-tool source authority changed.",
      );
    }
    return source;
  }

  #admit(
    input: BackendAgentToolInvocationInput,
    source: TrustedAgentToolSource,
  ) {
    // Deliberately re-read immediately before execution; attach-time policy is
    // presentation state, never invocation authority.
    const policy = this.policies.get(source.scope, source.sourceThreadId);
    const presentationPermitsAdapter = agentToolPresentationPermitsAdapter(
      policy.presentation,
      source.backendKind,
      input.adapter,
    );
    if (
      !policy.enabled ||
      !policy.enabledToolIds.includes(input.request.toolId) ||
      !presentationPermitsAdapter
    ) {
      throw new CanonicalAgentToolRequestError(
        "permission_denied",
        "The tool is not exposed to this thread.",
      );
    }
    const definition = this.canonical.prepareInlineInvocation(
      input.adapter,
      "thread_agent",
      input.request,
    );
    // The caller's project is read live: a location can move between
    // projects while its runtime keeps the source it captured at start.
    const projectId = this.environmentAuthority.reader.resolveWorkspaceProject(
      source.scope,
      source.sourceWorkspaceId,
    );
    if (!projectId) {
      throw new CanonicalAgentToolRequestError(
        "not_found",
        "The source thread was not found.",
      );
    }
    const defaults = Object.freeze({
      kind: "thread_agent" as const,
      environmentId: source.sourceEnvironmentId,
      workspaceId: source.sourceWorkspaceId,
      projectId,
      threadId: source.sourceThreadId,
    });
    return {
      policy,
      definition,
      defaults,
      resolved: this.environmentAuthority.resolve({
        tool: definition,
        input: input.request.input,
        scope: source.scope,
        defaults,
        resourceScope: policy.resourceScope,
        admittedEnvironmentIds: policy.resourceScope.allowOtherEnvironments
          ? this.environmentAuthority.reader.listEnvironments(source.scope).map(({id}) => id)
          : [source.sourceEnvironmentId],
      }),
    };
  }

  #execute<Output>(
    input: BackendAgentToolInvocationInput,
    source: TrustedAgentToolSource,
    defaults: Extract<TrustedAgentToolCallerDefaults, { kind: "thread_agent" }>,
    policyRevision: number,
    resolved: ResolvedEnvironmentAuthority,
    resourceScope: BackendAgentToolPolicy["resourceScope"],
    signal: AbortSignal,
    clientTurn?: TrustedClientTurn,
  ) {
    const environmentAuthority = createTrustedEnvironmentAuthorityGrant({
      ...resolved,
      tool: {
        id: input.request.toolId,
        schemaVersion: input.request.schemaVersion,
      },
      callerKind: "thread_agent",
      defaults,
      policyIdentity: {
        ownerKind: "thread",
        ownerId: source.sourceThreadId,
        revision: policyRevision,
      },
      resourceScope,
      admittedEnvironmentIds: resourceScope.allowOtherEnvironments
        ? this.environmentAuthority.reader.listEnvironments(source.scope).map(({id}) => id)
        : [source.sourceEnvironmentId],
    });
    return this.canonical.invoke<Output>(input.request, {
      scope: source.scope,
      ...(clientTurn ? { clientTurn } : {}),
      environmentAuthority,
      adapter: input.adapter,
      subject: Object.freeze({
        kind: "thread_agent" as const,
        sourceThreadId: source.sourceThreadId,
        backendKind: source.backendKind,
      }),
      defaults: environmentAuthority.defaults,
      policyIdentity: environmentAuthority.policyIdentity,
      signal,
      ...(input.onInvocationStarted
        ? { onInvocationStarted: input.onInvocationStarted }
        : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    });
  }

  #permitsDiscovery(
    policy: BackendAgentToolPolicy,
    source: TrustedAgentToolSource,
    adapter: Parameters<BackendAgentToolFacade["catalogSummaries"]>[1],
  ): boolean {
    // HTTP names the CLI's invocation hop only; discovery is labelled `cli`.
    return (
      policy.enabled &&
      adapter !== "http" &&
      agentToolPresentationPermitsAdapter(
        policy.presentation,
        source.backendKind,
        adapter,
      )
    );
  }

  #unavailable(): BackendAgentToolRequestError {
    return new BackendAgentToolRequestError({
      code: "not_found",
      message: "The requested tool is unavailable.",
      retryable: false,
    });
  }
}

function sameSource(
  left: TrustedAgentToolSource,
  right: TrustedAgentToolSource,
): boolean {
  return (
    left.scope.tenantId === right.scope.tenantId &&
    left.scope.principalId === right.scope.principalId &&
    left.sourceThreadId === right.sourceThreadId &&
    left.sourceWorkspaceId === right.sourceWorkspaceId &&
    left.sourceEnvironmentId === right.sourceEnvironmentId &&
    left.backendKind === right.backendKind
  );
}
