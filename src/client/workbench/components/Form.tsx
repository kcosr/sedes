import { createContext, useContext, useEffect, useId, useRef } from "react";
import type {
  InputHTMLAttributes,
  ReactNode,
  Ref,
  RefObject,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Provide id/description/invalid wiring to the control inside (used by Field and SettingsRow). */
export function FieldProvider({
  value,
  children,
}: {
  value: FieldContextValue;
  children?: ReactNode;
}) {
  return (
    <FieldContext.Provider value={value}>{children}</FieldContext.Provider>
  );
}

export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext);
}

function joinIds(
  ...ids: (string | undefined | null | false)[]
): string | undefined {
  const out = ids.filter(Boolean).join(" ");
  return out || undefined;
}

/**
 * Merge Field wiring into a control's props: id, aria-describedby and
 * aria-invalid come from the surrounding Field unless set explicitly.
 */
export function useFieldControl(props: {
  id?: string | undefined;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?:
    | boolean
    | "true"
    | "false"
    | "grammar"
    | "spelling"
    | undefined;
}): {
  id: string | undefined;
  "aria-describedby": string | undefined;
  "aria-invalid":
    | boolean
    | "true"
    | "false"
    | "grammar"
    | "spelling"
    | undefined;
} {
  const field = useFieldContext();
  return {
    id: props.id ?? field?.id,
    "aria-describedby": joinIds(field?.describedBy, props["aria-describedby"]),
    "aria-invalid":
      props["aria-invalid"] ?? (field?.invalid ? true : undefined),
  };
}

export interface FieldProps {
  label: ReactNode;
  /** Help text under the control (aria-describedby). */
  hint?: ReactNode;
  /** Error text; marks the control aria-invalid. */
  error?: ReactNode;
  /** Adds "(optional)" after the label. */
  optional?: boolean | undefined;
  /** Control id (default generated). */
  id?: string | undefined;
  children: ReactNode;
  className?: string | undefined;
}

/** Label + control + hint + error, with the ids wired for the control inside. */
export function Field({
  label,
  hint,
  error,
  optional,
  id,
  children,
  className,
}: FieldProps) {
  const auto = useId();
  const controlId = id ?? `wb-field-${auto}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  return (
    <div className={cx("wb-field", className)}>
      <label className="wb-field-label" htmlFor={controlId}>
        {label}
        {optional ? (
          <>
            {" "}
            <span className="wb-field-optional">(optional)</span>
          </>
        ) : null}
      </label>
      <FieldProvider
        value={{
          id: controlId,
          describedBy: joinIds(errorId, hintId),
          invalid: !!error,
        }}
      >
        {children}
      </FieldProvider>
      {hint ? (
        <div className="wb-field-hint" id={hintId}>
          {hint}
        </div>
      ) : null}
      {error ? (
        <div className="wb-field-error" id={errorId}>
          <Icon name="alert-circle" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  size?: undefined;
  /** sm = 30px (toolbars), default 32px. */
  inputSize?: "default" | "sm" | undefined;
  mono?: boolean | undefined;
  /** 96px, tabular numbers. */
  numeric?: boolean | undefined;
  ref?: Ref<HTMLInputElement> | undefined;
}

export function Input({
  inputSize = "default",
  mono,
  numeric,
  className,
  ...rest
}: InputProps) {
  const wiring = useFieldControl(rest);
  return (
    <input
      {...rest}
      {...wiring}
      className={cx(
        "wb-input",
        inputSize === "sm" && "wb-input--sm",
        mono && "wb-input--mono",
        numeric && "wb-input--num",
        className,
      )}
    />
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean | undefined;
  ref?: Ref<HTMLTextAreaElement> | undefined;
}

export function Textarea({ mono, className, ...rest }: TextareaProps) {
  const wiring = useFieldControl(rest);
  return (
    <textarea
      {...rest}
      {...wiring}
      className={cx(
        "wb-input",
        "wb-textarea",
        mono && "wb-input--mono",
        className,
      )}
    />
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean | undefined;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Options (or pass <option> children). */
  options?: readonly SelectOption[] | undefined;
  /** Full width. */
  block?: boolean | undefined;
  inputSize?: "default" | "sm" | undefined;
  ref?: Ref<HTMLSelectElement> | undefined;
}

/** Native select with the kit's field styling and chevron. */
export function Select({
  options,
  block,
  inputSize = "default",
  className,
  children,
  ...rest
}: SelectProps) {
  const wiring = useFieldControl(rest);
  return (
    <span className={cx("wb-select", block && "wb-select--block", className)}>
      <select
        {...rest}
        {...wiring}
        className={cx("wb-input", inputSize === "sm" && "wb-input--sm")}
      >
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          : children}
      </select>
      <Icon name="chevron-down" />
    </span>
  );
}

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type"
> {
  /** Visible label; omit when a Field/SettingsRow labels it. */
  label?: ReactNode;
  description?: ReactNode;
  indeterminate?: boolean | undefined;
  ref?: Ref<HTMLInputElement> | undefined;
}

function useIndeterminate(
  indeterminate: boolean | undefined,
  outer: Ref<HTMLInputElement> | undefined,
): (el: HTMLInputElement | null) => void {
  const local: RefObject<HTMLInputElement | null> = useRef(null);
  useEffect(() => {
    if (local.current) local.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (el) => {
    local.current = el;
    if (typeof outer === "function") outer(el);
    else if (outer) outer.current = el;
  };
}

export function Checkbox({
  label,
  description,
  indeterminate,
  className,
  ref,
  ...rest
}: CheckboxProps) {
  const auto = useId();
  const wiring = useFieldControl(rest);
  const setRef = useIndeterminate(indeterminate, ref);
  const id = wiring.id ?? `wb-check-${auto}`;
  // The description is a description, not part of the name: it sits
  // outside the <label> and is wired with aria-describedby.
  const descId = description ? `${id}-desc` : undefined;
  const wrapped = !!label || !!description;
  const input = (
    <input
      {...rest}
      {...wiring}
      id={id}
      aria-describedby={joinIds(wiring["aria-describedby"], descId)}
      ref={setRef}
      type="checkbox"
      className={cx("wb-checkbox", !wrapped && className)}
    />
  );
  if (!wrapped) return input;
  return (
    <span className={cx("wb-check", className)}>
      {input}
      <span className="wb-check-text">
        {label ? <label htmlFor={id}>{label}</label> : null}
        {description ? (
          <span className="wb-check-desc" id={descId}>
            {description}
          </span>
        ) : null}
      </span>
    </span>
  );
}

export interface SwitchProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "role" | "size"
> {
  /** Visible label; omit when a Field/SettingsRow labels it. */
  label?: ReactNode;
  /** sm: a smaller switch for dense rows, toolbars and table cells. */
  size?: "default" | "sm" | undefined;
  ref?: Ref<HTMLInputElement> | undefined;
}

/** On/off switch: a native checkbox with role="switch". */
export function Switch({
  label,
  size = "default",
  className,
  ...rest
}: SwitchProps) {
  const wiring = useFieldControl(rest);
  const input = (
    <input
      {...rest}
      {...wiring}
      type="checkbox"
      role="switch"
      className={cx(
        "wb-switch",
        size === "sm" && "wb-switch--sm",
        !label && className,
      )}
    />
  );
  if (!label) return input;
  return (
    <label className={cx("wb-switch-label", className)}>
      {input}
      <span>{label}</span>
    </label>
  );
}
