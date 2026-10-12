import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { formatNumber } from "../lib/time";
import { Button } from "./Button";
import { Spinner } from "./Spinner";

export interface ListPagerProps {
  /** Items loaded and shown. */
  shown: number;
  /** All matching items, when known ("50 of 1,284 grants"). */
  total?: number | undefined;
  /** "grant", or [singular, plural] for irregular words (default "item"). */
  noun?: string | readonly [string, string] | undefined;
  /** More items can be loaded (append-older paging). */
  hasMore?: boolean | undefined;
  onLoadMore?: (() => void) | undefined;
  /** A "load more" request is running. */
  loadingMore?: boolean | undefined;
  /** Button text (default "Load more <plural>"). */
  loadMoreLabel?: string | undefined;
  /**
   * Loading more failed: true for the standard message ("Couldn't load
   * more grants. The loaded grants are still shown."), or your own text.
   */
  error?: boolean | ReactNode;
  /** Retry after an error (default: onLoadMore). */
  onRetry?: (() => void) | undefined;
  /** A background refresh is running ("Updating…"). */
  updating?: boolean | undefined;
  /**
   * Load more (and Retry) can't be used right now, e.g. while a new result
   * set is loading after a filter change: the count stays, the button is
   * disabled.
   */
  disabled?: boolean | undefined;
  className?: string | undefined;
}

function nouns(noun: ListPagerProps["noun"]): readonly [string, string] {
  if (noun === undefined) return ["item", "items"];
  return typeof noun === "string" ? [noun, `${noun}s`] : noun;
}

/**
 * Footer for paged lists and tables: "N of M noun",
 * a "Load more" button, an inline error that keeps the loaded items, and an
 * "Updating…" state for background refreshes.
 */
export function ListPager({
  shown,
  total,
  noun,
  hasMore = false,
  onLoadMore,
  loadingMore = false,
  loadMoreLabel,
  error,
  onRetry,
  updating = false,
  disabled = false,
  className,
}: ListPagerProps) {
  const [one, many] = nouns(noun);
  const count =
    total !== undefined
      ? `${formatNumber(shown)} of ${formatNumber(total)} ${total === 1 ? one : many}`
      : `${formatNumber(shown)} ${shown === 1 ? one : many}`;
  const retry = onRetry ?? onLoadMore;
  return (
    <div className={cx("wb-list-pager", className)}>
      {error ? (
        <div className="wb-list-pager-error" role="alert">
          <span>
            {error === true
              ? `Couldn’t load more ${many}. The loaded ${many} are still shown.`
              : error}
          </span>
          {retry ? (
            <Button
              size="sm"
              icon="refresh"
              pending={loadingMore}
              disabled={disabled}
              onClick={retry}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      <span className="wb-list-pager-count" role="status">
        {count}
      </span>
      {updating ? (
        <span className="wb-list-pager-status" role="status">
          <Spinner />
          Updating…
        </span>
      ) : null}
      {hasMore && !error && onLoadMore ? (
        <Button
          size="sm"
          pending={loadingMore}
          disabled={disabled}
          onClick={onLoadMore}
        >
          {loadingMore ? "Loading…" : (loadMoreLabel ?? `Load more ${many}`)}
        </Button>
      ) : null}
    </div>
  );
}
