// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NormalizedExecutionTargetDescriptor,
  NormalizedWorkspaceSummary,
  ThreadTemplate,
} from "../../shared/index.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { NewThreadControl } from "./NewThreadControl.js";

const workspace = {
  id: "workspace-1",
  environmentId: "environment-1",
  label: { text: "Sedes" },
  displayPath: { text: "/workspace/sedes" },
  available: true,
};

const secondWorkspace = {
  id: "workspace-2",
  environmentId: "environment-2",
  label: { text: "Website" },
  displayPath: { text: "/workspace/website" },
  available: true,
};

const environments = [
  {
    id: "environment-1",
    kind: "local" as const,
    label: { text: "Local" },
    available: true as const,
    directoryBrowsing: "unavailable" as const,
  },
  {
    id: "environment-2",
    kind: "ssh" as const,
    label: { text: "Remote" },
    available: true as const,
    directoryBrowsing: "unavailable" as const,
  },
];

const targets: readonly NormalizedExecutionTargetDescriptor[] = [
  {
    id: "target-pi",
    environmentId: "environment-1",
    label: { text: "Local SDK" },
    backend: { label: { text: "Pi" }, brand: "pi" as const },
    workspaceExecution: { kind: "direct_only" as const },
    available: true as const,
  },
  {
    id: "target-codex",
    environmentId: "environment-1",
    label: { text: "Local app server" },
    backend: { label: { text: "Codex" }, brand: "codex" as const },
    workspaceExecution: { kind: "direct_only" as const },
    available: true as const,
  },
  {
    id: "target-website",
    environmentId: "environment-2",
    label: { text: "Website agent" },
    backend: { label: { text: "Pi" }, brand: "pi" as const },
    workspaceExecution: { kind: "direct_only" as const },
    available: true as const,
  },
];

const carefulAgent = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Careful",
  backendTypeId: "pi",
  backend: { typeId: "pi", label: { text: "Pi" }, brand: "pi" },
  overrideCount: 2,
  sedesTools: null,
  revision: 0,
  createdAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:00.000Z",
};

const replacementAgent = {
  ...carefulAgent,
  id: "66666666-6666-4666-8666-666666666666",
  name: "Replacement",
};

const carefulTemplate: ThreadTemplate = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Careful launch",
  workspaceId: workspace.id,
  targetId: "target-pi",
  executionWorkspace: { kind: "direct" },
  agentId: carefulAgent.id,
  capturedAgentName: carefulAgent.name,
  capturedWorkspaceName: workspace.label.text,
  capturedTargetName: "Local SDK",
  revision: 0,
  createdAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:00.000Z",
};

function candidate(
  id: string,
  label: string,
  accessBoundary: "thread" | "environment" | "unrestricted" = "environment",
  toolsEnabled = false,
) {
  return {
    target: {
      id,
      label: { text: label },
      backend: { typeId: "pi", label: { text: "Pi" }, brand: "pi" },
    },
    configuration: {
      backendTypeId: "pi",
      fields: [],
      canonicalOverrides: [],
    },
    sedesTools: {
      defaultPolicy: {
        enabled: false,
        enabledToolIds: [],
        presentation: { surface: "native", mode: "progressive" },
        accessBoundary,
      },
      resolvedPolicy: {
        enabled: toolsEnabled,
        enabledToolIds: [],
        presentation: { surface: "native", mode: "progressive" },
        accessBoundary,
      },
      groups: [],
      presentationOptions: [
        { surface: "native", modes: ["progressive", "individual"] },
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
    },
  };
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  Object.assign(window.HTMLElement.prototype, {
    scrollIntoView: vi.fn(),
    hasPointerCapture: vi.fn(),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function control(options?: {
  readonly workspaces?: readonly NormalizedWorkspaceSummary[];
  readonly agents?: readonly (typeof carefulAgent)[];
  readonly resolution?: {
    candidates: readonly ReturnType<typeof candidate>[];
    failures: readonly unknown[];
  };
  readonly createThread?: ReturnType<typeof vi.fn>;
  readonly getSavedAgent?: ReturnType<typeof vi.fn>;
  readonly getEnvironmentVariablePreview?: ReturnType<typeof vi.fn>;
  readonly listSavedAgents?: ReturnType<typeof vi.fn>;
  readonly listThreadTemplates?: ReturnType<typeof vi.fn>;
  readonly templates?: readonly ThreadTemplate[];
  readonly createThreadTemplate?: ReturnType<typeof vi.fn>;
  readonly updateThreadTemplate?: ReturnType<typeof vi.fn>;
  readonly deleteThreadTemplate?: ReturnType<typeof vi.fn>;
  readonly constrainedWorkspace?: typeof workspace;
  readonly allWorkspaces?: boolean;
  readonly executionTargets?: readonly NormalizedExecutionTargetDescriptor[];
  readonly creationScope?: {
    readonly environmentId: string | null;
    readonly targetId: string | null;
    readonly projectName: string | null;
  };
}) {
  const createThread =
    options?.createThread ??
    vi.fn().mockResolvedValue({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      targetId: "target-pi",
    });
  const api = {
    getEnvironmentVariablePreview: options?.getEnvironmentVariablePreview ?? vi.fn().mockResolvedValue({ snapshot: { version: 1, layers: { environment: {}, backend: {}, agent: {}, thread: {} } }, revision: { configurationRevision: 1 }, startup: { supported: true } }),
    listThreadTemplates:
      options?.listThreadTemplates ??
      vi.fn().mockResolvedValue({ items: options?.templates ?? [] }),
    createThreadTemplate:
      options?.createThreadTemplate ??
      vi.fn().mockImplementation((request) =>
        Promise.resolve({
          ...carefulTemplate,
          ...request,
          id: "33333333-3333-4333-8333-333333333333",
        }),
      ),
    updateThreadTemplate:
      options?.updateThreadTemplate ??
      vi.fn().mockImplementation((_id, request) =>
        Promise.resolve({
          ...carefulTemplate,
          ...request,
          revision: carefulTemplate.revision + 1,
        }),
      ),
    deleteThreadTemplate:
      options?.deleteThreadTemplate ??
      vi.fn().mockResolvedValue({
        deleted: true,
        templateId: carefulTemplate.id,
      }),
    listSavedAgents:
      options?.listSavedAgents ??
      vi.fn().mockResolvedValue({
        items: options?.agents ?? [carefulAgent],
      }),
    resolveSavedAgent: vi.fn().mockResolvedValue(
      options?.resolution ?? {
        candidates: [candidate("target-pi", "Local SDK")],
        failures: [],
      },
    ),
    getSavedAgent:
      options?.getSavedAgent ??
      vi.fn().mockResolvedValue({
        ...carefulAgent,
        backendOverrides: [],
        sedesTools: undefined,
      }),
  };
  const openWorkspace = vi.fn().mockResolvedValue("workspace-added");
  let store = { api, createThread, openWorkspace } as unknown as ApplicationClientStore;
  let workspaces = options?.workspaces ?? (options?.allWorkspaces ? [workspace, secondWorkspace] : [options?.constrainedWorkspace ?? workspace]);
  const onCreated = vi.fn();
  const renderControl = (creationScope: {
    readonly environmentId: string | null;
    readonly targetId: string | null;
    readonly projectName: string | null;
  }) => (
    <>
      <NewThreadControl
        store={store}
        environments={
          options?.allWorkspaces ? environments : [environments[0]!]
        }
        workspaces={workspaces}
        executionTargets={options?.executionTargets ?? targets}
        creationScope={creationScope}
        onCreated={onCreated}
      >
        New thread
      </NewThreadControl>
      <button type="button">Outside action</button>
    </>
  );
  const initialScope = options?.creationScope ?? {
    environmentId: null,
    targetId: options?.allWorkspaces ? null : "target-pi",
    projectName: options?.allWorkspaces ? null : workspace.label.text,
  };
  const rendered = render(renderControl(initialScope));
  return {
    api,
    createThread,
    openWorkspace,
    onCreated,
    unmount: rendered.unmount,
    rerenderApi: (replacementApi: typeof api) => {
      store = { ...store, api: replacementApi } as unknown as ApplicationClientStore;
      rendered.rerender(renderControl(initialScope));
    },
    rerenderWorkspaces: (next: readonly NormalizedWorkspaceSummary[]) => {
      workspaces = next;
      rendered.rerender(renderControl(initialScope));
    },
    rerenderScope: (creationScope: typeof initialScope) =>
      rendered.rerender(renderControl(creationScope)),
  };
}

function deferredTemplateList() {
  let resolve!: (result: { items: ThreadTemplate[] }) => void;
  const promise = new Promise<{ items: ThreadTemplate[] }>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "New thread" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeVisible(),
  );
}

async function chooseCareful(user: ReturnType<typeof userEvent.setup>) {
  const picker = screen.getByRole("combobox", { name: "Agent" });
  await user.click(picker);
  await user.click(
    await screen.findByRole("option", { name: /Careful.*11111111/ }),
  );
}

async function chooseTemplate(
  user: ReturnType<typeof userEvent.setup>,
  name = carefulTemplate.name,
) {
  await user.click(screen.getByRole("combobox", { name: "Template" }));
  await user.click(
    await screen.findByRole("option", { name: new RegExp(name) }),
  );
}

describe("NewThreadControl", () => {
  it("opens the Agent picker from the keyboard and scrolls the active option into view", async () => {
    const user = userEvent.setup();
    control({ agents: [carefulAgent, replacementAgent] });
    await openPicker(user);
    const trigger = screen.getByRole("combobox", { name: "Agent" });
    await waitFor(() => expect(trigger).toBeEnabled());
    trigger.focus();
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
    await user.keyboard("{ArrowUp}");
    const search = screen.getByRole("combobox", { name: "Search Agents" });
    const replacement = await screen.findByRole("option", { name: /Replacement/ });
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("aria-activedescendant", replacement.id);
    expect(replacement).toHaveAttribute("data-active", "true");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(replacement);
    await user.keyboard("{ArrowUp}");
    const careful = screen.getByRole("option", { name: /Careful/ });
    expect(search).toHaveAttribute("aria-activedescendant", careful.id);
    expect(careful).toHaveAttribute("data-active", "true");
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(careful);
  });

  it("reviews inherited variables and sends an accepted thread override with preview revisions", async () => {
    const user = userEvent.setup();
    const preview = { snapshot: { version: 1, layers: {
      environment: { LOG_LEVEL: { kind: "literal", value: "info" } }, backend: {}, agent: {}, thread: {},
    } }, revision: { configurationRevision: 7, agentRevision: 3 }, startup: { supported: true } };
    const { createThread } = control({ getEnvironmentVariablePreview: vi.fn().mockResolvedValue(preview) });
    await openPicker(user);
    await chooseCareful(user);
    const variablesButton = await screen.findByRole("button", { name: /1 effective variables/ });
    await user.click(variablesButton);
    await screen.findByRole("dialog", { name: "Environment variables" });
    fireEvent.change(screen.getByLabelText("Action for LOG_LEVEL"), { target: { value: "override" } });
    fireEvent.change(screen.getByLabelText("Value for LOG_LEVEL"), { target: { value: "debug" } });
    await user.click(screen.getByRole("button", { name: "Use these values" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Environment variables" })).toBeNull());
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(createThread).toHaveBeenCalledWith(expect.objectContaining({
      environmentVariables: { LOG_LEVEL: { kind: "literal", value: "debug" } },
      environmentVariablesRevision: { configurationRevision: 7, agentRevision: 3 },
    })));
  });

  it("blocks creation on a failed preview and allows an explicit refresh", async () => {
    const user = userEvent.setup();
    const preview = vi.fn().mockRejectedValue(new Error("Cannot read variable defaults"));
    control({ getEnvironmentVariablePreview: preview });
    await openPicker(user);
    await chooseCareful(user);
    await screen.findByText("Cannot read variable defaults");
    expect(screen.getByRole("button", { name: "Create thread" })).toBeDisabled();
    preview.mockResolvedValue({ snapshot: { version: 1, layers: { environment: {}, backend: {}, agent: {}, thread: {} } }, revision: { configurationRevision: 2 }, startup: { supported: true } });
    await user.click(screen.getByRole("button", { name: "Retry variable preview" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create thread" })).toBeEnabled());
  });

  it("adds a project from a scoped draft, waits for publication, and preserves the form", async () => {
    const user = userEvent.setup();
    const { openWorkspace, rerenderWorkspaces, createThread } = control();
    await openPicker(user);
    await user.clear(screen.getByRole("textbox", { name: "Thread name" }));
    await user.type(screen.getByRole("textbox", { name: "Thread name" }), "Keep this title");
    await user.click(screen.getByRole("combobox", { name: "Agent" }));
    await user.click(screen.getByRole("option", { name: /Custom/ }));
    await user.click(screen.getByRole("button", { name: "Add project" }));
    const dialog = screen.getByRole("dialog", { name: "Add project" });
    await user.type(within(dialog).getByLabelText("Absolute directory path"), "/workspace/added");
    await user.click(within(dialog).getByRole("button", { name: "Add project" }));
    expect(openWorkspace).toHaveBeenCalledWith("/workspace/added", "environment-1");
    expect(screen.getByRole("textbox", { name: "Thread name" })).toHaveValue("Keep this title");
    expect(screen.getByRole("button", { name: "Adding project…" })).toBeDisabled();
    rerenderWorkspaces([workspace, { ...workspace, id: "workspace-added", label: { text: "Added project" } }]);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveAttribute("data-workspace-id", "workspace-added"));
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    expect(createThread).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-added", configuration: { kind: "custom", targetId: "target-pi" }, title: "Keep this title" }));
  });

  it("offers Add project before any project exists", async () => {
    const user = userEvent.setup();
    control({ workspaces: [], creationScope: { environmentId: "environment-1", targetId: "target-pi", projectName: null } });
    await openPicker(user);
    expect(screen.getByRole("button", { name: "Create thread" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Add project" }));
    expect(screen.getByRole("dialog", { name: "Add project" })).toBeVisible();
  });

  it("searches templates by context and each manual scope picker without applying a query", async () => {
    const user = userEvent.setup();
    const { api } = control({ allWorkspaces: true, templates: [carefulTemplate] });
    await openPicker(user);
    await user.click(screen.getByRole("combobox", { name: "Template" }));
    await user.type(screen.getByRole("combobox", { name: "Search templates" }), "SDK SEDES");
    expect(screen.getByRole("option", { name: /Careful launch/ })).toHaveTextContent("Sedes · Careful");
    expect(screen.getByRole("option", { name: /Careful launch/ }).querySelector('[data-backend-brand="pi"]')).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("combobox", { name: "Template" })).toHaveTextContent("Configure manually");

    await user.click(screen.getByRole("combobox", { name: "Environment" }));
    await user.type(screen.getByRole("combobox", { name: "Search environments" }), "LOCAL");
    expect(screen.queryByRole("option", { name: "Remote" })).toBeNull();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveTextContent("Local");

    await user.click(screen.getByRole("combobox", { name: "Target" }));
    await user.type(screen.getByRole("combobox", { name: "Search targets" }), "CODEX local");
    expect(screen.queryByRole("option", { name: /Website agent/ })).toBeNull();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("combobox", { name: "Target" })).toHaveAttribute("data-target-id", "target-codex");

    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.type(screen.getByRole("combobox", { name: "Search projects" }), "/WORKSPACE/sedes local");
    expect(screen.getByRole("option", { name: "Sedes" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Website" })).toBeNull();
    await user.keyboard("{Enter}");
    await chooseCareful(user);
    await waitFor(() => expect(api.resolveSavedAgent).toHaveBeenCalledWith(
      carefulAgent.id,
      { workspaceId: "workspace-1", targetId: "target-codex" },
      expect.any(AbortSignal),
    ));
  });

  it("lists templates alphabetically after Configure manually", async () => {
    const user = userEvent.setup();
    control({
      templates: [
        {
          ...carefulTemplate,
          id: "44444444-4444-4444-8444-444444444444",
          name: "Zulu",
        },
        {
          ...carefulTemplate,
          id: "55555555-5555-4555-8555-555555555555",
          name: "Alpha",
        },
      ],
    });
    await openPicker(user);
    await user.click(screen.getByRole("combobox", { name: "Template" }));

    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      "Configure manually",
      expect.stringContaining("Alpha"),
      expect.stringContaining("Zulu"),
    ]);
  });

  it("keeps template scope details in the dropdown instead of the closed field", async () => {
    const user = userEvent.setup();
    const remoteTemplate: ThreadTemplate = {
      ...carefulTemplate,
      id: "77777777-7777-4777-8777-777777777777",
      name: "Remote launch",
      workspaceId: secondWorkspace.id,
      targetId: "target-website",
      capturedWorkspaceName: secondWorkspace.label.text,
      capturedTargetName: "Website agent",
    };
    control({
      templates: [carefulTemplate, remoteTemplate],
      allWorkspaces: true,
    });
    await openPicker(user);

    const picker = screen.getByRole("combobox", { name: "Template" });
    await user.click(picker);
    const option = await screen.findByRole("option", {
      name: /Careful launch/,
    });
    expect(option).toHaveTextContent(
      `${workspace.label.text} · ${carefulAgent.name}`,
    );
    expect(option).not.toHaveTextContent("Local");
    expect(
      option.querySelector('[data-environment-kind="local"]'),
    ).not.toBeNull();
    expect(option.querySelector('[data-backend-brand="pi"]')).not.toBeNull();
    const remoteOption = screen.getByRole("option", { name: /Remote launch/ });
    expect(remoteOption).toHaveTextContent(
      `Remote · ${secondWorkspace.label.text} · ${carefulAgent.name}`,
    );
    const remoteIcons = remoteOption.querySelectorAll(
      "[data-environment-kind], [data-backend-brand]",
    );
    expect(remoteIcons[0]).toHaveAttribute("data-environment-kind", "ssh");
    expect(remoteIcons[1]).toHaveAttribute("data-backend-brand", "pi");
    await user.click(option);

    expect(picker).toHaveTextContent(/^Careful launch$/);
    expect(
      picker.querySelector('[data-environment-kind="local"]'),
    ).not.toBeNull();
    expect(picker.querySelector('[data-backend-brand="pi"]')).not.toBeNull();
    const icons = picker.querySelectorAll(
      "[data-environment-kind], [data-backend-brand]",
    );
    expect(icons[0]).toHaveAttribute("data-environment-kind", "local");
    expect(icons[1]).toHaveAttribute("data-backend-brand", "pi");
  });

  it("prefills an editable template without changing or tracking the thread title", async () => {
    const user = userEvent.setup();
    const { createThread } = control({ templates: [carefulTemplate] });
    await openPicker(user);
    await chooseTemplate(user);

    expect(screen.getByRole("textbox", { name: "Thread name" })).toHaveValue(
      "New thread",
    );
    expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent(
      "Careful",
    );
    await user.clear(screen.getByRole("textbox", { name: "Thread name" }));
    await user.type(
      screen.getByRole("textbox", { name: "Thread name" }),
      "Independent title",
    );
    expect(screen.getByText("Using Careful launch")).toBeVisible();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create thread" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    expect(createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Independent title",
        configuration: {
          kind: "saved_agent",
          agentId: carefulAgent.id,
          targetId: "target-pi",
        },
      }),
    );
  });

  it("distinguishes template changes from save-as-new and can reset them", async () => {
    const user = userEvent.setup();
    control({ templates: [carefulTemplate] });
    await openPicker(user);
    await chooseTemplate(user);
    await user.click(screen.getByRole("combobox", { name: "Agent" }));
    await user.click(await screen.findByRole("option", { name: /^Custom/ }));

    expect(screen.getByText("Modified from Careful launch")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Update template…" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save as new…" })).toBeDisabled();
    expect(screen.getByText(/Choose a saved Agent/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Reset changes" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent(
        "Careful",
      ),
    );
    expect(screen.getByText("Using Careful launch")).toBeVisible();
  });

  it("saves a manual Agent configuration as a named template", async () => {
    const user = userEvent.setup();
    const createThreadTemplate = vi.fn().mockResolvedValue({
      ...carefulTemplate,
      id: "33333333-3333-4333-8333-333333333333",
      name: "My launch",
    });
    control({ createThreadTemplate });
    await openPicker(user);
    await chooseCareful(user);
    const saveAsTemplate = screen.getByRole("button", {
      name: "Save as template…",
    });
    await waitFor(() => expect(saveAsTemplate).toBeEnabled());
    await user.click(saveAsTemplate);
    await user.type(
      screen.getByRole("textbox", { name: "Template name" }),
      "My launch",
    );
    await user.click(screen.getByRole("button", { name: "Save template" }));

    await waitFor(() =>
      expect(createThreadTemplate).toHaveBeenCalledWith({
        name: "My launch",
        workspaceId: workspace.id,
        targetId: "target-pi",
        executionWorkspace: { kind: "direct" },
        agentId: carefulAgent.id,
      }),
    );
    expect(screen.getByText("Using My launch")).toBeVisible();
  });

  it("saves an applied template as a new independent template", async () => {
    const user = userEvent.setup();
    const createThreadTemplate = vi.fn().mockResolvedValue({
      ...carefulTemplate,
      id: "77777777-7777-4777-8777-777777777777",
      name: "Careful copy",
    });
    control({ templates: [carefulTemplate], createThreadTemplate });
    await openPicker(user);
    await chooseTemplate(user);
    const saveAsNew = screen.getByRole("button", { name: "Save as new…" });
    await waitFor(() => expect(saveAsNew).toBeEnabled());
    await user.click(saveAsNew);
    await user.type(
      screen.getByRole("textbox", { name: "Template name" }),
      "Careful copy",
    );
    await user.click(screen.getByRole("button", { name: "Save template" }));

    await waitFor(() =>
      expect(createThreadTemplate).toHaveBeenCalledWith({
        name: "Careful copy",
        workspaceId: workspace.id,
        targetId: "target-pi",
        executionWorkspace: { kind: "direct" },
        agentId: carefulAgent.id,
      }),
    );
  });

  it("portals the desktop creation drawer without a modal overlay", async () => {
    const user = userEvent.setup();
    control();
    await openPicker(user);

    expect(screen.getByRole("dialog", { name: "New thread" })).toHaveClass(
      "new-thread-target-picker",
    );
    expect(document.querySelector(".new-thread-sheet-overlay")).toBeNull();
  });

  it("renames and deletes a template only through its explicit edit flow", async () => {
    const user = userEvent.setup();
    const updateThreadTemplate = vi.fn().mockResolvedValue({
      ...carefulTemplate,
      name: "Renamed launch",
      revision: 1,
    });
    const deleteThreadTemplate = vi.fn().mockResolvedValue({
      deleted: true,
      templateId: carefulTemplate.id,
    });
    control({
      templates: [carefulTemplate],
      updateThreadTemplate,
      deleteThreadTemplate,
    });
    await openPicker(user);
    await chooseTemplate(user);
    await user.click(screen.getByRole("button", { name: "Edit template…" }));
    const name = screen.getByRole("textbox", { name: "Template name" });
    await user.clear(name);
    await user.type(name, "Renamed launch");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Replace Careful launch?",
    );
    await user.click(screen.getByRole("button", { name: "Replace template" }));
    await waitFor(() => expect(updateThreadTemplate).toHaveBeenCalledOnce());
    expect(updateThreadTemplate).toHaveBeenCalledWith(
      carefulTemplate.id,
      expect.objectContaining({
        expectedRevision: carefulTemplate.revision,
        name: "Renamed launch",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Edit template…" }));
    await user.click(screen.getByRole("button", { name: "Delete template" }));
    expect(screen.getByText(/Existing threads are unaffected/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(deleteThreadTemplate).toHaveBeenCalledWith(carefulTemplate.id, {
        expectedRevision: 1,
      }),
    );
    expect(
      screen.getByRole("combobox", { name: "Template" }),
    ).toHaveTextContent("Configure manually");
  });

  it("keeps a template with a deleted Agent visible but requires repair", async () => {
    const user = userEvent.setup();
    const { api } = control({
      templates: [carefulTemplate],
      agents: [replacementAgent],
    });
    await openPicker(user);
    await chooseTemplate(user);

    await waitFor(() =>
      expect(screen.getByText("Needs attention")).toBeVisible(),
    );
    expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent(
      "Careful (deleted)",
    );
    expect(
      screen.getByRole("button", { name: "Create thread" }),
    ).toBeDisabled();
    expect(api.listSavedAgents).toHaveBeenCalledWith({
      cursor: undefined,
      pageSize: 100,
    });
    expect(api.getEnvironmentVariablePreview.mock.calls.some(([query]) => query.agentId === carefulAgent.id)).toBe(false);
    expect(api.resolveSavedAgent).not.toHaveBeenCalled();

    await user.click(screen.getByRole("combobox", { name: "Agent" }));
    await user.click(
      await screen.findByRole("option", { name: /Replacement/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Update template…" }),
      ).toBeEnabled(),
    );
    expect(screen.getByText("Modified from Careful launch")).toBeVisible();
    await waitFor(() => expect(api.getEnvironmentVariablePreview).toHaveBeenCalledWith(
      { targetId: "target-pi", agentId: replacementAgent.id }, expect.any(AbortSignal),
    ));
  });

  it("lets a template override active sidebar scope defaults", async () => {
    const user = userEvent.setup();
    control({
      templates: [carefulTemplate],
      allWorkspaces: true,
      creationScope: {
        environmentId: "environment-2",
        targetId: "target-website",
        projectName: secondWorkspace.label.text,
      },
    });
    await openPicker(user);
    await chooseTemplate(user);

    expect(
      screen.getByRole("combobox", { name: "Environment" }),
    ).toHaveAttribute("data-environment-id", "environment-1");
    expect(screen.getByRole("combobox", { name: "Target" })).toHaveAttribute(
      "data-target-id",
      "target-pi",
    );
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveAttribute(
      "data-workspace-id",
      workspace.id,
    );
  });

  it("keeps a selected template open when sidebar scope changes", async () => {
    const user = userEvent.setup();
    const { rerenderScope } = control({
      templates: [carefulTemplate],
      allWorkspaces: true,
    });
    await openPicker(user);
    await chooseTemplate(user);

    rerenderScope({
      environmentId: "environment-2",
      targetId: "target-website",
      projectName: secondWorkspace.label.text,
    });

    expect(screen.getByRole("dialog", { name: "New thread" })).toBeVisible();
    expect(screen.getByText("Using Careful launch")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Target" })).toHaveAttribute(
      "data-target-id",
      "target-pi",
    );
  });

  it("creates an isolated workspace with the selected network profile", async () => {
    const user = userEvent.setup();
    const selectableTarget: NormalizedExecutionTargetDescriptor = {
      ...targets[0]!,
      workspaceExecution: {
        kind: "selectable",
        default: { kind: "direct" },
        isolatedNetworkProfiles: ["isolated", "execution_host"],
      },
    };
    const { createThread } = control({
      agents: [],
      executionTargets: [selectableTarget],
    });
    await openPicker(user);

    await user.click(
      screen.getByRole("combobox", { name: "Workspace execution" }),
    );
    await user.click(
      screen.getByRole("option", { name: "Writable isolated clone" }),
    );
    await user.click(screen.getByRole("combobox", { name: "Network" }));
    await user.click(screen.getByRole("option", { name: "Execution host" }));
    await user.click(await screen.findByRole("button", { name: "Use Custom" }));
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith(
        expect.objectContaining({
          executionWorkspace: {
            kind: "isolated",
            workspaceAccess: "writable_clone",
            networkProfile: "execution_host",
          },
        }),
      ),
    );
  });

  it("omits workspace execution when the target supports only direct execution", async () => {
    const user = userEvent.setup();
    control({ agents: [] });
    await openPicker(user);

    expect(
      screen.queryByRole("combobox", { name: "Workspace execution" }),
    ).not.toBeInTheDocument();
  });

  it("creates a read-only project mount with a writable private home", async () => {
    const user = userEvent.setup();
    const selectableTarget: NormalizedExecutionTargetDescriptor = {
      ...targets[0]!,
      workspaceExecution: {
        kind: "selectable",
        default: { kind: "direct" },
        isolatedNetworkProfiles: ["isolated"],
      },
    };
    const { createThread } = control({
      agents: [],
      executionTargets: [selectableTarget],
    });
    await openPicker(user);

    await user.click(
      screen.getByRole("combobox", { name: "Workspace execution" }),
    );
    await user.click(
      screen.getByRole("option", {
        name: "Read-only project with writable home",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Use Custom" }));
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith(
        expect.objectContaining({
          executionWorkspace: {
            kind: "isolated",
            workspaceAccess: "read_only",
            networkProfile: "isolated",
          },
        }),
      ),
    );
  });

  it("creates a Custom draft only after an explicit target choice", async () => {
    const user = userEvent.setup();
    const { createThread, onCreated } = control({
      agents: [],
      creationScope: {
        environmentId: null,
        targetId: null,
        projectName: workspace.label.text,
      },
    });
    await openPicker(user);

    const create = screen.getByRole("button", { name: "Create thread" });
    expect(create).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeDisabled();

    await user.click(screen.getByRole("combobox", { name: "Target" }));
    const codexOption = screen.getByRole("option", {
      name: "Local app server · Codex",
    });
    expect(
      codexOption.querySelector('[data-backend-brand="codex"]'),
    ).not.toBeNull();
    await user.click(codexOption);
    await user.click(await screen.findByRole("button", { name: "Use Custom" }));
    await user.clear(screen.getByRole("textbox", { name: "Thread name" }));
    await user.type(
      screen.getByRole("textbox", { name: "Thread name" }),
      "Review build",
    );
    await user.click(create);

    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith({
        environmentVariables: {},
        environmentVariablesRevision: { configurationRevision: 1 },
        workspaceId: "workspace-1",
        title: "Review build",
        executionWorkspace: { kind: "direct" },
        configuration: { kind: "custom", targetId: "target-codex" },
      }),
    );
    expect(onCreated).toHaveBeenCalledWith("thread-1");
  });

  it("infers one compatible target for a selected Agent", async () => {
    const user = userEvent.setup();
    const { api, createThread } = control({
      resolution: {
        candidates: [candidate("target-pi", "Local SDK", "environment", true)],
        failures: [],
      },
    });
    await openPicker(user);
    await chooseCareful(user);

    expect(api.listSavedAgents).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "target-pi" }),
    );

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(
      "Runs on Local SDK · Pi. Sedes tools: Ask outside this environment.",
    );
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("combobox", { name: "Target" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    expect(api.resolveSavedAgent).toHaveBeenCalledWith(
      carefulAgent.id,
      { workspaceId: "workspace-1", targetId: "target-pi" },
      expect.any(AbortSignal),
    );
    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith({
        environmentVariables: {},
        environmentVariablesRevision: { configurationRevision: 1 },
        workspaceId: "workspace-1",
        title: "New thread",
        executionWorkspace: { kind: "direct" },
        configuration: {
          kind: "saved_agent",
          agentId: carefulAgent.id,
          targetId: "target-pi",
        },
      }),
    );
  });

  it("previews allow relative to the selected thread environment", async () => {
    const user = userEvent.setup();
    control({
      resolution: {
        candidates: [candidate("target-pi", "Local SDK", "unrestricted", true)],
        failures: [],
      },
    });
    await openPicker(user);
    await chooseCareful(user);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Allow without asking.",
    );
  });

  it("previews Sedes tools as off without implying an environment grant", async () => {
    const user = userEvent.setup();
    control();
    await openPicker(user);
    await chooseCareful(user);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Runs on Local SDK · Pi. Sedes tools: Off.",
    );
  });

  it("keeps Agent resolution on the Target selected before Agent", async () => {
    const user = userEvent.setup();
    const { createThread } = control({
      resolution: {
        candidates: [
          candidate("target-pi", "Local SDK"),
          candidate("target-pi-2", "Backup SDK"),
        ],
        failures: [],
      },
    });
    await openPicker(user);
    await chooseCareful(user);

    expect(screen.queryByRole("combobox", { name: "Target" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith({
        environmentVariables: {},
        environmentVariablesRevision: { configurationRevision: 1 },
        workspaceId: "workspace-1",
        title: "New thread",
        executionWorkspace: { kind: "direct" },
        configuration: {
          kind: "saved_agent",
          agentId: carefulAgent.id,
          targetId: "target-pi",
        },
      }),
    );
  });

  it("locks Custom creation to the exact Target scope", async () => {
    const user = userEvent.setup();
    const { createThread } = control({
      agents: [],
      creationScope: {
        environmentId: "environment-1",
        targetId: "target-codex",
        projectName: workspace.label.text,
      },
    });
    await openPicker(user);

    await user.click(await screen.findByRole("button", { name: "Use Custom" }));
    expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Target" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "workspace-1",
          configuration: { kind: "custom", targetId: "target-codex" },
        }),
      ),
    );
  });

  it("constrains Agent resolution to Target and never switches after incompatibility", async () => {
    const user = userEvent.setup();
    const { api, createThread } = control({
      creationScope: {
        environmentId: "environment-1",
        targetId: "target-codex",
        projectName: workspace.label.text,
      },
      resolution: {
        candidates: [],
        failures: [
          {
            target: candidate("target-codex", "Local app server").target,
            reason: { text: "Careful cannot run on this target." },
          },
        ],
      },
    });
    await openPicker(user);
    await chooseCareful(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Careful cannot run on this target.",
    );
    expect(api.resolveSavedAgent).toHaveBeenCalledWith(
      carefulAgent.id,
      { workspaceId: "workspace-1", targetId: "target-codex" },
      expect.any(AbortSignal),
    );
    expect(
      screen.getByRole("button", { name: "Create thread" }),
    ).toBeDisabled();
    expect(createThread).not.toHaveBeenCalled();
  });

  it("disables creation and names an unavailable scoped target reason", () => {
    control({
      creationScope: {
        environmentId: "environment-1",
        targetId: "target-codex",
        projectName: workspace.label.text,
      },
      executionTargets: targets.map((target) =>
        target.id === "target-codex"
          ? {
              ...target,
              available: false,
              unavailableReason: { text: "Remote socket is offline." },
            }
          : target,
      ),
    });

    expect(screen.getByRole("button", { name: "New thread" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Remote socket is offline.",
    );
  });

  it("does not present an environment without an available target as creatable", () => {
    control({
      allWorkspaces: true,
      creationScope: {
        environmentId: "environment-2",
        targetId: null,
        projectName: null,
      },
      executionTargets: targets.filter(
        ({ environmentId }) => environmentId === "environment-1",
      ),
    });

    expect(screen.getByRole("button", { name: "New thread" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "No available Project and Target",
    );
  });

  it("raises an unfiltered sole Project and Target into creation", async () => {
    const user = userEvent.setup();
    const { api } = control({
      allWorkspaces: true,
      creationScope: {
        environmentId: "environment-2",
        targetId: null,
        projectName: null,
      },
      resolution: {
        candidates: [candidate("target-website", "Website agent")],
        failures: [],
      },
    });
    await openPicker(user);
    expect(screen.getByRole("combobox", { name: "Target" })).toHaveAttribute(
      "data-target-id",
      "target-website",
    );
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveAttribute(
      "data-workspace-id",
      "workspace-2",
    );
    await chooseCareful(user);
    await waitFor(() =>
      expect(api.resolveSavedAgent).toHaveBeenCalledWith(
        carefulAgent.id,
        { workspaceId: "workspace-2", targetId: "target-website" },
        expect.any(AbortSignal),
      ),
    );
  });

  it("shows a safe failure and disables creation when no target is compatible", async () => {
    const user = userEvent.setup();
    control({
      resolution: {
        candidates: [],
        failures: [
          {
            target: candidate("target-pi", "Local SDK").target,
            reason: { text: "The selected model is no longer available." },
          },
        ],
      },
    });
    await openPicker(user);
    await chooseCareful(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The selected model is no longer available.",
    );
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(
      screen.getByRole("button", { name: "Create thread" }),
    ).toBeDisabled();
  });

  it("makes Custom and Create an Agent prominent for an empty collection", async () => {
    const user = userEvent.setup();
    control({ agents: [] });
    await openPicker(user);

    expect(await screen.findByText("No saved Agents yet.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Use Custom" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Create an Agent" }),
    ).toBeEnabled();
  });

  it("refetches and returns focus to Agent when the selected Agent is deleted", async () => {
    const user = userEvent.setup();
    const createThread = vi.fn().mockRejectedValue(new Error("Conflict"));
    const { api } = control({
      createThread,
      getSavedAgent: vi.fn().mockRejectedValue(new Error("Not found")),
    });
    await openPicker(user);
    await chooseCareful(user);
    await screen.findByText(/Runs on Local SDK · Pi\. Sedes tools:/);
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That Agent is no longer available",
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Agent" })).toHaveFocus(),
    );
    expect(api.listSavedAgents).toHaveBeenCalledTimes(2);
  });

  it("searches the paginated collection and keeps Custom available", async () => {
    const user = userEvent.setup();
    const { api } = control();
    await openPicker(user);
    const picker = screen.getByRole("combobox", { name: "Agent" });
    await user.click(picker);
    await user.type(screen.getByRole("combobox", { name: "Search Agents" }), "care");

    await waitFor(() =>
      expect(api.listSavedAgents).toHaveBeenLastCalledWith(
        expect.objectContaining({ nameSearch: "care", pageSize: 50 }),
      ),
    );
    expect(screen.getByRole("option", { name: /Custom/ })).toBeVisible();
  });

  it("keeps the selected Agent label when an unfiltered page no longer contains it", async () => {
    const user = userEvent.setup();
    const listSavedAgents = vi.fn(
      async (input: { readonly nameSearch?: string }) => ({
        items: input.nameSearch ? [carefulAgent] : [],
      }),
    );
    control({ listSavedAgents });
    await openPicker(user);

    const picker = screen.getByRole<HTMLInputElement>("combobox", {
      name: "Agent",
    });
    await user.click(picker);
    await user.type(screen.getByRole("combobox", { name: "Search Agents" }), "care");
    await user.click(
      await screen.findByRole("option", { name: /Careful.*11111111/ }),
    );

    await waitFor(() => expect(listSavedAgents).toHaveBeenCalledTimes(3));
    expect(picker).toHaveTextContent("Careful");
  });

  it("requires an explicit environment for a project name available on two machines", async () => {
    const user = userEvent.setup();
    const remoteWorkspace = { ...secondWorkspace, label: workspace.label };
    const { createThread } = control({
      agents: [], allWorkspaces: true,
      workspaces: [workspace, remoteWorkspace],
      creationScope: { environmentId: null, targetId: null, projectName: "Sedes" },
    });
    await openPicker(user);
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveAttribute("data-environment-id", "");
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create thread" })).toBeDisabled();
    await user.click(screen.getByRole("combobox", { name: "Environment" }));
    await user.click(screen.getByRole("option", { name: "Remote" }));
    expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Use Custom" }));
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(createThread).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: remoteWorkspace.id,
      configuration: { kind: "custom", targetId: "target-website" },
    })));
  });

  it("requires a path choice for same-name projects within one environment", async () => {
    const user = userEvent.setup();
    const otherWorkspace = { ...workspace, id: "workspace-other", displayPath: { text: "/other/sedes" } };
    const { createThread } = control({
      agents: [], workspaces: [workspace, otherWorkspace],
      creationScope: { environmentId: "environment-1", targetId: "target-pi", projectName: "Sedes" },
    });
    await openPicker(user);
    expect(screen.getByRole("button", { name: "Create thread" })).toBeDisabled();
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    expect(screen.getByRole("option", { name: /Sedes.*\/workspace\/sedes/ })).toBeVisible();
    await user.click(screen.getByRole("option", { name: /Sedes.*\/other\/sedes/ }));
    await user.click(await screen.findByRole("button", { name: "Use Custom" }));
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(createThread).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-other" })));
  });

  it.each([
    { environmentId: "environment-2", targetId: null },
    { environmentId: null, targetId: "target-website" },
  ])("constrains grouped project creation to an explicit scope %j", async (scope) => {
    const user = userEvent.setup();
    const { createThread } = control({
      agents: [], allWorkspaces: true,
      workspaces: [workspace, { ...secondWorkspace, label: workspace.label }],
      creationScope: { ...scope, projectName: "Sedes" },
    });
    await openPicker(user);
    expect(screen.queryByRole("combobox", { name: "Environment" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Use Custom" }));
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(createThread).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: secondWorkspace.id,
      configuration: { kind: "custom", targetId: "target-website" },
    })));
  });

  it("does not fall back to another environment when the scoped name is unavailable", () => {
    control({
      allWorkspaces: true,
      workspaces: [workspace, { ...secondWorkspace, label: workspace.label, available: false }],
      creationScope: { environmentId: "environment-2", targetId: null, projectName: "Sedes" },
    });
    expect(screen.getByRole("button", { name: "New thread" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("No available Project and Target");
  });

  it("requires reselection when the chosen machine loses its matching project", async () => {
    const user = userEvent.setup();
    const remoteWorkspace = { ...secondWorkspace, label: workspace.label };
    const { createThread, rerenderWorkspaces } = control({
      agents: [], allWorkspaces: true,
      workspaces: [workspace, remoteWorkspace],
      creationScope: { environmentId: null, targetId: null, projectName: "Sedes" },
    });
    await openPicker(user);
    await user.click(screen.getByRole("combobox", { name: "Environment" }));
    await user.click(screen.getByRole("option", { name: "Remote" }));
    await user.click(await screen.findByRole("button", { name: "Use Custom" }));
    expect(screen.getByRole("button", { name: "Create thread" })).toBeEnabled();
    rerenderWorkspaces([workspace]);
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveAttribute("data-environment-id", "");
    expect(screen.getByRole("button", { name: "Create thread" })).toBeDisabled();
    expect(createThread).not.toHaveBeenCalled();
  });

  it("reveals the project picker when an inferred directory is replaced by a same-name directory", async () => {
    const user = userEvent.setup();
    const { createThread, rerenderWorkspaces } = control({ agents: [] });
    await openPicker(user);
    await user.click(await screen.findByRole("button", { name: "Use Custom" }));
    expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull();
    const replacement = { ...workspace, id: "workspace-replacement", displayPath: { text: "/replacement/sedes" } };
    rerenderWorkspaces([replacement]);
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveAttribute("data-workspace-id", "");
    expect(screen.getByRole("button", { name: "Create thread" })).toBeDisabled();
    expect(createThread).not.toHaveBeenCalled();
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.click(screen.getByRole("option", { name: "Sedes" }));
    await user.click(await screen.findByRole("button", { name: "Use Custom" }));
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(createThread).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: replacement.id })));
  });

  it("does not replace a vanished same-name directory with its remaining sibling", async () => {
    const user = userEvent.setup();
    const otherWorkspace = { ...workspace, id: "workspace-other", displayPath: { text: "/other/sedes" } };
    const { createThread, rerenderWorkspaces } = control({
      agents: [], workspaces: [workspace, otherWorkspace],
      creationScope: { environmentId: "environment-1", targetId: "target-pi", projectName: "Sedes" },
    });
    await openPicker(user);
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.click(screen.getByRole("option", { name: /Sedes.*\/other\/sedes/ }));
    await user.click(await screen.findByRole("button", { name: "Use Custom" }));
    rerenderWorkspaces([workspace]);
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveAttribute("data-workspace-id", "");
    expect(screen.getByRole("button", { name: "Create thread" })).toBeDisabled();
    expect(createThread).not.toHaveBeenCalled();
  });

  it("requires an environment in an unscoped multi-environment view", async () => {
    const user = userEvent.setup();
    const { api } = control({ allWorkspaces: true });
    await openPicker(user);
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeDisabled();

    const environment = screen.getByRole("combobox", {
      name: "Environment",
    });
    await user.click(environment);
    const remoteOption = screen.getByRole("option", { name: "Remote" });
    expect(
      remoteOption.querySelector('[data-environment-kind="ssh"]'),
    ).not.toBeNull();
    await user.click(remoteOption);
    expect(screen.getByRole("combobox", { name: "Target" })).toHaveAttribute(
      "data-target-id",
      "target-website",
    );
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveAttribute(
      "data-workspace-id",
      "workspace-2",
    );
    await chooseCareful(user);
    await waitFor(() =>
      expect(api.resolveSavedAgent).toHaveBeenCalledWith(
        carefulAgent.id,
        { workspaceId: "workspace-2", targetId: "target-website" },
        expect.any(AbortSignal),
      ),
    );
  });

  it("does not open the soft keyboard by focusing the title on mobile", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(pointer: coarse), (max-width: 819px)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const user = userEvent.setup();
    control();
    await openPicker(user);
    expect(
      screen.getByRole("textbox", { name: "Thread name" }),
    ).not.toHaveFocus();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "New thread" })).toHaveFocus(),
    );
    expect(document.querySelector(".new-thread-sheet-overlay")).not.toBeNull();
    expect(document.body.style.pointerEvents).toBe("none");
  });

  it("opens Agent choices for browsing on mobile, then focuses search only when tapped", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    const user = userEvent.setup();
    control();
    await openPicker(user);
    const trigger = screen.getByRole("combobox", { name: "Agent" });
    await user.click(trigger);
    const search = screen.getByRole("combobox", { name: "Search Agents" });
    expect(search).not.toHaveFocus();
    expect(screen.getByRole("option", { name: /Custom/ })).toBeVisible();
    await user.click(search);
    expect(search).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("combobox", { name: "Search Agents" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveTextContent("Custom");
  });

  it("reserves keyboard space in the mobile creation sheet", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    const user = userEvent.setup();
    control();
    await openPicker(user);
    const sheet = screen.getByRole("dialog", { name: "New thread" });
    act(() => {
      viewport.height = window.innerHeight - 300;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(sheet.style.getPropertyValue("--new-thread-keyboard-inset")).toBe("300px");
    act(() => {
      viewport.height = window.innerHeight;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(sheet.style.getPropertyValue("--new-thread-keyboard-inset")).toBe("0px");
  });

  it("retries a failed template list load when the surface reopens", async () => {
    const user = userEvent.setup();
    const listThreadTemplates = vi
      .fn()
      .mockRejectedValueOnce(new Error("Template service unavailable"))
      .mockResolvedValueOnce({ items: [carefulTemplate] });
    control({ listThreadTemplates });

    await openPicker(user);
    await screen.findByText("Template service unavailable");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await openPicker(user);

    await waitFor(() => expect(listThreadTemplates).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("combobox", { name: "Template" }));
    expect(
      await screen.findByRole("option", { name: /Careful launch/ }),
    ).toBeVisible();
  });

  it("retains one pending template catalog request while a missing project filter is repaired", async () => {
    const user = userEvent.setup();
    const pendingTemplates = deferredTemplateList();
    const listThreadTemplates = vi.fn().mockReturnValue(pendingTemplates.promise);
    const scope = { environmentId: null, targetId: "target-pi", projectName: "Removed project" };
    const { rerenderScope } = control({ creationScope: scope, listThreadTemplates });
    expect(listThreadTemplates).toHaveBeenCalledTimes(1);
    const signal = listThreadTemplates.mock.calls[0]![0].signal as AbortSignal;
    rerenderScope({ ...scope, projectName: null });
    expect(signal.aborted).toBe(false);
    await openPicker(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await openPicker(user);
    expect(listThreadTemplates).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    await act(async () => pendingTemplates.resolve({ items: [carefulTemplate] }));
    await user.click(screen.getByRole("combobox", { name: "Template" }));
    expect(await screen.findByRole("option", { name: /Careful launch/ })).toBeVisible();
    expect(listThreadTemplates).toHaveBeenCalledTimes(1);
  });

  it("aborts a pending template catalog read when the control unmounts", () => {
    const listThreadTemplates = vi.fn().mockReturnValue(new Promise(() => undefined));
    const { unmount } = control({
      creationScope: { environmentId: null, targetId: "target-pi", projectName: "Removed project" },
      listThreadTemplates,
    });
    const signal = listThreadTemplates.mock.calls[0]![0].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("aborts the old API's template read and ignores its late response after replacement", async () => {
    const user = userEvent.setup();
    const oldTemplates = deferredTemplateList();
    const newTemplates = deferredTemplateList();
    const oldList = vi.fn().mockReturnValue(oldTemplates.promise);
    const newList = vi.fn().mockReturnValue(newTemplates.promise);
    const { api, rerenderApi } = control({
      creationScope: { environmentId: null, targetId: "target-pi", projectName: "Removed project" },
      listThreadTemplates: oldList,
    });
    const oldSignal = oldList.mock.calls[0]![0].signal as AbortSignal;
    rerenderApi({ ...api, listThreadTemplates: newList });
    expect(oldSignal.aborted).toBe(true);
    expect(newList).toHaveBeenCalledTimes(1);
    const newSignal = newList.mock.calls[0]![0].signal as AbortSignal;
    expect(newSignal.aborted).toBe(false);
    await act(async () => newTemplates.resolve({ items: [carefulTemplate] }));
    await act(async () => oldTemplates.resolve({ items: [{ ...carefulTemplate, name: "Obsolete template" }] }));
    await openPicker(user);
    await user.click(screen.getByRole("combobox", { name: "Template" }));
    expect(await screen.findByRole("option", { name: /Careful launch/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /Obsolete template/ })).toBeNull();
    expect(newList).toHaveBeenCalledTimes(1);
  });

  it("uses a valid combobox and listbox composition for Agent choices", async () => {
    const user = userEvent.setup();
    control();
    await openPicker(user);
    const agent = screen.getByRole("combobox", { name: "Agent" });
    expect(agent).toHaveAttribute("aria-haspopup", "listbox");
    await user.click(agent);
    const listbox = await screen.findByRole("listbox", { name: "Agents" });
    expect(
      Array.from(listbox.children).every((child) => child.role === "option"),
    ).toBe(true);
  });

  it("restores focus to the trigger after Escape and Cancel", async () => {
    const user = userEvent.setup();
    control();
    const trigger = screen.getByRole("button", { name: "New thread" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("cancels on an outside pointer without stealing its focus", async () => {
    const user = userEvent.setup();
    control();
    await openPicker(user);

    const outside = screen.getByRole("button", { name: "Outside action" });
    await user.click(outside);

    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
    expect(outside).toHaveFocus();
  });

  it("closes without creating when the trigger is clicked a second time", async () => {
    const user = userEvent.setup();
    const { createThread } = control({ agents: [] });
    const trigger = screen.getByRole("button", { name: "New thread" });
    await user.click(trigger);
    await user.click(await screen.findByRole("button", { name: "Use Custom" }));

    await user.click(trigger);

    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull(),
    );
    expect(createThread).not.toHaveBeenCalled();
  });

  it("keeps creation open while focus moves outside without a pointer", async () => {
    const user = userEvent.setup();
    control();
    await openPicker(user);

    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    await user.tab();

    expect(screen.getByRole("textbox", { name: "Thread name" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Thread name" })).toBeVisible();
  });

  it("treats a portaled Target choice as part of the creation layer", async () => {
    const user = userEvent.setup();
    control({
      agents: [],
      creationScope: {
        environmentId: null,
        targetId: null,
        projectName: workspace.label.text,
      },
    });
    await openPicker(user);

    await user.click(screen.getByRole("combobox", { name: "Target" }));
    await user.click(
      screen.getByRole("option", { name: "Local app server · Codex" }),
    );

    expect(screen.getByRole("textbox", { name: "Thread name" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Target" })).toHaveAttribute(
      "data-target-id",
      "target-codex",
    );
  });

  it("lets a portaled Target picker consume Escape before creation closes", async () => {
    const user = userEvent.setup();
    control({
      creationScope: {
        environmentId: null,
        targetId: null,
        projectName: workspace.label.text,
      },
    });
    await openPicker(user);

    const target = screen.getByRole("combobox", { name: "Target" });
    await user.click(target);
    expect(screen.getByRole("listbox")).toBeVisible();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Thread name" })).toBeVisible();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New thread" })).toHaveFocus(),
    );
  });

  it("lets the nested Agent popup consume Escape before creation closes", async () => {
    const user = userEvent.setup();
    control();
    await openPicker(user);

    const agent = screen.getByRole("combobox", { name: "Agent" });
    await user.click(agent);
    expect(agent).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");

    expect(agent).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("textbox", { name: "Thread name" })).toBeVisible();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New thread" })).toHaveFocus(),
    );
  });

  it("ignores outside pointers while creation is pending", async () => {
    const user = userEvent.setup();
    let finishCreation!: (value: {
      threadId: string;
      workspaceId: string;
      targetId: string;
    }) => void;
    const createThread = vi.fn(
      () =>
        new Promise<{
          threadId: string;
          workspaceId: string;
          targetId: string;
        }>((resolve) => {
          finishCreation = resolve;
        }),
    );
    control({ agents: [], createThread });
    await openPicker(user);
    await user.click(await screen.findByRole("button", { name: "Use Custom" }));
    await user.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(createThread).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Outside action" }));
    expect(screen.getByRole("textbox", { name: "Thread name" })).toBeVisible();

    finishCreation({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      targetId: "target-pi",
    });
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull(),
    );
  });
});
