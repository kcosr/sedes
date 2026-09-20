import type { FrameDelivery } from "../../../provider-protocol/transport/assured-framed-transport.js";

export class CodexRpcDeliveryError extends Error {
  readonly delivery: FrameDelivery;
  readonly generation: number;
  readonly method?: string;

  constructor(input: {
    readonly code: string;
    readonly delivery: FrameDelivery;
    readonly generation: number;
    readonly method?: string;
    readonly cause?: unknown;
  }) {
    super(
      input.code,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "CodexRpcDeliveryError";
    this.delivery = input.delivery;
    this.generation = input.generation;
    this.method = input.method;
  }
}

export type CodexSteerRejectionReason = "no_active_turn" | "expected_turn_mismatch";

/** Exact native non-acceptance forms; never infer rejection from general error
 * codes or similar wording. Persist only this bounded private classification. */
export function codexSteerRejectionReason(input: { method: string; code: number; message: string }): CodexSteerRejectionReason | undefined {
  if (input.method !== "turn/steer" || input.code !== -32600) return undefined;
  if (input.message === "no active turn to steer") return "no_active_turn";
  return /^expected active turn id `[^`\r\n]{1,160}` but found `[^`\r\n]{1,160}`$/u.test(input.message)
    ? "expected_turn_mismatch" : undefined;
}

export class CodexRpcRemoteError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly generation: number;
  readonly method: string;
  readonly disposition: "rejected_not_accepted" | "remote_error";
  readonly rejectionReason?: CodexSteerRejectionReason;

  constructor(input: {
    readonly code: number;
    readonly message: string;
    readonly rejectionReason?: CodexSteerRejectionReason;
    readonly data?: unknown;
    readonly generation: number;
    readonly method: string;
  }) {
    super(input.message);
    this.name = "CodexRpcRemoteError";
    this.code = input.code;
    this.data = input.data;
    this.generation = input.generation;
    this.method = input.method;
    this.rejectionReason = input.method === "turn/steer" && input.code === -32600
      ? input.rejectionReason ?? codexSteerRejectionReason(input) : undefined;
    this.disposition =
      input.code === -32001 ? "rejected_not_accepted" : "remote_error";
  }
}

export class CodexRpcProtocolError extends Error {
  readonly generation: number;

  constructor(code: string, generation: number, options?: ErrorOptions) {
    super(code, options);
    this.name = "CodexRpcProtocolError";
    this.generation = generation;
  }
}
