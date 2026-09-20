import { ListChecks } from "lucide-react";
import {
  setTasksPanelOpen,
  useTasksPanelPreferences,
} from "../../app/tasks-panel-store.js";
import { Button } from "@client/components/ui/button";

/** Toggles the Tasks popup from the application header and Home/Archived controls. */
export function TasksPanelToggle({
  openThreadTaskCount = 0,
}: {
  readonly openThreadTaskCount?: number;
}): React.JSX.Element {
  const preferences = useTasksPanelPreferences();
  const action = preferences.open ? "Close" : "Open";
  const taskCountLabel =
    openThreadTaskCount > 0
      ? `, ${openThreadTaskCount} open ${openThreadTaskCount === 1 ? "task" : "tasks"} for this thread`
      : "";
  return (
    <Button
      variant={preferences.open ? "secondary" : "ghost"}
      size="icon"
      className="tasks-panel-toggle"
      aria-label={`${action} Tasks panel${taskCountLabel}`}
      aria-expanded={preferences.open}
      aria-controls="tasks-panel"
      data-has-items={openThreadTaskCount > 0 || undefined}
      data-testid="tasks-panel-toggle"
      onClick={() => setTasksPanelOpen(!preferences.open)}
    >
      <ListChecks size={20} strokeWidth={1.8} aria-hidden="true" />
    </Button>
  );
}
