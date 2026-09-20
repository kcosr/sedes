import { z } from "zod";
import {
  createWorkpadRequestSchema, listWorkpadsRequestSchema, updateWorkpadRequestSchema,
  workpadIdSchema, type Workpad, type WorkpadRevision, type WorkpadScope,
} from "../../../shared/protocol/workpads.js";
import type { WorkpadService } from "../../domain/workpad-service.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { TrustedToolInvocationContext } from "../contracts/agent-tool-contracts.js";
import {
  environmentAuthorityContinuationDigest, requireAdmittedEnvironment, requireAdmittedResource,
  type AgentToolEnvironmentAuthorityReader,
} from "../environment/environment-authority.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-agent-tool-request-error.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import { resolveTaskTargetScope } from "./management-tool-schemas.js";

const target = z.strictObject({ kind: z.enum(["global", "workspace", "thread"]), workspaceId: z.string().min(1).max(128).optional(), threadId: z.string().min(1).max(128).optional() });
const getInput = z.strictObject({ workpadId: workpadIdSchema, revision: z.number().int().nonnegative().optional() });
const revisionInput = z.strictObject({ workpadId: workpadIdSchema, limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(256).optional() });
const updateInput = z.object({ workpadId: workpadIdSchema }).passthrough();
const record = z.record(z.string(), z.unknown());

/** Canonical caller authority is rechecked against current domain state before use. */
export class WorkpadAgentToolService {
  constructor(private readonly input: {
    readonly workpads: WorkpadService;
    readonly authorityReader: AgentToolEnvironmentAuthorityReader;
  }) {}

  async execute(operation: "list" | "get" | "revisions" | "create" | "update", raw: unknown, context: TrustedToolInvocationContext): Promise<unknown> {
    const scope = { tenantId: context.tenantId, principalId: context.principalId };
    const actor = context.subject.kind === "thread_agent"
      ? { kind: "agent" as const, threadId: context.subject.sourceThreadId }
      : { kind: "tool_client" as const, clientId: context.subject.clientId };
    const tool = CANONICAL_AGENT_TOOL_MANIFEST[`workpad.${operation}`];
    if (operation === "list" || operation === "create") {
      const input = record.parse(raw);
      const resolved = resolveTaskTargetScope(target.parse(input.scope), context);
      this.assertScope(scope, resolved, context);
      if (operation === "list") {
        const request = listWorkpadsRequestSchema.parse({ ...input, scope: resolved });
        return this.input.workpads.list(scope, request, {
          environmentIds: context.environmentAuthority.targetEnvironmentIds,
          continuationKey: environmentAuthorityContinuationDigest(context.environmentAuthority, tool),
        });
      }
      const request = createWorkpadRequestSchema.parse({ ...input, scope: resolved });
      return { workpad: documentText(await this.input.workpads.create(scope, request, actor)) };
    }
    if (operation === "get") {
      const request = getInput.parse(raw);
      this.assertWorkpad(scope, request.workpadId, context);
      return { workpad: request.revision === undefined
        ? documentText(this.input.workpads.get(scope, request.workpadId))
        : revisionText(this.input.workpads.revision(scope, request.workpadId, request.revision)) };
    }
    if (operation === "revisions") {
      const request = revisionInput.parse(raw);
      this.assertWorkpad(scope, request.workpadId, context);
      return this.input.workpads.revisions(scope, request.workpadId, { limit: request.limit ?? 50, ...(request.cursor ? { cursor: request.cursor } : {}) });
    }
    const { workpadId, ...input } = updateInput.parse(raw);
    this.assertWorkpad(scope, workpadId, context);
    const resolved = input.scope === undefined ? undefined : resolveTaskTargetScope(target.parse(input.scope), context);
    if (resolved) this.assertScope(scope, resolved, context);
    const request = updateWorkpadRequestSchema.parse({ ...input, ...(resolved ? { scope: resolved } : {}) });
    return { workpad: documentText(await this.input.workpads.update(scope, workpadId, request, actor)) };
  }

  private assertWorkpad(scope: RequestScope, id: string, context: TrustedToolInvocationContext): void {
    const current = this.input.workpads.getAuthority(scope, id);
    requireAdmittedResource(context.environmentAuthority, {
      kind: "workpad", id, revision: current.revision,
      ...(current.environmentId === null ? {} : { environmentId: current.environmentId }),
    });
  }

  private assertScope(scope: RequestScope, targetScope: WorkpadScope, context: TrustedToolInvocationContext): void {
    if (targetScope.kind === "global") return;
    const fact = targetScope.kind === "thread"
      ? this.input.authorityReader.resolveThread(scope, targetScope.threadId)
      : this.input.authorityReader.resolveWorkspace(scope, targetScope.workspaceId);
    if (!fact) throw new CanonicalAgentToolRequestError("permission_denied", "The requested resource is unavailable.");
    requireAdmittedEnvironment(context.environmentAuthority, fact.environmentId);
    // Admission binds the exact destination, not just another resource in its environment.
    requireAdmittedResource(context.environmentAuthority, { kind: targetScope.kind, id: fact.id, environmentId: fact.environmentId, ...(fact.workspaceId ? { workspaceId: fact.workspaceId } : {}) });
  }
}

function documentText(workpad: Workpad) {
  const { attribution: _attribution, ...document } = workpad;
  return document;
}
function revisionText(revision: WorkpadRevision) {
  const { attribution: _attribution, changes: _changes, ...document } = revision;
  return document;
}
