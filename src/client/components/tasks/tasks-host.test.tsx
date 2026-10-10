// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from "vitest";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import type { PanelRegionStore } from "../../workspace-panels/region-store.js";
import { navigate, threadPath, useRoute } from "../../app/router.js";
import {
  TASKS_PANEL_STORAGE_KEY,
  consumeReveal,
  getPendingReveal,
  revealTask,
  subscribeReveal,
} from "../../app/tasks-panel-store.js";
import { useMediaQuery } from "../../app/use-media-query.js";
import { MessageTaskCard } from "../conversation/renderers/MessageTaskCard.js";
import { TasksPanel } from "./TasksPanel.js";
import {
  TasksDockSlot,
  usePublishTasksDock,
  useTasksHost,
  type TasksDock,
} from "./tasks-host.js";

let phone = false;

beforeEach(() => {
  phone = false;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      get matches() {
        return query.includes("(max-width: 819px)") ? phone : false;
      },
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  window.localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: TASKS_PANEL_STORAGE_KEY }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  const pending = getPendingReveal();
  if (pending) consumeReveal(pending.sequence);
  navigate("/", { replace: true });
});

function makeStore(): ApplicationClientStore {
  const state = {
    snapshot: {
      threads: [
        {
          id: "thread-1",
          workspaceId: "workspace-1",
          title: { text: "Checkout flow" },
          inventoryState: "active",
        },
        {
          id: "thread-2",
          workspaceId: "workspace-1",
          title: { text: "Invoice rounding" },
          inventoryState: "active",
        },
      ],
      projects: [{ id: "project-1", name: "acme-web", revision: 0 }],
      workspaces: [
        { id: "workspace-1", projectId: "project-1", label: { text: "acme-web" }, displayPath: { text: "/acme" } },
      ],
      environments: [],
      tasks: [
        {
          id: "task-1",
          scope: { kind: "thread", threadId: "thread-1" },
          associatedProjectId: "project-1",
          title: "Audit error states",
          details: "",
          pinned: false,
          backlog: false,
          files: [],
          completedAt: null,
          revision: 0,
          createdAt: "2026-08-01T10:00:00.000Z",
          updatedAt: "2026-08-01T10:00:00.000Z",
        },
      ],
    },
  };
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => state,
    getTasks: () => state.snapshot.tasks,
  } as unknown as ApplicationClientStore;
}

const panelLayoutStore = { open: vi.fn(() => true) } as unknown as Pick<PanelRegionStore, "open">;

type DockSpy = {
  readonly open: Mock<(options: { readonly focus: boolean }) => void>;
  readonly toggle: Mock<(invoker?: HTMLElement) => void>;
  readonly close: Mock<() => void>;
  readonly onMaximize: Mock<() => void>;
  readonly onClose: Mock<(invoker: HTMLElement) => void>;
  readonly showChat: Mock<() => void>;
  /** The tenant host's dirty report. */
  readonly setDirty: Mock<(dirty: boolean) => void>;
};

/**
 * A thread workspace with the Tasks panel in its layout: loaded (present)
 * or not, and while loaded shown or hidden, as the panel layout keeps it.
 * On a phone the layout presents it with the touch layout, without region
 * controls, and Chat can come in front of it.
 */
function Workspace({
  spy,
  loaded = true,
}: {
  readonly spy: DockSpy;
  /** Whether Tasks starts loaded in the layout. */
  readonly loaded?: boolean;
}): React.JSX.Element {
  const [present, setPresent] = useState(loaded);
  const [shown, setShown] = useState(true);
  const phone = useMediaQuery("(max-width: 819px)");
  const dock: TasksDock = {
    present,
    visible: present && shown,
    presentation: phone ? "sheet" : "panel",
    controls: {
      active: true,
      ...(phone
        ? {}
        : {
            region: {
              region: "right",
              maximized: false,
              extended: true,
              onMaximize: spy.onMaximize,
              onRestore: vi.fn(),
              onMove: vi.fn(),
              onExtend: vi.fn(),
            },
          }),
      onClose: (invoker) => {
        spy.onClose(invoker);
        setPresent(false);
      },
    },
    environmentTintStyle: {
      "--environment-hue": 210,
      "--environment-chroma": 0.08,
    },
    open: (options) => {
      spy.open(options);
      setPresent(true);
      setShown(true);
    },
    // Hides a shown panel, keeping it loaded; shows (or loads) otherwise.
    toggle: (invoker) => {
      spy.toggle(invoker);
      if (present && shown) {
        setShown(false);
      } else {
        setPresent(true);
        setShown(true);
      }
    },
    close: () => {
      spy.close();
      setPresent(false);
    },
    // Chat in front: Tasks leaves the stage and stays loaded.
    showChat: () => {
      spy.showChat();
      setShown(false);
    },
  };
  usePublishTasksDock(dock);
  // A hidden panel stays mounted, parked out of view.
  return (
    <section aria-label="Tasks panel" hidden={!shown}>
      {present ? <TasksDockSlot panelHost={{ setDirty: spy.setDirty }} /> : null}
    </section>
  );
}

function dockSpy(): DockSpy {
  return {
    open: vi.fn(),
    toggle: vi.fn(),
    close: vi.fn(),
    onMaximize: vi.fn(),
    onClose: vi.fn(),
    showChat: vi.fn(),
    setDirty: vi.fn(),
  };
}

function Probe({ onHost }: { readonly onHost: (host: ReturnType<typeof useTasksHost>) => void }): null {
  onHost(useTasksHost());
  return null;
}

/**
 * The workbench: a thread's workspace with its Tasks panel, or a page
 * without a thread (Home, Archived, Usage, the automation pages), which has
 * no Tasks at all.
 */
function Page({
  spy,
  loaded,
}: {
  readonly spy: DockSpy;
  readonly loaded?: boolean;
}): React.JSX.Element {
  const route = useRoute();
  return route.name === "thread" ? (
    <Workspace spy={spy} loaded={loaded} />
  ) : (
    <p>{route.name} page</p>
  );
}

function renderHost({
  thread = false,
  active = true,
  spy = dockSpy(),
  extra,
  loaded,
}: {
  readonly thread?: boolean;
  readonly active?: boolean;
  readonly spy?: DockSpy;
  /** More workbench content, such as a transcript task card. */
  readonly extra?: ReactNode;
  /** Whether Tasks starts loaded in the thread's layout. */
  readonly loaded?: boolean;
} = {}) {
  if (thread) act(() => navigate(threadPath("thread-1")));
  let host: ReturnType<typeof useTasksHost>;
  const content = (isActive: boolean) => (
    <TasksPanel store={makeStore()} panelLayoutStore={panelLayoutStore} active={isActive}>
      <Probe onHost={(value) => (host = value)} />
      <Page spy={spy} loaded={loaded} />
      {extra}
    </TasksPanel>
  );
  const view = render(content(active));
  return {
    ...view,
    spy,
    host: () => host,
    setActive: (isActive: boolean) => view.rerender(content(isActive)),
  };
}

const tasksSurface = () => screen.queryByRole("region", { name: "Tasks" });
const editor = () => screen.queryByRole("dialog", { name: "Edit task" });

async function editNotes(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  fireEvent.keyDown(screen.getByRole("button", { name: "Audit error states" }), { key: "e" });
  await user.type(within(editor()!).getByRole("textbox", { name: "Notes" }), "Unsaved notes");
}

/** The editor's confirmations, the action that opens each, and the way back. */
const confirmations = [
  { title: "Discard unsaved changes?", opener: "Cancel", back: "Keep editing" },
  { title: "Delete task?", opener: "Delete…", back: "Cancel" },
] as const;

/**
 * The named dialog is the open dialog on top, exposed to assistive
 * technology (neither it nor an ancestor is aria-hidden), with focus
 * inside it.
 */
async function expectOnTop(name: string): Promise<void> {
  // Focus restoration for layers that closed runs on the next tick.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const open = [
    ...document.querySelectorAll<HTMLElement>('[data-slot="dialog-content"][data-state="open"]'),
  ];
  const top = open.at(-1)!;
  expect(top.querySelector('[data-slot="dialog-title"]')).toHaveTextContent(name);
  expect(top.closest('[aria-hidden="true"]')).toBeNull();
  expect(top).toContainElement(document.activeElement as HTMLElement);
}

const expectEditorOnTop = () => expectOnTop("Edit task");

/** Presses the Tasks shortcut; false when something prevented its default. */
const pressShortcut = (target: Element = document.body, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key: "L", ctrlKey: true, shiftKey: true, ...init });

const PAGES_WITHOUT_A_THREAD = [
  ["Home", "/"],
  ["Archived", "/archived"],
  ["Usage", "/usage"],
  ["Automations", "/automations"],
  ["An automation", "/automations/thread-1"],
] as const;

describe("Tasks host on pages without a thread", () => {
  it("adds no status region to the page while Tasks has nothing to announce", () => {
    renderHost();
    expect(screen.queryAllByRole("status")).toEqual([]);
  });

  describe.each([false, true])("(phone: %s)", (isPhone) => {
    it.each(PAGES_WITHOUT_A_THREAD)(
      "%s shows no Tasks, and leaves the shortcut and reveals alone",
      (_page, path) => {
        phone = isPhone;
        act(() => navigate(path));
        const { host } = renderHost();
        expect(screen.queryByTestId("tasks-panel-toggle")).toBeNull();

        // Nothing to toggle: the key is not taken from the page.
        expect(pressShortcut()).toBe(true);
        act(() => revealTask("task-1"));

        expect(host()?.presentation).toBeUndefined();
        expect(tasksSurface()).toBeNull();
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(document.querySelector(".tasks-content")).toBeNull();
      },
    );
  });
});

describe("Tasks host from one thread to the next", () => {
  it.each([
    ["docked", false, "panel"],
    ["on a phone", true, "sheet"],
  ] as const)("keeps the body and an unsaved edit on stage %s", async (_case, isPhone, presentation) => {
    phone = isPhone;
    const user = userEvent.setup();
    const { spy } = renderHost({ thread: true });
    const body = document.querySelector(".tasks-content");
    await editNotes(user);

    act(() => navigate(threadPath("thread-2")));

    expect(tasksSurface()).toHaveAttribute("data-presentation", presentation);
    expect(document.querySelector(".tasks-content")).toBe(body);
    await expectEditorOnTop();
    expect(within(editor()!).getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved notes");
    expect(spy.open).not.toHaveBeenCalled();
  });
});

describe("Tasks host in a thread workspace", () => {
  it("reports an unsaved edit through the tenant host, hidden or shown", async () => {
    const user = userEvent.setup();
    const { spy, host } = renderHost({ thread: true });
    expect(spy.setDirty).toHaveBeenLastCalledWith(false);
    await editNotes(user);
    expect(spy.setDirty).toHaveBeenLastCalledWith(true);
    expect(host()?.dirty).toBe(true);

    // Hiding Tasks keeps the body and the edit in it.
    pressShortcut();
    expect(spy.toggle).toHaveBeenCalledOnce();
    expect(editor()).toBeNull();
    expect(spy.setDirty).toHaveBeenLastCalledWith(true);
    pressShortcut();
    expect(within(editor()!).getByRole("textbox", { name: "Notes" })).toHaveValue(
      "Unsaved notes",
    );
  });

  it("discards the body and its edit when the layout unloads Tasks", async () => {
    const user = userEvent.setup();
    const { spy, host } = renderHost({ thread: true });
    await editNotes(user);
    const body = document.querySelector(".tasks-content");
    // ✕ (or Reset layout) unloads Tasks after the layout's confirmation.
    fireEvent.click(screen.getByRole("button", { name: "Close Tasks panel", hidden: true }));
    expect(spy.onClose).toHaveBeenCalledOnce();
    expect(editor()).toBeNull();
    expect(host()?.dirty).toBe(false);
    expect(document.querySelector(".tasks-content")).toBeNull();

    // Opened again, Tasks has a new body, without the editor.
    pressShortcut();
    expect(tasksSurface()).not.toBeNull();
    expect(document.querySelector(".tasks-content")).not.toBe(body);
    expect(editor()).toBeNull();
    expect(
      screen.getByRole("button", { name: "Audit error states" }),
    ).toBeInTheDocument();
  });

  it("docks the retained body in the panel with the panel's own controls", () => {
    const { spy, host } = renderHost({ thread: true });
    const panel = screen.getByRole("region", { name: "Tasks panel" });
    const surface = within(panel).getByRole("region", { name: "Tasks" });
    expect(host()?.presentation).toBe("panel");
    expect(surface).toHaveAttribute("data-presentation", "panel");
    // One header: the content's panel chrome, with Maximize, Move to and close.
    expect(surface.querySelectorAll("header")).toHaveLength(1);
    const header = surface.querySelector<HTMLElement>(".workspace-panel-chrome");
    expect(header).not.toBeNull();
    // Like the other panel headers, it carries the thread environment's tint.
    expect(header).toHaveAttribute("data-environment-tint", "true");
    expect(header!.style.getPropertyValue("--environment-hue")).toBe("210");
    fireEvent.click(within(surface).getByRole("button", { name: "Maximize Tasks panel" }));
    expect(spy.onMaximize).toHaveBeenCalledTimes(1);
    expect(within(surface).getByRole("button", { name: "Tasks panel actions" })).toBeInTheDocument();
    fireEvent.click(within(surface).getByRole("button", { name: "Close Tasks panel" }));
    expect(spy.onClose).toHaveBeenCalledTimes(1);
    expect(tasksSurface()).toBeNull();
  });

  it("shows the body in the phone panel with the touch layout and the panel's close", async () => {
    phone = true;
    const user = userEvent.setup();
    const { spy, host } = renderHost({ thread: true });
    const panel = screen.getByRole("region", { name: "Tasks panel" });
    const surface = within(panel).getByRole("region", { name: "Tasks" });
    expect(host()?.presentation).toBe("sheet");
    expect(surface).toHaveAttribute("data-presentation", "sheet");
    // A panel like the others, not a dialog over the workbench.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panel).not.toHaveAttribute("aria-hidden");
    // One header: the panel chrome, without regions, its ⋯ carrying the
    // View options.
    expect(surface.querySelectorAll("header")).toHaveLength(1);
    expect(within(surface).queryByRole("button", { name: "Maximize Tasks panel" })).toBeNull();
    expect(within(surface).queryByRole("button", { name: "View options" })).toBeNull();
    await user.click(within(surface).getByRole("button", { name: "Tasks panel actions" }));
    const menu = screen.getByRole("dialog", { name: "Tasks panel" });
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Pinned" })).not.toBeChecked();
    expect(within(menu).getByRole("menuitem", { name: "Add a task with notes" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    fireEvent.click(within(surface).getByRole("button", { name: "Close Tasks panel" }));
    expect(spy.onClose).toHaveBeenCalledOnce();
    expect(tasksSurface()).toBeNull();
  });

  it.each(confirmations)(
    "brings an edit back from Settings with $title on top of the editor",
    async ({ title, opener }) => {
      const user = userEvent.setup();
      const view = renderHost({ thread: true });
      await editNotes(user);
      await user.click(within(editor()!).getByRole("button", { name: opener }));

      view.setActive(false);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(screen.queryByRole("dialog")).toBeNull();
      view.setActive(true);

      await expectOnTop(title);
    },
  );
});

describe("Tasks host across the phone breakpoint", () => {
  /** Lets the phone query change while mounted, as a window resize does. */
  function stubBreakpoint(): (next: boolean) => void {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        get matches() {
          return query.includes("(max-width: 819px)") ? phone : false;
        },
        media: query,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          if (query.includes("(max-width: 819px)")) listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          listeners.delete(listener);
        },
      })),
    );
    return (next) =>
      act(() => {
        phone = next;
        for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
      });
  }

  // The surface behind the modal editor is hidden from the accessibility tree.
  const surfaceElement = () => document.querySelector('[data-slot="tasks-panel"]');

  it("keeps the body in its panel, changing only its layout", () => {
    const setPhone = stubBreakpoint();
    const { spy, host } = renderHost({ thread: true });
    const body = document.querySelector(".tasks-content");
    expect(tasksSurface()).toHaveAttribute("data-presentation", "panel");

    setPhone(true);
    expect(host()?.presentation).toBe("sheet");
    expect(tasksSurface()).toHaveAttribute("data-presentation", "sheet");
    expect(document.querySelector(".tasks-content")).toBe(body);

    setPhone(false);
    expect(tasksSurface()).toHaveAttribute("data-presentation", "panel");
    expect(document.querySelector(".tasks-content")).toBe(body);
    // Tasks was on stage throughout: nothing had to show it.
    expect(spy.open).not.toHaveBeenCalled();
  });

  it("keeps an edit open across the breakpoint, both ways", async () => {
    const setPhone = stubBreakpoint();
    const user = userEvent.setup();
    const { spy } = renderHost({ thread: true });
    await editNotes(user);
    const dialog = editor();

    setPhone(true);
    expect(surfaceElement()).toHaveAttribute("data-presentation", "sheet");
    await expectEditorOnTop();
    // The same editor, never closed: no surface mounts over it.
    expect(editor()).toBe(dialog);
    expect(within(editor()!).getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved notes");

    setPhone(false);
    expect(surfaceElement()).toHaveAttribute("data-presentation", "panel");
    await expectEditorOnTop();
    expect(editor()).toBe(dialog);
    expect(within(editor()!).getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved notes");
    expect(spy.open).not.toHaveBeenCalled();
  });

  it.each([
    ["to a phone", false],
    ["to desktop", true],
  ] as const)(
    "shows Tasks for an open edit when the layout %s leaves it off stage",
    async (_direction, startsOnPhone) => {
      phone = startsOnPhone;
      const setPhone = stubBreakpoint();
      const user = userEvent.setup();
      renderHost({ thread: true });
      await editNotes(user);
      // Off stage (another panel in front, or make-room), the edit waits.
      pressShortcut();
      expect(editor()).toBeNull();

      setPhone(!startsOnPhone);

      await expectEditorOnTop();
      expect(within(editor()!).getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved notes");
    },
  );

  it.each(confirmations)(
    "keeps $title on top of the editor across the breakpoint, both ways",
    async ({ title, opener, back }) => {
      const setPhone = stubBreakpoint();
      const user = userEvent.setup();
      renderHost({ thread: true });
      await editNotes(user);
      await user.click(within(editor()!).getByRole("button", { name: opener }));
      await expectOnTop(title);

      setPhone(true);
      expect(surfaceElement()).toHaveAttribute("data-presentation", "sheet");
      await expectOnTop(title);

      setPhone(false);
      expect(surfaceElement()).toHaveAttribute("data-presentation", "panel");
      await expectOnTop(title);

      // Backing out of the confirmation returns to the edit as it was.
      await user.click(
        within(screen.getByRole("dialog", { name: title })).getByRole("button", { name: back }),
      );
      await expectEditorOnTop();
      expect(within(editor()!).getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved notes");
    },
  );
});

describe("Tasks host under Settings", () => {
  /**
   * jsdom runs no CSS animations, so Radix unmounts a closed dialog at once.
   * Report overlay.css's motion names for the dialog's state instead, so a
   * closed dialog stays mounted, animating out, as it does in a browser.
   */
  function simulateExitMotion(): void {
    const computed = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const style = computed(element, pseudo);
      if (!(element instanceof HTMLElement) || element.dataset.slot !== "dialog-content") {
        return style;
      }
      return new Proxy(style, {
        get(target, property) {
          if (property === "animationName") {
            return element.dataset.state === "closed" ? "ui-dialog-out" : "ui-dialog-in";
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    onTestFinished(() => spy.mockRestore());
  }

  /** Ends a closed dialog's exit motion, as the browser's animationend does. */
  function finishExitMotion(element: Element): void {
    const end = new Event("animationend");
    Object.defineProperty(end, "animationName", { value: "ui-dialog-out" });
    act(() => {
      element.dispatchEvent(end);
    });
  }

  it("reopens the editor, then its confirmation, once both have finished closing", async () => {
    simulateExitMotion();
    const user = userEvent.setup();
    const view = renderHost({ thread: true });
    await editNotes(user);
    await user.click(within(editor()!).getByRole("button", { name: "Delete…" }));

    view.setActive(false);

    // Both animate out. The editor's motion may end first; a confirmation
    // still closing would be hidden by an editor mounted again over it, so
    // the editor waits.
    const closing = [
      ...document.querySelectorAll('[data-slot="dialog-content"][data-state="closed"]'),
    ];
    expect(
      closing.map((dialog) => dialog.querySelector('[data-slot="dialog-title"]')?.textContent),
    ).toEqual(["Edit task", "Delete task?"]);
    finishExitMotion(closing[0]!);
    view.setActive(true);
    expect(document.querySelector(".tasks-edit-dialog")).toBeNull();
    finishExitMotion(closing[1]!);

    await expectOnTop("Delete task?");
  });
});

describe("revealTask", () => {
  it("opens the docked panel without moving focus in a thread workspace", () => {
    const { spy } = renderHost({ thread: true });
    act(() => revealTask("task-1"));
    expect(spy.open).toHaveBeenCalledWith({ focus: false });
  });

  it("opens the phone panel through the layout, on the task's detail", () => {
    phone = true;
    const { spy } = renderHost({ thread: true, loaded: false });
    act(() => revealTask("task-1"));
    expect(spy.open).toHaveBeenCalledWith({ focus: false });
    const panel = screen.getByRole("region", { name: "Tasks panel" });
    // The content, not the host, takes the request: it shows the task's
    // detail.
    expect(getPendingReveal()).toBeUndefined();
    expect(
      within(panel).getByRole("heading", { name: "Audit error states" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is what the transcript card's Open task asks for in a thread workspace", async () => {
    const user = userEvent.setup();
    const spy = dockSpy();
    renderHost({
      thread: true,
      spy,
      extra: <MessageTaskCard taskId="task-1" title="Audit error states" />,
    });
    // Start with the panel closed, so opening it is the card's doing.
    await user.click(screen.getByRole("button", { name: "Close Tasks panel" }));
    expect(tasksSurface()).toBeNull();
    const requests = vi.fn();
    const unsubscribe = subscribeReveal(requests);

    await user.click(
      screen.getByRole("button", { name: "Open task: Audit error states" }),
    );
    unsubscribe();

    expect(spy.open).toHaveBeenCalledWith({ focus: false });
    expect(tasksSurface()).toHaveAttribute("data-presentation", "panel");
    expect(requests).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1" }),
    );
  });
});

describe("toggle Tasks shortcut", () => {
  const press = pressShortcut;

  it("toggles the docked panel in a thread workspace", () => {
    const { spy } = renderHost({ thread: true });
    expect(press()).toBe(false);
    expect(spy.toggle).toHaveBeenCalledTimes(1);
    expect(tasksSurface()).toBeNull();
    press(document.body, { metaKey: true, ctrlKey: false, key: "l" });
    expect(spy.toggle).toHaveBeenCalledTimes(2);
    expect(tasksSurface()).not.toBeNull();
  });

  it("toggles the phone panel through the layout, from inside it too", () => {
    phone = true;
    const { spy } = renderHost({ thread: true, loaded: false });
    expect(press()).toBe(false);
    expect(spy.toggle).toHaveBeenCalledOnce();
    expect(tasksSurface()).toHaveAttribute("data-presentation", "sheet");
    expect(screen.queryByRole("dialog")).toBeNull();
    press(tasksSurface()!);
    expect(spy.toggle).toHaveBeenCalledTimes(2);
    expect(tasksSurface()).toBeNull();
  });

  it("leaves other dialogs, repeats, plain keys and Settings alone", () => {
    const view = renderHost({ thread: true });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const field = document.createElement("input");
    dialog.append(field);
    document.body.append(dialog);
    press(field);
    press(document.body, { repeat: true });
    press(document.body, { shiftKey: false });
    view.setActive(false);
    press();
    expect(view.spy.toggle).not.toHaveBeenCalled();
    dialog.remove();
  });
});
