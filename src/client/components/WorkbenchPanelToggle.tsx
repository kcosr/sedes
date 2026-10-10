import { Button } from "@client/components/ui/button";
import { CountBadge } from "@client/components/ui/count-badge";
import { cn } from "@client/lib/utils";

/**
 * A loaded panel's quick button in a thread's workbench bar. Filled while
 * the panel is visible; only outlined while it is loaded but hidden (hidden
 * by hand, replaced in its region, hidden to make room, or behind a
 * maximized panel). Pressing it hides a visible panel, which stays loaded,
 * or shows a hidden one in its region. An optional neutral badge shows a
 * count beside the icon; the icon itself is never tinted.
 */
export function WorkbenchPanelToggle({
  title,
  icon,
  visible,
  onToggle,
  badge,
  controls,
  className,
  testId,
}: {
  /** The panel's title, as in "Hide Tasks panel". */
  readonly title: string;
  readonly icon: React.ReactNode;
  /** Whether the panel is visible: on stage, or its sheet open. */
  readonly visible: boolean;
  readonly onToggle: (invoker: HTMLButtonElement) => void;
  /** A count beside the icon and its spoken label, such as "3 open tasks". */
  readonly badge?: { readonly count: number; readonly label: string };
  /** The ID of the element the toggle shows, when it has a stable one. */
  readonly controls?: string;
  readonly className?: string;
  readonly testId?: string;
}): React.JSX.Element {
  const action = visible ? `Hide ${title} panel` : `Show ${title} panel`;
  const shownBadge = badge && badge.count > 0 ? badge : undefined;
  return (
    <Button
      variant={visible ? "secondary" : "ghost"}
      size="icon"
      className={cn("workbench-panel-toggle", className)}
      aria-label={shownBadge ? `${action}, ${shownBadge.label}` : action}
      aria-expanded={visible}
      aria-controls={controls}
      data-state={visible ? "visible" : "hidden"}
      data-testid={testId}
      onClick={(event) => onToggle(event.currentTarget)}
    >
      {icon}
      {shownBadge && <CountBadge count={shownBadge.count} aria-hidden="true" />}
    </Button>
  );
}
