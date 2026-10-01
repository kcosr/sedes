import { ChevronRight, CircleCheck, ListTodo } from "lucide-react";
import { useState } from "react";
import { revealTask } from "../../../app/tasks-reveal.js";
import { Button } from "@client/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@client/components/ui/collapsible";

/**
 * A task carried by a user message: the title captured at send time, a
 * two-line notes preview, and "Open task", which reveals the live task in
 * Tasks. The identifiers are internals, so they sit behind "Details", which
 * also shows the full notes.
 */
export function MessageTaskCard({
  taskId,
  title,
  notes,
  completed = false,
  revision,
}: {
  readonly taskId: string;
  readonly title: string;
  readonly notes?: string;
  readonly completed?: boolean;
  readonly revision?: number;
}): React.JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <Collapsible
      className="message-task-card"
      data-task-id={taskId}
      data-completed={completed || undefined}
      open={detailsOpen}
      onOpenChange={setDetailsOpen}
    >
      <div className="message-task-card-head">
        {completed ? (
          <CircleCheck size={14} aria-hidden="true" />
        ) : (
          <ListTodo size={14} aria-hidden="true" />
        )}
        <strong>{title}</strong>
        {completed && <span>Completed</span>}
      </div>
      {notes && <p className="message-task-card-notes">{notes}</p>}
      <div className="message-task-card-actions">
        <Button
          variant="ghost"
          size="xs"
          aria-label={`Open task: ${title}`}
          onClick={() => revealTask(taskId)}
        >
          Open task
        </Button>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="message-task-card-details aria-expanded:bg-transparent"
          >
            Details
            <ChevronRight aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent asChild>
        <dl className="message-task-card-facts">
          <dt>Task ID</dt>
          <dd>{taskId}</dd>
          {revision !== undefined && (
            <>
              <dt>Revision</dt>
              <dd>{revision}</dd>
            </>
          )}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}
