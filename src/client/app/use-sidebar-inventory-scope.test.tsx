// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SidebarScopeCatalog } from "./sidebar-scope.js";
import { SIDEBAR_VIEW_STORAGE_KEY } from "./sidebar-view-model.js";
import {
  getSidebarViewPreferences,
  setSidebarInventoryScope,
  setSidebarShowFilter,
} from "./sidebar-view-store.js";
import {
  clearSidebarInventoryScope,
  sidebarScopeSummary,
  useSidebarInventoryScope,
} from "./use-sidebar-inventory-scope.js";

const catalog: SidebarScopeCatalog = {
  environments: [
    {
      id: "env-a",
      kind: "local",
      label: { text: "Host A" },
      available: true,
      directoryBrowsing: "available",
    },
    {
      id: "env-b",
      kind: "ssh",
      label: { text: "Host B" },
      available: false,
      directoryBrowsing: "unavailable",
    },
  ],
  executionTargets: [
    {
      id: "target-a",
      environmentId: "env-a",
      label: { text: "Socket A" },
      backend: { label: { text: "Codex" }, brand: "codex" },
      workspaceExecution: { kind: "direct_only" },
      available: true,
    },
  ],
  projects: [{ id: "project-1", name: "Sedes", revision: 0 }],
  workspaces: [
    {
      id: "ws-a",
      environmentId: "env-a",
      projectId: "project-1",
      label: { text: "sedes" },
      displayPath: { text: "/src/sedes" },
      available: true,
    },
  ],
  groups: [
    {
      id: "group-1",
      name: "Launch",
      revision: 1,
      memberCount: 0,
      activeMemberCount: 0,
    },
  ],
};

const none = {
  environmentId: null,
  targetId: null,
  projectId: null,
  groupId: null,
  ungrouped: false,
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
});

describe("sidebarScopeSummary", () => {
  it("reads All threads without a scope", () => {
    expect(sidebarScopeSummary(catalog, none)).toEqual({
      fullLabel: "",
      visibleLabel: "All threads",
    });
  });

  it("lists location facets, then the group, collapsing past two facets", () => {
    expect(
      sidebarScopeSummary(catalog, {
        ...none,
        environmentId: "env-a",
        targetId: "target-a",
        projectId: "project-1",
        groupId: "group-1",
      }),
    ).toEqual({
      fullLabel: "Host A · Socket A · Codex · Sedes · Launch",
      visibleLabel: "Host A · Socket A · Codex +1 · Launch",
    });
    expect(sidebarScopeSummary(catalog, { ...none, ungrouped: true })).toEqual({
      fullLabel: "Ungrouped",
      visibleLabel: "Ungrouped",
    });
    expect(
      sidebarScopeSummary(catalog, { ...none, environmentId: "env-b" })
        .fullLabel,
    ).toBe("Host B — Unavailable");
  });
});

describe("useSidebarInventoryScope", () => {
  it("derives the shared scope and clears only scope facets", () => {
    setSidebarInventoryScope({
      projectFilterId: "project-1",
      groupFilterId: "group-1",
    });
    setSidebarShowFilter("settled", false);
    function Probe() {
      const view = useSidebarInventoryScope(catalog);
      return (
        <button type="button" onClick={view.clearScope}>
          {`${view.active}|${view.scope.projectId}|${view.summary.visibleLabel}`}
        </button>
      );
    }
    render(<Probe />);
    expect(screen.getByRole("button")).toHaveTextContent(
      "true|project-1|Sedes · Launch",
    );
    act(() => screen.getByRole("button").click());
    expect(screen.getByRole("button")).toHaveTextContent(
      "false|null|All threads",
    );
    // Search and Show toggles are not Scope.
    expect(getSidebarViewPreferences().show.settled).toBe(false);
    expect(
      JSON.parse(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY)!),
    ).toMatchObject({
      projectFilterId: null,
      groupFilterId: null,
      ungroupedFilter: false,
    });
  });

  it("ignores stale persisted facets without rewriting them", () => {
    setSidebarInventoryScope({ targetFilterId: "retired-target" });
    function Probe() {
      const view = useSidebarInventoryScope(catalog);
      return (
        <span>{`${view.active}|${view.scope.repair?.targetFilterId}`}</span>
      );
    }
    render(<Probe />);
    expect(screen.getByText("false|null")).toBeInTheDocument();
    expect(getSidebarViewPreferences().targetFilterId).toBe("retired-target");
    clearSidebarInventoryScope();
    expect(getSidebarViewPreferences().targetFilterId).toBeNull();
  });

  it("leaves a legacy project-name hint unapplied until the sidebar migrates it", () => {
    localStorage.setItem(
      SIDEBAR_VIEW_STORAGE_KEY,
      JSON.stringify({
        ...getSidebarViewPreferences(),
        projectFilterName: "Sedes",
      }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    function Probe() {
      const view = useSidebarInventoryScope(catalog);
      return (
        <span>{`${view.active}|${view.scope.projectId}|${view.scope.repair?.projectFilterId}`}</span>
      );
    }
    render(<Probe />);
    expect(screen.getByText("false|null|project-1")).toBeInTheDocument();
    expect(getSidebarViewPreferences().projectFilterName).toBe("Sedes");
    act(() => clearSidebarInventoryScope());
    expect(getSidebarViewPreferences()).not.toHaveProperty("projectFilterName");
  });
});
