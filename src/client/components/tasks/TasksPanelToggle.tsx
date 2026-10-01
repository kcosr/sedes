import { ListChecks } from "lucide-react";
import { Button } from "@client/components/ui/button";
import { CountBadge } from "@client/components/ui/count-badge";

/**
 * The Tasks toggle in the workbench bar and in the pane corner of pages
 * without panels. Its host decides what opening means there: the docked
 * panel, the popover or the phone sheet. `count` is the open-task count of
 * the current context; a neutral badge shows it beside the icon. The icon
 * itself is never tinted.
 *
 * Docked Tasks can also be open but off stage: collapsed by hand, or to
 * make room for another panel. The toggle then shows the pressed chip's
 * outline without its fill, and pressing it shows Tasks again.
 */
export function TasksPanelToggle({
  open,
  collapsed = false,
  onToggle,
  count = 0,
}: {
  /** Whether Tasks is shown in this page's presentation. */
  readonly open: boolean;
  /** Whether docked Tasks is open but off stage. */
  readonly collapsed?: boolean;
  readonly onToggle: (invoker: HTMLButtonElement) => void;
  /** Open tasks in the current context. */
  readonly count?: number;
}): React.JSX.Element {
  const state = open ? "open" : collapsed ? "collapsed" : "closed";
  const action =
    state === "open"
      ? "Close Tasks panel"
      : state === "collapsed"
        ? "Show collapsed Tasks panel"
        : "Open Tasks panel";
  const countLabel =
    count > 0 ? `, ${count} open ${count === 1 ? "task" : "tasks"}` : "";
  return (
    <Button
      variant={open ? "secondary" : "ghost"}
      size="icon"
      className="tasks-panel-toggle"
      aria-label={`${action}${countLabel}`}
      aria-expanded={open}
      aria-controls="tasks-panel"
      data-state={state}
      data-testid="tasks-panel-toggle"
      onClick={(event) => onToggle(event.currentTarget)}
    >
      <ListChecks size={20} strokeWidth={1.8} aria-hidden="true" />
      {count > 0 && <CountBadge count={count} aria-hidden="true" />}
    </Button>
  );
}
