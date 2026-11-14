import type { BackendAccountUsage } from "../../../shared/protocol/account-usage.js";
import type { BackendAccountUsageSource } from "../backend-account-usage.js";
import {
  defineCodexAppServerMethod,
  type OfficialCodexClientRequestResult,
} from "../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import type { CodexSharedClientFacade } from "./codex-client-facade.js";

const POLL_INTERVAL_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 30_000;

const rateLimitsRead = defineCodexAppServerMethod({
  method: "account/rateLimits/read",
  refineParams: () => ({ excludeResetCreditDetails: true }),
  refineResult: value => value,
});

/** One observation per backend, independent of thread and browser lifetimes. */
export class CodexAccountUsageSource implements BackendAccountUsageSource {
  readonly supported = true;
  readonly #listeners = new Set<() => void>();
  readonly #controller = new AbortController();
  #snapshot: BackendAccountUsage | null = null;
  #unsubscribeLifecycle: (() => void) | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #reading = false;
  #closed = false;

  constructor(readonly client: CodexSharedClientFacade) {}

  snapshot(): BackendAccountUsage | null { return this.#snapshot; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  start(): void {
    if (this.#closed || this.#unsubscribeLifecycle) return;
    this.#unsubscribeLifecycle = this.client.subscribeLifecycle(({ state }) => {
      // A remote start returns before attachment. Begin once it is usable;
      // subsequent wakes/reconnections must not trigger additional reads.
      if (this.#closed || this.#timer || (state !== "ready" && state !== "idle")) return;
      this.#timer = setInterval(() => { void this.#refresh(); }, POLL_INTERVAL_MS);
      this.#timer.unref();
      void this.#refresh();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort();
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribeLifecycle?.();
    this.#unsubscribeLifecycle = undefined;
    this.#publish(null);
  }

  async #refresh(): Promise<void> {
    if (this.#closed || this.#reading) return;
    this.#reading = true;
    let snapshot: BackendAccountUsage | null = null;
    try {
      // The shared facade already takes a short residency lease: a parked
      // runtime wakes for this single read and can park again afterward.
      const result = await this.client.request(rateLimitsRead, {}, {
        timeoutMilliseconds: REQUEST_TIMEOUT_MS,
        signal: this.#controller.signal,
      });
      snapshot = normalizeAccountUsage(result, Date.now());
    } catch {
      // Unsupported auth, unavailable runtimes, and failed reads all hide the
      // indicator. Keep the fixed schedule so a later login can recover.
    } finally {
      this.#reading = false;
    }
    // Stop may finish while the provider's response is in flight. This source
    // belongs to one module lifetime and cannot be restarted after close.
    if (!this.#closed) this.#publish(snapshot);
  }

  #publish(snapshot: BackendAccountUsage | null): void {
    if (snapshot === null && this.#snapshot === null) return;
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) {
      try { listener(); }
      catch { /* Presentation listeners cannot change provider lifecycle. */ }
    }
  }
}

function normalizeAccountUsage(
  result: OfficialCodexClientRequestResult<"account/rateLimits/read">,
  capturedAt: number,
): BackendAccountUsage | null {
  // Other buckets can describe unrelated model quotas. The legacy single
  // bucket can fall back to one of those, so it is deliberately not used.
  const ordinary = result.rateLimitsByLimitId?.codex;
  if (!ordinary) return null;
  const windows = [ordinary.primary, ordinary.secondary].flatMap(window => {
    if (!window || !Number.isFinite(window.usedPercent)) return [];
    const duration = window.windowDurationMins;
    const reset = window.resetsAt === null ? null : window.resetsAt * 1_000;
    return [{
      remainingPercent: 100 - Math.max(0, Math.min(100, window.usedPercent)),
      durationMinutes: duration !== null && Number.isSafeInteger(duration) && duration > 0 ? duration : null,
      resetsAt: reset !== null && Number.isSafeInteger(reset) && reset >= 0 && reset <= 8_640_000_000_000_000 ? reset : null,
    }];
  });
  if (!windows.length) return null;
  return {
    capturedAt,
    accountId: result.accountId && result.accountId.length <= 512 ? result.accountId : null,
    plan: planLabel(ordinary.planType),
    includedUsageAllowed: result.ordinaryUsageAllowed,
    windows,
  };
}

function planLabel(plan: string | null): string | null {
  if (plan === null || plan === "unknown") return null;
  if (plan === "promax") return "Pro Max";
  if (plan === "prolite") return "Pro Lite";
  return plan.split("_").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
