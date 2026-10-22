import { Check, PanelRightOpen, Pointer } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { PageRevision } from "../../../shared/protocol/pages.js";
import { useConnectionScope } from "../../app/connection-scope.js";
import { MediaFrame } from "../../workbench/components/MediaFrame.js";
import { Button } from "../ui/button.js";
import { PageFrame } from "./PageFrame.js";
import { pageFrameRecoveryKey } from "./page-frame-recovery.js";
import { usePageResponseSubmission } from "./page-response-submission.js";
import type { PageFrameServices } from "../../lib/page-services.js";
import "../../workbench/styles/media-frame.css";
import "./page-preview.css";

/** Each chat occurrence keeps its published revision and independent interaction state. */
export function PagePreview({ page, services, onOpenPage }: {
  readonly page: PageRevision;
  readonly services: PageFrameServices;
  readonly onOpenPage?: (page: PageRevision) => void;
}): React.JSX.Element {
  const [interacting, setInteracting] = useState(false);
  const deactivate = useCallback(() => setInteracting(false), []);
  const connection = useConnectionScope();
  const response = usePageResponseSubmission(pageFrameRecoveryKey(connection, page), page, services.pageResponse);
  useEffect(deactivate, [deactivate, page.pageId, page.revision]);

  return <MediaFrame className="page-preview" data-page-id={page.pageId} data-page-revision={page.revision}
    data-interacting={interacting ? "true" : undefined} role="group" aria-label={page.title}>
    <div className="page-preview-controls">
      <Button size="icon-xs" variant="outline"
        aria-label={interacting ? "Done interacting with preview" : "Interact with preview"}
        title={interacting ? "Done interacting with preview" : "Interact with preview"}
        aria-pressed={interacting} className="page-preview-interact"
        onClick={() => setInteracting(value => !value)}>
        {interacting ? <Check /> : <Pointer />}
      </Button>
      <Button size="icon-xs" variant="outline" aria-label={`Open in Pages: ${page.title}`} title="Open in Pages"
        disabled={!onOpenPage} onClick={() => { deactivate(); onOpenPage?.(page); }}>
        <PanelRightOpen />
      </Button>
    </div>
    <PageFrame key={`${page.pageId}:${page.revision}`} page={page} createAdmission={services.createPageRenderAdmission}
      responseServices={services.pageResponse} response={response} enabled interactive={interacting}
      onActivate={() => setInteracting(true)} onDeactivate={deactivate} refreshVersion={0} />
  </MediaFrame>;
}
