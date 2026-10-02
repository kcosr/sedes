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
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "../../api/ApiClient.js";
import { AgentClientStore } from "../../agents/AgentClientStore.js";
import { navigate, settingsPath } from "../../app/router.js";
import { AgentsView } from "./AgentsView.js";

const agentsPath = () => settingsPath("agents");
const newAgentPath = () => settingsPath("agents", { mode: "new" });
const agentPath = (id: string) => settingsPath("agents", { mode: "view", resourceId: id });

const agentId = "11111111-1111-4111-8111-111111111111";
const workspace = {
  id: "workspace-1",
  environmentId: "environment-1",
  projectId: "project-1",
  label: { text: "Sedes" },
  displayPath: { text: "/workspace/sedes" },
  available: true,
};
const locations = {
  projects: [{ id: "project-1", name: "Sedes", revision: 0 }],
  workspaces: [workspace],
  environments: [
    {
      id: "environment-1",
      kind: "local" as const,
      label: { text: "Local" },
      available: true,
      directoryBrowsing: "available" as const,
    },
  ],
};
const backend = {
  typeId: "pi",
  label: { text: "Pi" },
  brand: "pi" as const,
};
const summary = {
  id: agentId,
  name: "Careful reviewer",
  backendTypeId: "pi",
  backend,
  overrideCount: 2,
  sedesTools: null,
  revision: 0,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
};
const detail = {
  ...summary,
  description: "Reviews carefully",
  backendOverrides: [],
  sedesTools: undefined,
};

afterEach(() => {
  cleanup();
  navigate(agentsPath(), { replace: true });
});

describe("AgentsView", () => {
  it("summarizes an explicit Agent environment-access policy", async () => {
    const explicitSummary = {
      ...summary,
      sedesTools: {
        enabled: true,
        selectedToolCount: 3,
        presentation: {
          surface: "native" as const,
          mode: "progressive" as const,
        },
        accessBoundary: "unrestricted" as const,
      },
    };
    const store = new AgentClientStore({
      listSavedAgents: vi.fn().mockResolvedValue({ items: [explicitSummary] }),
    } as unknown as ApiClient);
    navigate(agentsPath(), { replace: true });
    render(<AgentsView store={store} {...locations} />);

    expect(
      await screen.findByRole("link", { name: "Careful reviewer" }),
    ).toHaveAccessibleDescription(
      /3 enabled · Allow without asking · Native · Progressive$/u,
    );
  });

  it("bounds Agent list searches to the server contract", () => {
    const store = new AgentClientStore({
      listSavedAgents: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as ApiClient);
    navigate(agentsPath(), { replace: true });
    render(<AgentsView store={store} {...locations} />);

    expect(
      screen.getByRole("searchbox", { name: "Search Agents" }),
    ).toHaveAttribute("maxlength", "160");
  });

  it("loads the paginated collection only when the screen opens", async () => {
    const listSavedAgents = vi.fn().mockResolvedValue({ items: [summary] });
    const getSavedAgent = vi.fn().mockResolvedValue(detail);
    const store = new AgentClientStore({
      listSavedAgents,
      getSavedAgent,
      getSavedAgentOptions: vi.fn().mockResolvedValue({ kind: "targets", targets: [] }),
    } as unknown as ApiClient);
    navigate(agentsPath(), { replace: true });
    render(<AgentsView store={store} {...locations} />);

    expect(await screen.findByText("Careful reviewer")).toBeVisible();
    expect(listSavedAgents).toHaveBeenCalledTimes(1);
    expect(getSavedAgent).not.toHaveBeenCalled();
    const row = screen.getByRole("link", { name: "Careful reviewer" });
    expect(row).toHaveAttribute("href", agentPath(agentId));
    fireEvent.click(row);
    expect(window.location.pathname).toBe(agentPath(agentId));
    // The route opens the Agent's editor beside the list.
    expect(await screen.findByRole("region", { name: "Agent editor" })).toBeVisible();
    expect(getSavedAgent).toHaveBeenCalledWith(agentId, expect.any(AbortSignal));
    expect(listSavedAgents).toHaveBeenCalledTimes(1);
  });

  it("protects a dirty detail editor and keeps the draft after cancel", async () => {
    const getSavedAgentOptions = vi.fn().mockResolvedValue({
      kind: "targets",
      targets: [],
    });
    const api = {
      listSavedAgents: vi.fn().mockResolvedValue({ items: [summary] }),
      getSavedAgent: vi.fn().mockResolvedValue(detail),
      getSavedAgentOptions,
    } as unknown as ApiClient;
    const store = new AgentClientStore(api);
    navigate(agentPath(agentId), { replace: true });
    render(<AgentsView store={store} {...locations} />);

    const name = await screen.findByRole("textbox", { name: "Name" });
    await waitFor(() =>
      expect(getSavedAgentOptions).toHaveBeenCalledWith(
        { workspaceId: workspace.id },
        expect.any(AbortSignal),
      ),
    );
    fireEvent.change(name, { target: { value: "Changed locally" } });
    act(() => navigate(agentsPath()));
    expect(
      screen.getByRole("dialog", { name: "Discard unsaved Agent changes?" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(name).toHaveValue("Changed locally");
    expect(window.location.pathname).toBe(agentPath(agentId));
    // Cancel in the save bar discards the local edits in place.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(name).toHaveValue(detail.name);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("surfaces a focused validation error for an unnamed new Agent", async () => {
    const store = new AgentClientStore({
      listSavedAgents: vi.fn().mockResolvedValue({ items: [] }),
      getSavedAgentOptions: vi.fn().mockResolvedValue({
        kind: "targets",
        targets: [],
      }),
    } as unknown as ApiClient);
    navigate(newAgentPath(), { replace: true });
    render(<AgentsView store={store} {...locations} />);

    fireEvent.click(
      within(screen.getByRole("region", { name: "Agent editor" })).getByRole("button", { name: "Create Agent" }),
    );
    const name = screen.getByRole("textbox", { name: "Name" });
    await waitFor(() => expect(name).toHaveAttribute("aria-invalid", "true"));
    expect(name).toHaveAccessibleDescription("Enter an Agent name.");
    expect(name).toHaveFocus();
  });

  it("selects a lone location and names it by project and path", async () => {
    const getSavedAgentOptions = vi.fn().mockResolvedValue({
      kind: "targets",
      targets: [],
    });
    const store = new AgentClientStore({
      listSavedAgents: vi.fn().mockResolvedValue({ items: [] }),
      getSavedAgentOptions,
    } as unknown as ApiClient);
    navigate(newAgentPath(), { replace: true });
    render(<AgentsView store={store} {...locations} />);

    expect(
      await screen.findByRole("combobox", { name: "Project" }),
    ).toHaveTextContent("Sedes · /workspace/sedes");
    await waitFor(() =>
      expect(getSavedAgentOptions).toHaveBeenCalledWith(
        { workspaceId: workspace.id },
        expect.any(AbortSignal),
      ),
    );
  });

  it("validates against an available location chosen by project and location", async () => {
    const getSavedAgentOptions = vi.fn().mockResolvedValue({
      kind: "targets",
      targets: [],
    });
    const store = new AgentClientStore({
      listSavedAgents: vi.fn().mockResolvedValue({ items: [] }),
      getSavedAgentOptions,
    } as unknown as ApiClient);
    navigate(newAgentPath(), { replace: true });
    render(
      <AgentsView
        store={store}
        projects={[
          ...locations.projects,
          { id: "project-2", name: "Docs", revision: 0 },
        ]}
        workspaces={[
          workspace,
          {
            ...workspace,
            id: "workspace-2",
            environmentId: "environment-2",
            displayPath: { text: "/srv/sedes" },
          },
          {
            ...workspace,
            id: "workspace-3",
            projectId: "project-2",
            label: { text: "docs" },
            displayPath: { text: "/workspace/docs" },
            available: false,
          },
        ]}
        environments={[
          ...locations.environments,
          {
            id: "environment-2",
            kind: "ssh",
            label: { text: "Build host" },
            available: true,
            directoryBrowsing: "available",
          },
        ]}
      />,
    );

    fireEvent.click(await screen.findByRole("combobox", { name: "Project" }));
    expect(
      screen.getAllByRole("option").map(({ textContent }) => textContent),
    ).toEqual([
      "Sedes · Local · /workspace/sedes",
      "Sedes · Build host · /srv/sedes",
    ]);
    fireEvent.click(
      screen.getByRole("option", { name: "Sedes · Build host · /srv/sedes" }),
    );
    await waitFor(() =>
      expect(getSavedAgentOptions).toHaveBeenCalledWith(
        { workspaceId: "workspace-2" },
        expect.any(AbortSignal),
      ),
    );
  });

  it("deletes only after revision-checked confirmation", async () => {
    const deleteSavedAgent = vi.fn().mockResolvedValue({
      deleted: true,
      agentId,
    });
    const api = {
      listSavedAgents: vi.fn().mockResolvedValue({ items: [summary] }),
      getSavedAgent: vi.fn().mockResolvedValue(detail),
      getSavedAgentOptions: vi.fn().mockResolvedValue({
        kind: "targets",
        targets: [],
      }),
      deleteSavedAgent,
    } as unknown as ApiClient;
    const store = new AgentClientStore(api);
    navigate(agentPath(agentId), { replace: true });
    render(<AgentsView store={store} {...locations} />);

    await screen.findByRole("textbox", { name: "Name" });
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    expect(screen.getByText(/Existing threads are unchanged\./)).toBeVisible();
    expect(screen.getByText(/templates that use this Agent/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete Agent" }));
    await waitFor(() =>
      expect(deleteSavedAgent).toHaveBeenCalledWith(agentId, {
        expectedRevision: 0,
      }),
    );
    // Deleted, the Agent's page gives way to the list.
    await waitFor(() => expect(window.location.pathname).toBe(agentsPath()));
    expect(await screen.findByText("Select an Agent")).toBeVisible();
  });

  it("preserves a dirty draft and retries an update with the refreshed revision", async () => {
    const refreshed = {
      ...detail,
      name: "Changed elsewhere",
      revision: 1,
    };
    const updateSavedAgent = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, "conflict", "The Agent changed.", false),
      )
      .mockResolvedValueOnce({
        ...refreshed,
        name: "Local draft",
        revision: 2,
      });
    const api = {
      listSavedAgents: vi.fn().mockResolvedValue({ items: [summary] }),
      getSavedAgent: vi
        .fn()
        .mockResolvedValueOnce(detail)
        .mockResolvedValueOnce(refreshed),
      getSavedAgentOptions: vi.fn().mockResolvedValue({
        kind: "targets",
        targets: [],
      }),
      updateSavedAgent,
    } as unknown as ApiClient;
    const store = new AgentClientStore(api);
    navigate(agentPath(agentId), { replace: true });
    render(<AgentsView store={store} {...locations} />);

    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Local draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(/Your local edits are preserved/),
    ).toBeVisible();
    expect(name).toHaveValue("Local draft");
    expect(updateSavedAgent).toHaveBeenNthCalledWith(
      1,
      agentId,
      expect.objectContaining({ expectedRevision: 0, name: "Local draft" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateSavedAgent).toHaveBeenNthCalledWith(
        2,
        agentId,
        expect.objectContaining({ expectedRevision: 1, name: "Local draft" }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(/Your local edits are preserved/),
      ).not.toBeInTheDocument(),
    );
  });

  it("preserves a dirty draft and retries delete with the refreshed revision", async () => {
    const refreshed = { ...detail, name: "Changed elsewhere", revision: 1 };
    const deleteSavedAgent = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, "conflict", "The Agent changed.", false),
      )
      .mockResolvedValueOnce({ deleted: true, agentId });
    const api = {
      listSavedAgents: vi.fn().mockResolvedValue({ items: [summary] }),
      getSavedAgent: vi
        .fn()
        .mockResolvedValueOnce(detail)
        .mockResolvedValueOnce(refreshed),
      getSavedAgentOptions: vi.fn().mockResolvedValue({
        kind: "targets",
        targets: [],
      }),
      deleteSavedAgent,
    } as unknown as ApiClient;
    const store = new AgentClientStore(api);
    navigate(agentPath(agentId), { replace: true });
    render(<AgentsView store={store} {...locations} />);

    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Local draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Agent" }));

    expect(
      await screen.findByText(/Your local edits are preserved/),
    ).toBeVisible();
    expect(name).toHaveValue("Local draft");
    expect(deleteSavedAgent).toHaveBeenNthCalledWith(1, agentId, {
      expectedRevision: 0,
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Agent" }));
    await waitFor(() =>
      expect(deleteSavedAgent).toHaveBeenNthCalledWith(2, agentId, {
        expectedRevision: 1,
      }),
    );
    await waitFor(() => expect(window.location.pathname).toBe(agentsPath()));
  });

  it("lays the list beside the selected Agent on the settings split, and names the stack's selection", async () => {
    const api = {
      listSavedAgents: vi.fn().mockResolvedValue({ items: [summary] }),
      getSavedAgent: vi.fn().mockResolvedValue(detail),
      getSavedAgentOptions: vi.fn().mockResolvedValue({ kind: "targets", targets: [] }),
    } as unknown as ApiClient;
    navigate(agentsPath(), { replace: true });
    const { container } = render(<AgentsView store={new AgentClientStore(api)} {...locations} />);
    const page = container.querySelector('[data-slot="settings-page"]')!;
    expect(page).toHaveAttribute("data-selection", "none");
    expect(page).toHaveAttribute("data-width", "wide");
    expect(screen.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
    const list = screen.getByRole("region", { name: "Saved Agents" });
    expect(list).toHaveAttribute("data-slot", "settings-split-list");
    expect(await within(list).findByRole("link", { name: "Careful reviewer" })).toHaveAccessibleDescription(
      "Pi · 2 overrides · Default tools",
    );
    expect(screen.getByText("Select an Agent").closest('[data-slot="settings-split-detail"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Create Agent" })).toBeVisible();

    act(() => navigate(agentPath(agentId)));
    const editor = await screen.findByRole("region", { name: "Agent editor" });
    expect(page).toHaveAttribute("data-selection", "editor");
    expect(editor.closest('[data-slot="settings-split-detail"]')).not.toBeNull();
    expect(within(list).getByRole("link", { name: "Careful reviewer" })).toHaveAttribute("aria-current", "page");
    // The "‹ Agents" link is for the stack; beside the list, the list is the way back.
    expect(within(editor).getByRole("link", { name: "Agents" })).toHaveAttribute("data-stack-only", "true");
    expect(within(editor).getByRole("heading", { name: "Careful reviewer", level: 2 })).toBeVisible();
    expect(
      within(within(editor).getByRole("navigation", { name: "Editor sections" })).getAllByRole("button").map(button => button.textContent),
    ).toEqual(["Details", "Validate", "Variables"]);
    expect(within(editor).getByRole("region", { name: "Danger zone" })).toBeVisible();

    act(() => navigate(newAgentPath()));
    expect(await screen.findByRole("heading", { name: "Create Agent", level: 2 })).toBeVisible();
    expect(page).toHaveAttribute("data-selection", "editor");
    // Creating, the page offers no second Create Agent.
    expect(screen.getAllByRole("button", { name: "Create Agent" })).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Danger zone" })).toBeNull();
  });

  it("focuses a deep-linked Agent's heading, and its row on the way back to the list", async () => {
    const api = {
      listSavedAgents: vi.fn().mockResolvedValue({ items: [summary] }),
      getSavedAgent: vi.fn().mockResolvedValue(detail),
      getSavedAgentOptions: vi.fn().mockResolvedValue({ kind: "targets", targets: [] }),
    } as unknown as ApiClient;
    navigate(agentsPath(), { replace: true });
    navigate(agentPath(agentId));
    render(<AgentsView store={new AgentClientStore(api)} {...locations} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Careful reviewer", level: 2 })).toHaveFocus());
    await screen.findByRole("link", { name: "Careful reviewer" });
    const length = window.history.length;
    fireEvent.click(within(screen.getByRole("region", { name: "Agent editor" })).getByRole("link", { name: "Agents" }));
    await waitFor(() => expect(window.location.pathname).toBe(agentsPath()));
    // The ‹ link went back through history rather than stacking an entry.
    expect(window.history.length).toBe(length);
    await waitFor(() => expect(screen.getByRole("link", { name: "Careful reviewer" })).toHaveFocus());
  });

  it("names an unavailable Agent and keeps saying so after the list refreshes", async () => {
    let listed!: () => void;
    const listRefreshed = new Promise<void>((resolve) => { listed = resolve; });
    const listSavedAgents = vi.fn(async () => {
      listed();
      return { items: [summary] };
    });
    const api = {
      listSavedAgents,
      getSavedAgent: vi.fn().mockRejectedValue(new ApiError(404, "not_found", "That Agent does not exist.", false)),
    } as unknown as ApiClient;
    const missing = "22222222-2222-4222-8222-222222222222";
    navigate(agentPath(missing), { replace: true });
    render(<AgentsView store={new AgentClientStore(api)} {...locations} />);
    const unavailable = await screen.findByRole("region", { name: "Agent unavailable" });
    expect(within(unavailable).getByRole("alert")).toHaveTextContent("That Agent does not exist.");
    expect(within(unavailable).getByRole("link", { name: "Agents" })).toHaveAttribute("href", agentsPath());
    expect(screen.queryByRole("region", { name: "Agent editor" })).toBeNull();
    // The debounced list refresh succeeds after the failed load; the
    // unavailable Agent stays unavailable instead of turning into a loader.
    await listRefreshed;
    expect(await screen.findByRole("link", { name: "Careful reviewer" })).toBeVisible();
    expect(listSavedAgents).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "Agent unavailable" })).toHaveTextContent("That Agent does not exist.");
    expect(screen.queryByText("Loading Agent…")).toBeNull();
    // The list's own state is not the Agent's failure.
    expect(within(screen.getByRole("region", { name: "Saved Agents" })).queryByRole("alert")).toBeNull();
  });

  it("keeps an unavailable Agent through a failed retry and opens it when a retry succeeds", async () => {
    let finishRetry!: (value: unknown) => void;
    const getSavedAgent = vi.fn()
      .mockRejectedValueOnce(new Error("The server did not respond."))
      .mockRejectedValueOnce(new Error("Still unreachable."))
      .mockImplementationOnce(() => new Promise((resolve) => { finishRetry = resolve; }));
    const api = {
      listSavedAgents: vi.fn().mockResolvedValue({ items: [summary] }),
      getSavedAgent,
      getSavedAgentOptions: vi.fn().mockResolvedValue({ kind: "targets", targets: [] }),
    } as unknown as ApiClient;
    navigate(agentPath(agentId), { replace: true });
    render(<AgentsView store={new AgentClientStore(api)} {...locations} />);
    const unavailable = await screen.findByRole("region", { name: "Agent unavailable" });
    expect(within(unavailable).getByRole("alert")).toHaveTextContent("The server did not respond.");
    fireEvent.click(within(unavailable).getByRole("button", { name: "Retry" }));
    expect(await within(unavailable).findByRole("alert")).toHaveTextContent("Still unreachable.");
    // A keyboard user retries from the focused Retry button.
    const retry = within(unavailable).getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    // While the retry runs, the failure stays in place.
    expect(within(screen.getByRole("region", { name: "Agent unavailable" })).getByRole("button", { name: "Retrying…" })).toBeDisabled();
    expect(screen.queryByText("Loading Agent…")).toBeNull();
    act(() => finishRetry(detail));
    const editor = await screen.findByRole("region", { name: "Agent editor" });
    expect(editor).toBeVisible();
    expect(screen.queryByRole("region", { name: "Agent unavailable" })).toBeNull();
    expect(getSavedAgent).toHaveBeenCalledTimes(3);
    // The removed Retry button hands focus to the loaded Agent's heading.
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-detail-heading"));
    expect(editor).toContainElement(document.activeElement as HTMLElement);
  });

  it("drops an unavailable Agent's failure when the route opens another Agent", async () => {
    const other = { ...detail, id: "33333333-3333-4333-8333-333333333333", name: "Other Agent" };
    const api = {
      listSavedAgents: vi.fn().mockResolvedValue({ items: [summary] }),
      getSavedAgent: vi.fn()
        .mockRejectedValueOnce(new ApiError(404, "not_found", "That Agent does not exist.", false))
        .mockResolvedValueOnce(other),
      getSavedAgentOptions: vi.fn().mockResolvedValue({ kind: "targets", targets: [] }),
    } as unknown as ApiClient;
    navigate(agentPath(agentId), { replace: true });
    render(<AgentsView store={new AgentClientStore(api)} {...locations} />);
    await screen.findByRole("region", { name: "Agent unavailable" });
    act(() => navigate(agentPath(other.id)));
    expect(screen.queryByRole("region", { name: "Agent unavailable" })).toBeNull();
    expect(await screen.findByRole("heading", { name: "Other Agent", level: 2 })).toBeVisible();
  });
});
