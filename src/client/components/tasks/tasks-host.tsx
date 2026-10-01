import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";
import type { PanelChromeControls } from "../../workspace-panels/PanelChrome.js";
import { StablePaneSlot } from "../../workspace-panels/StablePaneSlot.js";
import { TasksPanelToggle } from "./TasksPanelToggle.js";

/**
 * Where the one retained Tasks body is shown:
 * - `panel`: docked beside Chat in a thread workspace (a workspace panel
 *   tenant, so it resizes, collapses and persists like Files and Workpads);
 * - `popover`: anchored to the toggle on pages without panels (Home,
 *   Archived, Usage);
 * - `sheet`: a bottom sheet on phones.
 */
export type TasksPresentation = "panel" | "popover" | "sheet";

/** Phones get the sheet; the same width at which panels stop docking. */
export const TASKS_SHEET_QUERY = "(max-width: 819px)";

/** What a mounted thread workspace tells the Tasks host about its panel. */
export interface TasksDock {
  /** The Tasks panel is in this layout, on stage or collapsed. */
  readonly present: boolean;
  /** The Tasks panel is on stage. */
  readonly visible: boolean;
  /**
   * The panel's collapse, dock and close controls. The content renders the
   * panel header itself, so it shows these in its `PanelChrome`.
   */
  readonly controls: PanelChromeControls;
  /** Adds the panel to the layout or reveals it there. */
  open(options: { readonly focus: boolean }): void;
  /** Closes the panel when it is on stage, otherwise opens or reveals it. */
  toggle(invoker?: HTMLElement): void;
  /** Closes the panel; focus moves to the next surface. */
  close(): void;
}

export interface TasksHost {
  /** The retained body's portal target, adopted by the current surface. */
  readonly bodyTarget: HTMLElement;
  readonly placement: TasksPresentation | undefined;
  /** Whether the popover or the sheet is open (their local open state). */
  readonly overlayOpen: boolean;
  toggleOverlay(): void;
  /** The popover's anchor on pages without panels. */
  setPopoverAnchor(element: HTMLElement | null): void;
  /** Must be stable: a thread workspace publishes its panel through it. */
  publishDock(dock: TasksDock | undefined): void;
}

export const TasksHostContext = createContext<TasksHost | undefined>(undefined);

export function useTasksHost(): TasksHost | undefined {
  return useContext(TasksHostContext);
}

/**
 * Publishes the thread workspace's Tasks panel to the host. Only the
 * presence, visibility and dock edge are compared; the callbacks always run
 * the latest render's, so frequent layout renders do not re-render Tasks.
 */
export function usePublishTasksDock(dock: TasksDock | undefined): void {
  const publish = useTasksHost()?.publishDock;
  const latest = useRef(dock);
  latest.current = dock;
  const defined = dock !== undefined;
  const present = dock?.present ?? false;
  const visible = dock?.visible ?? false;
  const active = dock?.controls.active;
  const dockEdge = dock?.controls.dockEdge;
  useLayoutEffect(() => {
    if (!publish) return;
    if (!defined) {
      publish(undefined);
      return;
    }
    publish({
      present,
      visible,
      controls: {
        ...(active === undefined ? {} : { active }),
        ...(dockEdge === undefined ? {} : { dockEdge }),
        onCollapse: () => latest.current?.controls.onCollapse(),
        onClose: (invoker) => latest.current?.controls.onClose(invoker),
        onDock: (edge) => latest.current?.controls.onDock(edge),
      },
      open: (options) => latest.current?.open(options),
      toggle: (invoker) => latest.current?.toggle(invoker),
      close: () => latest.current?.close(),
    });
  }, [publish, defined, present, visible, active, dockEdge]);
  useLayoutEffect(() => () => publish?.(undefined), [publish]);
}

/**
 * The surface that adopts the retained body. Every presentation shares the
 * `tasks-panel` slot and id, so the toggle's `aria-controls` and tests find
 * Tasks wherever it is shown.
 */
export function TasksSurface({
  presentation,
  target,
}: {
  readonly presentation: TasksPresentation;
  readonly target: HTMLElement;
}): React.JSX.Element {
  return (
    <section
      id="tasks-panel"
      className="tasks-surface"
      data-slot="tasks-panel"
      data-presentation={presentation}
      aria-label="Tasks"
    >
      <StablePaneSlot target={target} style={{ display: "contents" }} />
    </section>
  );
}

/** The `tasks` workspace panel tenant's content: the docked body's slot. */
export function TasksDockSlot(): React.JSX.Element | null {
  const host = useTasksHost();
  return host?.placement === "panel" ? (
    <TasksSurface presentation="panel" target={host.bodyTarget} />
  ) : null;
}

/** The Tasks toggle in the pane corner of pages without panels. */
export function TasksCornerControls({
  count,
}: {
  /** Open tasks in this page's context. */
  readonly count?: number;
}): React.JSX.Element {
  const host = useTasksHost();
  return (
    <div
      className="tasks-corner-controls"
      ref={(element) => host?.setPopoverAnchor(element)}
    >
      <TasksPanelToggle
        open={host?.overlayOpen ?? false}
        onToggle={() => host?.toggleOverlay()}
        {...(count === undefined ? {} : { count })}
      />
    </div>
  );
}
