import { environmentVariableOverridesSchema } from "../../../../shared/protocol/environment-variables.js";
import { resolvedEnvironmentVariablesSchema } from "../../../../internal/sidecar-protocol/environment-variables-v1.js";
import { normalizedAbsolutePath } from "../../../../shared/absolute-path.js";
import { isAgentToolCliEndpoint } from "../../../../internal/agent-tool-cli-protocol/local-endpoint.js";
import { z } from "zod";
import type { BoundedJsonValue } from "../../../provider-protocol/json/bounded-json-snapshot.js";
import { snapshotBoundedJson } from "../../../provider-protocol/json/bounded-json-snapshot.js";
import {
  defineSidecarOperation,
  type SidecarOperationHandler,
  type SidecarOperationRegistry,
} from "../../../../internal/sidecar-protocol/operation-registry.js";

import { CLAUDE_HISTORY_PAGE_MESSAGES } from "../claude-session-history.js";

export const CLAUDE_RUNTIME_CAPABILITY_ID = "claude_runtime" as const;
export const CLAUDE_RUNTIME_MAJOR_VERSION = 1 as const;
// HSC1's current frame ceiling is a little over 96 MiB. Keep enough room for
// the request/event envelope and JSON escaping rather than treating the whole
// transport frame as provider payload authority.
export const CLAUDE_RUNTIME_MAXIMUM_JSON_BYTES = 64 * 1024 * 1024;
export const CLAUDE_RUNTIME_MAXIMUM_HISTORY_RESPONSE_BYTES = 32 * 1024 * 1024;
export const CLAUDE_RUNTIME_MAXIMUM_QUERIES = 32;

const boundedJsonValueSchema = z
  .unknown()
  .transform((value, context): BoundedJsonValue => {
    try {
      return snapshotBoundedJson(value, {
        maximumDepth: 64,
        maximumObjectProperties: 16_384,
        maximumArrayItems: 262_144,
        maximumStringBytes: 64 * 1024 * 1024,
        maximumTotalNodes: 1_000_000,
        maximumEncodedBytes: CLAUDE_RUNTIME_MAXIMUM_JSON_BYTES,
      });
    } catch {
      context.addIssue({
        code: "custom",
        message: "A bounded JSON value is required.",
      });
      return z.NEVER;
    }
  });

const boundedJsonObjectSchema = boundedJsonValueSchema.refine(
  (value): value is Readonly<Record<string, BoundedJsonValue>> =>
    typeof value === "object" && value !== null && !Array.isArray(value),
  "A bounded JSON object is required.",
);
const uuidSchema = z.string().uuid();
const boundedStringSchema = z.string().max(16_384);
const optionalBoundedStringSchema = boundedStringSchema.optional();
const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      normalizedAbsolutePath(value) &&
      !value.includes("\0") &&
      !/[\u0001-\u001f\u007f]/u.test(value),
    "A bounded absolute remote path is required.",
  );
const nonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const permissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);
const agentToolEndpointSchema = z
  .url()
  .max(16_384)
  .refine((value) => {
    const parsed = new URL(value);
    const loopbackHttp =
      parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.port.length > 0 &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash &&
      parsed.origin === value;
    return loopbackHttp || isAgentToolCliEndpoint(value);
  }, "A canonical Agent Tool endpoint is required.");
export const claudeRuntimeQueryEnvironmentSchema = z.union([
  z.strictObject({}),
  z.strictObject({
    SEDES_AGENT_TOOL_ENDPOINT: agentToolEndpointSchema,
    SEDES_AGENT_TOOL_SOURCE_CAPABILITY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{32,256}$/u),
    SEDES_AGENT_TOOL_CLI_MODE: z.enum(["progressive", "individual"]),
    PATH: z
      .string()
      .max(16_384)
      .refine((value) => !/[\u0000\r\n]/u.test(value)),
  }),
]);

/**
 * The thread's Native Sedes tools as one stdio MCP server. It is exclusive
 * with the CLI query environment: a Native query's shell never receives a
 * thread reference.
 */
export const claudeRuntimeAgentToolMcpSchema = z.strictObject({
  command: absolutePathSchema,
  mode: z.enum(["progressive", "individual"]),
  endpoint: agentToolEndpointSchema,
  sourceCapability: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u),
});
export type ClaudeRuntimeAgentToolMcp = z.infer<
  typeof claudeRuntimeAgentToolMcpSchema
>;

export const claudeRuntimeInitializeRequestSchema = z.strictObject({
  startupEnvironment: resolvedEnvironmentVariablesSchema.optional(),
  startupEnvironmentVariables: environmentVariableOverridesSchema.optional(),
  executablePath: z.union([absolutePathSchema, z.literal("claude")]),
  configDirectory: absolutePathSchema.optional(),
  initializationTimeoutMs: z.number().int().min(1).max(600_000),
});
export const claudeRuntimeInitializeResponseSchema = z.strictObject({
  initialized: z.literal(true),
  configDirectory: absolutePathSchema,
});

export const claudeRuntimeAccountSchema = z.strictObject({
  subscriptionType: optionalBoundedStringSchema,
  tokenSource: optionalBoundedStringSchema,
  apiKeySource: optionalBoundedStringSchema,
  apiProvider: z
    .enum([
      "firstParty",
      "bedrock",
      "vertex",
      "foundry",
      "anthropicAws",
      "anthropicGoogleCloud",
      "mantle",
      "gateway",
    ])
    .optional(),
});

export const claudeRuntimeModelInfoSchema = z.strictObject({
  value: boundedStringSchema,
  resolvedModel: optionalBoundedStringSchema,
  displayName: boundedStringSchema,
  description: z.string().max(65_536),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(effortSchema).max(5).optional(),
  supportsAdaptiveThinking: z.boolean().optional(),
  supportedDialogKinds: z.array(boundedStringSchema).max(64).optional(),
});

export const claudeRuntimeSlashCommandSchema = z.strictObject({
  name: boundedStringSchema,
  description: z.string().max(65_536),
  argumentHint: boundedStringSchema,
  aliases: z.array(boundedStringSchema).max(128).optional(),
});

export const claudeRuntimeInitializationSchema = z.strictObject({
  models: z.array(claudeRuntimeModelInfoSchema).max(256),
  commands: z.array(claudeRuntimeSlashCommandSchema).max(4_096),
  skillNames: z.array(boundedStringSchema).max(4_096),
  terminalCommandNames: z.array(boundedStringSchema).max(4_096),
  account: claudeRuntimeAccountSchema,
  actualModel: optionalBoundedStringSchema,
  actualPermissionMode: permissionModeSchema,
  cliRelease: boundedStringSchema,
});

export const claudeRuntimeProbeRequestSchema = z.strictObject({
  cwd: absolutePathSchema,
});
export const claudeRuntimeProbeResponseSchema = z.strictObject({
  cliRelease: boundedStringSchema,
  account: claudeRuntimeAccountSchema,
  models: z.array(claudeRuntimeModelInfoSchema).max(256),
  commands: z.array(claudeRuntimeSlashCommandSchema).max(4_096),
  skillNames: z.array(boundedStringSchema).max(4_096),
  terminalCommandNames: z.array(boundedStringSchema).max(4_096),
});

export const claudeRuntimeSessionInfoSchema = z.strictObject({
  sessionId: uuidSchema,
  summary: z.string().max(1_048_576),
  lastModified: nonnegativeSafeIntegerSchema,
  fileSize: nonnegativeSafeIntegerSchema.optional(),
  customTitle: z.string().max(1_048_576).optional(),
  firstPrompt: z
    .string()
    .max(8 * 1024 * 1024)
    .optional(),
  gitBranch: boundedStringSchema.optional(),
  cwd: absolutePathSchema.optional(),
  tag: boundedStringSchema.optional(),
  createdAt: nonnegativeSafeIntegerSchema.optional(),
});

export const claudeRuntimeSessionMessageSchema = z.strictObject({
  type: z.enum(["user", "assistant", "system"]),
  uuid: uuidSchema,
  session_id: uuidSchema,
  message: boundedJsonValueSchema,
  parent_tool_use_id: z.string().max(256).nullable(),
  parent_agent_id: z.string().max(256).nullable(),
  origin: boundedJsonValueSchema.optional(),
  timestamp: z.iso.datetime().optional(),
  /** Claude Code's compaction summary; the SDK carries it on history rows. */
  isCompactSummary: z.literal(true).optional(),
});

export const claudeRuntimeSessionListRequestSchema = z.strictObject({
  dir: absolutePathSchema.optional(),
  limit: z.number().int().min(1).max(10_001).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
  includeWorktrees: z.boolean().optional(),
  includeProgrammatic: z.boolean().optional(),
});
export const claudeRuntimeSessionListResponseSchema = z.strictObject({
  sessions: z.array(claudeRuntimeSessionInfoSchema).max(10_001),
});
export const claudeRuntimeSessionInfoRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  dir: absolutePathSchema.optional(),
});
export const claudeRuntimeSessionInfoResponseSchema = z.strictObject({
  session: claudeRuntimeSessionInfoSchema.nullable(),
});
export const claudeRuntimeSessionTranscriptRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  dir: absolutePathSchema,
});
export const claudeRuntimeSessionTranscriptResponseSchema = z.strictObject({
  present: z.boolean(),
});
const claudeHistoryCursorSchema = z.strictObject({
  offset: nonnegativeSafeIntegerSchema,
  end: positiveSafeIntegerSchema,
  snapshotId: uuidSchema,
}).refine(value => value.offset < value.end);
export const claudeRuntimeSessionMessagesRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  dir: absolutePathSchema.optional(),
  limit: positiveSafeIntegerSchema.optional(),
  offset: nonnegativeSafeIntegerSchema.optional(),
  includeSystemMessages: z.boolean().optional(),
  cursor: claudeHistoryCursorSchema.optional(),
  maintenance: z.boolean().optional(),
});
export const claudeRuntimeSessionMessagesResponseSchema = z.strictObject({
  messages: z.array(claudeRuntimeSessionMessageSchema).max(CLAUDE_HISTORY_PAGE_MESSAGES),
  nextCursor: claudeHistoryCursorSchema.nullable(),
});
export const claudeRuntimeSessionRenameRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  title: z.string().min(1).max(16_384),
  dir: absolutePathSchema,
});
export const claudeRuntimeSessionRenameResponseSchema = z.strictObject({
  renamed: z.literal(true),
});
const queryLaunchSchema = z.discriminatedUnion("launch", [
  z.strictObject({ launch: z.literal("new") }),
  z.strictObject({ launch: z.literal("resume") }),
  z.strictObject({
    launch: z.literal("fork"),
    sourceSessionId: uuidSchema,
    resumeSessionAt: uuidSchema,
  }),
]);
export const claudeRuntimeQueryOpenRequestSchema = z
  .intersection(
    z.strictObject({
      queryId: uuidSchema,
      sessionId: uuidSchema,
      cwd: absolutePathSchema,
      title: z.string().min(1).max(16_384).optional(),
      model: boundedStringSchema.optional(),
      effort: effortSchema.optional(),
      permissionMode: permissionModeSchema.optional(),
      allowDangerouslySkipPermissions: z.literal(true).optional(),
      enableCanUseTool: z.boolean(),
      environment: claudeRuntimeQueryEnvironmentSchema,
      agentToolMcp: claudeRuntimeAgentToolMcpSchema.optional(),
      executionEnvironment: resolvedEnvironmentVariablesSchema.optional(),
    }),
    queryLaunchSchema,
  )
  .refine(
    (request) =>
      request.agentToolMcp === undefined ||
      Object.keys(request.environment).length === 0,
    "A query presents Sedes tools through the CLI or MCP, never both.",
  )
  .refine(
    (request) =>
      request.launch !== "fork" ||
      (request.permissionMode === undefined &&
        request.allowDangerouslySkipPermissions === undefined &&
        !request.enableCanUseTool &&
        request.agentToolMcp === undefined &&
        Object.keys(request.environment).length === 0),
    "A fork launch owns its locked-down permissions and presents no tools.",
  );
/**
 * One locked-down fork launch: copy the retained source prefix into the
 * application-reserved child session, confirm the launch, and exit.
 */
export const claudeRuntimeForkRequestSchema = z
  .strictObject({
    sessionId: uuidSchema,
    sourceSessionId: uuidSchema,
    resumeSessionAt: uuidSchema,
    cwd: absolutePathSchema,
    title: z.string().min(1).max(16_384).optional(),
    model: boundedStringSchema.min(1),
    effort: effortSchema.optional(),
    executionEnvironment: resolvedEnvironmentVariablesSchema.optional(),
  })
  .refine(
    (request) => request.sessionId !== request.sourceSessionId,
    "A fork child needs its own session identity.",
  );
export const claudeRuntimeForkResponseSchema = z.strictObject({
  cliRelease: boundedStringSchema,
});
export const claudeRuntimeQueryOpenResponseSchema = z.strictObject({
  queryId: uuidSchema,
  startupProbeUuid: uuidSchema,
  initialization: claudeRuntimeInitializationSchema,
});
export const claudeRuntimeQuerySendRequestSchema = z.strictObject({
  queryId: uuidSchema,
  operationId: uuidSchema,
  content: boundedJsonValueSchema,
  shouldQuery: z.boolean().optional(),
  priority: z.literal("next").optional(),
});
export const claudeRuntimeQuerySendResponseSchema = z.strictObject({
  accepted: z.literal(true),
});
const queryIdRequestSchema = z.strictObject({ queryId: uuidSchema });
export const claudeRuntimeQueryInterruptResponseSchema = z.strictObject({
  receipt: z
    .strictObject({
      still_queued: z.array(uuidSchema).max(4_096),
      cancelled: z.array(uuidSchema).max(4_096).optional(),
    })
    .nullable(),
});
export const claudeRuntimeQuerySetModelRequestSchema = z.strictObject({
  queryId: uuidSchema,
  model: boundedStringSchema.nullable(),
});
export const claudeRuntimeQuerySetEffortRequestSchema = z.strictObject({
  queryId: uuidSchema,
  effort: effortSchema.nullable(),
});
export const claudeRuntimeQuerySetPermissionModeRequestSchema = z.strictObject({
  queryId: uuidSchema,
  permissionMode: permissionModeSchema,
});
const updatedResponseSchema = z.strictObject({ updated: z.literal(true) });
export const claudeRuntimeQueryCloseResponseSchema = z.strictObject({
  closed: z.literal(true),
});

export const claudeRuntimeQueryMessageEventSchema = z.strictObject({
  queryId: uuidSchema,
  message: boundedJsonObjectSchema.refine(
    (message) =>
      typeof message.type === "string" &&
      typeof message.session_id === "string" &&
      uuidSchema.safeParse(message.session_id).success,
    "A routed Claude SDK message is required.",
  ),
});
export const claudeRuntimeQueryFailedEventSchema = z.strictObject({
  queryId: uuidSchema,
  code: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z][a-z0-9_.-]*$/u),
});

const permissionUpdateSchema = boundedJsonObjectSchema;
export const claudeRuntimeCanUseToolRequestSchema = z.strictObject({
  queryId: uuidSchema,
  toolName: boundedStringSchema,
  input: boundedJsonObjectSchema,
  options: z.strictObject({
    suggestions: z.array(permissionUpdateSchema).max(256).optional(),
    blockedPath: z.string().max(4_096).optional(),
    decisionReason: z.string().max(65_536).optional(),
    defaultToNo: z.boolean().optional(),
    suppressAlwaysAllowRule: z.boolean().optional(),
    mcpServer: z
      .strictObject({
        name: z.string().min(1).max(512),
        source: z.string().min(1).max(120),
      })
      .optional(),
    title: z.string().max(65_536).optional(),
    displayName: boundedStringSchema.optional(),
    description: z.string().max(65_536).optional(),
    toolUseID: boundedStringSchema,
    agentID: boundedStringSchema.optional(),
    requestId: boundedStringSchema,
    matchedAskRule: z
      .strictObject({
        source: boundedStringSchema,
        toolName: boundedStringSchema,
        ruleContent: z.string().max(65_536).optional(),
      })
      .optional(),
  }),
});
export const claudeRuntimeCanUseToolResponseSchema = z.discriminatedUnion(
  "behavior",
  [
    z.strictObject({
      behavior: z.literal("allow"),
      updatedInput: boundedJsonObjectSchema.optional(),
      updatedPermissions: z.array(permissionUpdateSchema).max(256).optional(),
      toolUseID: boundedStringSchema.optional(),
      decisionClassification: z
        .enum(["user_temporary", "user_permanent", "user_reject"])
        .optional(),
    }),
    z.strictObject({
      behavior: z.literal("deny"),
      message: z.string().max(65_536),
      interrupt: z.boolean().optional(),
      toolUseID: boundedStringSchema.optional(),
      decisionClassification: z
        .enum(["user_temporary", "user_permanent", "user_reject"])
        .optional(),
    }),
  ],
);
export const claudeRuntimePermissionResponseAckRequestSchema = z.strictObject({
  queryId: uuidSchema,
  requestId: boundedStringSchema,
  toolUseID: boundedStringSchema,
  adopted: z.boolean(),
});
export const claudeRuntimePermissionResponseAckResponseSchema = z.strictObject({
  acknowledged: z.literal(true),
});

function operation<Request, Response>(input: {
  readonly operation: string;
  readonly requestSchema: z.ZodType<Request>;
  readonly responseSchema: z.ZodType<Response>;
  readonly maximumDeadlineMilliseconds: number | "caller_abort";
  readonly lane: "control" | "operation";
}) {
  return defineSidecarOperation({
    capabilityId: CLAUDE_RUNTIME_CAPABILITY_ID,
    majorVersion: CLAUDE_RUNTIME_MAJOR_VERSION,
    ...input,
  });
}

export const claudeRuntimeProbeOperation = operation({
  operation: "runtime.probe",
  requestSchema: claudeRuntimeProbeRequestSchema,
  responseSchema: claudeRuntimeProbeResponseSchema,
  maximumDeadlineMilliseconds: "caller_abort",
  lane: "control",
});
export const claudeRuntimeInitializeOperation = operation({
  operation: "runtime.initialize",
  requestSchema: claudeRuntimeInitializeRequestSchema,
  responseSchema: claudeRuntimeInitializeResponseSchema,
  maximumDeadlineMilliseconds: "caller_abort",
  lane: "control",
});
export const claudeRuntimeSessionListOperation = operation({
  operation: "session.list",
  requestSchema: claudeRuntimeSessionListRequestSchema,
  responseSchema: claudeRuntimeSessionListResponseSchema,
  maximumDeadlineMilliseconds: 60_000,
  lane: "operation",
});
export const claudeRuntimeSessionInfoOperation = operation({
  operation: "session.info",
  requestSchema: claudeRuntimeSessionInfoRequestSchema,
  responseSchema: claudeRuntimeSessionInfoResponseSchema,
  maximumDeadlineMilliseconds: 60_000,
  lane: "operation",
});
export const claudeRuntimeSessionMessagesOperation = operation({
  operation: "session.messages",
  requestSchema: claudeRuntimeSessionMessagesRequestSchema,
  responseSchema: claudeRuntimeSessionMessagesResponseSchema,
  maximumDeadlineMilliseconds: 120_000,
  lane: "operation",
});
export const claudeRuntimeSessionTranscriptOperation = operation({
  operation: "session.transcript",
  requestSchema: claudeRuntimeSessionTranscriptRequestSchema,
  responseSchema: claudeRuntimeSessionTranscriptResponseSchema,
  maximumDeadlineMilliseconds: 60_000,
  lane: "operation",
});
export const claudeRuntimeSessionRenameOperation = operation({
  operation: "session.rename",
  requestSchema: claudeRuntimeSessionRenameRequestSchema,
  responseSchema: claudeRuntimeSessionRenameResponseSchema,
  maximumDeadlineMilliseconds: 60_000,
  lane: "operation",
});
export const claudeRuntimeQueryOpenOperation = operation({
  operation: "query.open",
  requestSchema: claudeRuntimeQueryOpenRequestSchema,
  responseSchema: claudeRuntimeQueryOpenResponseSchema,
  maximumDeadlineMilliseconds: "caller_abort",
  lane: "operation",
});
export const claudeRuntimeQuerySendOperation = operation({
  operation: "query.send",
  requestSchema: claudeRuntimeQuerySendRequestSchema,
  responseSchema: claudeRuntimeQuerySendResponseSchema,
  maximumDeadlineMilliseconds: 30_000,
  lane: "operation",
});
export const claudeRuntimeQueryInterruptOperation = operation({
  operation: "query.interrupt",
  requestSchema: queryIdRequestSchema,
  responseSchema: claudeRuntimeQueryInterruptResponseSchema,
  maximumDeadlineMilliseconds: 30_000,
  lane: "control",
});
export const claudeRuntimeQuerySetModelOperation = operation({
  operation: "query.set_model",
  requestSchema: claudeRuntimeQuerySetModelRequestSchema,
  responseSchema: updatedResponseSchema,
  maximumDeadlineMilliseconds: 30_000,
  lane: "control",
});
export const claudeRuntimeQuerySetEffortOperation = operation({
  operation: "query.set_effort",
  requestSchema: claudeRuntimeQuerySetEffortRequestSchema,
  responseSchema: updatedResponseSchema,
  maximumDeadlineMilliseconds: 30_000,
  lane: "control",
});
export const claudeRuntimeQuerySetPermissionModeOperation = operation({
  operation: "query.set_permission_mode",
  requestSchema: claudeRuntimeQuerySetPermissionModeRequestSchema,
  responseSchema: updatedResponseSchema,
  maximumDeadlineMilliseconds: 30_000,
  lane: "control",
});
export const claudeRuntimeQueryCloseOperation = operation({
  operation: "query.close",
  requestSchema: queryIdRequestSchema,
  responseSchema: claudeRuntimeQueryCloseResponseSchema,
  maximumDeadlineMilliseconds: 30_000,
  lane: "control",
});
export const claudeRuntimeCanUseToolOperation = operation({
  operation: "query.can_use_tool",
  requestSchema: claudeRuntimeCanUseToolRequestSchema,
  responseSchema: claudeRuntimeCanUseToolResponseSchema,
  maximumDeadlineMilliseconds: "caller_abort",
  lane: "operation",
});
export const claudeRuntimePermissionResponseAckOperation = operation({
  operation: "query.permission_response_ack",
  requestSchema: claudeRuntimePermissionResponseAckRequestSchema,
  responseSchema: claudeRuntimePermissionResponseAckResponseSchema,
  maximumDeadlineMilliseconds: 30_000,
  lane: "control",
});

export const claudeRuntimeWorkerOperations = Object.freeze([
  claudeRuntimeInitializeOperation,
  claudeRuntimeProbeOperation,
  claudeRuntimeSessionListOperation,
  claudeRuntimeSessionInfoOperation,
  claudeRuntimeSessionMessagesOperation,
  claudeRuntimeSessionTranscriptOperation,
  claudeRuntimeSessionRenameOperation,
  claudeRuntimeQueryOpenOperation,
  claudeRuntimeQuerySendOperation,
  claudeRuntimeQueryInterruptOperation,
  claudeRuntimeQuerySetModelOperation,
  claudeRuntimeQuerySetEffortOperation,
  claudeRuntimeQuerySetPermissionModeOperation,
  claudeRuntimeQueryCloseOperation,
]);
export const claudeRuntimeHostOperations = Object.freeze([
  claudeRuntimeCanUseToolOperation,
  claudeRuntimePermissionResponseAckOperation,
]);

type HandlerFor<Definition> = Definition extends {
  readonly requestSchema: z.ZodType<infer Request>;
  readonly responseSchema: z.ZodType<infer Response>;
}
  ? SidecarOperationHandler<Request, Response>
  : never;

export interface ClaudeRuntimeV1WorkerHandlers {
  readonly initialize: HandlerFor<typeof claudeRuntimeInitializeOperation>;
  readonly probe: HandlerFor<typeof claudeRuntimeProbeOperation>;
  readonly listSessions: HandlerFor<typeof claudeRuntimeSessionListOperation>;
  readonly getSessionInfo: HandlerFor<typeof claudeRuntimeSessionInfoOperation>;
  readonly getSessionMessages: HandlerFor<
    typeof claudeRuntimeSessionMessagesOperation
  >;
  readonly hasSessionTranscript: HandlerFor<
    typeof claudeRuntimeSessionTranscriptOperation
  >;
  readonly renameSession: HandlerFor<
    typeof claudeRuntimeSessionRenameOperation
  >;
  readonly openQuery: HandlerFor<typeof claudeRuntimeQueryOpenOperation>;
  readonly sendQuery: HandlerFor<typeof claudeRuntimeQuerySendOperation>;
  readonly interruptQuery: HandlerFor<
    typeof claudeRuntimeQueryInterruptOperation
  >;
  readonly setQueryModel: HandlerFor<
    typeof claudeRuntimeQuerySetModelOperation
  >;
  readonly setQueryEffort: HandlerFor<
    typeof claudeRuntimeQuerySetEffortOperation
  >;
  readonly setQueryPermissionMode: HandlerFor<
    typeof claudeRuntimeQuerySetPermissionModeOperation
  >;
  readonly closeQuery: HandlerFor<typeof claudeRuntimeQueryCloseOperation>;
}

export function registerClaudeRuntimeV1WorkerOperations(
  registry: SidecarOperationRegistry,
  handlers: ClaudeRuntimeV1WorkerHandlers,
): void {
  registry.register(claudeRuntimeInitializeOperation, handlers.initialize);
  registry.register(claudeRuntimeProbeOperation, handlers.probe);
  registry.register(claudeRuntimeSessionListOperation, handlers.listSessions);
  registry.register(claudeRuntimeSessionInfoOperation, handlers.getSessionInfo);
  registry.register(
    claudeRuntimeSessionMessagesOperation,
    handlers.getSessionMessages,
  );
  registry.register(
    claudeRuntimeSessionTranscriptOperation,
    handlers.hasSessionTranscript,
  );
  registry.register(
    claudeRuntimeSessionRenameOperation,
    handlers.renameSession,
  );
  registry.register(claudeRuntimeQueryOpenOperation, handlers.openQuery);
  registry.register(claudeRuntimeQuerySendOperation, handlers.sendQuery);
  registry.register(
    claudeRuntimeQueryInterruptOperation,
    handlers.interruptQuery,
  );
  registry.register(
    claudeRuntimeQuerySetModelOperation,
    handlers.setQueryModel,
  );
  registry.register(
    claudeRuntimeQuerySetEffortOperation,
    handlers.setQueryEffort,
  );
  registry.register(
    claudeRuntimeQuerySetPermissionModeOperation,
    handlers.setQueryPermissionMode,
  );
  registry.register(claudeRuntimeQueryCloseOperation, handlers.closeQuery);
}

export function registerClaudeRuntimeV1HostOperations(
  registry: SidecarOperationRegistry,
  handlers: {
    readonly canUseTool: HandlerFor<typeof claudeRuntimeCanUseToolOperation>;
    readonly acknowledgePermissionResponse: HandlerFor<
      typeof claudeRuntimePermissionResponseAckOperation
    >;
  },
): void {
  registry.register(claudeRuntimeCanUseToolOperation, handlers.canUseTool);
  registry.register(
    claudeRuntimePermissionResponseAckOperation,
    handlers.acknowledgePermissionResponse,
  );
}

export type ClaudeRuntimeQueryMessageEvent = z.infer<
  typeof claudeRuntimeQueryMessageEventSchema
>;
export type ClaudeRuntimeQueryFailedEvent = z.infer<
  typeof claudeRuntimeQueryFailedEventSchema
>;
export type ClaudeRuntimeCanUseToolRequest = z.infer<
  typeof claudeRuntimeCanUseToolRequestSchema
>;
export type ClaudeRuntimeCanUseToolResponse = z.infer<
  typeof claudeRuntimeCanUseToolResponseSchema
>;
export type ClaudeRuntimePermissionResponseAckRequest = z.infer<
  typeof claudeRuntimePermissionResponseAckRequestSchema
>;
