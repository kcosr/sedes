import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { Tooltip } from "radix-ui";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@client/components/ui/segmented-control";
import { cn } from "@client/lib/utils";
import { SCOPE_VIEWS, SCOPE_VIEW_LABEL, type ScopeView } from "./scope-views.js";
import "./scope-view.css";

type SegmentProps = Omit<
  ComponentProps<typeof SegmentedControlItem>,
  "value" | "disabled" | "children"
> & { readonly "data-autofocus"?: string };

export interface ScopeSegmentsProps {
  readonly "aria-label": string;
  readonly value: ScopeView;
  readonly onValueChange: (view: ScopeView) => void;
  /** Why a view does not apply here; its segment is disabled and says why. */
  readonly unavailableReason: (view: ScopeView) => string | undefined;
  /** A view's count, or undefined while it is not known. */
  readonly count: (view: ScopeView) => number | undefined;
  /** How a count reads to assistive technology, such as "3 open". */
  readonly describeCount: (count: number) => string;
  /** The whole control, while the panel cannot change what it shows. */
  readonly disabled?: boolean;
  /** Extra props of one segment: drop targets, autofocus. */
  readonly segmentProps?: (view: ScopeView) => SegmentProps;
  /** Choosing the selected segment again, which otherwise does nothing. */
  readonly onReselect?: (view: ScopeView) => void;
  readonly className?: string;
}

/**
 * Thread · Project · Global · All, each with its count: the scope control of
 * Tasks and Workpads. A view that does not apply is disabled, and its reason
 * shows on hover or tap and in the control's description.
 */
export function ScopeSegments({
  "aria-label": label,
  value,
  onValueChange,
  unavailableReason,
  count,
  describeCount,
  disabled,
  segmentProps,
  onReselect,
  className,
}: ScopeSegmentsProps): React.JSX.Element {
  const hintId = useId();
  const hint = SCOPE_VIEWS.map((view) => {
    const reason = unavailableReason(view);
    return reason ? `${SCOPE_VIEW_LABEL[view]}: ${reason}` : undefined;
  })
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <SegmentedControl
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
        className={cn("scope-segments", className)}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          const view = SCOPE_VIEWS.find((candidate) => candidate === next);
          if (view) onValueChange(view);
        }}
      >
        {SCOPE_VIEWS.map((view) => {
          const reason = unavailableReason(view);
          const shown = reason === undefined ? count(view) : undefined;
          const description = reason ?? (shown === undefined ? undefined : describeCount(shown));
          const descriptionId = `${hintId}-${view}`;
          const extra = segmentProps?.(view) ?? {};
          const segment = (
            <SegmentedControlItem
              {...extra}
              value={view}
              disabled={reason !== undefined}
              className={cn("scope-segments-item", extra.className)}
              aria-describedby={description === undefined ? undefined : descriptionId}
              onClick={(event) => {
                extra.onClick?.(event);
                if (view === value && reason === undefined) onReselect?.(view);
              }}
            >
              {SCOPE_VIEW_LABEL[view]}
              {shown !== undefined && (
                <span className="scope-segments-count" aria-hidden="true">
                  {shown}
                </span>
              )}
            </SegmentedControlItem>
          );
          const describedBy = description !== undefined && (
            <span id={descriptionId} className="sr-only">
              {description}
            </span>
          );
          return reason === undefined ? (
            <span key={view} className="scope-segments-slot">
              {segment}
              {describedBy}
            </span>
          ) : (
            <UnavailableScopeSlot key={view} reason={reason}>
              {segment}
              {describedBy}
            </UnavailableScopeSlot>
          );
        })}
      </SegmentedControl>
      {hint && (
        <span id={hintId} className="sr-only">
          {hint}
        </span>
      )}
    </>
  );
}

/**
 * The slot of a scope segment that does not apply. A disabled segment takes
 * neither focus nor pointer events, so its slot shows the reason: a tooltip
 * on hover, and on a tap or click, which is all touch has. Keyboard and
 * screen-reader users have it in the control's description.
 */
function UnavailableScopeSlot({
  reason,
  children,
}: {
  readonly reason: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root open={open} onOpenChange={setOpen}>
        <Tooltip.Trigger asChild>
          <span
            className="scope-segments-slot"
            data-unavailable=""
            onClick={(event) => {
              // The trigger would close the tooltip on a click.
              event.preventDefault();
              setOpen(true);
            }}
          >
            {children}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="lineage-tooltip"
            side="bottom"
            sideOffset={6}
            collisionPadding={8}
          >
            {reason}
            <Tooltip.Arrow className="lineage-tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
