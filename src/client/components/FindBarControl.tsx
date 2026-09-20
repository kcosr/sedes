import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { RefObject } from "react";
import { Button } from "./ui/button.js";

export interface FindBarControlProps {
  readonly id: string;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly query: string;
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly countLabel?: string;
  readonly interactive: boolean;
  readonly canMove: boolean;
  readonly matchCase?: boolean;
  readonly wholeWord?: boolean;
  readonly onQueryChange: (query: string) => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onMatchCaseChange?: (matchCase: boolean) => void;
  readonly onWholeWordChange?: (wholeWord: boolean) => void;
  readonly onClose: () => void;
}

/** Shared find-field chrome; each surface supplies its own search adapter. */
export function FindBarControl({
  id,
  inputRef,
  query,
  inputLabel,
  placeholder,
  countLabel = "",
  interactive,
  canMove,
  matchCase,
  wholeWord,
  onQueryChange,
  onMove,
  onMatchCaseChange,
  onWholeWordChange,
  onClose,
}: FindBarControlProps): React.JSX.Element {
  return (
    <div
      className="thread-find-control"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <Search aria-hidden="true" size={15} strokeWidth={1.8} />
      <label className="sr-only" htmlFor={`${id}-input`}>
        {inputLabel}
      </label>
      <input
        ref={inputRef}
        id={`${id}-input`}
        type="search"
        autoComplete="off"
        placeholder={placeholder}
        spellCheck={false}
        tabIndex={interactive ? 0 : -1}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onMove(event.shiftKey ? -1 : 1);
        }}
      />
      <span
        className="thread-find-count"
        id={`${id}-count`}
        role="status"
        aria-live="polite"
      >
        {countLabel}
      </span>
      {onMatchCaseChange ? (
        <Button
          type="button"
          variant={matchCase ? "secondary" : "ghost"}
          size="icon-sm"
          className="thread-find-option"
          aria-label="Match case"
          aria-pressed={matchCase}
          title="Match case"
          tabIndex={interactive ? 0 : -1}
          onClick={() => onMatchCaseChange(!matchCase)}
        >
          Aa
        </Button>
      ) : null}
      {onWholeWordChange ? (
        <Button
          type="button"
          variant={wholeWord ? "secondary" : "ghost"}
          size="icon-sm"
          className="thread-find-option thread-find-whole-word"
          aria-label="Match whole word"
          aria-pressed={wholeWord}
          title="Match whole word"
          tabIndex={interactive ? 0 : -1}
          onClick={() => onWholeWordChange(!wholeWord)}
        >
          ab
        </Button>
      ) : null}
      {onMatchCaseChange || onWholeWordChange ? (
        <span className="thread-find-divider" aria-hidden="true" />
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={!canMove}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        tabIndex={interactive ? 0 : -1}
        onClick={() => onMove(-1)}
      >
        <ChevronUp aria-hidden="true" size={16} strokeWidth={1.8} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={!canMove}
        aria-label="Next match"
        title="Next match (Enter)"
        tabIndex={interactive ? 0 : -1}
        onClick={() => onMove(1)}
      >
        <ChevronDown aria-hidden="true" size={16} strokeWidth={1.8} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Close find"
        title="Close find (Escape)"
        tabIndex={interactive ? 0 : -1}
        onClick={onClose}
      >
        <X aria-hidden="true" size={16} strokeWidth={1.8} />
      </Button>
    </div>
  );
}
