import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { defineSidecarOperation, SidecarOperationError } from "./operation-registry.js";
import {
  sidecarServiceConfigurationSchema,
  type SidecarServiceConfiguration,
} from "./service-management-v1.js";
import { sidecarAgentToolCliMetadataSchema } from "./control-v3.js";

export const MAX_POLICY_BYTES = 512 * 1024;
export const POLICY_BLOCK_BYTES = 6 * 1024;
const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const subject = z.strictObject({ id: identifier, generation });
const root = subject.extend({
  path: z
    .string()
    .min(1)
    .max(32_768)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
});
const backend = subject.extend({
  kind: identifier,
  launchDigest: digest,
  managedTuiDigest: digest.optional(),
  targets: z.array(subject.readonly()).max(64).readonly(),
});
const snapshotSchema = z
  .strictObject({
    roots: z.array(root.readonly()).max(16).readonly(),
    capabilities: z.array(subject.readonly()).max(32).readonly(),
    backends: z.array(backend.readonly()).max(64).readonly(),
  })
  .readonly();
export type ExecutionPolicySnapshot = z.infer<typeof snapshotSchema>;
export interface InstalledExecutionPolicy {
  readonly revision: number;
  readonly configuration: SidecarServiceConfiguration;
  readonly snapshot: ExecutionPolicySnapshot;
  readonly digest: string;
}

function ordered<T extends { id: string }>(subjects: readonly T[]): T[] {
  if (new Set(subjects.map((s) => s.id)).size !== subjects.length)
    throw new Error("sidecar_policy_duplicate_subject");
  return [...subjects].sort((a, b) =>
    a.id < b.id ? -1 : a.id === b.id ? 0 : 1,
  );
}

/** Serialize only the closed schema, with deterministic fields and byte ordering on both peers. */
export function executionPolicyBytes(input: ExecutionPolicySnapshot): Buffer {
  const snapshot = snapshotSchema.parse(input);
  if (new Set(snapshot.roots.map((r) => r.path)).size !== snapshot.roots.length)
    throw new Error("sidecar_policy_duplicate_root");
  if (snapshot.backends.filter((b) => b.kind === "antigravity").length > 1)
    throw new Error("sidecar_policy_duplicate_antigravity");
  const targets = snapshot.backends.flatMap((b) => b.targets);
  if (
    targets.length > 64 ||
    new Set(targets.map((t) => t.id)).size !== targets.length
  )
    throw new Error("sidecar_policy_target_limit");
  const bytes = Buffer.from(
    JSON.stringify({
      roots: ordered(snapshot.roots),
      capabilities: ordered(snapshot.capabilities),
      backends: ordered(snapshot.backends).map((b) => ({
        ...b,
        targets: ordered(b.targets),
      })),
    }),
  );
  if (bytes.length > MAX_POLICY_BYTES)
    throw new Error("sidecar_policy_too_large");
  return bytes;
}
export function executionPolicyDigest(
  snapshot: ExecutionPolicySnapshot,
): string {
  return createHash("sha256")
    .update(executionPolicyBytes(snapshot))
    .digest("hex");
}
export function decodeExecutionPolicy(bytes: Buffer): ExecutionPolicySnapshot {
  const value = snapshotSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (!executionPolicyBytes(value).equals(bytes))
    throw new Error("sidecar_policy_noncanonical");
  return value;
}
const stamp = z.strictObject({ revision: generation, digest });
const controller = z.strictObject({
  incarnation: z.uuid(),
  controllerEpoch: generation,
});
const status = controller.extend({
  installed: stamp.nullable(),
  configuration: sidecarServiceConfigurationSchema,
  readiness: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(280),
        generation,
        state: z.enum(["ready", "preparing", "failed", "unsupported"]),
        // A scanned empty registry confirms absence; an unobserved or starting resident has no evidence.
        observedLaunchDigest: digest.nullable().optional(),
      }),
    )
    .max(240)
    .readonly(),
});
export type ExecutionPolicyStatus = z.infer<typeof status>;
const readinessPageSize = 12;
const cursorSchema = z.string().min(1).max(200);
const statusPage = status.extend({
  readiness: z
    .array(status.shape.readiness.unwrap().element)
    .max(readinessPageSize)
    .readonly(),
  cursor: cursorSchema.optional(),
});
export type ExecutionPolicyPage = z.infer<typeof statusPage>;
/** A cursor reads one bounded observation from its authenticated attachment. */
export class ExecutionPolicyReadPages {
  #reads = new Map<
    string,
    { status: ExecutionPolicyStatus; expires: number }
  >();
  reset(): void {
    this.#reads.clear();
  }

  begin(status: ExecutionPolicyStatus): ExecutionPolicyPage {
    if (status.readiness.length <= readinessPageSize) return status;
    // An in-flight foreground read and a synchronizer may each need a continuation.
    while (this.#reads.size >= 2)
      this.#reads.delete(this.#reads.keys().next().value!);
    const id = randomUUID();
    this.#reads.set(id, { status, expires: Date.now() + 60_000 });
    return this.#slice(id, status, 0);
  }
  next(cursor: string): ExecutionPolicyPage {
    const [id, rawOffset] = cursor.split("/");
    const read = this.#reads.get(id!);
    if (!read || read.expires <= Date.now()) {
      this.#reads.delete(id!);
      throw new SidecarOperationError("sidecar_policy_cursor_stale");
    }
    const status = read.status;
    const offset = Number(rawOffset);
    if (
      !Number.isSafeInteger(offset) ||
      offset <= 0 ||
      offset % readinessPageSize !== 0 ||
      offset >= status.readiness.length ||
      cursor !== `${id}/${offset}`
    )
      throw new SidecarOperationError("sidecar_policy_cursor_stale");
    return this.#slice(id!, status, offset);
  }
  #slice(
    id: string,
    status: ExecutionPolicyStatus,
    offset: number,
  ): ExecutionPolicyPage {
    const end = offset + readinessPageSize;
    return {
      ...status,
      readiness: status.readiness.slice(offset, end),
      ...(end < status.readiness.length ? { cursor: `${id}/${end}` } : {}),
    };
  }
}
const control = {
  capabilityId: "control",
  majorVersion: 3,
  maximumDeadlineMilliseconds: 10_000,
} as const;
export const policyReadOperation = defineSidecarOperation({
  ...control,
  operation: "policy.read",
  lane: "control",
  requestSchema: z.strictObject({ cursor: cursorSchema.optional() }),
  responseSchema: statusPage,
});
export const policyStageOperation = defineSidecarOperation({
  ...control,
  operation: "policy.stage",
  lane: "staging",
  requestSchema: controller.extend({
    transferId: z.uuid(),
    revision: generation,
    digest,
    length: z.number().int().min(1).max(MAX_POLICY_BYTES),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_POLICY_BYTES - 1),
    block: z
      .string()
      .min(4)
      .max(8192)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  }),
  responseSchema: z.strictObject({
    offset: z.number().int().min(1).max(MAX_POLICY_BYTES),
  }),
});
export type PolicyStageRequest = z.infer<
  typeof policyStageOperation.requestSchema
>;
export const policyApplyOperation = defineSidecarOperation({
  ...control,
  operation: "policy.apply",
  lane: "control",
  requestSchema: controller.extend({
    base: stamp.nullable(),
    revision: generation,
    digest,
    transferId: z.uuid(),
    configuration: sidecarServiceConfigurationSchema,
  }),
  responseSchema: statusPage,
});
export type PolicyApplyRequest = z.infer<
  typeof policyApplyOperation.requestSchema
>;
const routeSubject = z.strictObject({
  capabilityId: z.literal("agent_tools_cli"),
  generation,
  backendInstanceId: identifier,
});
export type ExecutionPolicyRouteSubject = z.infer<typeof routeSubject>;
export const policyAcquireRouteOperation = defineSidecarOperation({
  ...control,
  operation: "policy.acquire_route",
  lane: "control",
  requestSchema: routeSubject,
  responseSchema: sidecarAgentToolCliMetadataSchema,
});
export const policyAcquireOpenCodeRouteOperation = defineSidecarOperation({
  ...control,
  operation: "policy.acquire_opencode_route",
  lane: "control",
  requestSchema: z.strictObject({ backendInstanceId: identifier, generation }),
  responseSchema: z.strictObject({
    capabilityId: z.literal("opencode_tools"),
    majorVersion: z.literal(3),
    operation: z.literal("tools.invoke"),
    generation,
    backendInstanceId: identifier,
  }),
});
