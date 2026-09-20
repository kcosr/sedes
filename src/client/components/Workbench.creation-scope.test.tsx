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
vi.mock("./tasks/TasksPanelToggle.js", () => ({
  TasksPanelToggle: () => null,
}));
vi.mock("../workspace-panels/PanelLayout.js", () => ({
  PanelLayout: () => <div data-testid="panel-layout" />,
}));

import { Workbench } from "./Workbench.js";

afterEach(() => {
  cleanup();
  captured.props = undefined;
  window.localStorage.clear();
  window.dispatchEvent(
    new StorageEvent("storage", { key: SIDEBAR_VIEW_STORAGE_KEY }),
  );
});

describe("Workbench new-thread creation scope", () => {
  it("passes every workspace and the persisted sidebar scope to the shared control", () => {
    window.localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify({
        ...SIDEBAR_VIEW_DEFAULTS,
        environmentFilterId: "environment-2",
        targetFilterId: "target-2",
        projectFilterName: "Second",
      }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: SIDEBAR_VIEW_STORAGE_KEY }),
    );
    const workspaces = [
      {
        id: "workspace-1",
        environmentId: "environment-1",
        label: { text: "First" },
        displayPath: { text: "/first" },
        available: true,
      },
      {
        id: "workspace-2",
        environmentId: "environment-2",
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
      snapshot: { environments, workspaces, executionTargets },
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

    expect(
      screen.getByRole("heading", { name: "What should the agent work on?" }),
    ).toBeVisible();
    expect(captured.props).toEqual(
      expect.objectContaining({
        workspaces,
        environments,
        executionTargets,
        creationScope: {
          environmentId: "environment-2",
          targetId: "target-2",
          projectName: "Second",
        },
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
      ({ threadId, presentation }) =>
        openPanel(threadId, { focus: true, presentation }),
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

    expect(openPanel).toHaveBeenCalledWith("thread-new", {
      focus: true,
      presentation: "split",
    });
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
      ({ threadId, presentation }) =>
        openPanel(threadId, { focus: true, presentation }),
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

    fireEvent.click(screen.getByRole("button", { name: "Continue recent" }), {
      shiftKey: true,
    });

    expect(openPanel).toHaveBeenCalledWith("thread-recent", {
      focus: true,
      presentation: "single",
    });
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
          automationOpen: false,
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
    const { rerender } = render(<Workbench {...props} route={{ name: "thread", threadId: "first", automationOpen: false }} />);
    const panelHost = screen.getByTestId("panel-layout");
    workspaceIdForThread.mockReturnValue(undefined);
    rerender(<Workbench {...props} route={{ name: "thread", threadId: "second", automationOpen: false }} />);
    expect(screen.getByTestId("panel-layout")).toBe(panelHost);
    workspaceIdForThread.mockReturnValue("workspace-2");
    rerender(<Workbench {...props} route={{ name: "thread", threadId: "second", automationOpen: false }} />);
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
          automationOpen: false,
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
});
