import { memo, useId } from "react";
import {
  ArchiveRestore,
  Box,
  Folder,
  GitBranch,
  LoaderCircle,
  Split,
} from "lucide-react";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import type { ArchivedThreadRow as ArchivedThreadRowModel } from "../archive/archived-threads.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import {
  openThreadRoute,
  pointerPanelPresentation,
} from "../workspace-panels/thread-panel-navigation.js";
import { BackendBrandIcon } from "./brand-icons.js";
import { ThreadContextMenu } from "./ThreadContextMenu.js";

export type ArchiveRestoreStatus =
  | { readonly kind: "pending" }
  /** Accepted; the row stays busy until the stream removes it. */
  | { readonly kind: "restored" }
  | { readonly kind: "error"; readonly message: string };

/** A muted marker that names what is unavailable for assistive technology. */
function UnavailableMarker({
  subject,
}: {
  readonly subject: string;
}): React.JSX.Element {
  return (
    <span className="archive-row-unavailable" title={`${subject} unavailable`}>
      <span className="sr-only">{subject} </span>
      Unavailable
    </span>
  );
}

/**
 * One archived thread: the whole row opens it, Restore is its own control,
 * and right-click or long-press opens the shared thread actions menu.
 *
 * Memoized with React's shallow comparison: `selectArchiveBase` keeps an
 * unchanged row's object, the parent passes stable callbacks, and the age is a
 * precomputed label, so an unrelated application event re-renders no row.
 */
export const ArchivedThreadRow = memo(function ArchivedThreadRow({
  row,
  store,
  showProject,
  showTarget,
  ageLabel,
  ageTitle,
  ageDateTime,
  restoreStatus,
  onRestore,
}: {
  readonly row: ArchivedThreadRowModel;
  readonly store: ApplicationClientStore;
  /** False when the grouping or the Scope already names the project. */
  readonly showProject: boolean;
  /** False when the Scope already names the target. */
  readonly showTarget: boolean;
  readonly ageLabel: string;
  readonly ageTitle: string;
  readonly ageDateTime: string;
  readonly restoreStatus?: ArchiveRestoreStatus;
  readonly onRestore: (row: ArchivedThreadRowModel) => void;
}): React.JSX.Element {
  const busy =
    restoreStatus?.kind === "pending" || restoreStatus?.kind === "restored";
  const environmentUnavailable = !row.environmentAvailable;
  const projectMarker = !row.projectAvailable
    ? environmentUnavailable
      ? "Project and environment"
      : "Project"
    : environmentUnavailable
      ? "Environment"
      : undefined;
  const targetText =
    row.targetLabel ?? (row.targetAvailable ? null : row.backendLabel);
  const projectPart = showProject || projectMarker !== undefined;
  const targetPart =
    targetText !== null && (showTarget || !row.targetAvailable);
  const worktreePart = row.worktreeLabel !== null;
  const forkLabel = row.origin
    ? row.forkSourceTitle
      ? `Fork of ${row.forkSourceTitle}`
      : "Forked thread"
    : undefined;
  const id = useId();
  const titleId = `${id}-title`;
  const metaId = `${id}-meta`;
  const detailsId = `${id}-details`;
  const hasMeta = projectPart || targetPart || worktreePart;
  return (
    <li className="archive-list-item">
      <ThreadContextMenu
        thread={row.thread}
        store={store}
        origin={row.origin}
        placement={row.placement}
        sourceTitle={row.forkSourceTitle}
        configurationCopyPending={row.configurationCopyPending}
      >
        <div
          className="archive-row"
          data-testid="archive-row"
          data-thread-id={row.id}
          aria-busy={busy || undefined}
        >
          <button
            type="button"
            className="archive-row-open"
            title={row.title}
            // Named by the title alone; location, lineage, and times describe it.
            aria-labelledby={titleId}
            aria-describedby={hasMeta ? `${metaId} ${detailsId}` : detailsId}
            onClick={(event) =>
              openThreadRoute(row.id, pointerPanelPresentation(event))
            }
          >
            <span
              className="archive-row-brand"
              role="img"
              aria-label={row.backendLabel}
              title={row.backendLabel}
            >
              <BackendBrandIcon brand={row.brand} size={14} />
            </span>
            <span className="archive-row-title" id={titleId}>
              {row.title}
            </span>
            <span className="archive-row-trail">
              {forkLabel && (
                <span
                  className="archive-row-fork"
                  data-testid="archive-row-fork"
                  role="img"
                  aria-label={forkLabel}
                  title={forkLabel}
                >
                  <Split size={14} strokeWidth={1.8} aria-hidden="true" />
                </span>
              )}
              <time
                className="archive-row-age"
                dateTime={ageDateTime}
                title={ageTitle}
              >
                {ageLabel}
              </time>
            </span>
            <span className="sr-only" id={detailsId}>
              {[row.backendLabel, forkLabel, ageTitle]
                .filter(Boolean)
                .join(". ")}
            </span>
            {hasMeta && (
              <span className="archive-row-meta" id={metaId}>
                {projectPart && (
                  <span className="archive-row-part" data-part="project">
                    {/* The folder stays with a lone marker so it reads as the project's. */}
                    <Folder size={13} strokeWidth={1.8} aria-hidden="true" />
                    {showProject && (
                      <span className="archive-row-part-text">
                        {row.projectLabel}
                      </span>
                    )}
                    {projectMarker && (
                      <UnavailableMarker subject={projectMarker} />
                    )}
                  </span>
                )}
                {targetPart && (
                  <span className="archive-row-part" data-part="target">
                    <Box size={12} strokeWidth={1.8} aria-hidden="true" />
                    <span className="archive-row-part-text">{targetText}</span>
                    {!row.targetAvailable && (
                      <UnavailableMarker subject="Target" />
                    )}
                  </span>
                )}
                {worktreePart && (
                  <span className="archive-row-part" data-part="worktree">
                    <GitBranch size={12} strokeWidth={1.8} aria-hidden="true" />
                    <span className="archive-row-part-text">
                      {row.worktreeLabel}
                    </span>
                    {!row.worktreeAvailable && (
                      <UnavailableMarker subject="Worktree" />
                    )}
                  </span>
                )}
              </span>
            )}
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="archive-row-restore"
            aria-label={`Restore ${row.title}`}
            title="Restore to Active"
            // aria-disabled keeps focus on the control while it is busy, so
            // the page can move focus on once the row leaves the list.
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onRestore(row);
            }}
          >
            {busy ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <ArchiveRestore aria-hidden="true" />
            )}
          </Button>
        </div>
      </ThreadContextMenu>
      {restoreStatus?.kind === "error" && (
        <Callout
          tone="danger"
          role="alert"
          className="archive-row-error"
          title={`Couldn’t restore ${row.title}`}
        >
          {restoreStatus.message}
        </Callout>
      )}
    </li>
  );
});
