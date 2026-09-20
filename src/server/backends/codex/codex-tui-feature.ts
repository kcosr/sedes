import { z } from "zod";
import {
  boundedDisplayTextSchema,
  type BoundedDisplayText,
  type BoundedValue,
} from "../../../shared/protocol/payload.js";
import { boundValue } from "../../conversations/payload-policy.js";
import type {
  ProviderFeatureModule,
  ProviderFeatureOperationDefinition,
} from "../../provider-features/contracts.js";

export const CODEX_TUI_FEATURE_REF = Object.freeze({
  featureId: "codex.tui",
  schemaVersion: 1,
} as const);

export const codexTuiLifecycleV1Schema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "exited",
  "failed",
]);
export type CodexTuiLifecycleV1 = z.infer<typeof codexTuiLifecycleV1Schema>;

export const codexTuiExitStatusV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("code"), code: z.number().int() }).strict(),
  z
    .object({
      kind: z.literal("signal"),
      signal: z.string().min(1).max(32),
    })
    .strict(),
]);
export type CodexTuiExitStatusV1 = z.infer<typeof codexTuiExitStatusV1Schema>;

export const codexTuiStateV1Schema = z
  .object({
    lifecycle: codexTuiLifecycleV1Schema,
    resourceGeneration: z.number().int().positive().nullable(),
    streamAvailable: z.boolean(),
    diagnostic: boundedDisplayTextSchema.optional(),
    exitStatus: codexTuiExitStatusV1Schema.optional(),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.lifecycle === "stopped") {
      if (state.resourceGeneration !== null || state.streamAvailable) {
        context.addIssue({
          code: "custom",
          message: "A stopped TUI has no live resource.",
        });
      }
    } else if (state.resourceGeneration === null) {
      context.addIssue({
        code: "custom",
        message: "A non-stopped TUI must identify its resource generation.",
        path: ["resourceGeneration"],
      });
    }
    if (state.streamAvailable !== (state.lifecycle === "running")) {
      context.addIssue({
        code: "custom",
        message: "The terminal stream is available only while running.",
        path: ["streamAvailable"],
      });
    }
    if (state.exitStatus !== undefined && state.lifecycle !== "exited") {
      context.addIssue({
        code: "custom",
        message: "Process exit status is valid only for an exited TUI.",
        path: ["exitStatus"],
      });
    }
    if (state.lifecycle === "failed" && state.diagnostic === undefined) {
      context.addIssue({
        code: "custom",
        message: "A failed TUI must include a bounded diagnostic.",
        path: ["diagnostic"],
      });
    }
  });
export type CodexTuiStateV1 = z.infer<typeof codexTuiStateV1Schema>;

export function codexTuiDiagnostic(text: string): BoundedDisplayText {
  return boundedDisplayTextSchema.parse({ text });
}

const noArgumentsSchema = z.null();

function operation(input: {
  readonly actionId: "start" | "stop";
  readonly label: string;
  readonly confirmation: "none" | "explicit";
}): ProviderFeatureOperationDefinition<null> {
  return {
    actionId: input.actionId,
    label: { text: input.label },
    confirmation: input.confirmation,
    argumentsSchema: noArgumentsSchema,
    effects: {
      application: "write",
      modelUsage: "none",
      external: "none",
    },
    execution: "durable",
  };
}

export const codexTuiFeatureModule = Object.freeze({
  ref: CODEX_TUI_FEATURE_REF,
  backendKind: "codex_app_server",
  kind: "stateful",
  label: { text: "TUI" },
  description: {
    text: "Runs one managed Codex terminal view attached to this thread.",
  },
  // ThreadView owns the first-class Chat/TUI switch. This feature deliberately
  // does not masquerade as a generic provider presentation slot.
  presentationSlots: [],
  stateSchema: codexTuiStateV1Schema,
  projectState(state: CodexTuiStateV1): BoundedValue {
    return boundValue(state);
  },
  operations: [
    operation({ actionId: "start", label: "Start TUI", confirmation: "none" }),
    operation({
      actionId: "stop",
      label: "Stop TUI",
      confirmation: "none",
    }),
  ],
} as const satisfies ProviderFeatureModule<CodexTuiStateV1>);

export type CodexTuiActionId = "start" | "stop";

export function availableCodexTuiActionIds(
  state: CodexTuiStateV1,
): readonly CodexTuiActionId[] {
  switch (state.lifecycle) {
    case "stopped":
    case "exited":
    case "failed":
      return ["start"];
    case "starting":
    case "running":
      return ["stop"];
    case "stopping":
      return [];
  }
}
