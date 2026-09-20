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
    preferredPlacement: { edge: "right" },
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
    expect(Object.isFrozen(compiled?.preferredPlacement)).toBe(true);
    expect(Object.isFrozen(registry.entries)).toBe(true);
    expect(registry.tenant("missing")).toBeUndefined();
  });

  it("ships the singleton workspace file browser", () => {
    const files = workspacePanelTenants.tenant("workspace-files");
    expect(workspacePanelTenants.entries).toHaveLength(2);
    expect(workspacePanelTenants.tenant("workpads")).toMatchObject({ scope: "global", title: "Workpads", preferredPlacement: { edge: "right" } });
    expect(files).toMatchObject({
      id: "workspace-files",
      scope: "workspace",
      preferredPlacement: { edge: "right" },
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
          label: { text: "Workspace" },
          displayPath: { text: "/workspace" },
          available: false,
        },
      }),
    ).toEqual({ available: true });
  });
});
