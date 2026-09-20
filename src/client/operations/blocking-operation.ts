export interface OperationContext {
  readonly isActive: () => boolean;
  readonly setMessage: (message: string) => void;
}

export interface OperationAction {
  readonly label: string;
  readonly onClick: () => void | Promise<void>;
}

export interface BlockingOperationOptions<T> {
  readonly message: string;
  readonly run: () => Promise<T>;
  readonly onSuccess?: (
    value: T,
    context: OperationContext,
  ) => void | Promise<void>;
  readonly retry?: boolean | ((error: unknown) => boolean);
  readonly retryLabel?: string;
  readonly cancelLabel?: string;
  readonly allowCancel?: boolean;
  readonly deferProgress?: boolean;
  readonly errorActions?: (error: unknown) => readonly OperationAction[];
}

export interface BlockingOperationState {
  readonly message: string;
  readonly cancelLabel: string;
  readonly allowCancel: boolean;
  readonly deferProgress: boolean;
  readonly error?: string;
  readonly retryLabel: string;
  readonly retry?: () => void;
  readonly actions: readonly OperationAction[];
  readonly cancel: () => void;
}

let current: BlockingOperationState | null = null;
const listeners = new Set<() => void>();
export const subscribeBlockingOperation = (
  listener: () => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getBlockingOperation = (): BlockingOperationState | null =>
  current;
function publish(next: BlockingOperationState | null): void {
  current = next;
  for (const listener of listeners) listener();
}

/** UI state belongs to this browser session; server mutation identity stays in its store. */
export async function runBlockingOperation<T>(
  options: BlockingOperationOptions<T>,
): Promise<void> {
  // A second trigger must not replace an operation whose completion could navigate.
  if (current) return;
  let active = true;
  let inFlight = false;
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const cancel = () => {
    if (!active) return;
    active = false;
    publish(null);
    finish();
  };
  let currentMessage = options.message;
  const context: OperationContext = {
    isActive: () => active,
    setMessage: (message) => {
      if (!active || !current) return;
      currentMessage = message;
      publish({ ...current, message });
    },
  };
  const base = {
    message: options.message,
    cancelLabel: options.cancelLabel ?? "Cancel",
    allowCancel: options.allowCancel ?? true,
    deferProgress: options.deferProgress ?? false,
    retryLabel: options.retryLabel ?? "Retry",
    actions: [],
    cancel,
  };
  const attempt = async () => {
    if (!active || inFlight) return;
    inFlight = true;
    currentMessage = options.message;
    publish(base);
    try {
      const value = await options.run();
      if (!active) return;
      await options.onSuccess?.(value, context);
      if (active) cancel();
    } catch (error) {
      if (!active) return;
      const canRetry =
        typeof options.retry === "function"
          ? options.retry(error)
          : options.retry;
      publish({
        ...base,
        message: currentMessage,
        error:
          error instanceof Error
            ? error.message
            : "The operation could not be completed.",
        retry: canRetry
          ? () => {
              void attempt();
            }
          : undefined,
        actions: options.errorActions?.(error) ?? [],
      });
    } finally {
      inFlight = false;
    }
  };
  void attempt();
  await closed;
}
