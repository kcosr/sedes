// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAssignment, ProjectLocation, ProjectSummary } from "../../../shared/index.js";
import { ApiError, ProjectRemovalBlockedApiError } from "../../api/ApiClient.js";
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

function location(id: string, overrides: Partial<ProjectLocation> = {}): ProjectLocation {
  return {
    id, environmentId: "local", environmentLabel: "Local", label: "sedes", path: `/src/${id}`,
    removed: false, removedWithProject: false, available: true, threadCount: 0, revision: 4, ...overrides,
  };
}

// "sedes" on Local with a removed checkout on aw-personal; a second "sedes";
// a removed project with locations on Local, aw-personal, and a host that no
// longer exists; and an empty project.
const sedes: ProjectSummary = {
  id: "project-sedes", name: "sedes", revision: 2, membershipRevision: 5, removed: false,
  locations: [
    location("sedes-local", { path: "/src/sedes", threadCount: 3 }),
    location("sedes-remote", { environmentId: "remote", environmentLabel: "aw-personal", path: "/home/k/sedes", removed: true }),
  ],
};
const twin: ProjectSummary = {
  id: "project-twin", name: "sedes", revision: 1, membershipRevision: 1, removed: false,
  locations: [location("twin-local", { path: "/work/sedes", threadCount: 1, revision: 7 })],
};
const retired: ProjectSummary = {
  id: "project-retired", name: "Retired", revision: 3, membershipRevision: 9, removed: true,
  locations: [
    location("retired-build", { environmentId: "build", environmentLabel: "Build host", label: "retired", path: "/srv/retired", removed: true, removedWithProject: true, available: false }),
    location("retired-local", { label: "retired", path: "/src/retired", removed: true, removedWithProject: true }),
    location("retired-remote", { environmentId: "remote", environmentLabel: "aw-personal", label: "old", path: "/home/k/old", removed: true }),
  ],
};
const empty: ProjectSummary = { id: "project-empty", name: "Empty", revision: 0, membershipRevision: 0, removed: false, locations: [] };

/**
 * A server that keeps its projects and checks expected revisions as the real
 * one does, so a retry after a conflict succeeds only with the revision the
 * reloaded list carries. `elsewhere` makes another client's changes.
 */
function fakeServer(initial: readonly ProjectSummary[]) {
  let projects = initial;
  const conflict = (message: string) => new ApiError(409, "conflict", message, false);
  const find = (id: string) => {
    const project = projects.find((candidate) => candidate.id === id);
    if (!project) throw new ApiError(404, "not_found", "The project was not found.", false);
    return project;
  };
  const place = (locationId: string) => {
    const project = projects.find(({ locations }) => locations.some(({ id }) => id === locationId))!;
    return { project, location: project.locations.find(({ id }) => id === locationId)! };
  };
  const save = (project: ProjectSummary) => {
    projects = projects.some(({ id }) => id === project.id)
      ? projects.map((candidate) => candidate.id === project.id ? project : candidate) : [...projects, project];
    return project;
  };
  const replaceLocation = (project: ProjectSummary, location: ProjectLocation): ProjectSummary => ({
    ...project, membershipRevision: project.membershipRevision + 1,
    locations: project.locations.map((candidate) => candidate.id === location.id ? location : candidate),
  });
  const operations = {
    renameProject: async (id: string, request: { name: string; expectedRevision: number }) => {
      const project = find(id);
      if (project.revision !== request.expectedRevision) throw conflict("The project changed. Refresh and try again.");
      return save({ ...project, name: request.name.trim(), revision: project.revision + 1 });
    },
    removeProject: async (id: string, request: { expectedRevision: number; expectedMembershipRevision: number }) => {
      const project = find(id);
      if (project.revision !== request.expectedRevision) throw conflict("The project changed. Refresh and try again.");
      if (project.membershipRevision !== request.expectedMembershipRevision) {
        throw conflict("The project's locations changed. Refresh and try again.");
      }
      return save({
        ...project, removed: true, revision: project.revision + 1, membershipRevision: project.membershipRevision + 1,
        locations: project.locations.map((location) => location.removed ? { ...location, removedWithProject: false }
          : { ...location, removed: true, removedWithProject: true, revision: location.revision + 1 }),
      });
    },
    restoreProject: async (id: string, request: { expectedRevision: number; locationIds: readonly string[] }) => {
      const project = find(id);
      if (project.revision !== request.expectedRevision) throw conflict("The project changed. Refresh and try again.");
      if (!request.locationIds.every((locationId) => project.locations.some(({ id: candidate }) => candidate === locationId))) {
        throw new ApiError(400, "bad_request", "Every location to restore must belong to the project.", false);
      }
      const restored = save({
        ...project, removed: false, revision: project.revision + 1,
        locations: project.locations.map((location) => request.locationIds.includes(location.id)
          ? { ...location, removed: false, removedWithProject: false, revision: location.revision + 1 } : location),
      });
      return { project: restored, locations: request.locationIds.map((locationId) => ({ id: locationId, status: "restored" as const })) };
    },
    reopenWorkspace: async (locationId: string) => {
      const { project, location } = place(locationId);
      save(replaceLocation(project, { ...location, removed: false, removedWithProject: false, revision: location.revision + 1 }));
      return { id: locationId, projectId: project.id };
    },
    removeLocation: async (locationId: string, request: { expectedRevision: number }) => {
      const { project, location } = place(locationId);
      if (location.revision !== request.expectedRevision) throw conflict("The project changed. Refresh and try again.");
      return save(replaceLocation(project, { ...location, removed: true, revision: location.revision + 1 }));
    },
    moveLocation: async (locationId: string, request: { target: ProjectAssignment; expectedRevision: number }) => {
      const { project, location } = place(locationId);
      if (location.revision !== request.expectedRevision) throw conflict("The location changed. Refresh and try again.");
      const destination = request.target.kind === "existing" ? find(request.target.projectId) : {
        id: `project-${request.target.name}`, name: request.target.name, revision: 0, membershipRevision: 0, removed: false, locations: [],
      };
      save({ ...project, membershipRevision: project.membershipRevision + 1, locations: project.locations.filter(({ id }) => id !== locationId) });
      return save({
        ...destination, membershipRevision: destination.membershipRevision + 1,
        locations: [...destination.locations, { ...location, removedWithProject: false, revision: location.revision + 1 }],
      });
    },
    mergeProject: async (id: string, request: {
      targetProjectId: string; expectedSourceMembershipRevision: number; expectedTargetMembershipRevision: number;
    }) => {
      const source = find(id);
      const target = find(request.targetProjectId);
      if (source.membershipRevision !== request.expectedSourceMembershipRevision
        || target.membershipRevision !== request.expectedTargetMembershipRevision) {
        throw conflict("The project's locations changed. Refresh and try again.");
      }
      projects = projects.filter((project) => project.id !== id);
      return save({
        ...target, membershipRevision: target.membershipRevision + 1,
        locations: [...target.locations, ...source.locations.map((location) => ({ ...location, removedWithProject: false, revision: location.revision + 1 }))],
      });
    },
  };
  return {
    project: find,
    elsewhere: operations,
    api: {
      listProjects: vi.fn(async () => ({ projects })),
      renameProject: vi.fn(operations.renameProject),
      removeProject: vi.fn(operations.removeProject),
      restoreProject: vi.fn(operations.restoreProject),
      mergeProject: vi.fn(operations.mergeProject),
      removeLocation: vi.fn(operations.removeLocation),
      moveLocation: vi.fn(operations.moveLocation),
      browseExecutionEnvironmentDirectories: vi.fn(),
    },
  };
}

function setup(initial: readonly ProjectSummary[] = [sedes, twin, retired, empty], server?: ReturnType<typeof fakeServer>) {
  let projects = initial;
  let state = {
    snapshot: {
      environments: [
        { id: "local", kind: "local", label: { text: "Local" }, available: true, directoryBrowsing: "unavailable" },
        { id: "remote", kind: "ssh", label: { text: "aw-personal" }, available: true, directoryBrowsing: "unavailable" },
      ],
      projects: projects.filter(({ removed }) => !removed).map(({ id, name, revision }) => ({ id, name, revision })),
      workspaces: projects.flatMap((project) => project.locations.filter(({ removed }) => !removed).map((entry) => ({
        id: entry.id, environmentId: entry.environmentId, projectId: project.id, label: { text: entry.label },
        displayPath: { text: entry.path }, available: entry.available,
      }))),
      threads: [
        { id: "thread-1", workspaceId: "twin-local", title: { text: "Fix login" } },
      ],
    },
  } as unknown as ApplicationClientState;
  const listeners = new Set<() => void>();
  const api = server?.api ?? {
    listProjects: vi.fn(async () => ({ projects })),
    renameProject: vi.fn(async (_id: string, request: { name: string }) => ({ ...sedes, name: request.name.trim() })),
    removeProject: vi.fn(async () => sedes),
    restoreProject: vi.fn(async (_id: string, request: { locationIds: readonly string[] }) => ({
      project: retired,
      locations: request.locationIds.map((id) => ({ id, status: "restored" as const })),
    })),
    mergeProject: vi.fn(async () => sedes),
    removeLocation: vi.fn(async () => sedes),
    moveLocation: vi.fn(async () => sedes),
    browseExecutionEnvironmentDirectories: vi.fn(),
  };
  const reopenWorkspace = vi.fn(async (id: string) => id);
  const store = {
    api, reopenWorkspace, openWorkspace: vi.fn(),
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } as unknown as ApplicationClientStore;
  render(<ProjectsSettingsPage store={store} />);
  return {
    api, reopenWorkspace,
    setProjects: (next: readonly ProjectSummary[]) => { projects = next; },
    publish: (snapshot: Partial<NonNullable<ApplicationClientState["snapshot"]>>) => {
      state = { ...state, snapshot: { ...state.snapshot!, ...snapshot } } as ApplicationClientState;
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

const projectRow = (name: string, index = 0) =>
  screen.getAllByTestId("project-settings-row").filter((row) =>
    row.querySelector(".projects-project-row .projects-row-title")?.textContent?.startsWith(name))[index]!;
const locationRows = (row: HTMLElement) =>
  within(row).queryAllByTestId("location-settings-row").map((entry) => entry.querySelector(".projects-row-path")!.textContent);

async function chooseAction(user: ReturnType<typeof userEvent.setup>, label: string, action: string) {
  await user.click(screen.getByRole("button", { name: `Actions for ${label}` }));
  await user.click(await screen.findByRole("menuitem", { name: action }));
}

async function choose(user: ReturnType<typeof userEvent.setup>, combobox: string, option: string | RegExp, scope: HTMLElement = document.body) {
  await user.click(within(scope).getByRole("combobox", { name: combobox }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("ProjectsSettingsPage", () => {
  it("lists projects with their locations, counts, availability, and removal", async () => {
    setup();
    await screen.findByText("Retired");
    expect(screen.getAllByTestId("project-settings-row").map((row) =>
      row.querySelector(".projects-project-row")!.textContent)).toEqual([
      "sedes2 locations · 1 removed", "sedes1 location", "RetiredRemoved3 locations", "Empty0 locations",
    ]);
    const local = within(projectRow("sedes")).getAllByTestId("location-settings-row")[0]!;
    expect(local).toHaveTextContent("Local");
    expect(local).toHaveTextContent("/src/sedes");
    expect(local).toHaveTextContent("3 threads");
    expect(local).toHaveTextContent("Available");
    const removed = within(projectRow("Retired")).getAllByTestId("location-settings-row")[0]!;
    expect(removed).toHaveTextContent("Build host");
    expect(removed).toHaveTextContent("Removed");
    expect(removed).toHaveTextContent("Unavailable");
    expect(screen.getByRole("status")).toHaveTextContent("4 projects");
  });

  it("filters both levels by environment, status, and search", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Retired");
    await choose(user, "Project environment", "aw-personal");
    expect(screen.getAllByTestId("project-settings-row")).toHaveLength(2);
    expect(locationRows(projectRow("sedes"))).toEqual(["/home/k/sedes"]);
    expect(locationRows(projectRow("Retired"))).toEqual(["/home/k/old"]);
    // A host no longer configured stays filterable.
    await choose(user, "Project environment", "Build host (unavailable)");
    expect(locationRows(projectRow("Retired"))).toEqual(["/srv/retired"]);
    await choose(user, "Project environment", "All environments");

    await choose(user, "Project status", "Active");
    // Empty active projects stay; the removed project and removed locations go.
    expect(screen.getAllByTestId("project-settings-row").map((row) => row.querySelector(".projects-row-title")!.textContent))
      .toEqual(["sedes", "sedes", "Empty"]);
    expect(locationRows(projectRow("sedes"))).toEqual(["/src/sedes"]);
    await choose(user, "Project status", "Removed");
    expect(screen.getAllByTestId("project-settings-row").map((row) => row.querySelector(".projects-row-title")!.textContent))
      .toEqual(["sedes", "RetiredRemoved"]);
    expect(locationRows(projectRow("sedes"))).toEqual(["/home/k/sedes"]);
    expect(screen.getByRole("status")).toHaveTextContent("2 of 4 projects");
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeVisible();

    await user.type(screen.getByRole("searchbox", { name: "Search projects" }), "OLD");
    expect(screen.getAllByTestId("project-settings-row")).toHaveLength(1);
    expect(locationRows(projectRow("Retired"))).toEqual(["/home/k/old"]);
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("searchbox", { name: "Search projects" })).toHaveFocus();
    expect(screen.getAllByTestId("project-settings-row")).toHaveLength(4);
    expect(screen.getByRole("combobox", { name: "Project status" })).toHaveTextContent("All statuses");
  });

  it("notes names shared by active projects and merges them from the note", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const note = await screen.findByText("Some projects share a name");
    const list = within(note.closest<HTMLElement>(".projects-duplicates")!).getByRole("list", { name: "Project names used more than once" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["“sedes” · 2 projectsMerge…"]);
    await user.click(within(list).getByRole("button", { name: "Merge projects named sedes" }));
    const dialog = screen.getByRole("dialog", { name: "Merge projects named “sedes”" });
    expect(dialog).toHaveTextContent("This can’t be undone.");
    // The project with fewer locations merges into the one with more.
    expect(within(dialog).getByRole("combobox", { name: "Merge" })).toHaveTextContent("sedes · /work/sedes — on Local");
    expect(within(dialog).getByRole("combobox", { name: "Into" })).toHaveTextContent("sedes · /src/sedes — on Local");
    await user.click(within(dialog).getByRole("button", { name: "Merge projects" }));
    expect(api.mergeProject).toHaveBeenCalledWith("project-twin", {
      targetProjectId: "project-sedes", expectedSourceMembershipRevision: 1, expectedTargetMembershipRevision: 5,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renames with the displayed revision and validates the name", async () => {
    const user = userEvent.setup();
    const { api } = setup([empty]);
    await screen.findByText("Empty");
    await chooseAction(user, "Empty", "Rename…");
    const dialog = screen.getByRole("dialog", { name: "Rename project “Empty”" });
    const input = within(dialog).getByRole("textbox", { name: "Project name" });
    expect(within(dialog).getByRole("button", { name: "Rename" })).toBeDisabled();
    await user.clear(input);
    expect(dialog).toHaveTextContent("Use 1 to 240 characters.");
    expect(within(dialog).getByRole("button", { name: "Rename" })).toBeDisabled();
    await user.type(input, "x".repeat(241));
    expect(within(dialog).getByRole("button", { name: "Rename" })).toBeDisabled();
    await user.clear(input);
    api.renameProject.mockRejectedValueOnce(new ApiError(409, "conflict", "The project changed. Refresh and try again.", false));
    await user.type(input, " Notes {Enter}");
    expect(api.renameProject).toHaveBeenCalledWith("project-empty", { name: " Notes ", expectedRevision: 0 });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The project changed. Refresh and try again.");
    expect(dialog).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.listProjects).toHaveBeenCalledTimes(3);
  });

  it("removes a location with today's copy and offers its project only for the last one", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await screen.findByText("Retired");
    await chooseAction(user, "Local · /src/sedes", "Remove location…");
    let dialog = screen.getByRole("dialog", { name: "Remove “sedes” from “sedes”?" });
    expect(dialog).toHaveTextContent("Hide this location (Local · /src/sedes) and its 3 threads from the working inventory.");
    expect(dialog).toHaveTextContent("Files, conversation history, and saved application data are retained");
    // Its other location is already removed, so this is the project's last active one.
    expect(within(dialog).getByRole("checkbox", { name: "Also remove project “sedes”" })).not.toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Remove location" }));
    expect(api.removeLocation).toHaveBeenCalledWith("sedes-local", { expectedRevision: 4 });
    expect(api.removeProject).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await chooseAction(user, "Local · /work/sedes", "Remove location…");
    dialog = screen.getByRole("dialog", { name: "Remove “sedes” from “sedes”?" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Also remove project “sedes”" }));
    api.removeProject.mockRejectedValueOnce(new ProjectRemovalBlockedApiError(400, "Resolve running work before removing it.", false, [
      { locationId: "twin-local", environmentId: "local", kind: "durable_work", threadIds: ["thread-1", "thread-gone"] },
    ]));
    await user.click(within(dialog).getByRole("button", { name: "Remove project" }));
    expect(api.removeProject).toHaveBeenCalledWith("project-twin", { expectedRevision: 1, expectedMembershipRevision: 1 });
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Resolve running work before removing it.");
    expect(within(alert).getByTestId("project-removal-blockers")).toHaveTextContent(
      "Local · /work/sedesStop running work: “Fix login” and 1 other thread");
    expect(dialog).toBeVisible();
  });

  it("lists every removal blocker by location in plain words", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await screen.findByText("Retired");
    // Same-named projects are told apart by their locations.
    await chooseAction(user, "sedes · /src/sedes", "Remove project…");
    const dialog = screen.getByRole("dialog", { name: "Remove project “sedes”?" });
    expect(dialog).toHaveTextContent("Hide this project, its 1 active location, and their 3 threads from the working inventory.");
    api.removeProject.mockRejectedValueOnce(new ProjectRemovalBlockedApiError(400, "Resolve work first.", false, [
      { locationId: "sedes-local", environmentId: "local", kind: "durable_work", threadIds: ["thread-1"] },
      { locationId: "sedes-local", environmentId: "local", kind: "enabled_schedule", threadIds: ["thread-a", "thread-b"] },
      { locationId: "sedes-remote", environmentId: "remote", kind: "live_terminal", threadIds: ["thread-c"] },
      { locationId: "sedes-local", environmentId: "local", kind: "busy_runtime", threadIds: ["thread-1"] },
    ]));
    await user.click(within(dialog).getByRole("button", { name: "Remove project" }));
    const blockers = await within(dialog).findByTestId("project-removal-blockers");
    const groups = [...blockers.querySelectorAll(".projects-blockers-location")];
    expect(groups.map((group) => group.querySelector("p")!.textContent)).toEqual(["Local · /src/sedes", "aw-personal · /home/k/sedes"]);
    expect([...groups[0]!.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Stop running work: “Fix login”",
      "Pause enabled schedules: 2 threads",
      "Wait for busy agents: “Fix login”",
    ]);
    expect(groups[1]).toHaveTextContent("End terminals: 1 thread");
    // The blockers clear when the removal is tried again.
    await user.click(within(dialog).getByRole("button", { name: "Remove project" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.removeProject).toHaveBeenCalledTimes(2);
  });

  it("removes an empty project without counting locations", async () => {
    const user = userEvent.setup();
    const { api } = setup([empty]);
    await screen.findByText("Empty");
    await chooseAction(user, "Empty", "Remove project…");
    const dialog = screen.getByRole("dialog", { name: "Remove project “Empty”?" });
    expect(dialog).toHaveTextContent(/^Remove project “Empty”\?Hide this project from the working inventory\./u);
    await user.click(within(dialog).getByRole("button", { name: "Remove project" }));
    expect(api.removeProject).toHaveBeenCalledWith("project-empty", { expectedRevision: 0, expectedMembershipRevision: 0 });
  });

  it("restores a project with the locations its removal took on available environments", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await screen.findByText("Retired");
    await chooseAction(user, "Retired", "Restore project…");
    const dialog = screen.getByRole("dialog", { name: "Restore project “Retired”?" });
    const group = within(dialog).getByRole("group", { name: "Locations to restore" });
    expect(within(group).getByRole("checkbox", { name: "Build host · /srv/retired (environment unavailable)" })).not.toBeChecked();
    expect(within(group).getByRole("checkbox", { name: "Local · /src/retired" })).toBeChecked();
    expect(within(group).getByRole("checkbox", { name: "aw-personal · /home/k/old" })).not.toBeChecked();
    await user.click(within(group).getByRole("checkbox", { name: "aw-personal · /home/k/old" }));
    api.restoreProject.mockResolvedValueOnce({
      project: retired,
      locations: [
        { id: "retired-local", status: "restored" },
        { id: "retired-remote", status: "failed", error: { code: "runtime_unavailable", message: "The environment is offline.", retryable: true } },
      ],
    } as never);
    await user.click(within(dialog).getByRole("button", { name: "Restore project" }));
    expect(api.restoreProject).toHaveBeenCalledWith("project-retired", { expectedRevision: 3, locationIds: ["retired-local", "retired-remote"] });
    const results = await screen.findByRole("list", { name: "Restored locations" });
    expect(within(results).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Local · /src/retiredRestored",
      "aw-personal · /home/k/oldNot restoredThe environment is offline.",
    ]);
    expect(screen.getByRole("dialog", { name: "Restored project “Retired”" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("restores a removed location of an active project in place", async () => {
    const user = userEvent.setup();
    const { reopenWorkspace, api } = setup();
    await screen.findByText("Retired");
    await chooseAction(user, "aw-personal · /home/k/sedes", "Restore location");
    expect(reopenWorkspace).toHaveBeenCalledWith("sedes-remote");
    await waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(2));
    // A removed project's locations restore with the project, not alone.
    await user.click(screen.getByRole("button", { name: "Actions for Local · /src/retired" }));
    expect(screen.queryByRole("menuitem", { name: "Restore location" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Move to project…" })).toBeVisible();
  });

  it("moves a location into an existing or a new project, saying what moves with it", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await screen.findByText("Retired");
    await chooseAction(user, "Local · /work/sedes", "Move to project…");
    let dialog = screen.getByRole("dialog", { name: "Move “sedes” to another project" });
    expect(dialog).toHaveTextContent("Local · /work/sedes leaves “sedes”. Its 1 thread, tasks, and workpads move with it.");
    expect(within(dialog).getByRole("button", { name: "Move location" })).toBeDisabled();
    await choose(user, "Move to", "Empty — no locations", dialog);
    await user.click(within(dialog).getByRole("button", { name: "Move location" }));
    expect(api.moveLocation).toHaveBeenCalledWith("twin-local", { target: { kind: "existing", projectId: "project-empty" }, expectedRevision: 7 });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await chooseAction(user, "Local · /src/sedes", "Move to project…");
    dialog = screen.getByRole("dialog", { name: "Move “sedes” to another project" });
    await choose(user, "Move to", "New project", dialog);
    const name = within(dialog).getByRole("textbox", { name: "New project name" });
    expect(name).toHaveValue("sedes");
    await user.clear(name);
    expect(within(dialog).getByRole("button", { name: "Move location" })).toBeDisabled();
    await user.type(name, "Split");
    api.moveLocation.mockRejectedValueOnce(new ApiError(400, "invalid_transition", "Resolve running, queued, or uncertain work before moving this location.", false));
    await user.click(within(dialog).getByRole("button", { name: "Move location" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Resolve running, queued, or uncertain work");
    expect(api.moveLocation).toHaveBeenLastCalledWith("sedes-local", { target: { kind: "new", name: "Split" }, expectedRevision: 4 });
  });

  it("merges a project into a chosen target, which cannot be undone", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await screen.findByText("Retired");
    await chooseAction(user, "Retired", "Merge into…");
    const dialog = screen.getByRole("dialog", { name: "Merge “Retired” into another project" });
    expect(dialog).toHaveTextContent("Every location of “Retired” (3 locations, removed ones included) moves into the chosen project");
    expect(dialog).toHaveTextContent("This can’t be undone.");
    expect(within(dialog).getByRole("button", { name: "Merge projects" })).toBeDisabled();
    await user.click(within(dialog).getByRole("combobox", { name: "Into" }));
    // Only active projects can receive locations.
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "sedes · /src/sedes — on Local", "sedes · /work/sedes — on Local", "Empty — no locations",
    ]);
    await user.click(screen.getByRole("option", { name: "Empty — no locations" }));
    await user.click(within(dialog).getByRole("button", { name: "Merge projects" }));
    expect(api.mergeProject).toHaveBeenCalledWith("project-retired", {
      targetProjectId: "project-empty", expectedSourceMembershipRevision: 9, expectedTargetMembershipRevision: 0,
    });
  });

  it("retries a rename with the revision of the reloaded project", async () => {
    const user = userEvent.setup();
    const server = fakeServer([empty]);
    setup([empty], server);
    await screen.findByText("Empty");
    await chooseAction(user, "Empty", "Rename…");
    const dialog = screen.getByRole("dialog", { name: "Rename project “Empty”" });
    await server.elsewhere.renameProject("project-empty", { name: "Notes", expectedRevision: 0 });
    const input = within(dialog).getByRole("textbox", { name: "Project name" });
    await user.clear(input);
    await user.type(input, "Docs{Enter}");
    expect(server.api.renameProject).toHaveBeenLastCalledWith("project-empty", { name: "Docs", expectedRevision: 0 });
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("“Empty” changed while this was open. Check the details and try again.");
    expect(alert).toHaveTextContent("It was renamed “Notes”.");
    expect(dialog).toHaveAccessibleName("Rename project “Notes”");
    expect(input).toHaveValue("Docs");

    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(server.api.renameProject).toHaveBeenLastCalledWith("project-empty", { name: "Docs", expectedRevision: 1 });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.project("project-empty")).toMatchObject({ name: "Docs", revision: 2 });
    expect(await screen.findByText("Docs")).toBeVisible();
  });

  it("offers removing the project again only while the location is still its last", async () => {
    const user = userEvent.setup();
    const server = fakeServer([sedes]);
    setup([sedes], server);
    await screen.findByText("sedes");
    await chooseAction(user, "Local · /src/sedes", "Remove location…");
    const dialog = screen.getByRole("dialog", { name: "Remove “sedes” from “sedes”?" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Also remove project “sedes”" }));
    // Another client restores the project's other location.
    await server.elsewhere.reopenWorkspace("sedes-remote");
    await user.click(within(dialog).getByRole("button", { name: "Remove project" }));
    expect(server.api.removeProject).toHaveBeenLastCalledWith("project-sedes", { expectedRevision: 2, expectedMembershipRevision: 5 });
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("“sedes” changed while this was open.");
    expect(alert).toHaveTextContent("Another location of “sedes” is active now, so removing this one keeps the project.");
    expect(within(dialog).queryByRole("checkbox")).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Remove location" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.api.removeLocation).toHaveBeenCalledWith("sedes-local", { expectedRevision: 4 });
    expect(server.project("project-sedes")).toMatchObject({ removed: false });
    expect(server.project("project-sedes").locations.map(({ id, removed }) => [id, removed])).toEqual([
      ["sedes-local", true], ["sedes-remote", false],
    ]);
  });

  it("moves a location from the project it has moved to since the dialog opened", async () => {
    const user = userEvent.setup();
    const server = fakeServer([sedes, twin, empty]);
    setup([sedes, twin, empty], server);
    await screen.findByText("Empty");
    await chooseAction(user, "Local · /work/sedes", "Move to project…");
    const dialog = screen.getByRole("dialog", { name: "Move “sedes” to another project" });
    await choose(user, "Move to", "Empty — no locations", dialog);
    await server.elsewhere.moveLocation("twin-local", { target: { kind: "existing", projectId: "project-sedes" }, expectedRevision: 7 });
    await user.click(within(dialog).getByRole("button", { name: "Move location" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Local · /work/sedes changed while this was open.");
    expect(alert).toHaveTextContent("It moved to project “sedes”.");
    expect(dialog).toHaveTextContent("Local · /work/sedes leaves “sedes”.");
    expect(within(dialog).getByRole("combobox", { name: "Move to" })).toHaveTextContent("Empty — no locations");

    await user.click(within(dialog).getByRole("button", { name: "Move location" }));
    expect(server.api.moveLocation).toHaveBeenLastCalledWith("twin-local", {
      target: { kind: "existing", projectId: "project-empty" }, expectedRevision: 8,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.project("project-empty").locations.map(({ id }) => id)).toEqual(["twin-local"]);
  });

  it("restores a project whose locations changed, keeping the choices that still apply", async () => {
    const user = userEvent.setup();
    const server = fakeServer([retired, empty]);
    setup([retired, empty], server);
    await screen.findByText("Retired");
    await chooseAction(user, "Retired", "Restore project…");
    const dialog = screen.getByRole("dialog", { name: "Restore project “Retired”?" });
    const group = within(dialog).getByRole("group", { name: "Locations to restore" });
    await user.click(within(group).getByRole("checkbox", { name: "aw-personal · /home/k/old" }));
    // Another client moves a preselected location out of the project.
    await server.elsewhere.moveLocation("retired-local", { target: { kind: "existing", projectId: "project-empty" }, expectedRevision: 4 });
    await user.click(within(dialog).getByRole("button", { name: "Restore project" }));
    expect(server.api.restoreProject).toHaveBeenLastCalledWith("project-retired", {
      expectedRevision: 3, locationIds: ["retired-local", "retired-remote"],
    });
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("“Retired” changed while this was open.");
    expect(alert).toHaveTextContent("It now has 0 active locations and 2 removed locations.");
    // The moved location leaves the list; the other choices stay as they were.
    expect(within(group).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(group).getByRole("checkbox", { name: "Build host · /srv/retired (environment unavailable)" })).not.toBeChecked();
    expect(within(group).getByRole("checkbox", { name: "aw-personal · /home/k/old" })).toBeChecked();

    await user.click(within(dialog).getByRole("button", { name: "Restore project" }));
    expect(server.api.restoreProject).toHaveBeenLastCalledWith("project-retired", { expectedRevision: 3, locationIds: ["retired-remote"] });
    expect(await screen.findByRole("list", { name: "Restored locations" })).toHaveTextContent("aw-personal · /home/k/oldRestored");
  });

  it("merges with the source's reloaded locations", async () => {
    const user = userEvent.setup();
    const server = fakeServer([sedes, twin, empty]);
    setup([sedes, twin, empty], server);
    await screen.findByText("Empty");
    await chooseAction(user, "Empty", "Merge into…");
    const dialog = screen.getByRole("dialog", { name: "Merge “Empty” into another project" });
    await choose(user, "Into", "sedes · /src/sedes — on Local", dialog);
    await server.elsewhere.moveLocation("twin-local", { target: { kind: "existing", projectId: "project-empty" }, expectedRevision: 7 });
    await user.click(within(dialog).getByRole("button", { name: "Merge projects" }));
    expect(server.api.mergeProject).toHaveBeenLastCalledWith("project-empty", {
      targetProjectId: "project-sedes", expectedSourceMembershipRevision: 0, expectedTargetMembershipRevision: 5,
    });
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("“Empty” changed while this was open.");
    expect(alert).toHaveTextContent("It now has 1 active location.");
    expect(alert).toHaveTextContent("Its active locations now have 1 thread.");
    expect(dialog).toHaveTextContent("Every location of “Empty” (1 location, removed ones included)");

    await user.click(within(dialog).getByRole("button", { name: "Merge projects" }));
    expect(server.api.mergeProject).toHaveBeenLastCalledWith("project-empty", {
      targetProjectId: "project-sedes", expectedSourceMembershipRevision: 1, expectedTargetMembershipRevision: 5,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.project("project-sedes").locations.map(({ id }) => id)).toEqual(["sedes-local", "sedes-remote", "twin-local"]);
  });

  it("says when the project is gone or removed, and keeps its action disabled", async () => {
    const user = userEvent.setup();
    const server = fakeServer([sedes, twin]);
    setup([sedes, twin], server);
    await screen.findByText("/work/sedes");
    await chooseAction(user, "sedes · /work/sedes", "Remove project…");
    let dialog = screen.getByRole("dialog", { name: "Remove project “sedes”?" });
    await server.elsewhere.mergeProject("project-twin", {
      targetProjectId: "project-sedes", expectedSourceMembershipRevision: 1, expectedTargetMembershipRevision: 5,
    });
    await user.click(within(dialog).getByRole("button", { name: "Remove project" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "“sedes” no longer exists. It may have been merged into another project.");
    expect(within(dialog).getByRole("button", { name: "Remove project" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await chooseAction(user, "sedes · /src/sedes", "Rename…");
    dialog = screen.getByRole("dialog", { name: "Rename project “sedes”" });
    await server.elsewhere.removeProject("project-sedes", { expectedRevision: 2, expectedMembershipRevision: 6 });
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "-main{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("“sedes” was removed while this was open.");
    expect(within(dialog).getByRole("button", { name: "Rename" })).toBeDisabled();
    expect(server.api.renameProject).toHaveBeenCalledTimes(1);
  });

  it("refetches when the snapshot republishes projects", async () => {
    const { api, publish, setProjects } = setup([empty]);
    await screen.findByText("Empty");
    expect(api.listProjects).toHaveBeenCalledTimes(1);
    setProjects([{ ...empty, name: "Renamed" }]);
    publish({ projects: [{ id: "project-empty", name: "Renamed", revision: 1 }] });
    expect(await screen.findByText("Renamed")).toBeVisible();
    expect(api.listProjects).toHaveBeenCalledTimes(2);
  });
});
