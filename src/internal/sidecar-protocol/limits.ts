import { WORKSPACE_FILE_WRITE_JSON_LIMIT_BYTES } from "../../shared/workspace-file-limits.js";

export interface SidecarProtocolLimits {
  readonly maximumFrameBytes: number;
  readonly maximumInboundQueueBytes: number;
  readonly maximumInboundQueueFrames: number;
  readonly maximumOutboundQueueBytes: number;
  readonly maximumOutboundQueueFrames: number;
  readonly reservedSettlementQueueBytes: number;
  readonly reservedSettlementQueueFrames: number;
  readonly maximumInboundRequests: number;
  readonly maximumOutboundRequests: number;
  readonly maximumRequestDeadlineMilliseconds: number;
}

export const DEFAULT_SIDECAR_PROTOCOL_LIMITS: SidecarProtocolLimits =
  Object.freeze({
    // Until chunk/credit streaming lands, one frame must admit a domain-legal
    // 16 MiB text write at JSON's worst-case six-byte escaping expansion.
    maximumFrameBytes: WORKSPACE_FILE_WRITE_JSON_LIMIT_BYTES,
    maximumInboundQueueBytes: WORKSPACE_FILE_WRITE_JSON_LIMIT_BYTES * 2,
    maximumInboundQueueFrames: 256,
    maximumOutboundQueueBytes: WORKSPACE_FILE_WRITE_JSON_LIMIT_BYTES * 2,
    maximumOutboundQueueFrames: 256,
    reservedSettlementQueueBytes: 64 * 1024,
    reservedSettlementQueueFrames: 16,
    maximumInboundRequests: 128,
    maximumOutboundRequests: 128,
    maximumRequestDeadlineMilliseconds: 605_000,
  });

export function resolveSidecarProtocolLimits(
  overrides?: Partial<SidecarProtocolLimits>,
): SidecarProtocolLimits {
  const candidate = {
    ...DEFAULT_SIDECAR_PROTOCOL_LIMITS,
    ...overrides,
  };
  if (overrides?.reservedSettlementQueueBytes === undefined) {
    candidate.reservedSettlementQueueBytes = Math.min(
      DEFAULT_SIDECAR_PROTOCOL_LIMITS.reservedSettlementQueueBytes,
      Math.max(1, candidate.maximumOutboundQueueBytes - 1),
    );
  }
  if (overrides?.reservedSettlementQueueFrames === undefined) {
    candidate.reservedSettlementQueueFrames = Math.min(
      DEFAULT_SIDECAR_PROTOCOL_LIMITS.reservedSettlementQueueFrames,
      Math.max(1, candidate.maximumOutboundQueueFrames - 1),
    );
  }
  const limits = Object.freeze(candidate);
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("sidecar_protocol_limits_invalid");
    }
  }
  if (
    limits.maximumInboundQueueBytes < limits.maximumFrameBytes ||
    limits.maximumOutboundQueueBytes < limits.maximumFrameBytes
  ) {
    throw new Error("sidecar_protocol_queue_limits_invalid");
  }
  return limits;
}
