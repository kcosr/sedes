import { environmentVariableOverridesSchema } from "../../shared/protocol/environment-variables.js";
import { z } from "zod";
import { defineSidecarOperation } from "./operation-registry.js";

export const INTERACTIVE_TERMINAL_CAPABILITY_ID = "interactive_terminal" as const;
export const INTERACTIVE_TERMINAL_MAJOR_VERSION = 2 as const;

/** Persistent PTY ownership. v1's separate forced-TTY carrier is obsolete. */
export const INTERACTIVE_TERMINAL_V2_EVIDENCE = Object.freeze({
  carrier: "persistent_sidecar_pty" as const,
  inputAcknowledgement: "execution_host_pty" as const,
  remoteCleanup: "confirmed_process_group" as const,
});
export const TERMINAL_REMOTE_CHUNK_BYTES = 48 * 1024;
export const TERMINAL_REMOTE_PAGE_BYTES = 256 * 1024;
const id = z.string().uuid();
const seq = z.number().int().nonnegative().safe();
const rows = z.number().int().min(1).max(256);
const columns = z.number().int().min(2).max(512);
const bytes = z.string().regex(/^[A-Za-z0-9_-]*$/u).max(65_536);
export const remoteTerminalIdentitySchema = z.strictObject({ terminalId: id, incarnationId: id });
const control = remoteTerminalIdentitySchema.extend({ controllerToken: id });
export const remoteTerminalExitSchema = z.strictObject({
  disposition: z.enum(["exited", "interrupted"]),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(80).nullable(),
  diagnosticCode: z.string().min(1).max(120).optional(),
  cleanupConfirmed: z.boolean().optional(),
  transportClosed: z.boolean().optional(),
});
export const remoteTerminalSnapshotSchema = z.strictObject({
  snapshotId: id,
  seq,
  rows,
  columns,
  byteLength: z.number().int().nonnegative().max(8 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  exit: remoteTerminalExitSchema.optional(),
});
export const remoteTerminalRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("output"), seq, data: bytes }),
  z.strictObject({ kind: z.literal("resize"), seq, rows, columns }),
  z.strictObject({ kind: z.literal("exit"), seq, exit: remoteTerminalExitSchema }),
]);
export const remoteTerminalWriteResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("sent") }),
  z.strictObject({ outcome: z.literal("not_sent"), diagnosticCode: z.string().max(120).optional() }),
  z.strictObject({ outcome: z.literal("sent_outcome_unknown"), diagnosticCode: z.string().max(120).optional() }),
]);
const common = { capabilityId: "interactive_terminal", majorVersion: 2, maximumDeadlineMilliseconds: 10_000, lane: "operation" } as const;
export const terminalPrepareOperation = defineSidecarOperation({
  ...common, operation: "terminal.prepare",
  requestSchema: remoteTerminalIdentitySchema.extend({ environmentVariables: environmentVariableOverridesSchema.optional(), initialCwd: z.string().min(1).max(4096), rows, columns }),
  responseSchema: z.strictObject({ ticket: id }),
});
export const terminalCreateOperation = defineSidecarOperation({
  ...common, operation: "terminal.create",
  requestSchema: z.strictObject({ ticket: id }), responseSchema: z.strictObject({ created: z.literal(true) }),
});
export const terminalAttachOperation = defineSidecarOperation({
  ...common, operation: "terminal.attach",
  requestSchema: remoteTerminalIdentitySchema,
  responseSchema: z.strictObject({ controllerToken: id, snapshot: remoteTerminalSnapshotSchema }),
});
export const terminalReadOperation = defineSidecarOperation({
  ...common, operation: "terminal.read",
  requestSchema: control.extend({ afterSeq: seq }),
  responseSchema: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("records"), records: z.array(remoteTerminalRecordSchema).max(64), headSeq: seq }),
    z.strictObject({ kind: z.literal("snapshot"), snapshot: remoteTerminalSnapshotSchema }),
  ]),
});
export const terminalSnapshotChunkOperation = defineSidecarOperation({
  ...common, operation: "terminal.snapshot_chunk",
  requestSchema: control.extend({ snapshotId: id, offset: seq }),
  responseSchema: z.strictObject({ data: bytes }),
});
export const terminalInputOperation = defineSidecarOperation({
  ...common, operation: "terminal.input", lane: "control",
  requestSchema: control.extend({
    controlSeq: z.number().int().positive().safe(), data: z.string().regex(/^[A-Za-z0-9_-]*$/u).max(87_382),
    producer: z.strictObject({ producerId: id, inputSeq: z.number().int().positive().safe() }).optional(),
  }),
  responseSchema: remoteTerminalWriteResultSchema,
});
export const terminalProducerOperation = defineSidecarOperation({
  ...common, operation: "terminal.producer", lane: "control",
  requestSchema: control.extend({ producerId: id }),
  responseSchema: z.strictObject({ highWater: seq }),
});
export const terminalResizeOperation = defineSidecarOperation({
  ...common, operation: "terminal.resize", lane: "control",
  requestSchema: control.extend({ controlSeq: z.number().int().positive().safe(), rows, columns }),
  responseSchema: z.strictObject({ resized: z.literal(true) }),
});
export const terminalStopOperation = defineSidecarOperation({
  ...common, operation: "terminal.stop", lane: "control",
  requestSchema: control.extend({ signal: z.enum(["hangup", "terminate", "kill"]) }),
  responseSchema: z.strictObject({ accepted: z.literal(true) }),
});
export const terminalDetachOperation = defineSidecarOperation({
  ...common, operation: "terminal.detach", lane: "control",
  requestSchema: control, responseSchema: z.strictObject({ detached: z.literal(true) }),
});
export const terminalAcknowledgeOperation = defineSidecarOperation({
  ...common, operation: "terminal.acknowledge", lane: "control",
  requestSchema: control.extend({ finalSeq: seq }), responseSchema: z.strictObject({ acknowledged: z.literal(true) }),
});
export const terminalForgetOperation = defineSidecarOperation({
  ...common, operation: "terminal.forget", lane: "control",
  requestSchema: remoteTerminalIdentitySchema, responseSchema: z.strictObject({ forgotten: z.literal(true) }),
});
export const interactiveTerminalV2Operations = Object.freeze([
  terminalPrepareOperation, terminalCreateOperation, terminalAttachOperation,
  terminalReadOperation, terminalSnapshotChunkOperation, terminalInputOperation, terminalProducerOperation,
  terminalResizeOperation, terminalStopOperation, terminalDetachOperation,
  terminalAcknowledgeOperation, terminalForgetOperation,
]);
export type RemoteTerminalIdentity = z.infer<typeof remoteTerminalIdentitySchema>;
export type RemoteTerminalSnapshot = z.infer<typeof remoteTerminalSnapshotSchema>;
export type RemoteTerminalRecord = z.infer<typeof remoteTerminalRecordSchema>;
export type RemoteTerminalPrepare = z.infer<typeof terminalPrepareOperation.requestSchema>;
