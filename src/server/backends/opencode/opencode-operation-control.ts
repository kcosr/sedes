import { OpenCodeNativeMutationDeliveryError, OpenCodeNativeMutationInputError } from "./opencode-native-codecs.js";
import type { OpenCodeMutationControl, OpenCodeMutationIdentity, OpenCodeNativePort, OpenCodeMutationMethod } from "./opencode-native-port.js";

/** Only explicit application deadlines constrain dispatch; retries never extend them. */
export function openCodeOperationControl(operation: {
  readonly applicationOperationId: string;
  readonly operationKind: Extract<OpenCodeMutationIdentity, { origin: "application" }>["operationKind"] | "fork";
  readonly createdAt: number;
  readonly deadlineAt?: number | null;
}, step: string): OpenCodeMutationControl {
  if (operation.operationKind === "fork") throw new Error("opencode_fork_unsupported");
  return { identity: { origin: "application", applicationOperationId: operation.applicationOperationId,
    operationKind: operation.operationKind, step }, deadlineAt: operation.deadlineAt ?? null };
}

/** Receipts have already committed; lost ACKs retain host evidence without changing the proven result. */
export async function acknowledgeOpenCodeMutation(port: OpenCodeNativePort, method: OpenCodeMutationMethod, control: OpenCodeMutationControl): Promise<void> {
  await port.acknowledgeMutation(method, control.identity).catch(() => undefined);
}

/** Main's durable terminal disposition fences retries. Host ACK intent waits
 * for a pending native effect to settle before reclaiming its retained entry. */
export async function acknowledgeOpenCodeTerminalOperation(port: OpenCodeNativePort,
  read: () => (Parameters<typeof openCodeOperationControl>[0] & { readonly disposition: string }) | undefined): Promise<void> {
  let receipt: ReturnType<typeof read>;
  try { receipt = read(); } catch { return; }
  if (!receipt || !["accepted", "not_applied", "unknown"].includes(receipt.disposition)) return;
  if (receipt.operationKind === "fork") return;
  await port.acknowledgeOperation({ applicationOperationId: receipt.applicationOperationId, operationKind: receipt.operationKind }).catch(() => undefined);
}

export function openCodeMutationWasNotSent(error: unknown): boolean {
  return error instanceof OpenCodeNativeMutationInputError || error instanceof OpenCodeNativeMutationDeliveryError && error.delivery === "not_sent";
}
