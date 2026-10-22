import { z } from "zod";
import { boundedDisplayTextSchema, boundedValueSchema, type BoundedValue } from "../protocol/payload.js";

/** Public logical payload for the versioned feature; no native IDs or RPC shapes. */
export const CODEX_SPEED_REF = Object.freeze({ featureId: "codex.fast_mode", schemaVersion: 3 } as const);
export const SPEED_SELECTIONS = ["standard", "fast", "ultrafast"] as const;
export const speedSelectionSchema = z.enum(SPEED_SELECTIONS);
export type SpeedSelection = z.infer<typeof speedSelectionSchema>;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(160);
export const speedRunTargetSchema = z.strictObject({ turnId: id, activationId: id });
export type SpeedRunTarget = z.infer<typeof speedRunTargetSchema>;
export const speedArgumentsSchema = z.strictObject({ selection: speedSelectionSchema, currentRunTarget: speedRunTargetSchema.nullable() });
export type SpeedArguments = z.infer<typeof speedArgumentsSchema>;
const attempt = { target: speedRunTargetSchema, selection: speedSelectionSchema };
export const speedCurrentRunResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_requested") }),
  z.strictObject({ status: z.enum(["pending", "published", "target_finished"]), ...attempt }),
  z.strictObject({ status: z.literal("rejected"), ...attempt, reason: z.enum(["not_enabled", "provider_rejected"]), message: boundedDisplayTextSchema }),
  z.strictObject({ status: z.literal("not_attempted"), ...attempt, reason: z.enum(["connection_changed", "publication_aborted", "ownership_changed", "unsupported_model"]) }),
  z.strictObject({ status: z.literal("uncertain"), ...attempt, reason: z.enum(["response_lost", "generation_changed", "invalid_response", "result_not_persisted"]) }),
]);
export type SpeedCurrentRunResult = z.infer<typeof speedCurrentRunResultSchema>;
export const speedResultSchema = z.strictObject({
  operationId: id, receiptRevision: revision,
  saved: z.strictObject({ status: z.literal("saved"), selection: speedSelectionSchema, desiredRevision: revision }),
  currentRun: speedCurrentRunResultSchema,
});
export type SpeedResult = z.infer<typeof speedResultSchema>;
export const speedStateSchema = z.strictObject({
  saved: z.strictObject({ selection: speedSelectionSchema, desiredRevision: revision }),
  offered: z.array(z.strictObject({ selection: speedSelectionSchema, description: z.string().min(1).max(240).optional() })).min(1).max(3).refine(
    values => values[0]?.selection === "standard" && values.every((value, index) => index === 0 ||
      SPEED_SELECTIONS.indexOf(values[index - 1]!.selection) < SPEED_SELECTIONS.indexOf(value.selection)),
    "Speeds must be unique and ordered, starting with Standard.",
  ),
  currentRun: z.strictObject({
    target: speedRunTargetSchema.nullable(), startingSelection: speedSelectionSchema.nullable(), requestedSelection: speedSelectionSchema.nullable(),
    publicationState: z.enum(["initial", "pending", "published", "unknown"]),
  }).nullable(),
  lastChange: speedResultSchema.nullable(),
});
export type SpeedState = z.infer<typeof speedStateSchema>;

/** Lossless bounded payload only. Truncation/redaction cannot become action authority. */
function unwrap(value: BoundedValue): unknown {
  if (value === null || typeof value !== "object") return value;
  if ("truncation" in value) throw new Error("truncated_feature_value");
  if ("text" in value) return value.text;
  if (value.kind === "array") return value.values.map(unwrap);
  if (value.kind !== "object") throw new Error("incomplete_feature_value");
  const entries = value.entries.map(({ key, value: entry }) => {
    if (key.truncation) throw new Error("truncated_feature_key");
    return [key.text, unwrap(entry)] as const;
  });
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("duplicate_feature_key");
  return Object.fromEntries(entries);
}
const decoded = boundedValueSchema.transform((value, context) => {
  try { return unwrap(value); } catch {
    context.addIssue({ code: "custom", message: "Feature payload must be complete and unique." });
    return z.NEVER;
  }
});
export const speedArgumentsWireSchema = decoded.pipe(speedArgumentsSchema);
export const speedStateWireSchema = decoded.pipe(speedStateSchema);
export const speedResultWireSchema = decoded.pipe(speedResultSchema);

export function speedArgumentsValue(argumentsValue: SpeedArguments): BoundedValue {
  const value = speedArgumentsSchema.parse(argumentsValue);
  return { kind: "object", entries: [
    { key: { text: "selection" }, value: { text: value.selection } },
    { key: { text: "currentRunTarget" }, value: value.currentRunTarget === null ? null : {
      kind: "object", entries: [
        { key: { text: "turnId" }, value: { text: value.currentRunTarget.turnId } },
        { key: { text: "activationId" }, value: { text: value.currentRunTarget.activationId } },
      ],
    } },
  ] };
}
