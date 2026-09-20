// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "../../../shared/index.js";
import type { ApplicationClientState, ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { ProjectsSettingsPage } from "./ProjectsSettingsPage.js";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const project: ProjectSummary = { id: "project-1", environmentId: "local", environmentLabel: "Local", label: "Sedes", path: "/projects/sedes", removed: false, available: true, threadCount: 3, revision: 4 };

function setup(initial: readonly ProjectSummary[] = [project]) {
  let projects = initial;
  const state = { snapshot: { environments: [{ id: "local", kind: "local", label: { text: "Local" }, available: true, directoryBrowsing: "unavailable" }], workspaces: [], threads: [] } } as unknown as ApplicationClientState;
  const api = {
    listProjects: vi.fn(async () => ({ projects })),
    removeProject: vi.fn(async () => {
      projects = projects.map((entry) => ({ ...entry, removed: true, revision: entry.revision + 1 }));
      return projects[0];
    }),
  };
  const reopenWorkspace = vi.fn(async () => {
    projects = projects.map((entry) => ({ ...entry, removed: false, revision: entry.revision + 1 }));
    return project.id;
  });
  const store = { api, reopenWorkspace, getSnapshot: () => state, subscribe: () => () => {} } as unknown as ApplicationClientStore;
  render(<ProjectsSettingsPage store={store} />);
  return { api, reopenWorkspace };
}

describe("ProjectsSettingsPage", () => {
  it("lists removed projects from missing environments and filters them", async () => {
    const user = userEvent.setup();
    setup([project, { ...project, id: "old", label: "Retired project", environmentId: "retired-host", environmentLabel: "Build host", removed: true, available: false }]);
    expect(await screen.findByText("Retired project")).toBeVisible();
    await user.click(screen.getByRole("combobox", { name: "Project environment" }));
    const environmentSearch = screen.getByRole("combobox", { name: "Search environments" });
    expect(environmentSearch).toHaveFocus();
    await user.type(environmentSearch, "BUILD HOST");
    expect(screen.getByRole("option", { name: "All environments" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Local" })).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.queryByText("Sedes")).toBeNull();
    expect(screen.getByRole("button", { name: "Restore project Retired project" })).toBeEnabled();
    await user.click(screen.getByRole("combobox", { name: "Project status" }));
    await user.type(screen.getByRole("combobox", { name: "Search project statuses" }), "remembered");
    await user.keyboard("{Enter}");
    expect(screen.getByText("No projects match these filters.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("textbox", { name: "Search projects" })).toHaveFocus();
    expect(screen.getByText("Sedes")).toBeVisible();
    expect(screen.getByText("Retired project")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Project environment" })).toHaveTextContent("All environments");
    expect(screen.getByRole("combobox", { name: "Project status" })).toHaveTextContent("All projects");
  });

  it("confirms removal with the displayed revision and restores the same identity", async () => {
    const user = userEvent.setup();
    const { api, reopenWorkspace } = setup();
    await user.click(await screen.findByRole("button", { name: "Remove project Sedes" }));
    const dialog = screen.getByRole("dialog", { name: "Remove project Sedes?" });
    expect(dialog).toHaveTextContent("Files, conversation history, and saved application data are retained");
    expect(api.removeProject).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Remove project" }));
    expect(api.removeProject).toHaveBeenCalledWith("project-1", { expectedRevision: 4 });
    await user.click(await screen.findByRole("button", { name: "Restore project Sedes" }));
    expect(reopenWorkspace).toHaveBeenCalledWith("project-1");
    expect(await screen.findByRole("button", { name: "Remove project Sedes" })).toBeVisible();
    expect(api.listProjects).toHaveBeenCalledTimes(3);
  });

  it("keeps a blocked removal visible and reports the server reason", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    api.removeProject.mockRejectedValueOnce(new Error("Stop running threads before removing this project."));
    await user.click(await screen.findByRole("button", { name: "Remove project Sedes" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove project" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Stop running threads"));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(api.listProjects).toHaveBeenCalledTimes(2);
  });
});
