import { createHash } from "node:crypto";
import { SidecarOperationError } from "../../internal/sidecar-protocol/operation-registry.js";
import { isUncertainSidecarMutationError } from "../../internal/sidecar-protocol/operation-outcome.js";
import { SidecarResourceHandoffPendingError } from "./persistent-sidecar-service-registry.js";

interface Receipt {
  readonly fingerprint: string;
  readonly reservedBytes: number;
  readonly settlement: Promise<unknown>;
  settled: boolean;
  outcome?:
    | { readonly state: "succeeded"; readonly result: unknown }
    | { readonly state: "failed"; readonly code: string }
    | { readonly state: "unknown"; readonly settled: true };
}

/** Service-owned bounded admitted results. Acknowledgment relinquishes replay. */
export class SidecarOperationReceipts {
  readonly #receipts = new Map<string, Receipt>();
  #reservedBytes = 0;
  #revision = 0;
  #stopping = false;
  constructor(readonly maximumReceipts = 1024) {}

  async run<T>(
    operationId: string,
    payload: unknown,
    operation: () => Promise<T>,
    maximumResultBytes = 8192,
  ): Promise<T> {
    if (this.#stopping) throw new SidecarOperationError("sidecar_operation_stopped");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    const existing = this.#receipts.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new SidecarOperationError("sidecar_operation_id_reused");
      return (await existing.settlement) as T;
    }
    if (
      this.#receipts.size >= this.maximumReceipts ||
      this.#reservedBytes + maximumResultBytes > 64 * 1024 * 1024
    )
      throw new SidecarOperationError("sidecar_receipt_capacity", true);
    // Install before invoking the operation, including synchronous failures.
    const receipt: Receipt = {
      fingerprint,
      reservedBytes: maximumResultBytes,
      settled: false,
      settlement: Promise.resolve().then(operation),
    };
    this.#receipts.set(operationId, receipt);
    this.#reservedBytes += maximumResultBytes;
    this.#revision += 1;
    try {
      const result = (await receipt.settlement) as T;
      receipt.outcome = { state: "succeeded", result };
      return result;
    } catch (error) {
      receipt.outcome =
        error instanceof SidecarOperationError &&
        !isUncertainSidecarMutationError(error)
          ? { state: "failed", code: error.code }
          : { state: "unknown", settled: true };
      throw error;
    } finally {
      receipt.settled = true;
      this.#revision += 1;
    }
  }

  inspect(operationId: string) {
    const receipt = this.#receipts.get(operationId);
    return (
      receipt?.outcome ??
      (receipt
        ? { state: "pending" as const }
        : { state: "unknown" as const, settled: false })
    );
  }

  ids(): readonly string[] {
    return [...this.#receipts.keys()];
  }
  abandonmentEvidence() {
    return { ...this.snapshot(), operations: [...this.#receipts].map(([operationId, receipt]) => ({ operationId,
      state: receipt.outcome?.state ?? "pending", ...(receipt.outcome?.state === "failed" ? { code: receipt.outcome.code } : {}) })) };
  }
  async stop(force: boolean): Promise<void> {
    if (!force) { this.assertSettled(); return; }
    this.#stopping = true;
    // File mutations are not safely cancellable halfway through their commit.
    // Wait for admitted effects, then relinquish replay without requiring ACK.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled([...this.#receipts.values()].map(receipt => receipt.settlement)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("sidecar_operation_cleanup_unproven")), 5_000); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  acknowledge(operationId: string): boolean {
    const receipt = this.#receipts.get(operationId);
    if (!receipt) return true;
    if (!receipt.settled) return false;
    this.#receipts.delete(operationId);
    this.#reservedBytes -= receipt.reservedBytes;
    this.#revision += 1;
    return true;
  }

  snapshot(): {
    revision: string;
    state: "idle" | "active";
    blockers: ("active_work" | "unsettled_outcome")[];
  } {
    const active = [...this.#receipts.values()].some(
      (receipt) => !receipt.settled,
    );
    return {
      revision: String(this.#revision),
      state: active ? "active" : "idle",
      blockers: [
        ...(active ? ["active_work" as const] : []),
        ...(this.#receipts.size ? ["unsettled_outcome" as const] : []),
      ],
    };
  }

  assertSettled(): void {
    if (this.#receipts.size) throw new SidecarResourceHandoffPendingError();
  }
}
