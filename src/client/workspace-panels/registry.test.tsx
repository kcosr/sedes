import { describe, expect, it, vi } from "vitest";
import {
  WorkspacePanelTenantRegistry,
  workspacePanelTenants,
  type WorkspacePanelTenant,
} from "./registry.js";

const icon = () => null;

function tenant(id: string): WorkspacePanelTenant {
  return {
    id,
    title: `Panel ${id}`,
    icon,
    scope: "thread",
    size: {
      minWidth: 280,
      minHeight: 160,
      preferredWidth: 360,
      preferredHeight: 320,
    },
    availability: () => ({ available: true }),
    render: vi.fn(() => null),
  };
}

describe("WorkspacePanelTenantRegistry", () => {
  it("rejects duplicate tenant ids", () => {
    expect(
      () => new WorkspacePanelTenantRegistry([tenant("fixture"), tenant("fixture")]),
    ).toThrowError("duplicate_workspace_panel:fixture");
  });

  it("freezes the compiled declarations and exposes exact lookup", () => {
    const original = tenant("fixture");
    const registry = new WorkspacePanelTenantRegistry([original]);
    const compiled = registry.tenant("fixture");

    expect(compiled).not.toBe(original);
    expect(compiled).toBe(registry.entries[0]);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled?.size)).toBe(true);
    expect(Object.isFrozen(registry.entries)).toBe(true);
    expect(registry.tenant("missing")).toBeUndefined();
  });

  it("ships the singleton workspace file browser", () => {
    const files = workspacePanelTenants.tenant("workspace-files");
    expect(workspacePanelTenants.entries.map(({ id }) => id)).toEqual([
      "workspace-files",
      "workpads",
      "tasks",
    ]);
    expect(workspacePanelTenants.tenant("workpads")).toMatchObject({ scope: "global", title: "Workpads" });
    expect(files).toMatchObject({
      id: "workspace-files",
      scope: "workspace",
    });
    expect(files?.availability({})).toEqual({
      available: false,
      reason: "Open a workspace to browse files.",
    });
    expect(
      files?.availability({
        workspace: {
          id: "workspace-1",
          environmentId: "local",
          projectId: "project-1",
          label: { text: "Workspace" },
          displayPath: { text: "/workspace" },
          available: true,
        },
      }),
    ).toEqual({ available: true });
    expect(
      files?.availability({
        workspace: {
          id: "workspace-1",
          environmentId: "local",
          projectId: "project-1",
          label: { text: "Workspace" },
          displayPath: { text: "/workspace" },
          available: false,
        },
      }),
    ).toEqual({ available: true });
  });

  it("ships Tasks as a tenant that renders its own header", () => {
    const tasks = workspacePanelTenants.tenant("tasks");
    expect(tasks).toMatchObject({
      id: "tasks",
      title: "Tasks",
      scope: "thread",
      header: "tenant",
      size: { minWidth: 300, preferredWidth: 380 },
    });
    expect(tasks?.availability({})).toEqual({ available: true });
    expect(workspacePanelTenants.tenant("workspace-files")?.header).toBeUndefined();
  });
});
