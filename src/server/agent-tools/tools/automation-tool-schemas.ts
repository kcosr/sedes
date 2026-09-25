import { Type } from "typebox";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";

const isoDate = () => Type.String({ minLength: 20, maxLength: 40 });
const id = () => Type.String({ minLength: 1, maxLength: 128 });

export const automationScheduleToolSchema = Type.Union([
  Type.Object(
    {
      kind: Type.String({ maxLength: 9, enum: ["date_time"] }),
      runAt: isoDate(),
    },
    { additionalProperties: false, maxProperties: 2 },
  ),
  Type.Object(
    {
      kind: Type.String({ maxLength: 8, enum: ["interval"] }),
      anchorAt: isoDate(),
      everySeconds: Type.Integer({ minimum: 300, maximum: 31_536_000 }),
    },
    { additionalProperties: false, maxProperties: 3 },
  ),
  Type.Object(
    {
      kind: Type.String({ maxLength: 4, enum: ["cron"] }),
      expression: Type.String({ minLength: 1, maxLength: 160 }),
      timeZone: Type.String({ minLength: 1, maxLength: 120 }),
    },
    { additionalProperties: false, maxProperties: 3 },
  ),
]);

export const automationPrecheckToolSchema = Type.Object(
  {
    command: Type.String({ minLength: 1, maxLength: 4_096 }),
    timeoutSeconds: Type.Integer({ minimum: 1, maximum: 60 }),
    includeStdout: Type.Boolean(),
  },
  { additionalProperties: false, maxProperties: 3 },
);

const lastRunSchema = Type.Object(
  {
    id: id(),
    state: Type.String({
      maxLength: 16,
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
    }),
    occurrence: Type.String({
      maxLength: 9,
      enum: ["scheduled", "manual"],
    }),
    scheduledFor: isoDate(),
    finishedAt: Type.Optional(isoDate()),
    resultThreadId: Type.Optional(id()),
    errorCode: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  },
  { additionalProperties: false, maxProperties: 7 },
);

export const automationDefinitionToolOutputSchema =
  normalizeCanonicalAgentToolSchema(
    Type.Object(
      {
        status: Type.String({ maxLength: 7, enum: ["enabled", "paused"] }),
        runMode: Type.String({
          maxLength: 11,
          enum: ["same_thread", "clone"],
        }),
        scheduleKind: Type.String({
          maxLength: 9,
          enum: ["date_time", "interval", "cron"],
        }),
        nextRunAt: Type.Optional(isoDate()),
        lastRun: Type.Optional(lastRunSchema),
        revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        createdAt: isoDate(),
        updatedAt: isoDate(),
        hasPrecheck: Type.Boolean(),
        prompt: Type.String({ minLength: 1, maxLength: 65_536 }),
        schedule: automationScheduleToolSchema,
        misfirePolicy: Type.String({
          maxLength: 8,
          enum: ["coalesce", "skip"],
        }),
        precheck: Type.Union([automationPrecheckToolSchema, Type.Null()]),
        upcoming: Type.Array(isoDate(), { maxItems: 5 }),
      },
      {
        $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
        additionalProperties: false,
        maxProperties: 14,
      },
    ),
  );

const runPrecheckSchema = Type.Object(
  {
    status: Type.String({
      maxLength: 8,
      enum: ["pending", "checking", "passed", "skipped", "failed"],
    }),
    durationMilliseconds: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    stdoutBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    stdoutIncluded: Type.Boolean(),
    exitCode: Type.Optional(
      Type.Integer({ minimum: -2_147_483_648, maximum: 2_147_483_647 }),
    ),
  },
  { additionalProperties: false, maxProperties: 5 },
);

export const automationRunToolSchema = Type.Object(
  {
    id: id(),
    occurrence: Type.String({
      maxLength: 9,
      enum: ["scheduled", "manual"],
    }),
    scheduledFor: isoDate(),
    state: Type.String({
      maxLength: 16,
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
    }),
    runMode: Type.String({
      maxLength: 11,
      enum: ["same_thread", "clone"],
    }),
    resultThreadId: Type.Optional(id()),
    coalescedCount: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    errorCode: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    diagnostic: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    claimedAt: Type.Optional(isoDate()),
    startedAt: Type.Optional(isoDate()),
    acceptedAt: Type.Optional(isoDate()),
    finishedAt: Type.Optional(isoDate()),
    precheck: Type.Optional(runPrecheckSchema),
  },
  { additionalProperties: false, maxProperties: 14 },
);

export function automationToolInputSchema(
  properties: Parameters<typeof Type.Object>[0],
  options?: { readonly minProperties?: number },
) {
  return normalizeCanonicalAgentToolSchema(
    Type.Object(properties, {
      $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
      additionalProperties: false,
      ...(options?.minProperties === undefined
        ? {}
        : { minProperties: options.minProperties }),
      maxProperties: Object.keys(properties).length,
    }),
  );
}

export const optionalAutomationThreadId = Type.Optional(id());

export function automationToolPresentations(input: {
  readonly piName: string;
  readonly label: string;
  readonly promptSnippet: string;
  readonly command: string;
}) {
  return {
    pi: {
      name: input.piName,
      label: input.label,
      promptSnippet: input.promptSnippet,
    },
    mcp: { name: input.piName },
    http: { invocation: "inline" as const },
    cli: { command: input.command },
  };
}

export const automationToolExposure = {
  adapters: ["pi_sdk", "mcp", "http", "cli"],
} as const;

export const automationReadWaitCeilings = {
  pi_sdk: 30_000,
  mcp: 30_000,
  http: 30_000,
  cli: 30_000,
} as const;

export const automationRunWaitCeilings = {
  pi_sdk: 90_000,
  mcp: 90_000,
  http: 90_000,
  cli: 90_000,
} as const;
