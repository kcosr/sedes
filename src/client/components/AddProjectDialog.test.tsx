// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocationConflict,
  NormalizedEnvironmentSummary,
  NormalizedProjectSummary,
  NormalizedWorkspaceSummary,
  RestoredLocationResult,
} from "../../shared/index.js";
import { LocationConflictApiError } from "../api/ApiClient.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { AddProjectDialog, NEW_PROJECT, preselectedProjectId } from "./AddProjectDialog.js";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const environments: readonly NormalizedEnvironmentSummary[] = [
  { id: "local", kind: "local", label: { text: "Local" }, available: true, directoryBrowsing: "unavailable" },
  { id: "remote", kind: "ssh", label: { text: "aw-personal" }, available: true, directoryBrowsing: "unavailable" },
  { id: "ci", kind: "ssh", label: { text: "CI" }, available: true, directoryBrowsing: "unavailable" },
];
const projects: readonly NormalizedProjectSummary[] = [
  { id: "project-sedes", name: "sedes", revision: 1 },
  { id: "project-notes", name: "notes", revision: 1 },
  { id: "project-wide", name: "wide", revision: 1 },
];
function workspace(id: string, projectId: string, environmentId: string, folder: string): NormalizedWorkspaceSummary {
  return { id, projectId, environmentId, label: { text: folder }, displayPath: { text: `/${environmentId}/${folder}` }, available: true };
}
const workspaces: readonly NormalizedWorkspaceSummary[] = [
  workspace("sedes-remote", "project-sedes", "remote", "sedes"),
  workspace("notes-local", "project-notes", "local", "notes"),
  workspace("wide-local", "project-wide", "local", "wide"),
  workspace("wide-remote", "project-wide", "remote", "wide"),
  workspace("wide-ci", "project-wide", "ci", "wide"),
];
const conflict: LocationConflict = {
  reason: "other_project", workspaceId: "existing-location", locationRevision: 6, locationRemoved: false,
  projectId: "project-old", projectName: "Old home", projectRevision: 2,
};

function setup(options: { readonly projectId?: string; readonly environmentLocked?: boolean } = {}) {
  const api = {
    browseExecutionEnvironmentDirectories: vi.fn(),
    moveLocation: vi.fn(async () => ({})),
    restoreProject: vi.fn(async (): Promise<{ project: unknown; locations: readonly RestoredLocationResult[] }> => ({
      project: {}, locations: [{ id: conflict.workspaceId, status: "restored" }],
    })),
  };
  const openWorkspace = vi.fn(async () => "added-location");
  const reopenWorkspace = vi.fn(async (id: string) => id);
  const onAdded = vi.fn();
  const onClose = vi.fn();
  const store = { api, openWorkspace, reopenWorkspace } as unknown as Pick<ApplicationClientStore, "api" | "openWorkspace" | "reopenWorkspace">;
  render(<AddProjectDialog store={store} environments={environments} projects={projects} workspaces={workspaces}
    initialEnvironmentId="local" environmentLocked={options.environmentLocked ?? false}
    {...(options.projectId === undefined ? {} : { projectId: options.projectId })}
    onAdded={onAdded} onClose={onClose} />);
  return { api, openWorkspace, reopenWorkspace, onAdded, onClose };
}

const dialog = (name = "Add project") => screen.getByRole("dialog", { name });
const project = () => within(dialog()).getByRole("combobox", { name: "Project" });
async function enterPath(user: ReturnType<typeof userEvent.setup>, path: string, title = "Add project") {
  await user.type(within(dialog(title)).getByRole("textbox", { name: "Absolute directory path" }), path);
}

describe("preselectedProjectId", () => {
  it("joins only the one same-named project without a location on the environment", () => {
    const catalog = { projects, workspaces };
    // The same repository on another host.
    expect(preselectedProjectId(catalog, "sedes", "local")).toBe("project-sedes");
    // Already on this host: another checkout here is likely separate work.
    expect(preselectedProjectId(catalog, "sedes", "remote")).toBe(NEW_PROJECT);
    expect(preselectedProjectId(catalog, "unknown", "local")).toBe(NEW_PROJECT);
    const twins = { projects: [...projects, { id: "project-twin", name: "sedes", revision: 0 }], workspaces };
    expect(preselectedProjectId(twins, "sedes", "local")).toBe(NEW_PROJECT);
  });
});

describe("AddProjectDialog", () => {
  it("starts a new project named by the folder, with an editable name", async () => {
    const user = userEvent.setup();
    const { openWorkspace, onAdded, onClose } = setup();
    await enterPath(user, "/src/billing/");
    expect(project()).toHaveTextContent("New project");
    const name = within(dialog()).getByRole("textbox", { name: "New project name" });
    expect(name).toHaveValue("billing");
    await user.clear(name);
    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("Enter a project name of 1 to 240 characters.");
    await user.type(name, "Billing service");
    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    expect(openWorkspace).toHaveBeenCalledWith("/src/billing/", "local", { kind: "new", name: "Billing service" });
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("added-location", "local"));
    expect(onClose).toHaveBeenCalled();
  });

  it("preselects the same-named project from another host and describes projects by host", async () => {
    const user = userEvent.setup();
    const { openWorkspace } = setup();
    await enterPath(user, "/src/sedes");
    expect(project()).toHaveTextContent("sedes — on aw-personal");
    expect(within(dialog()).queryByRole("textbox", { name: "New project name" })).toBeNull();
    await user.click(project());
    const wide = screen.getByRole("option", { name: "wide — on Local, aw-personal +1" });
    expect(wide).toHaveAttribute("title", "wide — on Local, aw-personal, CI");
    await user.keyboard("{Escape}");
    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    expect(openWorkspace).toHaveBeenCalledWith("/src/sedes", "local", { kind: "existing", projectId: "project-sedes" });
  });

  it("keeps a chosen project when the directory changes", async () => {
    const user = userEvent.setup();
    const { openWorkspace } = setup();
    await enterPath(user, "/src/sedes");
    await user.click(project());
    await user.click(screen.getByRole("option", { name: "New project" }));
    await enterPath(user, "-copy");
    expect(within(dialog()).getByRole("textbox", { name: "New project name" })).toHaveValue("sedes-copy");
    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    expect(openWorkspace).toHaveBeenCalledWith("/src/sedes-copy", "local", { kind: "new", name: "sedes-copy" });
  });

  it("offers to move a directory that is already in another project here", async () => {
    const user = userEvent.setup();
    const { api, openWorkspace, reopenWorkspace, onAdded } = setup();
    openWorkspace.mockRejectedValueOnce(new LocationConflictApiError(409, "conflict", "This directory already belongs to another project. Move it instead.", false, conflict));
    await enterPath(user, "/src/notes");
    await user.click(project());
    await user.click(screen.getByRole("option", { name: "notes — on Local" }));
    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    const alert = await within(dialog()).findByRole("alert");
    expect(alert).toHaveTextContent("Already in project “Old home”");
    expect(alert).toHaveTextContent("Move it to “notes”; its threads, tasks, and workpads move with it.");
    await user.click(within(alert).getByRole("button", { name: "Move here" }));
    expect(api.moveLocation).toHaveBeenCalledWith("existing-location", {
      target: { kind: "existing", projectId: "project-notes" }, expectedRevision: 6,
    });
    expect(reopenWorkspace).not.toHaveBeenCalled();
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("existing-location", "local"));
  });

  it("moves and restores a removed location, or restores it in its own project", async () => {
    const user = userEvent.setup();
    const { api, openWorkspace, reopenWorkspace, onAdded } = setup();
    const removed = { ...conflict, locationRemoved: true };
    openWorkspace.mockRejectedValue(new LocationConflictApiError(409, "conflict", "Move it instead.", false, removed));
    await enterPath(user, "/src/notes");
    await user.click(project());
    await user.click(screen.getByRole("option", { name: "notes — on Local" }));
    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    let alert = await within(dialog()).findByRole("alert");
    expect(alert).toHaveTextContent("Removed from project “Old home”");
    await user.click(within(alert).getByRole("button", { name: "Restore in “Old home”" }));
    expect(reopenWorkspace).toHaveBeenCalledWith("existing-location");
    expect(api.moveLocation).not.toHaveBeenCalled();
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("existing-location", "local"));

    cleanup();
    const second = setup();
    second.openWorkspace.mockRejectedValue(new LocationConflictApiError(409, "conflict", "Move it instead.", false, removed));
    await enterPath(user, "/src/notes");
    await user.click(project());
    await user.click(screen.getByRole("option", { name: "notes — on Local" }));
    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    alert = await within(dialog()).findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Move here" }));
    expect(second.api.moveLocation).toHaveBeenCalledWith("existing-location", {
      target: { kind: "existing", projectId: "project-notes" }, expectedRevision: 6,
    });
    expect(second.reopenWorkspace).toHaveBeenCalledWith("existing-location");
  });

  it("restores a removed project, or adds the directory to another project", async () => {
    const user = userEvent.setup();
    const { api, openWorkspace, onAdded } = setup();
    const removedProject = { ...conflict, reason: "project_removed" as const, locationRemoved: true };
    openWorkspace.mockRejectedValue(new LocationConflictApiError(400, "invalid_transition", "The project was removed.", false, removedProject));
    await enterPath(user, "/src/old");
    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    let alert = await within(dialog()).findByRole("alert");
    expect(alert).toHaveTextContent("Project “Old home” was removed");
    expect(alert).toHaveTextContent("add the directory to a new project “old” instead.");
    api.restoreProject.mockResolvedValueOnce({
      project: {},
      locations: [{ id: "existing-location", status: "failed", error: { code: "runtime_unavailable", message: "The environment is offline.", retryable: true } }],
    });
    await user.click(within(alert).getByRole("button", { name: "Restore project “Old home”" }));
    expect(api.restoreProject).toHaveBeenCalledWith("project-old", { expectedRevision: 2, locationIds: ["existing-location"] });
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(
      "Restored project “Old home”, but not this location: The environment is offline.");
    expect(onAdded).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    alert = await within(dialog()).findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Restore project “Old home”" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("existing-location", "local"));

    cleanup();
    const other = setup();
    other.openWorkspace.mockRejectedValue(new LocationConflictApiError(400, "invalid_transition", "The project was removed.", false, removedProject));
    await enterPath(user, "/src/old");
    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    alert = await within(dialog()).findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Add to another project" }));
    expect(other.api.moveLocation).toHaveBeenCalledWith("existing-location", {
      target: { kind: "new", name: "old" }, expectedRevision: 6,
    });
    expect(other.reopenWorkspace).toHaveBeenCalledWith("existing-location");
    await waitFor(() => expect(other.onAdded).toHaveBeenCalledWith("existing-location", "local"));
  });

  it("adds a location to a fixed project from its menu", async () => {
    const user = userEvent.setup();
    const { openWorkspace } = setup({ projectId: "project-wide" });
    const location = dialog("Add location");
    expect(location).toHaveTextContent("Choose a directory or enter its absolute path to add to “wide”.");
    expect(within(location).getByRole("textbox", { name: "Project" })).toHaveValue("wide");
    expect(within(location).queryByRole("combobox", { name: "Project" })).toBeNull();
    await enterPath(user, "/src/wide-docs", "Add location");
    await user.click(within(location).getByRole("button", { name: "Add location" }));
    expect(openWorkspace).toHaveBeenCalledWith("/src/wide-docs", "local", { kind: "existing", projectId: "project-wide" });
  });

  it("keeps the environment locked to the sidebar scope", () => {
    setup({ environmentLocked: true });
    expect(within(dialog()).getByRole("textbox", { name: "Environment" })).toHaveValue("Local");
  });
});
