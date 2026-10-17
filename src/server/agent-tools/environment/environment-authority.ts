import type { AgentToolResourceScope } from "../../../shared/protocol/conversation.js";
import { createHash, randomUUID } from "node:crypto";
import type { RequestScope } from "../../identity/identity-provider.js";
import { deterministicJson } from "../../canonical-json.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-inline-agent-tool-service.js";
import type {
  AgentToolCallerKind,
  TrustedAgentToolCallerDefaults,
  TrustedAgentToolPolicyIdentity,
} from "../contracts/agent-tool-contracts.js";

export type EnvironmentResourceKind =
  | "global"
  | "environment"
  | "workspace"
  | "project"
  | "project_subtree"
  | "thread"
  | "thread_family"
  | "task"
  | "workpad"
  | "saved_agent"
  | "automation";

export type EnvironmentAuthorityDeclaration =
  | { readonly kind: "source_only" }
  | { readonly kind: "public_information" }
  | { readonly kind: "installation_directory" }
  | { readonly kind: "environment_neutral" }
  | {
      readonly kind: "direct_resource";
      readonly resource: "environment" | "workspace" | "thread";
      readonly inputField?: string;
      readonly defaultToSource?: boolean;
      /** An optional project the operation also targets, authorized as a project ref. */
      readonly projectInputField?: string;
    }
  | {
      readonly kind: "direct_resource";
      readonly resource: "thread_family" | "task" | "workpad" | "saved_agent" | "automation";
      readonly inputField?: string;
      readonly defaultToSource?: never;
    }
  | {
      readonly kind: "scoped_query";
      readonly resource: "environment" | "workspace" | "thread" | "task" | "workpad";
    }
  | {
      readonly kind: "scope_transition";
      readonly resource: "workspace" | "task" | "workpad";
      readonly inputField?: string;
      readonly defaultToSource?: boolean;
    };

export interface ResolvedEnvironmentResourceRef {
  readonly kind: EnvironmentResourceKind;
  readonly id: string;
  readonly environmentId?: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly threadId?: string;
  /** Mutable resource generation included when authority depends on it. */
  readonly revision?: number;
  readonly outsideEveryEnvironment?: true;
  readonly label?: string;
}

export interface EnvironmentAuthorityDisplay {
  readonly defaultEnvironmentLabel?: string;
  readonly targetEnvironmentLabels: readonly string[];
  readonly resourceLabels: readonly string[];
}

export interface ResolvedEnvironmentAuthority {
  readonly canonicalInputDigest: string;
  readonly authorityDigest: string;
  readonly targetEnvironmentIds: readonly string[];
  readonly resolvedResourceRefs: readonly ResolvedEnvironmentResourceRef[];
  readonly display: EnvironmentAuthorityDisplay;
}

export interface TrustedEnvironmentAuthorityGrant extends ResolvedEnvironmentAuthority {
  readonly id: string;
  readonly callerKind: AgentToolCallerKind;
  readonly defaults: TrustedAgentToolCallerDefaults;
  readonly policyIdentity: TrustedAgentToolPolicyIdentity;
  readonly admittedEnvironmentIds: readonly string[];
  readonly resourceScope?: AgentToolResourceScope;
}

export interface EnvironmentAuthorityResourceFact {
  readonly id: string;
  readonly threadId?: string;
  readonly environmentId: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly label?: string;
}

export interface EnvironmentAuthorityTaskFact {
  readonly id: string;
  readonly revision: number;
  readonly scopeKind: "global" | "project" | "thread";
  /** The environment of a thread-scoped resource's thread. */
  readonly environmentId?: string;
  readonly projectId?: string;
  readonly threadId?: string;
  readonly label?: string;
}

/**
 * An active project. Its member environments are those hosting one of its
 * active locations; every location edit advances the membership revision.
 */
export interface EnvironmentAuthorityProjectFact {
  readonly id: string;
  readonly membershipRevision: number;
  /** Distinct and sorted. Empty when the project has no active location. */
  readonly memberEnvironmentIds: readonly string[];
  readonly label?: string;
}

/** Bounded application/configuration facts only; implementations must not attach providers or probe paths. */
export interface AgentToolEnvironmentAuthorityReader {
  resolveEnvironment(
    scope: RequestScope,
    id: string,
  ): EnvironmentAuthorityResourceFact | undefined;
  resolveWorkspace(
    scope: RequestScope,
    id: string,
  ): EnvironmentAuthorityResourceFact | undefined;
  resolveThread(
    scope: RequestScope,
    id: string,
  ): EnvironmentAuthorityResourceFact | undefined;
  resolveAutomation(
    scope: RequestScope,
    id: string,
  ):
    | (EnvironmentAuthorityResourceFact & { readonly threadId: string })
    | undefined;
  resolveThreadFamily(
    scope: RequestScope,
    id: string,
  ): readonly EnvironmentAuthorityResourceFact[] | undefined;
  resolveTask(
    scope: RequestScope,
    id: string,
  ): EnvironmentAuthorityTaskFact | undefined;
  resolveSavedAgent(
    scope: RequestScope,
    id: string,
  ):
    | { readonly id: string; readonly revision: number; readonly label?: string;
      } | undefined;
  resolveWorkpad(
    scope: RequestScope,
    id: string,
  ): EnvironmentAuthorityTaskFact | undefined;
  /** Undefined when the project does not exist or was removed. */
  resolveProject(
    scope: RequestScope,
    id: string,
  ): EnvironmentAuthorityProjectFact | undefined;
  /** The project of an active location; undefined when it was removed. */
  resolveWorkspaceProject(
    scope: RequestScope,
    workspaceId: string,
  ): string | undefined;
  listEnvironments(
    scope: RequestScope,
  ): readonly EnvironmentAuthorityResourceFact[];
}

export interface ResolveEnvironmentAuthorityInput {
  readonly tool: {
    readonly id: string;
    readonly schemaVersion: number;
    readonly environmentAuthority: EnvironmentAuthorityDeclaration;
  };
  readonly input: unknown;
  readonly scope: RequestScope;
  readonly defaults: TrustedAgentToolCallerDefaults;
  /** Exact pre-authorized set for callers that cannot request an interaction. */
  readonly admittedEnvironmentIds?: readonly string[];
  readonly resourceScope?: AgentToolResourceScope;
}

export class AgentToolEnvironmentAuthorityResolver {
  constructor(readonly reader: AgentToolEnvironmentAuthorityReader) {}

  resolve(
    request: ResolveEnvironmentAuthorityInput,
  ): ResolvedEnvironmentAuthority {
    requireThreadResourceScope(request);
    const canonicalInputDigest = digest(request.input);
    const refs = [...this.#resolveRefs(request)];
    // Updates may also resolve an authoring workspace; retain both authorities.
    const input = inputObject(request.input);
    if (
      request.tool.environmentAuthority.kind === "scope_transition" &&
      request.tool.environmentAuthority.resource === "workspace" &&
      typeof input.agentId === "string"
    ) {
      refs.push({
        kind: "saved_agent",
        ...required(this.reader.resolveSavedAgent(request.scope, input.agentId),
        ),
      });
    }
    const identifiedRefs = refs.map(ref => {
      const workspaceId = ref.kind === "workspace" ? ref.id : ref.workspaceId ??
        (ref.threadId && !ref.projectId
          ? this.reader.resolveThread(request.scope, ref.threadId)?.workspaceId : undefined);
      const projectId = ref.kind === "project" || ref.kind === "project_subtree" ? ref.id : ref.projectId ??
        ((ref.kind === "thread" && ref.id === request.defaults.threadId) ? request.defaults.projectId : undefined) ??
        (workspaceId ? this.reader.resolveWorkspaceProject(request.scope, workspaceId) : undefined);
      return {...ref, ...(projectId ? {projectId} : {})};
    });
    const isQuery = request.tool.environmentAuthority.kind === "scoped_query" ||
      request.tool.environmentAuthority.kind === "installation_directory";
    const resolvedResourceRefs = uniqueSortedRefs(isQuery
      ? filterResourceScopeRefs(identifiedRefs, request)
      : identifiedRefs);
    if (!isQuery) assertResourceScope(identifiedRefs, request);
    const targetEnvironmentIds = Object.freeze(
      [
        ...new Set(
          resolvedResourceRefs.flatMap((ref) =>
            ref.environmentId ? [ref.environmentId] : [],
          ),
        ),
      ].sort(),
    );
    const environments = this.reader.listEnvironments(request.scope);
    const labels = new Map(
      environments.map((environment) => [
        environment.id,
        environment.label ?? environment.id,
      ]),
    );
    const display = Object.freeze({
      defaultEnvironmentLabel: labels.get(request.defaults.environmentId),
      targetEnvironmentLabels: Object.freeze(
        targetEnvironmentIds.map((id) => labels.get(id) ?? id),
      ),
      resourceLabels: Object.freeze(
        resolvedResourceRefs.map((ref) => ref.label ?? ref.id),
      ),
    });
    const authorityDigest = digest({
      tool: { id: request.tool.id, schemaVersion: request.tool.schemaVersion },
      defaults: request.defaults,
      targetEnvironmentIds,
      resolvedResourceRefs: resolvedResourceRefs.map(
        ({ kind, id, environmentId, projectId, workspaceId, threadId, revision, outsideEveryEnvironment }) => ({
          kind,
          id,
          ...(environmentId ? { environmentId } : {}),
          ...(projectId ? { projectId } : {}),
          ...(workspaceId ? { workspaceId } : {}),
          ...(threadId ? { threadId } : {}),
          ...(revision !== undefined ? { revision } : {}),
          ...(outsideEveryEnvironment ? {outsideEveryEnvironment} : {}),
        }),
      ),
    });
    return Object.freeze({
      canonicalInputDigest,
      authorityDigest,
      targetEnvironmentIds,
      resolvedResourceRefs,
      display,
    });
  }

  #resolveRefs(
    request: ResolveEnvironmentAuthorityInput,
  ): readonly ResolvedEnvironmentResourceRef[] {
    const declaration = request.tool.environmentAuthority;
    if (declaration.kind === "source_only") {
      return [
        resourceRef("thread", {
          id: requiredDefaultThreadId(request),
          environmentId: request.defaults.environmentId,
        }),
      ];
    }
    if (
      declaration.kind === "public_information" ||
      declaration.kind === "environment_neutral"
    )
      return [];
    if (declaration.kind === "installation_directory") return request.defaults.kind === "principal_client" ? [] : allowedEnvironments(request, this.reader).map(fact => resourceRef("environment", fact));
    if (declaration.kind === "direct_resource")
      return this.#direct(request, declaration);
    if (declaration.kind === "scoped_query")
      return this.#query(request, declaration.resource);
    return this.#transition(request, declaration.resource);
  }

  #direct(
    request: ResolveEnvironmentAuthorityInput,
    declaration: Extract<
      EnvironmentAuthorityDeclaration,
      { kind: "direct_resource" }
    >,
  ): readonly ResolvedEnvironmentResourceRef[] {
    const object = inputObject(request.input);
    const inputField = declaration.inputField ?? `${declaration.resource}Id`;
    const supplied = inputField.split(".").reduce<unknown>((value, key) =>
      value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined, object,
      );
    const sourceDefault = declaration.defaultToSource
      ? declaration.resource === "environment"
        ? request.defaults.environmentId
        : declaration.resource === "workspace"
          ? request.defaults.workspaceId
          : declaration.resource === "thread"
            ? request.defaults.threadId
            : undefined
      : undefined;
    const id = typeof supplied === "string" ? supplied : sourceDefault;
    if (!id) {
      if (declaration.defaultToSource) return invalidContext();
      return deny();
    }
    if (declaration.resource === "environment") {
      const projectId = declaration.projectInputField
        ? object[declaration.projectInputField]
        : undefined;
      return [
        resourceRef(
          "environment",
          required(this.reader.resolveEnvironment(request.scope, id)),
        ),
        ...(typeof projectId === "string"
          ? projectScopeRefs(
              required(this.reader.resolveProject(request.scope, projectId)),
              request,
              "exact",
            )
          : []),
      ];
    }
    if (declaration.resource === "workspace")
      return [
        resourceRef(
          "workspace",
          required(this.reader.resolveWorkspace(request.scope, id)),
        ),
      ];
    if (declaration.resource === "thread")
      return [
        resourceRef(
          "thread",
          required(this.reader.resolveThread(request.scope, id)),
        ),
      ];
    if (declaration.resource === "automation") {
      const fact = required(this.reader.resolveAutomation(request.scope, id));
      return [resourceRef("automation", fact)];
    }
    if (declaration.resource === "thread_family") {
      if (object.includeDescendants !== true) {
        return [
          resourceRef(
            "thread",
            required(this.reader.resolveThread(request.scope, id)),
          ),
        ];
      }
      const family = required(
        this.reader.resolveThreadFamily(request.scope, id),
      );
      const environmentIds = new Set(
        family.map(({ environmentId }) => environmentId),
      );
      const workspaceIds = new Set(
        family.map(({ workspaceId }) => workspaceId),
      );
      if (
        environmentIds.size !== 1 ||
        workspaceIds.size !== 1 ||
        workspaceIds.has(undefined)
      )
        return deny();
      return family.map((fact) => resourceRef("thread_family", fact));
    }
    if (declaration.resource === "saved_agent") {
      const fact = required(this.reader.resolveSavedAgent(request.scope, id));
      return [{ kind: "saved_agent", ...fact }];
    }
    return this.#taskRefs(
      required(declaration.resource === "workpad" ? this.reader.resolveWorkpad(request.scope, id) : this.reader.resolveTask(request.scope, id),
      ),
      request,
      declaration.resource,
    );
  }

  #query(
    request: ResolveEnvironmentAuthorityInput,
    resource: Extract<
      EnvironmentAuthorityDeclaration,
      { kind: "scoped_query" }
    >["resource"],
  ): readonly ResolvedEnvironmentResourceRef[] {
    const input = inputObject(request.input);
    if (resource === "workspace") {
      const scope = inputObject(input.scope ?? { kind: "default_environment" });
      if (scope.kind === "default_environment")
        return [
          resourceRef("environment", {
            id: request.defaults.environmentId,
            environmentId: request.defaults.environmentId,
          }),
        ];
      if (
        scope.kind === "environment" &&
        typeof scope.environmentId === "string"
      )
        return [
          resourceRef(
            "environment",
            required(
              this.reader.resolveEnvironment(
                request.scope,
                scope.environmentId,
              ),
            ),
          ),
        ];
      if (scope.kind === "all_allowed_environments")
        return allowedEnvironments(request, this.reader).map((fact) =>
          resourceRef("environment", fact),
        );
      return deny();
    }
    if (resource === "thread") {
      const scope = inputObject(input.scope ?? { kind: "default_environment" });
      if (scope.kind === "default_environment")
        return [
          resourceRef("environment", {
            id: request.defaults.environmentId,
            environmentId: request.defaults.environmentId,
          }),
        ];
      if (scope.kind === "default_workspace")
        return [
          resourceRef("workspace", {
            id: requiredDefaultWorkspaceId(request),
            environmentId: request.defaults.environmentId,
          }),
        ];
      if (scope.kind === "workspace" && typeof scope.workspaceId === "string")
        return [
          resourceRef(
            "workspace",
            required(
              this.reader.resolveWorkspace(request.scope, scope.workspaceId),
            ),
          ),
        ];
      if (scope.kind === "all_allowed_environments")
        return allowedEnvironments(request, this.reader).map((fact) =>
          resourceRef("environment", fact),
        );
      return deny();
    }
    if (resource === "task" || resource === "workpad") return this.#taskQuery(request);
    return this.reader
      .listEnvironments(request.scope)
      .map((fact) => resourceRef("environment", fact));
  }

  #taskQuery(
    request: ResolveEnvironmentAuthorityInput,
  ): readonly ResolvedEnvironmentResourceRef[] {
    const input = inputObject(request.input);
    const scope = inputObject(input.scope);
    if (scope.kind === "global") {
      return input.scopeMode === "subtree"
        ? allowedEnvironments(request, this.reader).map((fact) =>
            resourceRef("environment", fact),
          )
        : [];
    }
    if (scope.kind === "project")
      return projectScopeRefs(
        required(
          this.reader.resolveProject(
            request.scope,
            typeof scope.projectId === "string"
              ? scope.projectId
              : requiredDefaultProjectId(request),
          ),
        ),
        request,
        input.scopeMode === "subtree" ? "subtree" : "exact",
      );
    if (scope.kind === "thread")
      return [
        resourceRef(
          "thread",
          required(
            this.reader.resolveThread(
              request.scope,
              typeof scope.threadId === "string"
                ? scope.threadId
                : requiredDefaultThreadId(request),
            ),
          ),
        ),
      ];
    return deny();
  }

  #taskRefs(
    task: EnvironmentAuthorityTaskFact,
    request: ResolveEnvironmentAuthorityInput,
    kind: "task" | "workpad",
  ): readonly ResolvedEnvironmentResourceRef[] {
    return scopedResourceRefs(
      kind,
      task,
      task.scopeKind === "project"
        ? required(this.reader.resolveProject(request.scope, task.projectId!))
        : undefined,
      request,
    );
  }

  #transition(
    request: ResolveEnvironmentAuthorityInput,
    resource: "workspace" | "task" | "workpad",
  ): readonly ResolvedEnvironmentResourceRef[] {
    const input = inputObject(request.input);
    if (resource === "workspace") {
      const declaration = request.tool.environmentAuthority;
      if (declaration.kind !== "scope_transition") return deny();
      const workspaceId =
        readStringPath(input, declaration.inputField) ??
        authoringWorkspaceId(input) ??
        (declaration.defaultToSource === false
          ? undefined
          : request.defaults.workspaceId);
      if (!workspaceId) {
        if (declaration.defaultToSource === false) return [];
        return invalidContext();
      }
      return [
        resourceRef(
          "workspace",
          required(this.reader.resolveWorkspace(request.scope, workspaceId)),
        ),
      ];
    }
    const refs: ResolvedEnvironmentResourceRef[] = [];
    const resourceId = input[`${resource}Id`];
    if (typeof resourceId === "string")
      refs.push(
        ...this.#taskRefs(
          required(resource === "workpad" ? this.reader.resolveWorkpad(request.scope, resourceId) : this.reader.resolveTask(request.scope, resourceId),
          ),
          request,
          resource,
        ),
      );
    if (input.scope !== undefined)
      refs.push(...scopeRefs(request, inputObject(input.scope), this.reader));
    return refs;
  }
}

export function createTrustedEnvironmentAuthorityGrant(
  input: ResolvedEnvironmentAuthority & {
    readonly tool: { readonly id: string; readonly schemaVersion: number };
    readonly callerKind: AgentToolCallerKind;
    readonly defaults: TrustedAgentToolCallerDefaults;
    readonly policyIdentity: TrustedAgentToolPolicyIdentity;
    readonly admittedEnvironmentIds: readonly string[];
    readonly resourceScope?: AgentToolResourceScope;
  },
): TrustedEnvironmentAuthorityGrant {
  requireThreadResourceScope(input);
  const targetEnvironmentIds = Object.freeze([...input.targetEnvironmentIds]);
  const resolvedResourceRefs = Object.freeze(
    input.resolvedResourceRefs.map((ref) => Object.freeze({ ...ref })),
  );
  const defaults = Object.freeze({ ...input.defaults });
  const policyIdentity = Object.freeze({ ...input.policyIdentity });
  const admittedEnvironmentIds = Object.freeze(
    [...new Set(input.admittedEnvironmentIds)].sort(),
  );
  const display = Object.freeze({
    ...input.display,
    targetEnvironmentLabels: Object.freeze([
      ...input.display.targetEnvironmentLabels,
    ]),
    resourceLabels: Object.freeze([...input.display.resourceLabels]),
  });
  const authorityDigest = digest({
    tool: input.tool,
    canonicalInputDigest: input.canonicalInputDigest,
    callerKind: input.callerKind,
    defaults,
    policyIdentity,
    admittedEnvironmentIds,
    ...(input.resourceScope ? {resourceScope: input.resourceScope} : {}),
    targetEnvironmentIds,
    resolvedResourceRefs: resolvedResourceRefs.map(
      ({ kind, id, environmentId, projectId, workspaceId, threadId, revision, outsideEveryEnvironment }) => ({
        kind,
        id,
        ...(environmentId ? { environmentId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(threadId ? { threadId } : {}),
        ...(revision !== undefined ? { revision } : {}),
        ...(outsideEveryEnvironment ? {outsideEveryEnvironment} : {}),
      }),
    ),
  });
  return Object.freeze({
    canonicalInputDigest: input.canonicalInputDigest,
    authorityDigest,
    callerKind: input.callerKind,
    defaults,
    policyIdentity,
    admittedEnvironmentIds,
    ...(input.resourceScope ? { resourceScope: Object.freeze({...input.resourceScope}) } : {}),
    targetEnvironmentIds,
    resolvedResourceRefs,
    display,
    id: randomUUID(),
  });
}

/**
 * Stable authority identity for continuations whose next request necessarily
 * has different canonical input. This excludes the invocation id, input
 * digest, and labels while retaining the tool schema and every caller, policy,
 * environment, and resolved-resource fact that grants access.
 */
export function environmentAuthorityContinuationDigest(
  grant: TrustedEnvironmentAuthorityGrant,
  tool: { readonly id: string; readonly schemaVersion: number },
): string {
  return digest({
    tool: { id: tool.id, schemaVersion: tool.schemaVersion },
    callerKind: grant.callerKind,
    defaults: grant.defaults,
    policyIdentity: grant.policyIdentity,
    admittedEnvironmentIds: grant.admittedEnvironmentIds,
    ...(grant.resourceScope ? {resourceScope: grant.resourceScope} : {}),
    targetEnvironmentIds: grant.targetEnvironmentIds,
    resolvedResourceRefs: grant.resolvedResourceRefs.map(
      ({ kind, id, environmentId, projectId, workspaceId, threadId, revision, outsideEveryEnvironment }) => ({
        kind,
        id,
        ...(environmentId ? { environmentId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(threadId ? { threadId } : {}),
        ...(revision !== undefined ? { revision } : {}),
        ...(outsideEveryEnvironment ? {outsideEveryEnvironment} : {}),
      }),
    ),
  });
}

export function requireAdmittedEnvironment(
  grant: TrustedEnvironmentAuthorityGrant,
  environmentId: string,
): void {
  requireThreadResourceScope(grant);
  if (!grant.admittedEnvironmentIds.includes(environmentId)) deny();
}

export function requireAdmittedResource(
  grant: TrustedEnvironmentAuthorityGrant,
  resource: ResolvedEnvironmentResourceRef,
): void {
  assertResourceScope([resource], grant);
  requireAdmittedEnvironment(
    grant,
    resource.environmentId ?? grant.defaults.environmentId,
  );
  if (
    !grant.resolvedResourceRefs.some(
      (candidate) =>
        candidate.kind === resource.kind &&
        candidate.id === resource.id &&
        candidate.environmentId === resource.environmentId &&
        candidate.workspaceId === resource.workspaceId &&
        (resource.projectId === undefined || candidate.projectId === resource.projectId) &&
        candidate.revision === resource.revision,
    )
  )
    deny();
}

function scopeRefs(
  request: ResolveEnvironmentAuthorityInput,
  scope: Record<string, unknown>,
  reader: AgentToolEnvironmentAuthorityReader,
): readonly ResolvedEnvironmentResourceRef[] {
  if (scope.kind === "global") return [{ kind: "global", id: "global" }];
  if (scope.kind === "project")
    return projectScopeRefs(
      required(
        reader.resolveProject(
          request.scope,
          typeof scope.projectId === "string"
            ? scope.projectId
            : requiredDefaultProjectId(request),
        ),
      ),
      request,
      "exact",
    );
  if (scope.kind === "thread")
    return [
      resourceRef(
        "thread",
        required(
          reader.resolveThread(
            request.scope,
            typeof scope.threadId === "string"
              ? scope.threadId
              : requiredDefaultThreadId(request),
          ),
        ),
      ),
    ];
  return deny();
}

/** Who reaches a project, and through which pre-authorized environments. */
export interface ProjectAccessCaller {
  readonly defaults: TrustedAgentToolCallerDefaults;
  /** Tool-client allowlist or the environments admitted by the thread policy. */
  readonly admittedEnvironmentIds?: readonly string[];
  readonly resourceScope?: AgentToolResourceScope;
}

/** The caller facts an admitted grant was resolved with. */
export function grantProjectAccessCaller(
  grant: TrustedEnvironmentAuthorityGrant,
): ProjectAccessCaller {
  return grant.callerKind === "principal_client"
    ? {
        defaults: grant.defaults,
        admittedEnvironmentIds: grant.admittedEnvironmentIds,
      }
    : { defaults: grant.defaults, resourceScope: grant.resourceScope, admittedEnvironmentIds: grant.admittedEnvironmentIds };
}

/**
 * A thread with cross-environment access disabled reaches shared project
 * records through an active location on its own environment. Cross-environment
 * access removes that location restriction. Tool clients retain their explicit
 * allowlists: exact access needs one member; subtrees name every member.
 */
export function projectAccessEnvironmentIds(
  project: EnvironmentAuthorityProjectFact,
  caller: ProjectAccessCaller,
  mode: "exact" | "subtree",
): readonly string[] {
  const members = [...new Set(project.memberEnvironmentIds)].sort();
  if (caller.defaults.kind === "thread_agent") {
    requireThreadResourceScope(caller);
    if (caller.resourceScope!.allowOtherEnvironments) return [];
    // Keep inaccessible references for admission to deny, or query resolution
    // to filter. A shared project spanning hosts needs only the local member.
    return members.includes(caller.defaults.environmentId)
      ? [caller.defaults.environmentId]
      : members;
  }
  if (members.length === 0) {
    return deny();
  }
  if (mode === "subtree") return members;
  if (members.includes(caller.defaults.environmentId))
    return [caller.defaults.environmentId];
  const allowed = members.filter((environmentId) =>
    caller.admittedEnvironmentIds?.includes(environmentId),
  );
  return allowed.length > 0 ? [allowed[0]!] : deny();
}

/** Membership changes invalidate an admitted project reference before execution. */
export function projectScopeRefs(
  project: EnvironmentAuthorityProjectFact,
  caller: ProjectAccessCaller,
  mode: "exact" | "subtree",
): readonly ResolvedEnvironmentResourceRef[] {
  const base = {
    kind: mode === "subtree" ? "project_subtree" as const : "project" as const,
    id: project.id,
    revision: project.membershipRevision,
    projectId: project.id,
    ...(project.memberEnvironmentIds.length === 0 ? {outsideEveryEnvironment:true as const} : {}),
    ...(project.label ? { label: project.label } : {}),
  };
  const environmentIds = projectAccessEnvironmentIds(project, caller, mode);
  return environmentIds.length === 0
    ? [base]
    : environmentIds.map((environmentId) => ({ ...base, environmentId }));
}

/** Whether a resolution reaches a project that has no active location. */
export function reachesOutsideEveryEnvironment(authority: {
  readonly resolvedResourceRefs: readonly ResolvedEnvironmentResourceRef[];
}): boolean {
  return authority.resolvedResourceRefs.some(
    (ref) => ref.outsideEveryEnvironment === true,
  );
}

/**
 * Refs for one Task or Workpad in its current scope. A project resource is
 * reached through its project's access environments and also binds the
 * project's membership revision.
 */
export function scopedResourceRefs(
  kind: "task" | "workpad",
  resource: EnvironmentAuthorityTaskFact,
  project: EnvironmentAuthorityProjectFact | undefined,
  caller: ProjectAccessCaller,
): readonly ResolvedEnvironmentResourceRef[] {
  const base = {
    kind,
    id: resource.id,
    revision: resource.revision,
    ...(resource.label ? { label: resource.label } : {}),
  };
  if (resource.scopeKind === "global") return [base];
  if (resource.scopeKind === "project") {
    if (!project || project.id !== resource.projectId) return unavailable();
    const projectRefs = projectScopeRefs(project, caller, "exact");
    return [
      ...projectRefs.map(({ environmentId }) => ({
        ...base,
        projectId: project.id,
        ...(environmentId ? { environmentId } : {}),
      })),
      ...projectRefs,
    ];
  }
  const environmentId =
    resource.environmentId ??
    (resource.threadId === caller.defaults.threadId
      ? caller.defaults.environmentId
      : undefined);
  if (!environmentId) return deny();
  return [
    {
      ...base,
      ...(resource.threadId ? { threadId: resource.threadId } : {}),
      ...(resource.projectId ? { projectId: resource.projectId } : {}),
      environmentId,
    },
  ];
}

/**
 * Refs for a Task or Workpad as its current scope requires them now. A
 * removed project is not found.
 */
export function currentScopedResourceRefs(
  reader: AgentToolEnvironmentAuthorityReader,
  scope: RequestScope,
  kind: "task" | "workpad",
  id: string,
  caller: ProjectAccessCaller,
): readonly ResolvedEnvironmentResourceRef[] {
  const resource = required(
    kind === "workpad"
      ? reader.resolveWorkpad(scope, id)
      : reader.resolveTask(scope, id),
  );
  return scopedResourceRefs(
    kind,
    resource.scopeKind === "thread" && resource.threadId ? {...resource, projectId: resource.projectId ?? (() => {const thread = reader.resolveThread(scope, resource.threadId!); return thread?.workspaceId ? reader.resolveWorkspaceProject(scope, thread.workspaceId) : undefined;})()} : resource,
    resource.scopeKind === "project"
      ? required(reader.resolveProject(scope, resource.projectId!))
      : undefined,
    caller,
  );
}

/**
 * Refs a Task or Workpad scope requires now, as a destination (exact) or as
 * a list query. A global subtree spans every environment.
 */
export function scopeAuthorityRefs(
  reader: AgentToolEnvironmentAuthorityReader,
  scope: RequestScope,
  target:
    | { readonly kind: "global" }
    | { readonly kind: "project"; readonly projectId: string }
    | { readonly kind: "thread"; readonly threadId: string },
  caller: ProjectAccessCaller,
  mode: "exact" | "subtree",
): readonly ResolvedEnvironmentResourceRef[] {
  switch (target.kind) {
    case "global":
      return mode === "exact"
        ? []
        : reader
            .listEnvironments(scope)
            .map((fact) => resourceRef("environment", fact));
    case "project":
      return projectScopeRefs(
        required(reader.resolveProject(scope, target.projectId)),
        caller,
        mode,
      );
    case "thread":
      return [
        resourceRef("thread", (() => {const fact = required(reader.resolveThread(scope, target.threadId)); return {...fact, projectId: fact.projectId ?? (fact.workspaceId ? reader.resolveWorkspaceProject(scope, fact.workspaceId) : undefined)};})(),
        ),
      ];
  }
}

/**
 * Rechecks at execution that a list query was admitted with exactly the
 * environments and refs its scope needs now, so a missing or narrower grant
 * never falls back to a wider query.
 */
export function requireExactScopeQuery(
  grant: TrustedEnvironmentAuthorityGrant,
  refs: readonly ResolvedEnvironmentResourceRef[],
): void {
  requireThreadResourceScope(grant);
  refs = filterResourceScopeRefs(refs, grant);
  const environmentIds = [
    ...new Set(refs.flatMap(({ environmentId }) =>
        environmentId ? [environmentId] : [],
      ),
    ),
  ].sort();
  if (
    environmentIds.length !== grant.targetEnvironmentIds.length ||
    environmentIds.some((id, index) => id !== grant.targetEnvironmentIds[index])
  ) {
    throw new CanonicalAgentToolRequestError(
      "not_found",
      "The target environments no longer match the query scope.",
    );
  }
  const expectedResources = refs.filter(({kind}) => kind !== "environment");
  const admittedResources = grant.resolvedResourceRefs.filter(({kind}) => kind !== "environment");
  if (expectedResources.length !== admittedResources.length) {
    throw new CanonicalAgentToolRequestError("permission_denied", "The query scope does not match the admitted resource scope.");
  }
  requireAdmittedResources(grant, expectedResources);
}

/** Rechecks freshly resolved refs against an admitted grant at execution. */
export function requireAdmittedResources(
  grant: TrustedEnvironmentAuthorityGrant,
  resources: readonly ResolvedEnvironmentResourceRef[],
): void {
  requireThreadResourceScope(grant);
  for (const resource of resources) requireAdmittedResource(grant, resource);
}

export function requireThreadResourceScope(caller: ProjectAccessCaller): void {
  if (caller.defaults.kind === "thread_agent" && (!caller.resourceScope ||
      typeof caller.resourceScope.allowOtherEnvironments !== "boolean" ||
      typeof caller.resourceScope.allowOtherProjects !== "boolean")) {
    throw new CanonicalAgentToolRequestError("permission_denied", "The thread resource scope is unavailable.");
  }
}

/** Resource visibility is the intersection of the two independent thread boundaries. */
export function resourceWithinScope(ref: ResolvedEnvironmentResourceRef, caller: ProjectAccessCaller): boolean {
  const policy = caller.resourceScope;
  if (caller.defaults.kind !== "thread_agent") return true;
  if (!policy) return false;
  if (ref.kind === "global" || ref.kind === "saved_agent") return true;
  if (!policy.allowOtherEnvironments && (ref.outsideEveryEnvironment ||
      ref.environmentId && ref.environmentId !== caller.defaults.environmentId)) return false;
  const projectOwned = ["workspace", "thread", "thread_family", "automation", "project", "project_subtree"].includes(ref.kind) ||
    ((ref.kind === "task" || ref.kind === "workpad") && (ref.threadId !== undefined || ref.environmentId !== undefined));
  if (!policy.allowOtherProjects && !ref.projectId && projectOwned) return false;
  if (ref.projectId && !policy.allowOtherProjects && ref.projectId !== caller.defaults.projectId) return false;
  return true;
}
export function filterResourceScopeRefs(refs: readonly ResolvedEnvironmentResourceRef[], caller: ProjectAccessCaller): readonly ResolvedEnvironmentResourceRef[] {
  return refs.filter(ref => resourceWithinScope(ref, caller));
}
export function assertResourceScope(refs: readonly ResolvedEnvironmentResourceRef[], caller: ProjectAccessCaller): void {
  const outside = refs.find(ref => !resourceWithinScope(ref, caller));
  if (!outside) return;
  const environment = !caller.resourceScope?.allowOtherEnvironments && (outside.outsideEveryEnvironment ||
    outside.environmentId && outside.environmentId !== caller.defaults.environmentId);
  throw new CanonicalAgentToolRequestError("permission_denied", environment
    ? "Cross-environment access is disabled for this thread. Enable access to other environments in its tool settings to continue."
    : "Access to other projects is disabled for this thread. Enable access to other projects in its tool settings to continue.");
}

function requiredDefaultWorkspaceId(
  request: ResolveEnvironmentAuthorityInput,
): string {
  const workspaceId = request.defaults.workspaceId;
  if (!workspaceId) return invalidContext();
  return workspaceId;
}

function requiredDefaultProjectId(
  request: ResolveEnvironmentAuthorityInput,
): string {
  const projectId = request.defaults.projectId;
  if (!projectId) return invalidContext();
  return projectId;
}

function requiredDefaultThreadId(
  request: ResolveEnvironmentAuthorityInput,
): string {
  const threadId = request.defaults.threadId;
  if (!threadId) return invalidContext();
  return threadId;
}

function allowedEnvironments(
  request: ResolveEnvironmentAuthorityInput,
  reader: AgentToolEnvironmentAuthorityReader,
): readonly EnvironmentAuthorityResourceFact[] {
  const environments = reader.listEnvironments(request.scope);
  if (!request.admittedEnvironmentIds) return environments;
  const admitted = new Set(request.admittedEnvironmentIds);
  return environments.filter(({ id }) => admitted.has(id));
}

function resourceRef(
  kind: EnvironmentResourceKind,
  fact: EnvironmentAuthorityResourceFact,
): ResolvedEnvironmentResourceRef {
  return Object.freeze({
    kind,
    id: fact.id,
    environmentId: fact.environmentId,
    ...(fact.workspaceId ? { workspaceId: fact.workspaceId } : {}),
    ...(fact.projectId ? { projectId: fact.projectId } : {}),
    ...(fact.label ? { label: fact.label } : {}),
    ...(fact.threadId ? { threadId: fact.threadId } : {}),
  });
}

function uniqueSortedRefs(
  refs: readonly ResolvedEnvironmentResourceRef[],
): readonly ResolvedEnvironmentResourceRef[] {
  const byKey = new Map(
    refs.map((ref) => [
      `${ref.kind}\0${ref.id}\0${ref.environmentId ?? ""}\0${ref.workspaceId ?? ""}\0${ref.threadId ?? ""}\0${ref.revision ?? ""}`,
      ref,
    ]),
  );
  return Object.freeze(
    [...byKey.values()]
      .sort((a, b) =>
        `${a.kind}\0${a.id}\0${a.environmentId ?? ""}\0${a.workspaceId ?? ""}\0${a.threadId ?? ""}\0${a.revision ?? ""}`.localeCompare(
          `${b.kind}\0${b.id}\0${b.environmentId ?? ""}\0${b.workspaceId ?? ""}\0${b.threadId ?? ""}\0${b.revision ?? ""}`,
        ),
      )
      .map((ref) => Object.freeze({ ...ref })),
  );
}

function authoringWorkspaceId(
  input: Record<string, unknown>,
): string | undefined {
  if (typeof input.workspaceId === "string") return input.workspaceId;
  const authoring = inputObject(input.authoringContext);
  return typeof authoring.workspaceId === "string"
    ? authoring.workspaceId
    : undefined;
}

function readStringPath(
  input: Record<string, unknown>,
  path: string | undefined,
): string | undefined {
  if (!path) return undefined;
  let value: unknown = input;
  for (const part of path.split(".")) value = inputObject(value)[part];
  return typeof value === "string" ? value : undefined;
}

function inputObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function required<T>(value: T | undefined): T {
  return value ?? unavailable();
}

function unavailable(): never {
  throw new CanonicalAgentToolRequestError(
    "not_found",
    "The requested resource was not found.",
  );
}

function deny(): never {
  throw new CanonicalAgentToolRequestError(
    "permission_denied",
    "The requested resource is unavailable.",
  );
}

function invalidContext(): never {
  throw new CanonicalAgentToolRequestError(
    "invalid_input",
    "The requested operation requires a configured caller default.",
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(deterministicJson(value)).digest("hex");
}
