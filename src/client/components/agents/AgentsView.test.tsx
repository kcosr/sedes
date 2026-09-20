// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "../../api/ApiClient.js";
import { AgentClientStore } from "../../agents/AgentClientStore.js";
import {
  agentPath,
  agentsPath,
  navigate,
  parseRoute,
} from "../../app/router.js";
import { AgentsView } from "./AgentsView.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const workspace = {
  id: "workspace-1",
  environmentId: "environment-1",
  label: { text: "Sedes" },
  displayPath: { text: "/workspace/sedes" },
  available: true,
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
    render(
      <AgentsView
        route={{ name: "agents", create: false }}
        store={store}
        workspaces={[workspace]}
      />,
    );

    expect(
      await screen.findByText(
        "3 enabled · Allow without asking · Native · Progressive",
      ),
    ).toBeVisible();
  });

  it("bounds Agent list searches to the server contract", () => {
    const store = new AgentClientStore({
      listSavedAgents: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as ApiClient);
    render(
      <AgentsView
        route={{ name: "agents", create: false }}
        store={store}
        workspaces={[workspace]}
      />,
    );

    expect(
      screen.getByRole("searchbox", { name: "Search Agents" }),
    ).toHaveAttribute("maxlength", "160");
  });

  it("loads the paginated collection only when the screen opens", async () => {
    const listSavedAgents = vi.fn().mockResolvedValue({ items: [summary] });
    const store = new AgentClientStore({
      listSavedAgents,
    } as unknown as ApiClient);
    render(
      <AgentsView
        route={{ name: "agents", create: false }}
        store={store}
        workspaces={[workspace]}
      />,
    );

    expect(await screen.findByText("Careful reviewer")).toBeVisible();
    expect(listSavedAgents).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Careful reviewer/ }));
    expect(window.location.pathname).toBe(agentPath(agentId));
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
    render(
      <AgentsView
        route={
          parseRoute(agentPath(agentId)) as Extract<
            ReturnType<typeof parseRoute>,
            { name: "agents" }
          >
        }
        store={store}
        workspaces={[workspace]}
      />,
    );

    const name = await screen.findByRole("textbox", { name: "Name" });
    await waitFor(() =>
      expect(getSavedAgentOptions).toHaveBeenCalledWith(
        { workspaceId: workspace.id },
        expect.any(AbortSignal),
      ),
    );
    fireEvent.change(name, { target: { value: "Changed locally" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("dialog", { name: "Discard unsaved Agent changes?" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(name).toHaveValue("Changed locally");
    expect(window.location.pathname).toBe(agentPath(agentId));
  });

  it("surfaces a focused validation error for an unnamed new Agent", async () => {
    const store = new AgentClientStore({
      listSavedAgents: vi.fn().mockResolvedValue({ items: [] }),
      getSavedAgentOptions: vi.fn().mockResolvedValue({
        kind: "targets",
        targets: [],
      }),
    } as unknown as ApiClient);
    render(
      <AgentsView
        route={{ name: "agents", create: true }}
        store={store}
        workspaces={[workspace]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Enter an Agent name.",
      ),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
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
    render(
      <AgentsView
        route={{ name: "agents", agentId, create: false }}
        store={store}
        workspaces={[workspace]}
      />,
    );

    await screen.findByRole("textbox", { name: "Name" });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText(/Existing threads are unchanged\./)).toBeVisible();
    expect(screen.getByText(/templates that use this Agent/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete Agent" }));
    await waitFor(() =>
      expect(deleteSavedAgent).toHaveBeenCalledWith(agentId, {
        expectedRevision: 0,
      }),
    );
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
    render(
      <AgentsView
        route={{ name: "agents", agentId, create: false }}
        store={store}
        workspaces={[workspace]}
      />,
    );

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
    render(
      <AgentsView
        route={{ name: "agents", agentId, create: false }}
        store={store}
        workspaces={[workspace]}
      />,
    );

    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Local draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Agent" }));

    expect(
      await screen.findByText(/Your local edits are preserved/),
    ).toBeVisible();
    expect(name).toHaveValue("Local draft");
    expect(deleteSavedAgent).toHaveBeenNthCalledWith(1, agentId, {
      expectedRevision: 0,
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Agent" }));
    await waitFor(() =>
      expect(deleteSavedAgent).toHaveBeenNthCalledWith(2, agentId, {
        expectedRevision: 1,
      }),
    );
    await waitFor(() => expect(window.location.pathname).toBe(agentsPath()));
  });
});
