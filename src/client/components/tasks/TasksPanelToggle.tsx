import { ListChecks } from "lucide-react";
import { Button } from "@client/components/ui/button";

/**
 * The Tasks toggle in the workbench bar and in the pane corner of pages
 * without panels. Its host decides what opening means there: the docked
 * panel, the popover or the phone sheet.
 */
export function TasksPanelToggle({
  open,
  onToggle,
  count = 0,
}: {
  /** Whether Tasks is shown in this page's presentation. */
  readonly open: boolean;
  readonly onToggle: (invoker: HTMLButtonElement) => void;
  /** Open tasks in the current context. */
  readonly count?: number;
}): React.JSX.Element {
  const action = open ? "Close" : "Open";
  const taskCountLabel =
    count > 0 ? `, ${count} open ${count === 1 ? "task" : "tasks"}` : "";
  return (
    <Button
      variant={open ? "secondary" : "ghost"}
      size="icon"
      className="tasks-panel-toggle"
      aria-label={`${action} Tasks panel${taskCountLabel}`}
      aria-expanded={open}
      aria-controls="tasks-panel"
      data-has-items={count > 0 || undefined}
      data-testid="tasks-panel-toggle"
      onClick={(event) => onToggle(event.currentTarget)}
    >
      <ListChecks size={20} strokeWidth={1.8} aria-hidden="true" />
    </Button>
  );
}
