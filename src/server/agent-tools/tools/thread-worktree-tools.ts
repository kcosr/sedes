import { Type } from "typebox";
import { WORKSPACE_FILE_MAX_LINKED_WORKTREES } from "../../../shared/workspace-file-limits.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { TrustedEnvironmentAuthorityGrant } from "../environment/environment-authority.js";
import type {
  AgentToolDefinition,
  TrustedToolInvocationContext,
} from "../contracts/agent-tool-contracts.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";
import { identifierSchema } from "./management-tool-schemas.js";

const listManifest = CANONICAL_AGENT_TOOL_MANIFEST["thread.worktree_list"];
const setManifest = CANONICAL_AGENT_TOOL_MANIFEST["thread.worktree_set"];
const clearManifest = CANONICAL_AGENT_TOOL_MANIFEST["thread.worktree_clear"];
const revisionSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});
const sharedAdapters = {
  pi_sdk: 30_000,
  mcp: 30_000,
  http: 30_000,
  cli: 30_000,
} as const;

export interface AgentThreadWorktreeContext {
  readonly mutationId: string;
  readonly threadId: string;
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly environmentAuthority: TrustedEnvironmentAuthorityGrant;
  readonly signal: AbortSignal;
}

export interface AgentThreadWorktreePreference {
  readonly rootId: string | null;
  readonly revision: number;
}

export type AgentThreadWorktreeItem =
  | {
      readonly rootId: "primary";
      readonly kind: "primary";
      readonly displayLabel: string;
    }
  | {
      readonly rootId: string;
      readonly kind: "linked_worktree";
      readonly displayLabel: string;
      readonly branch: string | null;
      readonly head: string;
    };

export interface AgentThreadWorktreeListResult {
  readonly worktrees: readonly AgentThreadWorktreeItem[];
  readonly preference: AgentThreadWorktreePreference;
}

/** Source-thread worktree preference seam; implementations retain all path authority. */
export interface AgentThreadWorktreeService {
  list(
    scope: RequestScope,
    context: AgentThreadWorktreeContext,
  ): Promise<AgentThreadWorktreeListResult>;
  set(
    scope: RequestScope,
    context: AgentThreadWorktreeContext,
    input: ThreadWorktreeSetInput,
  ): Promise<AgentThreadWorktreePreference>;
  clear(
    scope: RequestScope,
    context: AgentThreadWorktreeContext,
    input: ThreadWorktreeClearInput,
  ): Promise<AgentThreadWorktreePreference>;
}

export interface ThreadWorktreeListInput {}

export interface ThreadWorktreeSetInput {
  readonly rootId: string;
  readonly expectedRevision: number;
}

export interface ThreadWorktreeClearInput {
  readonly expectedRevision: number;
}

const emptyInputSchema = normalizeCanonicalAgentToolSchema(
  Type.Object(
    {},
    {
      $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
      additionalProperties: false,
      maxProperties: 0,
    },
  ),
);
const preferenceSchema = Type.Object(
  {
    rootId: Type.Union([identifierSchema, Type.Null()], {
      description:
        "Opaque preferred linked-worktree root ID, or null when the thread uses Primary.",
    }),
    revision: revisionSchema,
  },
  { additionalProperties: false, maxProperties: 2 },
);
const worktreeItemSchema = Type.Union([
  Type.Object(
    {
      rootId: Type.String({ enum: ["primary"], maxLength: 7 }),
      kind: Type.String({ enum: ["primary"], maxLength: 7 }),
      displayLabel: Type.String({ minLength: 1, maxLength: 240 }),
    },
    { additionalProperties: false, maxProperties: 3 },
  ),
  Type.Object(
    {
      rootId: identifierSchema,
      kind: Type.String({ enum: ["linked_worktree"], maxLength: 15 }),
      displayLabel: Type.String({ minLength: 1, maxLength: 240 }),
      branch: Type.Union([
        Type.String({ minLength: 1, maxLength: 1_024 }),
        Type.Null(),
      ]),
      head: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false, maxProperties: 5 },
  ),
]);
const preferenceOutputSchema = normalizeCanonicalAgentToolSchema(
  Type.Object(
    { preference: preferenceSchema },
    {
      $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
      additionalProperties: false,
      maxProperties: 1,
    },
  ),
);

export function createThreadWorktreeListToolDefinition(
  service: AgentThreadWorktreeService,
): AgentToolDefinition<ThreadWorktreeListInput, AgentThreadWorktreeListResult> {
  return {
    ...listManifest,
    inputSchema: emptyInputSchema,
    outputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          worktrees: Type.Array(worktreeItemSchema, {
            minItems: 1,
            maxItems: WORKSPACE_FILE_MAX_LINKED_WORKTREES + 1,
          }),
          preference: preferenceSchema,
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 2,
        },
      ),
    ),
    requiredCapabilities: [],
    execution: execution("thread_worktree_list_read", false),
    exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_thread_worktree_list",
        label: "List Sedes linked worktrees",
        promptSnippet:
          "List the source thread's selectable linked worktrees and current thread preference revision.",
      },
      mcp: { name: "sedes_thread_worktree_list" },
      http: { invocation: "inline" },
      cli: { command: listManifest.id },
    },
    async execute(_input, context) {
      return await service.list(scope(context), sourceContext(context));
    },
  };
}

export function createThreadWorktreeSetToolDefinition(
  service: AgentThreadWorktreeService,
): AgentToolDefinition<
  ThreadWorktreeSetInput,
  { readonly preference: AgentThreadWorktreePreference }
> {
  return {
    ...setManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        { rootId: identifierSchema, expectedRevision: revisionSchema },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 2,
        },
      ),
    ),
    outputSchema: preferenceOutputSchema,
    requiredCapabilities: [],
    execution: execution("thread_worktree_preference_write", true),
    exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_thread_worktree_set",
        label: "Set Sedes preferred worktree",
        promptSnippet:
          "Revision-check and set one listed linked worktree as this thread's preferred worktree.",
      },
      mcp: { name: "sedes_thread_worktree_set" },
      http: { invocation: "inline" },
      cli: { command: setManifest.id },
    },
    async execute(input, context) {
      return {
        preference: await service.set(
          scope(context),
          sourceContext(context),
          input,
        ),
      };
    },
  };
}

export function createThreadWorktreeClearToolDefinition(
  service: AgentThreadWorktreeService,
): AgentToolDefinition<
  ThreadWorktreeClearInput,
  { readonly preference: AgentThreadWorktreePreference }
> {
  return {
    ...clearManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        { expectedRevision: revisionSchema },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 1,
        },
      ),
    ),
    outputSchema: preferenceOutputSchema,
    requiredCapabilities: [],
    execution: execution("thread_worktree_preference_write", true),
    exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_thread_worktree_clear",
        label: "Clear Sedes preferred worktree",
        promptSnippet:
          "Revision-check and return this thread's UI context to its primary project directory.",
      },
      mcp: { name: "sedes_thread_worktree_clear" },
      http: { invocation: "inline" },
      cli: { command: clearManifest.id },
    },
    async execute(input, context) {
      return {
        preference: await service.clear(
          scope(context),
          sourceContext(context),
          input,
        ),
      };
    },
  };
}

function execution(concurrencyClass: string, write: boolean) {
  return {
    form: "inline" as const,
    adapterWaitCeilingMilliseconds: sharedAdapters,
    supportsCancellation: true,
    idempotency: "not_applicable" as const,
    progress: "none" as const,
    maximumInputBytes: 2_048,
    maximumOutputBytes: write ? 1_024 : 128 * 1_024,
    concurrencyClass,
    uncertainExternalOutcome: write,
  };
}

function scope(context: TrustedToolInvocationContext): RequestScope {
  return { tenantId: context.tenantId, principalId: context.principalId };
}

function sourceContext(
  context: TrustedToolInvocationContext,
): AgentThreadWorktreeContext {
  if (
    context.subject.kind !== "thread_agent" ||
    context.defaults.kind !== "thread_agent" ||
    context.subject.sourceThreadId !== context.defaults.threadId
  ) {
    throw new Error("thread_worktree_agent_context_mismatch");
  }
  return {
    mutationId: context.mutationId,
    threadId: context.defaults.threadId,
    workspaceId: context.defaults.workspaceId,
    environmentId: context.defaults.environmentId,
    environmentAuthority: context.environmentAuthority,
    signal: context.abortSignal,
  };
}
