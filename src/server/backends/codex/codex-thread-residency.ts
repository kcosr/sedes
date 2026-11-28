import type { CodexSharedClientFacade } from "./codex-client-facade.js";
import { codexThreadReadMethod, codexThreadTurnsListMethod, codexThreadUnsubscribeMethod } from "./codex-c1-protocol.js";
import { codexThreadGoalGetMethod } from "./codex-goal-protocol.js";
import { CODEX_HISTORY_TIMEOUT_MILLISECONDS } from "./codex-history-timeouts.js";
import { codexError, bindingMismatch, mapCodexReadError } from "./codex-read-errors.js";
import { assertThreadBinding } from "./codex-thread-binding.js";
import { isCodexNativeArchiveThreadMissing } from "./codex-native-archive.js";
import { CodexRpcRemoteError } from "./rpc/errors.js";

export async function releaseCodexThreadResidency(
  client: Pick<CodexSharedClientFacade, "requestWithReceipt">, lifecycle: CodexSharedClientFacade["lifecycleSnapshot"],
  threadId: string, workspace: string, archive?: {
    signal: AbortSignal; inspectionOnly?: boolean; markObserved(): void; beforeUnsubscribe?(): void; onUnsubscribe?(generation: number): void;
  },
): Promise<"released" | "busy"> {
  const options = { timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS, signal: archive?.signal };
  try {
    const inspected = await client.requestWithReceipt(
      codexThreadReadMethod,
      { threadId, includeTurns: false },
      options,
    ).catch(error => {
      if (archive && error instanceof CodexRpcRemoteError && isCodexNativeArchiveThreadMissing(error, threadId) &&
          lifecycle().state === "ready" &&
          error.generation === lifecycle().generation) return undefined;
      throw error;
    });
    if (!inspected) return "released";
    assertThreadBinding(inspected.result.thread, threadId, workspace);
    archive?.markObserved();
    const generation = inspected.generation;
    const assertGeneration = (received: number) => {
      const current = lifecycle();
      if (received !== generation || current.generation !== generation || current.state !== "ready") {
        throw codexError("unavailable", "Codex changed connection while releasing the thread's tool configuration.",
          "codex_residency_release_generation_changed", true);
      }
    };
    assertGeneration(generation);
    const status = inspected.result.thread.status.type;
    if (status === "active") return "busy";
    // A newly created native thread may still exist only in memory. Prove
    // that its history is materialized before dropping the subscription;
    // otherwise the next resume can fail with "no rollout found".
    let materialized = true;
    try {
      if (inspected.result.thread.historyMode === "paginated") {
        const history = await client.requestWithReceipt(
          codexThreadTurnsListMethod,
          { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
          options,
        );
        assertGeneration(history.generation);
      } else {
        const history = await client.requestWithReceipt(
          codexThreadReadMethod,
          { threadId, includeTurns: true },
          options,
        );
        assertGeneration(history.generation);
        assertThreadBinding(history.result.thread, threadId, workspace);
        if (history.result.thread.status.type === "active") return "busy";
      }
    } catch (error) {
      if (error instanceof CodexRpcRemoteError && /(?:not materialized yet|no rollout found)/iu.test(error.message)) {
        if (!archive) throw codexError("invalid_state", "Send the first message before changing tools on this Codex conversation.",
          "codex_residency_history_unmaterialized", false, error);
        const historyMethod = inspected.result.thread.historyMode === "paginated" ? "thread/turns/list" : "thread/read";
        if (error.method !== historyMethod || ![-32600, -32603].includes(error.code) || ![
          "thread not materialized yet",
          `no rollout found for thread id ${threadId}`,
          `thread ${threadId} is not materialized yet; ${historyMethod} is unavailable before first user message`,
        ].includes(error.message)) throw error;
        assertGeneration(error.generation);
        materialized = false;
      } else throw error;
    }
    const goal = await client.requestWithReceipt(
      codexThreadGoalGetMethod,
      { threadId },
      options,
    );
    assertGeneration(goal.generation);
    if (goal.result.goal && goal.result.goal.threadId !== threadId) throw bindingMismatch();
    if (goal.result.goal?.status === "active") return "busy";
    if (!materialized || archive?.inspectionOnly) return "released";
    archive?.signal.throwIfAborted();
    archive?.beforeUnsubscribe?.();
    const unsubscribed = await client.requestWithReceipt(
      codexThreadUnsubscribeMethod,
      { threadId },
      options,
    );
    assertGeneration(unsubscribed.generation);
    archive?.onUnsubscribe?.(unsubscribed.generation);
    // This releases Sedes's subscription only. Codex can retain an idle
    // thread after unsubscribe; the next native resume rebuilds its config
    // unless a separate native client is still subscribed to the same thread.
    // Persistent hosts invalidate their cached configuration on this receipt.
    return "released";
  } catch (error) {
    throw mapCodexReadError(error);
  }
}
