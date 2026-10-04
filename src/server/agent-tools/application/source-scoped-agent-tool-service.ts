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
import { deterministicJson } from "../../canonical-json.js";
import {
  AgentToolEnvironmentAuthorityResolver,
  createTrustedEnvironmentAuthorityGrant,
  reachesOutsideEveryEnvironment,
  type ResolvedEnvironmentAuthority,
} from "../environment/environment-authority.js";
import type { TrustedAgentToolCallerDefaults } from "../contracts/agent-tool-contracts.js";
import type {
  ApplicationDecisionPresentation,
  InteractionBroker,
} from "../../conversations/interaction-broker.js";
import type { AgentToolApprovalAuthorityLease } from "../../events/thread-runtime-coordinator.js";
import { DomainError } from "../../domain/errors.js";

export interface AgentToolSourceRevalidator {
  resolveInScope(
    scope: TrustedAgentToolSource["scope"],
    sourceThreadId: string,
    signal: AbortSignal,
  ): TrustedAgentToolSource;
}

export interface AgentToolApprovalAuthorityProvider {
  acquireAgentToolApprovalAuthority(
    scope: TrustedAgentToolSource["scope"],
    sourceThreadId: string,
  ): Promise<AgentToolApprovalAuthorityLease>;
}

export interface AgentToolApprovalRequester {
  requestApplicationDecision: InteractionBroker["requestApplicationDecision"];
}

/** Provider-neutral facade over canonical tools and the live thread policy. */
export class SourceScopedAgentToolService implements BackendAgentToolFacade {
  constructor(
    readonly canonical: CanonicalInlineAgentToolService,
    readonly policies: ThreadAgentToolPolicyRepository,
    readonly environmentAuthority: AgentToolEnvironmentAuthorityResolver,
    readonly sources: AgentToolSourceRevalidator,
    readonly approvalAuthority: AgentToolApprovalAuthorityProvider,
    readonly approvals: AgentToolApprovalRequester,
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
      accessBoundary: policy.accessBoundary,
      enabledToolIds: policy.enabledToolIds,
    });
  }

  async invoke<Output = unknown>(input: BackendAgentToolInvocationInput) {
    let approvalAuthority: AgentToolApprovalAuthorityLease | undefined;
    let sourceAuthority: Awaited<ReturnType<NonNullable<BackendAgentToolInvocationInput["accessDecisionAuthority"]>["acquire"]>> | undefined;
    try {
      const source = this.#resolveSource(input.source, input.signal);
      const admitted = this.#admit(input, source);
      let clientTurn: TrustedClientTurn | undefined;
      if (input.request.toolId.startsWith("client.")) {
        if (!this.clientControls) throw this.#unavailable();
        // Admission binds the normalized turn before any asynchronous provider
        // check. A later turn can invalidate this call, never become its source.
        clientTurn = this.clientControls.capture(source.scope, source.sourceThreadId);
        sourceAuthority = await input.accessDecisionAuthority?.acquire(input.signal);
        if (sourceAuthority && !sourceAuthority.isCurrent()) throw this.#unavailable();
      }
      const needsApproval = admitted.policy.accessBoundary === "thread"
        ? !isWithinSourceThread(admitted.resolved, source.sourceThreadId,
            admitted.definition.environmentAuthority.kind)
        : admitted.policy.accessBoundary === "environment" &&
          (admitted.resolved.targetEnvironmentIds.some(
            (environmentId) => environmentId !== source.sourceEnvironmentId,
          ) ||
            reachesOutsideEveryEnvironment(admitted.resolved));
      if (needsApproval) {
        sourceAuthority ??= await input.accessDecisionAuthority?.acquire(input.signal);
        if (sourceAuthority && !sourceAuthority.isCurrent()) throw new CanonicalAgentToolRequestError(
          "cancelled", "The input authority changed before approval could be requested.");
        approvalAuthority =
          await this.approvalAuthority.acquireAgentToolApprovalAuthority(
            source.scope,
            source.sourceThreadId,
          );
        const signal = AbortSignal.any([
          input.signal,
          approvalAuthority.signal,
          ...(sourceAuthority ? [sourceAuthority.signal] : []),
        ]);
        signal.throwIfAborted();
        let decision;
        try {
          decision = await this.approvals.requestApplicationDecision({
            scope: source.scope,
            applicationThreadId: source.sourceThreadId,
            generation: approvalAuthority.generation,
            presentation: approvalPresentation(
              source,
              admitted.resolved,
              admitted.definition,
              input.request.input,
            ),
            signal,
          });
        } catch (error) {
          if (isAbortError(error)) {
            throw new CanonicalAgentToolRequestError(
              "cancelled",
              "The tool invocation was cancelled.",
            );
          }
          throw error;
        }
        if (decision !== "allow") {
          throw new CanonicalAgentToolRequestError(
            "permission_denied",
            "Access outside the configured boundary was denied.",
          );
        }
        signal.throwIfAborted();
        if (!approvalAuthority.isCurrent() || sourceAuthority && !sourceAuthority.isCurrent()) {
          throw new CanonicalAgentToolRequestError(
            "cancelled",
            "The thread runtime changed while approval was pending.",
          );
        }
        const refreshedSource = this.#resolveSource(input.source, signal);
        if (!sameSource(source, refreshedSource)) {
          throw new CanonicalAgentToolRequestError(
            "permission_denied",
            "The agent-tool source authority changed.",
          );
        }
        const refreshed = this.#admit(input, refreshedSource);
        if (
          refreshed.policy.revision !== admitted.policy.revision ||
          refreshed.resolved.canonicalInputDigest !==
            admitted.resolved.canonicalInputDigest ||
          refreshed.resolved.authorityDigest !==
            admitted.resolved.authorityDigest ||
          definitionApprovalDigest(refreshed.definition) !==
            definitionApprovalDigest(admitted.definition)
        ) {
          throw new CanonicalAgentToolRequestError(
            "permission_denied",
            "The access request changed while approval was pending.",
          );
        }
        return await this.#execute<Output>(
          input,
          refreshedSource,
          refreshed.defaults,
          refreshed.policy.revision,
          refreshed.resolved,
          signal,
          clientTurn,
        );
      }
      return await this.#execute<Output>(
        input,
        source,
        admitted.defaults,
        admitted.policy.revision,
        admitted.resolved,
        sourceAuthority ? AbortSignal.any([input.signal, sourceAuthority.signal]) : input.signal,
        clientTurn,
      );
    } catch (error) {
      if (
        (input.signal.aborted || approvalAuthority?.signal.aborted || sourceAuthority?.signal.aborted) &&
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
              ? "The thread cannot accept another approval request right now."
              : "The access approval request could not be completed.",
          retryable: error.code === "runtime_unavailable" && error.retryable,
        });
      }
      throw error;
    } finally {
      approvalAuthority?.release();
      sourceAuthority?.release();
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
      }),
    };
  }

  #execute<Output>(
    input: BackendAgentToolInvocationInput,
    source: TrustedAgentToolSource,
    defaults: Extract<TrustedAgentToolCallerDefaults, { kind: "thread_agent" }>,
    policyRevision: number,
    resolved: ResolvedEnvironmentAuthority,
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
      admittedEnvironmentIds: [
        source.sourceEnvironmentId,
        ...resolved.targetEnvironmentIds,
      ],
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

function approvalPresentation(
  source: TrustedAgentToolSource,
  resolved: ResolvedEnvironmentAuthority,
  definition: {
    readonly id: string;
    readonly schemaVersion: number;
    readonly catalog: { readonly label: string };
    readonly effects: {
      readonly application: "read" | "write" | "destructive";
      readonly modelUsage: "none" | "agent_execution";
      readonly external: "none" | "durable_side_effect";
    };
  },
  input: unknown,
): ApplicationDecisionPresentation {
  const otherTargetLabels = resolved.targetEnvironmentIds.flatMap(
    (environmentId, index) =>
      environmentId === source.sourceEnvironmentId
        ? []
        : [resolved.display.targetEnvironmentLabels[index] ?? environmentId],
  );
  const outside = reachesOutsideEveryEnvironment(resolved)
    ? ["a project with no active location"]
    : [];
  const targets = [...otherTargetLabels, ...outside].join(", ");
  // A project resource reached through several environments has one ref per
  // environment; name it once.
  const resources = [
    ...new Set(
      resolved.display.resourceLabels.filter(
        (_label, index) =>
          resolved.resolvedResourceRefs[index]?.kind !== "environment",
      ),
    ),
  ].join(", ");
  const consequences = approvalConsequences(definition.effects);
  const argumentsSummary = approvalArgumentSummary(input);
  return {
    sourceLabel: {
      text: bounded(
        resolved.display.defaultEnvironmentLabel ?? source.sourceEnvironmentId,
        256,
      ),
    },
    title: {
      text: bounded(`Allow ${definition.catalog.label}?`, 256),
    },
    message: {
      text: bounded(
        `This tool wants to access ${targets || "resources outside this thread"}${
          resources ? ` for ${resources}` : ""
        }. Arguments: ${argumentsSummary}.${
          consequences.length > 0 ? ` ${consequences.join(" ")}` : ""
        }`,
        4_096,
      ),
    },
    code: {
      text: `${definition.id}@${definition.schemaVersion} · ${effectsLabel(
        definition.effects,
      )}`,
    },
    destructive: definition.effects.application === "destructive",
  };
}

function approvalConsequences(effects: {
  readonly application: "read" | "write" | "destructive";
  readonly modelUsage: "none" | "agent_execution";
  readonly external: "none" | "durable_side_effect";
}): readonly string[] {
  return [
    effects.application === "destructive"
      ? "This can destructively change Sedes application state."
      : undefined,
    effects.modelUsage === "agent_execution"
      ? "This starts model work."
      : undefined,
    effects.external === "durable_side_effect"
      ? "This may create a durable external side effect."
      : undefined,
  ].filter((value): value is string => value !== undefined);
}

const SENSITIVE_ARGUMENT_KEY =
  /(?:authorization|cookie|credential|password|secret|token|api[-_]?key)/i;

/**
 * Keep approval arguments useful without copying arbitrary prompts, names, or
 * other free-form content into an application interaction. Resource IDs and
 * paths are the authority-bearing values a reviewer needs to distinguish.
 */
function approvalArgumentSummary(input: unknown): string {
  return bounded(
    deterministicJson(summarizeApprovalArgument(input, undefined, 0)),
    2_048,
  );
}

function summarizeApprovalArgument(
  value: unknown,
  key: string | undefined,
  depth: number,
): unknown {
  if (depth >= 6) return "[nested value omitted]";
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") {
    if (key && SENSITIVE_ARGUMENT_KEY.test(key)) return "[redacted]";
    if (key === "path" || key?.endsWith("Id")) return bounded(value, 512);
    return `[string:${value.length}]`;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 12)
      .map((item) => summarizeApprovalArgument(item, key, depth + 1))
      .concat(value.length > 12 ? [`[${value.length - 12} more]`] : []);
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return Object.fromEntries(
      entries
        .slice(0, 24)
        .map(([entryKey, entryValue]) => [
          entryKey,
          summarizeApprovalArgument(entryValue, entryKey, depth + 1),
        ])
        .concat(
          entries.length > 24
            ? [["[omitted]", `${entries.length - 24} properties`]]
            : [],
        ),
    );
  }
  return "[unsupported value]";
}

function definitionApprovalDigest(definition: {
  readonly id: string;
  readonly schemaVersion: number;
  readonly catalog: { readonly label: string };
  readonly effects: unknown;
}): string {
  return deterministicJson({
    id: definition.id,
    schemaVersion: definition.schemaVersion,
    label: definition.catalog.label,
    effects: definition.effects,
  });
}

function effectsLabel(effects: {
  readonly application: "read" | "write" | "destructive";
  readonly modelUsage: "none" | "agent_execution";
  readonly external: "none" | "durable_side_effect";
}): string {
  return [
    effects.application,
    effects.modelUsage === "agent_execution" ? "starts model work" : undefined,
    effects.external === "durable_side_effect"
      ? "external side effect"
      : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Empty resource sets are global, except explicitly classified public information. */
function isWithinSourceThread(
  resolved: ResolvedEnvironmentAuthority,
  sourceThreadId: string,
  declarationKind: string,
): boolean {
  if (declarationKind === "public_information") return true;
  return (
    resolved.resolvedResourceRefs.length > 0 &&
    resolved.resolvedResourceRefs.every(
      (resource) =>
        ((resource.kind === "thread" || resource.kind === "thread_family") &&
          resource.id === sourceThreadId) ||
        ((resource.kind === "task" || resource.kind === "workpad") &&
          resource.threadId === sourceThreadId),
    )
  );
}
