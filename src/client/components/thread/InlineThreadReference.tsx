import type { ComponentPropsWithoutRef } from "react";
import { Folder, MessagesSquare, Server } from "lucide-react";
import type { ThreadReference } from "../../../shared/thread-references.js";
import { threadPath } from "../../app/router.js";
import { openThreadRoute } from "../../workspace-panels/thread-panel-navigation.js";
import { BackendBrandIcon } from "../brand-icons.js";
import "./inline-thread-reference.css";

export function InlineThreadReference({ reference, editing = false }: {
  readonly reference: ThreadReference;
  readonly editing?: boolean;
}): React.JSX.Element {
  const { threadId, title, brand, project, environment } = reference;
  const description = [
    brand,
    project && `Project: ${project}`,
    environment && `Environment: ${environment}`,
  ].filter(Boolean).join(" · ");
  const attributes = {
    className: "inline-thread-reference",
    "data-thread-reference-id": threadId,
    title: [title, description].filter(Boolean).join(" · "),
    "aria-label": title,
    "aria-description": description || undefined,
  };
  const contents = <>
    {brand
      ? <BackendBrandIcon brand={brand} size={15} data-backend-brand={brand} aria-hidden="true" />
      : <MessagesSquare size={15} aria-hidden="true" />}
    <span className="inline-thread-reference-title">{title}</span>
    {project && <span className="inline-thread-reference-project" aria-hidden="true">
      <Folder size={12} /><span data-label={project} />
    </span>}
    {environment && <span className="inline-thread-reference-environment" aria-hidden="true">
      <Server size={12} /><span data-label={environment} />
    </span>}
  </>;
  if (editing) return <span {...attributes} contentEditable={false} role="img">{contents}</span>;
  return <ThreadReferenceLink threadId={threadId} {...attributes}>{contents}</ThreadReferenceLink>;
}

export function ThreadReferenceLink({ threadId, ...props }: {
  readonly threadId: string;
} & Omit<ComponentPropsWithoutRef<"a">, "onClick" | "href">): React.JSX.Element {
  return <a {...props} href={threadPath(threadId)} onClick={(event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openThreadRoute(threadId);
  }} />;
}
