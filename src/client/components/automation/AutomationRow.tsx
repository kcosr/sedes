import { memo, useId } from "react";
import {
  Check,
  CirclePause,
  CirclePlay,
  Ellipsis,
  MessageSquare,
  Pencil,
  Play,
} from "lucide-react";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuValue,
} from "@client/components/ui/dropdown-menu";
import {
  automationEditPath,
  automationPath,
  navigate,
} from "../../app/router.js";
import { useTouchDensity } from "../../app/use-touch-density.js";
import { automationActionAvailability } from "../../automation/automation-actions.js";
import {
  automationRowPresentation,
  type AutomationListEntry,
  type AutomationListRow,
  type AutomationRowText,
} from "../../automation/automation-list.js";
import { openThreadRoute } from "../../workspace-panels/thread-panel-navigation.js";
import { followLink } from "../settings/SettingsNav.js";
import { AutomationGlyph } from "./AutomationGlyph.js";

export type AutomationRowActionKind = "run" | "pause" | "enable";

/**
 * A row action's progress. Pending blocks another action on the row until
 * the server answers; an error stays on the row until the next attempt.
 */
export type AutomationRowStatus =
  | { readonly kind: "pending"; readonly action: AutomationRowActionKind }
  | {
      readonly kind: "error";
      readonly action: AutomationRowActionKind;
      readonly message: string;
    };

/**
 * What the page around a row already names, so the row leaves it out. `all`
 * names nothing. `project` names the project (grouped by project, or a
 * Scope on one), leaving only a location tag. `thread` is the thread's own
 * list: rows drop the thread, its project and backend, and ⋯'s Open thread.
 */
export type AutomationRowContext = "all" | "project" | "thread";

const FAILURE_TITLES: Readonly<Record<AutomationRowActionKind, string>> = {
  run: "Couldn’t run",
  pause: "Couldn’t pause",
  enable: "Couldn’t enable",
};

function RowText({
  value,
  className,
}: {
  readonly value: AutomationRowText | null;
  readonly className: string;
}): React.JSX.Element {
  return (
    <span className={className} data-tone={value?.tone} aria-hidden="true">
      {value?.check && <Check aria-hidden="true" />}
      {value?.running && <AutomationGlyph glyph="spinner" tone="info" />}
      {value?.text}
    </span>
  );
}

/** The row's line 2 parts, joined by dots; a sentence loses its full stop. */
function joinParts(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/\.$/u, ""))
    .join(" · ");
}

/**
 * The row's ⋯ menu: Run now, Pause or Enable, Edit…, then Open thread
 * outside the thread's own list.
 */
function AutomationRowMenu({
  entry,
  busy,
  openThread,
  onAction,
}: {
  readonly entry: AutomationListEntry;
  readonly busy: boolean;
  readonly openThread: boolean;
  readonly onAction: (
    row: AutomationListRow,
    action: AutomationRowActionKind,
  ) => void;
}): React.JSX.Element {
  // A sheet on touch, like the other row menus.
  const sheet = useTouchDensity();
  const { row, health } = entry;
  // The page offers the same actions with the same reasons; the row shows
  // a short hint and gives the instruction as the item's description.
  const { runNow, toggle, edit } = automationActionAvailability(row, health);
  return (
    <DropdownMenu presentation={sheet ? "sheet" : "menu"}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="automation-row-more"
          aria-label={`Actions for ${row.displayTitle}`}
          title="Automation actions"
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        aria-label={`Actions for ${row.displayTitle}`}
        sheetTitle={row.displayTitle}
        sheetDescription={health.label}
      >
        <DropdownMenuItem
          disabled={busy || !runNow.available}
          title={runNow.reason}
          onSelect={() => onAction(row, "run")}
        >
          <Play aria-hidden="true" />
          Run now
          {runNow.hint && (
            <DropdownMenuValue aria-hidden="true">{runNow.hint}</DropdownMenuValue>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={busy || !toggle.available}
          title={toggle.reason}
          onSelect={() => onAction(row, toggle.action)}
        >
          {toggle.action === "pause" ? (
            <CirclePause aria-hidden="true" />
          ) : (
            <CirclePlay aria-hidden="true" />
          )}
          {toggle.action === "pause" ? "Pause" : "Enable"}
          {toggle.hint && (
            <DropdownMenuValue aria-hidden="true">{toggle.hint}</DropdownMenuValue>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!edit.available}
          title={edit.reason}
          onSelect={() => navigate(automationEditPath(row.id))}
        >
          <Pencil aria-hidden="true" />
          Edit…
          {edit.hint && (
            <DropdownMenuValue aria-hidden="true">{edit.hint}</DropdownMenuValue>
          )}
        </DropdownMenuItem>
        {openThread && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openThreadRoute(row.threadId)}>
              <MessageSquare aria-hidden="true" />
              Open thread
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One automation on the Automations page: the whole row links to its
 * automation page; ⋯ holds the quick actions. Desktop rows read
 * `glyph title … next run` over `thread · schedule · project · backend …
 * last outcome`; narrow pages switch to `outcome · thread · schedule` with
 * only the next run trailing (a container query, so both variants render and
 * CSS picks one; assistive technology reads one description instead). The
 * `context` leaves out what the page already names.
 */
export const AutomationRow = memo(function AutomationRow({
  entry,
  now,
  context,
  status,
  onAction,
}: {
  readonly entry: AutomationListEntry;
  readonly now: number;
  readonly context: AutomationRowContext;
  readonly status?: AutomationRowStatus;
  readonly onAction: (
    row: AutomationListRow,
    action: AutomationRowActionKind,
  ) => void;
}): React.JSX.Element {
  const { row, health } = entry;
  const presentation = automationRowPresentation(entry, now);
  const { primary, secondary, detail, outcome, nextRun } = presentation;
  const busy = status?.kind === "pending";
  const path = automationPath(row.id);
  const id = useId();
  const titleId = `${id}-title`;
  const detailsId = `${id}-details`;
  const thread = context === "thread";
  const source = thread ? null : row.sourceTitle;
  const location = thread
    ? null
    : context === "project"
      ? row.locationTag
      : row.projectLabel;
  const backend = thread ? null : row.backendLabel;
  const wideMeta = joinParts([source, detail, location, backend]);
  const lead =
    health.kind === "active" && nextRun !== null
      ? `Next run ${nextRun}`
      : primary.text;
  const description = [lead, wideMeta, secondary?.text]
    .filter(Boolean)
    .join(". ");
  return (
    <li className="automations-list-item">
      <div
        className="automation-row"
        data-testid="automation-row"
        data-thread-id={row.threadId}
        data-automation-id={row.id}
        data-group={health.group}
        aria-busy={busy || undefined}
      >
        <a
          className="automation-row-open"
          href={path}
          title={row.displayTitle}
          aria-labelledby={titleId}
          aria-describedby={detailsId}
          onClick={(event) => followLink(event, path)}
        >
          <span className="automation-row-glyph">
            <AutomationGlyph glyph={health.glyph} tone={health.tone} size="list" />
          </span>
          <span className="automation-row-title" id={titleId}>
            {row.displayTitle}
          </span>
          <RowText value={primary} className="automation-row-primary" />
          <span className="automation-row-meta" data-layout="wide" aria-hidden="true">
            {wideMeta}
          </span>
          <span className="automation-row-meta" data-layout="narrow" aria-hidden="true">
            {outcome && (
              <span className="automation-row-outcome" data-tone={outcome.tone}>
                {outcome.text}
              </span>
            )}
            {outcome && " · "}
            {joinParts([source, detail])}
          </span>
          <RowText value={secondary} className="automation-row-secondary" />
          <span className="automation-row-next" aria-hidden="true">
            {nextRun}
          </span>
          <span className="sr-only" id={detailsId}>
            {description}
          </span>
        </a>
        <AutomationRowMenu
          entry={entry}
          busy={busy}
          openThread={!thread}
          onAction={onAction}
        />
      </div>
      {status?.kind === "error" && (
        <Callout
          tone="danger"
          role="alert"
          className="automation-row-error"
          title={`${FAILURE_TITLES[status.action]} ${row.displayTitle}`}
        >
          {status.message}
        </Callout>
      )}
    </li>
  );
});
