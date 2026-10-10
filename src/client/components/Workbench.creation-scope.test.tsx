// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_VIEW_DEFAULTS } from "../app/sidebar-view-model.js";
import { SIDEBAR_VIEW_STORAGE_KEY } from "../app/sidebar-view-model.js";
import { installThreadPanelOpenRequestListener } from "../workspace-panels/thread-panel-navigation.js";

const captured = vi.hoisted(() => ({ props: undefined as unknown }));

vi.mock("./NewThreadControl.js", () => ({
  NewThreadControl: (props: unknown) => {
    captured.props = props;
    return <button type="button">New thread</button>;
  },
}));
vi.mock("./SidebarNavTrigger.js", () => ({
  SidebarNavTrigger: () => null,
}));
vi.mock("../workspace-panels/PanelLayout.js", () => ({
  PanelLayout: () => <div data-testid="panel-layout" />,
}));

import { Workbench } from "./Workbench.js";
import { TasksPanel } from "./tasks/TasksPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  captured.props = undefined;
  window.localStorage.clear();
  window.dispatchEvent(
    new StorageEvent("storage", { key: SIDEBAR_VIEW_STORAGE_KEY }),
  );
});

describe("Workbench new-thread creation scope", () => {
  it("does not mount the analytics query for a disabled direct Usage route", () => {
    const state = {experimentalUsageEnabled:false};
    const getUsageAnalytics = vi.fn();
    const applicationStore = {api:{getUsageAnalytics},subscribe:()=>()=>undefined,getSnapshot:()=>state,workspaceIdForThread:()=>undefined};
    render(<Workbench route={{name:"usage"}} applicationStore={applicationStore as never} threadRegistry={{} as never} panelLayoutStore={{} as never} panelTenants={{} as never}/>);
    expect(screen.getByText("Experimental usage accounting is disabled on this server.")).toBeVisible();
    expect(screen.queryByRole("region",{name:"Usage"})).toBeNull();
    expect(getUsageAnalytics).not.toHaveBeenCalled();
  });
  function renderHome(preferences: Record<string, unknown>) {
    window.localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify({ ...SIDEBAR_VIEW_DEFAULTS, ...preferences }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: SIDEBAR_VIEW_STORAGE_KEY }),
    );
    const projects = [
      { id: "project-1", name: "First", revision: 0 },
      { id: "project-2", name: "Second", revision: 0 },
    ];
    const workspaces = [
      {
        id: "workspace-1",
        environmentId: "environment-1",
        projectId: "project-1",
        label: { text: "First" },
        displayPath: { text: "/first" },
        available: true,
      },
      {
        id: "workspace-2",
        environmentId: "environment-2",
        projectId: "project-2",
        label: { text: "Second" },
        displayPath: { text: "/second" },
        available: true,
      },
    ];
    const executionTargets = [
      {
        id: "target-2",
        environmentId: "environment-2",
        label: { text: "Remote" },
        backend: { label: { text: "Codex" }, brand: "codex" },
        available: true,
      },
    ];
    const environments = [
      { id: "environment-1", label: { text: "Local" }, available: true },
      { id: "environment-2", label: { text: "Remote" }, available: true },
    ];
    const state = {
      snapshot: { environments, projects, workspaces, executionTargets, groups: [] },
      visibleThreads: [],
    };
    const applicationStore = {
      api: {},
      subscribe: () => () => undefined,
      getSnapshot: () => state,
      workspaceIdForThread: () => undefined,
    };

    render(
      <Workbench
        route={{ name: "home" }}
        applicationStore={applicationStore as never}
        threadRegistry={{} as never}
        panelLayoutStore={{} as never}
        panelTenants={{} as never}
      />,
    );
    return { environments, executionTargets, projects, workspaces };
  }

  it("passes the inventory and the derived sidebar scope to the shared control", () => {
    const { environments, executionTargets, projects, workspaces } = renderHome({
      environmentFilterId: "environment-2",
      targetFilterId: "target-2",
      projectFilterId: "project-2",
    });

    expect(
      screen.getByRole("heading", { name: "What should the agent work on?" }),
    ).toBeVisible();
    expect(captured.props).toEqual(
      expect.objectContaining({
        projects,
        workspaces,
        environments,
        executionTargets,
        creationScope: {
          environmentId: "environment-2",
          targetId: "target-2",
          projectId: "project-2",
        },
      }),
    );
  });

  it("does not narrow creation by stale or legacy stored selections", () => {
    renderHome({
      environmentFilterId: "environment-gone",
      targetFilterId: "target-gone",
      projectFilterId: "project-gone",
    });
    expect(captured.props).toEqual(
      expect.objectContaining({
        creationScope: { environmentId: null, targetId: null, projectId: null },
      }),
    );

    cleanup();
    // A legacy name is only a migration hint the sidebar resolves; it
    // filters nothing by itself.
    renderHome({ targetFilterId: "target-2", projectFilterName: "Second" });
    expect(captured.props).toEqual(
      expect.objectContaining({
        creationScope: { environmentId: null, targetId: "target-2", projectId: null },
      }),
    );
  });

  it("reopens and focuses Chat before navigating to a newly created thread", () => {
    const state = {
      snapshot: { environments: [], workspaces: [], executionTargets: [] },
      visibleThreads: [],
    };
    const applicationStore = {
      api: {},
      subscribe: () => () => undefined,
      getSnapshot: () => state,
      workspaceIdForThread: () => undefined,
    };
    const openPanel = vi.fn();
    const removeOpenListener = installThreadPanelOpenRequestListener(
      window,
      ({ threadId }) => openPanel(threadId, { focus: true }),
    );

    render(
      <Workbench
        route={{ name: "home" }}
        applicationStore={applicationStore as never}
        threadRegistry={{} as never}
        panelLayoutStore={{ forThread: () => ({ openPanel }) } as never}
        panelTenants={{} as never}
      />,
    );

    const props = captured.props as {
      onCreated: (threadId: string) => void;
    };
    props.onCreated("thread-new");

    expect(openPanel).toHaveBeenCalledWith("thread-new", { focus: true });
    expect(window.location.pathname).toBe("/threads/thread-new");
    removeOpenListener();
  });

  it("reopens and focuses Chat before continuing the recent thread", () => {
    const state = {
      snapshot: { environments: [], workspaces: [], executionTargets: [] },
      visibleThreads: [{ id: "thread-recent", inventoryState: "active" }],
    };
    const applicationStore = {
      api: {},
      subscribe: () => () => undefined,
      getSnapshot: () => state,
      workspaceIdForThread: () => undefined,
    };
    const openPanel = vi.fn();
    const removeOpenListener = installThreadPanelOpenRequestListener(
      window,
      ({ threadId }) => openPanel(threadId, { focus: true }),
    );

    render(
      <Workbench
        route={{ name: "home" }}
        applicationStore={applicationStore as never}
        threadRegistry={{} as never}
        panelLayoutStore={{ forThread: () => ({ openPanel }) } as never}
        panelTenants={{} as never}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue recent" }));

    expect(openPanel).toHaveBeenCalledWith("thread-recent", { focus: true });
    expect(window.location.pathname).toBe("/threads/thread-recent");
    removeOpenListener();
  });

  it("preserves a persisted closed Chat on an initial thread route", () => {
    const state = {
      snapshot: { environments: [], workspaces: [], executionTargets: [] },
      visibleThreads: [],
    };
    const applicationStore = {
      api: {},
      subscribe: () => () => undefined,
      getSnapshot: () => state,
      workspaceIdForThread: () => "workspace-1",
    };
    const openPanel = vi.fn();
    const threadRegistry = {
      retain: vi.fn(),
      release: vi.fn(),
    };

    render(
      <Workbench
        route={{
          name: "thread",
          threadId: "thread-deep-link",
        }}
        applicationStore={applicationStore as never}
        threadRegistry={threadRegistry as never}
        panelLayoutStore={{ isVisible: () => false, openPanel } as never}
        panelTenants={{} as never}
      />,
    );

    expect(screen.getByTestId("panel-layout")).toBeVisible();
    expect(openPanel).not.toHaveBeenCalled();
    expect(threadRegistry.retain).toHaveBeenCalledWith("thread-deep-link");
  });

  it("retains the panel host while a destination thread's workspace is unresolved", () => {
    const state = { snapshot: { environments: [], workspaces: [], executionTargets: [] }, visibleThreads: [] };
    const workspaceIdForThread = vi.fn((): string | undefined => "workspace-1");
    const applicationStore = { api: {}, subscribe: () => () => undefined, getSnapshot: () => state, workspaceIdForThread };
    const props = {
      applicationStore: applicationStore as never,
      threadRegistry: { retain: vi.fn(), release: vi.fn() } as never,
      panelLayoutStore: { openPanel: vi.fn() } as never,
      panelTenants: {} as never,
    };
    const { rerender } = render(<Workbench {...props} route={{ name: "thread", threadId: "first" }} />);
    const panelHost = screen.getByTestId("panel-layout");
    workspaceIdForThread.mockReturnValue(undefined);
    rerender(<Workbench {...props} route={{ name: "thread", threadId: "second" }} />);
    expect(screen.getByTestId("panel-layout")).toBe(panelHost);
    workspaceIdForThread.mockReturnValue("workspace-2");
    rerender(<Workbench {...props} route={{ name: "thread", threadId: "second" }} />);
    expect(screen.getByTestId("panel-layout")).toBe(panelHost);
  });

  it("restores Chat after a successful route transition", () => {
    const state = {
      snapshot: { environments: [], workspaces: [], executionTargets: [] },
      visibleThreads: [],
    };
    const applicationStore = {
      api: {},
      subscribe: () => () => undefined,
      getSnapshot: () => state,
      workspaceIdForThread: () => "workspace-1",
    };
    const openPanel = vi.fn();
    const panelLayoutStore = {
      isVisible: () => true,
      openPanel,
    } as never;
    const threadRegistry = {
      retain: vi.fn(),
      release: vi.fn(),
    };
    const { rerender } = render(
      <Workbench
        route={{ name: "home" }}
        applicationStore={applicationStore as never}
        threadRegistry={threadRegistry as never}
        panelLayoutStore={panelLayoutStore}
        panelTenants={{} as never}
      />,
    );

    rerender(
      <Workbench
        route={{
          name: "thread",
          threadId: "thread-after-navigation",
        }}
        applicationStore={applicationStore as never}
        threadRegistry={threadRegistry as never}
        panelLayoutStore={panelLayoutStore}
        panelTenants={{} as never}
      />,
    );

    expect(openPanel).toHaveBeenCalledWith("chat", {
      focus: true,
      focusScope: {
        kind: "thread",
        threadId: "thread-after-navigation",
      },
    });
    expect(threadRegistry.retain).toHaveBeenCalledWith(
      "thread-after-navigation",
    );
  });

  it.each([
    ["home", false],
    ["archived", false],
    ["usage", false],
    ["home", true],
    ["archived", true],
    ["usage", true],
  ] as const)(
    "shows no Tasks on %s, where the Tasks shortcut does nothing (phone: %s)",
    (name, phone) => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
          matches: phone && query === "(max-width: 819px)",
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      );
      const task = (id: string, scope: unknown) => ({ id, scope, completedAt: null });
      const state = {
        experimentalUsageEnabled: false,
        search: "",
        pendingThreadConfigurationCopySourceIds: [],
        snapshot: {
          environments: [],
          projects: [],
          workspaces: [],
          executionTargets: [],
          groups: [],
          threads: [],
          forkOrigins: [],
          lineagePlacements: [],
          tasks: [
            task("global-open", { kind: "global" }),
            task("thread-open", { kind: "thread", threadId: "thread-1" }),
          ],
        },
        visibleThreads: [],
      };
      const applicationStore = {
        api: { getUsageAnalytics: vi.fn() },
        subscribe: () => () => undefined,
        getSnapshot: () => state,
        getTasks: () => state.snapshot.tasks,
        workspaceIdForThread: () => undefined,
      };
      render(
        <TasksPanel
          route={{ name }}
          store={applicationStore as never}
          panelLayoutStore={{} as never}
        >
          <Workbench
            route={{ name }}
            applicationStore={applicationStore as never}
            threadRegistry={{} as never}
            panelLayoutStore={{} as never}
            panelTenants={{} as never}
          />
        </TasksPanel>,
      );

      expect(screen.queryByTestId("tasks-panel-toggle")).toBeNull();
      expect(screen.queryByRole("button", { name: /Tasks panel/ })).toBeNull();
      // Nothing to toggle: the key stays the page's.
      expect(
        fireEvent.keyDown(document.body, { key: "L", ctrlKey: true, shiftKey: true }),
      ).toBe(true);
      expect(screen.queryByRole("region", { name: "Tasks" })).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );
});
