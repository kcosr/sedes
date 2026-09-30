import type {
  OpenTaskDisposition,
  ThreadArchiveImpact,
} from "../../../shared/index.js";
import { SegmentedControl } from "../tasks/SegmentedControl.js";

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
      <span className="archive-task-disposition-label">
        {description ?? `${total} open ${total === 1 ? "task" : "tasks"}`}
      </span>
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
        ariaLabel="Open task handling"
        size="small"
        value={value}
        onChange={(next) => onChange(next as OpenTaskDisposition)}
        options={[
          {
            value: "move_to_workspace",
            label: "To project",
            title: "Move each task to its thread's project",
            disabled,
          },
          {
            value: "move_to_global",
            label: "To global",
            title: "Move open tasks to the global list",
            disabled,
          },
          {
            value: "keep",
            label: "Keep",
            title: "Leave open tasks with their threads",
            disabled,
          },
          {
            value: "complete",
            label: "Complete all",
            title:
              "Complete all affected open tasks and keep them attached to their threads",
            disabled,
          },
        ]}
      />
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
