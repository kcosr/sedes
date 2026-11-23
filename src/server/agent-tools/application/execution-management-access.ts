import type { ConfigurationBackend, ConfigurationEnvironment, ConfigurationTarget } from "../../../shared/protocol/configuration-admin.js";
import { deterministicJson } from "../../canonical-json.js";
import type { ThreadAgentToolPolicyRepository } from "../../db/repositories/thread-agent-tool-policy-repository.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { TrustedToolInvocationContext } from "../contracts/agent-tool-contracts.js";
import { AgentToolEnvironmentAuthorityResolver, assertResourceScope, requireAdmittedEnvironment, requireAdmittedResources, requireExactScopeQuery,
  type AgentToolEnvironmentAuthorityReader, type EnvironmentAuthorityResourceFact, type ResolvedEnvironmentAuthority, type ResolvedEnvironmentResourceRef,
} from "../environment/environment-authority.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-agent-tool-request-error.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";

/** Shared authorization for the delegated administration surface. Authority is
 * authenticated and invocation-bound; resource IDs never choose a principal. */
export class ExecutionManagementAccess {
  constructor(readonly reader: AgentToolEnvironmentAuthorityReader, readonly toolPolicies: Pick<ThreadAgentToolPolicyRepository, "getDurable">) {}

  assertCaller(context: TrustedToolInvocationContext, toolId: string): RequestScope {
    if (context.subject.kind !== "thread_agent" || context.defaults.kind !== "thread_agent" ||
        context.subject.sourceThreadId !== context.defaults.threadId ||
        context.policyIdentity.ownerKind !== "thread" || context.policyIdentity.ownerId !== context.defaults.threadId)
      deny("This management operation requires its exact permission on the source thread.");
    const scope = scopeOf(context);
    const source = this.reader.resolveThread(scope, context.defaults.threadId);
    const projectId = source?.projectId ?? (source?.workspaceId ? this.reader.resolveWorkspaceProject(scope, source.workspaceId) : undefined);
    if (!source || source.environmentId !== context.defaults.environmentId || source.workspaceId !== context.defaults.workspaceId || projectId !== context.defaults.projectId)
      deny("The source thread execution identity changed.");
    const policy = this.toolPolicies.getDurable(scope, context.defaults.threadId);
    const admitted = context.environmentAuthority.resourceScope;
    if (policy.tenantId !== scope.tenantId || policy.ownerPrincipalId !== scope.principalId || policy.applicationThreadId !== context.defaults.threadId ||
        !policy.enabled || !policy.enabledToolIds.includes(toolId) || policy.revision !== context.policyIdentity.revision ||
        !admitted || policy.resourceScope.allowOtherEnvironments !== admitted.allowOtherEnvironments ||
        policy.resourceScope.allowOtherProjects !== admitted.allowOtherProjects)
      deny("The source thread no longer grants this management operation at its admitted policy revision and resource scope.");
    return scope;
  }

  revalidate(context: TrustedToolInvocationContext, toolId: string, input: unknown): ResolvedEnvironmentAuthority {
    const scope = this.assertCaller(context, toolId);
    const tool = CANONICAL_AGENT_TOOL_MANIFEST[toolId as keyof typeof CANONICAL_AGENT_TOOL_MANIFEST];
    if (!tool) deny("The management operation is unavailable.");
    const authority = new AgentToolEnvironmentAuthorityResolver(this.reader).resolve({ tool, input, scope,
      defaults: context.defaults, resourceScope: context.environmentAuthority.resourceScope,
      admittedEnvironmentIds: context.environmentAuthority.admittedEnvironmentIds });
    if (tool.environmentAuthority.kind === "scoped_query" || tool.environmentAuthority.kind === "template_query")
      requireExactScopeQuery(context.environmentAuthority, authority.resolvedResourceRefs);
    else requireAdmittedResources(context.environmentAuthority, authority.resolvedResourceRefs);
    return authority;
  }

  principal(context: TrustedToolInvocationContext): void {
    if (context.defaults.kind !== "thread_agent" || context.environmentAuthority.resourceScope?.allowOtherEnvironments !== true)
      deny("Principal-wide management requires access to other environments.");
  }

  environment(context: TrustedToolInvocationContext, id: string): EnvironmentAuthorityResourceFact {
    const fact = this.reader.resolveConfiguredEnvironment(scopeOf(context), id);
    if (!fact) notFound();
    this.#environmentScope(context, fact.environmentId);
    return fact;
  }

  backend(context: TrustedToolInvocationContext, id: string): EnvironmentAuthorityResourceFact {
    const fact = this.reader.resolveBackend(scopeOf(context), id);
    if (!fact) notFound();
    this.#environmentScope(context, fact.environmentId);
    return fact;
  }

  /** Receipt facts remain authoritative for access checks after definitions are
   * removed. Never re-resolve their identity through a caller-provided pairing. */
  retained(context: TrustedToolInvocationContext, refs: readonly ResolvedEnvironmentResourceRef[]): void {
    if (refs.every(ref => ref.kind === "environment") && context.environmentAuthority.resolvedResourceRefs.some(ref =>
      ref.kind === "principal_management" && ref.id === context.principalId)) {
      // A principal-wide creation grant precedes allocation of the new identity.
      // Its trusted receipt facts may also outlive removal of that identity.
      this.principal(context);
      return;
    }
    requireAdmittedResources(context.environmentAuthority, refs);
  }

  sourceEnvironmentChange(context: TrustedToolInvocationContext, previous: ConfigurationEnvironment, next: ConfigurationEnvironment | undefined): void {
    if (previous.id !== context.defaults.environmentId) return;
    if (!next || !same(without(previous, ["label"]), without(next, ["label"])))
      deny("Only the label of the source environment can be changed by its active agent.");
  }

  sourceBackendChange(context: TrustedToolInvocationContext, previous: ConfigurationBackend, next: ConfigurationBackend | undefined,
    previousTargets: readonly ConfigurationTarget[], nextTargets: readonly ConfigurationTarget[]): void {
    if (previous.id !== this.#sourceBackend(context)) return;
    if (!next || !same(without(previous, ["label", "modelPolicy"]), without(next, ["label", "modelPolicy"])))
      deny("The source backend permits label and model-policy edits only.");
    const targets = (items: readonly ConfigurationTarget[]) => items.filter(item => item.backendInstanceId === previous.id)
      .map(sourceTargetSafetyShape).sort((left, right) => left.id.localeCompare(right.id));
    if (!same(targets(previousTargets), targets(nextTargets)))
      deny("Source backend connections permit model and reasoning defaults only; connection identity, access and permissions must remain unchanged.");
  }

  sourceRuntimeAction(context: TrustedToolInvocationContext, resourceKind: "environment" | "backend", id: string): void {
    if (resourceKind === "environment" ? id === context.defaults.environmentId : id === this.#sourceBackend(context))
      deny("An agent cannot operate the backend or environment carrying its own tool invocation. Use Settings or an agent on another backend.");
  }

  sourceThreadUpdate(context: TrustedToolInvocationContext, id: string): void {
    if (id === context.defaults.threadId) deny("An agent cannot change its own thread's applied tool settings.");
  }

  #environmentScope(context: TrustedToolInvocationContext, environmentId: string): void {
    assertResourceScope([{ kind: "environment", id: environmentId, environmentId }], context.environmentAuthority);
    requireAdmittedEnvironment(context.environmentAuthority, environmentId);
    if (!context.environmentAuthority.targetEnvironmentIds.includes(environmentId))
      deny("The environment was not admitted for this invocation.");
  }

  #sourceBackend(context: TrustedToolInvocationContext): string {
    if (context.defaults.kind !== "thread_agent") deny("The source thread is unavailable.");
    const source = this.reader.resolveThread(scopeOf(context), context.defaults.threadId);
    if (!source?.backendInstanceId || source.environmentId !== context.defaults.environmentId) deny("The source thread execution identity changed.");
    return source.backendInstanceId;
  }
}

function sourceTargetSafetyShape(target: ConfigurationTarget): { id: string; [key: string]: unknown } {
  if (!("moduleConfiguration" in target)) return { ...target };
  const allowed = target.kind === "pi_rpc" ? ["provider", "model", "thinkingLevel"]
    : target.kind === "antigravity_acp" ? ["modelId", "thinkingLevel"]
    : target.kind === "opencode_http" ? ["model", "variant"]
    : target.kind === "grok_acp" ? ["model", "reasoningEffort"]
    : target.kind === "codex_app_server" ? ["model"] : [];
  return { ...target, moduleConfiguration: { ...target.moduleConfiguration, defaults: without(target.moduleConfiguration.defaults, allowed) } };
}
function without(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => !keys.includes(key) && item !== undefined));
}
function same(left: unknown, right: unknown): boolean { return deterministicJson(left) === deterministicJson(right); }
function scopeOf(context: TrustedToolInvocationContext): RequestScope { return { tenantId: context.tenantId, principalId: context.principalId }; }
function deny(message: string): never { throw new CanonicalAgentToolRequestError("permission_denied", message); }
function notFound(): never { throw new CanonicalAgentToolRequestError("not_found", "The requested resource was not found."); }
