import type { ForkThreadResult } from "../../shared/index.js";
import { ApiError } from "../api/ApiClient.js";
import type { PanelPresentation } from "../workspace-panels/panel-presentation.js";
import { openThreadRoute } from "../workspace-panels/thread-panel-navigation.js";
import { runBlockingOperation } from "./blocking-operation.js";
import { waitForOperationThreadReady } from "./thread-readiness.js";

class ForkOutcomeError extends Error {
  constructor(
    readonly result: Exclude<ForkThreadResult, { status: "created" }>,
  ) {
    super(result.diagnostic);
  }
}

export function runThreadCreation(options: {
  message: string;
  create: () => Promise<string>;
  presentation: PanelPresentation;
  onNavigate?: () => void;
}): Promise<void> {
  let createdThreadId: string | undefined;
  return runBlockingOperation({
    allowCancel: false,
    message: options.message,
    run: async () => (createdThreadId ??= await options.create()),
    retry: (error) => !(error instanceof ApiError) || error.retryable,
    onSuccess: async (threadId, context) => {
      await waitForOperationThreadReady(threadId, context);
      if (!context.isActive()) return;
      openThreadRoute(threadId, options.presentation);
      options.onNavigate?.();
    },
  });
}

export function runThreadFork(options: {
  fork: (restart: boolean) => Promise<ForkThreadResult>;
  retainSource?: () => () => void;
  presentation: PanelPresentation;
  restart?: boolean;
  onNavigate?: () => void;
}): Promise<void> {
  let restart = options.restart ?? false;
  let createdThreadId: string | undefined;
  const releaseSource = options.retainSource?.();
  return runBlockingOperation({
    allowCancel: false,
    message: "Creating fork…",
    run: async () => {
      if (createdThreadId) return createdThreadId;
      const shouldRestart = restart;
      restart = false;
      // Keep the request alive even if the overlay host unmounts.
      const releaseRequest = options.retainSource?.();
      let result: ForkThreadResult;
      try {
        result = await options.fork(shouldRestart);
      } finally {
        releaseRequest?.();
      }
      if (result.status !== "created") throw new ForkOutcomeError(result);
      createdThreadId = result.childThreadId;
      return createdThreadId;
    },
    retry: (error) =>
      error instanceof ForkOutcomeError
        ? error.result.status === "recovery_required" && error.result.retryable
        : !(error instanceof ApiError) || error.retryable,
    retryLabel: "Retry same fork",
    errorActions: (error) => {
      if (!(error instanceof ForkOutcomeError)) return [];
      const result = error.result;
      if (result.status === "recovery_required")
        return [
          {
            label: "Open recovery thread",
            onClick: () => {
              openThreadRoute(result.childThreadId, options.presentation);
              options.onNavigate?.();
            },
          },
        ];
      return [
        {
          label: "Start a new fork",
          onClick: () => runThreadFork({ ...options, restart: true }),
        },
      ];
    },
    onSuccess: async (threadId, context) => {
      await waitForOperationThreadReady(threadId, context);
      if (!context.isActive()) return;
      openThreadRoute(threadId, options.presentation);
      options.onNavigate?.();
    },
  }).finally(() => releaseSource?.());
}
