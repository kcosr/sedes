import { MessagesSquare, X } from "lucide-react";
import type { ThreadReference } from "../../../shared/thread-references.js";
import { threadPath } from "../../app/router.js";
import { openThreadRoute } from "../../workspace-panels/thread-panel-navigation.js";
import "./thread-references.css";

export function ThreadReferenceChips({ references, onRemove }: {
  readonly references: readonly ThreadReference[];
  readonly onRemove?: (threadId: string) => void;
}): React.JSX.Element | null {
  if (references.length === 0) return null;
  return (
    <div className="thread-reference-list" role="list" aria-label="Referenced threads">
      {references.map((reference) => (
        <div className="thread-reference-chip" role="listitem" key={reference.threadId}>
          <MessagesSquare size={13} aria-hidden="true" />
          {onRemove ? <span title={reference.threadId}>{reference.title}</span> : (
            <a href={threadPath(reference.threadId)} title={reference.threadId} onClick={(event) => {
              if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              openThreadRoute(reference.threadId);
            }}>{reference.title}</a>
          )}
          {onRemove && <button type="button" aria-label={`Remove thread: ${reference.title}`}
            onClick={() => onRemove(reference.threadId)}><X size={12} aria-hidden="true" /></button>}
        </div>
      ))}
    </div>
  );
}
