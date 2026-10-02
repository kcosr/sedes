// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationSnapshot } from "../../../shared/index.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import { ThreadLoadingView } from "./ThreadLoadingView.js";

type CatalogWorkspace = NormalizedApplicationSnapshot["workspaces"][number];

const localEnvironment = {
  id: "environment-local",
  kind: "local" as const,
  label: { text: "Local" },
  available: true,
  directoryBrowsing: "available" as const,
};
const remoteEnvironment = {
  id: "environment-remote",
  kind: "ssh" as const,
  label: { text: "Build host" },
  available: true,
  directoryBrowsing: "available" as const,
};
const threadLocation: CatalogWorkspace = {
  id: "workspace-1",
  environmentId: localEnvironment.id,
  projectId: "project-1",
  label: { text: "sedes-context" },
  displayPath: { text: "/src/sedes-context" },
  available: true,
};
const siblingLocation: CatalogWorkspace = {
  id: "workspace-2",
  environmentId: localEnvironment.id,
  projectId: "project-1",
  label: { text: "sedes" },
  displayPath: { text: "/src/sedes" },
  available: true,
};

function renderLoadingView({
  workspaces,
  environments = [localEnvironment],
}: {
  readonly workspaces: readonly CatalogWorkspace[];
  readonly environments?: readonly (
    | typeof localEnvironment
    | typeof remoteEnvironment
  )[];
}) {
  const state = {
    status: "ready",
    connection: "connected",
    authoritative: true,
    search: "",
    descendantPages: {},
    pendingThreadConfigurationCopySourceIds: [],
    visibleThreads: [],
    snapshot: {
      environments,
      projects: [{ id: "project-1", name: "sedes", revision: 0 }],
      workspaces,
      threads: [
        {
          id: "thread-1",
          workspaceId: threadLocation.id,
          targetId: "target-1",
          title: { text: "Loading thread" },
          backend: { label: { text: "Pi" }, brand: "pi" },
          preferredWorktree: null,
        },
      ],
      executionTargets: [
        {
          id: "target-1",
          environmentId: threadLocation.environmentId,
          label: { text: "Pi SDK" },
          available: true,
        },
      ],
    },
  } as unknown as ApplicationClientState;
  const applicationStore = {
    subscribe: () => () => undefined,
    getSnapshot: () => state,
  } as unknown as ApplicationClientStore;
  render(
    <ThreadLoadingView threadId="thread-1" applicationStore={applicationStore} />,
  );
  return screen.getByTestId("thread-context");
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThreadLoadingView project row", () => {
  it("names a single-location project by its name alone", () => {
    const context = renderLoadingView({ workspaces: [threadLocation] });

    expect(context.querySelector(".thread-project-name")).toHaveTextContent(
      /^sedes$/u,
    );
    expect(context).toHaveAttribute("title", "sedes · Pi SDK");
  });

  it("adds the folder when the project has another location on the environment", () => {
    const context = renderLoadingView({
      workspaces: [threadLocation, siblingLocation],
    });

    expect(context.querySelector(".thread-project-name")).toHaveTextContent(
      /^sedes › sedes-context$/u,
    );
  });

  it("qualifies a remote location by its environment", () => {
    const context = renderLoadingView({
      workspaces: [
        { ...threadLocation, environmentId: remoteEnvironment.id },
        siblingLocation,
      ],
      environments: [localEnvironment, remoteEnvironment],
    });

    expect(context.querySelector(".thread-project-name")).toHaveTextContent(
      /^sedes · Build host$/u,
    );
  });
});
