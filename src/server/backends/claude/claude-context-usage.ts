import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const CLAUDE_CONTEXT_USAGE_TIMEOUT_MS = 5_000;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Only bounded numeric context telemetry crosses the worker boundary. */
export const claudeContextUsageSchema = z.strictObject({
  usedTokens: count,
  windowTokens: count.positive(),
  percent: z.number().finite().nonnegative(),
});
export type ClaudeContextUsage = z.infer<typeof claudeContextUsageSchema>;

export function projectClaudeContextUsage(value: SDKControlGetContextUsageResponse): ClaudeContextUsage {
  // Like the structured /context report, rawMaxTokens is the effective
  // auto-compaction window, which can be smaller than the model's hard limit.
  // Keep the percentage tied to exactly the denominator displayed by Sedes.
  return claudeContextUsageSchema.parse({ usedTokens: value.totalTokens, windowTokens: value.rawMaxTokens,
    percent: value.totalTokens / value.rawMaxTokens * 100 });
}

/** Cancel only this read's wait, never the query that owns the conversation. */
export function waitClaudeContextUsage<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("claude_context_usage_cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** Volatile, coalesced telemetry. No polling, durable accounting or native work
 * admission. A new observation supersedes an older read, and invalidation must
 * clear an old context even if the following refresh fails. */
export class ClaudeContextUsageTracker {
  #value: ClaudeContextUsage | undefined;
  #revision = 0;
  #pending = false;
  #running = false;
  #closed = false;
  #controller: AbortController | undefined;

  constructor(readonly input: {
    readonly read: (signal: AbortSignal) => Promise<ClaudeContextUsage>;
    readonly publish: (value: ClaudeContextUsage | undefined) => void;
    readonly timeoutMilliseconds?: number;
  }) {}

  refresh(): void {
    if (this.#closed) return;
    this.#revision++;
    this.#pending = true;
    if (this.#running) return;
    this.#running = true;
    void this.#refresh();
  }

  invalidate(): void {
    this.#revision++;
    this.#pending = false;
    this.#controller?.abort();
    this.#publish(undefined);
  }

  close(): void {
    this.#closed = true;
    this.invalidate();
  }

  async #refresh(): Promise<void> {
    // One microtask also coalesces a replay or a synchronous block burst.
    await Promise.resolve();
    if (this.#closed || !this.#pending) { this.#running = false; return; }
    this.#pending = false;
    const revision = this.#revision;
    const controller = new AbortController();
    this.#controller = controller;
    const timer = setTimeout(() => controller.abort(), this.input.timeoutMilliseconds ?? CLAUDE_CONTEXT_USAGE_TIMEOUT_MS);
    timer.unref?.();
    try {
      const value = claudeContextUsageSchema.parse(await waitClaudeContextUsage(this.input.read(controller.signal), controller.signal));
      if (!this.#closed && revision === this.#revision && !controller.signal.aborted) this.#publish(value);
    } catch {
      // Missing/invalid/stalled telemetry must not turn a working query into a
      // conversation failure, nor make a previous estimate look current.
      if (!this.#closed && revision === this.#revision) this.#publish(undefined);
    } finally {
      clearTimeout(timer);
      this.#controller = undefined;
      this.#running = false;
      if (this.#pending && !this.#closed) this.refresh();
    }
  }

  #publish(value: ClaudeContextUsage | undefined): void {
    if (value?.usedTokens === this.#value?.usedTokens && value?.windowTokens === this.#value?.windowTokens && value?.percent === this.#value?.percent) return;
    this.#value = value;
    this.input.publish(value);
  }
}
