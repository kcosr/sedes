import { z } from "zod";
import {
  SidecarOperationError,
  type SidecarOperationDefinition,
} from "../../internal/sidecar-protocol/index.js";
import type { SidecarClientSession } from "./sidecar-client-session.js";
import { isUncertainSidecarMutationError } from "../../internal/sidecar-protocol/operation-outcome.js";

interface ReceiptInspection {
  readonly state: "succeeded" | "failed" | "pending" | "unknown";
  readonly result?: unknown;
  readonly code?: string;
}

/** Recover only a recorded outcome. Never resend a potentially applied mutation. */
export async function recoverSidecarOperation<Result>(input: {
  readonly error: unknown;
  readonly operationId: string;
  readonly resultSchema: z.ZodType<Result>;
  readonly inspect: SidecarOperationDefinition<
    { operationId: string },
    ReceiptInspection
  >;
  readonly acquire: () => Promise<{
    readonly session: SidecarClientSession;
    release(): void;
  }>;
}): Promise<Result> {
  if (!isUncertainSidecarMutationError(input.error)) throw input.error;
  let lease;
  try {
    lease = await input.acquire();
  } catch {
    throw input.error;
  }
  try {
    let receipt;
    try {
      receipt = await lease.session.call(input.inspect, {
        operationId: input.operationId,
      });
    } catch {
      throw input.error;
    }
    if (receipt.state === "succeeded")
      return input.resultSchema.parse(receipt.result);
    if (receipt.state === "failed")
      throw new SidecarOperationError(receipt.code!);
    throw input.error;
  } finally {
    lease.release();
  }
}
