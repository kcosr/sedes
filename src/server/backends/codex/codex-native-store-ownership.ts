import type { BackendNativeStoreLease } from "../module.js";

export const CODEX_CLEANUP_UNCERTAINTIES = [
  "orphaned_process_group",
  "process_cleanup_failed",
  "codex_rpc_transport_close_failed",
] as const;

export type CodexCleanupUncertainty =
  (typeof CODEX_CLEANUP_UNCERTAINTIES)[number];

export type CodexNativeStoreRetentionReason =
  | CodexCleanupUncertainty
  | "codex_daemon_cleanup_unproven";

export type CodexNativeStoreOwnershipState =
  | "prelaunch"
  | "launch_armed"
  | "proven_closed"
  | "cleanup_failed";

export interface CodexNativeStoreOwnershipSnapshot {
  readonly state: CodexNativeStoreOwnershipState;
  readonly releaseSafety: "safe" | "blocked";
  readonly retentionReason?: CodexNativeStoreRetentionReason;
  readonly cleanupUncertainty?: CodexCleanupUncertainty;
}

/**
 * Provider-owned proof governing removal of the native-home marker.
 *
 * Preflight failures are safe because no launch has begun. Crossing the launch
 * boundary blocks release until the generation's cleanup is positively
 * proven. Any cleanup failure is terminal for this process: a later success
 * cannot erase uncertainty about an earlier owned process group.
 */
export class CodexNativeStoreOwnershipGate {
  #state: CodexNativeStoreOwnershipState = "prelaunch";
  #retentionReason: CodexNativeStoreRetentionReason | undefined;
  #cleanupUncertainty: CodexCleanupUncertainty | undefined;

  armLaunch(): void {
    if (this.#state === "cleanup_failed") return;
    this.#state = "launch_armed";
    this.#retentionReason = "codex_daemon_cleanup_unproven";
    this.#cleanupUncertainty = undefined;
  }

  proveClosed(): void {
    if (this.#state !== "launch_armed") return;
    this.#state = "proven_closed";
    this.#retentionReason = undefined;
  }

  latchCleanupFailure(error: unknown): void {
    if (this.#state === "cleanup_failed") return;
    const uncertainty = findCodexCleanupUncertainty(error);
    this.#state = "cleanup_failed";
    this.#retentionReason =
      uncertainty ?? "codex_daemon_cleanup_unproven";
    this.#cleanupUncertainty = uncertainty;
  }

  snapshot(): CodexNativeStoreOwnershipSnapshot {
    const safe =
      this.#state === "prelaunch" || this.#state === "proven_closed";
    return Object.freeze({
      state: this.#state,
      releaseSafety: safe ? "safe" : "blocked",
      ...(this.#retentionReason
        ? { retentionReason: this.#retentionReason }
        : {}),
      ...(this.#cleanupUncertainty
        ? { cleanupUncertainty: this.#cleanupUncertainty }
        : {}),
    });
  }

  assertReleaseSafe(): void {
    if (
      this.#state === "prelaunch" ||
      this.#state === "proven_closed"
    ) {
      return;
    }
    throw new CodexNativeStoreRetentionError(
      this.#retentionReason ?? "codex_daemon_cleanup_unproven",
      this.#cleanupUncertainty,
    );
  }
}

export class CodexNativeStoreRetentionError extends Error {
  readonly retentionReason: CodexNativeStoreRetentionReason;
  readonly cleanupUncertainty?: CodexCleanupUncertainty;

  constructor(
    retentionReason: CodexNativeStoreRetentionReason,
    cleanupUncertainty?: CodexCleanupUncertainty,
  ) {
    super("codex_native_store_retained_cleanup_unproven");
    this.name = "CodexNativeStoreRetentionError";
    this.retentionReason = retentionReason;
    this.cleanupUncertainty = cleanupUncertainty;
  }
}

/**
 * A guarded lease deliberately leaves the underlying marker untouched once
 * cleanup uncertainty is latched. Calls share one release attempt.
 */
export function guardCodexNativeStoreLease(
  lease: BackendNativeStoreLease,
  ownership: CodexNativeStoreOwnershipGate,
): BackendNativeStoreLease {
  let released = false;
  let releasePromise: Promise<void> | undefined;
  return Object.freeze({
    release: () => {
      if (released) return Promise.resolve();
      try {
        ownership.assertReleaseSafe();
      } catch (error) {
        return Promise.reject(error);
      }
      releasePromise ??= Promise.resolve(lease.release())
        .then(() => {
          released = true;
        })
        .finally(() => {
          releasePromise = undefined;
        });
      return releasePromise;
    },
  });
}

export function codexCleanupUncertainty(
  value: unknown,
): CodexCleanupUncertainty | undefined {
  return CODEX_CLEANUP_UNCERTAINTIES.find((candidate) => candidate === value);
}

export function findCodexCleanupUncertainty(
  error: unknown,
  visited = new Set<unknown>(),
): CodexCleanupUncertainty | undefined {
  const direct = codexCleanupUncertainty(error);
  if (direct) return direct;
  if (visited.has(error)) return undefined;
  visited.add(error);
  if (error instanceof CodexNativeStoreRetentionError) {
    return error.cleanupUncertainty;
  }
  if (error instanceof Error) {
    return (
      codexCleanupUncertainty(error.message) ??
      findCodexCleanupUncertainty(error.cause, visited)
    );
  }
  return undefined;
}
