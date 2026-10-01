import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { Button } from "@client/components/ui/button";
import {
  Dialog, DialogAlert, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@client/components/ui/dialog";
import { ArchiveChoicesDialog } from "../components/thread/ArchiveChoicesDialog.js";
import {
  type ApplicationClientStore,
  useApplicationStore,
} from "../stores/ApplicationClientStore.js";
import { getBlockingOperation, subscribeBlockingOperation } from "./blocking-operation.js";
import { getThreadArchiveOperations, type ThreadArchiveOperation } from "./thread-archive.js";

/** Mounted with the application connection, outside routes and mobile drawers. */
export function ThreadArchiveOperationHost({ store }: { readonly store: ApplicationClientStore }) {
  const operations = getThreadArchiveOperations(store);
  const state = useSyncExternalStore(operations.subscribe, operations.getSnapshot);
  const progress = useSyncExternalStore(subscribeBlockingOperation, getBlockingOperation);
  const operation = state.find(({ result }) => result);
  // A late result must not replace another operation's progress or focus.
  if (progress || !operation) return null;
  return <ArchiveResult key={operation.id} store={store} operation={operation} />;
}

function ArchiveResult({ store, operation }: {
  readonly store: ApplicationClientStore;
  readonly operation: ThreadArchiveOperation;
}) {
  const state = useApplicationStore(store);
  const errorId = useId();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const operations = getThreadArchiveOperations(store);
  const close = () => operations.closeResult(operation.id);
  // Imported threads or unloaded descendant pages may not be in the inventory.
  const thread = state.snapshot?.threads.find(({ id }) => id === operation.thread.id)
    ?? operation.thread;
  const result = operation.result!;
  const error = result.kind === "error" ? result.message : undefined;
  if (error !== undefined) return (
    <Dialog open onOpenChange={close}>
      <DialogContent layer="blocking" showClose={false}
        returnFocusRef={operation.returnFocusRef} aria-describedby={errorId}>
        <DialogHeader>
          <DialogTitle>Could not archive thread</DialogTitle>
          <DialogDescription>{thread.title.text}</DialogDescription>
        </DialogHeader>
        <DialogBody><DialogAlert id={errorId} tone="danger">{error}</DialogAlert></DialogBody>
        <DialogFooter><Button onClick={close}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
  if (result.kind !== "choices") return null;
  return (
    <ArchiveChoicesDialog
      thread={thread}
      store={store}
      descendantCount={result.impact.descendantCount}
      initialImpact={result.impact}
      disabled={!state.authoritative || state.connection !== "connected" || !thread.available}
      returnFocusRef={operation.returnFocusRef}
      onOpenChange={(open) => { if (!open) close(); }}
      onPendingChange={operation.onPendingChange}
      onArchived={(choice, ids) => {
        if (mounted.current) operation.onArchived?.(choice, ids);
        close();
      }}
    />
  );
}
