import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ClipboardEvent, KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { layerDepth, useOverlayOwner } from "../lib/layers";
import { useAnchoredPosition } from "../lib/position";
import { Chip } from "./Chips";
import { useFieldControl } from "./Form";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

export interface ComboOption {
  value: string;
  label: string;
  description?: string | undefined;
  icon?: IconName | undefined;
  disabled?: boolean | undefined;
  /** Extra text matched by the built-in filter. */
  keywords?: readonly string[] | undefined;
}

interface ComboboxBaseProps {
  /** Static options, filtered as the user types. */
  options?: readonly ComboOption[] | undefined;
  /** Async typeahead: return options for the query (server-side filtering). */
  loadOptions?:
    | ((query: string, signal: AbortSignal) => Promise<readonly ComboOption[]>)
    | undefined;
  /** Minimum query length before loadOptions runs (default 0). */
  minQuery?: number | undefined;
  /** Debounce for loadOptions (default 150ms). */
  debounceMs?: number | undefined;
  /**
   * Typed text can be the value (e.g. email lists, free-text filters): it is
   * offered as the first option ("Add “x”") whenever no option matches it
   * exactly, so Enter commits the text as typed.
   */
  allowCustom?: boolean | undefined;
  /**
   * Match typed text case-sensitively everywhere (filtering, highlight,
   * exact matches). With allowCustom, exact matching is always
   * case-sensitive so typed identifiers are never re-cased.
   */
  matchCase?: boolean | undefined;
  /** Text of the free-text option (default `Add “x”`). */
  customOptionLabel?: ((text: string) => ReactNode) | undefined;
  /** Icon of the free-text option (default "plus"). */
  customOptionIcon?: IconName | undefined;
  /**
   * On blur (Tab, click elsewhere) commit what was typed: an option whose
   * label or value matches exactly, else the text itself when allowCustom;
   * a single-value combobox whose text was erased is cleared. Default: on
   * for multiple + allowCustom, off otherwise (typed text is discarded).
   */
  commitOnBlur?: boolean | undefined;
  /** Label for values whose option is not loaded (async pickers). */
  getLabel?: ((value: string) => string | undefined) | undefined;
  placeholder?: string | undefined;
  id?: string | undefined;
  "aria-label"?: string | undefined;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean | undefined;
  disabled?: boolean | undefined;
  emptyText?: string | undefined;
  className?: string | undefined;
}

export interface ComboboxSingleProps extends ComboboxBaseProps {
  multiple?: false | undefined;
  value: string | null;
  onChange: (value: string | null) => void;
}

export interface ComboboxMultipleProps extends ComboboxBaseProps {
  multiple: true;
  value: readonly string[];
  onChange: (value: string[]) => void;
  /**
   * Token entry, for lists of free values (with allowCustom): typing one of
   * these characters commits the typed text, and pasted text containing one
   * (or a line break or tab) is split into values. `[",", " "]` for emails.
   */
  separators?: readonly string[] | undefined;
  /**
   * Splits and normalizes typed or pasted text into values (default: split
   * on `separators`, line breaks and tabs, trim, drop empty parts). Return
   * [] to reject the text; it stays in the field.
   */
  parse?: ((text: string) => readonly string[]) | undefined;
}

export type ComboboxProps = ComboboxSingleProps | ComboboxMultipleProps;

function matches(o: ComboOption, text: string, matchCase: boolean): boolean {
  if (!text) return true;
  const hay = [o.label, o.value, ...(o.keywords ?? [])].join("\n");
  return matchCase
    ? hay.includes(text)
    : hay.toLowerCase().includes(text.toLowerCase());
}

function Highlight({
  text,
  query,
  matchCase,
}: {
  text: string;
  query: string;
  matchCase: boolean;
}): ReactNode {
  if (!query) return text;
  const i = matchCase
    ? text.indexOf(query)
    : text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

type Entry =
  | { kind: "custom"; text: string }
  | { kind: "option"; option: ComboOption };

const PAGE = 10;

/**
 * Accessible typeahead (ARIA combobox + listbox), single or multiple
 * selection. Keys: ↑/↓ move, Home/End and PageUp/PageDown jump while the
 * list is open, Enter selects the highlighted option, Esc closes (then
 * clears the text), Backspace on empty text removes the last chip / clears
 * the value. While typing, the highlight goes to an option whose label or
 * value equals the text, else to the first option (the free text itself
 * with allowCustom); arrow keys and the pointer move it from there.
 */
export function Combobox(props: ComboboxProps) {
  const {
    options,
    loadOptions,
    minQuery = 0,
    debounceMs = 150,
    allowCustom = false,
    customOptionLabel = (text: string) => <>Add “{text}”</>,
    customOptionIcon = "plus",
    commitOnBlur = !!props.multiple && allowCustom,
    matchCase = false,
    getLabel,
    placeholder,
    disabled = false,
    emptyText = "No matches",
    className,
  } = props;
  const wiring = useFieldControl(props);
  const autoId = useId();
  const inputId = wiring.id ?? `wb-combo-${autoId}`;
  const listId = `${inputId}-list`;
  const optionId = (i: number) => `${inputId}-opt-${i}`;

  const selected: readonly string[] = props.multiple
    ? props.value
    : props.value === null
      ? []
      : [props.value];

  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Until the user moves the highlight, it follows the typed text.
  const [navigated, setNavigated] = useState(false);
  const [remote, setRemote] = useState<{
    query: string;
    items: readonly ComboOption[];
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const box = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  // The portaled listbox counts as inside any overlay the combobox sits in.
  useOverlayOwner(list);
  // Paint above every overlay open when the listbox opens.
  useLayoutEffect(() => {
    if (open)
      list.current?.style.setProperty("--wb-z-depth", String(layerDepth() + 1));
  }, [open]);
  const labels = useRef(new Map<string, string>());

  for (const o of options ?? []) labels.current.set(o.value, o.label);
  for (const o of remote?.items ?? []) labels.current.set(o.value, o.label);
  const labelOf = (v: string) => getLabel?.(v) ?? labels.current.get(v) ?? v;

  const q = query.trim().toLowerCase();
  const async = !!loadOptions;
  const separators = props.multiple ? (props.separators ?? []) : [];
  const parse = props.multiple ? props.parse : undefined;
  // Token entry: free text is split into values (separators, paste, parse).
  const tokens = !!props.multiple && (separators.length > 0 || !!parse);

  // Async loading, debounced, cancelling the previous request.
  useEffect(() => {
    if (!loadOptions || !open) return;
    const text = query.trim();
    if (text.length < minQuery) {
      setRemote(null);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      loadOptions(text, ctrl.signal).then(
        (items) => {
          if (ctrl.signal.aborted) return;
          setRemote({ query: text, items });
          setLoading(false);
        },
        () => {
          if (ctrl.signal.aborted) return;
          setRemote({ query: text, items: [] });
          setLoading(false);
        },
      );
    }, debounceMs);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [loadOptions, open, query, minQuery, debounceMs]);

  // Async results are only usable for the query they were loaded for.
  const remoteItems =
    remote && remote.query === query.trim() ? remote.items : undefined;
  const shown: readonly ComboOption[] = useMemo(
    () =>
      async
        ? (remoteItems ?? [])
        : (options ?? []).filter((o) => matches(o, query.trim(), matchCase)),
    [async, remoteItems, options, query, matchCase],
  );
  const customText = query.trim();
  /**
   * The option the typed text names exactly (even if disabled): its label or
   * value equals the text. Case-sensitive with allowCustom or matchCase, so a
   * free-text value is never re-cased into an option; otherwise a unique
   * case-insensitive match counts too.
   */
  const exactAny = (list: readonly ComboOption[], text = customText) => {
    if (text === "") return undefined;
    const same = list.find((o) => o.label === text || o.value === text);
    if (same || allowCustom || matchCase) return same;
    const lower = text.toLowerCase();
    const folded = list.filter(
      (o) => o.label.toLowerCase() === lower || o.value.toLowerCase() === lower,
    );
    return folded.length === 1 ? folded[0] : undefined;
  };
  const exactOption = (list: readonly ComboOption[]) => {
    const o = exactAny(list);
    return o && !o.disabled ? o : undefined;
  };
  // Free text never stands in for an existing option, disabled ones included.
  const showCustom =
    allowCustom &&
    customText !== "" &&
    !exactAny(shown) &&
    !selected.includes(customText);
  const entries: readonly Entry[] = [
    ...(showCustom ? [{ kind: "custom" as const, text: customText }] : []),
    ...shown.map((option) => ({ kind: "option" as const, option })),
  ];
  const count = entries.length;
  const enabled = (i: number) => {
    const e = entries[i];
    return !!e && (e.kind === "custom" || !e.option.disabled);
  };
  /** Nearest enabled entry from `from` in direction `dir` (no wrap), or -1. */
  const nearest = (from: number, dir: 1 | -1) => {
    for (let i = from; i >= 0 && i < count; i += dir) if (enabled(i)) return i;
    return -1;
  };
  const exact = exactOption(shown);
  const defaultIndex =
    q !== ""
      ? exact
        ? entries.findIndex(
            (e) => e.kind === "option" && e.option.value === exact.value,
          )
        : allowCustom
          ? // Free text first; never a different option by default.
            showCustom
            ? 0
            : -1
          : matchCase
            ? // Only an exact match is highlighted; others need arrows.
              -1
            : nearest(0, 1)
      : (() => {
          const i = entries.findIndex(
            (e) => e.kind === "option" && selected.includes(e.option.value),
          );
          return i >= 0 ? i : nearest(0, 1);
        })();
  const cur =
    navigated && active >= 0 && active < count && enabled(active)
      ? active
      : defaultIndex;

  useEffect(() => {
    if (!open || cur < 0) return;
    document
      .getElementById(`${inputId}-opt-${cur}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, cur, inputId]);

  // Close on outside pointer down.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (box.current?.contains(t) || list.current?.contains(t))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const { style, measured } = useAnchoredPosition(
    open,
    box,
    list,
    "bottom-start",
    {
      matchWidth: true,
      gap: 4,
    },
  );

  // Disabled while open (e.g. during a save): close, drop pending text.
  useLayoutEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setQuery("");
    setEditing(false);
  }, [disabled]);

  const openList = () => {
    if (disabled || open) return;
    setNavigated(false);
    setOpen(true);
  };

  const highlight = (i: number) => {
    if (i < 0) return;
    setActive(i);
    setNavigated(true);
  };

  const commit = (value: string, label?: string) => {
    if (label) labels.current.set(value, label);
    if (props.multiple) {
      const has = props.value.includes(value);
      props.onChange(
        has ? props.value.filter((v) => v !== value) : [...props.value, value],
      );
      setQuery("");
      setEditing(false);
      setNavigated(false);
    } else {
      props.onChange(value);
      setQuery("");
      setEditing(false);
      setOpen(false);
    }
  };

  /**
   * What `text` stands for: the option it names exactly, else the text
   * itself with allowCustom; never a disabled option. Async results only
   * count for the query they were loaded for.
   */
  const choiceFor = (
    text: string,
  ): { value: string; label?: string } | undefined => {
    if (text === "") return undefined;
    const known = exactAny(
      async ? (remote?.query === text ? remote.items : []) : (options ?? []),
      text,
    );
    if (known)
      return known.disabled
        ? undefined
        : { value: known.value, label: known.label };
    return allowCustom ? { value: text } : undefined;
  };
  const typedChoice = () => choiceFor(customText);

  /** Token entry: the values in free text (parse, or split on separators). */
  const splitText = (text: string): readonly string[] => {
    if (parse) return parse(text);
    let parts = text.split(/[\r\n\t]/);
    for (const sep of separators)
      if (sep) parts = parts.flatMap((p) => p.split(sep));
    return parts.map((p) => p.trim()).filter(Boolean);
  };

  /**
   * Token entry: commit every value in `text` at once. Parts that stand for
   * nothing stay as the text; returns false (state untouched) when none do.
   */
  const commitParts = (text: string): boolean => {
    if (!props.multiple) return false;
    const next = [...props.value];
    const rest: string[] = [];
    let took = false;
    for (const part of splitText(text)) {
      const choice = choiceFor(part);
      if (!choice) {
        rest.push(part);
        continue;
      }
      took = true;
      if (next.includes(choice.value)) continue;
      if (choice.label) labels.current.set(choice.value, choice.label);
      next.push(choice.value);
    }
    if (!took) return false;
    if (next.length !== props.value.length) props.onChange(next);
    const sep = separators[0] ?? ",";
    const left = rest.join(/\s/.test(sep) ? sep : `${sep} `);
    setQuery(left);
    setEditing(left !== "");
    setNavigated(false);
    return true;
  };

  const pick = (index: number) => {
    const e = entries[index];
    if (!e || disabled) return;
    if (e.kind === "custom") {
      if (tokens) commitParts(e.text);
      else commit(e.text);
    } else if (!e.option.disabled) commit(e.option.value, e.option.label);
  };

  /** Blur/Tab with commitOnBlur: keep what was typed. */
  const commitTyped = () => {
    if (!editing || disabled) return;
    if (customText === "") {
      if (!props.multiple && selected.length > 0) props.onChange(null);
      return;
    }
    if (tokens) {
      commitParts(customText);
      return;
    }
    const choice = typedChoice();
    if (!choice) return;
    if (choice.label) labels.current.set(choice.value, choice.label);
    if (props.multiple) {
      if (!props.value.includes(choice.value))
        props.onChange([...props.value, choice.value]);
    } else if (choice.value !== props.value) {
      props.onChange(choice.value);
    }
  };

  const removeValue = (value: string) => {
    if (props.multiple) props.onChange(props.value.filter((v) => v !== value));
    else {
      props.onChange(null);
      // Clearing discards pending text too, so blur can't commit it again.
      setQuery("");
      setEditing(false);
    }
    input.current?.focus();
  };

  const move = (delta: 1 | -1) => {
    if (count === 0) return;
    // Nothing highlighted yet: ↓ starts at the first entry, ↑ at the last.
    if (cur < 0) {
      highlight(delta === 1 ? nearest(0, 1) : nearest(count - 1, -1));
      return;
    }
    let next = cur;
    for (let step = 0; step < count; step++) {
      next = (next + delta + count) % count;
      if (enabled(next)) break;
    }
    highlight(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Keys confirming an IME candidate belong to the IME.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) openList();
        else move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) {
          openList();
          highlight(nearest(count - 1, -1));
        } else move(-1);
        break;
      case "Home":
      case "End":
      case "PageUp":
      case "PageDown": {
        // While the list is open these move the highlight (not the caret).
        if (!open || count === 0) break;
        e.preventDefault();
        const from = cur < 0 ? 0 : cur;
        if (e.key === "Home") highlight(nearest(0, 1));
        else if (e.key === "End") highlight(nearest(count - 1, -1));
        else if (e.key === "PageUp")
          highlight(nearest(Math.max(0, from - PAGE), 1));
        else highlight(nearest(Math.min(count - 1, from + PAGE), -1));
        break;
      }
      case "Enter":
        // While the list is open or typed text is pending, Enter belongs to
        // the combobox (never an implicit form submit), even when it
        // commits nothing (e.g. only a disabled match). Otherwise it
        // submits the form as usual.
        if (open) {
          e.preventDefault();
          if (cur >= 0) pick(cur);
        } else if (editing) {
          e.preventDefault();
          // List closed (Esc): Enter confirms what was typed.
          if (tokens) {
            commitParts(customText);
            break;
          }
          const choice = typedChoice();
          if (choice && !(props.multiple && props.value.includes(choice.value)))
            commit(choice.value, choice.label);
        }
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        } else if (query) {
          e.preventDefault();
          e.stopPropagation();
          setQuery("");
          setEditing(false);
        }
        break;
      case "Backspace":
        if (query === "" && selected.length > 0) {
          const last = selected[selected.length - 1];
          if (last !== undefined && (props.multiple || !editing)) {
            e.preventDefault();
            removeValue(last);
          }
        }
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        // Token entry: a separator commits the typed text (it is never typed).
        if (tokens && separators.includes(e.key)) {
          e.preventDefault();
          if (customText !== "" && !disabled) commitParts(customText);
        }
        break;
    }
  };

  /** Token entry: a pasted list (with separators or line breaks) becomes values. */
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    if (!tokens || disabled) return;
    const pasted = e.clipboardData.getData("text");
    if (
      !/[\r\n\t]/.test(pasted) &&
      !separators.some((sep) => sep && pasted.includes(sep))
    )
      return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const text = el.value.slice(0, start) + pasted + el.value.slice(end);
    if (commitParts(text)) return;
    setQuery(text);
    setEditing(true);
    setNavigated(false);
    if (!open) setOpen(true);
  };

  const single = !props.multiple;
  const singleLabel =
    single && selected[0] !== undefined ? labelOf(selected[0]) : "";
  const inputValue = single && !editing ? singleLabel : query;
  const note =
    loading || (async && !remoteItems && query.trim().length >= minQuery)
      ? "Loading…"
      : async && query.trim().length < minQuery
        ? `Type ${minQuery} or more characters`
        : shown.length === 0 && !showCustom
          ? emptyText
          : null;

  return (
    <div
      ref={box}
      className={cx("wb-combo", disabled && "is-disabled", className)}
      aria-invalid={wiring["aria-invalid"] ? true : undefined}
      onMouseDown={(e) => {
        // Clicks on the frame focus the input (chips' × buttons handle themselves).
        if (e.target === box.current) {
          e.preventDefault();
          input.current?.focus();
          openList();
        }
      }}
    >
      {props.multiple
        ? props.value.map((v) => (
            <Chip
              key={v}
              onRemove={disabled ? undefined : () => removeValue(v)}
              removeLabel={`Remove ${labelOf(v)}`}
            >
              {labelOf(v)}
            </Chip>
          ))
        : null}
      <input
        ref={input}
        id={inputId}
        className="wb-combo-input"
        role="combobox"
        aria-label={props["aria-label"]}
        aria-describedby={wiring["aria-describedby"]}
        aria-invalid={wiring["aria-invalid"]}
        aria-expanded={open && !disabled}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && !disabled && cur >= 0 ? optionId(cur) : undefined
        }
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={
          props.multiple && props.value.length > 0 ? undefined : placeholder
        }
        value={inputValue}
        onChange={(e) => {
          setQuery(e.target.value);
          setEditing(true);
          setNavigated(false);
          if (!open && !disabled) setOpen(true);
        }}
        onClick={openList}
        onFocus={(e) => {
          // Typing replaces the shown label of a single selection.
          if (single) e.currentTarget.select();
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => {
          if (commitOnBlur) commitTyped();
          setOpen(false);
          setEditing(false);
          setQuery("");
        }}
      />
      {single && selected.length > 0 && !disabled ? (
        <button
          type="button"
          className="wb-combo-toggle"
          aria-label="Clear selection"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => removeValue(selected[0] ?? "")}
        >
          <Icon name="x" />
        </button>
      ) : (
        <button
          type="button"
          className="wb-combo-toggle"
          aria-label={open ? "Close options" : "Show options"}
          tabIndex={-1}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (open) setOpen(false);
            else {
              input.current?.focus();
              openList();
            }
          }}
        >
          <Icon name="chevron-down" />
        </button>
      )}
      {open && !disabled
        ? createPortal(
            <div
              ref={list}
              className={cx("wb-listbox", !measured && "is-measuring")}
              style={style}
            >
              <ul
                id={listId}
                role="listbox"
                aria-label={props["aria-label"] ?? "Options"}
                aria-multiselectable={props.multiple ? true : undefined}
                className="wb-rows"
              >
                {entries.map((entry, i) => {
                  if (entry.kind === "custom") {
                    return (
                      <li
                        key="\u0000custom"
                        id={optionId(i)}
                        role="option"
                        aria-selected={false}
                        className={cx("wb-option", i === cur && "is-active")}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseMove={() => {
                          if (i !== cur) highlight(i);
                        }}
                        onClick={() => pick(i)}
                      >
                        <span className="wb-option-check">
                          <Icon name={customOptionIcon} />
                        </span>
                        <span className="wb-option-text">
                          <span className="wb-option-label">
                            {customOptionLabel(entry.text)}
                          </span>
                        </span>
                      </li>
                    );
                  }
                  const o = entry.option;
                  const isSelected = selected.includes(o.value);
                  return (
                    <li
                      key={o.value}
                      id={optionId(i)}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={o.disabled ? true : undefined}
                      className={cx("wb-option", i === cur && "is-active")}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => {
                        if (i !== cur && !o.disabled) highlight(i);
                      }}
                      onClick={() => pick(i)}
                    >
                      <span className="wb-option-check">
                        {isSelected ? <Icon name="check" /> : null}
                      </span>
                      {o.icon ? <Icon name={o.icon} /> : null}
                      <span className="wb-option-text">
                        <span className="wb-option-label">
                          <Highlight
                            text={o.label}
                            query={async ? "" : query.trim()}
                            matchCase={matchCase}
                          />
                        </span>
                        {o.description ? (
                          <span className="wb-option-desc">
                            {o.description}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {note ? (
                <div className="wb-listbox-note" role="status">
                  {note}
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
