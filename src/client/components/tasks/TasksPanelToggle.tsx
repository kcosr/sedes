import { ListChecks } from "lucide-react";
import {
  setTasksPanelOpen,
  useTasksPanelPreferences,
} from "../../app/tasks-panel-store.js";
import { Button } from "@client/components/ui/button";
import { CountBadge } from "@client/components/ui/count-badge";

/**
 * Toggles Tasks from the workbench bar and the Home/Archived/Usage corner.
 * `count` is the open-task count of the current context; a neutral badge
 * shows it beside the icon. The icon itself is never tinted.
 */
export function TasksPanelToggle({
  count = 0,
}: {
  readonly count?: number;
}): React.JSX.Element {
  const preferences = useTasksPanelPreferences();
  const action = preferences.open ? "Close" : "Open";
  const countLabel =
    count > 0 ? `, ${count} open ${count === 1 ? "task" : "tasks"}` : "";
  return (
    <Button
      variant={preferences.open ? "secondary" : "ghost"}
      size="icon"
      className="tasks-panel-toggle"
      aria-label={`${action} Tasks panel${countLabel}`}
      aria-expanded={preferences.open}
      aria-controls="tasks-panel"
      data-testid="tasks-panel-toggle"
      onClick={() => setTasksPanelOpen(!preferences.open)}
    >
      <ListChecks size={20} strokeWidth={1.8} aria-hidden="true" />
      {count > 0 && <CountBadge count={count} aria-hidden="true" />}
    </Button>
  );
}
