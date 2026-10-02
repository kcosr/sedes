import type { LucideIcon } from "lucide-react";
import { Button } from "@client/components/ui/button";
import { CountBadge } from "@client/components/ui/count-badge";
import { cn } from "@client/lib/utils";

/**
 * A side panel's toggle in a thread's workbench bar (Tasks, Workpads). Its
 * host decides what opening means there: the docked panel, a phone's stage
 * panel, or a sheet. An optional neutral badge shows a count beside the
 * icon; the icon itself is never tinted.
 *
 * A docked panel can also be open but off stage: collapsed by hand, or to
 * make room for another panel. The toggle then shows the pressed chip's
 * outline without its fill, and pressing it shows the panel again.
 */
export function WorkbenchPanelToggle({
  title,
  icon: Icon,
  open,
  collapsed = false,
  onToggle,
  badge,
  controls,
  className,
  testId,
}: {
  /** The panel's title, as in "Open Tasks panel". */
  readonly title: string;
  readonly icon: LucideIcon;
  /** Whether the panel is shown: docked on stage, or its sheet open. */
  readonly open: boolean;
  /** Whether the docked panel is open but off stage. */
  readonly collapsed?: boolean;
  readonly onToggle: (invoker: HTMLButtonElement) => void;
  /** A count beside the icon and its spoken label, such as "3 open tasks". */
  readonly badge?: { readonly count: number; readonly label: string };
  /** The ID of the element the toggle shows, when it has a stable one. */
  readonly controls?: string;
  readonly className?: string;
  readonly testId?: string;
}): React.JSX.Element {
  const state = open ? "open" : collapsed ? "collapsed" : "closed";
  const action =
    state === "open"
      ? `Close ${title} panel`
      : state === "collapsed"
        ? `Show collapsed ${title} panel`
        : `Open ${title} panel`;
  const shownBadge = badge && badge.count > 0 ? badge : undefined;
  return (
    <Button
      variant={open ? "secondary" : "ghost"}
      size="icon"
      className={cn("workbench-panel-toggle", className)}
      aria-label={shownBadge ? `${action}, ${shownBadge.label}` : action}
      aria-expanded={open}
      aria-controls={controls}
      data-state={state}
      data-testid={testId}
      onClick={(event) => onToggle(event.currentTarget)}
    >
      <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
      {shownBadge && <CountBadge count={shownBadge.count} aria-hidden="true" />}
    </Button>
  );
}
