import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@client/components/ui/button";
import {
  Dialog,
  DialogAlert,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  initialFocusTarget,
} from "@client/components/ui/dialog";
import {
  getBlockingOperation,
  subscribeBlockingOperation,
} from "./blocking-operation.js";
import "./operation-overlay.css";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import { setOperationThreadRegistry } from "./thread-readiness.js";

// Install before component effects register application capture shortcuts. Focus
// trapping alone does not prevent those shortcuts from navigating behind a modal.
if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      if (!document.querySelector("[data-blocking-operation]")) return;
      if (
        event.key === "Escape" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        // Keep native copy/paste, selection, and browser shortcuts available.
        // Prevent their event from reaching application-wide capture handlers.
        if (event.key === "Escape" || event.altKey) event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
}

function OperationLoading({
  message,
  onDismiss,
  deferred = false,
}: {
  readonly message: string;
  readonly onDismiss?: () => void;
  readonly deferred?: boolean;
}): React.JSX.Element {
  return (
    <div className={`operation-progress${deferred ? " deferred" : ""}`}>
      <div role="status" className="operation-progress-message">
        <LoaderCircle className="operation-spinner" aria-hidden="true" />
        <span>{message}</span>
      </div>
      {onDismiss && (
        <Button variant="outline" onClick={onDismiss}>
          Dismiss
        </Button>
      )}
    </div>
  );
}

/**
 * Moves focus after a phase change while the dialog stays open: into the
 * progress (its Dismiss button, else the surface), then into the settled dialog by
 * the dialog focus rule (first field, else the primary action).
 */
function useOperationContentFocus(
  phase: unknown,
  settled: boolean,
): React.RefObject<HTMLDivElement | null> {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const target = settled
      ? initialFocusTarget(node)
      : (node.querySelector<HTMLButtonElement>("button") ?? node);
    target.focus({ preventScroll: true });
    // Focus follows the phase only; `settled` changes with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);
  return content;
}

/** Operation messages read as progress ("Creating fork…"); the error title names what failed. */
function failureTitle(message: string): string {
  return `${message.replace(/…$/u, "")} failed`;
}

export function OperationOverlayHost({
  threadRegistry,
}: {
  readonly threadRegistry?: ThreadStoreRegistry;
}): React.JSX.Element | null {
  const operation = useSyncExternalStore(
    subscribeBlockingOperation,
    getBlockingOperation,
    () => null,
  );
  const content = useOperationContentFocus(
    operation?.error,
    Boolean(operation?.error),
  );
  const errorId = useId();
  useEffect(
    () => () => {
      getBlockingOperation()?.dismiss();
    },
    [],
  );
  useEffect(() => {
    setOperationThreadRegistry(threadRegistry);
    return () => {
      setOperationThreadRegistry(undefined);
    };
  }, [threadRegistry]);
  if (!operation) return null;
  const retry = operation.retry;
  const primaryAction = retry ? undefined : operation.actions.at(-1);
  const secondaryActions = operation.actions.filter(
    (action) => action !== primaryAction,
  );
  return (
    <Dialog open>
      <DialogContent
        ref={content}
        layer="blocking"
        showClose={false}
        dismissible={false}
        className={operation.error ? undefined : "operation-progress-surface"}
        data-blocking-operation="true"
        onKeyDown={(event) => event.stopPropagation()}
        aria-describedby={operation.error ? errorId : undefined}
      >
        {operation.error ? (
          <>
            <DialogHeader>
              <DialogTitle>{failureTitle(operation.message)}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <DialogAlert id={errorId} tone="danger">
                {operation.error}
              </DialogAlert>
            </DialogBody>
            <DialogFooter
              start={
                secondaryActions.length > 0
                  ? secondaryActions.map((action) => (
                      <Button
                        key={action.label}
                        variant="outline"
                        onClick={() => {
                          operation.dismiss();
                          void action.onClick();
                        }}
                      >
                        {action.label}
                      </Button>
                    ))
                  : undefined
              }
            >
              <Button variant="outline" onClick={operation.dismiss}>
                Close
              </Button>
              {retry && <Button onClick={retry}>{operation.retryLabel}</Button>}
              {primaryAction && (
                <Button
                  onClick={() => {
                    operation.dismiss();
                    void primaryAction.onClick();
                  }}
                >
                  {primaryAction.label}
                </Button>
              )}
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogTitle className="sr-only">{operation.message}</DialogTitle>
            <OperationLoading
              message={operation.message}
              deferred={operation.deferProgress}
              onDismiss={operation.allowDismiss ? operation.dismiss : undefined}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
