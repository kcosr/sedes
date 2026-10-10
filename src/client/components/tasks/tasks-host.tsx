import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";
import type { EnvironmentTintStyle } from "../../app/environment-palette.js";
import type {
  PanelChromeControls,
  PanelRegionControls,
} from "../../workspace-panels/PanelChrome.js";
import { StablePaneSlot } from "../../workspace-panels/StablePaneSlot.js";

/**
 * Where the one retained Tasks body is shown. Tasks belongs to a thread
 * workspace; other pages (Home, Archived, Usage, the automation pages) have
 * no Tasks surface.
 * - `panel`: a workspace panel tenant in its region, so it moves, resizes,
 *   hides and persists like Files and Workpads;
 * - `sheet`: a bottom sheet on phones.
 */
export type TasksPresentation = "panel" | "sheet";

/** Phones get the sheet; the same width at which panels stop docking. */
export const TASKS_SHEET_QUERY = "(max-width: 819px)";

/** What a mounted thread workspace tells the Tasks host about its panel. */
export interface TasksDock {
  /** The Tasks panel is loaded, on stage or hidden. */
  readonly present: boolean;
  /** The Tasks panel is on stage. */
  readonly visible: boolean;
  /**
   * The panel's Maximize, Move to and close controls. The content renders
   * the panel header itself, so it shows these in its `PanelChrome`.
   */
  readonly controls: PanelChromeControls;
  /** The thread environment's tint, as the other panel headers show it. */
  readonly environmentTintStyle?: EnvironmentTintStyle;
  /** Loads the panel if needed and shows it in its place. */
  open(options: { readonly focus: boolean }): void;
  /** Hides the panel when it is on stage, otherwise shows (or opens) it. */
  toggle(invoker?: HTMLElement): void;
  /** Closes (unloads) the panel; focus moves to the next surface. */
  close(): void;
}

export interface TasksHost {
  /** The retained body's portal target, adopted by the current surface. */
  readonly bodyTarget: HTMLElement;
  readonly placement: TasksPresentation | undefined;
  /** Whether the phone sheet is open (its local open state). */
  readonly sheetOpen: boolean;
  toggleSheet(): void;
  /** Must be stable: a thread workspace publishes its panel through it. */
  publishDock(dock: TasksDock | undefined): void;
}

export const TasksHostContext = createContext<TasksHost | undefined>(undefined);

export function useTasksHost(): TasksHost | undefined {
  return useContext(TasksHostContext);
}

/**
 * Publishes the thread workspace's Tasks panel to the host. Only the
 * presence, visibility, the header's region state and tint are compared;
 * the callbacks always run the latest render's, so frequent layout renders
 * do not re-render Tasks.
 */
export function usePublishTasksDock(dock: TasksDock | undefined): void {
  const publish = useTasksHost()?.publishDock;
  const latest = useRef(dock);
  latest.current = dock;
  const defined = dock !== undefined;
  const present = dock?.present ?? false;
  const visible = dock?.visible ?? false;
  const active = dock?.controls.active;
  const closeAction = dock?.controls.closeAction;
  const region = dock?.controls.region;
  // The region controls' state, compared by value.
  const regionState = region
    ? JSON.stringify({
        region: region.region,
        maximized: region.maximized,
        extended: region.extended,
      })
    : undefined;
  // A tint is rebuilt each render, so it is compared by value.
  const tint = dock?.environmentTintStyle
    ? JSON.stringify(dock.environmentTintStyle)
    : undefined;
  useLayoutEffect(() => {
    if (!publish) return;
    if (!defined) {
      publish(undefined);
      return;
    }
    const state = regionState === undefined
      ? undefined
      : (JSON.parse(regionState) as Pick<
          PanelRegionControls,
          "region" | "maximized" | "extended"
        >);
    const current = () => latest.current?.controls.region;
    publish({
      present,
      visible,
      controls: {
        ...(active === undefined ? {} : { active }),
        ...(closeAction === undefined ? {} : { closeAction }),
        onClose: (invoker) => latest.current?.controls.onClose(invoker),
        ...(state === undefined
          ? {}
          : {
              region: {
                ...state,
                onMaximize: () => current()?.onMaximize(),
                onRestore: () => current()?.onRestore(),
                onMove: (target) => current()?.onMove(target),
                onExtend: (on) => current()?.onExtend(on),
              },
            }),
      },
      ...(tint === undefined
        ? {}
        : { environmentTintStyle: JSON.parse(tint) as EnvironmentTintStyle }),
      open: (options) => latest.current?.open(options),
      toggle: (invoker) => latest.current?.toggle(invoker),
      close: () => latest.current?.close(),
    });
  }, [publish, defined, present, visible, active, closeAction, regionState, tint]);
  useLayoutEffect(() => () => publish?.(undefined), [publish]);
}

/**
 * The surface that adopts the retained body. Both presentations share the
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
