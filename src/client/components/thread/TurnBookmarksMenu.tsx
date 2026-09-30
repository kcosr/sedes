import { Bookmark, LoaderCircle, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { TurnBookmark } from "../../../shared/index.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@client/components/ui/dialog";
import {
  menuDescriptionClass,
  menuEmptyClass,
  menuHeaderClass,
  menuListRowClass,
  menuRowActionClass,
  menuRowClass,
} from "@client/components/ui/floating";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@client/components/ui/popover";
import { moveListFocus } from "@client/lib/list-focus";
import { cn } from "@client/lib/utils";

function BookmarkList({
  bookmarks,
  status,
  error,
  pendingTurnIds,
  store,
  className,
  onSelectTurn,
}: {
  readonly bookmarks: readonly TurnBookmark[];
  readonly status: "loading" | "ready" | "error";
  readonly error?: string;
  readonly pendingTurnIds: readonly string[];
  readonly store: ThreadClientStore;
  readonly className?: string;
  readonly onSelectTurn: (turnId: string) => void;
}): React.JSX.Element {
  if (status === "loading" && bookmarks.length === 0) {
    return (
      <p className={cn(menuEmptyClass, "m-0")} role="status">
        <LoaderCircle aria-hidden="true" /> Loading bookmarks…
      </p>
    );
  }
  if (status === "error" && bookmarks.length === 0) {
    return (
      <Callout
        tone="danger"
        role="alert"
        action={
          <Button
            variant="outline"
            size="xs"
            onClick={() => void store.loadBookmarks()}
          >
            Try again
          </Button>
        }
      >
        {error ?? "Bookmarks could not be loaded."}
      </Callout>
    );
  }
  if (bookmarks.length === 0) {
    return (
      <p className={cn(menuEmptyClass, "m-0")}>
        Bookmark a user message to find that turn here.
      </p>
    );
  }
  return (
    <>
      {error && (
        <Callout tone="danger" role="alert" className="shrink-0">
          {error}
        </Callout>
      )}
      <ol
        className={cn(
          "m-0 flex min-h-0 flex-1 list-none flex-col overflow-y-auto overscroll-contain p-0",
          className,
        )}
        onKeyDown={(event) => {
          const links = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              '[data-slot="turn-bookmark-link"]',
            ),
          );
          if (moveListFocus(links, event.key)) event.preventDefault();
        }}
      >
        {bookmarks.map((bookmark) => {
          const pending =
            status !== "ready" || pendingTurnIds.includes(bookmark.turnId);
          return (
            <li key={bookmark.turnId} className={menuListRowClass}>
              <button
                type="button"
                data-slot="turn-bookmark-link"
                className={cn(menuRowClass, "w-auto min-w-0 flex-1")}
                onClick={() => onSelectTurn(bookmark.turnId)}
              >
                <span className="min-w-0 flex-1">
                  <span
                    data-slot="turn-bookmark-item-title"
                    className="block truncate"
                  >
                    <span className="sr-only">You: </span>
                    {bookmark.userPreview}
                  </span>
                  <span
                    data-slot="turn-bookmark-item-description"
                    data-response-state={bookmark.responseState}
                    className={cn(
                      menuDescriptionClass,
                      "truncate data-[response-state=no_response]:italic",
                    )}
                  >
                    <span className="sr-only">Assistant: </span>
                    {bookmark.assistantPreview ?? "No assistant response."}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className={menuRowActionClass}
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
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 aria-hidden="true" />
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/**
 * The thread's bookmarked turns: a list popover from the header, or the
 * shared bottom sheet under the density switch. Choosing a turn closes the
 * surface first and scrolls to the turn once focus would return.
 */
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
  const titleId = useId();
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
  const list = (className?: string) => (
    <BookmarkList
      bookmarks={bookmarks}
      status={status}
      error={error}
      pendingTurnIds={pendingTurnIds}
      store={store}
      className={className}
      onSelectTurn={selectTurn}
    />
  );

  if (mobile) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        <DialogContent
          layout="sheet"
          size="md"
          onCloseAutoFocus={completePendingSelection}
        >
          <DialogHeader>
            <DialogTitle>Bookmarks</DialogTitle>
            <DialogDescription>Saved turns in this thread.</DialogDescription>
          </DialogHeader>
          {/* Rows reach into the inset so their text lines up with the title. */}
          <DialogBody>{list("-mx-2")}</DialogBody>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        aria-labelledby={titleId}
        className="max-h-[min(var(--radix-popover-content-available-height),70dvh)] w-[min(380px,calc(100vw-16px))] gap-1 overflow-hidden p-(--menu-panel-padding)"
        onCloseAutoFocus={completePendingSelection}
      >
        <PopoverTitle id={titleId} className={cn(menuHeaderClass, "m-0")}>
          Bookmarks
        </PopoverTitle>
        {list()}
      </PopoverContent>
    </Popover>
  );
}
