// @vitest-environment jsdom

import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TasksDock, TasksHost } from "../components/tasks/tasks-host.js";
import { tasksTenant } from "../tasks/tasks-tenant.js";
import type { PanelChromeControls } from "./PanelChrome.js";
import {
  TERMINAL_ID,
  applicationStore,
  draftTenant,
  filesTenant,
  harness,
  initialThreadState,
  installPanelLayoutHarness,
  layoutElement,
  makeThreadTask,
  measureStage,
  noStorage,
  openPanelActions,
  openPanelsMenu,
  publishApplicationState,
  publishThreadState,
  setMobile,
  setup,
  terminalResource,
  workpadsTenant,
} from "./panel-layout.fixtures.js";
import { PanelRegionStore } from "./region-store.js";
import {
  WorkspacePanelTenantRegistry,
  type WorkspacePanelTenant,
} from "./registry.js";

vi.mock("../terminals/TerminalPanel.js", async () => ({
  TerminalPanel: (await import("./panel-layout.terminal-fixture.js"))
    .TerminalPanelFixture,
}));

installPanelLayoutHarness();

const bar = () => within(screen.getByTestId("workspace-workbench-bar"));
const quickButton = (kind: string) => bar().getByTestId(`${kind}-panel-toggle`);
const quickButtons = () =>
  within(bar().getByRole("group", { name: "Loaded panels" }))
    .queryAllByRole("button")
    .map((button) => [
      button.dataset.testid?.replace("-panel-toggle", ""),
      button.dataset.state,
    ]);
/** The panel's section on stage, or null while it is not on stage. */
const panel = (title: string) => screen.queryByRole("region", { name: `${title} panel` });
const regionOf = (title: string) => panel(title)?.getAttribute("data-region");
const stageKinds = () =>
  [...document.querySelectorAll<HTMLElement>(".workspace-panel-stage [data-panel-kind]")]
    .map((section) => section.dataset.panelKind);
const regionBox = (region: string) =>
  document.querySelector<HTMLElement>(`.workspace-region[data-region="${region}"]`)!.style;
const statusText = () => screen.getByRole("status").textContent;
/** A button in a panel's header, apart from the bar's quick buttons. */
const headerButton = (title: string, name: string) =>
  within(screen.getByRole("banner", { name: `${title} panel header` })).getByRole("button", {
    name,
  });

describe("PanelLayout regions", () => {
  it("opens a panel in its place, replacing only what its region shows", async () => {
    const mountedWorkpads = vi.fn();
    const unmountedWorkpads = vi.fn();
    const store = setup({
      extraTenants: [
        tasksTenant,
        workpadsTenant({ mounted: mountedWorkpads, unmounted: unmountedWorkpads }),
      ],
    });
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: false });
      store.open("workpads", { focus: false });
    });
    const draft = await screen.findByRole("textbox", { name: "Workpad draft" });
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    expect(regionOf("Chat")).toBe("middle");
    expect(regionOf("Workpads")).toBe("right");
    expect(regionOf("Terminals")).toBe("bottom");

    act(() => store.open("tasks", { focus: false }));

    // Tasks takes the Right from Workpads; Chat and the Bottom stay put.
    expect(regionOf("Tasks")).toBe("right");
    expect(panel("Workpads")).toBeNull();
    expect(regionOf("Chat")).toBe("middle");
    expect(regionOf("Terminals")).toBe("bottom");
    expect(stageKinds().sort()).toEqual(["chat", "tasks", "terminals"]);
    // Workpads is hidden, not closed: its quick button stays, outlined.
    expect(quickButtons()).toEqual([
      ["chat", "visible"],
      ["workpads", "hidden"],
      ["tasks", "visible"],
      ["terminals", "visible"],
    ]);
    expect(quickButton("workpads")).toHaveAccessibleName("Show Workpads panel");

    fireEvent.click(quickButton("workpads"));
    expect(regionOf("Workpads")).toBe("right");
    expect(panel("Tasks")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Workpad draft" })).toBe(draft);
    expect(draft).toHaveValue("Keep this draft");
    expect(mountedWorkpads).toHaveBeenCalledOnce();
    expect(unmountedWorkpads).not.toHaveBeenCalled();
  });

  it("hides a panel with its quick button and shows it again in its region", async () => {
    const store = setup();
    act(() => store.open("files", { focus: false }));
    const draft = await screen.findByRole("textbox", { name: "File draft" });
    fireEvent.change(draft, { target: { value: "unsaved" } });
    expect(quickButton("files")).toHaveAttribute("data-state", "visible");
    expect(quickButton("files")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(quickButton("files"));
    expect(panel("Files")).toBeNull();
    expect(store.isLoaded("files")).toBe(true);
    expect(screen.getByTestId("files-visible")).toHaveTextContent("false");
    expect(quickButton("files")).toHaveAttribute("data-state", "hidden");
    expect(quickButton("files")).toHaveAccessibleName("Show Files panel");
    // Hiding never asks about unsaved changes: nothing is lost.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(statusText()).toBe("Files panel hidden.");

    fireEvent.click(quickButton("files"));
    expect(regionOf("Files")).toBe("right");
    expect(screen.getByRole("textbox", { name: "File draft" })).toBe(draft);
    expect(draft).toHaveValue("unsaved");
    await waitFor(() => expect(draft).toHaveFocus());
  });

  it("closes and unloads a panel with ✕, asking first about unsaved changes", async () => {
    const unmountedFiles = vi.fn();
    const store = setup({ unmountedFiles });
    act(() => store.open("files", { focus: false }));
    fireEvent.change(await screen.findByRole("textbox", { name: "File draft" }), {
      target: { value: "unsaved" },
    });
    await waitFor(() => expect(store.hasDirtyWorkspacePanels("workspace-1")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Close Files panel" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    expect(dialog).toHaveTextContent("Closing Files will discard its unsaved changes.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(store.isLoaded("files")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close Files panel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and close" }));
    expect(store.isLoaded("files")).toBe(false);
    expect(unmountedFiles).toHaveBeenCalledOnce();
    expect(bar().queryByTestId("files-panel-toggle")).toBeNull();
    expect(statusText()).toBe("Files panel closed.");
    await waitFor(() => expect(store.hasDirtyWorkspacePanels("workspace-1")).toBe(false));
    // Nothing takes the closed panel's region.
    expect(stageKinds()).toEqual(["chat"]);
  });

  it("hides Chat with its ✕ and keeps it loaded", async () => {
    const unmountedChat = vi.fn();
    const store = setup({ unmountedChat });
    const draft = screen.getByRole("textbox", { name: "Chat draft" });
    fireEvent.change(draft, { target: { value: "draft message" } });

    fireEvent.click(headerButton("Chat", "Hide Chat panel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.isLoaded("chat")).toBe(true);
    expect(screen.getByTestId("chat-visible")).toHaveTextContent("false");
    expect(screen.getByTestId("workspace-panel-empty")).toHaveTextContent(
      "No panels are shown",
    );
    expect(statusText()).toBe("Chat panel hidden.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Panels" })).toHaveFocus());

    fireEvent.click(quickButton("chat"));
    expect(regionOf("Chat")).toBe("middle");
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBe(draft);
    expect(draft).toHaveValue("draft message");
    expect(unmountedChat).not.toHaveBeenCalled();
  });

  it("moves a panel with Move to, for every thread, and reopens it there", async () => {
    const store = setup();
    act(() => store.open("files", { focus: false }));
    await openPanelActions("Files");
    const moveTo = screen.getByRole("group", { name: "Move to" });
    expect(
      within(moveTo)
        .getAllByRole("menuitemradio")
        .filter((item) => item.getAttribute("aria-checked") === "true")
        .map((item) => item.textContent),
    ).toEqual(["Right"]);
    fireEvent.click(within(moveTo).getByRole("menuitemradio", { name: "Left" }));

    expect(regionOf("Files")).toBe("left");
    expect(statusText()).toBe("Files panel moved to the left.");
    expect(store.forThread("thread-2").placementOf("files")).toBe("left");

    fireEvent.click(screen.getByRole("button", { name: "Close Files panel" }));
    act(() => store.open("files", { focus: false }));
    expect(regionOf("Files")).toBe("left");
  });

  it("maximizes a panel until Restore, Escape or another panel opens", async () => {
    const store = setup({ extraTenants: [workpadsTenant()] });
    act(() => store.open("files", { focus: false }));
    await screen.findByRole("textbox", { name: "File draft" });
    const chatDraft = screen.getByRole("textbox", { name: "Chat draft" });

    fireEvent.click(screen.getByRole("button", { name: "Maximize Files panel" }));
    expect(stageKinds()).toEqual(["files"]);
    expect(regionBox("right")).toMatchObject({ left: "0%", width: "100%", height: "100%" });
    expect(screen.getByTestId("chat-visible")).toHaveTextContent("false");
    expect(quickButton("chat")).toHaveAttribute("data-state", "hidden");
    expect(chatDraft.closest(".workspace-panel-parking")).not.toBeNull();
    const restore = screen.getByRole("button", { name: "Restore Files panel" });

    // Escape belongs to the field being edited.
    const fileDraft = screen.getByRole("textbox", { name: "File draft" });
    fireEvent.keyDown(fileDraft, { key: "Escape" });
    expect(store.maximized()).toBe("files");

    restore.focus();
    fireEvent.keyDown(restore, { key: "Escape" });
    expect(store.maximized()).toBeNull();
    expect(stageKinds().sort()).toEqual(["chat", "files"]);
    expect(statusText()).toBe("Panel layout restored.");

    fireEvent.click(screen.getByRole("button", { name: "Maximize Files panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore Files panel" }));
    expect(store.maximized()).toBeNull();

    // Opening another panel ends Maximize too.
    fireEvent.click(headerButton("Chat", "Maximize Chat panel"));
    expect(stageKinds()).toEqual(["chat"]);
    act(() => store.open("workpads", { focus: false }));
    expect(store.maximized()).toBeNull();
    expect(stageKinds().sort()).toEqual(["chat", "workpads"]);
  });

  it("leaves Escape to an open dialog while maximized", async () => {
    const store = setup();
    act(() => store.open("files", { focus: false }));
    fireEvent.change(await screen.findByRole("textbox", { name: "File draft" }), {
      target: { value: "unsaved" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Maximize Files panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Files panel" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Keep editing" }), {
      key: "Escape",
    });
    expect(store.maximized()).toBe("files");
  });

  it("extends an edge region across its corners with Full width", async () => {
    const store = setup();
    act(() => {
      store.open("files", { focus: false });
      store.openTerminalTab(TERMINAL_ID, { focus: false });
    });
    // Sides run full height; the Bottom spans the Middle (1200 - 400 - 5).
    expect(regionBox("bottom").width).toBe(`${(795 / 1200) * 100}%`);
    expect(regionBox("right").height).toBe("100%");

    await openPanelActions("Terminals");
    const fullWidth = screen.getByRole("menuitemcheckbox", { name: "Full width" });
    expect(fullWidth).toHaveAttribute("aria-checked", "false");
    fireEvent.click(fullWidth);

    expect(store.isExtended("bottom")).toBe(true);
    expect(store.isExtended("right")).toBe(false);
    expect(regionBox("bottom").width).toBe("100%");
    // The Right now sits above the Bottom (800 - 240 - 5).
    expect(regionBox("right").height).toBe(`${(555 / 800) * 100}%`);

    await openPanelActions("Files");
    const fullHeight = screen.getByRole("menuitemcheckbox", { name: "Full height" });
    expect(fullHeight).toHaveAttribute("aria-checked", "false");
    fireEvent.click(fullHeight);
    // The most recent wins the shared corner.
    expect(store.isExtended("right")).toBe(true);
    expect(store.isExtended("bottom")).toBe(false);
    expect(regionBox("right").height).toBe("100%");
  });

  it("resizes a region with its divider and keeps a release in place", () => {
    const store = setup();
    act(() => store.open("files", { focus: false }));
    const divider = screen.getByRole("separator", { name: "Resize Files panel" });
    expect(divider).toHaveAttribute("aria-valuenow", "400");
    expect(divider).toHaveAttribute("aria-valuemin", "280");
    // Chat keeps its 360px: 1200 - 5 - 360.
    expect(divider).toHaveAttribute("aria-valuemax", "835");

    // A Right divider grows its panel moving left.
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(store.getSnapshot().view.layout.sizes.files?.width).toBeCloseTo(416 / 1200);
    expect(regionBox("right").width).toBe(`${(416 / 1200) * 100}%`);

    // Pressing and releasing in place remembers nothing new.
    const sizes = store.getSnapshot().view.layout.sizes;
    Object.assign(HTMLElement.prototype, { hasPointerCapture: vi.fn(() => true) });
    fireEvent.pointerDown(divider, { button: 0, isPrimary: true, pointerId: 1, clientX: 784 });
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 784 });
    expect(store.getSnapshot().view.layout.sizes).toBe(sizes);
  });

  it("keeps docked Tasks on stage when Chat hides", () => {
    const store = setup({ extraTenants: [tasksTenant] });
    act(() => store.open("tasks", { focus: false }));
    fireEvent.click(headerButton("Chat", "Hide Chat panel"));
    // Tasks, alone, fills the stage.
    expect(stageKinds()).toEqual(["tasks"]);
    expect(regionBox("right")).toMatchObject({ width: "100%", height: "100%" });
    expect(store.isVisible("tasks")).toBe(true);
    expect(screen.queryByTestId("workspace-panel-empty")).toBeNull();
  });

  it("parks loaded panels without remounting them while the workbench is inactive", async () => {
    const mountedChat = vi.fn();
    const unmountedChat = vi.fn();
    const mountedFiles = vi.fn();
    const unmountedFiles = vi.fn();
    const store = setup({ mountedChat, unmountedChat, mountedFiles, unmountedFiles });
    const chatDraft = screen.getByRole("textbox", { name: "Chat draft" });
    fireEvent.change(chatDraft, { target: { value: "Retained chat draft" } });
    act(() => store.open("files", { focus: false }));
    const fileDraft = await screen.findByRole("textbox", { name: "File draft" });
    fireEvent.change(fileDraft, { target: { value: "Unsaved file" } });
    act(() => store.setActive(false));
    expect(screen.getByTestId("chat-visible")).toHaveTextContent("false");
    expect(screen.getByTestId("files-visible")).toHaveTextContent("false");
    act(() => store.setActive(true));
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBe(chatDraft);
    expect(screen.getByRole("textbox", { name: "File draft" })).toBe(fileDraft);
    expect(chatDraft).toHaveValue("Retained chat draft");
    expect(fileDraft).toHaveValue("Unsaved file");
    expect(mountedChat).toHaveBeenCalledOnce();
    expect(mountedFiles).toHaveBeenCalledOnce();
    expect(unmountedChat).not.toHaveBeenCalled();
    expect(unmountedFiles).not.toHaveBeenCalled();
  });

  it("colors the Files header with its workspace environment", () => {
    const store = setup();
    act(() => store.open("files", { focus: false }));
    const header = screen.getByRole("banner", { name: "Files panel header" });
    expect(header).toHaveAttribute("data-environment-tint", "true");
    expect(header.style.getPropertyValue("--environment-hue")).not.toBe("");
    expect(header.style.getPropertyValue("--environment-chroma")).not.toBe("");
  });
});

describe("PanelLayout make-room", () => {
  it("hides the least recently used edge region on a narrow stage and announces it", () => {
    harness.stage = { width: 900, height: 800 };
    const store = setup({ extraTenants: [workpadsTenant()] });
    act(() => store.open("files", { focus: false }));
    // Chat 360 + Files 280 fit.
    expect(stageKinds().sort()).toEqual(["chat", "files"]);

    // With Workpads on the Left too, 280 + 5 + 280 + 5 + 360 does not fit.
    act(() => store.open("workpads", { region: "left", focus: false }));
    expect(stageKinds().sort()).toEqual(["chat", "workpads"]);
    expect(store.isHiddenByMakeRoom("files")).toBe(true);
    expect(quickButton("files")).toHaveAttribute("data-state", "hidden");
    expect(statusText()).toBe("Files hidden to make room.");

    // Hidden for room is derived: a wider stage brings Files back.
    act(() => measureStage(1_200));
    expect(stageKinds().sort()).toEqual(["chat", "files", "workpads"]);
    expect(statusText()).toBe("Files shown again.");
  });

  it("never hides Chat to make room", () => {
    harness.stage = { width: 700, height: 800 };
    const store = setup({ extraTenants: [workpadsTenant()] });
    act(() => {
      store.open("files", { focus: false });
      store.open("workpads", { region: "left", focus: false });
    });
    expect(stageKinds()).toContain("chat");
    expect(store.isHiddenByMakeRoom("chat")).toBe(false);
  });

  it("counts using the retained Tasks body as using its panel", () => {
    harness.applicationState = {
      ...harness.applicationState,
      snapshot: {
        threads: [{ id: "thread-1", workspaceId: "workspace-1", title: { text: "Thread" }, inventoryState: "active" }],
        workspaces: [{ id: "workspace-1", label: { text: "Workspace" }, displayPath: { text: "/workspace" } }],
        environments: [],
        tasks: [makeThreadTask({ id: "open-1" })],
      },
    };
    harness.stage = { width: 1_300, height: 800 };
    const store = setup({ extraTenants: [tasksTenant, workpadsTenant()], withTasksPanel: true });
    act(() => {
      store.open("tasks", { region: "left", focus: false });
      store.open("files", { focus: false });
    });
    // Tasks 300 + Chat 360 + Files 280 fit.
    expect(stageKinds().sort()).toEqual(["chat", "files", "tasks"]);

    // The Tasks body is portaled in from the Tasks host, outside the
    // layout's React tree; pressing in it still uses Tasks.
    fireEvent.pointerDown(
      within(panel("Tasks")!).getByRole("textbox", { name: "Add a task" }),
    );
    act(() => store.open("workpads", { region: "top", focus: false }));
    // 300 + 5 + 280 + 5 + 360 does not fit.
    act(() => measureStage(900));

    // Files, used least recently, makes room; Tasks stays.
    expect(store.isHiddenByMakeRoom("files")).toBe(true);
    expect(store.isVisible("tasks")).toBe(true);
  });
});

describe("PanelLayout workbench bar", () => {
  it("shows a quick button per loaded panel, in the fixed order", () => {
    const store = setup({ extraTenants: [tasksTenant, workpadsTenant()] });
    expect(quickButtons()).toEqual([["chat", "visible"]]);
    expect(quickButton("chat")).toHaveAccessibleName("Hide Chat panel");
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: false });
      store.open("tasks", { focus: false });
      store.open("workpads", { focus: false });
      store.open("files", { focus: false });
    });
    expect(quickButtons()).toEqual([
      ["chat", "visible"],
      ["files", "visible"],
      ["workpads", "hidden"],
      ["tasks", "hidden"],
      ["terminals", "visible"],
    ]);
    // The old per-panel shortcut icons and always-shown toggles are gone.
    expect(screen.queryByRole("group", { name: "Panel shortcuts" })).toBeNull();
    act(() => {
      store.close("tasks");
      store.close("workpads");
    });
    expect(quickButtons().map(([kind]) => kind)).toEqual(["chat", "files", "terminals"]);
  });

  it.each([
    [0, undefined, "Hide Workpads panel"],
    [1, "1", "Hide Workpads panel, 1 workpad in this thread"],
    [99, "99", "Hide Workpads panel, 99 workpads in this thread"],
    [100, "99+", "Hide Workpads panel, 100 workpads in this thread"],
  ])("badges %s thread workpads on the loaded Workpads quick button", (count, shown, label) => {
    harness.applicationState = {
      ...harness.applicationState,
      authoritative: true,
      snapshot: {
        tasks: [],
        threads: [
          { id: "thread-1", nonArchivedWorkpadCount: count },
          { id: "thread-2", nonArchivedWorkpadCount: 8 },
        ],
      },
    };
    const store = setup({ extraTenants: [workpadsTenant()] });
    // No quick button, so no badge, until Workpads is loaded.
    expect(bar().queryByTestId("workpads-panel-toggle")).toBeNull();
    act(() => store.open("workpads", { focus: false }));
    const toggle = quickButton("workpads");
    expect(toggle).toHaveAccessibleName(label);
    const badge = toggle.querySelector('[data-slot="count-badge"]');
    if (shown === undefined) expect(badge).toBeNull();
    else expect(badge).toHaveTextContent(shown);
    expect(applicationStore.api.listWorkpads).not.toHaveBeenCalled();
  });

  it("follows the current thread and the authoritative summary for the Workpads count", () => {
    const store = setup({ extraTenants: [workpadsTenant()] });
    act(() => store.open("workpads", { focus: false }));
    const threads = [
      { id: "thread-1", nonArchivedWorkpadCount: 2 },
      { id: "thread-2", nonArchivedWorkpadCount: 3 },
    ];
    expect(quickButton("workpads")).toHaveAccessibleName("Hide Workpads panel");
    act(() => publishApplicationState({ authoritative: true, snapshot: { tasks: [], threads } }));
    expect(quickButton("workpads")).toHaveAccessibleName(
      "Hide Workpads panel, 2 workpads in this thread",
    );
    fireEvent.click(quickButton("workpads"));
    expect(quickButton("workpads")).toHaveAccessibleName(
      "Show Workpads panel, 2 workpads in this thread",
    );
    store.rerenderThread("thread-2");
    expect(quickButton("workpads")).toHaveAccessibleName(
      "Show Workpads panel, 3 workpads in this thread",
    );
    act(() => publishApplicationState({ authoritative: false }));
    expect(quickButton("workpads").querySelector('[data-slot="count-badge"]')).toBeNull();
    act(() => publishApplicationState({ authoritative: true }));
    store.setActive(false);
    expect(quickButton("workpads").querySelector('[data-slot="count-badge"]')).toBeNull();
  });

  it("badges only open tasks scoped directly to the current thread", () => {
    harness.applicationState = {
      ...harness.applicationState,
      snapshot: {
        threads: [],
        tasks: [
          makeThreadTask({ id: "open-1" }),
          makeThreadTask({ id: "open-2" }),
          makeThreadTask({ id: "completed", completed: true }),
          makeThreadTask({ id: "other-thread", threadId: "thread-2" }),
          { ...makeThreadTask({ id: "project" }), scope: { kind: "project", projectId: "project-1" } },
          { ...makeThreadTask({ id: "global" }), scope: { kind: "global" } },
        ],
      },
    };
    const store = setup({ extraTenants: [tasksTenant] });
    act(() => store.open("tasks", { focus: false }));
    const toggle = quickButton("tasks");
    expect(toggle).toHaveAccessibleName("Hide Tasks panel, 2 open tasks");
    expect(toggle.querySelector('[data-slot="count-badge"]')).toHaveTextContent("2");
    expect(toggle).toHaveAttribute("aria-controls", "tasks-panel");
  });

  it("lists every panel in ▾ with its state, and Reset layout", async () => {
    const store = setup({ extraTenants: [tasksTenant, workpadsTenant()] });
    act(() => {
      store.open("workpads", { focus: false });
      store.open("files", { focus: false });
    });
    const menu = await openPanelsMenu();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .filter((item) => item.dataset.panelRow)
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual([
      "Chat, In the middle",
      "Files, On the right",
      "Workpads, Loaded, hidden",
      "Tasks",
      "Terminals",
    ]);
    expect(within(menu).getByRole("menuitem", { name: "Reset layout" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Show all" })).toBeNull();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Workpads, Loaded, hidden" }));
    expect(regionOf("Workpads")).toBe("right");
    expect(panel("Files")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Workpad draft" })).toHaveFocus(),
    );
  });

  it("opens a panel where its row's place button says, which becomes its place", async () => {
    const store = setup({ extraTenants: [tasksTenant] });
    const menu = await openPanelsMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Choose where to open Tasks" }));
    const places = await screen.findByRole("group", { name: "Open Tasks in" });
    const items = within(places).getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      "Middle",
      "Left",
      "Right",
      "Top",
      "Bottom",
    ]);
    expect(
      items
        .filter((item) => item.getAttribute("aria-checked") === "true")
        .map((item) => item.textContent),
    ).toEqual(["Right"]);
    fireEvent.click(within(places).getByRole("menuitemradio", { name: "Left" }));

    expect(regionOf("Tasks")).toBe("left");
    expect(store.placementOf("tasks")).toBe("left");
    expect(regionOf("Chat")).toBe("middle");
  });

  it("opens Terminals in a chosen place through the terminal entry", async () => {
    const resource = terminalResource();
    Object.assign(applicationStore.api, {
      listTerminals: vi.fn().mockResolvedValue({ terminals: [resource] }),
      createTerminal: vi.fn(),
    });
    const store = setup();
    const menu = await openPanelsMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Choose where to open Terminals" }));
    fireEvent.click(
      within(await screen.findByRole("group", { name: "Open Terminals in" })).getByRole(
        "menuitemradio",
        { name: "Right" },
      ),
    );
    await waitFor(() => expect(store.terminalPanel()?.activeTerminalId).toBe(TERMINAL_ID));
    expect(store.placementOf("terminals")).toBe("right");
    expect(regionOf("Terminals")).toBe("right");
    expect(applicationStore.api.createTerminal).not.toHaveBeenCalled();
  });

  it("presents ▾ as a sheet on touch, with each row's places a step in", () => {
    harness.coarsePointer = true;
    const store = setup();
    fireEvent.click(screen.getByRole("button", { name: "Panels" }));
    const sheet = screen.getByRole("dialog", { name: "Panels" });
    fireEvent.click(within(sheet).getByRole("menuitem", { name: "Choose where to open Files" }));
    fireEvent.click(within(sheet).getByRole("menuitemradio", { name: "Bottom" }));
    expect(store.placementOf("files")).toBe("bottom");
    expect(regionOf("Files")).toBe("bottom");
  });

  it("protects unsaved changes when resetting the layout", async () => {
    const store = setup({ extraTenants: [workpadsTenant()] });
    act(() => store.open("workpads", { focus: false }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Workpad draft" }), {
      target: { value: "Unsynced draft" },
    });
    const layout = store.getSnapshot().view.layout;
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset layout" }));
    expect(
      await screen.findByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toHaveTextContent("Resetting the layout will discard unsaved changes in Workpads.");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(store.getSnapshot().view.layout).toBe(layout);
    expect(screen.getByRole("textbox", { name: "Workpad draft" })).toHaveValue("Unsynced draft");

    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset layout" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and reset" }));
    expect(store.getSnapshot().loaded).toEqual(["chat"]);
    expect(screen.queryByRole("textbox", { name: "Workpad draft" })).toBeNull();
  });

  it("resets to Chat alone in the Middle", async () => {
    const store = setup();
    act(() => {
      store.open("files", { region: "middle", focus: false });
      store.openTerminalTab(TERMINAL_ID, { focus: false });
    });
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset layout" }));
    expect(store.getSnapshot().loaded).toEqual(["chat"]);
    expect(store.placementOf("files")).toBe("right");
    expect(stageKinds()).toEqual(["chat"]);
    expect(statusText()).toBe("Panel layout reset.");
  });

  it("keeps global navigation in the workbench bar", () => {
    setup();
    const sidebar = screen.getByRole("button", { name: "Hide sidebar" });
    expect(screen.getByTestId("workspace-workbench-bar")).toContainElement(sidebar);
    expect(screen.getByRole("banner", { name: "Chat panel header" })).not.toContainElement(sidebar);
    fireEvent.click(sidebar);
    expect(harness.toggleSidebar).toHaveBeenCalledOnce();
  });
});

describe("PanelLayout Tasks", () => {
  function fakeTasksHost(overrides: Partial<TasksHost> = {}): TasksHost & {
    readonly docks: (TasksDock | undefined)[];
  } {
    const docks: (TasksDock | undefined)[] = [];
    return {
      bodyTarget: document.createElement("div"),
      placement: undefined,
      sheetOpen: false,
      toggleSheet: vi.fn(),
      publishDock: (dock) => docks.push(dock),
      docks,
      ...overrides,
    };
  }

  const withTasks = () => {
    harness.applicationState = {
      ...harness.applicationState,
      snapshot: {
        threads: [{ id: "thread-1", workspaceId: "workspace-1", title: { text: "Thread" }, inventoryState: "active" }],
        workspaces: [{ id: "workspace-1", label: { text: "Workspace" }, displayPath: { text: "/workspace" } }],
        environments: [],
        tasks: [makeThreadTask({ id: "open-1" })],
      },
    };
  };

  it("toggles Tasks with Ctrl+Shift+L: opening, hiding and showing it", () => {
    withTasks();
    const store = setup({ extraTenants: [tasksTenant], withTasksPanel: true });
    const press = () =>
      fireEvent.keyDown(document.body, { key: "L", ctrlKey: true, shiftKey: true });
    expect(press()).toBe(false);
    expect(regionOf("Tasks")).toBe("right");
    press();
    expect(store.isLoaded("tasks")).toBe(true);
    expect(panel("Tasks")).toBeNull();
    expect(quickButton("tasks")).toHaveAttribute("data-state", "hidden");
    press();
    expect(regionOf("Tasks")).toBe("right");
  });

  it("moves focus on when Ctrl+Shift+L hides the focused Tasks panel", async () => {
    withTasks();
    const store = setup({ extraTenants: [tasksTenant], withTasksPanel: true });
    act(() => store.open("tasks"));
    const add = within(panel("Tasks")!).getByRole("textbox", { name: "Add a task" });
    await waitFor(() => expect(add).toHaveFocus());
    fireEvent.keyDown(add, { key: "L", ctrlKey: true, shiftKey: true });
    expect(panel("Tasks")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Chat draft" })).toHaveFocus(),
    );
  });

  it("hosts the retained Tasks body in its region with one header and region controls", async () => {
    withTasks();
    const store = setup({ extraTenants: [tasksTenant], withTasksPanel: true });
    fireEvent.click((await openPanelsMenu()).querySelector('[data-panel-row="tasks"]')!);
    const leaf = panel("Tasks")!;
    expect(within(leaf).getByRole("region", { name: "Tasks" })).toHaveAttribute(
      "data-presentation",
      "panel",
    );
    expect(within(leaf).getByRole("button", { name: "Task open-1" })).toBeInTheDocument();
    expect(leaf.querySelectorAll("header")).toHaveLength(1);
    const body = leaf.querySelector(".tasks-content");

    await openPanelActions("Tasks");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Left" }));
    expect(regionOf("Tasks")).toBe("left");
    expect(panel("Tasks")!.querySelector(".tasks-content")).toBe(body);

    fireEvent.click(within(panel("Tasks")!).getByRole("button", { name: "Maximize Tasks panel" }));
    expect(stageKinds()).toEqual(["tasks"]);
    fireEvent.click(within(panel("Tasks")!).getByRole("button", { name: "Restore Tasks panel" }));

    // Hidden, the body stays mounted.
    fireEvent.click(quickButton("tasks"));
    expect(quickButton("tasks")).toHaveAccessibleName("Show Tasks panel, 1 open task");
    expect(body).toBeInTheDocument();
    fireEvent.click(quickButton("tasks"));
    expect(panel("Tasks")!.querySelector(".tasks-content")).toBe(body);

    fireEvent.click(within(panel("Tasks")!).getByRole("button", { name: "Close Tasks panel" }));
    expect(store.isLoaded("tasks")).toBe(false);
    expect(document.querySelector(".tasks-content")).toBeNull();
  });

  it("publishes the panel and its controls to the Tasks host", () => {
    const host = fakeTasksHost();
    const store = setup({ extraTenants: [tasksTenant], tasksHost: host });
    expect(host.docks.at(-1)).toMatchObject({ present: false, visible: false });
    act(() => store.open("tasks", { focus: false }));
    const dock = host.docks.at(-1)!;
    expect(dock).toMatchObject({
      present: true,
      visible: true,
      controls: { active: true, region: { region: "right", maximized: false, extended: true } },
    });
    const published = host.docks.length;
    act(() => publishThreadState({ ...harness.threadState, status: "loading" }));
    expect(host.docks).toHaveLength(published);

    act(() => dock.controls.region!.onMove("bottom"));
    expect(store.placementOf("tasks")).toBe("bottom");
    expect(host.docks.at(-1)?.controls.region?.region).toBe("bottom");
    act(() => host.docks.at(-1)!.controls.region!.onMaximize());
    expect(host.docks.at(-1)?.controls.region?.maximized).toBe(true);
    act(() => host.docks.at(-1)!.controls.region!.onRestore());
    act(() => host.docks.at(-1)!.toggle());
    expect(host.docks.at(-1)).toMatchObject({ present: true, visible: false });
    act(() => host.docks.at(-1)!.open({ focus: false }));
    expect(store.isVisible("tasks")).toBe(true);
    act(() => host.docks.at(-1)!.close());
    expect(store.isLoaded("tasks")).toBe(false);
    expect(host.docks.at(-1)).toMatchObject({ present: false });

    cleanup();
    expect(host.docks.at(-1)).toBeUndefined();
  });
});

describe("PanelLayout phones", () => {
  it("shows one foreground panel and switches it without remounting", async () => {
    harness.mobile = true;
    const mountedFiles = vi.fn();
    const unmountedFiles = vi.fn();
    const store = setup({ mountedFiles, unmountedFiles });
    expect(stageKinds()).toEqual(["chat"]);

    fireEvent.click((await openPanelsMenu()).querySelector('[data-panel-row="files"]')!);
    const fileDraft = await screen.findByRole("textbox", { name: "File draft" });
    fireEvent.change(fileDraft, { target: { value: "retained mobile draft" } });
    expect(stageKinds()).toEqual(["files"]);
    expect(quickButtons()).toEqual([
      ["chat", "hidden"],
      ["files", "visible"],
    ]);

    fireEvent.click(quickButton("chat"));
    await waitFor(() => expect(stageKinds()).toEqual(["chat"]));
    expect(screen.getByTestId("files-visible")).toHaveTextContent("false");
    expect(store.isShown("files")).toBe(true);

    const menu = await openPanelsMenu();
    expect(within(menu).getByRole("menuitem", { name: "Chat, Showing" })).toBeInTheDocument();
    // Phones have no regions to choose.
    expect(within(menu).queryByRole("menuitem", { name: /Choose where/ })).toBeNull();
    // The row tells of the unsaved draft it keeps.
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Files, Loaded, hidden, unsaved changes" }),
    );
    await waitFor(() => expect(stageKinds()).toEqual(["files"]));
    expect(fileDraft).toHaveValue("retained mobile draft");
    expect(mountedFiles).toHaveBeenCalledOnce();
    expect(unmountedFiles).not.toHaveBeenCalled();
    // Nor Maximize or Move to.
    expect(screen.queryByRole("button", { name: "Maximize Files panel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Files panel actions" })).toBeNull();

    // Hiding the foreground panel brings the next one forward.
    fireEvent.click(quickButton("files"));
    await waitFor(() => expect(stageKinds()).toEqual(["chat"]));
    expect(store.isLoaded("files")).toBe(true);
  });

  it("keeps the focused Files surface foregrounded when narrowing", () => {
    const store = setup();
    act(() => store.open("files", { focus: false }));
    const fileDraft = screen.getByRole("textbox", { name: "File draft" });
    fireEvent.pointerDown(fileDraft);
    fileDraft.focus();
    fileDraft.blur();
    act(() => setMobile(true));
    expect(stageKinds()).toEqual(["files"]);
    expect(fileDraft).toBeVisible();
  });

  it("ends Maximize on a phone, which shows one panel anyway", () => {
    const store = setup();
    act(() => {
      store.open("files", { focus: false });
      store.maximize("files");
    });
    act(() => setMobile(true));
    expect(store.maximized()).toBeNull();
  });

  it("opens the Tasks sheet from Tasks' row without replacing the Right's panel", async () => {
    harness.mobile = true;
    const host = {
      bodyTarget: document.createElement("div"),
      placement: undefined,
      sheetOpen: false,
      toggleSheet: vi.fn(),
      publishDock: vi.fn(),
    } satisfies TasksHost;
    const store = setup({ extraTenants: [tasksTenant], tasksHost: host });
    fireEvent.click((await openPanelsMenu()).querySelector('[data-panel-row="files"]')!);
    await waitFor(() => expect(stageKinds()).toEqual(["files"]));
    fireEvent.click((await openPanelsMenu()).querySelector('[data-panel-row="tasks"]')!);
    expect(host.toggleSheet).toHaveBeenCalledOnce();
    // The sheet is not a panel: Files stays the Right's panel, on stage.
    expect(store.isLoaded("tasks")).toBe(false);
    expect(store.regionPanel("right")).toBe("files");
    expect(stageKinds()).toEqual(["files"]);
    expect(panel("Tasks")).toBeNull();
  });

  it("shows Tasks' quick button while the phone sheet is open, and closes it", () => {
    harness.mobile = true;
    const host = {
      bodyTarget: document.createElement("div"),
      placement: "sheet" as const,
      sheetOpen: true,
      toggleSheet: vi.fn(),
      publishDock: vi.fn(),
    } satisfies TasksHost;
    setup({ extraTenants: [tasksTenant], tasksHost: host });
    expect(quickButton("tasks")).toHaveAttribute("data-state", "visible");
    fireEvent.click(quickButton("tasks"));
    expect(host.toggleSheet).toHaveBeenCalledOnce();
  });
});

describe("PanelLayout focus", () => {
  it("focuses an opened panel's preferred control", async () => {
    const store = setup({ extraTenants: [workpadsTenant()] });
    act(() => store.open("workpads"));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Workpad draft" })).toHaveFocus(),
    );
    await waitFor(() => expect(store.getSnapshot().focusRequest).toBeUndefined());
  });

  it("focuses the region on phones rather than raising the keyboard", async () => {
    harness.mobile = true;
    const store = setup({ extraTenants: [workpadsTenant()] });
    act(() => store.open("workpads"));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Workpads panel content" })).toHaveFocus(),
    );
  });

  it("defers a retained Chat focus request until replay enables its composer", async () => {
    const store = setup({ chatDisabledUntilAuthoritative: true });
    fireEvent.click(headerButton("Chat", "Hide Chat panel"));
    act(() => store.open("chat"));
    const composer = screen.getByRole("textbox", { name: "Chat draft" });
    expect(composer).toBeDisabled();
    expect(composer).not.toHaveFocus();
    expect(store.getSnapshot().focusRequest?.kind).toBe("chat");

    act(() =>
      publishThreadState({ ...initialThreadState, connection: "connected", authoritative: true }),
    );
    await waitFor(() => expect(composer).toHaveFocus());
    // Focus lands first; the request is consumed a frame later.
    await waitFor(() => expect(store.getSnapshot().focusRequest).toBeUndefined());
  });

  it("defers desktop Chat focus until a cold thread mounts its composer", async () => {
    const store = setup({ chatUnmountedUntilReady: true });
    act(() => {
      store.open("chat", { focus: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.queryByRole("textbox", { name: "Chat draft" })).toBeNull();
    expect(store.getSnapshot().focusRequest?.kind).toBe("chat");

    act(() =>
      publishThreadState({
        ...initialThreadState,
        status: "ready",
        connection: "connected",
        authoritative: true,
      }),
    );
    const composer = await screen.findByRole("textbox", { name: "Chat draft" });
    await waitFor(() => expect(composer).toHaveFocus());
    // Focus lands first; the request is consumed a frame later.
    await waitFor(() => expect(store.getSnapshot().focusRequest).toBeUndefined());
  });

  it.each(["phone", "touch tablet"])("does not carry cold-thread composer focus onto a %s", async (device) => {
    harness.mobile = device === "phone";
    harness.coarsePointer = true;
    const store = setup({ chatUnmountedUntilReady: true });
    act(() => {
      store.open("chat", { focus: true });
    });
    await waitFor(() => expect(store.getSnapshot().focusRequest).toBeUndefined());
    act(() =>
      publishThreadState({
        ...initialThreadState,
        status: "ready",
        connection: "connected",
        authoritative: true,
      }),
    );
    const composer = await screen.findByRole("textbox", { name: "Chat draft" });
    expect(composer).not.toHaveFocus();
  });

  it.each(["touch", "pen"])("focuses the chat panel instead of its composer after %s selection on a hybrid desktop", async (pointerType) => {
    const store = setup({ chatUnmountedUntilReady: true });
    const pointer = new Event("pointerdown", { bubbles: true });
    Object.defineProperty(pointer, "pointerType", { value: pointerType });
    fireEvent(document.body, pointer);
    act(() => store.open("chat", { focus: true }));
    await waitFor(() => expect(store.getSnapshot().focusRequest).toBeUndefined());
    act(() =>
      publishThreadState({
        ...initialThreadState,
        status: "ready",
        connection: "connected",
        authoritative: true,
      }),
    );
    const composer = await screen.findByRole("textbox", { name: "Chat draft" });
    expect(composer).not.toHaveFocus();
    expect(screen.getByRole("region", { name: "Chat panel content" })).toHaveFocus();

    fireEvent.keyDown(document.body, { key: "Enter" });
    act(() => store.open("chat", { focus: true }));
    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("keeps route-scoped Chat focus pending until the destination composer mounts", async () => {
    const registry = new WorkspacePanelTenantRegistry([]);
    const store = new PanelRegionStore(registry, { storage: noStorage });
    const view = (threadId: string) =>
      layoutElement({
        store,
        tenants: registry,
        threadId,
        chat: (controls, visible) => (
          <ChatFixture key={threadId} controls={controls} visible={visible} />
        ),
      });
    const rendered = render(view("thread-a"));
    const oldComposer = screen.getByRole("textbox", { name: "Chat draft" });

    // A route change asks the destination thread's store before it renders.
    act(() => {
      store.forThread("thread-b").open("chat", {
        focus: true,
        focusScope: { kind: "thread", threadId: "thread-b" },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(oldComposer).not.toHaveFocus();
    expect(store.forThread("thread-b").getSnapshot().focusRequest?.scope).toEqual({
      kind: "thread",
      threadId: "thread-b",
    });

    rendered.rerender(view("thread-b"));
    const destinationComposer = screen.getByRole("textbox", { name: "Chat draft" });
    expect(destinationComposer).not.toBe(oldComposer);
    await waitFor(() => expect(destinationComposer).toHaveFocus());
    await waitFor(() =>
      expect(store.forThread("thread-b").getSnapshot().focusRequest).toBeUndefined(),
    );
  });

  it("abandons deferred Chat focus when the user interacts with another panel", async () => {
    const store = setup({ chatDisabledUntilAuthoritative: true });
    act(() => store.open("files", { region: "left", focus: false }));
    const fileDraft = screen.getByRole("textbox", { name: "File draft" });
    fireEvent.click(headerButton("Chat", "Hide Chat panel"));
    act(() => store.open("chat"));
    const composer = screen.getByRole("textbox", { name: "Chat draft" });
    expect(composer).toBeDisabled();
    expect(store.getSnapshot().focusRequest?.kind).toBe("chat");

    fireEvent.pointerDown(fileDraft);
    fileDraft.focus();
    // Pressing elsewhere abandons the request at once.
    expect(store.getSnapshot().focusRequest).toBeUndefined();
    act(() =>
      publishThreadState({ ...initialThreadState, connection: "connected", authoritative: true }),
    );
    await waitFor(() => expect(fileDraft).toHaveFocus());
    expect(composer).not.toHaveFocus();
  });
});

describe("PanelLayout Files and Workpads", () => {
  it("retains Files across threads in one workspace and remounts it across workspaces", async () => {
    const mountedFiles = vi.fn();
    const unmountedFiles = vi.fn();
    const registry = new WorkspacePanelTenantRegistry([
      filesTenant({ mounted: mountedFiles, unmounted: unmountedFiles }),
    ]);
    const store = new PanelRegionStore(registry, { storage: noStorage });
    const layout = (threadId: string, workspaceId: string) =>
      layoutElement({ store, tenants: registry, threadId, workspaceId });
    const view = render(layout("thread-a", "workspace-a"));
    act(() => store.forThread("thread-a").open("files", { focus: false }));
    await screen.findByRole("textbox", { name: "File draft" });
    expect(mountedFiles).toHaveBeenCalledOnce();
    expect(screen.getByTestId("files-thread")).toHaveTextContent("thread-a");

    view.rerender(layout("thread-b", "workspace-a"));
    expect(mountedFiles).toHaveBeenCalledOnce();
    expect(unmountedFiles).not.toHaveBeenCalled();
    expect(screen.getByTestId("files-thread")).toHaveTextContent("thread-b");
    // Files is loaded for the device: the other thread shows it too.
    expect(regionOf("Files")).toBe("right");

    view.rerender(layout("thread-c", "workspace-b"));
    await waitFor(() => expect(mountedFiles).toHaveBeenCalledTimes(2));
    expect(unmountedFiles).toHaveBeenCalledOnce();
  });

  it("retains a cold-open Files intent until the panel workspace is known", async () => {
    const registry = new WorkspacePanelTenantRegistry([filesTenant()]);
    const store = new PanelRegionStore(registry, { threadId: "thread-1", storage: noStorage });
    const intent = {
      kind: "open-workspace-file",
      workspaceId: "workspace-1",
      rootId: "primary",
      path: "src/index.ts",
      rootVisibility: "listed",
      target: { kind: "file" },
      sequence: 41,
    };
    store.open("files", { intent, focus: false });
    const layout = (workspaceId: string | null) =>
      layoutElement({ store, tenants: registry, workspaceId });
    const view = render(layout(null));
    await act(async () => Promise.resolve());
    expect(store.intent("files")).toEqual(intent);

    view.rerender(layout("workspace-1"));
    await waitFor(() => expect(store.intent("files")).toEqual(intent));

    view.rerender(layout("workspace-2"));
    await waitFor(() => expect(store.intent("files")).toBeUndefined());
  });

  it("keeps Workpads' unsaved draft and its close guard across workspaces", async () => {
    function WorkpadFixture({
      context,
    }: {
      context: Parameters<WorkspacePanelTenant["render"]>[0];
    }) {
      const [text, setText] = useState("");
      return (
        <input
          aria-label="Workpad draft"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            context.host.setDirty(true);
          }}
        />
      );
    }
    const store = setup({
      extraTenants: [
        { ...workpadsTenant(), render: (context) => <WorkpadFixture context={context} /> },
      ],
    });
    act(() => store.open("workpads", { focus: false }));
    const draft = await screen.findByRole("textbox", { name: "Workpad draft" });
    fireEvent.change(draft, { target: { value: "Retain this across workspaces" } });
    store.rerenderWorkspace("workspace-2");
    expect(screen.getByRole("textbox", { name: "Workpad draft" })).toBe(draft);
    fireEvent.click(screen.getByRole("button", { name: "Close Workpads panel" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(draft).toHaveValue("Retain this across workspaces");
    expect(store.isLoaded("workpads")).toBe(true);
  });

  it("shows a tenant's unavailability notice in its panel", () => {
    const store = setup({
      tenants: [
        {
          ...draftTenant(),
          availability: () => ({ available: false, reason: "Files is offline." }),
        },
      ],
    });
    act(() => store.open("files", { focus: false }));
    expect(within(panel("Files")!).getByRole("status")).toHaveTextContent("Files is offline.");
  });
});

/** A Chat stand-in keyed by thread, for route changes. */
function ChatFixture({
  visible,
}: {
  readonly controls: PanelChromeControls;
  readonly visible: boolean;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  return (
    <section>
      <input
        aria-label="Chat draft"
        data-workspace-primary-focus="preferred"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
      <span data-testid="chat-visible">{String(visible)}</span>
    </section>
  );
}
