import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight, CircleAlert, Plus, X } from "lucide-react";
import { SettingsField, type SettingsFieldProps } from "../settings/SettingsField.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Checkbox } from "../ui/checkbox.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { controlVariants, useFieldControl } from "../ui/control.js";
import { Input } from "../ui/input.js";
import { NativeSelect } from "../ui/native-select.js";
import { Tag } from "../ui/tag.js";
import { cn } from "../../lib/utils.js";

type RowProps = Pick<SettingsFieldProps, "label" | "description" | "error" | "disabled" | "layout">;

/** A text setting in the settings row layout. Optional values are left blank, never filled with a default. */
export function TextField({ value, onChange, required = false, type = "text", placeholder, suffix, mono = false, ...row }: RowProps & {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly required?: boolean;
  readonly type?: "text" | "number" | "url";
  readonly placeholder?: string;
  /** A unit shown after the value, such as "ms". */
  readonly suffix?: string;
  /** Paths and identifiers. */
  readonly mono?: boolean;
}): React.JSX.Element {
  const input = <Input type={type} value={value} required={required} disabled={row.disabled} placeholder={placeholder}
    autoComplete="off" spellCheck={false} className={cn(mono && "font-mono", suffix && "pr-9")}
    onChange={(event) => onChange(event.currentTarget.value)} />;
  return <SettingsField {...row}>
    {suffix ? <span className="execution-field-affix">{input}<span aria-hidden="true">{suffix}</span></span> : input}
  </SettingsField>;
}

export interface SelectOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
}

export function SelectField<T extends string>({ value, onChange, options, ...row }: RowProps & {
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: ReadonlyArray<SelectOption<T>>;
}): React.JSX.Element {
  return <SettingsField {...row}>
    <NativeSelect value={value} disabled={row.disabled} onChange={(event) => {
      const option = options.find(({ value: candidate }) => candidate === event.currentTarget.value);
      if (option && !option.disabled) onChange(option.value);
    }}>
      {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </NativeSelect>
  </SettingsField>;
}

/**
 * A setting that is fixed after creation. It reads as a value with a
 * "Locked" tag, not as a washed-out disabled control.
 */
export function ReadOnlyField({ label, value, description, mono = false, locked = true }: {
  readonly label: string;
  readonly value: ReactNode;
  readonly description?: ReactNode;
  readonly mono?: boolean;
  /** Fixed for good, rather than set by an earlier step. */
  readonly locked?: boolean;
}): React.JSX.Element {
  const id = useId();
  return <div data-slot="settings-field" data-orientation="horizontal" role="group" aria-labelledby={`${id}label`}
    aria-describedby={description ? `${id}description` : undefined} className="execution-read-only-field">
    <div data-slot="field-text">
      <span id={`${id}label`} className="execution-read-only-label">{label}</span>
      {description ? <p id={`${id}description`} className="execution-field-description">{description}</p> : null}
    </div>
    <div data-slot="field-control" className="execution-read-only-value">
      <span className={cn(mono && "font-mono")}>{value}</span>{locked ? <Tag>Locked</Tag> : null}
    </div>
  </div>;
}

function FieldError({ id, children }: { readonly id?: string; readonly children: ReactNode }): React.JSX.Element {
  return <p id={id} data-slot="field-error" className="execution-field-error"><CircleAlert aria-hidden="true" /><span>{children}</span></p>;
}

/**
 * An ordered list of short values (workspace roots): one input per entry
 * with a remove button, and an add button. Each entry carries its own error.
 */
export function ListField({ label, description, error, itemErrors = [], value, onChange, itemLabel, addLabel, placeholder, disabled = false }: {
  readonly label: string;
  readonly description?: ReactNode;
  /** An error about the whole list, such as "Add at least one". */
  readonly error?: string;
  readonly itemErrors?: ReadonlyArray<string | undefined>;
  readonly value: readonly string[];
  readonly onChange: (value: string[]) => void;
  /** Names one entry for assistive technology, e.g. "Workspace root". */
  readonly itemLabel: string;
  readonly addLabel: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
}): React.JSX.Element {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  // An empty list still offers one blank entry to type into.
  const entries = value.length ? value : [""];
  // Only blank entries is an empty list, so it reads as "none" rather than one blank path.
  const emit = (next: string[]) => onChange(next.every((current) => !current) ? [] : next);
  const set = (index: number, entry: string) => emit(entries.map((current, position) => position === index ? entry : current));
  const remove = (index: number) => {
    emit(entries.filter((_, position) => position !== index));
    requestAnimationFrame(() => list.current?.querySelectorAll<HTMLInputElement>("input")[Math.max(0, index - 1)]?.focus());
  };
  const add = () => {
    onChange([...entries, ""]);
    requestAnimationFrame(() => Array.from(list.current?.querySelectorAll<HTMLInputElement>("input") ?? []).at(-1)?.focus());
  };
  return <div data-slot="settings-field" data-orientation="vertical" role="group" aria-labelledby={`${id}label`}
    aria-describedby={[error ? `${id}error` : "", description ? `${id}description` : ""].filter(Boolean).join(" ") || undefined}
    className="execution-list-field">
    <div data-slot="field-text">
      <span id={`${id}label`} className="execution-read-only-label">{label}</span>
      {description ? <p id={`${id}description`} className="execution-field-description">{description}</p> : null}
    </div>
    <div ref={list} className="execution-list-field-entries">
      {entries.map((entry, index) => {
        const entryError = itemErrors[index];
        return <div key={index} className="execution-list-field-entry">
          <div className="execution-list-field-row">
            <Input value={entry} disabled={disabled} placeholder={placeholder} autoComplete="off" spellCheck={false} className="font-mono"
              aria-label={`${itemLabel} ${index + 1}`} aria-invalid={Boolean(entryError) || undefined}
              aria-describedby={entryError ? `${id}entry${index}` : undefined}
              onChange={(event) => set(index, event.currentTarget.value)} />
            <Button type="button" variant="ghost" size="icon" disabled={disabled || (entries.length === 1 && !entry)}
              aria-label={`Remove ${itemLabel.toLowerCase()} ${index + 1}`} onClick={() => remove(index)}><X /></Button>
          </div>
          {entryError ? <FieldError id={`${id}entry${index}`}>{entryError}</FieldError> : null}
        </div>;
      })}
    </div>
    <Button type="button" variant="ghost" size="sm" className="execution-list-field-add" disabled={disabled || entries.length >= 16} onClick={add}><Plus />{addLabel}</Button>
    {error ? <FieldError id={`${id}error`}>{error}</FieldError> : null}
  </div>;
}

/** Splits pasted or typed text into entries on commas and line breaks. */
export function splitTokens(text: string): string[] {
  return text.split(/[\n,]/u).map((entry) => entry.trim()).filter(Boolean);
}

function TokenInput({ value, onChange, placeholder, disabled }: {
  readonly value: readonly string[];
  readonly onChange: (value: string[]) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const control = useFieldControl<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>({});
  const commit = (raw = text) => {
    const additions = splitTokens(raw).filter((entry) => !value.includes(entry));
    setText("");
    if (additions.length) onChange([...value, ...new Set(additions)]);
  };
  return <div className={cn(controlVariants({ size: "multiline" }), "execution-token-input")} data-disabled={disabled || undefined}
    aria-invalid={control["aria-invalid"]} onClick={() => input.current?.focus()}>
    {value.map((entry) => <span key={entry} className="execution-token">
      <span>{entry}</span>
      <button type="button" aria-label={`Remove ${entry}`} disabled={disabled}
        onClick={(event) => { event.stopPropagation(); onChange(value.filter((candidate) => candidate !== entry)); input.current?.focus(); }}><X aria-hidden="true" /></button>
    </span>)}
    <input ref={input} {...control} value={text} disabled={disabled} placeholder={value.length ? undefined : placeholder}
      autoComplete="off" spellCheck={false}
      onChange={(event) => {
        const next = event.currentTarget.value;
        if (/[\n,]/u.test(next)) commit(next); else setText(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        else if (event.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
      }}
      onPaste={(event) => {
        const pasted = event.clipboardData.getData("text");
        if (/[\n,]/u.test(pasted)) { event.preventDefault(); commit(`${text}${pasted}`); }
      }}
      onBlur={() => commit()} />
  </div>;
}

/**
 * Identifiers as removable chips. Enter, a comma or leaving the field adds
 * the typed entry; Backspace in an empty field removes the last one.
 */
export function TokenListField({ value, onChange, placeholder, ...row }: RowProps & {
  readonly value: readonly string[];
  readonly onChange: (value: string[]) => void;
  readonly placeholder?: string;
}): React.JSX.Element {
  return <SettingsField layout="stacked" {...row}>
    <TokenInput value={value} onChange={onChange} placeholder={placeholder} disabled={row.disabled} />
  </SettingsField>;
}

export interface ChoiceOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Marks a choice that weakens safety, such as bypassing permissions. */
  readonly risky?: boolean;
}

/** A set of allowed values: a titled group of checkboxes in columns. */
export function CheckboxGroup<T extends string>({ label, description, error, value, options, onChange, disabled = false, columns = 1 }: {
  readonly label: string;
  readonly description?: ReactNode;
  readonly error?: string;
  readonly value: readonly T[];
  readonly options: ReadonlyArray<ChoiceOption<T>>;
  readonly onChange: (value: T[]) => void;
  readonly disabled?: boolean;
  readonly columns?: 1 | 2;
}): React.JSX.Element {
  const id = useId();
  return <div role="group" aria-labelledby={`${id}label`} data-invalid={Boolean(error) || undefined}
    aria-describedby={[error ? `${id}error` : "", description ? `${id}description` : ""].filter(Boolean).join(" ") || undefined}
    className="execution-checkbox-group">
    <p id={`${id}label`} className="execution-checkbox-group-title">{label}</p>
    {description ? <p id={`${id}description`} className="execution-field-description">{description}</p> : null}
    <div className="execution-checkbox-group-options" data-columns={columns}>
      {options.map((option) => <label key={option.value} className="execution-checkbox-option" data-disabled={disabled || undefined}>
        <Checkbox checked={value.includes(option.value)} disabled={disabled} aria-invalid={Boolean(error) || undefined} onCheckedChange={(checked) => {
          const selected = new Set(value);
          if (checked === true) selected.add(option.value); else selected.delete(option.value);
          onChange(options.filter(({ value: candidate }) => selected.has(candidate)).map(({ value: candidate }) => candidate));
        }} />
        <span>{option.label}</span>
        {option.risky ? <Badge tone="warning" size="xs">High risk</Badge> : null}
      </label>)}
    </div>
    {error ? <FieldError id={`${id}error`}>{error}</FieldError> : null}
  </div>;
}

/**
 * A collapsed group for rarely changed settings (executable paths, home
 * directories, timeouts). It starts open when it holds a value, and stays
 * open while it holds an error, so nothing configured or wrong is hidden.
 */
export function AdvancedGroup({ children, defaultOpen = false, forceOpen = false, label = "Advanced", summary }: {
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly forceOpen?: boolean;
  readonly label?: string;
  /** What the group holds, shown beside its trigger. */
  readonly summary?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return <Collapsible open={open || forceOpen} onOpenChange={setOpen} className="execution-advanced">
    <CollapsibleTrigger asChild>
      <button type="button" className="execution-advanced-trigger"><ChevronRight aria-hidden="true" />{label}
        {summary ? <span className="execution-advanced-summary">{summary}</span> : null}</button>
    </CollapsibleTrigger>
    <CollapsibleContent className="execution-advanced-content">{children}</CollapsibleContent>
  </Collapsible>;
}

/**
 * One item of a repeated group (a connection, a model rule): a summary row
 * that expands to its fields. It stays open while it holds an error.
 */
export function CollapsibleItem({ title, summary, tags, defaultOpen = false, forceOpen = false, actions, children }: {
  readonly title: string;
  readonly summary?: string;
  readonly tags?: ReactNode;
  readonly defaultOpen?: boolean;
  readonly forceOpen?: boolean;
  /** Item actions such as Remove, beside the summary row. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const expanded = open || forceOpen;
  return <Collapsible open={expanded} onOpenChange={setOpen} className="execution-item" data-state={expanded ? "open" : "closed"}>
    <div className="execution-item-header">
      <CollapsibleTrigger asChild>
        <button type="button" className="execution-item-trigger" aria-label={title}>
          <ChevronRight aria-hidden="true" />
          <span className="execution-item-text">
            <span className="execution-item-title">{title}{tags ? <span className="execution-item-tags">{tags}</span> : null}</span>
            {summary && !expanded ? <span className="execution-item-summary">{summary}</span> : null}
          </span>
        </button>
      </CollapsibleTrigger>
      {actions ? <div className="execution-item-actions">{actions}</div> : null}
    </div>
    <CollapsibleContent className="execution-item-content">{children}</CollapsibleContent>
  </Collapsible>;
}

export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}
