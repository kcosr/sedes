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
    }
  | {
      readonly kind: "direct_resource";
      readonly resource: "thread_family" | "task" | "workpad" | "saved_agent";
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
  readonly workspaceId?: string;
  readonly threadId?: string;
  /** Mutable resource generation included when authority depends on it. */
  readonly revision?: number;
  readonly label?: string;
}

export interface EnvironmentApprovalDisplay {
  readonly defaultEnvironmentLabel?: string;
  readonly targetEnvironmentLabels: readonly string[];
  readonly resourceLabels: readonly string[];
}

export interface ResolvedEnvironmentAuthority {
  readonly canonicalInputDigest: string;
  readonly authorityDigest: string;
  readonly targetEnvironmentIds: readonly string[];
  readonly resolvedResourceRefs: readonly ResolvedEnvironmentResourceRef[];
  readonly display: EnvironmentApprovalDisplay;
}

export interface TrustedEnvironmentAuthorityGrant extends ResolvedEnvironmentAuthority {
  readonly id: string;
  readonly callerKind: AgentToolCallerKind;
  readonly defaults: TrustedAgentToolCallerDefaults;
  readonly policyIdentity: TrustedAgentToolPolicyIdentity;
  readonly admittedEnvironmentIds: readonly string[];
}

export interface EnvironmentAuthorityResourceFact {
  readonly id: string;
  readonly environmentId: string;
  readonly workspaceId?: string;
  readonly label?: string;
}

export interface EnvironmentAuthorityTaskFact {
  readonly id: string;
  readonly revision: number;
  readonly scopeKind: "global" | "workspace" | "thread";
  readonly environmentId?: string;
  readonly workspaceId?: string;
  readonly threadId?: string;
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
  ): { readonly id: string; readonly revision: number; readonly label?: string } | undefined;
  resolveWorkpad(
    scope: RequestScope,
    id: string,
  ): EnvironmentAuthorityTaskFact | undefined;
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
}

export class AgentToolEnvironmentAuthorityResolver {
  constructor(readonly reader: AgentToolEnvironmentAuthorityReader) {}

  resolve(
    request: ResolveEnvironmentAuthorityInput,
  ): ResolvedEnvironmentAuthority {
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
        ...required(this.reader.resolveSavedAgent(request.scope, input.agentId)),
      });
    }
    const resolvedResourceRefs = uniqueSortedRefs(refs);
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
        ({ kind, id, environmentId, workspaceId, threadId, revision }) => ({
          kind,
          id,
          ...(environmentId ? { environmentId } : {}),
          ...(workspaceId ? { workspaceId } : {}),
          ...(threadId ? { threadId } : {}),
          ...(revision !== undefined ? { revision } : {}),
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
      declaration.kind === "installation_directory" ||
      declaration.kind === "environment_neutral"
    )
      return [];
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
    const supplied = object[inputField];
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
    if (declaration.resource === "environment")
      return [
        resourceRef(
          "environment",
          required(this.reader.resolveEnvironment(request.scope, id)),
        ),
      ];
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
    return taskRefs(
      required(declaration.resource === "workpad" ? this.reader.resolveWorkpad(request.scope, id) : this.reader.resolveTask(request.scope, id)),
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
    if (scope.kind === "workspace")
      return [
        resourceRef(
          "workspace",
          required(
            this.reader.resolveWorkspace(
              request.scope,
              typeof scope.workspaceId === "string"
                ? scope.workspaceId
                : requiredDefaultWorkspaceId(request),
            ),
          ),
        ),
      ];
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
        ...taskRefs(
          required(resource === "workpad" ? this.reader.resolveWorkpad(request.scope, resourceId) : this.reader.resolveTask(request.scope, resourceId)),
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
  },
): TrustedEnvironmentAuthorityGrant {
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
    targetEnvironmentIds,
    resolvedResourceRefs: resolvedResourceRefs.map(
      ({ kind, id, environmentId, workspaceId, threadId, revision }) => ({
        kind,
        id,
        ...(environmentId ? { environmentId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(threadId ? { threadId } : {}),
        ...(revision !== undefined ? { revision } : {}),
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
    targetEnvironmentIds: grant.targetEnvironmentIds,
    resolvedResourceRefs: grant.resolvedResourceRefs.map(
      ({ kind, id, environmentId, workspaceId, threadId, revision }) => ({
        kind,
        id,
        ...(environmentId ? { environmentId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(threadId ? { threadId } : {}),
        ...(revision !== undefined ? { revision } : {}),
      }),
    ),
  });
}

export function requireAdmittedEnvironment(
  grant: TrustedEnvironmentAuthorityGrant,
  environmentId: string,
): void {
  if (!grant.admittedEnvironmentIds.includes(environmentId)) deny();
}

export function requireAdmittedResource(
  grant: TrustedEnvironmentAuthorityGrant,
  resource: ResolvedEnvironmentResourceRef,
): void {
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
  if (scope.kind === "workspace")
    return [
      resourceRef(
        "workspace",
        required(
          reader.resolveWorkspace(
            request.scope,
            typeof scope.workspaceId === "string"
              ? scope.workspaceId
              : requiredDefaultWorkspaceId(request),
          ),
        ),
      ),
    ];
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

function taskRefs(
  task: EnvironmentAuthorityTaskFact,
  request: ResolveEnvironmentAuthorityInput,
  kind: "task" | "workpad" = "task",
): readonly ResolvedEnvironmentResourceRef[] {
  if (task.scopeKind === "global")
    return [
      { kind, id: task.id, revision: task.revision, label: task.label },
    ];
  const environmentId =
    task.environmentId ??
    (task.workspaceId === request.defaults.workspaceId ||
    task.threadId === request.defaults.threadId
      ? request.defaults.environmentId
      : undefined);
  if (!environmentId) return deny();
  return [
    {
      kind,
      id: task.id,
      ...(task.threadId ? { threadId: task.threadId } : {}),
      environmentId,
      revision: task.revision,
      label: task.label,
    },
  ];
}

function requiredDefaultWorkspaceId(
  request: ResolveEnvironmentAuthorityInput,
): string {
  const workspaceId = request.defaults.workspaceId;
  if (!workspaceId) return invalidContext();
  return workspaceId;
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
    ...(fact.label ? { label: fact.label } : {}),
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
