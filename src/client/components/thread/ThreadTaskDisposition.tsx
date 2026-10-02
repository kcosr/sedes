import type {
  OpenTaskDisposition,
  ThreadArchiveImpact,
} from "../../../shared/index.js";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@client/components/ui/segmented-control";
import "./archive-choices.css";

type TaskCollection = ThreadArchiveImpact["openTasks"]["root"];

/** The same bounded task preview and handling choices for every lifecycle action. */
export function ThreadTaskDisposition({
  groups,
  action,
  description,
  value,
  onChange,
  disabled = false,
  threadTitleFor,
}: {
  readonly groups: readonly {
    readonly label: string;
    readonly tasks: TaskCollection;
    readonly showOwningThread?: boolean;
  }[];
  readonly action: "archive" | "settle";
  readonly description?: React.ReactNode;
  readonly value: OpenTaskDisposition;
  readonly onChange: (value: OpenTaskDisposition) => void;
  readonly disabled?: boolean;
  readonly threadTitleFor?: (threadId: string) => string | undefined;
}): React.JSX.Element | null {
  const total = groups.reduce((sum, group) => sum + group.tasks.total, 0);
  const omitted = groups.reduce((sum, group) => sum + group.tasks.omitted, 0);
  if (total === 0) return null;
  return (
    <div
      className="archive-task-disposition"
      data-testid="archive-task-disposition"
    >
      <p className="archive-task-disposition-label">
        {description ?? `${total} open ${total === 1 ? "task" : "tasks"}`}
      </p>
      <div
        className="archive-task-summary-scroll"
        role="region"
        aria-label={`${total} open ${total === 1 ? "task" : "tasks"} affected by this ${action}`}
        tabIndex={0}
      >
        {groups
          .filter(({ tasks }) => tasks.items.length > 0)
          .map(({ label, tasks, showOwningThread }) => (
            <section
              key={label}
              className="archive-task-summary-group"
              aria-label={label}
            >
              <h4>{label}</h4>
              <ul>
                {tasks.items.map((task) => (
                  <li key={task.id} data-task-id={task.id}>
                    <span className="archive-task-summary-title">
                      {task.title}
                    </span>
                    {showOwningThread && (
                      <span
                        className="archive-task-summary-owner"
                        title={`Owned by thread ${task.threadId}`}
                      >
                        {threadTitleFor?.(task.threadId) ??
                          `Thread ${task.threadId}`}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        {omitted > 0 && (
          <p className="archive-task-summary-omitted" role="status">
            {omitted} more {omitted === 1 ? "task" : "tasks"} not shown
          </p>
        )}
      </div>
      <SegmentedControl
        aria-label="Open task handling"
        size="sm"
        className="w-full"
        value={value}
        onValueChange={(next) => onChange(next as OpenTaskDisposition)}
      >
        <SegmentedControlItem
          value="move_to_project"
          title="Move each task to its thread's project"
          disabled={disabled}
        >
          To project
        </SegmentedControlItem>
        <SegmentedControlItem
          value="move_to_global"
          title="Move open tasks to the global list"
          disabled={disabled}
        >
          To global
        </SegmentedControlItem>
        <SegmentedControlItem
          value="keep"
          title="Leave open tasks with their threads"
          disabled={disabled}
        >
          Keep
        </SegmentedControlItem>
        <SegmentedControlItem
          value="complete"
          title="Complete all affected open tasks and keep them attached to their threads"
          disabled={disabled}
        >
          Complete all
        </SegmentedControlItem>
      </SegmentedControl>
      {value === "complete" && (
        <p className="archive-task-completion-note" role="note">
          All open tasks on the threads you {action}
          {omitted > 0 ? ", including those not shown," : ""} will be marked
          completed and remain attached to their threads.
        </p>
      )}
    </div>
  );
}
