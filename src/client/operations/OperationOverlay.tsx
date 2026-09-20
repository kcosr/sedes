import * as Dialog from "@radix-ui/react-dialog";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "../components/ui/button.js";
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

export function OperationLoading({
  message,
  onCancel,
  cancelLabel = "Cancel",
  deferred = false,
}: {
  readonly message: string;
  readonly onCancel?: () => void;
  readonly cancelLabel?: string;
  readonly deferred?: boolean;
}): React.JSX.Element {
  return (
    <div className={`operation-progress${deferred ? " deferred" : ""}`}>
      <div role="status" className="operation-progress-message">
        <LoaderCircle className="operation-spinner" aria-hidden="true" />
        <span>{message}</span>
      </div>
      {onCancel && (
        <Button variant="outline" onClick={onCancel}>
          {cancelLabel}
        </Button>
      )}
    </div>
  );
}

export function useOperationContentFocus(
  phase: unknown,
): React.RefObject<HTMLDivElement | null> {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Move focus after a phase change, including button-free progress.
    if (content.current) {
      const target = content.current.querySelector<HTMLButtonElement>("button") ?? content.current;
      target.focus();
    }
  }, [phase]);
  return content;
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
  const content = useOperationContentFocus(operation?.error);
  useEffect(
    () => () => {
      getBlockingOperation()?.cancel();
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
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay operation-overlay-backdrop" />
        <Dialog.Content
          ref={content}
          className={
            operation.error
              ? "dialog-card operation-error"
              : "operation-overlay-content"
          }
          data-blocking-operation="true"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onKeyDown={(event) => event.stopPropagation()}
          aria-describedby={
            operation.error ? "operation-error-description" : undefined
          }
        >
          <Dialog.Title className="sr-only">{operation.message}</Dialog.Title>
          {operation.error ? (
            <>
              <Dialog.Description id="operation-error-description" role="alert">
                {operation.error}
              </Dialog.Description>
              <div className="operation-error-actions">
                <Button variant="outline" onClick={operation.cancel}>
                  Close
                </Button>
                {operation.retry && (
                  <Button onClick={operation.retry}>
                    {operation.retryLabel}
                  </Button>
                )}
                {operation.actions.map((action) => (
                  <Button
                    key={action.label}
                    onClick={() => {
                      operation.cancel();
                      void action.onClick();
                    }}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            </>
          ) : (
            <OperationLoading
              message={operation.message}
              deferred={operation.deferProgress}
              onCancel={operation.allowCancel ? operation.cancel : undefined}
              cancelLabel={operation.cancelLabel}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
