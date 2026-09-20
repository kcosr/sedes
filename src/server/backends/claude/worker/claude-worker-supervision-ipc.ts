import { randomBytes } from "node:crypto";

export type ClaudeWorkerSupervisionMessage =
  | Readonly<{
      readonly type: "ready";
      readonly token: string;
      readonly expectedDigest: string;
      readonly expectedBuild: string;
      readonly carrierGeneration: number;
      readonly sessionNonce: string;
    }>
  | Readonly<{
      readonly type: "process_group_registered";
      readonly token: string;
      readonly processGroupId: number;
    }>
  | Readonly<{
      readonly type: "process_group_unregistered";
      readonly token: string;
      readonly processGroupId: number;
    }>
  | Readonly<{
      readonly type: "process_group_registered_ack";
      readonly token: string;
      readonly processGroupId: number;
    }>;

export interface ClaudeProcessGroupRegistrar {
  register(processGroupId: number): Promise<void>;
  unregister(processGroupId: number): void;
  close(): void;
}

export function createClaudeWorkerParentToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createClaudeProcessGroupRegistrar(input: {
  readonly token: string;
  readonly onFailure: (error: Error) => void;
}): ClaudeProcessGroupRegistrar {
  if (
    !validParentToken(input.token) ||
    typeof process.send !== "function" ||
    !process.connected ||
    process.channel === undefined
  ) {
    throw new Error("claude_runtime_worker_parent_ipc_required");
  }
  let failed = false;
  const pending = new Map<
    number,
    {
      readonly resolve: () => void;
      readonly reject: (error: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = (error: Error) => {
    if (failed) return;
    failed = true;
    process.removeListener("message", onMessage);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    input.onFailure(error);
  };
  const onMessage = (value: unknown) => {
    try {
      const message = parseClaudeWorkerSupervisionMessage(value, input.token);
      if (message.type !== "process_group_registered_ack") {
        throw new Error("claude_runtime_worker_parent_ipc_ack_invalid");
      }
      const waiter = pending.get(message.processGroupId);
      if (!waiter) {
        throw new Error("claude_runtime_worker_parent_ipc_ack_unknown");
      }
      pending.delete(message.processGroupId);
      clearTimeout(waiter.timer);
      waiter.resolve();
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new Error("claude_runtime_worker_parent_ipc_ack_invalid"),
      );
    }
  };
  process.on("message", onMessage);
  const send = (
    type: "process_group_registered" | "process_group_unregistered",
    processGroupId: number,
  ) => {
    if (failed || !process.connected || !Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
      throw new Error("claude_runtime_worker_parent_ipc_unavailable");
    }
    process.send!(
      { type, token: input.token, processGroupId } satisfies ClaudeWorkerSupervisionMessage,
      (error) => {
        if (!error || failed) return;
        fail(
          new Error("claude_runtime_worker_parent_ipc_failed", { cause: error }),
        );
      },
    );
  };
  return Object.freeze({
    register: (processGroupId: number) =>
      new Promise<void>((resolve, reject) => {
        if (pending.has(processGroupId)) {
          reject(new Error("claude_runtime_worker_parent_ipc_registration_duplicate"));
          return;
        }
        const timer = setTimeout(() => {
          pending.delete(processGroupId);
          const error = new Error("claude_runtime_worker_parent_ipc_ack_timeout");
          reject(error);
          fail(error);
        }, 5_000);
        timer.unref?.();
        pending.set(processGroupId, { resolve, reject, timer });
        try {
          send("process_group_registered", processGroupId);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(processGroupId);
          reject(error);
        }
      }),
    unregister: (processGroupId: number) => send("process_group_unregistered", processGroupId),
    close: () => {
      if (failed) return;
      failed = true;
      process.removeListener("message", onMessage);
      const error = new Error("claude_runtime_worker_parent_ipc_closed");
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      pending.clear();
      if (process.connected) process.disconnect?.();
    },
  });
}

export function validParentToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(value);
}

export function parseClaudeWorkerSupervisionMessage(
  value: unknown,
  expectedToken: string,
): ClaudeWorkerSupervisionMessage {
  if (!validParentToken(expectedToken) || !isRecord(value) || value.token !== expectedToken) {
    throw new Error("claude_runtime_worker_parent_ipc_message_invalid");
  }
  if (
    value.type === "process_group_registered" ||
    value.type === "process_group_unregistered"
  ) {
    if (
      Object.keys(value).sort().join("\0") !== "processGroupId\0token\0type" ||
      !Number.isSafeInteger(value.processGroupId) ||
      (value.processGroupId as number) <= 1
    ) {
      throw new Error("claude_runtime_worker_parent_ipc_message_invalid");
    }
    return value as ClaudeWorkerSupervisionMessage;
  }
  if (value.type === "process_group_registered_ack") {
    if (
      Object.keys(value).sort().join("\0") !== "processGroupId\0token\0type" ||
      !Number.isSafeInteger(value.processGroupId) ||
      (value.processGroupId as number) <= 1
    ) {
      throw new Error("claude_runtime_worker_parent_ipc_message_invalid");
    }
    return value as ClaudeWorkerSupervisionMessage;
  }
  if (
    value.type !== "ready" ||
    Object.keys(value).sort().join("\0") !==
      "carrierGeneration\0expectedBuild\0expectedDigest\0sessionNonce\0token\0type" ||
    typeof value.expectedDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.expectedDigest) ||
    typeof value.expectedBuild !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(value.expectedBuild) ||
    !Number.isSafeInteger(value.carrierGeneration) ||
    (value.carrierGeneration as number) <= 0 ||
    typeof value.sessionNonce !== "string" ||
    !/^[A-Za-z0-9_-]{32,160}$/u.test(value.sessionNonce)
  ) {
    throw new Error("claude_runtime_worker_parent_ipc_message_invalid");
  }
  return value as ClaudeWorkerSupervisionMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
