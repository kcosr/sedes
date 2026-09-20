import { Type } from "typebox";
import {
  TASK_DETAILS_MAX_CHARACTERS,
  TASK_FILES_MAX_COUNT,
  TASK_FILE_MAX_PATH_BYTES,
  TASK_QUERY_MAX_CHARACTERS,
} from "../../../shared/protocol/tasks.js";
import { AGENT_TOOL_JSON_SCHEMA_DIALECT } from "../schema/canonical-json-schema.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-agent-tool-request-error.js";

export const identifierSchema = Type.String({ minLength: 1, maxLength: 128 });
export const targetIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 160,
});
export const cursorSchema = Type.String({ minLength: 1, maxLength: 2_048 });
export const pageSizeSchema = Type.Integer({ minimum: 1, maximum: 100 });
export const isoDateSchema = Type.String({ minLength: 20, maxLength: 40 });
export const threadTitleSchema = Type.String({ minLength: 1, maxLength: 240 });
export const taskTitleSchema = Type.String({ minLength: 1, maxLength: 240 });
export const taskDetailsSchema = Type.String({
  maxLength: TASK_DETAILS_MAX_CHARACTERS,
});
export const taskQuerySchema = Type.String({
  minLength: 1,
  maxLength: TASK_QUERY_MAX_CHARACTERS,
  description:
    "Nonblank ASCII-case-insensitive substring matched against task titles and details; non-ASCII characters match exactly.",
});
export const taskFilesSchema = Type.Array(
  Type.String({
    minLength: 1,
    maxLength: TASK_FILE_MAX_PATH_BYTES,
    description:
      "Absolute POSIX metadata path; the authoritative task protocol also enforces the 4096-byte UTF-8 limit and rejects NUL.",
  }),
  { maxItems: TASK_FILES_MAX_COUNT, uniqueItems: true },
);

export const taskScopeSchema = Type.Union([
  Type.Object(
    { kind: Type.String({ enum: ["global"], maxLength: 9 }) },
    { additionalProperties: false, maxProperties: 1 },
  ),
  Type.Object(
    {
      kind: Type.String({ enum: ["workspace"], maxLength: 9 }),
      workspaceId: identifierSchema,
    },
    { additionalProperties: false, maxProperties: 2 },
  ),
  Type.Object(
    {
      kind: Type.String({ enum: ["thread"], maxLength: 9 }),
      threadId: identifierSchema,
    },
    { additionalProperties: false, maxProperties: 2 },
  ),
]);

export const taskTargetScopeSchema = Type.Union([
  Type.Object(
    { kind: Type.String({ enum: ["global"], maxLength: 9 }) },
    { additionalProperties: false, maxProperties: 1 },
  ),
  Type.Object(
    {
      kind: Type.String({ enum: ["workspace"], maxLength: 9 }),
      workspaceId: Type.Optional(identifierSchema),
    },
    { additionalProperties: false, maxProperties: 2 },
  ),
  Type.Object(
    {
      kind: Type.String({ enum: ["thread"], maxLength: 9 }),
      threadId: Type.Optional(identifierSchema),
    },
    { additionalProperties: false, maxProperties: 2 },
  ),
]);

const taskOutputProperties = {
  id: identifierSchema,
  scope: taskScopeSchema,
  title: taskTitleSchema,
  details: taskDetailsSchema,
  pinned: Type.Boolean(),
  files: taskFilesSchema,
  completedAt: Type.Union([isoDateSchema, Type.Null()]),
  revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
} as const;

export const nestedTaskOutputSchema = Type.Object(
  {
    ...taskOutputProperties,
    associatedWorkspaceId: Type.Union([identifierSchema, Type.Null()], {
      description:
        "Read-only authoritative workspace association; null only for global tasks.",
    }),
  },
  { additionalProperties: false, maxProperties: 11 },
);

export const taskOutputSchema = Type.Object(taskOutputProperties, {
  $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
  additionalProperties: false,
  maxProperties: 10,
});

export function resolveTaskTargetScope(
  input: {
    readonly kind: "global" | "workspace" | "thread";
    readonly workspaceId?: string;
    readonly threadId?: string;
  },
  caller: {
    readonly defaults: {
      readonly workspaceId?: string;
      readonly threadId?: string;
    };
  },
) {
  if (input.kind === "global") return { kind: "global" as const };
  if (input.kind === "workspace") {
    const workspaceId = input.workspaceId ?? caller.defaults.workspaceId;
    if (!workspaceId) throw missingCallerDefault();
    return { kind: "workspace" as const, workspaceId };
  }
  const threadId = input.threadId ?? caller.defaults.threadId;
  if (!threadId) throw missingCallerDefault();
  return { kind: "thread" as const, threadId };
}

function missingCallerDefault(): CanonicalAgentToolRequestError {
  return new CanonicalAgentToolRequestError(
    "invalid_input",
    "The requested operation requires a configured caller default.",
  );
}

export const sharedAdapters = {
  pi_sdk: 30_000,
  http: 30_000,
  cli: 30_000,
} as const;
