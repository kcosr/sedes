import { useId, useState } from "react";
import type { BackendInteraction } from "../../../shared/index.js";
import { validateFormAnswers } from "../../../shared/protocol/interactions.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { Button } from "@client/components/ui/button";

type FormInteraction = Extract<BackendInteraction, { kind: "form" }>;
type FormField = FormInteraction["fields"][number];
type Response = Parameters<ThreadClientStore["respond"]>[1];
type FormAnswer = Extract<Response, { kind: "form" }>["answers"][number];
type Draft = string | string[];

function initialDraft(field: FormField): Draft {
  const value = field.input.default;
  return Array.isArray(value)
    ? [...value]
    : value === undefined
      ? ""
      : String(value);
}

function fieldHint(field: FormField): string | undefined {
  const input = field.input;
  const hints: string[] = [];
  if (input.kind === "text") {
    if (input.minLength !== undefined)
      hints.push(`At least ${input.minLength} characters.`);
    if (input.maxLength !== undefined)
      hints.push(`At most ${input.maxLength} characters.`);
    if (input.format) hints.push(`Format: ${input.format}.`);
  } else if (input.kind === "number") {
    if (input.integer) hints.push("Whole number.");
    if (input.minimum !== undefined) hints.push(`Minimum: ${input.minimum}.`);
    if (input.maximum !== undefined) hints.push(`Maximum: ${input.maximum}.`);
  } else if (input.kind === "multiple_choice") {
    if (input.minItems !== undefined)
      hints.push(`Select at least ${input.minItems}.`);
    if (input.maxItems !== undefined)
      hints.push(`Select at most ${input.maxItems}.`);
  }
  return hints.length > 0 ? hints.join(" ") : undefined;
}

export function InteractionForm({
  request,
  pending,
  onRespond,
}: {
  readonly request: FormInteraction;
  readonly pending: boolean;
  readonly onRespond: (response: Response) => Promise<void>;
}): React.JSX.Element {
  const id = useId();
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      request.fields.map((field) => [field.id, initialDraft(field)]),
    ),
  );
  const [included, setIncluded] = useState(
    () =>
      new Set(
        request.fields
          .filter(
            (field) => field.required || field.input.default !== undefined,
          )
          .map((field) => field.id),
      ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = (fieldId: string, value: Draft) => {
    setDrafts((current) => ({ ...current, [fieldId]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[fieldId];
      return next;
    });
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const answers: FormAnswer[] = [];
    const failures: Record<string, string> = {};
    for (const field of request.fields) {
      if (!included.has(field.id)) continue;
      const draft = drafts[field.id] ?? initialDraft(field);
      let value: FormAnswer["value"];
      if (field.input.kind === "multiple_choice") {
        value = Array.isArray(draft) ? draft : [];
      } else if (field.input.kind === "number") {
        if (
          typeof draft !== "string" ||
          draft.trim() === "" ||
          !Number.isFinite(Number(draft))
        ) {
          failures[field.id] = "Enter a number.";
          continue;
        }
        value = Number(draft);
      } else if (field.input.kind === "boolean") {
        if (draft !== "true" && draft !== "false") {
          failures[field.id] = "Choose Yes or No.";
          continue;
        }
        value = draft === "true";
      } else {
        value = typeof draft === "string" ? draft : "";
      }
      const answer = { fieldId: field.id, value };
      const error = validateFormAnswers([field], [answer]);
      if (error) failures[field.id] = error;
      answers.push(answer);
    }
    setErrors(failures);
    if (Object.keys(failures).length > 0) {
      const fieldIndex = request.fields.findIndex(
        (field) => failures[field.id],
      );
      document.getElementById(`${id}-field-${fieldIndex}`)?.focus();
      return;
    }
    void onRespond({ kind: "form", answers });
  };

  return (
    <form className="interaction-fields-form" onSubmit={submit} noValidate>
      <div className="interaction-fields-scroll">
        {request.fields.map((field, index) => {
          const input = field.input;
          const fieldId = `${id}-field-${index}`;
          const descriptionId = `${fieldId}-description`;
          const hintId = `${fieldId}-hint`;
          const hint = fieldHint(field);
          const errorId = `${fieldId}-error`;
          const enabled = included.has(field.id);
          const disabled = pending || !enabled;
          const draft = drafts[field.id] ?? initialDraft(field);
          const common = {
            id: fieldId,
            disabled,
            "aria-required": field.required,
            "aria-invalid": Boolean(errors[field.id]),
            "aria-describedby":
              [
                field.description ? descriptionId : "",
                hint ? hintId : "",
                errors[field.id] ? errorId : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined,
          };
          return (
            <div key={field.id} className="interaction-field">
              <div className="interaction-field-heading">
                {input.kind !== "multiple_choice" && (
                  <label htmlFor={fieldId}>{field.label.text}</label>
                )}
                {field.required ? (
                  <span className="interaction-field-required">Required</span>
                ) : (
                  <label className="interaction-field-inclusion">
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={pending}
                      aria-label={`Include optional field ${field.label.text}`}
                      onChange={(event) => {
                        setIncluded((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(field.id);
                          else next.delete(field.id);
                          return next;
                        });
                        setErrors((current) => {
                          const next = { ...current };
                          delete next[field.id];
                          return next;
                        });
                      }}
                    />
                    Include optional field
                  </label>
                )}
              </div>
              {field.description && (
                <p id={descriptionId}>{field.description.text}</p>
              )}
              {hint && <p id={hintId}>{hint}</p>}
              {input.kind === "text" ? (
                <input
                  {...common}
                  type="text"
                  value={typeof draft === "string" ? draft : ""}
                  inputMode={
                    input.format === "email"
                      ? "email"
                      : input.format === "uri"
                        ? "url"
                        : undefined
                  }
                  placeholder={
                    input.format === "date"
                      ? "YYYY-MM-DD"
                      : input.format === "date-time"
                        ? "YYYY-MM-DDTHH:mm:ssZ"
                        : undefined
                  }
                  onChange={(event) => update(field.id, event.target.value)}
                />
              ) : input.kind === "number" ? (
                <input
                  {...common}
                  type="number"
                  value={typeof draft === "string" ? draft : ""}
                  min={input.minimum}
                  max={input.maximum}
                  step={input.integer ? 1 : "any"}
                  onChange={(event) => update(field.id, event.target.value)}
                />
              ) : input.kind === "boolean" ? (
                <select
                  {...common}
                  value={typeof draft === "string" ? draft : ""}
                  onChange={(event) => update(field.id, event.target.value)}
                >
                  <option value="">Select…</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : input.kind === "single_choice" ? (
                <select
                  {...common}
                  value={typeof draft === "string" ? draft : ""}
                  onChange={(event) => update(field.id, event.target.value)}
                >
                  <option value="">Select…</option>
                  {input.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label.text}
                    </option>
                  ))}
                </select>
              ) : (
                <fieldset
                  id={common.id}
                  disabled={common.disabled}
                  aria-describedby={common["aria-describedby"]}
                  tabIndex={-1}
                  className="interaction-field-options"
                >
                  <legend>
                    {field.label.text}
                    {field.required && (
                      <>
                        {" "}
                        <span className="sr-only">(required)</span>
                      </>
                    )}
                  </legend>
                  {input.options.map((option) => (
                    <label key={option.id}>
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={
                          Array.isArray(draft) && draft.includes(option.id)
                        }
                        onChange={(event) => {
                          const current = Array.isArray(draft) ? draft : [];
                          update(
                            field.id,
                            event.target.checked
                              ? [...current, option.id]
                              : current.filter((value) => value !== option.id),
                          );
                        }}
                      />
                      {option.label.text}
                    </label>
                  ))}
                </fieldset>
              )}
              {errors[field.id] && (
                <p
                  id={errorId}
                  className="interaction-field-error"
                  role="alert"
                >
                  {errors[field.id]}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div className="interaction-prompt-actions">
        {request.cancellable && (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => void onRespond({ kind: "cancel" })}
          >
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          Continue
        </Button>
      </div>
    </form>
  );
}
