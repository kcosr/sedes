// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ToolClient,
  ToolClientCredentialResult,
  ToolClientOptions,
} from "../../../shared/index.js";
import {
  ToolClientsSettingsPage,
  type ToolClientSettingsControls,
} from "./ToolClientsSettingsPage.js";

const clientId = "10000000-0000-4000-8000-000000000001";
const credential = `hatc1_${clientId}_1_${"a".repeat(43)}`;

function options(): ToolClientOptions {
  return {
    environments: [
      { id: "env-local", label: "Local", kind: "local", available: true },
      { id: "env-remote", label: "Remote", kind: "ssh", available: true },
    ],
    groups: [
      {
        id: "threads",
        label: "Threads",
        description: "Inspect and control threads.",
        order: 10,
        tools: [
          {
            id: "thread.status",
            label: "Thread status",
            description: "Read thread status.",
            order: 10,
            effects: {
              application: "read",
              modelUsage: "none",
              external: "none",
            },
            available: true,
          },
          {
            id: "thread.send",
            label: "Send message",
            description: "Send a message and start model work.",
            order: 20,
            effects: {
              application: "write",
              modelUsage: "agent_execution",
              external: "durable_side_effect",
            },
            available: true,
          },
        ],
      },
    ],
  };
}

function toolClient(
  overrides: Partial<ToolClient> = {},
): ToolClient {
  return {
    id: clientId,
    creationRequestId: "20000000-0000-4000-8000-000000000001",
    name: "External CLI",
    state: "enabled",
    availability: "available",
    toolIds: ["thread.status"],
    tools: [{ id: "thread.status", available: true }],
    defaultEnvironmentId: "env-local",
    allowedEnvironmentIds: ["env-local"],
    environments: [{ id: "env-local", available: true }],
    defaultWorkspaceId: "workspace-1",
    defaultWorkspaceAvailable: true,
    defaultThreadId: "thread-1",
    defaultThreadAvailable: true,
    policyRevision: 1,
    credentialGeneration: 1,
    createdAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function controls(
  overrides: Partial<ToolClientSettingsControls["api"]> = {},
  endpoint = "https://sedes.example",
): ToolClientSettingsControls {
  return {
    endpoint,
    resources: {
      workspaces: [
        {
          id: "workspace-1",
          environmentId: "env-local",
          label: "Sedes",
          available: true,
        },
      ],
      threads: [
        {
          id: "thread-1",
          workspaceId: "workspace-1",
          title: "Build thread",
          available: true,
          archived: false,
        },
      ],
    },
    api: {
      getToolClientOptions: vi.fn().mockResolvedValue(options()),
      listToolClients: vi.fn().mockResolvedValue({ items: [] }),
      getToolClient: vi.fn(),
      createToolClient: vi.fn(),
      replaceToolClient: vi.fn(),
      rotateToolClient: vi.fn(),
      revokeToolClient: vi.fn(),
      ...overrides,
    },
  };
}

describe("Tool clients settings", () => {
  afterEach(cleanup);

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("creates an exact grant and keeps an HTTP credential masked until explicit reveal", async () => {
    const created = toolClient();
    const createToolClient = vi.fn().mockResolvedValue({
      client: created,
      credential,
    } satisfies ToolClientCredentialResult);
    const value = controls({ createToolClient }, "http://192.168.1.20:4784");
    render(<ToolClientsSettingsPage controls={value} />);

    await screen.findByRole("button", { name: "New client" });
    fireEvent.click(screen.getByRole("button", { name: "New client" }));
    fireEvent.change(screen.getByLabelText("Tool client name"), {
      target: { value: "External CLI" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Thread status" }));
    fireEvent.change(screen.getByLabelText("Default workspace"), {
      target: { value: "workspace-1" },
    });
    fireEvent.change(screen.getByLabelText("Default thread"), {
      target: { value: "thread-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create client" }));

    await waitFor(() =>
      expect(createToolClient).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "External CLI",
          toolIds: ["thread.status"],
          defaultEnvironmentId: "env-local",
          allowedEnvironmentIds: ["env-local"],
          defaultWorkspaceId: "workspace-1",
          defaultThreadId: "thread-1",
        }),
      ),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Save this credential now",
    });
    expect(within(dialog).queryByText(credential)).toBeNull();
    expect(within(dialog).getByText(/hatc1_••/u)).toHaveTextContent(
      /^hatc1_•+$/u,
    );
    expect(
      within(dialog).getByRole("button", { name: "Copy configuration" }),
    ).toBeDisabled();

    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Acknowledge cleartext credential risk",
      }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy configuration" }),
    );
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        `export SEDES_AGENT_TOOL_ENDPOINT="http://192.168.1.20:4784"\nexport SEDES_AGENT_TOOL_CLIENT_TOKEN="${credential}"`,
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Reveal token" }));
    expect(within(dialog).getByText(credential)).toBeVisible();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).toBeVisible();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "I saved it — close" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Save this credential now" }),
      ).toBeNull(),
    );
    expect(screen.queryByText(credential)).toBeNull();
  });

  it("fails copy gracefully when the Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const createToolClient = vi.fn().mockResolvedValue({
      client: toolClient(),
      credential,
    } satisfies ToolClientCredentialResult);
    render(
      <ToolClientsSettingsPage controls={controls({ createToolClient })} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "New client" }));
    fireEvent.change(screen.getByLabelText("Tool client name"), {
      target: { value: "External CLI" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Thread status" }));
    fireEvent.click(screen.getByRole("button", { name: "Create client" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Save this credential now",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy token" }));
    expect(
      within(dialog).getByRole("status"),
    ).toHaveTextContent("Could not copy token.");
  });

  it("resets environment access when the default environment changes", async () => {
    const createToolClient = vi.fn().mockResolvedValue({
      client: toolClient({
        defaultEnvironmentId: "env-remote",
        allowedEnvironmentIds: ["env-remote"],
        environments: [{ id: "env-remote", available: true }],
      }),
      credential,
    } satisfies ToolClientCredentialResult);
    render(
      <ToolClientsSettingsPage controls={controls({ createToolClient })} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "New client" }));
    fireEvent.change(screen.getByLabelText("Tool client name"), {
      target: { value: "External CLI" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Thread status" }));
    fireEvent.change(screen.getByLabelText("Default environment"), {
      target: { value: "env-remote" },
    });

    expect(
      screen.getByRole("checkbox", { name: "Allow Local" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Allow Remote" }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Create client" }));

    await waitFor(() =>
      expect(createToolClient).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultEnvironmentId: "env-remote",
          allowedEnvironmentIds: ["env-remote"],
        }),
      ),
    );
  });

  it("uses current revisions to disable, rotate, and terminally revoke", async () => {
    const initial = toolClient();
    const disabled = toolClient({
      state: "disabled",
      policyRevision: 2,
      updatedAt: "2026-08-15T12:05:00.000Z",
    });
    const rotated = toolClient({
      state: "disabled",
      policyRevision: 3,
      credentialGeneration: 2,
      updatedAt: "2026-08-15T12:06:00.000Z",
    });
    const revoked = toolClient({
      state: "revoked",
      availability: "needs_attention",
      policyRevision: 4,
      credentialGeneration: 2,
      toolIds: [],
      tools: [],
      defaultEnvironmentId: null,
      allowedEnvironmentIds: [],
      environments: [],
      defaultWorkspaceId: null,
      defaultWorkspaceAvailable: null,
      defaultThreadId: null,
      defaultThreadAvailable: null,
      revokedAt: "2026-08-15T12:07:00.000Z",
      updatedAt: "2026-08-15T12:07:00.000Z",
    });
    const replaceToolClient = vi.fn().mockResolvedValue(disabled);
    const rotateToolClient = vi.fn().mockResolvedValue({
      client: rotated,
      credential: credential.replace("_1_", "_2_"),
    });
    const revokeToolClient = vi.fn().mockResolvedValue(revoked);
    const value = controls({
      listToolClients: vi.fn().mockResolvedValue({ items: [initial] }),
      replaceToolClient,
      rotateToolClient,
      revokeToolClient,
    });
    render(<ToolClientsSettingsPage controls={value} />);

    fireEvent.click(await screen.findByRole("button", { name: /External CLI/u }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable tool client" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(replaceToolClient).toHaveBeenCalledWith(
        clientId,
        expect.objectContaining({ expectedRevision: 1, enabled: false }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Rotate credential" }));
    const rotateDialog = screen.getByRole("dialog", { name: "Rotate credential?" });
    fireEvent.click(
      within(rotateDialog).getByRole("button", { name: "Rotate credential" }),
    );
    await waitFor(() =>
      expect(rotateToolClient).toHaveBeenCalledWith(clientId, 2),
    );
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Save this credential now" }),
      ).getByRole("button", { name: "I saved it — close" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const revokeDialog = screen.getByRole("dialog", { name: "Revoke tool client?" });
    fireEvent.click(
      within(revokeDialog).getByRole("button", { name: "Revoke permanently" }),
    );
    await waitFor(() =>
      expect(revokeToolClient).toHaveBeenCalledWith(clientId, 3),
    );
    expect(await screen.findByText(/credentials can no longer be used/u)).toBeVisible();
  });

  it("recovers an admitted create without inventing a missing secret", async () => {
    const admitted = toolClient();
    const listToolClients = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [admitted] });
    const createToolClient = vi.fn().mockRejectedValue(new TypeError("network"));
    const value = controls({ listToolClients, createToolClient });
    render(<ToolClientsSettingsPage controls={value} />);

    fireEvent.click(await screen.findByRole("button", { name: "New client" }));
    fireEvent.change(screen.getByLabelText("Tool client name"), {
      target: { value: "External CLI" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Thread status" }));
    fireEvent.click(screen.getByRole("button", { name: "Create client" }));

    expect(
      await screen.findByText(/client was created, but its credential was not received/u),
    ).toBeVisible();
    expect(listToolClients).toHaveBeenLastCalledWith(
      expect.objectContaining({
        creationRequestId: expect.any(String),
        pageSize: 1,
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Save this credential now" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Rotate credential" })).toBeVisible();
  });
});
