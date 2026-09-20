import { useEffect, useId, useState } from "react";
import { Input } from "../ui/input.js";
import { Label } from "../ui/label.js";
import { Textarea } from "../ui/textarea.js";

export function TextField({ label, value, onChange, description, required = false, disabled = false, autoFocus = false, type = "text" }: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly description?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  readonly type?: "text" | "number" | "url";
}): React.JSX.Element {
  const id = useId();
  return <div className="execution-settings-field">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} type={type} value={value} required={required} disabled={disabled} autoFocus={autoFocus}
      autoComplete="off" aria-describedby={description ? `${id}-help` : undefined}
      onChange={(event) => onChange(event.currentTarget.value)} />
    {description ? <p id={`${id}-help`}>{description}</p> : null}
  </div>;
}

export function SelectField<T extends string>({ label, value, onChange, options, description, disabled = false, autoFocus = false }: {
  readonly label: string;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string; readonly disabled?: boolean }>;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
}): React.JSX.Element {
  const id = useId();
  return <div className="execution-settings-field">
    <Label htmlFor={id}>{label}</Label>
    <select id={id} className="settings-native-select" value={value} disabled={disabled} autoFocus={autoFocus}
      aria-describedby={description ? `${id}-help` : undefined}
      onChange={(event) => {
        const option = options.find(({ value: candidate }) => candidate === event.currentTarget.value);
        if (option && !option.disabled) onChange(option.value);
      }}>
      {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>
    {description ? <p id={`${id}-help`}>{description}</p> : null}
  </div>;
}

export function LinesField({ label, value, onChange, description, disabled = false }: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly description?: string;
  readonly disabled?: boolean;
}): React.JSX.Element {
  const id = useId();
  return <div className="execution-settings-field">
    <Label htmlFor={id}>{label}</Label>
    <Textarea id={id} value={value} rows={3} disabled={disabled} spellCheck={false}
      aria-describedby={description ? `${id}-help` : undefined}
      onChange={(event) => onChange(event.currentTarget.value)} />
    {description ? <p id={`${id}-help`}>{description}</p> : null}
  </div>;
}

export function parseLines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export function TextListField({ value, onChange, ...props }: Omit<Parameters<typeof LinesField>[0], "value" | "onChange"> & {
  readonly value: readonly string[];
  readonly onChange: (value: string[]) => void;
}): React.JSX.Element {
  const [text, setText] = useState(() => value.join("\n"));
  const key = JSON.stringify(value);
  useEffect(() => {
    setText((current) => JSON.stringify(parseLines(current)) === key ? current : (JSON.parse(key) as string[]).join("\n"));
  }, [key]);
  return <LinesField {...props} value={text} onChange={(next) => {
    setText(next);
    onChange(parseLines(next));
  }} />;
}

export function Toggle({ label, checked, onChange, disabled = false, autoFocus = false }: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
}): React.JSX.Element {
  return <label className="execution-settings-check"><input type="checkbox" checked={checked}
    disabled={disabled} autoFocus={autoFocus} onChange={(event) => onChange(event.currentTarget.checked)} />{label}</label>;
}

export function ChoiceList<T extends string>({ label, value, options, onChange }: {
  readonly label: string;
  readonly value: readonly T[];
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T[]) => void;
}): React.JSX.Element {
  return <fieldset><legend>{label}</legend>{options.map((option) => <Toggle key={option.value}
    label={option.label} checked={value.includes(option.value)} onChange={(checked) => {
      const selected = new Set(value);
      if (checked) selected.add(option.value); else selected.delete(option.value);
      onChange(options.filter(({ value: candidate }) => selected.has(candidate)).map(({ value: candidate }) => candidate));
    }} />)}</fieldset>;
}

export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}
