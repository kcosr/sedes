import { MessagesSquare } from "lucide-react";
import type { ThreadReference } from "../../../shared/thread-references.js";
import { ThreadReferenceLink } from "./InlineThreadReference.js";
import "./thread-references.css";

export function ThreadReferenceChips({ references }: {
  readonly references: readonly ThreadReference[];
}): React.JSX.Element | null {
  if (references.length === 0) return null;
  return (
    <div className="thread-reference-list" role="list" aria-label="Referenced threads">
      {references.map((reference) => (
        <div className="thread-reference-chip" role="listitem" key={reference.threadId}>
          <MessagesSquare size={13} aria-hidden="true" />
          <ThreadReferenceLink threadId={reference.threadId} title={reference.threadId}>{reference.title}</ThreadReferenceLink>
        </div>
      ))}
    </div>
  );
}
