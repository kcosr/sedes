import { createHash } from "node:crypto";
import {
  decodeExecutionPolicy,
  POLICY_BLOCK_BYTES,
  type ExecutionPolicySnapshot,
  type ExecutionPolicyStatus,
  type InstalledExecutionPolicy,
  type PolicyStageRequest,
  type PolicyApplyRequest,
} from "../../internal/sidecar-protocol/execution-policy.js";
import { SidecarOperationError } from "../../internal/sidecar-protocol/operation-registry.js";
import type { SidecarServiceConfiguration } from "../../internal/sidecar-protocol/service-management-v1.js";

type Transfer = {
  request: Pick<
    PolicyStageRequest,
    "revision" | "length" | "digest" | "transferId"
  >;
  bytes: Buffer;
  offset: number;
  // One bit per byte boundary allows exact older retries without retaining duplicate bodies.
  boundaries: Uint8Array;
  started: number;
  progressed: number;
};
export class InstalledExecutionPolicyStore {
  #installed: InstalledExecutionPolicy | undefined;
  #transfer: Transfer | undefined;
  #timer: NodeJS.Timeout | undefined;
  #confirmedEpoch: number | undefined;

  current(epoch: number): ExecutionPolicySnapshot {
    if (this.#confirmedEpoch !== epoch || !this.#installed)
      throw new SidecarOperationError("sidecar_policy_unsynchronized");
    return this.#installed.snapshot;
  }

  hasInstalledBackend(id: string, kind: string, generation: number): boolean {
    return this.#installed?.snapshot.backends.some(backend =>
      backend.id === id && backend.kind === kind && backend.generation === generation && backend.targets.length > 0,
    ) ?? false;
  }

  discardStaging(): void {
    this.#discard();
  }

  invalidateAttachment(): void {
    this.#confirmedEpoch = undefined;
    this.#discard();
  }

  status(
    incarnation: string,
    controllerEpoch: number,
    configuration: SidecarServiceConfiguration,
    ready: (
      category: "backend" | "capability" | "root" | "route" | "managed_tui",
      id: string,
      kind?: string,
    ) => "ready" | "preparing" | "failed" | "unsupported",
    observeBackend?: (id: string, kind: string) => string | undefined,
  ): ExecutionPolicyStatus {
    const p = this.#installed;
    return {
      incarnation,
      controllerEpoch,
      configuration,
      installed: p ? { revision: p.revision, digest: p.digest } : null,
      readiness: p
        ? [
            ...p.snapshot.backends.map((b) => {
              const observedLaunchDigest = observeBackend?.(b.id, b.kind);
              return {
                id: `backend:${b.id}`,
                generation: b.generation,
                state: ready("backend", b.id, b.kind),
                ...(observedLaunchDigest ? { observedLaunchDigest } : {}),
              };
            }),
            ...p.snapshot.backends
              .filter((b) => b.managedTuiDigest)
              .map((b) => ({
                id: `managed_tui:${b.id}`,
                generation: b.generation,
                state: ready("managed_tui", b.id),
              })),
            ...p.snapshot.capabilities.map((c) => ({
              id: `capability:${c.id}`,
              generation: c.generation,
              state: ready("capability", c.id),
            })),
            ...p.snapshot.capabilities
              .filter((c) => c.id === "agent_tools_cli")
              .flatMap((c) =>
                p.snapshot.backends
                  .filter((b) => b.kind !== "pi")
                  .map((b) => ({
                    id: `route:${b.id}`,
                    generation: c.generation,
                    state: ready("route", b.id),
                  })),
              ),
            ...p.snapshot.roots.map((r) => ({
              id: `root:${r.id}`,
              generation: r.generation,
              state: ready("root", r.id, r.path),
            })),
          ]
        : [],
    };
  }

  stage(request: PolicyStageRequest): { offset: number } {
    if (
      this.#installed &&
      (request.revision < this.#installed.revision ||
        (request.revision === this.#installed.revision &&
          request.digest !== this.#installed.digest))
    )
      throw new SidecarOperationError("sidecar_policy_revision_conflict");
    const now = Date.now();
    let t = this.#transfer;
    if (t && (now - t.progressed >= 60_000 || now - t.started >= 600_000)) {
      this.#discard();
      t = undefined;
    }
    const bytes = Buffer.from(request.block, "base64");
    if (
      bytes.length === 0 ||
      bytes.length > POLICY_BLOCK_BYTES ||
      bytes.toString("base64") !== request.block ||
      request.offset + bytes.length > request.length
    )
      throw new SidecarOperationError("sidecar_policy_invalid_block");
    if (!t || t.request.transferId !== request.transferId) {
      if (
        request.offset !== 0 ||
        (t &&
          (request.revision < t.request.revision ||
            (request.revision === t.request.revision &&
              (request.digest !== t.request.digest ||
                request.length !== t.request.length))))
      )
        throw new SidecarOperationError("sidecar_policy_stage_conflict");
      this.#discard();
      this.#transfer = t = {
        request: {
          revision: request.revision,
          length: request.length,
          digest: request.digest,
          transferId: request.transferId,
        },
        bytes: Buffer.alloc(request.length),
        offset: 0,
        boundaries: new Uint8Array(Math.ceil((request.length + 1) / 8)),
        started: now,
        progressed: now,
      };
      t.boundaries[0] = 1;
    }
    if (
      t.request.revision !== request.revision ||
      t.request.digest !== request.digest ||
      t.request.length !== request.length
    ) {
      throw new SidecarOperationError("sidecar_policy_stage_conflict");
    }
    if (request.offset < t.offset) {
      const end = request.offset + bytes.length;
      const boundary = (index: number) =>
        !!(t.boundaries[index >>> 3]! & (1 << (index & 7)));
      if (
        end > t.offset ||
        !boundary(request.offset) ||
        !boundary(end) ||
        !bytes.equals(t.bytes.subarray(request.offset, end))
      )
        throw new SidecarOperationError("sidecar_policy_stage_conflict");
      for (let i = request.offset + 1; i < end; i++)
        if (boundary(i))
          throw new SidecarOperationError("sidecar_policy_stage_conflict");
      return { offset: t.offset };
    }
    if (request.offset !== t.offset)
      throw new SidecarOperationError("sidecar_policy_stage_conflict");
    bytes.copy(t.bytes, t.offset);
    t.offset += bytes.length;
    t.boundaries[t.offset >>> 3] =
      t.boundaries[t.offset >>> 3]! | (1 << (t.offset & 7));
    t.progressed = now;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(
      () => this.#discard(),
      Math.min(60_000, t.started + 600_000 - now),
    );
    this.#timer.unref();
    return { offset: t.offset };
  }

  apply(request: PolicyApplyRequest): InstalledExecutionPolicy {
    const old = this.#installed;
    if (
      old?.revision === request.revision &&
      old.digest === request.digest &&
      old.configuration.environmentRevision ===
        request.configuration.environmentRevision &&
      old.configuration.operationsRevision ===
        request.configuration.operationsRevision
    ) {
      this.#confirmedEpoch = request.controllerEpoch;
      if (this.#transfer?.request.revision === request.revision)
        this.#discard();
      return old;
    }
    if (
      (old &&
        (old.revision >= request.revision ||
          old.configuration.environmentRevision >
            request.configuration.environmentRevision ||
          old.configuration.operationsRevision >
            request.configuration.operationsRevision)) ||
      (old
        ? old.revision !== request.base?.revision ||
          old.digest !== request.base.digest
        : request.base !== null)
    ) {
      throw new SidecarOperationError("sidecar_policy_revision_conflict");
    }
    const t = this.#transfer;
    if (
      !t ||
      t.request.transferId !== request.transferId ||
      t.request.digest !== request.digest ||
      t.request.revision !== request.revision ||
      t.offset !== t.bytes.length ||
      Date.now() - t.started >= 600_000 ||
      Date.now() - t.progressed >= 60_000
    )
      throw new SidecarOperationError("sidecar_policy_stage_incomplete");
    if (createHash("sha256").update(t.bytes).digest("hex") !== request.digest)
      throw new SidecarOperationError("sidecar_policy_digest_mismatch");
    let snapshot: ExecutionPolicySnapshot;
    try {
      snapshot = decodeExecutionPolicy(t.bytes);
    } catch (error) {
      throw new SidecarOperationError(
        "sidecar_policy_snapshot_invalid",
        false,
        { cause: error },
      );
    }
    this.#installed = {
      snapshot,
      revision: request.revision,
      digest: request.digest,
      configuration: Object.freeze({ ...request.configuration }),
    };
    this.#confirmedEpoch = request.controllerEpoch;
    this.#discard();
    return this.#installed;
  }

  #discard(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#transfer = undefined;
  }
}
