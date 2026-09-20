import { Type } from "typebox";
import { z } from "zod";
import { createThreadTitleSchema } from "../../../shared/protocol/api.js";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";
import type {
  AgentManagementService,
  AgentThreadListScope,
  AgentThreadSummary,
} from "../application/agent-management-service.js";
import {
  cursorSchema,
  identifierSchema,
  isoDateSchema,
  sharedAdapters,
  targetIdentifierSchema,
  threadTitleSchema,
} from "./management-tool-schemas.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import type {
  AgentToolBootstrapPolicy,
  NormalizedAgentConfigurationOverrides,
} from "../../../shared/protocol/saved-agents.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import {
  savedAgentSedesToolsToolSchema,
  savedAgentOverridesToolSchema,
} from "./saved-agent-tool-schemas.js";
import type { TrustedEnvironmentAuthorityGrant } from "../environment/environment-authority.js";
import type { ToolInitiator } from "../contracts/tool-initiator.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-inline-agent-tool-service.js";

const threadListManifest = CANONICAL_AGENT_TOOL_MANIFEST["thread.list"];
const threadCreateManifest = CANONICAL_AGENT_TOOL_MANIFEST["thread.create"];
const threadListLastActivityAfterSchema = z.iso.datetime();

export type ThreadListInput = {
  readonly scope?: AgentThreadListScope;
  readonly query?: string;
  readonly lifecycle?: AgentThreadSummary["lifecycle"];
  readonly lastActivityAfter?: string;
  readonly hasAutomation?: boolean;
  readonly cursor?: string;
  readonly pageSize?: number;
};
export type ThreadCreateInput = {
  readonly title: string;
  readonly workspaceId?: string;
  readonly configuration:
    | {
        readonly kind: "saved_agent";
        readonly agentId: string;
        readonly targetId?: string;
      }
    | {
        readonly kind: "custom";
        readonly targetId: string;
        readonly backendOverrides?: NormalizedAgentConfigurationOverrides;
        readonly sedesTools?: AgentToolBootstrapPolicy;
      };
};

export type AgentThreadCreateRequest = ThreadCreateInput & {
  readonly workspaceId: string;
  readonly executionWorkspace: { readonly kind: "direct" };
};

export interface AgentThreadCreationService {
  createThread(
    scope: RequestScope,
    request: AgentThreadCreateRequest,
    caller: {
      readonly kind: "agent_tool";
      readonly initiator: ToolInitiator;
      readonly mutationId: string;
      readonly environmentAuthority: TrustedEnvironmentAuthorityGrant;
    },
    signal?: AbortSignal,
  ): Promise<{
    readonly threadId: string;
    readonly workspaceId: string;
    readonly targetId: string;
  }>;
}

const automationSchema = Type.Union([
  Type.Object(
    {
      status: Type.String({ enum: ["enabled", "paused"], maxLength: 7 }),
      runMode: Type.String({ enum: ["same_thread", "clone"], maxLength: 11 }),
      scheduleKind: Type.String({
        enum: ["date_time", "interval", "cron"],
        maxLength: 9,
      }),
      nextRunAt: Type.Optional(isoDateSchema),
      revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      hasPrecheck: Type.Boolean(),
      lastRun: Type.Optional(
        Type.Object(
          {
            id: targetIdentifierSchema,
            state: Type.String({
              enum: [
                "claimed",
                "dispatching",
                "queued",
                "running",
                "completed",
                "failed",
                "skipped",
                "uncertain",
              ],
              maxLength: 11,
            }),
            occurrence: Type.String({
              enum: ["scheduled", "manual"],
              maxLength: 9,
            }),
            scheduledFor: isoDateSchema,
            finishedAt: Type.Optional(isoDateSchema),
            resultThreadId: Type.Optional(targetIdentifierSchema),
            errorCode: Type.Optional(
              Type.String({ minLength: 1, maxLength: 120 }),
            ),
          },
          { additionalProperties: false, maxProperties: 7 },
        ),
      ),
    },
    { additionalProperties: false, maxProperties: 7 },
  ),
  Type.Null(),
]);

const threadItemSchema = Type.Object(
  {
    id: identifierSchema,
    title: threadTitleSchema,
    lastActivityAt: Type.String({
      minLength: 20,
      maxLength: 40,
      description:
        "Thread activity time; results are ordered by this field descending, then id ascending.",
    }),
    workspace: Type.Object(
      {
        id: identifierSchema,
        label: Type.String({ minLength: 1, maxLength: 240 }),
      },
      {
        additionalProperties: false,
        maxProperties: 2,
        description:
          "Principal-owned workspace identity and display label; no native path is exposed.",
      },
    ),
    environment: Type.Object(
      {
        id: identifierSchema,
        label: Type.String({ minLength: 1, maxLength: 240 }),
      },
      {
        additionalProperties: false,
        maxProperties: 2,
        description:
          "Execution-environment identity and safe display label; no host or transport topology is exposed.",
      },
    ),
    backend: Type.String({
      enum: ["pi", "codex_app_server", "claude_agent_sdk", "grok_build"],
      maxLength: 32,
    }),
    lifecycle: Type.String({
      enum: ["active", "snoozed", "settled", "archived"],
      maxLength: 8,
    }),
    activity: Type.String({
      enum: ["idle", "running", "waiting_for_input"],
      maxLength: 17,
    }),
    automation: automationSchema,
  },
  { additionalProperties: false, maxProperties: 9 },
);

const threadListScopeSchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.String({ enum: ["default_environment"], maxLength: 19 }),
      },
      {
        additionalProperties: false,
        maxProperties: 1,
        description: "Search the caller's configured default environment.",
      },
    ),
    Type.Object(
      {
        kind: Type.String({ enum: ["default_workspace"], maxLength: 17 }),
      },
      {
        additionalProperties: false,
        maxProperties: 1,
        description: "Search only the caller's configured default workspace.",
      },
    ),
    Type.Object(
      {
        kind: Type.String({ enum: ["workspace"], maxLength: 9 }),
        workspaceId: identifierSchema,
      },
      {
        additionalProperties: false,
        maxProperties: 2,
        description: "Search one exact principal-owned workspace.",
      },
    ),
    Type.Object(
      {
        kind: Type.String({
          enum: ["all_allowed_environments"],
          maxLength: 24,
        }),
      },
      {
        additionalProperties: false,
        maxProperties: 1,
        description: "Search every admitted execution environment.",
      },
    ),
  ],
  {
    description:
      "Search scope. Omit this field for the caller's configured default environment.",
  },
);

export function createThreadListToolDefinition(
  service: AgentManagementService,
): AgentToolDefinition<
  ThreadListInput,
  {
    readonly items: readonly AgentThreadSummary[];
    readonly nextCursor?: string;
  }
> {
  return {
    ...threadListManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          scope: Type.Optional(threadListScopeSchema),
          query: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 240,
              description:
                "ASCII-case-insensitive title substring to match; non-ASCII characters match exactly.",
            }),
          ),
          lifecycle: Type.Optional(
            Type.String({
              enum: ["active", "snoozed", "settled", "archived"],
              maxLength: 8,
            }),
          ),
          lastActivityAfter: Type.Optional(
            Type.String({
              minLength: 20,
              maxLength: 40,
              description:
                "Return only threads with activity strictly later than this ISO timestamp.",
            }),
          ),
          hasAutomation: Type.Optional(Type.Boolean()),
          cursor: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 2_048,
              description:
                "Opaque cursor for the next page of the same query and fixed recency order.",
            }),
          ),
          pageSize: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 100,
              description: "Maximum summaries to return; defaults to 50.",
            }),
          ),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 7,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          items: Type.Array(threadItemSchema, { maxItems: 100 }),
          nextCursor: Type.Optional(cursorSchema),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 2,
        },
      ),
    ),
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: sharedAdapters,
      supportsCancellation: true,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 8_192,
      maximumOutputBytes: 512 * 1_024,
      concurrencyClass: "thread_list_read",
      uncertainExternalOutcome: false,
    },
    exposure: { adapters: ["pi_sdk", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_thread_list",
        label: "Sedes thread list",
        promptSnippet: "Discover Sedes threads and their activity.",
      },
      http: { invocation: "inline" },
      cli: { command: threadListManifest.id },
    },
    async execute(input, context) {
      const lastActivityAfter =
        input.lastActivityAfter === undefined
          ? undefined
          : threadListLastActivityAfterSchema.parse(input.lastActivityAfter);
      return service.listThreads(
        { tenantId: context.tenantId, principalId: context.principalId },
        context.defaults.workspaceId,
        {
          ...input,
          scope: input.scope ?? { kind: "default_environment" },
          ...(lastActivityAfter === undefined ? {} : { lastActivityAfter }),
          pageSize: input.pageSize ?? 50,
        },
        context.environmentAuthority,
        context.abortSignal,
      );
    },
  };
}

export function createThreadCreateToolDefinition(
  service: AgentThreadCreationService,
): AgentToolDefinition<
  ThreadCreateInput,
  {
    readonly threadId: string;
    readonly workspaceId: string;
    readonly targetId: string;
  }
> {
  return {
    ...threadCreateManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          title: threadTitleSchema,
          workspaceId: Type.Optional(identifierSchema),
          configuration: Type.Union([
            Type.Object(
              {
                kind: Type.String({ enum: ["saved_agent"], maxLength: 11 }),
                agentId: identifierSchema,
                targetId: Type.Optional(targetIdentifierSchema),
              },
              { additionalProperties: false, maxProperties: 3 },
            ),
            Type.Object(
              {
                kind: Type.String({ enum: ["custom"], maxLength: 6 }),
                targetId: targetIdentifierSchema,
                backendOverrides: Type.Optional(savedAgentOverridesToolSchema),
                sedesTools: Type.Optional(savedAgentSedesToolsToolSchema),
              },
              { additionalProperties: false, maxProperties: 4 },
            ),
          ]),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 3,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          threadId: identifierSchema,
          workspaceId: identifierSchema,
          targetId: targetIdentifierSchema,
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 3,
        },
      ),
    ),
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: sharedAdapters,
      supportsCancellation: true,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 256 * 1_024,
      maximumOutputBytes: 1_024,
      concurrencyClass: "thread_create_write",
      uncertainExternalOutcome: true,
    },
    exposure: { adapters: ["pi_sdk", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_thread_create",
        label: "Create Sedes thread",
        promptSnippet: "Create an empty Sedes draft thread.",
      },
      http: { invocation: "inline" },
      cli: { command: threadCreateManifest.id },
    },
    async execute(input, context) {
      const initiator: ToolInitiator =
        context.subject.kind === "thread_agent" &&
        context.defaults.kind === "thread_agent"
          ? {
              kind: "thread_agent",
              sourceThreadId: context.subject.sourceThreadId,
              sourceWorkspaceId: context.defaults.workspaceId,
            }
          : context.subject.kind === "principal_client" &&
              context.defaults.kind === "principal_client"
            ? {
                kind: "principal_client",
                clientId: context.subject.clientId,
              }
            : (() => {
                throw new Error("agent_tool_caller_context_mismatch");
              })();
      const workspaceId = input.workspaceId ?? context.defaults.workspaceId;
      if (!workspaceId) {
        throw new CanonicalAgentToolRequestError(
          "invalid_input",
          "thread.create requires an explicit workspace or a configured default workspace.",
        );
      }
      return service.createThread(
        { tenantId: context.tenantId, principalId: context.principalId },
        {
          ...input,
          title: createThreadTitleSchema.parse(input.title),
          workspaceId,
          executionWorkspace: { kind: "direct" },
        },
        {
          kind: "agent_tool",
          initiator,
          mutationId: context.mutationId,
          environmentAuthority: context.environmentAuthority,
        },
        context.abortSignal,
      );
    },
  };
}
