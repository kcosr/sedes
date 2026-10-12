import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { cx } from "../lib/cx";
import { useHotkey } from "../lib/hotkeys";
import { topLayer } from "../lib/layers";
import { Icon } from "./Icon";
import { Kbd } from "./Chips";

export interface FilterInputProps {
  value: string;
  /** Called with the new text (after `debounceMs`, immediately on Enter, clear and Esc). */
  onChange: (value: string) => void;
  placeholder: string;
  /** Accessible name (default: the placeholder). */
  label?: string | undefined;
  /**
   * Global shortcut that focuses this input (default "/"; null for none). Give
   * only one filter per screen the shortcut; secondary filters (sidebar) use null.
   */
  hotkey?: string | null | undefined;
  /** Delay before onChange while typing (default 0: every keystroke). */
  debounceMs?: number | undefined;
  id?: string | undefined;
  className?: string | undefined;
  autoFocus?: boolean | undefined;
  ref?: Ref<HTMLInputElement> | undefined;
}

/**
 * Search field: search icon, "/" hint that focuses it from anywhere, × to
 * clear when non-empty, Esc clears (and blurs when already empty).
 */
export function FilterInput({
  value,
  onChange,
  placeholder,
  label,
  hotkey = "/",
  debounceMs = 0,
  id,
  className,
  autoFocus,
  ref,
}: FilterInputProps) {
  const [text, setText] = useState(value);
  const last = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // External changes (back button, "clear filters") win over local text.
  useEffect(() => {
    if (value !== last.current) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      last.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const emit = (next: string, now = false) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const fire = () => {
      timer.current = null;
      last.current = next;
      onChangeRef.current(next);
    };
    if (now || debounceMs <= 0) fire();
    else timer.current = setTimeout(fire, debounceMs);
  };

  useHotkey(
    hotkey ?? "",
    (e) => {
      const el = input.current;
      // Skip inputs on hidden panes so another visible filter can take "/".
      if (
        !el ||
        (typeof el.checkVisibility === "function" && !el.checkVisibility())
      )
        return;
      el.focus();
      el.select();
      e.preventDefault();
    },
    { enabled: !!hotkey, preventDefault: false },
  );

  const setRefs = (el: HTMLInputElement | null) => {
    input.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };

  return (
    <div className={cx("wb-filter", className)}>
      <Icon name="search" />
      <input
        ref={setRefs}
        id={id}
        className="wb-filter-input"
        type="search"
        value={text}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        aria-keyshortcuts={hotkey ?? undefined}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
          emit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") emit(text, true);
          if (e.key === "Escape") {
            if (text) {
              e.stopPropagation();
              e.preventDefault();
              setText("");
              emit("", true);
            } else if (!topLayer()) {
              e.currentTarget.blur();
            }
          }
        }}
      />
      {text ? (
        <button
          type="button"
          className="wb-filter-clear"
          aria-label="Clear filter"
          onClick={() => {
            setText("");
            emit("", true);
            input.current?.focus();
          }}
        >
          <Icon name="x" />
        </button>
      ) : hotkey ? (
        <Kbd>{hotkey}</Kbd>
      ) : null}
    </div>
  );
}
