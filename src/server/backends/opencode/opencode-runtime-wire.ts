import { z } from "zod";
import type { SidecarOperationDefinition } from "../../../internal/sidecar-protocol/operation-registry.js";
import { sidecarRuntimeBodySchema } from "../../sidecar/runtime-body-channel.js";
import { sidecarUpgradeBlockerSchema } from "../../../internal/sidecar-protocol/service-management-v1.js";
import { openCodeRuntimeConfigurationSchema } from "./opencode-runtime-configuration.js";
import { openCodeNativeAuthoritySchema, openCodeNativeFailureSchema, openCodeMutationControlSchema,
  openCodeApplicationOperationIdentitySchema, openCodeReadMethods, openCodeMutationMethods } from "./opencode-native-codecs.js";
import { OPENCODE_CONTROL_MUTATIONS } from "./opencode-native-port.js";

const id = z.string().min(1).max(256);
const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const envelope = { serviceIncarnation: id, controllerEpoch: z.number().int().positive() };
const runtime = { ...envelope, runtimeId: id };
const scope = { ...runtime, nativeGeneration: id, portId: id };
export const openCodeRuntimeTargetSchema = openCodeNativeAuthoritySchema.pick({ directory: true, session: true });
const cursor = z.strictObject({ journalId: id, sequence: position });
const readMethod = z.enum(openCodeReadMethods);
const mutationMethod = z.enum(openCodeMutationMethods);
const identity = openCodeMutationControlSchema.shape.identity;

/** Closed provider-private commands over the shared authenticated carrier. */
export const openCodeRuntimeCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...envelope, action: z.literal("ensure"), configuration: openCodeRuntimeConfigurationSchema }),
  z.strictObject({ ...envelope, action: z.literal("lookup"), configuration: openCodeRuntimeConfigurationSchema }),
  z.strictObject({ ...envelope, action: z.literal("lookup_recovery"), configuration: openCodeRuntimeConfigurationSchema }),
  z.strictObject({ ...envelope, action: z.literal("lookup_retained"), backendInstanceId: id }),
  z.strictObject({ ...runtime, action: z.literal("info") }),
  z.strictObject({ ...runtime, action: z.literal("assert_current"), nativeGeneration: id }),
  z.strictObject({ ...runtime, action: z.literal("inspect") }),
  z.strictObject({ ...runtime, action: z.literal("stop"), expectedRevision: id, force: z.boolean() }),
  z.strictObject({ ...runtime, action: z.literal("acquire"), nativeGeneration: id, target: openCodeRuntimeTargetSchema }),
  z.strictObject({ ...runtime, action: z.literal("acquire_retained"), nativeGeneration: id, target: openCodeRuntimeTargetSchema }),
  z.strictObject({ ...scope, action: z.literal("release") }),
  z.strictObject({ ...scope, action: z.literal("read"), method: readMethod, input: z.unknown(), deadlineAt: position.nullable() }),
  z.strictObject({ ...scope, action: z.literal("mutate"), method: mutationMethod, input: z.unknown(), control: openCodeMutationControlSchema }),
  z.strictObject({ ...scope, action: z.literal("outcome"), method: mutationMethod, identity }),
  z.strictObject({ ...scope, action: z.literal("acknowledge_mutation"), method: mutationMethod, identity }),
  z.strictObject({ ...scope, action: z.literal("acknowledge_operation"), identity: openCodeApplicationOperationIdentitySchema }),
  z.strictObject({ ...scope, action: z.literal("observe_open"), purpose: z.enum(["evidence", "presentation"]), after: cursor.optional() }),
  z.strictObject({ ...scope, action: z.literal("observe_poll"), observationId: id, purpose: z.enum(["evidence", "presentation"]) }),
  z.strictObject({ ...scope, action: z.literal("observe_ack"), observationId: id, cursor }),
  z.strictObject({ ...scope, action: z.literal("observe_close"), observationId: id }),
]);
export type OpenCodeRuntimeCommand = z.infer<typeof openCodeRuntimeCommandSchema>;
export type OpenCodeRuntimeCommandInput = OpenCodeRuntimeCommand extends infer Command
  ? Command extends OpenCodeRuntimeCommand ? Omit<Command, "serviceIncarnation" | "controllerEpoch"> : never : never;

const capability = { capabilityId: "opencode_runtime", majorVersion: 1 } as const;
export const openCodeRuntimeExecuteOperation = { ...capability, operation: "runtime.execute",
  requestSchema: sidecarRuntimeBodySchema, responseSchema: sidecarRuntimeBodySchema,
  lane: "operation", maximumDeadlineMilliseconds: 600_000,
} satisfies SidecarOperationDefinition<z.infer<typeof sidecarRuntimeBodySchema>, z.infer<typeof sidecarRuntimeBodySchema>>;
export const openCodeRuntimeControlOperation = { ...capability, operation: "runtime.control",
  requestSchema: sidecarRuntimeBodySchema, responseSchema: sidecarRuntimeBodySchema,
  lane: "control", maximumDeadlineMilliseconds: 120_000,
} satisfies SidecarOperationDefinition<z.infer<typeof sidecarRuntimeBodySchema>, z.infer<typeof sidecarRuntimeBodySchema>>;
export const openCodeRuntimeOperations = [openCodeRuntimeExecuteOperation, openCodeRuntimeControlOperation] as const;

const controlReads = new Set(["getSession", "getActive", "getPending", "getInteractions", "getPermission", "getForm", "getActivity"]);
export function openCodeRuntimeCommandLane(command: OpenCodeRuntimeCommand | OpenCodeRuntimeCommandInput): "operation" | "control" {
  if (command.action === "mutate") return OPENCODE_CONTROL_MUTATIONS.has(command.method) ? "control" : "operation";
  if (command.action === "read") return controlReads.has(command.method) ? "control" : "operation";
  if (command.action === "observe_open" || command.action === "observe_poll") return command.purpose === "evidence" ? "control" : "operation";
  return command.action === "ensure" ? "operation" : "control";
}

export const openCodeRuntimeResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), value: z.unknown() }),
  z.strictObject({ status: z.literal("failed"), failure: openCodeNativeFailureSchema }),
  z.strictObject({ status: z.literal("control_rejected"), reason: z.enum(["confirmation_stale", "blocked", "cleanup_unproven"]) }),
]);
const fileIdentity = z.strictObject({ device: id, inode: id });
export const openCodeRuntimeInfoSchema = z.strictObject({
  runtimeId: id, nativeNamespaceKey: z.string().regex(/^[a-f0-9]{64}$/u),
  snapshot: z.strictObject({ state: z.enum(["stopped", "starting", "ready", "disconnected", "cleanup_unproved"]),
    ownership: z.enum(["owned", "external"]), generation: id.optional(), references: position,
    identity: z.strictObject({ pid: z.number().int().positive(), startTime: id, uid: z.number().int().nonnegative(),
      executablePath: z.string().min(1).max(4096), executable: fileIdentity, nativeStorePath: z.string().min(1).max(4096),
      store: fileIdentity, storeObservation: z.enum(["open_file", "operator_declared"]) }).optional(),
  }),
});
export type OpenCodeRuntimeInfo = z.infer<typeof openCodeRuntimeInfoSchema>;
export const openCodeRuntimeInspectionSchema = z.strictObject({ state: z.enum(["unknown", "active", "idle"]),
  incarnation: id, revision: id, blockers: z.array(sidecarUpgradeBlockerSchema),
  startupEnvironmentFingerprint: id.optional(), retainedThreadIds: z.array(id).max(4096).optional(),
});
export const openCodePortAdmissionSchema = z.strictObject({ portId: id, authority: openCodeNativeAuthoritySchema });
export const openCodeRuntimeSuccessSchema = z.strictObject({ ok: z.literal(true) });
