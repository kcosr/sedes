import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { ChevronRight, Folder, Globe, MessageSquare, X } from "lucide-react";
import type { TaskScope } from "../../../shared/index.js";
import { Button } from "@client/components/ui/button";
import { cn } from "@client/lib/utils";
import "./scope-view.css";

/**
 * Shared pieces of the scoped lists (Tasks, Workpads): the scope icon, the
 * quiet line that says where an item belongs, collapsible section headings,
 * and the chips of the View options in effect.
 */

/** The icon of a scope kind: threads, projects and Global read the same everywhere. */
export function ScopeIcon({
  kind,
  className,
}: {
  readonly kind: TaskScope["kind"];
  readonly className?: string;
}): React.JSX.Element {
  const Icon =
    kind === "global" ? Globe : kind === "thread" ? MessageSquare : Folder;
  return <Icon className={className} aria-hidden="true" />;
}

/** Where an item belongs: its scope's kind and a label naming it. */
export interface ScopeLocationLabel {
  readonly kind: TaskScope["kind"];
  readonly label: string;
}

/**
 * The quiet second line of a row in a list that mixes scopes (All, and
 * Project with its threads' items): the scope's icon and name. It is
 * presentation only; the row says the same in its description ("In …").
 */
export function ScopeLocation({
  location,
  className,
  children,
}: {
  readonly location: ScopeLocationLabel;
  readonly className?: string;
  /** Trailing content on the same line (Tasks' indicators under touch density). */
  readonly children?: ReactNode;
}): React.JSX.Element {
  return (
    <span className={cn("scope-location", className)} aria-hidden="true">
      <ScopeIcon kind={location.kind} />
      <span className="scope-location-label">{location.label}</span>
      {children}
    </span>
  );
}

export type ListHeadingProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "onClick" | "children"
> & {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly label: string;
  /** Omitted while it is not known. */
  readonly count?: number;
  readonly "data-tasks-nav"?: string;
};

/**
 * The collapsible heading of a section that ends a list (Backlog, Completed,
 * Archived).
 */
export function ListHeading({
  expanded,
  onToggle,
  label,
  count,
  className,
  ...button
}: ListHeadingProps): React.JSX.Element {
  return (
    <button
      {...button}
      type="button"
      className={cn("list-heading", className)}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <ChevronRight className="list-heading-chevron" aria-hidden="true" />
      <span className="list-heading-label">{label}</span>
      {count !== undefined && <span className="list-heading-count">{count}</span>}
    </button>
  );
}

/** A View option in effect, shown as a removable chip under the scope control. */
export interface ViewFilterChip {
  readonly key: string;
  readonly label: string;
}

/** The chips of the View options in effect; removing one calls back with its index. */
export function ViewFilterChips({
  chips,
  onRemove,
  disabled,
  ref,
}: {
  readonly chips: readonly ViewFilterChip[];
  readonly onRemove: (index: number) => void;
  readonly disabled?: boolean;
  readonly ref?: Ref<HTMLDivElement>;
}): React.JSX.Element | null {
  if (chips.length === 0) return null;
  return (
    <div ref={ref} className="view-filters" role="group" aria-label="View filters">
      {chips.map((chip, index) => (
        <Button
          key={chip.key}
          variant="outline"
          size="sm"
          className="view-filter-chip"
          data-filter={chip.key}
          disabled={disabled}
          aria-label={`Remove filter: ${chip.label}`}
          onClick={() => onRemove(index)}
        >
          <span className="view-filter-label">{chip.label}</span>
          <X data-icon="inline-end" aria-hidden="true" />
        </Button>
      ))}
    </div>
  );
}
