// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import type { PanelLayoutStore } from "../../workspace-panels/panel-state.js";
import { navigate, threadPath } from "../../app/router.js";
import {
  TASKS_PANEL_STORAGE_KEY,
  consumeReveal,
  getPendingReveal,
  revealTask,
} from "../../app/tasks-panel-store.js";
import { TasksPanel } from "./TasksPanel.js";
import {
  TasksCornerControls,
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
      ],
      workspaces: [
        { id: "workspace-1", label: { text: "acme-web" }, displayPath: { text: "/acme" } },
      ],
      environments: [],
      tasks: [
        {
          id: "task-1",
          scope: { kind: "thread", threadId: "thread-1" },
          associatedWorkspaceId: "workspace-1",
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

function renderHost({
  thread = false,
  active = true,
  spy = dockSpy(),
}: { readonly thread?: boolean; readonly active?: boolean; readonly spy?: DockSpy } = {}) {
  if (thread) act(() => navigate(threadPath("thread-1")));
  let host: ReturnType<typeof useTasksHost>;
  const content = (isActive: boolean) => (
    <TasksPanel store={makeStore()} panelLayoutStore={panelLayoutStore} active={isActive}>
      <Probe onHost={(value) => (host = value)} />
      {thread ? <Workspace spy={spy} /> : <TasksCornerControls />}
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

describe("Tasks host on pages without panels", () => {
  it("opens a popover from the corner toggle and closes it again", async () => {
    const user = userEvent.setup();
    const { host } = renderHost();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(tasksSurface()).toBeNull();

    await user.click(toggle());
    const surface = tasksSurface()!;
    expect(surface).toHaveAttribute("data-presentation", "popover");
    expect(surface).toHaveAttribute("id", "tasks-panel");
    expect(host()?.placement).toBe("popover");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(toggle()).toHaveAttribute("aria-controls", "tasks-panel");
    expect(surface.closest('[data-slot="popover-content"]')).not.toBeNull();
    // No floating card, no pin.
    expect(document.querySelector(".tasks-panel")).toBeNull();
    expect(screen.queryByRole("button", { name: /Pin Tasks panel/ })).toBeNull();

    // Pressing the toggle closes it (its press is not an outside dismissal
    // that the click would immediately reopen).
    await user.click(toggle());
    expect(tasksSurface()).toBeNull();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the popover from its close button and on an outside press", async () => {
    const user = userEvent.setup();
    const outside = document.createElement("button");
    document.body.append(outside);
    renderHost();
    await user.click(toggle());
    await user.click(
      within(tasksSurface()!).getByRole("button", { name: "Close Tasks panel" }),
    );
    expect(tasksSurface()).toBeNull();
    expect(toggle()).toHaveFocus();

    await user.click(toggle());
    await user.click(outside);
    expect(tasksSurface()).toBeNull();
    outside.remove();
  });

  it("closes the popover when the page changes", async () => {
    const user = userEvent.setup();
    renderHost();
    await user.click(toggle());
    expect(tasksSurface()).not.toBeNull();
    act(() => navigate("/archived"));
    expect(tasksSurface()).toBeNull();
  });

  it("uses a bottom sheet on phones", async () => {
    phone = true;
    const user = userEvent.setup();
    renderHost();
    await user.click(toggle());
    const sheet = screen.getByRole("dialog", { name: "Tasks" });
    expect(sheet).toHaveClass("tasks-sheet");
    expect(within(sheet).getByRole("region", { name: "Tasks" })).toHaveAttribute(
      "data-presentation",
      "sheet",
    );
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Tasks" })).toBeNull();
  });

  it("suspends the popover under Settings and keeps the same body", async () => {
    const user = userEvent.setup();
    const view = renderHost();
    await user.click(toggle());
    const body = document.querySelector(".tasks-panel-body");
    view.setActive(false);
    expect(tasksSurface()).toBeNull();
    expect(body).toBeInTheDocument();
    view.setActive(true);
    expect(document.querySelector(".tasks-panel-body")).toBe(body);
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
    expect(surface.querySelector(".workspace-panel-chrome")).not.toBeNull();
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
    act(() => host()?.toggleOverlay());
    expect(
      within(screen.getByRole("dialog", { name: "Tasks" })).getByRole("region", {
        name: "Tasks",
      }),
    ).toHaveAttribute("data-presentation", "sheet");
    expect(
      // The modal sheet hides the workbench from the accessibility tree.
      within(screen.getByRole("region", { name: "Tasks panel", hidden: true })).queryByRole(
        "region",
        { name: "Tasks", hidden: true },
      ),
    ).toBeNull();
  });
});

describe("revealTask", () => {
  it("opens the popover on pages without panels", () => {
    renderHost();
    act(() => revealTask("task-1"));
    expect(tasksSurface()).toHaveAttribute("data-presentation", "popover");
    // The content, not the host, consumes the request.
    expect(getPendingReveal()).toMatchObject({ taskId: "task-1" });
  });

  it("opens the docked panel without moving focus in a thread workspace", () => {
    const { spy } = renderHost({ thread: true });
    act(() => revealTask("task-1"));
    expect(spy.open).toHaveBeenCalledWith({ focus: false });
  });

  it("opens the sheet on phones", () => {
    phone = true;
    renderHost({ thread: true });
    act(() => revealTask("task-1"));
    expect(screen.getByRole("dialog", { name: "Tasks" })).toBeInTheDocument();
  });
});

describe("toggle Tasks shortcut", () => {
  const press = (target: Element = document.body, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(target, { key: "L", ctrlKey: true, shiftKey: true, ...init });

  it("toggles the popover on pages without panels", () => {
    renderHost();
    press();
    expect(tasksSurface()).toHaveAttribute("data-presentation", "popover");
    press(tasksSurface()!);
    expect(tasksSurface()).toBeNull();
    press(document.body, { metaKey: true, ctrlKey: false, key: "l" });
    expect(tasksSurface()).not.toBeNull();
  });

  it("toggles the docked panel in a thread workspace", () => {
    const { spy } = renderHost({ thread: true });
    press();
    expect(spy.toggle).toHaveBeenCalledTimes(1);
    expect(tasksSurface()).toBeNull();
    press();
    expect(spy.toggle).toHaveBeenCalledTimes(2);
    expect(tasksSurface()).not.toBeNull();
  });

  it("leaves other dialogs, repeats, plain keys and Settings alone", () => {
    const view = renderHost();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const field = document.createElement("input");
    dialog.append(field);
    document.body.append(dialog);
    press(field);
    press(document.body, { repeat: true });
    press(document.body, { shiftKey: false });
    expect(tasksSurface()).toBeNull();
    view.setActive(false);
    press();
    expect(tasksSurface()).toBeNull();
    dialog.remove();
  });
});
