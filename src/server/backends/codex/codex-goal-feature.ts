import { createHash } from "node:crypto";
import { z } from "zod";
import type { BoundedValue } from "../../../shared/protocol/payload.js";
import { boundValue } from "../../conversations/payload-policy.js";
import type {
  ProviderFeatureModule,
  ProviderFeatureOperationDefinition,
} from "../../provider-features/contracts.js";

/**
 * Provider-feature mutations carry BoundedValue arguments on the wire. These
 * helpers recover the closed logical Goal action shapes from that envelope.
 */
function decodeBoundedObject(
  value: BoundedValue,
): Readonly<Record<string, BoundedValue>> | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "object"
  ) {
    return undefined;
  }
  return Object.fromEntries(
    value.entries.map(({ key, value: entry }) => [key.text, entry]),
  );
}

function decodeBoundedText(value: BoundedValue | undefined): string | undefined {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    !("text" in value) ||
    typeof value.text !== "string"
  ) {
    return undefined;
  }
  return value.text;
}

export const CODEX_GOAL_FEATURE_REF = Object.freeze({
  featureId: "codex.goal",
  schemaVersion: 1,
} as const);

/** Product bound matching Codex MAX_THREAD_GOAL_OBJECTIVE_CHARS. */
export const CODEX_GOAL_OBJECTIVE_MAX_SCALARS = 4_000;
/** Sedes browser-safe UTF-8 bound for Goal objectives. */
export const CODEX_GOAL_OBJECTIVE_MAX_UTF8_BYTES = 16 * 1_024;

export const codexGoalStatusV1Schema = z.enum([
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
]);
export type CodexGoalStatusV1 = z.infer<typeof codexGoalStatusV1Schema>;

const utf8Encoder = new TextEncoder();

/**
 * Exact product normalization: Unicode trim, then non-empty, scalar, and
 * UTF-8 bounds. Matches Codex `trim` + `validate_thread_goal_objective` with
 * the additional Sedes 16 KiB UTF-8 ceiling.
 */
export function normalizeCodexGoalObjective(raw: string): string {
  return raw.trim();
}

export function validateNormalizedCodexGoalObjective(
  objective: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (objective.length === 0) {
    return { ok: false, reason: "goal objective must not be empty" };
  }
  const scalars = [...objective].length;
  if (scalars > CODEX_GOAL_OBJECTIVE_MAX_SCALARS) {
    return {
      ok: false,
      reason: `goal objective must be at most ${CODEX_GOAL_OBJECTIVE_MAX_SCALARS} characters`,
    };
  }
  const bytes = utf8Encoder.encode(objective).byteLength;
  if (bytes > CODEX_GOAL_OBJECTIVE_MAX_UTF8_BYTES) {
    return {
      ok: false,
      reason: `goal objective must be at most ${CODEX_GOAL_OBJECTIVE_MAX_UTF8_BYTES} UTF-8 bytes`,
    };
  }
  return { ok: true };
}

export const codexGoalStateV1Schema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("unset"),
    })
    .strict(),
  z
    .object({
      state: z.literal("set"),
      objective: z.string().min(1),
      status: codexGoalStatusV1Schema,
    })
    .strict()
    .superRefine((value, context) => {
      const validated = validateNormalizedCodexGoalObjective(value.objective);
      if (!validated.ok) {
        context.addIssue({
          code: "custom",
          message: validated.reason,
          path: ["objective"],
        });
      }
    }),
]);
export type CodexGoalStateV1 = z.infer<typeof codexGoalStateV1Schema>;

/** Logical empty object `{}` encoded as a BoundedValue object with no entries. */
const emptyObjectSchema = z
  .custom((value) => {
    if (value === null || typeof value !== "object") return false;
    // Accept already-decoded empty plain object from internal callers.
    if (!("kind" in value)) {
      return Object.keys(value).length === 0;
    }
    const decoded = decodeBoundedObject(value as BoundedValue);
    return decoded !== undefined && Object.keys(decoded).length === 0;
  }, "Expected an empty object")
  .transform(() => ({} as Record<string, never>));

function extractCreateObjective(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if ("kind" in value) {
    const decoded = decodeBoundedObject(value as BoundedValue);
    if (!decoded || Object.keys(decoded).length !== 1) return undefined;
    return decodeBoundedText(decoded.objective);
  }
  if (
    "objective" in value &&
    typeof (value as { objective?: unknown }).objective === "string" &&
    Object.keys(value).length === 1
  ) {
    return (value as { objective: string }).objective;
  }
  return undefined;
}

const createArgumentsSchema = z
  .custom<{ readonly objective: string }>((value) => {
    const objective = extractCreateObjective(value);
    if (objective === undefined) return false;
    const normalized = normalizeCodexGoalObjective(objective);
    return validateNormalizedCodexGoalObjective(normalized).ok;
  }, "Expected { objective }")
  .transform((value) => {
    const objective = extractCreateObjective(value)!;
    return { objective: normalizeCodexGoalObjective(objective) };
  });

/** Parse and normalize create arguments (BoundedValue or plain object). */
export function parseCodexGoalCreateObjective(argumentsValue: unknown): string {
  return createArgumentsSchema.parse(argumentsValue).objective;
}

function operation<Arguments>(
  actionId: string,
  label: string,
  argumentsSchema: z.ZodType<Arguments>,
  effects: ProviderFeatureOperationDefinition<Arguments>["effects"],
): ProviderFeatureOperationDefinition<Arguments> {
  return {
    actionId,
    label: { text: label },
    argumentsSchema,
    effects,
    confirmation: "none",
    execution: "durable",
  };
}

export const codexGoalFeatureModule = Object.freeze({
  ref: CODEX_GOAL_FEATURE_REF,
  backendKind: "codex_app_server",
  kind: "stateful",
  label: { text: "Goal" },
  description: {
    text: "Persistent Codex thread goal: create, pause, resume, and clear.",
  },
  presentationSlots: ["composer_action"],
  stateSchema: codexGoalStateV1Schema,
  projectState(state: CodexGoalStateV1): BoundedValue {
    return boundValue(state);
  },
  operations: [
    operation("create", "Start goal", createArgumentsSchema, {
      application: "write",
      modelUsage: "agent_execution",
      external: "durable_side_effect",
    }),
    operation("pause", "Pause", emptyObjectSchema, {
      application: "write",
      modelUsage: "none",
      external: "durable_side_effect",
    }),
    operation("resume", "Resume", emptyObjectSchema, {
      application: "write",
      modelUsage: "agent_execution",
      external: "durable_side_effect",
    }),
    operation("clear", "Clear", emptyObjectSchema, {
      application: "write",
      modelUsage: "none",
      external: "durable_side_effect",
    }),
  ],
} as const satisfies ProviderFeatureModule<CodexGoalStateV1>);

export type CodexGoalActionId = "create" | "pause" | "resume" | "clear";

/** Actions currently available for the closed Goal capability advertisement. */
export function availableCodexGoalActionIds(
  state: CodexGoalStateV1,
): readonly CodexGoalActionId[] {
  if (state.state === "unset") return ["create"];
  switch (state.status) {
    case "active":
      return ["pause", "clear"];
    case "paused":
    case "blocked":
      return ["resume", "clear"];
    case "usage_limited":
    case "budget_limited":
    case "complete":
      return ["clear"];
  }
}

export function codexGoalObjectiveFingerprint(objective: string): string {
  return createHash("sha256").update(objective, "utf8").digest("hex");
}

/**
 * Receipt postconditions stay well under the generic 8 KiB receipt JSON cap.
 * Create stores only a fingerprint of the objective (not the full 16 KiB text);
 * pause/resume already used fingerprints.
 */
export type CodexGoalDesiredPostcondition =
  | {
      readonly kind: "create";
      readonly status: "active";
      readonly objectiveFingerprint: string;
    }
  | {
      readonly kind: "pause";
      readonly status: "paused";
      readonly objectiveFingerprint: string;
    }
  | {
      readonly kind: "resume";
      readonly status: "active";
      readonly objectiveFingerprint: string;
    }
  | {
      readonly kind: "clear";
    };

/** Bounded result metadata for Goal receipts — never stores raw objective text. */
export function boundedCodexGoalReceiptResult(
  state: CodexGoalStateV1,
): Readonly<Record<string, unknown>> {
  if (state.state === "unset") {
    return { state: "unset" };
  }
  return {
    state: "set",
    status: state.status,
    objectiveFingerprint: codexGoalObjectiveFingerprint(state.objective),
  };
}

export function desiredPostconditionForCodexGoalAction(input: {
  readonly actionId: CodexGoalActionId;
  readonly arguments: unknown;
  readonly currentState: CodexGoalStateV1;
}): CodexGoalDesiredPostcondition {
  switch (input.actionId) {
    case "create": {
      const parsed = createArgumentsSchema.parse(input.arguments);
      return {
        kind: "create",
        status: "active",
        objectiveFingerprint: codexGoalObjectiveFingerprint(parsed.objective),
      };
    }
    case "pause": {
      emptyObjectSchema.parse(input.arguments);
      if (input.currentState.state !== "set") {
        throw new Error("codex_goal_pause_requires_set_state");
      }
      return {
        kind: "pause",
        status: "paused",
        objectiveFingerprint: codexGoalObjectiveFingerprint(
          input.currentState.objective,
        ),
      };
    }
    case "resume": {
      emptyObjectSchema.parse(input.arguments);
      if (input.currentState.state !== "set") {
        throw new Error("codex_goal_resume_requires_set_state");
      }
      return {
        kind: "resume",
        status: "active",
        objectiveFingerprint: codexGoalObjectiveFingerprint(
          input.currentState.objective,
        ),
      };
    }
    case "clear": {
      emptyObjectSchema.parse(input.arguments);
      return { kind: "clear" };
    }
  }
}

/**
 * Authoritative recovery check after a lost or malformed native response.
 * Returns accepted when the observed state proves the desired postcondition.
 */
export function codexGoalPostconditionMatches(input: {
  readonly desired: CodexGoalDesiredPostcondition;
  readonly observed: CodexGoalStateV1;
}): boolean {
  switch (input.desired.kind) {
    case "create":
      return (
        input.observed.state === "set" &&
        input.observed.status === "active" &&
        codexGoalObjectiveFingerprint(input.observed.objective) ===
          input.desired.objectiveFingerprint
      );
    case "pause":
      return (
        input.observed.state === "set" &&
        input.observed.status === "paused" &&
        codexGoalObjectiveFingerprint(input.observed.objective) ===
          input.desired.objectiveFingerprint
      );
    case "resume":
      return (
        input.observed.state === "set" &&
        input.observed.status === "active" &&
        codexGoalObjectiveFingerprint(input.observed.objective) ===
          input.desired.objectiveFingerprint
      );
    case "clear":
      return input.observed.state === "unset";
  }
}
