import {
  type KeyboardEvent as ReactKeyboardEvent,
  type FocusEventHandler,
  type DragEventHandler,
  type PointerEvent as ReactPointerEvent,
  type PointerEventHandler,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { SidebarDensity } from "../../app/sidebar-view-model.js";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog.js";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover.js";
import "./thread-group-roster.css";

export type ThreadGroupRosterPresentation = "popover" | "sheet";

export interface ThreadGroupRosterMember {
  readonly id: string;
}

export interface ThreadGroupRosterRenderState {
  readonly density: SidebarDensity;
  readonly presentation: ThreadGroupRosterPresentation;
  readonly isRepresentative: boolean;
  readonly isSelected: boolean;
  /** Dismiss the roster after an action that navigates to this member. */
  readonly close: () => void;
}

export interface ThreadGroupRosterProps<
  Member extends ThreadGroupRosterMember,
> {
  readonly label: string;
  readonly members: readonly Member[];
  readonly representativeId: string;
  readonly selectedId?: string | null;
  readonly density: SidebarDensity;
  readonly presentation: ThreadGroupRosterPresentation;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Stable id referenced by a stack face's aria-controls attribute. */
  readonly contentId?: string;
  /** Autofocus the initial member when a desktop popover opens from keyboard. */
  readonly autoFocusMembers?: boolean;
  readonly renderMember: (
    member: Member,
    state: ThreadGroupRosterRenderState,
  ) => ReactNode;
  /**
   * The stack card used as the desktop positioning anchor. It remains in
   * charge of hover, click, and context-menu behavior; the roster does not
   * turn it into a popover trigger.
   */
  readonly anchor?: ReactElement;
  /** Group-scoped controls supplied by the inventory owner (filter/manage). */
  readonly headerActions?: ReactNode;
  readonly onEscape?: () => void;
  readonly onPointerEnter?: PointerEventHandler<HTMLDivElement>;
  readonly onPointerLeave?: PointerEventHandler<HTMLDivElement>;
  readonly onFocusCapture?: FocusEventHandler<HTMLDivElement>;
  readonly onBlurCapture?: FocusEventHandler<HTMLDivElement>;
  readonly onDragEnter?: DragEventHandler<HTMLDivElement>;
  readonly onDragOver?: DragEventHandler<HTMLDivElement>;
  readonly onDragLeave?: DragEventHandler<HTMLDivElement>;
  readonly className?: string;
}

const FOCUSABLE_MEMBER_CONTROL =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusMember(item: HTMLElement | undefined): void {
  if (!item) return;
  const control = item.querySelector<HTMLElement>(FOCUSABLE_MEMBER_CONTROL);
  (control ?? item).focus();
}

function RosterBody<Member extends ThreadGroupRosterMember>({
  label,
  members,
  representativeId,
  selectedId,
  density,
  presentation,
  headerActions,
  onOpenChange,
  renderMember,
  titleId,
  contentId,
}: Omit<ThreadGroupRosterProps<Member>, "anchor" | "open" | "className"> & {
  readonly titleId: string;
  readonly contentId: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const handleListKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) {
        return;
      }
      const items = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>(
          "[data-thread-group-roster-member]",
        ) ?? [],
      );
      if (items.length === 0) return;
      const current = items.findIndex((item) =>
        item.contains(document.activeElement),
      );
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowDown"
              ? current < 0
                ? 0
                : (current + 1) % items.length
              : current < 0
                ? items.length - 1
                : (current - 1 + items.length) % items.length;
      event.preventDefault();
      focusMember(items[next]);
    },
    [],
  );

  return (
    <div
      id={contentId}
      className="thread-group-roster-frame"
      data-testid="thread-group-roster"
      data-density={density}
      data-presentation={presentation}
    >
      <header className="thread-group-roster-header">
        <h2 id={titleId} className="thread-group-roster-title">
          {label}
        </h2>
        <div className="thread-group-roster-actions">
          {headerActions}
        </div>
      </header>
      <div
        ref={listRef}
        className="thread-group-roster-list"
        role="list"
        aria-labelledby={titleId}
        onKeyDown={handleListKeyDown}
      >
        {members.map((member) => {
          const isRepresentative = member.id === representativeId;
          const isSelected = member.id === selectedId;
          return (
            <div
              key={member.id}
              className="thread-group-roster-member"
              role="listitem"
              tabIndex={-1}
              data-testid="thread-group-member"
              data-thread-id={member.id}
              data-thread-group-roster-member={member.id}
              data-representative={isRepresentative || undefined}
              data-selected={isSelected || undefined}
              aria-current={isSelected ? "true" : undefined}
            >
              {renderMember(member, {
                density,
                presentation,
                isRepresentative,
                isSelected,
                close,
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ThreadGroupRoster<Member extends ThreadGroupRosterMember>(
  props: ThreadGroupRosterProps<Member>,
) {
  const generatedId = `thread-group-roster-${useId().replaceAll(":", "")}`;
  const contentId = props.contentId ?? generatedId;
  const titleId = `${contentId}-title`;
  const initialMemberId =
    (props.selectedId && props.members.some(({ id }) => id === props.selectedId)
      ? props.selectedId
      : undefined) ??
    (props.members.some(({ id }) => id === props.representativeId)
      ? props.representativeId
      : props.members[0]?.id);

  useEffect(() => {
    if (!props.open || props.presentation !== "popover") return;
    const handleScroll = (event: Event) => {
      const content = document.getElementById(contentId);
      if (
        content &&
        event.target instanceof Node &&
        content.contains(event.target)
      ) return;
      props.onOpenChange(false);
    };
    window.addEventListener("scroll", handleScroll, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("scroll", handleScroll, { capture: true });
    };
  }, [contentId, props.onOpenChange, props.open, props.presentation]);

  const focusInitialMember = useCallback(
    (event: Event) => {
      event.preventDefault();
      if (props.presentation === "popover" && !props.autoFocusMembers) {
        return;
      }
      const surface = event.currentTarget as HTMLElement;
      const items = Array.from(
        surface.querySelectorAll<HTMLElement>(
          "[data-thread-group-roster-member]",
        ),
      );
      focusMember(
        items.find(
          (item) => item.dataset.threadGroupRosterMember === initialMemberId,
        ) ?? items[0],
      );
    },
    [initialMemberId, props.autoFocusMembers, props.presentation],
  );

  const handleEscape = useCallback(
    (event: KeyboardEvent) => {
      event.preventDefault();
      props.onEscape?.();
      props.onOpenChange(false);
    },
    [props],
  );

  const [sheetDragOffset, setSheetDragOffset] = useState(0);
  const suppressSheetHandleClick = useRef(false);
  const sheetDrag = useRef<
    | {
        pointerId: number;
        startY: number;
        lastY: number;
        startedAt: number;
        moved: boolean;
      }
    | undefined
  >(undefined);
  const beginSheetDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    suppressSheetHandleClick.current = false;
    sheetDrag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      startedAt: performance.now(),
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveSheetDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = sheetDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.lastY = event.clientY;
    const offset = Math.max(0, event.clientY - drag.startY);
    if (offset > 4) drag.moved = true;
    setSheetDragOffset(offset);
  };
  const finishSheetDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = sheetDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const offset = Math.max(0, drag.lastY - drag.startY);
    const elapsed = Math.max(1, performance.now() - drag.startedAt);
    suppressSheetHandleClick.current = drag.moved;
    sheetDrag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (offset >= 72 || (offset >= 24 && offset / elapsed >= 0.55)) {
      props.onOpenChange(false);
    }
    setSheetDragOffset(0);
  };
  const cancelSheetDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (sheetDrag.current?.pointerId !== event.pointerId) return;
    sheetDrag.current = undefined;
    setSheetDragOffset(0);
  };

  const body = (
    <RosterBody {...props} titleId={titleId} contentId={contentId} />
  );

  if (props.presentation === "sheet") {
    return (
      <>
        {props.anchor}
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
          <DialogContent
            className={`thread-group-roster-sheet ${sheetDrag.current ? "is-dragging" : ""} ${props.className ?? ""}`}
            overlayClassName="thread-group-roster-sheet-overlay"
            style={
              {
                "--thread-group-sheet-drag-offset": `${sheetDragOffset}px`,
              } as React.CSSProperties
            }
            data-testid="thread-group-sheet"
            aria-labelledby={titleId}
            aria-describedby={undefined}
            aria-modal="true"
            onOpenAutoFocus={focusInitialMember}
            onEscapeKeyDown={handleEscape}
          >
            <DialogTitle className="sr-only">{props.label}</DialogTitle>
            <button
              type="button"
              className="thread-group-roster-sheet-handle"
              aria-label={`Close ${props.label} roster`}
              onClick={() => {
                if (suppressSheetHandleClick.current) {
                  suppressSheetHandleClick.current = false;
                  return;
                }
                props.onOpenChange(false);
              }}
              onPointerDown={beginSheetDrag}
              onPointerMove={moveSheetDrag}
              onPointerUp={finishSheetDrag}
              onPointerCancel={cancelSheetDrag}
            >
              <span aria-hidden="true" />
            </button>
            {body}
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      {props.anchor ? (
        <PopoverAnchor asChild>{props.anchor}</PopoverAnchor>
      ) : null}
      <PopoverContent
        className={`thread-group-roster-popover ${props.className ?? ""}`}
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        aria-labelledby={titleId}
        onPointerEnter={props.onPointerEnter}
        onPointerLeave={props.onPointerLeave}
        onFocusCapture={props.onFocusCapture}
        onBlurCapture={props.onBlurCapture}
        onDragEnter={props.onDragEnter}
        onDragOver={props.onDragOver}
        onDragLeave={props.onDragLeave}
        onOpenAutoFocus={focusInitialMember}
        onEscapeKeyDown={handleEscape}
      >
        {body}
      </PopoverContent>
    </Popover>
  );
}
