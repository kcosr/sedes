import type { FrameDelivery } from "../../transport/assured-framed-transport.js";

export type AcpBindingErrorCode =
  | "acp_binding_closed"
  | "acp_binding_capability_denied"
  | "acp_binding_overloaded"
  | "acp_binding_protocol_violation"
  | "acp_binding_request_cancelled"
  | "acp_binding_request_deadline"
  | "acp_binding_remote_error";

/** Provider-safe base error. Messages are closed codes, never raw wire text. */
export class AcpBindingError extends Error {
  readonly code: AcpBindingErrorCode;

  constructor(code: AcpBindingErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "AcpBindingError";
    this.code = code;
  }
}

/** Carries the transport's replay-safety boundary to the backend adapter. */
export class AcpDeliveryError extends AcpBindingError {
  readonly delivery: FrameDelivery;

  constructor(
    code:
      | "acp_binding_closed"
      | "acp_binding_request_cancelled"
      | "acp_binding_request_deadline",
    delivery: FrameDelivery,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "AcpDeliveryError";
    this.delivery = delivery;
  }
}

/** A bounded remote JSON-RPC failure with no peer-provided message or data. */
export class AcpRemoteError extends AcpBindingError {
  readonly remoteCode: number;

  constructor(remoteCode: number) {
    super("acp_binding_remote_error");
    this.name = "AcpRemoteError";
    this.remoteCode = remoteCode;
  }
}
