// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectLocation, ProjectSummary } from "../../../shared/index.js";
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

function setup(initial: readonly ProjectSummary[] = [sedes, twin, retired, empty]) {
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
  const api = {
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
