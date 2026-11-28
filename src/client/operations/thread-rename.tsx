import { useCallback, useId, useSyncExternalStore } from "react";
import type { NormalizedApplicationThreadSummary } from "../../shared/index.js";
import { ApiError } from "../api/ApiClient.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { Button } from "@client/components/ui/button";

type Thread = Pick<
  NormalizedApplicationThreadSummary,
  "id" | "title" | "threadRevision"
>;
type Phase = "editing" | "submitting" | "uncertain" | "rejected";
interface Edit {
  readonly surface: string;
  readonly original: string;
  readonly revision: number;
  readonly text: string;
  readonly phase: Phase;
  readonly mutationId?: string;
  readonly message?: string;
}

class ThreadRenames {
  private edits = new Map<string, Edit>();
  private listeners = new Map<string, Set<() => void>>();
  constructor(private store: ApplicationClientStore) {}

  subscribe(id: string, listener: () => void) {
    const listeners = this.listeners.get(id) ?? new Set<() => void>();
    this.listeners.set(id, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }
  get(id: string) {
    return this.edits.get(id);
  }
  private set(id: string, edit?: Edit) {
    if (edit) this.edits.set(id, edit);
    else this.edits.delete(id);
    this.listeners.get(id)?.forEach((listener) => listener());
  }
  begin(thread: Thread, surface: string) {
    const edit = this.get(thread.id);
    this.set(
      thread.id,
      edit
        ? { ...edit, surface }
        : {
            surface,
            original: thread.title.text,
            revision: thread.threadRevision,
            text: thread.title.text,
            phase: "editing",
          },
    );
  }
  update(id: string, surface: string, text: string) {
    const edit = this.get(id);
    if (edit?.surface === surface && edit.phase === "editing")
      this.set(id, { ...edit, text });
  }
  cancel(id: string, surface: string) {
    const edit = this.get(id);
    if (
      edit?.surface === surface &&
      (edit.phase === "editing" || edit.phase === "rejected")
    )
      this.set(id);
  }
  restart(thread: Thread, surface: string) {
    const edit = this.get(thread.id);
    if (edit?.surface === surface && edit.phase === "rejected")
      this.set(thread.id, {
        surface: edit.surface,
        original: thread.title.text,
        revision: thread.threadRevision,
        text: edit.text,
        phase: "editing",
      });
  }
  async submit(id: string, surface: string, check = false) {
    const edit = this.get(id);
    if (
      !edit ||
      edit.surface !== surface ||
      edit.phase !== (check ? "uncertain" : "editing")
    )
      return;
    const text = edit.text.trim();
    if (!text || text === edit.original) {
      this.set(id);
      return;
    }
    const mutationId = edit.mutationId ?? crypto.randomUUID();
    const attempt: Edit = { ...edit, text, mutationId, phase: "submitting" };
    this.set(id, attempt);
    try {
      const result = await this.store.renameThread(
        id,
        text,
        edit.revision,
        mutationId,
      );
      if (result.status === "accepted" && result.operationId === mutationId) {
        this.set(id);
        return;
      }
      this.set(id, {
        ...(this.get(id) ?? attempt),
        phase: "uncertain",
        message:
          result.status === "recovery_required" && result.diagnostic
            ? result.diagnostic
            : "The submitted title has not been confirmed.",
      });
    } catch (cause) {
      const rejected =
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        cause.code !== "operation_outcome_uncertain" &&
        cause.code !== "backend_submission_unknown" &&
        cause.status !== 408;
      this.set(id, {
        ...(this.get(id) ?? attempt),
        phase: rejected ? "rejected" : "uncertain",
        message:
          cause instanceof ApiError
            ? cause.message
            : "The title may have been saved. Check its status to continue.",
      });
    }
  }
}

const connections = new WeakMap<ApplicationClientStore, ThreadRenames>();
export function useThreadRename(
  store: ApplicationClientStore,
  thread: Thread,
  surface: string,
) {
  let operations = connections.get(store);
  if (!operations) {
    operations = new ThreadRenames(store);
    connections.set(store, operations);
  }
  const renames = operations;
  const get = useCallback(() => renames.get(thread.id), [renames, thread.id]);
  const subscribe = useCallback(
    (listener: () => void) => renames.subscribe(thread.id, listener),
    [renames, thread.id],
  );
  const edit = useSyncExternalStore(subscribe, get);
  return {
    edit: edit?.surface === surface ? edit : undefined,
    begin: () => renames.begin(thread, surface),
    update: (text: string) => renames.update(thread.id, surface, text),
    submit: () => {
      void renames.submit(thread.id, surface);
    },
    check: () => {
      void renames.submit(thread.id, surface, true);
    },
    cancel: () => renames.cancel(thread.id, surface),
    restart: () => renames.restart(thread, surface),
    currentTitle: thread.title.text,
  };
}

export function ThreadRenameEditor({
  rename,
  onKeyboardFinish,
  children,
  className,
  sidebar,
}: {
  readonly rename: ReturnType<typeof useThreadRename>;
  readonly onKeyboardFinish: () => void;
  readonly children?: React.ReactNode;
  readonly className: string;
  readonly sidebar?: boolean;
}) {
  const inputId = useId();
  const edit = rename.edit!;
  const hasFeedback = edit.phase === "uncertain" || edit.phase === "rejected";
  return (
    <div className={hasFeedback ? "grid w-full min-w-0 gap-1" : "contents"}>
      <form
        className={className}
        onSubmit={(event) => {
          event.preventDefault();
          if (edit.phase !== "editing") return;
          onKeyboardFinish();
          rename.submit();
        }}
      >
        {children}
        <label className="sr-only" htmlFor={inputId}>
          Thread title
        </label>
        <input
          id={inputId}
          data-testid={sidebar ? "thread-row-rename" : undefined}
          autoFocus={edit.phase === "editing"}
          maxLength={240}
          value={edit.text}
          readOnly={edit.phase !== "editing"}
          aria-busy={edit.phase === "submitting"}
          onChange={(event) => rename.update(event.target.value)}
          onBlur={rename.submit}
          onKeyDown={(event) => {
            if (
              event.key === "Escape" &&
              (edit.phase === "editing" || edit.phase === "rejected")
            ) {
              event.stopPropagation();
              onKeyboardFinish();
              rename.cancel();
            }
          }}
        />
      </form>
      {hasFeedback && (
        <div className="thread-row-error" role="alert">
          <p>{edit.message}</p>
          {edit.phase === "uncertain" ? (
            <Button size="sm" onClick={rename.check}>
              Check rename status
            </Button>
          ) : (
            <>
              <p>Current title: {rename.currentTitle || "Untitled thread"}</p>
              <Button size="sm" onClick={rename.restart}>
                Edit again
              </Button>
              <Button size="sm" variant="ghost" onClick={rename.cancel}>
                Cancel
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
