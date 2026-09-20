import type { ResolvedEnvironmentVariables } from "../environment-variables/runtime-environment.js";
import { randomUUID } from "node:crypto";
import { isUncertainSidecarMutationError } from "../../internal/sidecar-protocol/operation-outcome.js";
import {
  SidecarProtocolDeliveryError,
  SidecarOperationError,
  workspaceToolsShellCancelOperation,
  workspaceToolsShellStartOperation,
  workspaceToolsShellInspectOperation,
  workspaceToolsShellAcknowledgeOperation,
  type SidecarStreamDataRecord,
  type WorkspaceToolsShellTerminal,
} from "../../internal/sidecar-protocol/index.js";
import type { SidecarClientSession } from "../sidecar/sidecar-client-session.js";
import { SidecarConnectionError } from "../sidecar/sidecar-provisioner.js";

const RECOVERY_ALLOWANCE_MILLISECONDS = 5_000;
const RECOVERY_POLL_MILLISECONDS = 250;
const ACKNOWLEDGEMENT_ACQUISITION_MILLISECONDS = 30_000;

export class SidecarWorkspaceShellOutcomeUnknownError extends Error {
  readonly diagnosticCode = "workspace_tools_shell_outcome_unknown" as const;
  constructor(options?: ErrorOptions) {
    super("workspace_tools_shell_outcome_unknown", options);
    this.name = "SidecarWorkspaceShellOutcomeUnknownError";
  }
}

export interface SidecarWorkspaceShellProcess {
  readonly streamId: string;
  readonly terminal: Promise<WorkspaceToolsShellTerminal>;
  addCredit(bytes: number): Promise<void>;
  cancel(): Promise<void>;
  acknowledge(): Promise<void>;
}

export interface WorkspaceShellLease {
  readonly session: SidecarClientSession;
  readonly workspaceHandle: string;
  readonly carrierGeneration: number;
  release(): void;
}

export interface WorkspaceShellRecoveryLease {
  readonly session: SidecarClientSession;
  assertActive(): void | Promise<void>;
  release(): void;
}

/** Main-host shell adapter. Its runtime operation lease remains held to terminal. */
export class SidecarWorkspaceShellExecutor {
  readonly #acquireWorkspaceLease: (
    signal: AbortSignal,
  ) => Promise<WorkspaceShellLease>;

  readonly #acquireRecoveryLease: (
    signal: AbortSignal,
    originalSession: SidecarClientSession,
  ) => Promise<WorkspaceShellRecoveryLease>;

  constructor(input: {
    readonly acquireWorkspaceLease: (
      signal: AbortSignal,
    ) => Promise<WorkspaceShellLease>;
    readonly acquireRecoveryLease: (
      signal: AbortSignal,
      originalSession: SidecarClientSession,
    ) => Promise<WorkspaceShellRecoveryLease>;
  }) {
    this.#acquireWorkspaceLease = input.acquireWorkspaceLease;
    this.#acquireRecoveryLease = input.acquireRecoveryLease;
  }

  async start(input: {
    readonly environmentVariables?: ResolvedEnvironmentVariables;
    readonly command: string;
    readonly initialCreditBytes: number;
    readonly timeoutMilliseconds: number;
    readonly signal?: AbortSignal;
    readonly onData: (record: SidecarStreamDataRecord) => void | Promise<void>;
  }): Promise<SidecarWorkspaceShellProcess> {
    const signal = input.signal ?? new AbortController().signal;
    const lease = await this.#acquireWorkspaceLease(signal);
    const operationId = randomUUID();
    const streamId = randomUUID();
    const environmentIdentity = input.environmentVariables ? randomUUID() : undefined;
    const lifetime = new AbortController();
    const recoveryLifetime = new AbortController();
    let settle!: (terminal: WorkspaceToolsShellTerminal) => void;
    let fail!: (error: Error) => void;
    const terminal = new Promise<WorkspaceToolsShellTerminal>(
      (resolve, reject) => {
        settle = resolve;
        fail = reject;
      },
    );
    // A terminal can arrive before the start acknowledgement exposes this promise.
    void terminal.catch(() => undefined);
    let terminalSettled = false;
    let terminalReceived = false;
    let recovering = false;
    let released = false;
    let recovered: WorkspaceShellRecoveryLease | undefined;
    let acknowledgementLease: WorkspaceShellRecoveryLease | undefined;
    let acknowledgementLeaseTimer: ReturnType<typeof setTimeout> | undefined;
    let originalSessionClosed = false;
    let cancelRequested = false;
    let cancellationSession: SidecarClientSession | undefined;
    let consumerFailure: Error | undefined;
    let output = Promise.resolve();
    let sequence = 0;
    const accepted = { stdout: 0, stderr: 0 };
    const recoveredChannels = new Set<"stdout" | "stderr">();
    const release = () => {
      if (released) return;
      released = true;
      lease.release();
    };
    const releaseRecovered = () => {
      recovered?.release();
      recovered = undefined;
    };
    const releaseAcknowledgementLease = () => {
      clearTimeout(acknowledgementLeaseTimer);
      acknowledgementLease?.release();
      acknowledgementLease = undefined;
      recoveryLifetime.abort();
    };
    const cleanup = () => {
      clearTimeout(deadlineTimer);
      signal.removeEventListener("abort", aborted);
      lifetime.abort();
      incoming.unregister();
      release();
      releaseRecovered();
      if (!acknowledgementLease) recoveryLifetime.abort();
    };
    const failUnknown = (cause?: unknown) => {
      if (terminalSettled) return;
      terminalSettled = true;
      fail(new SidecarWorkspaceShellOutcomeUnknownError({ cause }));
      cleanup();
    };
    // A command's own timeout bounds waiting even if every reconnect fails.
    // Five seconds allows sidecar termination/receipt delivery after that timeout.
    const deadlineAt =
      Date.now() + input.timeoutMilliseconds + RECOVERY_ALLOWANCE_MILLISECONDS;
    let deadlineTimer = setTimeout(
      failUnknown,
      input.timeoutMilliseconds + RECOVERY_ALLOWANCE_MILLISECONDS,
    );
    deadlineTimer.unref();
    const finish = async (result: WorkspaceToolsShellTerminal) => {
      await output;
      if (terminalSettled) return;
      terminalSettled = true;
      if (!consumerFailure && recovered) {
        // Give the caller the completing carrier for acknowledgement. A caller
        // retaining an incomplete receipt must not retain its SSH lease forever.
        acknowledgementLease = recovered;
        recovered = undefined;
        acknowledgementLeaseTimer = setTimeout(
          releaseAcknowledgementLease,
          RECOVERY_ALLOWANCE_MILLISECONDS,
        );
        acknowledgementLeaseTimer.unref();
      }
      if (consumerFailure) fail(consumerFailure);
      else settle(result);
      cleanup();
    };
    const cancelOn = async (session: SidecarClientSession) => {
      if (
        !cancelRequested ||
        cancellationSession === session ||
        terminalSettled
      )
        return;
      cancellationSession = session;
      try {
        const result = await bounded(
          (callSignal) =>
            session.call(
              workspaceToolsShellCancelOperation,
              { streamId },
              { signal: callSignal },
            ),
          lifetime.signal,
        );
        if (!result.accepted) cancellationSession = undefined;
      } catch (error) {
        cancellationSession = undefined;
        throw error;
      }
    };
    const requestCancel = async () => {
      if (terminalSettled || cancelRequested) return;
      cancelRequested = true;
      // Stop remains bounded when the target cannot be reached. It never proves
      // process exit merely because this cleanup allowance has expired.
      clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(
        failUnknown,
        Math.min(
          RECOVERY_ALLOWANCE_MILLISECONDS,
          Math.max(0, deadlineAt - Date.now()),
        ),
      );
      deadlineTimer.unref();
      if (recovering) {
        const current = recovered;
        if (current) {
          try {
            await bounded(
              async () => await current.assertActive(),
              lifetime.signal,
            );
            await cancelOn(current.session);
          } catch {
            // The recovery loop still needs authoritative terminal evidence.
          }
        }
        return;
      }
      try {
        await cancelOn(lease.session);
      } catch {
        recover();
      }
    };
    const aborted = () => void requestCancel();
    const accept = (record: SidecarStreamDataRecord) => {
      output = output.then(async () => {
        if (terminalSettled || consumerFailure) return;
        try {
          await input.onData(record);
          if (record.channel === "stdout" || record.channel === "stderr")
            accepted[record.channel] += record.bytes.byteLength;
        } catch (error) {
          consumerFailure =
            error instanceof Error
              ? error
              : new Error("workspace_tools_shell_consumer_failed");
          void requestCancel();
        }
      });
      return output;
    };
    const incoming = lease.session.registerIncomingShellStream({
      streamId,
      initialCreditBytes: input.initialCreditBytes,
      onData: (record) => {
        if (recovering || terminalReceived || terminalSettled) return;
        sequence = Math.max(sequence, record.sequence + 1);
        void accept(record).then(() => {
          if (
            recovering ||
            terminalReceived ||
            terminalSettled ||
            consumerFailure
          )
            return;
          // Credit failure is a carrier problem, not an output consumer failure.
          void incoming
            .addCredit(record.bytes.byteLength)
            .catch(() => recover());
        });
      },
      onTerminal: (result) => {
        if (recovering || terminalReceived || terminalSettled) return;
        terminalReceived = true;
        void finish(result);
      },
    });
    const runRecovery = async () => {
      try {
        await bounded(() => output, lifetime.signal);
        while (!terminalSettled) {
          try {
            if (!recovered) {
              recovered = await bounded(
                (callSignal) =>
                  this.#acquireRecoveryLease(callSignal, lease.session),
                recoveryLifetime.signal,
                (lateLease) => lateLease.release(),
                Math.max(0, deadlineAt - Date.now()),
              );
              if (terminalSettled) {
                releaseRecovered();
                return;
              }
              if (
                originalSessionClosed &&
                recovered.session === lease.session
              ) {
                failUnknown();
                return;
              }
            }
            await bounded(
              async () => await recovered!.assertActive(),
              lifetime.signal,
            );
            await cancelOn(recovered.session);
            await bounded(
              async () => await recovered!.assertActive(),
              lifetime.signal,
            );
            const result = await bounded(
              (callSignal) =>
                recovered!.session.call(
                  workspaceToolsShellInspectOperation,
                  { streamId },
                  { signal: callSignal },
                ),
              lifetime.signal,
            );
            await bounded(
              async () => await recovered!.assertActive(),
              lifetime.signal,
            );
            if (result.state === "unknown") {
              failUnknown();
              return;
            }
            // Receipts retain per-channel prefixes, without cross-channel order.
            // Deliver only each prefix suffix beyond bytes already accepted.
            for (const channel of ["stdout", "stderr"] as const) {
              const bytes = Buffer.from(
                result[`${channel}Base64`],
                "base64",
              ).subarray(accepted[channel]);
              if (bytes.byteLength > 0) {
                recoveredChannels.add(channel);
                await bounded(
                  () => accept({ channel, bytes, sequence: sequence++ }),
                  lifetime.signal,
                ).catch(failUnknown);
                if (terminalSettled) return;
              }
            }
            if (result.state === "completed") {
              if (!result.terminal) {
                failUnknown();
                return;
              }
              await finish({
                ...result.terminal,
                truncated:
                  result.terminal.stdoutBytes > accepted.stdout ||
                  result.terminal.stderrBytes > accepted.stderr ||
                  recoveredChannels.size > 1 ||
                  result.terminal.outcome === "output_limited",
              });
              return;
            }
          } catch (error) {
            releaseRecovered();
            if (lifetime.signal.aborted) return;
            if (!isRetryableRecoveryError(error)) {
              failUnknown(error);
              return;
            }
          }
          await waitForPoll(lifetime.signal);
        }
      } catch (error) {
        failUnknown(error);
      } finally {
        releaseRecovered();
      }
    };
    const recover = () => {
      if (recovering || terminalReceived || terminalSettled) return;
      recovering = true;
      incoming.unregister();
      release();
      void runRecovery();
    };
    signal.addEventListener("abort", aborted, { once: true });
    const disconnected = () => {
      originalSessionClosed = true;
      recover();
    };
    void lease.session.closed.then(disconnected, disconnected);
    try {
      await bounded(
        (callSignal) =>
          lease.session.call(
            workspaceToolsShellStartOperation,
            {
              workspaceHandle: lease.workspaceHandle,
              operationId,
              streamId,
              command: input.command,
              ...(input.environmentVariables ? { environmentVariables: input.environmentVariables, environmentIdentity } : {}),
              initialCreditBytes: input.initialCreditBytes,
              timeoutMilliseconds: input.timeoutMilliseconds,
            },
            { signal: AbortSignal.any([signal, callSignal]) },
          ),
        lifetime.signal,
        undefined,
        workspaceToolsShellStartOperation.maximumDeadlineMilliseconds,
      );
    } catch (error) {
      if (!terminalReceived && !terminalSettled) {
        if (isUncertainSidecarMutationError(error)) {
          recover();
        } else {
          terminalSettled = true;
          cleanup();
          throw error;
        }
      }
    }
    if (signal.aborted) void requestCancel();
    return Object.freeze({
      streamId,
      terminal,
      addCredit: async (bytes: number) => {
        if (recovering || terminalReceived || terminalSettled) return;
        try {
          await incoming.addCredit(bytes);
        } catch {
          recover();
        }
      },
      cancel: requestCancel,
      acknowledge: async () => {
        if (!terminalSettled)
          throw new Error("workspace_tools_shell_not_settled");
        const acknowledgement = new AbortController();
        const retainedLease = acknowledgementLease;
        acknowledgementLease = undefined;
        clearTimeout(acknowledgementLeaseTimer);
        const recoveryLease = retainedLease ?? await bounded(
          (callSignal) => this.#acquireRecoveryLease(callSignal, lease.session),
          acknowledgement.signal,
          (lateLease) => lateLease.release(),
          ACKNOWLEDGEMENT_ACQUISITION_MILLISECONDS,
        );
        try {
          await bounded(
            async () => await recoveryLease.assertActive(),
            acknowledgement.signal,
          );
          const result = await bounded(
            (callSignal) =>
              recoveryLease.session.call(
                workspaceToolsShellAcknowledgeOperation,
                { streamId },
                { signal: callSignal },
              ),
            acknowledgement.signal,
          );
          if (!result.acknowledged)
            throw new Error("workspace_tools_shell_receipt_not_settled");
        } finally {
          recoveryLease.release();
          recoveryLifetime.abort();
        }
      },
    });
  }
}

function isRetryableRecoveryError(error: unknown): boolean {
  return (
    error instanceof SidecarProtocolDeliveryError ||
    error instanceof SidecarConnectionError ||
    (error instanceof Error && error.message === "sidecar_protocol_peer_closed") ||
    (error instanceof SidecarOperationError &&
      error.code === "sidecar_request_timeout")
  );
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, RECOVERY_POLL_MILLISECONDS);
    timer.unref();
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

/** Also bounds dependencies which do not promptly honor their AbortSignal. */
async function bounded<T>(
  action: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  disposeLate?: (value: T) => void,
  timeoutMilliseconds = RECOVERY_ALLOWANCE_MILLISECONDS,
): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  timer.unref();
  let abandoned = false;
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () =>
      reject(
        new SidecarProtocolDeliveryError(
          "workspace_tools_shell_recovery_timeout",
          "sent_outcome_unknown",
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    if (signal.aborted) return await interrupted;
    return await Promise.race([
      action(signal).then((value) => {
        if (abandoned) disposeLate?.(value);
        return value;
      }),
      interrupted,
    ]);
  } finally {
    abandoned = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
