// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspacePanelNavigationBlocker,
  installVoiceDockHeight,
  installWorkspacePanelBeforeUnloadGuard,
  installPromptSettingsRequestListener,
  openThreadChatPanel,
  resolveComposerWorkspaceId,
  toolClientResources,
} from "./ApplicationShell.js";
import { PanelLayoutStore } from "../workspace-panels/panel-state.js";
import { WorkspacePanelTenantRegistry } from "../workspace-panels/registry.js";
import type { Route } from "../app/router.js";
import type { ApplicationClientState } from "../stores/ApplicationClientStore.js";
import { ElectronConnectionRecovery } from "./ElectronConnectionSettings.js";

afterEach(cleanup);

const threadRoute = (threadId: string): Route => ({
  name: "thread",
  threadId,
});

const workspaceResolver =
  (threads: readonly { readonly id: string; readonly workspaceId: string }[]) =>
  (threadId: string): string | undefined =>
    threads.find(({ id }) => id === threadId)?.workspaceId;

describe("thread panel selection", () => {
  it("opens the destination thread Chat panel with the resolved presentation", () => {
    const openPanel = vi.fn(() => true);
    const forThread = vi.fn(() => ({ openPanel }));

    expect(
      openThreadChatPanel(
        { forThread } as unknown as Pick<PanelLayoutStore, "forThread">,
        "thread-destination",
        "single",
      ),
    ).toBe(true);
    expect(forThread).toHaveBeenCalledWith("thread-destination");
    expect(openPanel).toHaveBeenCalledWith("chat", {
      focus: true,
      presentation: "single",
    });
  });
});

describe("prompt settings request", () => {
  it("opens Prompts settings from the composer event and removes cleanly", () => {
    const onRequest = vi.fn();
    const remove = installPromptSettingsRequestListener(window, onRequest);

    window.dispatchEvent(new Event("sedes-open-settings-prompts"));
    expect(onRequest).toHaveBeenCalledOnce();

    remove();
    window.dispatchEvent(new Event("sedes-open-settings-prompts"));
    expect(onRequest).toHaveBeenCalledOnce();
  });
});

describe("Electron connection recovery", () => {
  it("offers an accessible connection chooser while application bootstrap is unavailable", async () => {
    let resolveSwitch: (() => void) | undefined;
    const switchConnection = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSwitch = resolve;
        }),
    );
    render(
      createElement(ElectronConnectionRecovery, {
        controls: {
          activeProfile: {
            id: "10000000-0000-4000-8000-000000000001",
            name: "Office",
            kind: "direct",
            baseUrl: "https://sedes.example",
          },
          switchConnection,
        },
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Choose another connection" }),
    );
    expect(switchConnection).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Opening…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Opening…" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    resolveSwitch?.();
    await waitFor(() => expect(switchConnection).toHaveBeenCalledOnce());
  });

  it("announces a failure to open the chooser and allows retry", async () => {
    const switchConnection = vi.fn(async () => {
      throw new Error("Tunnel cleanup failed.");
    });
    render(
      createElement(ElectronConnectionRecovery, {
        controls: {
          activeProfile: {
            id: "10000000-0000-4000-8000-000000000001",
            name: "Office",
            kind: "direct",
            baseUrl: "https://sedes.example",
          },
          switchConnection,
        },
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Choose another connection" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Tunnel cleanup failed.",
    );
    expect(
      screen.getByRole("button", { name: "Choose another connection" }),
    ).toBeEnabled();
  });
});

describe("workspace panel navigation policy", () => {
  it("scopes the composer from the pending-created thread workspace handoff", () => {
    const workspaceIdForThread = vi.fn(() => "workspace-pending");

    expect(
      resolveComposerWorkspaceId(
        threadRoute("thread-created-before-publication"),
        workspaceIdForThread,
      ),
    ).toBe("workspace-pending");
    expect(workspaceIdForThread).toHaveBeenCalledWith(
      "thread-created-before-publication",
    );
  });

  it("retains dirty panels for same-workspace threads and blocks a workspace switch", () => {
    const proceed = vi.fn();
    const store = {
      hasDirtyWorkspacePanels: vi.fn(() => true),
      discardWorkspacePanelChanges: vi.fn(),
    };
    const onBlocked = vi.fn();
    const block = createWorkspacePanelNavigationBlocker(
      workspaceResolver([
        { id: "thread-1", workspaceId: "workspace-1" },
        { id: "thread-2", workspaceId: "workspace-1" },
        { id: "thread-3", workspaceId: "workspace-2" },
      ]),
      store,
      {
        onBlocked,
      },
    );

    expect(block(threadRoute("thread-1"), threadRoute("thread-2"), proceed)).toBe(true);
    expect(onBlocked).not.toHaveBeenCalled();
    expect(block(threadRoute("thread-2"), threadRoute("thread-3"), proceed)).toBe(false);
    expect(onBlocked).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      next: threadRoute("thread-3"),
      proceed,
    });
    expect(store.discardWorkspacePanelChanges).not.toHaveBeenCalled();
  });

  it("preserves the navigation continuation for explicit confirmation", () => {
    const proceed = vi.fn();
    const onBlocked = vi.fn();
    const block = createWorkspacePanelNavigationBlocker(
      workspaceResolver([
        { id: "thread-1", workspaceId: "workspace-1" },
        { id: "thread-2", workspaceId: "workspace-2" },
      ]),
      { hasDirtyWorkspacePanels: () => true, discardWorkspacePanelChanges: vi.fn() },
      { onBlocked },
    );

    expect(block(threadRoute("thread-1"), threadRoute("thread-2"), proceed)).toBe(false);
    expect(proceed).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledWith({
      workspaceId: "workspace-1", next: threadRoute("thread-2"), proceed,
    });
    onBlocked.mock.calls[0]![0].proceed();
    expect(proceed).toHaveBeenCalledOnce();
  });

  it("parks dirty workspace panels across Settings categories and guards departure", () => {
    const proceed = vi.fn();
    const onBlocked = vi.fn();
    const block = createWorkspacePanelNavigationBlocker(
      workspaceResolver([
        { id: "thread-1", workspaceId: "workspace-1" },
        { id: "thread-2", workspaceId: "workspace-1" },
        { id: "thread-3", workspaceId: "workspace-2" },
      ]),
      { hasDirtyWorkspacePanels: () => true, discardWorkspacePanelChanges: vi.fn() },
      { onBlocked },
      () => threadRoute("thread-1"),
    );
    const settings: Route = { name: "settings", page: "general" };
    expect(block(threadRoute("thread-1"), settings, proceed)).toBe(true);
    expect(block(settings, { name: "settings", page: "backends" }, proceed)).toBe(true);
    expect(block(settings, threadRoute("thread-2"), proceed)).toBe(true);
    expect(onBlocked).not.toHaveBeenCalled();
    expect(block(settings, threadRoute("thread-3"), proceed)).toBe(false);
    expect(onBlocked).toHaveBeenLastCalledWith({
      workspaceId: "workspace-1", next: threadRoute("thread-3"), proceed,
    });
    expect(block(settings, { name: "home" }, proceed)).toBe(false);
    expect(onBlocked).toHaveBeenLastCalledWith({
      workspaceId: "workspace-1", next: { name: "home" }, proceed,
    });
  });

  it("uses the created-thread workspace handoff before publication catches up", () => {
    const proceed = vi.fn();
    const workspaces = new Map([
      ["thread-1", "workspace-1"],
      ["thread-new", "workspace-1"],
    ]);
    const onBlocked = vi.fn();
    const block = createWorkspacePanelNavigationBlocker(
      (threadId) => workspaces.get(threadId),
      {
        hasDirtyWorkspacePanels: () => true,
        discardWorkspacePanelChanges: vi.fn(),
      },
      { onBlocked },
    );

    expect(block(threadRoute("thread-1"), threadRoute("thread-new"), proceed)).toBe(
      true,
    );
    expect(onBlocked).not.toHaveBeenCalled();

    workspaces.set("thread-new", "workspace-2");
    expect(block(threadRoute("thread-1"), threadRoute("thread-new"), proceed)).toBe(
      false,
    );
    expect(onBlocked).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      next: threadRoute("thread-new"),
      proceed,
    });
  });

  it.each([
    ["home", { name: "home" as const }],
    ["archived", { name: "archived" as const }],
    ["usage", { name: "usage" as const }],
  ])("blocks leaving a dirty workspace for %s until confirmed", (_label, destination) => {
    const store = {
      hasDirtyWorkspacePanels: vi.fn(() => true),
      discardWorkspacePanelChanges: vi.fn(),
    };
    const onBlocked = vi.fn();
    const proceed = vi.fn();
    const block = createWorkspacePanelNavigationBlocker(
      workspaceResolver([{ id: "thread-1", workspaceId: "workspace-1" }]),
      store,
      { onBlocked },
    );

    expect(block(threadRoute("thread-1"), destination, proceed)).toBe(false);
    expect(onBlocked).toHaveBeenCalledWith({
      workspaceId: "workspace-1", next: destination, proceed,
    });
    expect(store.discardWorkspacePanelChanges).not.toHaveBeenCalled();
    expect(proceed).not.toHaveBeenCalled();
  });
});

describe("workspace panel beforeunload policy", () => {
  it("installs only while dirty and removes the listener when cleaned or unmounted", () => {
    const store = new PanelLayoutStore(new WorkspacePanelTenantRegistry([]), {
      storage: { getItem: () => null, setItem: () => undefined },
    });
    const remove = installWorkspacePanelBeforeUnloadGuard(store, window);
    const dispatchBeforeUnload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(dispatchBeforeUnload()).toBe(false);
    store.setWorkspaceTenantDirty("workspace-1", "files", true);
    expect(dispatchBeforeUnload()).toBe(true);
    store.setWorkspaceTenantDirty("workspace-1", "files", false);
    expect(dispatchBeforeUnload()).toBe(false);

    store.setWorkspaceTenantDirty("workspace-1", "files", true);
    remove();
    expect(dispatchBeforeUnload()).toBe(false);
  });
});

describe("voice dock height", () => {
  it("publishes the band under the view, follows resizes and clears on removal", () => {
    const observed: Element[] = [];
    let resized = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe(element: Element) { observed.push(element); }
      unobserve() {}
      disconnect = disconnect;
    });
    const [main, view, root] = [document.createElement("div"), document.createElement("div"), document.createElement("div")];
    const bottoms = new Map([[main, 915], [view, 915]]);
    for (const element of [main, view]) element.getBoundingClientRect = () => ({ bottom: bottoms.get(element)! }) as DOMRect;
    const height = () => root.style.getPropertyValue("--voice-dock-height");
    try {
      const remove = installVoiceDockHeight(main, view, root);
      expect(observed).toEqual([main, view]);
      expect(height()).toBe("0px");
      // The card appears under the view, then the soft keyboard shrinks both.
      bottoms.set(view, 838.5);
      resized();
      expect(height()).toBe("76.5px");
      bottoms.set(main, 600).set(view, 523.5);
      resized();
      expect(height()).toBe("76.5px");
      remove();
      expect(disconnect).toHaveBeenCalledOnce();
      expect(height()).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ends the mobile drawer and the touch selection action above the card", () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../styles.css");
    const declarations = new Map<string, string>();
    postcss.parse(readFileSync(file, "utf8")).walkRules((rule) => {
      const media = rule.parent?.type === "atrule" ? (rule.parent as postcss.AtRule).params : "";
      rule.walkDecls((declaration) => {
        for (const selector of rule.selectors) declarations.set(`${media} ${selector} ${declaration.prop}`, declaration.value.replace(/\s+/gu, " "));
      });
    });
    const declared = (media: string, selector: string, prop: string) => declarations.get(`${media} ${selector} ${prop}`);
    const phone = "(max-width: 819px)";
    expect(declared(phone, ".mobile-drawer", "bottom")).toBe("var(--voice-dock-height, 0px)");
    expect(declared(phone, ".mobile-drawer", "height")).toBe("calc(100dvh - var(--workbench-bar-height) - var(--voice-dock-height, 0px))");
    expect(declared(phone, ".mobile-drawer .sidebar-footer", "padding-bottom")).toContain("env(safe-area-inset-bottom) - var(--voice-dock-height, 0px)");
    const touch = "(pointer: coarse), (max-width: 700px)";
    expect(declared(touch, ".pierre-selection-action", "--selection-action-floor")).toBe("max(env(safe-area-inset-bottom), var(--voice-dock-height, 0px))");
    expect(declared(touch, ".pierre-selection-action", "bottom")).toBe("calc(12px + var(--selection-action-floor))");
  });
});

describe("tool client resources", () => {
  it("names each location by its project and path", () => {
    const location = {
      environmentId: "environment-1",
      projectId: "project-1",
      label: { text: "sedes" },
      available: true,
    };
    const snapshot = {
      environments: [
        {
          id: "environment-1",
          kind: "local",
          label: { text: "Local" },
          available: true,
          directoryBrowsing: "available",
        },
        {
          id: "environment-2",
          kind: "ssh",
          label: { text: "Build host" },
          available: true,
          directoryBrowsing: "available",
        },
      ],
      projects: [
        { id: "project-1", name: "sedes", revision: 0 },
        { id: "project-2", name: "Docs", revision: 0 },
      ],
      workspaces: [
        { ...location, id: "workspace-1", displayPath: { text: "/src/sedes" } },
        {
          ...location,
          id: "workspace-2",
          projectId: "project-2",
          label: { text: "docs" },
          displayPath: { text: "/src/docs" },
          available: false,
        },
      ],
      threads: [
        {
          id: "thread-1",
          workspaceId: "workspace-1",
          title: { text: "Build thread" },
          available: true,
          inventoryState: "archived",
        },
      ],
    } as unknown as NonNullable<ApplicationClientState["snapshot"]>;

    expect(toolClientResources(snapshot)).toEqual({
      workspaces: [
        {
          id: "workspace-1",
          environmentId: "environment-1",
          label: "sedes · /src/sedes",
          available: true,
        },
        {
          id: "workspace-2",
          environmentId: "environment-1",
          label: "Docs · /src/docs",
          available: false,
        },
      ],
      threads: [
        {
          id: "thread-1",
          workspaceId: "workspace-1",
          title: "Build thread",
          available: true,
          archived: true,
        },
      ],
    });
    expect(toolClientResources(undefined)).toEqual({
      workspaces: [],
      threads: [],
    });
  });
});
