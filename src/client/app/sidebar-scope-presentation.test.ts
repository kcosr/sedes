import { describe, expect, it } from "vitest";
import {
  environmentDisplayLabel,
  scopeSummaryPresentation,
  scopeSummaryLabel,
  targetDisplayLabel,
  workspaceDisplayLabel,
} from "./sidebar-scope-presentation.js";

const environments = [
  { id: "environment-local", label: { text: "Local" }, available: true },
  { id: "environment-ssh", label: { text: "Build host" }, available: true },
];
const workspaces = [
  {
    id: "workspace-local",
    environmentId: "environment-local",
    label: { text: "agent-workspaces" },
    displayPath: { text: "/home/me/agent-workspaces" },
    available: true,
  },
  {
    id: "workspace-ssh",
    environmentId: "environment-ssh",
    label: { text: "agent-workspaces" },
    displayPath: { text: "/srv/agent-workspaces" },
    available: true,
  },
];

describe("sidebar scope presentation", () => {
  it("keeps a project-only scope independent of environment", () => {
    expect(
      scopeSummaryLabel({
        projectName: workspaces[1]!.label.text,
        environments,
        targets: [],
        workspaces,
      }),
    ).toBe("agent-workspaces");
  });

  it("does not treat an equivalent catalog copy as a label collision", () => {
    expect(
      environmentDisplayLabel(
        { ...environments[0]!, label: { ...environments[0]!.label } },
        environments,
      ),
    ).toBe("Local");
  });

  it("adds paths only for same-environment project collisions", () => {
    const duplicate = {
      id: "workspace-ssh-2",
      environmentId: "environment-ssh",
      label: { text: "agent-workspaces" },
      displayPath: { text: "/opt/agent-workspaces" },
      available: true,
    };
    expect(
      workspaceDisplayLabel({
        workspace: workspaces[1]!,
        workspaces: [...workspaces, duplicate],
        environments,
        includeEnvironment: true,
      }),
    ).toBe("agent-workspaces · Build host · /srv/agent-workspaces");
  });

  it("expands colliding environment and target suffixes until unique", () => {
    const duplicateEnvironments = [
      {
        id: "environment-alpha-abcdef",
        label: { text: "Build host" },
        available: true,
      },
      {
        id: "environment-beta-abcdef",
        label: { text: "Build host" },
        available: true,
      },
    ];
    expect(
      environmentDisplayLabel(duplicateEnvironments[0]!, duplicateEnvironments),
    ).toBe("Build host · ha-abcdef");
    expect(
      environmentDisplayLabel(duplicateEnvironments[1]!, duplicateEnvironments),
    ).toBe("Build host · ta-abcdef");

    const targets = [
      {
        id: "target-alpha-abcdef",
        environmentId: duplicateEnvironments[0]!.id,
        label: { text: "Codex" },
        backend: { label: { text: "Codex" }, brand: "codex" },
        available: true,
      },
      {
        id: "target-beta-abcdef",
        environmentId: duplicateEnvironments[0]!.id,
        label: { text: "Codex" },
        backend: { label: { text: "Codex" }, brand: "codex" },
        available: true,
      },
    ];
    expect(
      targetDisplayLabel({
        target: targets[0]!,
        targets,
        environments: duplicateEnvironments,
        includeEnvironment: false,
      }),
    ).toBe("Codex · ha-abcdef");
    expect(
      targetDisplayLabel({
        target: targets[1]!,
        targets,
        environments: duplicateEnvironments,
        includeEnvironment: false,
      }),
    ).toBe("Codex · ta-abcdef");
  });

  it("bounds the visible hierarchy while preserving full unavailable detail", () => {
    const presentation = scopeSummaryPresentation({
      environment: { ...environments[1]!, available: false },
      target: {
        id: "target-ssh",
        environmentId: "environment-ssh",
        label: { text: "Codex SSH" },
        backend: { label: { text: "Codex" }, brand: "codex" },
        available: false,
      },
      projectName: workspaces[1]!.label.text,
      environments: [{ ...environments[1]!, available: false }],
      targets: [],
      workspaces,
      maxVisibleParts: 2,
    });
    expect(presentation.fullLabel).toContain("Build host — Unavailable");
    expect(presentation.fullLabel).toContain("Codex SSH · Codex — Unavailable");
    expect(presentation.fullLabel).toContain("agent-workspaces");
    expect(presentation.visibleLabel).toMatch(/ \+1$/);
  });
});
