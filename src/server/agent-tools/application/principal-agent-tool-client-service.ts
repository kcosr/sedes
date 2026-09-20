import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import { environmentAdmitsForegroundOperation } from "../../domain/environment-operational-state.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type {
  AgentToolDescription,
  AgentToolCatalogSummary,
  SedesToolInvocationRequest,
  SedesToolInvocationResult,
  TrustedAgentToolAuthority,
} from "../contracts/agent-tool-contracts.js";
import { assertTrustedAgentToolAuthority } from "../contracts/agent-tool-contracts.js";
import {
  createTrustedEnvironmentAuthorityGrant,
  type AgentToolEnvironmentAuthorityResolver,
} from "../environment/environment-authority.js";
import {
  CanonicalAgentToolRequestError,
  type CanonicalInlineAgentToolService,
} from "../invocation/canonical-inline-agent-tool-service.js";
import type {
  PrincipalAgentToolClientPolicyInput,
  PrincipalAgentToolClientRecord,
  PrincipalAgentToolClientRepository,
} from "../../db/repositories/principal-agent-tool-client-repository.js";
import type { ThreadAgentToolCatalogReader } from "../../conversations/database-thread-application-readers.js";
import {
  toolClientListPageSchema,
  toolClientOptionsSchema,
  toolClientSchema,
  type ToolClient,
  type ToolClientListPage,
  type ToolClientOptions,
} from "../../../shared/protocol/tool-clients.js";
import {
  parsePrincipalAgentToolClientCredential,
  PrincipalAgentToolClientCredentialCodec,
} from "./principal-agent-tool-client-credential.js";

export interface PrincipalAgentToolClientAdmissionHooks {
  /** Deterministic test gate for mutations that commit before admission starts. */
  readonly beforeTransaction?: () => void;
  /** Observation-only gate while the immutable authority is prepared. */
  readonly authorityPrepared?: (authority: TrustedAgentToolAuthority) => void;
  /** Deterministic test gate for mutations serialized after admission commits. */
  readonly afterCommit?: (authority: TrustedAgentToolAuthority) => void;
}

export interface AdmittedPrincipalAgentToolInvocation {
  readonly scope: RequestScope;
  readonly authority: TrustedAgentToolAuthority;
}

export class ToolClientCreationConflictError extends DomainError {
  constructor(readonly client: ToolClient) {
    super("conflict", "The tool client creation request was already accepted.");
    this.name = "ToolClientCreationConflictError";
  }
}

export class PrincipalAgentToolClientService {
  readonly #credentials: PrincipalAgentToolClientCredentialCodec;

  constructor(
    installationKey: Uint8Array,
    readonly database: Database.Database,
    readonly repository: PrincipalAgentToolClientRepository,
    readonly canonical: CanonicalInlineAgentToolService,
    readonly environments: AgentToolEnvironmentAuthorityResolver,
    readonly now: () => number = Date.now,
    readonly admissionHooks: PrincipalAgentToolClientAdmissionHooks = {},
    readonly managementCatalog?: ThreadAgentToolCatalogReader,
  ) {
    this.#credentials = new PrincipalAgentToolClientCredentialCodec(
      installationKey,
    );
  }

  create(
    scope: RequestScope,
    input: Omit<PrincipalAgentToolClientPolicyInput, "enabled"> & {
      readonly requestId: string;
    },
  ): { readonly client: PrincipalAgentToolClientRecord; readonly credential: string } {
    const existing = this.repository.findByCreationRequestId(
      scope,
      input.requestId,
    );
    if (existing) {
      throw new ToolClientCreationConflictError(this.#present(existing));
    }
    const issued = this.#credentials.issue();
    let client: PrincipalAgentToolClientRecord;
    try {
      client = this.repository.create(scope, {
        id: issued.clientId,
        creationRequestId: input.requestId,
        name: input.name,
        enabled: true,
        toolIds: input.toolIds,
        defaultEnvironmentId: input.defaultEnvironmentId,
        allowedEnvironmentIds: input.allowedEnvironmentIds,
        ...(input.defaultWorkspaceId
          ? { defaultWorkspaceId: input.defaultWorkspaceId }
          : {}),
        ...(input.defaultThreadId
          ? { defaultThreadId: input.defaultThreadId }
          : {}),
        credentialGeneration: issued.generation,
        credentialVerifier: issued.verifier,
        now: this.now(),
      });
    } catch (error) {
      const admitted = this.repository.findByCreationRequestId(
        scope,
        input.requestId,
      );
      if (error instanceof DomainError && error.code === "conflict" && admitted) {
        throw new ToolClientCreationConflictError(this.#present(admitted));
      }
      throw error;
    }
    return Object.freeze({ client, credential: issued.credential });
  }

  createForManagement(
    scope: RequestScope,
    input: Omit<PrincipalAgentToolClientPolicyInput, "enabled"> & {
      readonly requestId: string;
    },
  ): { readonly client: ToolClient; readonly credential: string } {
    const created = this.create(scope, input);
    return Object.freeze({
      client: this.#present(created.client),
      credential: created.credential,
    });
  }

  replace(
    scope: RequestScope,
    clientId: string,
    input: PrincipalAgentToolClientPolicyInput & {
      readonly expectedRevision: number;
    },
  ): PrincipalAgentToolClientRecord {
    return this.repository.replace(scope, clientId, {
      ...input,
      now: this.now(),
    });
  }

  replaceForManagement(
    scope: RequestScope,
    clientId: string,
    input: PrincipalAgentToolClientPolicyInput & {
      readonly expectedRevision: number;
    },
  ): ToolClient {
    return this.#present(this.replace(scope, clientId, input));
  }

  rotate(
    scope: RequestScope,
    clientId: string,
    expectedRevision: number,
  ): { readonly client: PrincipalAgentToolClientRecord; readonly credential: string } {
    const current = this.repository.get(scope, clientId);
    if (current.revokedAt !== undefined) {
      throw new DomainError("conflict", "The tool client is revoked.");
    }
    if (current.credentialGeneration === 0xffff_ffff) {
      throw new DomainError(
        "conflict",
        "The tool client reached its maximum credential generation.",
      );
    }
    const issued = this.#credentials.issue(
      current.credentialGeneration + 1,
      current.id,
    );
    const client = this.repository.rotate(scope, clientId, {
      expectedRevision,
      nextGeneration: issued.generation,
      verifier: issued.verifier,
      now: this.now(),
    });
    return Object.freeze({ client, credential: issued.credential });
  }

  rotateForManagement(
    scope: RequestScope,
    clientId: string,
    expectedRevision: number,
  ): { readonly client: ToolClient; readonly credential: string } {
    const rotated = this.rotate(scope, clientId, expectedRevision);
    return Object.freeze({
      client: this.#present(rotated.client),
      credential: rotated.credential,
    });
  }

  revoke(
    scope: RequestScope,
    clientId: string,
    expectedRevision: number,
  ): PrincipalAgentToolClientRecord {
    return this.repository.revoke(scope, clientId, {
      expectedRevision,
      now: this.now(),
    });
  }

  revokeForManagement(
    scope: RequestScope,
    clientId: string,
    expectedRevision: number,
  ): ToolClient {
    return this.#present(this.revoke(scope, clientId, expectedRevision));
  }

  get(scope: RequestScope, clientId: string): ToolClient {
    return this.#present(this.repository.get(scope, clientId));
  }

  findByCreationRequestId(
    scope: RequestScope,
    creationRequestId: string,
  ): ToolClient | undefined {
    const record = this.repository.findByCreationRequestId(
      scope,
      creationRequestId,
    );
    return record ? this.#present(record) : undefined;
  }

  list(
    scope: RequestScope,
    input: {
      readonly pageSize: number;
      readonly cursor?: string;
      readonly creationRequestId?: string;
    },
  ): ToolClientListPage {
    if (input.creationRequestId) {
      const item = this.findByCreationRequestId(scope, input.creationRequestId);
      return toolClientListPageSchema.parse({ items: item ? [item] : [] });
    }
    const before = input.cursor ? decodeCursor(input.cursor) : undefined;
    const rows = this.repository.list(scope, {
      limit: input.pageSize + 1,
      ...(before ? { before } : {}),
    });
    const retained = rows.slice(0, input.pageSize);
    const last = retained.at(-1);
    return toolClientListPageSchema.parse({
      items: retained.map((record) => this.#present(record)),
      ...(rows.length > input.pageSize && last
        ? { nextCursor: encodeCursor(last) }
        : {}),
    });
  }

  options(scope: RequestScope): ToolClientOptions {
    if (!this.managementCatalog) {
      throw new DomainError(
        "runtime_unavailable",
        "Tool client management is unavailable.",
      );
    }
    const environments = this.database
      .prepare(
        `SELECT id, label, kind, availability, diagnostic_code AS diagnosticCode
         FROM execution_environments
         WHERE tenant_id = ? AND owner_principal_id = ?
         ORDER BY kind, label, id
         LIMIT 17`,
      )
      .all(scope.tenantId, scope.principalId) as Array<{
      readonly id: string;
      readonly label: string;
      readonly kind: "local" | "ssh" | "outbound";
      readonly availability: "available" | "unavailable";
      readonly diagnosticCode: string | null;
    }>;
    if (environments.length > 16) {
      throw new DomainError(
        "invalid_transition",
        "Tool client options exceed the supported environment limit.",
      );
    }
    let toolCount = 0;
    const groups = this.managementCatalog
      .list()
      .groups.map((group) => ({
        ...group,
        tools: group.tools.filter((tool) => {
          const eligible = this.repository.eligibility.eligibleToolIds.has(
            tool.id,
          );
          if (eligible) toolCount += 1;
          return eligible;
        }),
      }))
      .filter(({ tools }) => tools.length > 0);
    if (groups.length > 64 || toolCount > 256) {
      throw new DomainError(
        "invalid_transition",
        "Tool client options exceed the supported catalog limits.",
      );
    }
    return toolClientOptionsSchema.parse({
      environments: environments.map((environment) => ({
        id: environment.id,
        label: environment.label,
        kind: environment.kind,
        available: environmentAdmitsForegroundOperation(environment),
      })),
      groups,
    });
  }

  catalogSummaries(credential: string): readonly AgentToolCatalogSummary[] {
    let authenticated: AuthenticatedClient | undefined;
    try {
      return this.database.transaction(() => {
        authenticated = this.#authenticate(credential);
        const selected = new Set(authenticated.client.toolIds);
        return Object.freeze(
          this.canonical
            .catalogSummaries("http", "principal_client")
            .filter(({ id }) => selected.has(id)),
        );
      }).immediate();
    } finally {
      if (authenticated) this.#touch(authenticated);
    }
  }

  describeMany(
    credential: string,
    toolIds: readonly string[],
  ): readonly AgentToolDescription[] {
    let authenticated: AuthenticatedClient | undefined;
    try {
      return this.database.transaction(() => {
        authenticated = this.#authenticate(credential);
        const selected = new Set(authenticated.client.toolIds);
        if (toolIds.some((toolId) => !selected.has(toolId))) unavailable();
        return this.canonical.describeMany(
          "http",
          "principal_client",
          toolIds,
        );
      }).immediate();
    } finally {
      if (authenticated) this.#touch(authenticated);
    }
  }

  admitInvocation(
    credential: string,
    request: SedesToolInvocationRequest,
  ): AdmittedPrincipalAgentToolInvocation {
    this.admissionHooks.beforeTransaction?.();
    let authenticated: AuthenticatedClient | undefined;
    try {
      const admitted = this.database.transaction(() => {
        authenticated = this.#authenticate(credential);
        const client = authenticated.client;
        if (!client.toolIds.includes(request.toolId)) unavailable();
        const definition = this.canonical.prepareInlineInvocation(
          "http",
          "principal_client",
          request,
        );
        const defaults = Object.freeze({
          kind: "principal_client" as const,
          environmentId: required(client.defaultEnvironmentId),
          ...(client.defaultWorkspaceId
            ? { workspaceId: client.defaultWorkspaceId }
            : {}),
          ...(client.defaultThreadId ? { threadId: client.defaultThreadId } : {}),
        });
        const resolved = this.environments.resolve({
          tool: definition,
          input: request.input,
          scope: authenticated.scope,
          defaults,
          admittedEnvironmentIds: client.allowedEnvironmentIds,
        });
        this.#assertLiveDefaults(
          authenticated.scope,
          defaults,
          resolved.resolvedResourceRefs,
        );
        if (
          resolved.targetEnvironmentIds.some(
            (environmentId) =>
              !client.allowedEnvironmentIds.includes(environmentId),
          )
        ) {
          throw new CanonicalAgentToolRequestError(
            "permission_denied",
            "The requested resource is outside the tool client's environment grant.",
          );
        }
        const policyIdentity = Object.freeze({
          ownerKind: "principal_client" as const,
          ownerId: client.id,
          revision: client.policyRevision,
          credentialGeneration: client.credentialGeneration,
        });
        const environmentAuthority = createTrustedEnvironmentAuthorityGrant({
          ...resolved,
          tool: { id: definition.id, schemaVersion: definition.schemaVersion },
          callerKind: "principal_client",
          defaults,
          policyIdentity,
          admittedEnvironmentIds: client.allowedEnvironmentIds,
        });
        const authority = Object.freeze({
          subject: Object.freeze({
            kind: "principal_client" as const,
            clientId: client.id,
            credentialGeneration: client.credentialGeneration,
          }),
          defaults,
          policyIdentity,
          environmentAuthority,
        });
        assertTrustedAgentToolAuthority(authority);
        this.admissionHooks.authorityPrepared?.(authority);
        return Object.freeze({
          scope: authenticated.scope,
          authority,
        });
      }).immediate();
      this.admissionHooks.afterCommit?.(admitted.authority);
      return admitted;
    } finally {
      if (authenticated) this.#touch(authenticated);
    }
  }

  async invoke(
    credential: string,
    request: SedesToolInvocationRequest,
    signal: AbortSignal,
  ): Promise<SedesToolInvocationResult<unknown>> {
    const admitted = this.admitInvocation(credential, request);
    return this.canonical.invoke(request, {
      scope: admitted.scope,
      ...admitted.authority,
      adapter: "http",
      signal,
    });
  }

  #authenticate(credential: string): AuthenticatedClient {
    const parsed = parsePrincipalAgentToolClientCredential(credential);
    if (!parsed) unauthenticated();
    const record = this.repository.authenticationRecord(parsed.clientId);
    if (
      !record ||
      record.credentialGeneration !== parsed.generation ||
      !this.#credentials.matches(parsed, record.credentialVerifier)
    ) {
      unauthenticated();
    }
    const scope = Object.freeze({
      tenantId: record.tenantId,
      principalId: record.ownerPrincipalId,
    });
    return Object.freeze({ client: record, scope });
  }

  #assertLiveDefaults(
    scope: RequestScope,
    defaults: {
      readonly environmentId: string;
      readonly workspaceId?: string;
      readonly threadId?: string;
    },
    resolvedResourceRefs: readonly {
      readonly kind: string;
      readonly id: string;
      readonly workspaceId?: string;
    }[],
  ): void {
    const environment = this.database
      .prepare(
        `SELECT availability, diagnostic_code AS diagnosticCode
         FROM execution_environments
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .get(scope.tenantId, scope.principalId, defaults.environmentId) as
      | {
          readonly availability: "available" | "unavailable";
          readonly diagnosticCode: string | null;
        }
      | undefined;
    if (!environment || !environmentAdmitsForegroundOperation(environment)) {
      unavailable();
    }
    const usesDefaultThread = Boolean(
      defaults.threadId &&
        resolvedResourceRefs.some(
          (resource) =>
            (resource.kind === "thread" ||
              resource.kind === "thread_family") &&
            resource.id === defaults.threadId,
        ),
    );
    const usesDefaultWorkspace = Boolean(
      defaults.workspaceId &&
        (usesDefaultThread ||
          resolvedResourceRefs.some(
            (resource) =>
              (resource.kind === "workspace" &&
                resource.id === defaults.workspaceId) ||
              resource.workspaceId === defaults.workspaceId,
          )),
    );
    if (usesDefaultWorkspace && defaults.workspaceId) {
      const workspace = this.database
        .prepare(
          `SELECT availability FROM workspaces
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND environment_id = ? AND id = ?`,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          defaults.environmentId,
          defaults.workspaceId,
        ) as { readonly availability: "available" | "unavailable" } | undefined;
      if (!workspace || workspace.availability !== "available") unavailable();
    }
    if (usesDefaultThread && defaults.threadId) {
      const thread = this.database
        .prepare(
          `SELECT thread.availability, state.inventory_state AS inventoryState
           FROM application_threads AS thread
           JOIN thread_principal_state AS state
             ON state.tenant_id = thread.tenant_id
             AND state.principal_id = thread.owner_principal_id
             AND state.thread_id = thread.id
           WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
             AND thread.environment_id = ? AND thread.workspace_id = ?
             AND thread.id = ?`,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          defaults.environmentId,
          defaults.workspaceId,
          defaults.threadId,
        ) as
        | {
            readonly availability: string;
            readonly inventoryState: string;
          }
        | undefined;
      if (
        !thread ||
        thread.availability !== "available" ||
        thread.inventoryState === "archived"
      ) {
        unavailable();
      }
    }
  }

  #touch(authenticated: AuthenticatedClient): void {
    this.repository.touchLastUsed(
      authenticated.scope,
      authenticated.client.id,
      authenticated.client.credentialGeneration,
      this.now(),
    );
  }

  #present(record: PrincipalAgentToolClientRecord): ToolClient {
    const availableTools = this.managementCatalog
      ? new Set(
          this.managementCatalog
            .list()
            .groups.flatMap(({ tools }) => tools)
            .filter(({ available }) => available)
            .map(({ id }) => id),
        )
      : this.repository.eligibility.eligibleToolIds;
    const environmentAvailability = new Map<string, boolean>();
    if (record.allowedEnvironmentIds.length > 0) {
      const rows = this.database
        .prepare(
          `SELECT id, availability, diagnostic_code AS diagnosticCode
           FROM execution_environments
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND id IN (${record.allowedEnvironmentIds.map(() => "?").join(", ")})`,
        )
        .all(
          record.tenantId,
          record.ownerPrincipalId,
          ...record.allowedEnvironmentIds,
        ) as Array<{
        readonly id: string;
        readonly availability: "available" | "unavailable";
        readonly diagnosticCode: string | null;
      }>;
      for (const row of rows) {
        environmentAvailability.set(
          row.id,
          environmentAdmitsForegroundOperation(row),
        );
      }
    }
    const workspaceAvailable = record.defaultWorkspaceId
      ? this.database
          .prepare(
            `SELECT 1 FROM workspaces
             WHERE tenant_id = ? AND owner_principal_id = ?
               AND environment_id = ? AND id = ? AND availability = 'available'`,
          )
          .get(
            record.tenantId,
            record.ownerPrincipalId,
            record.defaultEnvironmentId,
            record.defaultWorkspaceId,
          ) !== undefined
      : null;
    const threadAvailable = record.defaultThreadId
      ? this.database
          .prepare(
            `SELECT 1
             FROM application_threads AS thread
             JOIN thread_principal_state AS state
               ON state.tenant_id = thread.tenant_id
               AND state.principal_id = thread.owner_principal_id
               AND state.thread_id = thread.id
             WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
               AND thread.environment_id = ? AND thread.workspace_id = ?
               AND thread.id = ? AND thread.availability = 'available'
               AND state.inventory_state <> 'archived'`,
          )
          .get(
            record.tenantId,
            record.ownerPrincipalId,
            record.defaultEnvironmentId,
            record.defaultWorkspaceId,
            record.defaultThreadId,
          ) !== undefined
      : null;
    const tools = record.toolIds.map((id) => ({
      id,
      available: availableTools.has(id),
    }));
    const environments = record.allowedEnvironmentIds.map((id) => ({
      id,
      available: environmentAvailability.get(id) === true,
    }));
    const needsAttention =
      record.revokedAt === undefined &&
      (tools.some(({ available }) => !available) ||
        environments.some(({ available }) => !available) ||
        workspaceAvailable === false ||
        threadAvailable === false);
    return toolClientSchema.parse({
      id: record.id,
      creationRequestId: record.creationRequestId,
      name: record.name,
      state:
        record.revokedAt !== undefined
          ? "revoked"
          : record.enabled
            ? "enabled"
            : "disabled",
      availability: needsAttention ? "needs_attention" : "available",
      toolIds: record.toolIds,
      tools,
      defaultEnvironmentId: record.defaultEnvironmentId ?? null,
      allowedEnvironmentIds: record.allowedEnvironmentIds,
      environments,
      defaultWorkspaceId: record.defaultWorkspaceId ?? null,
      defaultWorkspaceAvailable: workspaceAvailable,
      defaultThreadId: record.defaultThreadId ?? null,
      defaultThreadAvailable: threadAvailable,
      policyRevision: record.policyRevision,
      credentialGeneration: record.credentialGeneration,
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
      lastUsedAt: record.lastUsedAt === undefined ? null : iso(record.lastUsedAt),
      revokedAt: record.revokedAt === undefined ? null : iso(record.revokedAt),
    });
  }
}

type AuthenticatedClient = {
  readonly client: ReturnType<
    PrincipalAgentToolClientRepository["authenticationRecord"]
  > extends infer T
    ? Exclude<T, undefined>
    : never;
  readonly scope: RequestScope;
};

function required(value: string | undefined): string {
  if (!value) unavailable();
  return value;
}

function unauthenticated(): never {
  throw new CanonicalAgentToolRequestError(
    "unauthenticated",
    "The tool client credential is invalid.",
  );
}

function unavailable(): never {
  throw new CanonicalAgentToolRequestError(
    "not_found",
    "The requested tool is unavailable.",
  );
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function encodeCursor(record: PrincipalAgentToolClientRecord): string {
  return Buffer.from(
    JSON.stringify({ v: 1, createdAt: record.createdAt, id: record.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  cursor: string,
): { readonly createdAt: number; readonly id: string } {
  try {
    if (cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
      throw new Error("tool_client_cursor_invalid");
    }
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) {
      throw new Error("tool_client_cursor_noncanonical");
    }
    const parsed = JSON.parse(decoded) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.keys(parsed).length !== 3 ||
      !("v" in parsed) ||
      parsed.v !== 1 ||
      !("createdAt" in parsed) ||
      !Number.isSafeInteger(parsed.createdAt) ||
      (parsed.createdAt as number) < 0 ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        parsed.id,
      )
    ) {
      throw new Error("tool_client_cursor_invalid");
    }
    return { createdAt: parsed.createdAt as number, id: parsed.id };
  } catch (cause) {
    throw new DomainError(
      "cursor_invalid",
      "The tool client cursor is invalid.",
      false,
      { cause },
    );
  }
}
