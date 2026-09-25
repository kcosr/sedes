import { Type } from "typebox";
import { z } from "zod";
import type {
  ThreadForkResult,
  ThreadForkService,
} from "../../conversations/thread-fork-service.js";
import {
  DEFAULT_THREAD_MESSAGES_PAGE_SIZE,
  MAXIMUM_THREAD_MESSAGES_OUTPUT_BYTES,
  MAXIMUM_THREAD_MESSAGES_PAGE_SIZE,
  type ThreadMessagesPage,
  type ThreadMessagesService,
} from "../../conversations/thread-messages-service.js";
import type {
  AgentThreadControlService,
  AgentThreadDirectSendResult,
} from "../application/agent-thread-control-service.js";
import type {
  AgentThreadArchiveResult,
  AgentThreadInventoryControlService,
  AgentThreadRestoreResult,
} from "../application/agent-thread-inventory-control-service.js";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";
import {
  identifierSchema,
  isoDateSchema,
  sharedAdapters,
  targetIdentifierSchema,
} from "./management-tool-schemas.js";
import type { ToolInitiator } from "../contracts/tool-initiator.js";

const messagesManifest = CANONICAL_AGENT_TOOL_MANIFEST["thread.messages"];
const sendManifest = CANONICAL_AGENT_TOOL_MANIFEST["thread.send"];
const forkManifest = CANONICAL_AGENT_TOOL_MANIFEST["thread.fork"];
const archiveManifest = CANONICAL_AGENT_TOOL_MANIFEST["thread.archive"];
const restoreManifest = CANONICAL_AGENT_TOOL_MANIFEST["thread.restore"];
const MAXIMUM_THREAD_SEND_MESSAGE_BYTES = 65_536;
const threadForkAdapters = {
  pi_sdk: 90_000,
  mcp: 90_000,
  http: 90_000,
  cli: 90_000,
} as const;
const threadSendMessageSchema = z
  .string()
  .min(1)
  .max(MAXIMUM_THREAD_SEND_MESSAGE_BYTES)
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <= MAXIMUM_THREAD_SEND_MESSAGE_BYTES,
    "The message must not exceed 65536 UTF-8 bytes.",
  );

const threadMessagesPageSizeSchema = Type.Integer({
  minimum: 1,
  maximum: MAXIMUM_THREAD_MESSAGES_PAGE_SIZE,
  description:
    "Number of settled terminal turns to return, not a message count. Omit it for 10. The first request returns the newest turns; reuse the same value with nextCursor.",
});
const threadMessagesCursorSchema = Type.String({
  minLength: 1,
  maxLength: 2_048,
  description:
    "Opaque single-use continuation returned as nextCursor. It continues toward older turns and must be used with the same threadId and pageSize. Cursors expire, are invalidated when the transcript changes or the server restarts, and must then be discarded so reading can restart without a cursor.",
});
const revisionSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});
const truncationSchema = Type.Object(
  {
    truncated: Type.Boolean({
      description: "True when the projected text is incomplete.",
    }),
    retainedBytes: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "UTF-8 bytes retained in text.",
    }),
    originalBytes: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "Original UTF-8 byte count when it is known.",
      }),
    ),
    reason: Type.String({
      enum: ["byte_limit", "depth_limit", "entry_limit", "binary_omitted"],
      maxLength: 14,
      description:
        "Why text is incomplete. binary_omitted means normalized image content was excluded. entry_limit means normalized non-text content such as a skill, context excerpt, or attachment was excluded. An omitted-only message therefore has blank text plus this truncation marker.",
    }),
  },
  { additionalProperties: false, maxProperties: 4 },
);
const boundedTextSchema = Type.Object(
  {
    text: Type.String({
      maxLength: 16_384,
      description:
        "Projected message text. It can be blank when the original message contained only omitted image or other non-text content; inspect truncation before treating blank text as an empty message.",
    }),
    truncation: Type.Optional(truncationSchema),
  },
  { additionalProperties: false, maxProperties: 2 },
);
const boundedDisplayTextSchema = Type.Object(
  {
    text: Type.String({ maxLength: 4_096 }),
    truncation: Type.Optional(truncationSchema),
  },
  { additionalProperties: false, maxProperties: 2 },
);
const deliveryInputOriginSchema = Type.Object(
  {
    kind: Type.String({
      enum: ["agent_message", "agent_result"],
      maxLength: 13,
    }),
    callbackId: Type.Optional(targetIdentifierSchema),
    sourceThreadId: targetIdentifierSchema,
    sourceThreadLabel: boundedDisplayTextSchema,
  },
  {
    additionalProperties: false,
    maxProperties: 4,
    description:
      "Authenticated inter-agent provenance. callbackId is present only for agent_result.",
  },
);
const messageSchema = Type.Object(
  {
    role: Type.String({ enum: ["user", "assistant"], maxLength: 9 }),
    text: boundedTextSchema,
    origin: Type.Optional(deliveryInputOriginSchema),
  },
  {
    additionalProperties: false,
    maxProperties: 3,
    description:
      "One settled ordinary user or assistant message. Messages remain chronological within their turn. Authenticated inter-agent provenance is emitted only with role user.",
  },
);
const activeMessageSchema = Type.Object(
  {
    id: targetIdentifierSchema,
    role: Type.String({ enum: ["user", "assistant"], maxLength: 9 }),
    text: boundedTextSchema,
    origin: Type.Optional(deliveryInputOriginSchema),
  },
  {
    additionalProperties: false,
    maxProperties: 4,
    description:
      "One text-finalized ordinary user or assistant message from the active turn. Completion means its text receives no more live deltas; it does not assert that the model response succeeded. Authenticated inter-agent provenance is emitted only with role user.",
  },
);
const messagesTruncationSchema = Type.Object(
  {
    truncated: Type.Boolean(),
    omittedCount: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description:
        "Number of additional ordinary messages omitted after the returned chronological messages.",
    }),
    reason: Type.String({
      enum: ["entry_limit"],
      maxLength: 11,
      description:
        "entry_limit means the turn contained more ordinary messages than this bounded projection can return.",
    }),
  },
  { additionalProperties: false, maxProperties: 3 },
);
const activeMessagesTruncationSchema = Type.Object(
  {
    truncated: Type.Boolean(),
    omittedCount: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description:
        "Number of older text-finalized ordinary messages omitted before the returned chronological tail.",
    }),
    reason: Type.String({
      enum: ["entry_limit"],
      maxLength: 11,
      description:
        "entry_limit means the active turn contained more text-finalized ordinary messages than its newest-message window can return.",
    }),
  },
  { additionalProperties: false, maxProperties: 3 },
);
const turnSchema = Type.Object(
  {
    id: targetIdentifierSchema,
    revision: revisionSchema,
    status: Type.String({
      enum: ["completed", "interrupted", "failed"],
      maxLength: 11,
    }),
    startedAt: Type.Optional(isoDateSchema),
    completedAt: Type.Optional(isoDateSchema),
    forkable: Type.Boolean(),
    messages: Type.Array(messageSchema, {
      maxItems: 16,
      description:
        "Settled ordinary user and assistant messages in chronological order. This can be empty when the terminal turn contained no ordinary messages.",
    }),
    messagesTruncation: Type.Optional(messagesTruncationSchema),
  },
  {
    additionalProperties: false,
    maxProperties: 8,
    description:
      "One settled terminal turn. Turns are chronological within each returned page even though pages are read from newest history toward older history.",
  },
);
const activeTurnSchema = Type.Object(
  {
    id: targetIdentifierSchema,
    status: Type.String({ enum: ["in_progress"], maxLength: 11 }),
    startedAt: Type.Optional(isoDateSchema),
    messages: Type.Array(activeMessageSchema, {
      maxItems: 16,
      description:
        "The newest text-finalized ordinary user and assistant messages in chronological order. Streaming, failed, and interrupted items, reasoning, tools, commands, diffs, and provider-private message phases are excluded.",
    }),
    messagesTruncation: Type.Optional(activeMessagesTruncationSchema),
  },
  {
    additionalProperties: false,
    maxProperties: 5,
    description:
      "The active in-progress turn from the same atomic snapshot as turns. It can be present while the thread waits for input or approval, and message silence does not imply that work is stalled.",
  },
);

export interface AgentThreadControlToolServices {
  readonly messages: Pick<ThreadMessagesService, "list">;
  readonly send: Pick<AgentThreadControlService, "sendDirect">;
  readonly forks: Pick<ThreadForkService, "forkAgent" | "forkPrincipalClient">;
  readonly inventory: Pick<
    AgentThreadInventoryControlService,
    "archive" | "restore"
  >;
}

export interface ThreadMessagesToolInput {
  readonly threadId: string;
  readonly cursor?: string;
  readonly pageSize?: number;
}

export interface ThreadSendToolInput {
  readonly threadId: string;
  readonly message: string;
  readonly callback?: boolean;
}

export interface ThreadForkToolInput {
  readonly threadId: string;
  readonly sourceTurnId: string;
  readonly expectedTurnRevision: number;
}

export interface ThreadArchiveToolInput {
  readonly threadId: string;
  readonly includeDescendants?: boolean;
  readonly openTaskDisposition?:
    "move_to_workspace" | "move_to_global" | "keep";
}

export interface ThreadRestoreToolInput {
  readonly threadId: string;
}

export function createThreadMessagesToolDefinition(
  services: AgentThreadControlToolServices,
): AgentToolDefinition<ThreadMessagesToolInput, ThreadMessagesPage> {
  return {
    ...messagesManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          threadId: identifierSchema,
          cursor: Type.Optional(threadMessagesCursorSchema),
          pageSize: Type.Optional(threadMessagesPageSizeSchema),
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
          turns: Type.Array(turnSchema, {
            maxItems: MAXIMUM_THREAD_MESSAGES_PAGE_SIZE,
            description:
              "Settled terminal turns in chronological order. The initial page contains the newest matching turns; each continuation page contains the next older turns.",
          }),
          nextCursor: Type.Union([threadMessagesCursorSchema, Type.Null()], {
            description:
              "Opaque continuation toward older turns, or null when no older turns remain. A non-null value is single-use and ephemeral; follow the cursor instructions from the input schema.",
          }),
          activeTurn: Type.Optional(
            Type.Union([activeTurnSchema, Type.Null()], {
              description:
                "Present only on a fresh request without cursor. An object contains the current in-progress turn's text-finalized ordinary messages; null proves that the fresh snapshot had no active turn. Continuation pages omit this field because they do not evaluate current liveness.",
            }),
          ),
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
      supportsCancellation: false,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 8_192,
      maximumOutputBytes: MAXIMUM_THREAD_MESSAGES_OUTPUT_BYTES,
      concurrencyClass: "thread_messages_read",
      uncertainExternalOutcome: false,
    },
    exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_thread_messages",
        label: "Sedes thread messages",
        promptSnippet:
          "Read bounded settled thread messages plus text-finalized messages from the active turn on a fresh request.",
      },
      mcp: { name: "sedes_thread_messages" },
      http: { invocation: "inline" },
      cli: { command: messagesManifest.id },
    },
    execute(request, context) {
      return services.messages.list(
        { tenantId: context.tenantId, principalId: context.principalId },
        request.threadId,
        {
          ...(request.cursor ? { cursor: request.cursor } : {}),
          pageSize: request.pageSize ?? DEFAULT_THREAD_MESSAGES_PAGE_SIZE,
          environmentAuthority: context.environmentAuthority,
        },
      );
    },
  };
}

export function createThreadSendToolDefinition(
  services: AgentThreadControlToolServices,
): AgentToolDefinition<ThreadSendToolInput, AgentThreadDirectSendResult> {
  return {
    ...sendManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          threadId: identifierSchema,
          message: Type.String({
            minLength: 1,
            maxLength: MAXIMUM_THREAD_SEND_MESSAGE_BYTES,
            description: "Limited to 65536 UTF-8 bytes.",
          }),
          callback: Type.Optional(
            Type.Boolean({
              description:
                "When true, the calling thread automatically receives the target operation's terminal result and can continue. The send returns immediately in either mode. Omit or set false for fire-and-forget delivery. Available only to thread-agent callers.",
            }),
          ),
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
          status: Type.String({
            enum: ["delivery_accepted", "recovery_required", "aborted"],
            maxLength: 17,
          }),
          operationId: targetIdentifierSchema,
          retryable: Type.Optional(Type.Boolean()),
          callbackId: Type.Optional(targetIdentifierSchema),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 4,
        },
      ),
    ),
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: sharedAdapters,
      supportsCancellation: false,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 512 * 1_024,
      maximumOutputBytes: 8_192,
      concurrencyClass: "thread_send_write",
      uncertainExternalOutcome: true,
    },
    exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_thread_send",
        label: "Send Sedes thread message",
        promptSnippet:
          "Send an independent message to an unbound or idle Sedes thread. This starts model work and never changes its composer draft. Set callback true to receive the terminal result back in this calling thread; omit it for fire-and-forget delivery.",
      },
      mcp: { name: "sedes_thread_send" },
      http: { invocation: "inline" },
      cli: { command: sendManifest.id },
    },
    execute(request, context) {
      const initiator: ToolInitiator =
        context.subject.kind === "thread_agent" &&
        context.defaults.kind === "thread_agent"
          ? {
              kind: "thread_agent",
              sourceThreadId: context.subject.sourceThreadId,
              sourceWorkspaceId: context.defaults.workspaceId,
            }
          : context.subject.kind === "principal_client"
            ? { kind: "principal_client", clientId: context.subject.clientId }
            : (() => {
                throw new Error("agent_tool_caller_context_mismatch");
              })();
      return services.send.sendDirect(
        { tenantId: context.tenantId, principalId: context.principalId },
        {
          initiator,
          targetThreadId: request.threadId,
          message: threadSendMessageSchema.parse(request.message),
          callback: request.callback === true,
          mutationId: context.mutationId,
          environmentAuthority: context.environmentAuthority,
        },
      );
    },
  };
}

export function createThreadForkToolDefinition(
  services: AgentThreadControlToolServices,
): AgentToolDefinition<ThreadForkToolInput, ThreadForkResult> {
  return {
    ...forkManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          threadId: identifierSchema,
          sourceTurnId: targetIdentifierSchema,
          expectedTurnRevision: revisionSchema,
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
          status: Type.String({
            enum: ["created", "recovery_required", "aborted"],
            maxLength: 17,
          }),
          childThreadId: identifierSchema,
          retryable: Type.Optional(Type.Boolean()),
          uncertaintyKind: Type.Optional(
            Type.Union([
              Type.String({ enum: ["fork_unknown"], maxLength: 12 }),
              Type.Null(),
            ]),
          ),
          diagnostic: Type.Optional(
            Type.String({ minLength: 1, maxLength: 500 }),
          ),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 5,
        },
      ),
    ),
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: threadForkAdapters,
      supportsCancellation: false,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 8_192,
      maximumOutputBytes: 8_192,
      concurrencyClass: "thread_fork_write",
      uncertainExternalOutcome: true,
    },
    exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_thread_fork",
        label: "Fork Sedes thread",
        promptSnippet:
          "Fork an exact completed Sedes turn without sending a message.",
      },
      mcp: { name: "sedes_thread_fork" },
      http: { invocation: "inline" },
      cli: { command: forkManifest.id },
    },
    execute(request, context) {
      const common = {
        scope: { tenantId: context.tenantId, principalId: context.principalId },
        sourceThreadId: request.threadId,
        sourceTurnId: request.sourceTurnId,
        expectedTurnRevision: request.expectedTurnRevision,
        mutationId: context.mutationId,
        environmentAuthority: context.environmentAuthority,
      };
      return context.subject.kind === "thread_agent"
        ? services.forks.forkAgent({
            ...common,
            controllerThreadId: context.subject.sourceThreadId,
          })
        : services.forks.forkPrincipalClient({
            ...common,
            clientId: context.subject.clientId,
          });
    },
  };
}

export function createThreadArchiveToolDefinition(
  services: AgentThreadControlToolServices,
): AgentToolDefinition<ThreadArchiveToolInput, AgentThreadArchiveResult> {
  return {
    ...archiveManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          threadId: identifierSchema,
          includeDescendants: Type.Optional(Type.Boolean()),
          openTaskDisposition: Type.Optional(
            Type.String({
              enum: ["move_to_workspace", "move_to_global", "keep"],
              maxLength: 17,
            }),
          ),
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
          archivedThreadCount: Type.Integer({ minimum: 1, maximum: 10_000 }),
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
      supportsCancellation: false,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 8_192,
      maximumOutputBytes: 8_192,
      concurrencyClass: "thread_inventory_write",
      uncertainExternalOutcome: true,
    },
    exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_thread_archive",
        label: "Archive Sedes thread",
        promptSnippet:
          "Archive a Sedes thread without deleting its provider conversation.",
      },
      mcp: { name: "sedes_thread_archive" },
      http: { invocation: "inline" },
      cli: { command: archiveManifest.id },
    },
    execute(request, context) {
      return services.inventory.archive(
        { tenantId: context.tenantId, principalId: context.principalId },
        {
          threadId: request.threadId,
          includeDescendants: request.includeDescendants ?? false,
          ...(request.openTaskDisposition
            ? { openTaskDisposition: request.openTaskDisposition }
            : {}),
          mutationId: context.mutationId,
          environmentAuthority: context.environmentAuthority,
        },
      );
    },
  };
}

export function createThreadRestoreToolDefinition(
  services: AgentThreadControlToolServices,
): AgentToolDefinition<ThreadRestoreToolInput, AgentThreadRestoreResult> {
  return {
    ...restoreManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        { threadId: identifierSchema },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 1,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        { threadId: identifierSchema },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 1,
        },
      ),
    ),
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: sharedAdapters,
      supportsCancellation: false,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 8_192,
      maximumOutputBytes: 8_192,
      concurrencyClass: "thread_inventory_write",
      uncertainExternalOutcome: true,
    },
    exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_thread_restore",
        label: "Restore Sedes thread",
        promptSnippet:
          "Restore an archived Sedes thread to active inventory.",
      },
      mcp: { name: "sedes_thread_restore" },
      http: { invocation: "inline" },
      cli: { command: restoreManifest.id },
    },
    execute(request, context) {
      return services.inventory.restore(
        { tenantId: context.tenantId, principalId: context.principalId },
        {
          threadId: request.threadId,
          mutationId: context.mutationId,
          environmentAuthority: context.environmentAuthority,
        },
      );
    },
  };
}
