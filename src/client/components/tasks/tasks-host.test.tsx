// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from "vitest";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import type { PanelLayoutStore } from "../../workspace-panels/panel-state.js";
import { navigate, threadPath, useRoute } from "../../app/router.js";
import {
  TASKS_PANEL_STORAGE_KEY,
  consumeReveal,
  getPendingReveal,
  revealTask,
  subscribeReveal,
} from "../../app/tasks-panel-store.js";
import { MessageTaskCard } from "../conversation/renderers/MessageTaskCard.js";
import { TasksPanel } from "./TasksPanel.js";
import { TasksPanelToggle } from "./TasksPanelToggle.js";
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
        return query === "(max-width: 819px)" ? phone : false;
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

const panelLayoutStore = { openPanel: vi.fn(() => true) } as unknown as PanelLayoutStore;

type DockSpy = {
  readonly open: Mock<(options: { readonly focus: boolean }) => void>;
  readonly toggle: Mock<(invoker?: HTMLElement) => void>;
  readonly close: Mock<() => void>;
  readonly onCollapse: Mock<() => void>;
  readonly onClose: Mock<(invoker: HTMLElement) => void>;
};

/** A thread workspace with the Tasks panel in its layout. */
function Workspace({ spy }: { readonly spy: DockSpy }): React.JSX.Element {
  const [present, setPresent] = useState(true);
  const dock: TasksDock = {
    present,
    visible: present,
    controls: {
      active: true,
      dockEdge: "right",
      onCollapse: spy.onCollapse,
      onClose: (invoker) => {
        spy.onClose(invoker);
        setPresent(false);
      },
      onDock: vi.fn(),
    },
    environmentTintStyle: {
      "--environment-hue": 210,
      "--environment-chroma": 0.08,
    },
    open: (options) => {
      spy.open(options);
      setPresent(true);
    },
    toggle: (invoker) => {
      spy.toggle(invoker);
      setPresent((current) => !current);
    },
    close: () => {
      spy.close();
      setPresent(false);
    },
  };
  usePublishTasksDock(dock);
  return (
    <section aria-label="Tasks panel">
      <TasksDockSlot />
    </section>
  );
}

function dockSpy(): DockSpy {
  return {
    open: vi.fn(),
    toggle: vi.fn(),
    close: vi.fn(),
    onCollapse: vi.fn(),
    onClose: vi.fn(),
  };
}

function Probe({ onHost }: { readonly onHost: (host: ReturnType<typeof useTasksHost>) => void }): null {
  onHost(useTasksHost());
  return null;
}

/**
 * The workbench: a thread's workspace with its Tasks panel, or a page
 * without a thread (Home, Archived, Usage), which has no Tasks at all.
 */
function Page({ spy }: { readonly spy: DockSpy }): React.JSX.Element {
  const route = useRoute();
  return route.name === "thread" ? (
    <Workspace spy={spy} />
  ) : (
    <p>{route.name} page</p>
  );
}

/** The workbench bar's Tasks toggle on phones, as the panel layout renders it. */
function PhoneToggle(): React.JSX.Element {
  const host = useTasksHost();
  return (
    <TasksPanelToggle
      open={host?.sheetOpen ?? false}
      onToggle={() => host?.toggleSheet()}
    />
  );
}

function renderHost({
  thread = false,
  active = true,
  spy = dockSpy(),
  extra,
}: {
  readonly thread?: boolean;
  readonly active?: boolean;
  readonly spy?: DockSpy;
  /** More workbench content, such as a transcript task card. */
  readonly extra?: ReactNode;
} = {}) {
  if (thread) act(() => navigate(threadPath("thread-1")));
  let host: ReturnType<typeof useTasksHost>;
  const content = (isActive: boolean) => (
    <TasksPanel store={makeStore()} panelLayoutStore={panelLayoutStore} active={isActive}>
      <Probe onHost={(value) => (host = value)} />
      <Page spy={spy} />
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

const toggle = () => screen.getByTestId("tasks-panel-toggle");
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

        expect(host()?.placement).toBeUndefined();
        expect(tasksSurface()).toBeNull();
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(document.querySelector(".tasks-content")).toBeNull();
      },
    );
  });
});

describe("Tasks host from one thread to the next", () => {
  it("keeps the docked body and an unsaved edit on stage", async () => {
    const user = userEvent.setup();
    const { spy } = renderHost({ thread: true });
    const body = document.querySelector(".tasks-content");
    await editNotes(user);

    act(() => navigate(threadPath("thread-2")));

    expect(tasksSurface()).toHaveAttribute("data-presentation", "panel");
    expect(document.querySelector(".tasks-content")).toBe(body);
    await expectEditorOnTop();
    expect(within(editor()!).getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved notes");
    expect(spy.open).not.toHaveBeenCalled();
  });

  it("closes the phone sheet but keeps the body and an unsaved edit for the next sheet", async () => {
    phone = true;
    const user = userEvent.setup();
    const { host } = renderHost({ thread: true });
    act(() => host()?.toggleSheet());
    const body = document.querySelector(".tasks-content");
    await editNotes(user);

    act(() => navigate(threadPath("thread-2")));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByRole("dialog", { name: "Tasks" })).toBeNull();
    expect(editor()).toBeNull();

    act(() => host()?.toggleSheet());
    expect(tasksSurface()).toHaveAttribute("data-presentation", "sheet");
    expect(document.querySelector(".tasks-content")).toBe(body);
    await expectEditorOnTop();
    expect(within(editor()!).getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved notes");
  });
});

describe("Tasks host in a thread workspace", () => {
  it("docks the retained body in the panel with the panel's own controls", () => {
    const { spy, host } = renderHost({ thread: true });
    const panel = screen.getByRole("region", { name: "Tasks panel" });
    const surface = within(panel).getByRole("region", { name: "Tasks" });
    expect(host()?.placement).toBe("panel");
    expect(surface).toHaveAttribute("data-presentation", "panel");
    // One header: the content's panel chrome, with collapse, dock and close.
    expect(surface.querySelectorAll("header")).toHaveLength(1);
    const header = surface.querySelector<HTMLElement>(".workspace-panel-chrome");
    expect(header).not.toBeNull();
    // Like the other panel headers, it carries the thread environment's tint.
    expect(header).toHaveAttribute("data-environment-tint", "true");
    expect(header!.style.getPropertyValue("--environment-hue")).toBe("210");
    fireEvent.click(within(surface).getByRole("button", { name: "Collapse Tasks panel" }));
    expect(spy.onCollapse).toHaveBeenCalledTimes(1);
    expect(within(surface).getByRole("button", { name: "Tasks panel actions" })).toBeInTheDocument();
    fireEvent.click(within(surface).getByRole("button", { name: "Close Tasks panel" }));
    expect(spy.onClose).toHaveBeenCalledTimes(1);
    expect(tasksSurface()).toBeNull();
  });

  it("opens the sheet on phones even where a panel is docked", () => {
    phone = true;
    const { host } = renderHost({ thread: true });
    expect(host()?.placement).toBeUndefined();
    act(() => host()?.toggleSheet());
    expect(
      within(screen.getByRole("dialog", { name: "Tasks" })).getByRole("region", {
        name: "Tasks",
      }),
    ).toHaveAttribute("data-presentation", "sheet");
    // The modal sheet hides the workbench (and so its name) from the
    // accessibility tree; the docked slot stays empty.
    const workbench = document.querySelector<HTMLElement>('section[aria-label="Tasks panel"]')!;
    expect(workbench).toHaveAttribute("aria-hidden", "true");
    expect(within(workbench).queryByRole("region", { name: "Tasks", hidden: true })).toBeNull();
  });

  it("closes the phone sheet with Escape", async () => {
    phone = true;
    const user = userEvent.setup();
    renderHost({ thread: true, extra: <PhoneToggle /> });
    await user.click(toggle());
    const sheet = screen.getByRole("dialog", { name: "Tasks" });
    expect(sheet).toHaveClass("tasks-sheet");
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Tasks" })).toBeNull();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("suspends the phone sheet under Settings, keeps the same body and leaves focus", async () => {
    phone = true;
    const user = userEvent.setup();
    const view = renderHost({ thread: true, extra: <PhoneToggle /> });
    await user.click(toggle());
    const body = document.querySelector(".tasks-content");
    expect(body).toBeInTheDocument();
    view.setActive(false);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(tasksSurface()).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Tasks" })).toBeNull();
    expect(body).toBeInTheDocument();
    // Closing must not pull focus back to the hidden workspace's toggle.
    expect(toggle()).not.toHaveFocus();
    view.setActive(true);
    expect(document.querySelector(".tasks-content")).toBe(body);
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
          return query === "(max-width: 819px)" ? phone : false;
        },
        media: query,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          if (query === "(max-width: 819px)") listeners.add(listener);
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

  it("closes the sheet with nothing unsaved in it, and leaves the dock as it was", () => {
    phone = true;
    const setPhone = stubBreakpoint();
    const { spy, host } = renderHost({ thread: true });
    act(() => host()?.toggleSheet());
    expect(tasksSurface()).toHaveAttribute("data-presentation", "sheet");

    setPhone(false);
    expect(document.querySelector(".tasks-sheet")).toBeNull();
    expect(tasksSurface()).toHaveAttribute("data-presentation", "panel");
    expect(spy.open).not.toHaveBeenCalled();

    // Docked Tasks has no place on a phone until the sheet is opened.
    setPhone(true);
    expect(tasksSurface()).toBeNull();
    expect(host()?.sheetOpen).toBe(false);
  });

  it("keeps an edit open from the docked panel to the phone sheet, and back", async () => {
    const setPhone = stubBreakpoint();
    const user = userEvent.setup();
    act(() => navigate(threadPath("thread-1")));
    const { spy } = renderHost({ thread: true });
    await editNotes(user);

    setPhone(true);
    // The sheet mounts over the editor, which opens again on top of it.
    expect(document.querySelector(".tasks-sheet")).toBeInTheDocument();
    await expectEditorOnTop();
    expect(within(editor()!).getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved notes");

    setPhone(false);
    expect(surfaceElement()).toHaveAttribute("data-presentation", "panel");
    expect(within(editor()!).getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved notes");
    // The dock was still on stage, so nothing had to reopen it.
    expect(spy.open).not.toHaveBeenCalled();
  });

  it("opens the dock for an edit from the phone sheet when Tasks is not docked", async () => {
    const setPhone = stubBreakpoint();
    const user = userEvent.setup();
    act(() => navigate(threadPath("thread-1")));
    const { spy, host } = renderHost({ thread: true });
    // Tasks is not on the desktop stage: its panel was closed.
    fireEvent.click(screen.getByRole("button", { name: "Close Tasks panel" }));
    expect(tasksSurface()).toBeNull();
    setPhone(true);
    act(() => host()?.toggleSheet());
    await editNotes(user);

    setPhone(false);

    expect(spy.open).toHaveBeenCalledWith({ focus: false });
    expect(surfaceElement()).toHaveAttribute("data-presentation", "panel");
    expect(within(editor()!).getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved notes");
  });

  it.each(confirmations)(
    "keeps $title on top of the editor from the docked panel to the phone sheet, and back",
    async ({ title, opener, back }) => {
      const setPhone = stubBreakpoint();
      const user = userEvent.setup();
      renderHost({ thread: true });
      await editNotes(user);
      await user.click(within(editor()!).getByRole("button", { name: opener }));
      await expectOnTop(title);

      setPhone(true);
      expect(document.querySelector(".tasks-sheet")).toBeInTheDocument();
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

  it.each(confirmations)(
    "keeps $title on top of the editor from the phone sheet to the docked panel",
    async ({ title, opener }) => {
      phone = true;
      const setPhone = stubBreakpoint();
      const user = userEvent.setup();
      const { host } = renderHost({ thread: true });
      act(() => host()?.toggleSheet());
      await editNotes(user);
      await user.click(within(editor()!).getByRole("button", { name: opener }));

      setPhone(false);

      expect(surfaceElement()).toHaveAttribute("data-presentation", "panel");
      await expectOnTop(title);
    },
  );

  it("reopens the editor, then its confirmation, once both have finished closing", async () => {
    simulateExitMotion();
    const setPhone = stubBreakpoint();
    const user = userEvent.setup();
    renderHost({ thread: true });
    await editNotes(user);
    await user.click(within(editor()!).getByRole("button", { name: "Delete…" }));

    setPhone(true);

    // Both animate out under the sheet. The editor's motion may end first;
    // a confirmation still closing would be hidden by an editor mounted
    // again over it, so the editor waits.
    const closing = [
      ...document.querySelectorAll('[data-slot="dialog-content"][data-state="closed"]'),
    ];
    expect(
      closing.map((dialog) => dialog.querySelector('[data-slot="dialog-title"]')?.textContent),
    ).toEqual(["Edit task", "Delete task?"]);
    finishExitMotion(closing[0]!);
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

  it("opens the sheet on phones", () => {
    phone = true;
    renderHost({ thread: true });
    act(() => revealTask("task-1"));
    const sheet = screen.getByRole("dialog", { name: "Tasks" });
    // The content, not the host, takes the request: it shows the task's
    // detail.
    expect(getPendingReveal()).toBeUndefined();
    expect(
      within(sheet).getByRole("heading", { name: "Audit error states" }),
    ).toBeInTheDocument();
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

  it("toggles the sheet on phones in a thread, from inside it too", () => {
    phone = true;
    renderHost({ thread: true });
    press();
    const sheet = screen.getByRole("dialog", { name: "Tasks" });
    expect(within(sheet).getByRole("region", { name: "Tasks" })).toHaveAttribute(
      "data-presentation",
      "sheet",
    );
    press(within(sheet).getByRole("region", { name: "Tasks" }));
    expect(screen.queryByRole("dialog", { name: "Tasks" })).toBeNull();
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
