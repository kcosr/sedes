import { Bookmark, LoaderCircle } from "lucide-react";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import type { TurnBookmarkPreview } from "./turn-bookmark-presentation.js";

export type TurnBookmarkActionProps = {
  readonly turnId: string;
  readonly preview: TurnBookmarkPreview;
  readonly bookmarked: boolean;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly store: ThreadClientStore;
};

export function TurnBookmarkAction({ turnId, preview, bookmarked, disabled, pending, store }: TurnBookmarkActionProps): React.JSX.Element {
  return <button
    type="button"
    className="turn-fork-action turn-bookmark-toggle"
    aria-label={bookmarked ? "Remove response bookmark" : "Bookmark response"}
    aria-pressed={bookmarked}
    title={bookmarked ? "Remove bookmark" : "Bookmark response"}
    disabled={disabled || pending}
    onClick={() => void store.setTurnBookmarked(bookmarked
      ? { turnId, bookmarked: false }
      : { turnId, bookmarked: true, preview }).catch(() => undefined)}
  >
    {pending
      ? <LoaderCircle className="turn-bookmark-spinner" size={16} aria-hidden="true" />
      : <Bookmark size={16} fill={bookmarked ? "currentColor" : "none"} aria-hidden="true" />}
  </button>;
}
