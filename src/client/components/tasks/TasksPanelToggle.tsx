import { ListChecks } from "lucide-react";
import { WorkbenchPanelToggle } from "@client/components/WorkbenchPanelToggle";

/**
 * The Tasks toggle in a thread's workbench bar. Its host decides what
 * opening means there: the docked panel, or the sheet on phones. `count` is
 * the current thread's open-task count, shown as a neutral badge.
 */
export function TasksPanelToggle({
  open,
  collapsed = false,
  onToggle,
  count = 0,
}: {
  /** Whether Tasks is shown: docked on stage, or the sheet open. */
  readonly open: boolean;
  /** Whether docked Tasks is open but off stage. */
  readonly collapsed?: boolean;
  readonly onToggle: (invoker: HTMLButtonElement) => void;
  /** Open tasks in the current thread. */
  readonly count?: number;
}): React.JSX.Element {
  return (
    <WorkbenchPanelToggle
      title="Tasks"
      icon={ListChecks}
      open={open}
      collapsed={collapsed}
      onToggle={onToggle}
      badge={{
        count,
        label: `${count} open ${count === 1 ? "task" : "tasks"}`,
      }}
      controls="tasks-panel"
      className="tasks-panel-toggle"
      testId="tasks-panel-toggle"
    />
  );
}
