import { OpenCodeNativeMutationDeliveryError, OpenCodeNativeMutationInputError } from "./opencode-native-codecs.js";
import type { OpenCodeMutationControl, OpenCodeMutationIdentity, OpenCodeNativePort, OpenCodeMutationMethod } from "./opencode-native-port.js";

/** Fixed at durable application admission; reconnects never refresh this budget. */
export function openCodeOperationControl(operation: {
  readonly applicationOperationId: string;
  readonly operationKind: Extract<OpenCodeMutationIdentity, { origin: "application" }>["operationKind"] | "fork";
  readonly createdAt: number;
  readonly deadlineAt?: number | null;
}, step: string): OpenCodeMutationControl {
  if (operation.operationKind === "fork") throw new Error("opencode_fork_unsupported");
  return { identity: { origin: "application", applicationOperationId: operation.applicationOperationId,
    operationKind: operation.operationKind, step }, deadlineAt: operation.deadlineAt ?? operation.createdAt + 60_000 };
}

/** Receipts have already committed; lost ACKs retain host evidence without changing the proven result. */
export async function acknowledgeOpenCodeMutation(port: OpenCodeNativePort, method: OpenCodeMutationMethod, control: OpenCodeMutationControl): Promise<void> {
  await port.acknowledgeMutation(method, control.identity).catch(() => undefined);
}

export function openCodeMutationWasNotSent(error: unknown): boolean {
  return error instanceof OpenCodeNativeMutationInputError || error instanceof OpenCodeNativeMutationDeliveryError && error.delivery === "not_sent";
}
