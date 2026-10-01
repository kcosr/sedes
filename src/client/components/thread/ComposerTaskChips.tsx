import { AlertTriangle, CircleCheck, ListTodo, LoaderCircle, X } from "lucide-react";

/**
 * A task reference's live state: "checking" until the task projection is
 * authoritative, then available, completed, or missing (deleted).
 */
export type ComposerTaskChipState =
  | "available"
  | "checking"
  | "completed"
  | "missing";

export interface ComposerTaskChipModel {
  readonly taskId: string;
  readonly label: string;
  readonly state: ComposerTaskChipState;
}

const stateLabels: Readonly<
  Record<Exclude<ComposerTaskChipState, "available">, string>
> = {
  checking: "Checking",
  completed: "Completed",
  missing: "Missing task",
};

const stateTooltips: Readonly<
  Record<Exclude<ComposerTaskChipState, "available">, string>
> = {
  checking: "Checking this task…",
  completed: "This task is completed. It is still sent with the prompt.",
  missing: "This task no longer exists. Remove it before sending.",
};

/**
 * The composer's attached tasks as compact pills (icon, truncated title, ×)
 * that wrap above the message box. Only exceptional states show: a muted
 * pill for a completed task and a warning pill for a missing one, each
 * explained by its tooltip and, for assistive technology, by its text.
 */
export function ComposerTaskChips({
  chips,
  onRemove,
}: {
  readonly chips: readonly ComposerTaskChipModel[];
  readonly onRemove: (taskId: string) => void;
}): React.JSX.Element | null {
  if (chips.length === 0) return null;
  return (
    <div className="composer-task-list" role="list" aria-label="Attached tasks">
      {chips.map(({ taskId, label, state }) => (
        <div
          className="composer-task-chip"
          role="listitem"
          data-state={state}
          data-task-id={taskId}
          key={taskId}
          title={
            state === "available" ? label : `${label}\n${stateTooltips[state]}`
          }
        >
          {state === "completed" ? (
            <CircleCheck size={13} strokeWidth={1.9} aria-hidden="true" />
          ) : state === "missing" ? (
            <AlertTriangle size={13} strokeWidth={1.9} aria-hidden="true" />
          ) : state === "checking" ? (
            <LoaderCircle size={13} strokeWidth={1.9} aria-hidden="true" />
          ) : (
            <ListTodo size={13} strokeWidth={1.9} aria-hidden="true" />
          )}
          <span className="composer-task-title">{label}</span>
          {state !== "available" && (
            <span className="sr-only">{stateLabels[state]}</span>
          )}
          <button
            type="button"
            aria-label={`Remove task: ${label}`}
            onClick={() => onRemove(taskId)}
          >
            <X size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
