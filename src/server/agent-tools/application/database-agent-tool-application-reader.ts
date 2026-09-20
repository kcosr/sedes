import type Database from "better-sqlite3";
import type { Request } from "express";
import type { ThreadRunState } from "../../../shared/protocol/conversation.js";
import type { BackendKind } from "../../backends/contracts.js";
import type { ThreadApplicationService } from "../../conversations/thread-application-service.js";
import type { ThreadAgentToolPolicyRepository } from "../../db/repositories/thread-agent-tool-policy-repository.js";
import type {
  IdentityProvider,
  RequestScope,
} from "../../identity/identity-provider.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-inline-agent-tool-service.js";
import { DatabaseAgentToolSourceAuthority } from "./database-agent-tool-source-authority.js";
import type {
  AgentToolSourceContextResolver,
  ResolvedAgentToolSourceContext,
} from "../http/agent-tool-http-service.js";
import type {
  AgentToolApplicationReader,
  ThreadStatusResult,
} from "../tools/agent-tool-readers.js";
import {
  requireAdmittedResource,
  type TrustedEnvironmentAuthorityGrant,
} from "../environment/environment-authority.js";

function activity(runState: ThreadRunState): ThreadStatusResult["activity"] {
  if (runState === "waiting_for_input" || runState === "waiting_for_approval") {
    return "waiting_for_input";
  }
  if (
    runState === "idle" ||
    runState === "failed" ||
    runState === "disconnected"
  ) {
    return "idle";
  }
  return "running";
}

/**
 * One scoped application reader for transport association and canonical
 * application reads. Thread, workspace, and backend facts come from one
 * server-owned join; no caller-provided scope participates in the lookup.
 */
export class DatabaseAgentToolApplicationReader
  implements AgentToolSourceContextResolver, AgentToolApplicationReader
{
  readonly #sources: DatabaseAgentToolSourceAuthority;

  constructor(
    readonly database: Database.Database,
    readonly identity: IdentityProvider<Request>,
    readonly threads: Pick<ThreadApplicationService, "snapshot">,
    sources: DatabaseAgentToolSourceAuthority,
  ) {
    this.#sources = sources;
  }

  async resolve(
    request: Request,
    sourceCapability: string,
    signal: AbortSignal,
  ): Promise<ResolvedAgentToolSourceContext> {
    this.#assertOpen(signal);
    const scope = await this.identity.resolve(request);
    this.#assertOpen(signal);
    return this.#sources.resolveCapabilityInScope(
      scope,
      sourceCapability,
      signal,
    );
  }

  async readThreadStatus(
    scope: RequestScope,
    threadId: string,
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
    signal: AbortSignal,
  ): Promise<ThreadStatusResult | undefined> {
    this.#assertOpen(signal);
    const source = this.#sources.resolveThread(scope, threadId);
    if (!source) return undefined;
    const backend = this.database
      .prepare(
        `
          SELECT backend.kind AS backendKind
          FROM application_threads AS thread
          JOIN agent_backend_instances AS backend
            ON backend.tenant_id = thread.tenant_id
            AND backend.id = thread.backend_instance_id
          WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
            AND thread.id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      { readonly backendKind: BackendKind } | undefined;
    if (!backend) return undefined;
    requireAdmittedResource(environmentAuthority, {
      kind: "thread",
      id: source.id,
      environmentId: source.environmentId,
      workspaceId: source.workspaceId,
    });
    const snapshot = await this.threads.snapshot(scope, threadId);
    this.#assertOpen(signal);
    return {
      threadId: source.id,
      backend: backend.backendKind,
      lifecycle:
        snapshot.thread.inventoryState === "archived"
          ? "archived"
          : snapshot.thread.inventoryState === "snoozed"
            ? "snoozed"
            : snapshot.thread.inventoryState === "settled"
              ? "settled"
              : "active",
      activity: activity(snapshot.thread.runState),
    };
  }

  #assertOpen(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new CanonicalAgentToolRequestError(
        "cancelled",
        "The agent-tool request was cancelled.",
      );
    }
  }
}
