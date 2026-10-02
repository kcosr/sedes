import { describe, expect, it } from "vitest";
import {
  describeProjectLocations,
  summarizeHosts,
  type LocationPresentation,
  type ProjectLocationCatalog,
} from "./project-locations.js";

const environments = [
  { id: "local", kind: "local", label: { text: "Local" }, available: true },
  { id: "remote", kind: "ssh", label: { text: "aw-personal" }, available: true },
  { id: "ci", kind: "ssh", label: { text: "CI" }, available: true },
];

function location(
  id: string,
  projectId: string,
  environmentId: string,
  folder: string,
  path = `/${environmentId}/${folder}`,
): LocationPresentation {
  return {
    id,
    projectId,
    environmentId,
    label: { text: folder },
    displayPath: { text: path },
    available: true,
  };
}

function catalog(
  projects: ProjectLocationCatalog["projects"],
  workspaces: readonly LocationPresentation[],
): ProjectLocationCatalog {
  return { projects, workspaces, environments };
}

describe("project location presentation", () => {
  it("adds nothing for a project with one location", () => {
    const projects = describeProjectLocations(
      catalog(
        [{ id: "sedes", name: "sedes" }],
        [location("sedes-local", "sedes", "remote", "checkout")],
      ),
    );
    expect(projects.locationTag("sedes-local")).toBeUndefined();
    expect(projects.folderLabel("sedes-local")).toBeUndefined();
    expect(projects.projectFolderLabel("sedes-local")).toBe("sedes");
    expect(projects.projectLabel("sedes")).toBe("sedes");
  });

  it("tags only remote rows of the same repository on several hosts", () => {
    const projects = describeProjectLocations(
      catalog(
        [{ id: "sedes", name: "sedes" }],
        [
          location("sedes-local", "sedes", "local", "sedes"),
          location("sedes-remote", "sedes", "remote", "sedes"),
        ],
      ),
    );
    expect(projects.locationTag("sedes-local")).toBeUndefined();
    expect(projects.locationTag("sedes-remote")).toBe("aw-personal");
    expect(
      projects.locationTag("sedes-remote", { includeEnvironment: false }),
    ).toBeUndefined();
    expect(projects.projectFolderLabel("sedes-remote")).toBe("sedes");
    expect(
      projects.projectFolderLabel("sedes-remote", { includeEnvironment: true }),
    ).toBe("sedes · aw-personal");
    expect(
      projects.projectFolderLabel("sedes-local", { includeEnvironment: true }),
    ).toBe("sedes");
  });

  it("names the folder for several folders on one host unless it is the project's name", () => {
    const projects = describeProjectLocations(
      catalog(
        [{ id: "sedes", name: "sedes" }],
        [
          location("main", "sedes", "local", "sedes"),
          location("context", "sedes", "local", "sedes-context"),
        ],
      ),
    );
    expect(projects.locationTag("main")).toBeUndefined();
    expect(projects.locationTag("context")).toBe("sedes-context");
    expect(projects.projectFolderLabel("main")).toBe("sedes");
    expect(projects.projectFolderLabel("context")).toBe("sedes › sedes-context");
  });

  it("combines the environment and folder only where each distinguishes", () => {
    const projects = describeProjectLocations(
      catalog(
        [{ id: "sedes", name: "sedes" }],
        [
          location("local", "sedes", "local", "sedes"),
          location("remote-main", "sedes", "remote", "sedes"),
          location("remote-context", "sedes", "remote", "sedes-context"),
        ],
      ),
    );
    expect(projects.locationTag("local")).toBeUndefined();
    expect(projects.locationTag("remote-main")).toBe("aw-personal");
    expect(projects.locationTag("remote-context")).toBe(
      "aw-personal · sedes-context",
    );
  });

  it("omits the environment when every location shares one remote host", () => {
    const projects = describeProjectLocations(
      catalog(
        [{ id: "tools", name: "tools" }],
        [
          location("api", "tools", "remote", "api"),
          location("web", "tools", "remote", "web"),
        ],
      ),
    );
    expect(projects.locationTag("api")).toBe("api");
    expect(projects.locationTag("web")).toBe("web");
  });

  it("falls back to paths for same-named folders on one host", () => {
    const projects = describeProjectLocations(
      catalog(
        [{ id: "sedes", name: "sedes" }],
        [
          location("first", "sedes", "local", "sedes", "/src/sedes"),
          location("second", "sedes", "local", "sedes", "/worktrees/x/sedes"),
        ],
      ),
    );
    expect(projects.locationTag("first")).toBe("sedes · /src/sedes");
    expect(projects.locationTag("second")).toBe("sedes · /worktrees/x/sedes");
    expect(projects.projectFolderLabel("second")).toBe(
      "sedes › sedes · /worktrees/x/sedes",
    );
  });

  it("disambiguates same-named projects by environment, else by path", () => {
    const byHost = describeProjectLocations(
      catalog(
        [
          { id: "local-sedes", name: "sedes" },
          { id: "remote-sedes", name: "sedes" },
        ],
        [
          location("a", "local-sedes", "local", "sedes"),
          location("b", "remote-sedes", "remote", "sedes"),
        ],
      ),
    );
    expect(byHost.projectLabel("local-sedes")).toBe("sedes");
    expect(byHost.projectLabel("remote-sedes")).toBe("sedes · aw-personal");
    // Cards name the project as pickers do, without repeating its host.
    expect(byHost.projectFolderLabel("b")).toBe("sedes · aw-personal");
    expect(
      byHost.projectFolderLabel("b", { includeEnvironment: true }),
    ).toBe("sedes · aw-personal");

    const byPath = describeProjectLocations(
      catalog(
        [
          { id: "first", name: "sedes" },
          { id: "second", name: "sedes" },
          { id: "empty", name: "sedes" },
        ],
        [
          location("a", "first", "local", "sedes", "/src/sedes"),
          location("b", "second", "local", "sedes", "/work/sedes"),
          location("c", "second", "remote", "sedes", "/srv/sedes"),
        ],
      ),
    );
    expect(byPath.projectLabel("first")).toBe("sedes · /src/sedes");
    expect(byPath.projectLabel("second")).toBe("sedes · /work/sedes +1");
    expect(byPath.projectLabel("empty")).toBe("sedes · No locations");
    // The path hint names only its first location's environment.
    expect(
      byPath.projectFolderLabel("c", { includeEnvironment: true }),
    ).toBe("sedes · /work/sedes +1 · aw-personal");
  });

  it("keeps a location's own host when its project's hint names several", () => {
    const projects = describeProjectLocations(
      catalog(
        [
          { id: "spread", name: "sedes" },
          { id: "home", name: "sedes" },
        ],
        [
          location("on-remote", "spread", "remote", "sedes"),
          location("on-ci", "spread", "ci", "sedes"),
          location("on-local", "home", "local", "sedes"),
        ],
      ),
    );
    expect(projects.projectLabel("spread")).toBe("sedes · aw-personal, CI");
    expect(
      projects.projectFolderLabel("on-remote", { includeEnvironment: true }),
    ).toBe("sedes · aw-personal, CI · aw-personal");
    expect(
      projects.projectFolderLabel("on-ci", { includeEnvironment: true }),
    ).toBe("sedes · aw-personal, CI · CI");
    expect(projects.projectFolderLabel("on-remote")).toBe(
      "sedes · aw-personal, CI",
    );
    expect(
      projects.projectFolderLabel("on-local", { includeEnvironment: true }),
    ).toBe("sedes");
  });

  it("does not repeat the one host a path hint already names", () => {
    const projects = describeProjectLocations(
      catalog(
        [
          { id: "first", name: "sedes" },
          { id: "second", name: "sedes" },
        ],
        [
          location("a", "first", "remote", "sedes", "/srv/a"),
          location("b", "second", "remote", "sedes", "/srv/b"),
        ],
      ),
    );
    expect(projects.projectLabel("first")).toBe("sedes · aw-personal · /srv/a");
    expect(
      projects.projectFolderLabel("a", { includeEnvironment: true }),
    ).toBe("sedes · aw-personal · /srv/a");
  });

  it("falls back to an ID suffix when location hints still collide", () => {
    const projects = describeProjectLocations(
      catalog(
        [
          { id: "project-aaaaaa", name: "notes" },
          { id: "project-bbbbbb", name: "notes" },
        ],
        [],
      ),
    );
    expect(projects.projectLabel("project-aaaaaa")).toBe(
      "notes · No locations · aaaaaa",
    );
    expect(projects.projectLabel("project-bbbbbb")).toBe(
      "notes · No locations · bbbbbb",
    );
  });

  it("names a project header's one remote host unless Scope implies it", () => {
    const projects = describeProjectLocations(
      catalog(
        [
          { id: "remote-only", name: "sedes" },
          { id: "local-only", name: "notes" },
          { id: "spread", name: "tools" },
          { id: "empty", name: "empty" },
          { id: "folders", name: "web" },
        ],
        [
          location("r", "remote-only", "remote", "sedes"),
          location("l", "local-only", "local", "notes"),
          location("s-local", "spread", "local", "tools"),
          location("s-remote", "spread", "remote", "tools"),
          location("f-api", "folders", "remote", "api"),
          location("f-site", "folders", "remote", "site"),
        ],
      ),
    );
    const header = (id: string) =>
      projects.projectHeaderLabel(id, { includeEnvironment: true });
    // As the per-location header did: "sedes · aw-personal".
    expect(header("remote-only")).toBe("sedes · aw-personal");
    expect(header("folders")).toBe("web · aw-personal");
    // Local is never named; several hosts leave it to the rows.
    expect(header("local-only")).toBe("notes");
    expect(header("spread")).toBe("tools");
    expect(header("empty")).toBe("empty");
    // Scope already implies the environment.
    expect(projects.projectHeaderLabel("remote-only")).toBe("sedes");
    expect(
      projects.projectHeaderLabel("remote-only", { includeEnvironment: false }),
    ).toBe("sedes");
    expect(projects.projectHeaderLabel("missing")).toBeUndefined();
  });

  it("does not repeat a host a same-named project's header already names", () => {
    const byHost = describeProjectLocations(
      catalog(
        [
          { id: "local-sedes", name: "sedes" },
          { id: "remote-sedes", name: "sedes" },
          { id: "spread-sedes", name: "sedes" },
        ],
        [
          location("a", "local-sedes", "local", "sedes"),
          location("b", "remote-sedes", "remote", "sedes"),
          location("c", "spread-sedes", "remote", "sedes"),
          location("d", "spread-sedes", "ci", "sedes"),
        ],
      ),
    );
    const header = (id: string) =>
      byHost.projectHeaderLabel(id, { includeEnvironment: true });
    expect(header("local-sedes")).toBe("sedes");
    expect(header("remote-sedes")).toBe("sedes · aw-personal");
    expect(header("spread-sedes")).toBe("sedes · aw-personal, CI");

    const byPath = describeProjectLocations(
      catalog(
        [
          { id: "first", name: "sedes" },
          { id: "second", name: "sedes" },
        ],
        [
          location("a", "first", "ci", "sedes", "/srv/a"),
          location("b", "second", "ci", "sedes", "/srv/b"),
        ],
      ),
    );
    expect(
      byPath.projectHeaderLabel("first", { includeEnvironment: true }),
    ).toBe("sedes · CI · /srv/a");
  });

  it("describes projects in pickers by up to two hosts", () => {
    const projects = describeProjectLocations({
      ...catalog(
        [
          { id: "sedes", name: "sedes" },
          { id: "notes", name: "notes" },
          { id: "empty", name: "empty" },
        ],
        [
          location("ci", "sedes", "ci", "sedes"),
          location("build", "sedes", "build", "sedes"),
          location("remote", "sedes", "remote", "sedes"),
          location("local", "sedes", "local", "sedes"),
          location("remote-2", "sedes", "remote", "sedes-context"),
          location("notes", "notes", "remote", "notes"),
        ],
      ),
      environments: [
        ...environments,
        { id: "build", kind: "ssh", label: { text: "build-box" }, available: true },
      ],
    });
    expect(projects.projectChoice("sedes")).toEqual({
      label: "sedes — on Local, aw-personal +2",
      title: "sedes — on Local, aw-personal, build-box, CI",
    });
    expect(projects.projectChoice("notes")).toEqual({
      label: "notes — on aw-personal",
      title: "notes — on aw-personal",
    });
    expect(projects.projectChoice("empty")).toEqual({
      label: "empty — no locations",
      title: "empty — no locations",
    });
    expect(projects.projectChoice("missing")).toBeUndefined();
    // Each host once, Local first.
    expect(projects.projectHosts("sedes")).toEqual(["Local", "aw-personal", "build-box", "CI"]);
    expect(projects.projectHosts("empty")).toEqual([]);
    expect(summarizeHosts(["Local", "aw-personal"])).toBe("Local, aw-personal");
    expect(summarizeHosts(projects.projectHosts("sedes"))).toBe("Local, aw-personal +2");
  });

  it("describes locations for pickers with their environment and path", () => {
    const projects = describeProjectLocations(
      catalog(
        [{ id: "sedes", name: "sedes" }],
        [location("remote", "sedes", "remote", "sedes", "/srv/sedes")],
      ),
    );
    expect(projects.locationLabel("remote")).toBe("aw-personal · /srv/sedes");
    expect(projects.projectLocationLabel("remote")).toBe(
      "sedes · aw-personal · /srv/sedes",
    );
    expect(projects.projectPathLabel("remote")).toBe("sedes · /srv/sedes");
    const single = describeProjectLocations({
      projects: [{ id: "sedes", name: "sedes" }],
      workspaces: [location("only", "sedes", "local", "sedes", "/src/sedes")],
      environments: [environments[0]!],
    });
    expect(single.locationLabel("only")).toBe("/src/sedes");
    expect(single.projectForLocation("only")?.id).toBe("sedes");
    expect(single.locationsOf("sedes").map(({ id }) => id)).toEqual(["only"]);
  });
});
