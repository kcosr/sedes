import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import type { EnvironmentTintStyle } from "../../app/environment-palette.js";
import type {
  PanelChromeControls,
  PanelRegionControls,
} from "../../workspace-panels/PanelChrome.js";
import type { WorkspacePanelHost } from "../../workspace-panels/registry.js";
import { StablePaneSlot } from "../../workspace-panels/StablePaneSlot.js";

/**
 * How the one retained Tasks body is shown in its workspace panel. Tasks
 * belongs to a thread workspace; other pages (Home, Archived, Usage, the
 * automation pages) have no Tasks surface.
 * - `panel`: on the desktop stage, in its region, with the panel family's
 *   header and inline task details;
 * - `sheet`: on a phone, as the panel in front, like Files and Workpads,
 *   with the touch layout: an add bar under the list, and a task's detail in
 *   place of the list.
 */
export type TasksPresentation = "panel" | "sheet";

/** What a mounted thread workspace tells the Tasks host about its panel. */
export interface TasksDock {
  /** The Tasks panel is loaded, on stage or hidden. */
  readonly present: boolean;
  /** The Tasks panel is on stage: in its region, or in front on a phone. */
  readonly visible: boolean;
  /** The layout's presentation: `sheet` on phones, `panel` otherwise. */
  readonly presentation: TasksPresentation;
  /**
   * The panel's close control, and on desktop its Maximize and Move to. The
   * content renders the panel header itself, so it shows these in its
   * `PanelChrome`.
   */
  readonly controls: PanelChromeControls;
  /** The thread environment's tint, as the other panel headers show it. */
  readonly environmentTintStyle?: EnvironmentTintStyle;
  /** Loads the panel if needed and shows it in its place, in front on phones. */
  open(options: { readonly focus: boolean }): void;
  /** Hides the panel when it is on stage, otherwise shows (or opens) it. */
  toggle(invoker?: HTMLElement): void;
  /** Closes (unloads) the panel; focus moves to the next surface. */
  close(): void;
  /** Phones: brings Chat, their home, in front; Tasks stays loaded. */
  showChat(): void;
}

export interface TasksHost {
  /** The retained body's portal target, adopted by the panel's surface. */
  readonly bodyTarget: HTMLElement;
  /** How the loaded panel shows the body; undefined while it is not loaded. */
  readonly presentation: TasksPresentation | undefined;
  /** Whether the retained body holds an edit with unsaved changes. */
  readonly dirty: boolean;
  /** Must be stable: a thread workspace publishes its panel through it. */
  publishDock(dock: TasksDock | undefined): void;
}

export const TasksHostContext = createContext<TasksHost | undefined>(undefined);

export function useTasksHost(): TasksHost | undefined {
  return useContext(TasksHostContext);
}

/**
 * Publishes the thread workspace's Tasks panel to the host. Only the
 * presence, visibility, presentation, the header's region state and tint
 * are compared; the callbacks always run the latest render's, so frequent
 * layout renders do not re-render Tasks.
 */
export function usePublishTasksDock(dock: TasksDock | undefined): void {
  const publish = useTasksHost()?.publishDock;
  const latest = useRef(dock);
  latest.current = dock;
  const defined = dock !== undefined;
  const present = dock?.present ?? false;
  const visible = dock?.visible ?? false;
  const presentation = dock?.presentation ?? "panel";
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
      presentation,
      controls: {
        ...(active === undefined ? {} : { active }),
        ...(closeAction === undefined ? {} : { closeAction }),
        onClose: (invoker) => latest.current?.controls.onClose?.(invoker),
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
      showChat: () => latest.current?.showChat(),
    });
  }, [
    publish,
    defined,
    present,
    visible,
    presentation,
    active,
    closeAction,
    regionState,
    tint,
  ]);
  useLayoutEffect(() => () => publish?.(undefined), [publish]);
}

/**
 * The surface that adopts the retained body, with the `tasks-panel` slot and
 * id, so the quick button's `aria-controls` and tests find Tasks in either
 * presentation.
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

/**
 * The `tasks` workspace panel tenant's content: the retained body's slot. It
 * stays mounted while Tasks is loaded, shown or hidden, and reports the
 * retained body's unsaved edit through the tenant host, as other tenants
 * report theirs, so the layout asks before ✕ or Reset layout unloads it.
 */
export function TasksDockSlot({
  panelHost,
}: {
  readonly panelHost?: Pick<WorkspacePanelHost, "setDirty">;
} = {}): React.JSX.Element | null {
  const host = useTasksHost();
  const dirty = host?.dirty ?? false;
  useEffect(() => {
    panelHost?.setDirty(dirty);
  }, [dirty, panelHost]);
  return host?.presentation ? (
    <TasksSurface presentation={host.presentation} target={host.bodyTarget} />
  ) : null;
}
