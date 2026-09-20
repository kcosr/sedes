import * as Popover from "@radix-ui/react-popover";
import { Bookmark, LoaderCircle, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { TurnBookmark } from "../../../shared/index.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { Button } from "../ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog.js";

function BookmarkList({
  bookmarks,
  status,
  error,
  pendingTurnIds,
  store,
  onSelectTurn,
}: {
  readonly bookmarks: readonly TurnBookmark[];
  readonly status: "loading" | "ready" | "error";
  readonly error?: string;
  readonly pendingTurnIds: readonly string[];
  readonly store: ThreadClientStore;
  readonly onSelectTurn: (turnId: string) => void;
}): React.JSX.Element {
  if (status === "loading" && bookmarks.length === 0) {
    return (
      <p className="turn-bookmarks-empty" role="status">
        <LoaderCircle className="turn-bookmark-spinner" size={16} /> Loading
        bookmarks…
      </p>
    );
  }
  if (status === "error" && bookmarks.length === 0) {
    return (
      <div className="turn-bookmarks-empty" role="alert">
        <p>{error ?? "Bookmarks could not be loaded."}</p>
        <Button
          variant="outline"
          size="xs"
          onClick={() => void store.loadBookmarks()}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (bookmarks.length === 0) {
    return (
      <p className="turn-bookmarks-empty">
        Bookmark a user message to find that turn here.
      </p>
    );
  }
  return (
    <>
      {error && (
        <p className="turn-bookmarks-error" role="alert">
          {error}
        </p>
      )}
      <ol className="turn-bookmarks-list">
        {bookmarks.map((bookmark) => {
          const pending =
            status !== "ready" || pendingTurnIds.includes(bookmark.turnId);
          return (
            <li key={bookmark.turnId} className="turn-bookmark-row">
              <button
                type="button"
                className="turn-bookmark-link"
                onClick={() => onSelectTurn(bookmark.turnId)}
              >
                <span className="turn-bookmark-user-preview">
                  <span className="sr-only">You: </span>
                  {bookmark.userPreview}
                </span>
                <span
                  className="turn-bookmark-assistant-preview"
                  data-response-state={bookmark.responseState}
                >
                  <span className="sr-only">Assistant: </span>
                  {bookmark.assistantPreview ?? "No assistant response."}
                </span>
              </button>
              <button
                type="button"
                className="turn-bookmark-remove"
                aria-label={`Remove bookmark: ${bookmark.userPreview}`}
                title="Remove bookmark"
                disabled={pending}
                onClick={() =>
                  void store
                    .setTurnBookmarked({
                      turnId: bookmark.turnId,
                      bookmarked: false,
                    })
                    .catch(() => undefined)
                }
              >
                {pending ? (
                  <LoaderCircle
                    className="turn-bookmark-spinner"
                    size={15}
                    aria-hidden="true"
                  />
                ) : (
                  <Trash2 size={15} aria-hidden="true" />
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

export function TurnBookmarksMenu({
  bookmarks,
  status,
  error,
  pendingTurnIds,
  store,
  mobile,
  onSelectTurn,
}: {
  readonly bookmarks: readonly TurnBookmark[];
  readonly status: "loading" | "ready" | "error";
  readonly error?: string;
  readonly pendingTurnIds: readonly string[];
  readonly store: ThreadClientStore;
  readonly mobile: boolean;
  readonly onSelectTurn: (turnId: string) => boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const pendingSelectionRef = useRef<string | undefined>(undefined);
  const selectTurn = (turnId: string) => {
    pendingSelectionRef.current = turnId;
    setOpen(false);
  };
  const completePendingSelection = (event: { preventDefault(): void }) => {
    const turnId = pendingSelectionRef.current;
    if (!turnId) {
      return;
    }
    pendingSelectionRef.current = undefined;
    if (onSelectTurn(turnId)) {
      event.preventDefault();
    }
  };
  const trigger = (
    <Button
      variant={open ? "secondary" : "ghost"}
      size="icon"
      className="thread-bookmarks-trigger"
      aria-label={`Bookmarks${bookmarks.length > 0 ? `, ${bookmarks.length}` : ""}`}
      title="Bookmarks"
      data-has-items={bookmarks.length > 0 || undefined}
    >
      <Bookmark size={19} strokeWidth={1.8} aria-hidden="true" />
    </Button>
  );
  const body = (
    <BookmarkList
      bookmarks={bookmarks}
      status={status}
      error={error}
      pendingTurnIds={pendingTurnIds}
      store={store}
      onSelectTurn={selectTurn}
    />
  );

  if (mobile) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        <DialogContent
          className="thread-settings-sheet turn-bookmarks-sheet"
          overlayClassName="thread-settings-sheet-overlay"
          onCloseAutoFocus={completePendingSelection}
        >
          <DialogTitle>Bookmarks</DialogTitle>
          <DialogDescription>Saved turns in this thread.</DialogDescription>
          <div className="thread-settings-sheet-body">{body}</div>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="turn-bookmarks-popover"
          align="end"
          sideOffset={8}
          onCloseAutoFocus={completePendingSelection}
        >
          <h2>Bookmarks</h2>
          {body}
          <Popover.Arrow className="popover-arrow" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
