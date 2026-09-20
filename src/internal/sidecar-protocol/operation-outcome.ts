import { SidecarProtocolDeliveryError } from "./contracts.js";
import { SidecarOperationError } from "./operation-registry.js";

/** Only for admitted mutations: timeout/cancel can precede handler settlement,
 * and an unclassified failure can follow the filesystem's commit boundary. */
export function isUncertainSidecarMutationError(error: unknown): boolean {
  return (
    (error instanceof SidecarProtocolDeliveryError &&
      error.delivery === "sent_outcome_unknown") ||
    (error instanceof SidecarOperationError &&
      [
        "sidecar_operation_failed",
        "sidecar_request_timeout",
        "sidecar_request_cancelled",
        "workspace_tools_outcome_unknown",
      ].includes(error.code))
  );
}
